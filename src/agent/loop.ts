/**
 * The agent loop: user prompt -> provider stream -> tool execution -> repeat.
 *
 * Everything the UI sees is an `AgentEvent`. Because tool execution runs
 * concurrently and may need to interrupt for approval, events are funnelled
 * through an internal queue that the public async generator drains: the driver
 * pushes, the generator yields. This keeps approval prompts inline with text
 * output without making the driver aware of the consumer.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OgConfig, ApprovalPolicy } from "../config/schema.ts";
import type { ChatRequest, Message, Provider, ToolCall, ToolSpec } from "../provider/types.ts";
import { ProviderError } from "../provider/types.ts";
import type { SessionStore, StoredMessage } from "../session/types.ts";
import type { ApprovalRequest, Tool, ToolContext, ToolLogEvent } from "../tools/types.ts";
import { ToolValidationError } from "../tools/types.ts";
import { compact, messageTokens } from "./context.ts";
import type { SystemPromptInput } from "./prompt.ts";
import { systemPrompt } from "./prompt.ts";
import type { Agent, AgentEvent, AgentRunOptions } from "./types.ts";

export interface AgentDeps {
	config: OgConfig;
	provider: Provider;
	tools: Tool[];
	store: SessionStore;
	sessionId: string;
	workspaceRoot: string;
	cwd: string;
	approve(req: ApprovalRequest): Promise<boolean>;
}

type StopReason = "stop" | "max-steps" | "aborted" | "error";

/** Backoff before each retry of a retryable provider failure, in milliseconds. */
const RETRY_DELAYS = [500, 1500, 4000] as const;

/** Max characters of AGENTS.md folded into the system prompt. */
const PROJECT_CONTEXT_LIMIT = 4000;

const TITLE_LIMIT = 60;

/** Max characters of raw tool arguments echoed into a `tool-start` summary. */
const ARG_PREVIEW_LIMIT = 120;

/** Max characters of tool output echoed into a `tool-end` summary. */
const TOOL_SUMMARY_LIMIT = 90;

/**
 * Path-ish tokens inside an approval summary/detail. The lookbehind keeps URLs
 * (`http://host/x`) and `key:value` pairs from being read as filesystem paths.
 */
const PATH_PATTERN = /(?<![A-Za-z0-9_:\\/])(?:~[\\/]|[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[^\s"'`;|]*/g;

export function createAgent(deps: AgentDeps): Agent {
	return new OgAgent(deps);
}

// --------------------------------------------------------------------------
// event plumbing
// --------------------------------------------------------------------------

class EventQueue<T> {
	private readonly items: T[] = [];
	private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter !== undefined) waiter({ value, done: false });
		else this.items.push(value);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	next(): Promise<IteratorResult<T>> {
		const buffered = this.items.shift();
		if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		const { promise, resolve: settle } = Promise.withResolvers<IteratorResult<T>>();
		this.waiters.push(settle);
		return promise;
	}
}

/** Per-run cancellation plus the set of unanswered approval prompts. */
class RunState {
	private readonly controller = new AbortController();
	private readonly pending = new Set<(approved: boolean) => void>();
	private readonly external: AbortSignal | undefined;
	private readonly onExternalAbort = () => this.controller.abort();
	abandoned = false;

	constructor(external?: AbortSignal) {
		this.external = external;
		if (external === undefined) return;
		if (external.aborted) this.controller.abort();
		else external.addEventListener("abort", this.onExternalAbort, { once: true });
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get aborted(): boolean {
		return this.controller.signal.aborted;
	}

	hold(resolver: (approved: boolean) => void): void {
		this.pending.add(resolver);
	}

	release(resolver: (approved: boolean) => void): void {
		this.pending.delete(resolver);
	}

	/** Consumer stopped listening: cancel inference and deny anything waiting. */
	abandon(): void {
		if (this.abandoned) return;
		this.abandoned = true;
		this.controller.abort();
		const waiting = [...this.pending];
		this.pending.clear();
		for (const resolver of waiting) resolver(false);
		this.dispose();
	}

	dispose(): void {
		this.external?.removeEventListener("abort", this.onExternalAbort);
	}
}

interface TurnUsage {
	promptTokens: number;
	completionTokens: number;
}

type TurnOutcome =
	| { kind: "ok"; text: string; reasoning: string; calls: ToolCall[]; usage?: TurnUsage }
	| { kind: "aborted"; text: string; reasoning: string; calls: ToolCall[]; usage?: TurnUsage }
	| { kind: "error"; message: string };

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function errText(err: unknown): string {
	if (err instanceof Error) return err.message.length > 0 ? err.message : err.name;
	return String(err);
}

/** Leading line of a message, condensed for a single-line status entry. */
function firstLine(text: string, limit: number): string {
	const line = text.split("\n", 1)[0]?.trim() ?? "";
	if (line.length === 0) return "failed";
	return line.length > limit ? `${line.slice(0, limit - 1)}\u2026` : line;
}

/**
 * Tool output routinely self-prefixes ("read failed: ...", "bash: exit 0"), and
 * every renderer already prints the tool name, so drop a leading occurrence.
 */
function stripToolName(text: string, name: string): string {
	if (!text.startsWith(name)) return text;
	const rest = text.slice(name.length);
	const trimmed = rest.replace(/^[:\s]+/, "");
	return trimmed.length > 0 ? trimmed : text;
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function toolMessage(call: ToolCall, content: string): Message {
	return { role: "tool", content, toolCallId: call.id, name: call.name };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve: done } = Promise.withResolvers<void>();
	if (signal.aborted) {
		done();
		return promise;
	}
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		done();
	}, ms);
	function onAbort(): void {
		clearTimeout(timer);
		done();
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/** Drops the persistence fields so nothing extra reaches the backend. */
function toMessage(stored: StoredMessage): Message {
	const msg: Message = { role: stored.role, content: stored.content };
	if (stored.toolCalls !== undefined) msg.toolCalls = stored.toolCalls;
	if (stored.toolCallId !== undefined) msg.toolCallId = stored.toolCallId;
	if (stored.name !== undefined) msg.name = stored.name;
	if (stored.reasoning !== undefined) msg.reasoning = stored.reasoning;
	return msg;
}

function parseArguments(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return {};
	try {
		return JSON.parse(trimmed);
	} catch (err) {
		throw new ToolValidationError(`arguments are not valid JSON (${errText(err)})`);
	}
}

function readProjectContext(workspaceRoot: string): string | undefined {
	const path = join(workspaceRoot, "AGENTS.md");
	try {
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf8");
		if (text.trim().length === 0) return undefined;
		return text.length > PROJECT_CONTEXT_LIMIT ? text.slice(0, PROJECT_CONTEXT_LIMIT) : text;
	} catch {
		return undefined;
	}
}

// --------------------------------------------------------------------------
// agent
// --------------------------------------------------------------------------

class OgAgent implements Agent {
	readonly sessionId: string;

	private readonly deps: AgentDeps;
	private readonly toolsByName: Map<string, Tool>;
	private readonly specs: ToolSpec[];
	private readonly window: number;
	private messages: Message[] = [];
	private tokens: number[] = [];
	private hasUserTurn = false;

	constructor(deps: AgentDeps) {
		this.deps = deps;
		this.sessionId = deps.sessionId;
		this.toolsByName = new Map(deps.tools.map((t) => [t.name, t]));
		this.specs = deps.tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		const declared = deps.provider.contextWindow;
		this.window = Number.isFinite(declared) && declared > 0 ? declared : 8192;

		const stored = deps.store.messages(deps.sessionId);
		if (stored.length > 0) {
			for (const row of stored) {
				const msg = toMessage(row);
				this.messages.push(msg);
				this.tokens.push(row.tokens > 0 ? row.tokens : messageTokens(msg));
				if (msg.role === "user") this.hasUserTurn = true;
			}
			return;
		}

		const projectContext = readProjectContext(deps.workspaceRoot);
		const input: SystemPromptInput = {
			workspaceRoot: deps.workspaceRoot,
			cwd: deps.cwd,
			model: deps.provider.model,
			toolNames: deps.tools.map((t) => t.name),
		};
		if (projectContext !== undefined) input.projectContext = projectContext;
		this.append({ role: "system", content: systemPrompt(input) });
	}

	history(): readonly Message[] {
		return this.messages;
	}

	run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
		return this.iterate(opts);
	}

	private async *iterate(opts: AgentRunOptions): AsyncGenerator<AgentEvent> {
		const queue = new EventQueue<AgentEvent>();
		const state = new RunState(opts.signal);
		const driver = this.drive(opts, queue, state).finally(() => {
			state.dispose();
			queue.close();
		});
		try {
			for (;;) {
				const next = await queue.next();
				if (next.done === true) break;
				yield next.value;
			}
		} finally {
			state.abandon();
			await driver;
		}
	}

	/** Never rejects: every failure becomes an `error` event plus one `done`. */
	private async drive(
		opts: AgentRunOptions,
		queue: EventQueue<AgentEvent>,
		state: RunState,
	): Promise<void> {
		const maxSteps = Math.max(1, opts.maxSteps ?? this.deps.config.agent.maxSteps);
		let steps = 0;
		let finished = false;
		const finish = (stopReason: StopReason): void => {
			if (finished) return;
			finished = true;
			queue.push({ type: "done", steps, stopReason });
		};

		try {
			const fresh = !this.hasUserTurn;
			this.append({ role: "user", content: opts.prompt }, queue);
			this.hasUserTurn = true;
			if (fresh) {
				const flat = opts.prompt.replace(/\s+/g, " ").trim();
				this.deps.store.setTitle(
					this.sessionId,
					flat.length > TITLE_LIMIT ? flat.slice(0, TITLE_LIMIT) : flat,
				);
			}

			if (state.aborted) {
				finish("aborted");
				return;
			}

			while (steps < maxSteps) {
				steps++;
				queue.push({ type: "turn-start", step: steps });

				const turn = await this.runTurn(queue, state);
				if (turn.kind === "error") {
					queue.push({ type: "error", message: turn.message, fatal: true });
					finish("error");
					return;
				}

				this.commitAssistant(turn, queue);
				this.reportUsage(turn, queue);

				if (turn.kind === "aborted") {
					finish("aborted");
					return;
				}
				if (turn.calls.length === 0) {
					finish("stop");
					return;
				}

				await this.runTools(turn.calls, queue, state);
				if (state.aborted) {
					finish("aborted");
					return;
				}
			}
			finish("max-steps");
		} catch (err) {
			queue.push({ type: "error", message: errText(err), fatal: true });
			finish("error");
		} finally {
			// Guarantees exactly one terminal event on every path.
			finish("error");
		}
	}

	// ---- provider turn -----------------------------------------------------

	private async runTurn(queue: EventQueue<AgentEvent>, state: RunState): Promise<TurnOutcome> {
		for (let attempt = 0; ; attempt++) {
			let text = "";
			let reasoning = "";
			const calls: ToolCall[] = [];
			let usage: TurnUsage | undefined;
			let produced = false;

			try {
				const req: ChatRequest = {
					messages: this.messages.slice(),
					temperature: this.deps.config.agent.temperature,
					maxTokens: this.deps.config.agent.maxTokens,
					signal: state.signal,
				};
				if (this.specs.length > 0) req.tools = this.specs;

				let finishReason = "stop";
				let streamError: string | undefined;

				for await (const ev of this.deps.provider.chat(req)) {
					switch (ev.type) {
						case "text":
							if (ev.delta.length > 0) {
								text += ev.delta;
								produced = true;
								queue.push({ type: "text", delta: ev.delta });
							}
							break;
						case "reasoning":
							if (ev.delta.length > 0) {
								reasoning += ev.delta;
								produced = true;
								queue.push({ type: "reasoning", delta: ev.delta });
							}
							break;
						case "tool_call":
							calls.push(ev.call);
							produced = true;
							break;
						case "usage":
							usage = {
								promptTokens: ev.promptTokens,
								completionTokens: ev.completionTokens,
							};
							break;
						case "done":
							finishReason = ev.finishReason;
							streamError = ev.error;
							break;
					}
				}

				if (state.aborted || finishReason === "aborted") {
					return usage === undefined
						? { kind: "aborted", text, reasoning, calls }
						: { kind: "aborted", text, reasoning, calls, usage };
				}
				if (finishReason === "error") {
					return { kind: "error", message: streamError ?? "provider stream failed" };
				}
				return usage === undefined
					? { kind: "ok", text, reasoning, calls }
					: { kind: "ok", text, reasoning, calls, usage };
			} catch (err) {
				if (state.aborted || isAbortError(err)) {
					return { kind: "aborted", text, reasoning, calls };
				}
				const delay = RETRY_DELAYS[attempt];
				const retryable = err instanceof ProviderError && err.retryable;
				if (!retryable || delay === undefined) {
					return { kind: "error", message: errText(err) };
				}
				queue.push({
					type: "error",
					message: `${errText(err)} - retrying in ${delay}ms (attempt ${attempt + 2}/${RETRY_DELAYS.length + 1})${produced ? "; partial output discarded" : ""}`,
					fatal: false,
				});
				await sleep(delay, state.signal);
				if (state.aborted) return { kind: "aborted", text: "", reasoning: "", calls: [] };
			}
		}
	}

	private commitAssistant(turn: TurnOutcome, queue: EventQueue<AgentEvent>): void {
		if (turn.kind === "error") return;
		if (turn.text.length === 0 && turn.reasoning.length === 0 && turn.calls.length === 0) return;
		const msg: Message = { role: "assistant", content: turn.text };
		if (turn.calls.length > 0) msg.toolCalls = turn.calls;
		if (turn.reasoning.length > 0) msg.reasoning = turn.reasoning;
		this.append(msg, queue);
	}

	private reportUsage(turn: TurnOutcome, queue: EventQueue<AgentEvent>): void {
		if (turn.kind === "error" || turn.usage === undefined) return;
		const { promptTokens, completionTokens } = turn.usage;
		this.deps.store.addUsage(this.sessionId, promptTokens, completionTokens);
		const contextTokens = this.used();
		queue.push({
			type: "usage",
			promptTokens,
			completionTokens,
			contextTokens,
			contextWindow: this.window,
			contextUsedPct: (contextTokens / this.window) * 100,
		});
	}

	// ---- tools -------------------------------------------------------------

	private async runTools(
		calls: ToolCall[],
		queue: EventQueue<AgentEvent>,
		state: RunState,
	): Promise<void> {
		const results = new Array<Message | undefined>(calls.length).fill(undefined);
		const lanes = Math.min(Math.max(1, this.deps.config.agent.maxParallelTools), calls.length);
		let cursor = 0;

		const worker = async (): Promise<void> => {
			for (;;) {
				const index = cursor++;
				if (index >= calls.length) return;
				const call = calls[index];
				if (call === undefined) continue;
				results[index] = await this.execute(call, queue, state);
			}
		};

		await Promise.all(Array.from({ length: lanes }, () => worker()));

		// Appended in the model's original call order regardless of completion order.
		for (const msg of results) {
			if (msg !== undefined) this.append(msg, queue);
		}
	}

	private async execute(
		call: ToolCall,
		queue: EventQueue<AgentEvent>,
		state: RunState,
	): Promise<Message> {
		const startedAt = Date.now();
		const tool = this.toolsByName.get(call.name);

		if (tool === undefined) {
			const available = [...this.toolsByName.keys()].join(", ");
			const content = `Error: unknown tool "${call.name}". Available tools: ${available.length > 0 ? available : "(none)"}. Call one of these instead.`;
			queue.push({ type: "tool-start", call, summary: "unknown tool" });
			queue.push({
				type: "tool-end",
				callId: call.id,
				ok: false,
				durationMs: Date.now() - startedAt,
				summary: "unknown tool",
				content,
			});
			return toolMessage(call, content);
		}

		const flatArgs = call.arguments.trim().replace(/\s+/g, " ");
		const shownArgs =
			flatArgs.length > ARG_PREVIEW_LIMIT
				? `${flatArgs.slice(0, ARG_PREVIEW_LIMIT - 3)}...`
				: flatArgs;
		queue.push({
			type: "tool-start",
			call,
			summary: shownArgs.length === 0 || shownArgs === "{}" ? "" : shownArgs,
		});

		let args: unknown;
		try {
			args = tool.validate(parseArguments(call.arguments));
		} catch (err) {
			const content = `Error: invalid arguments for ${tool.name}: ${errText(err)}. Re-read the tool schema and call it again with corrected JSON.`;
			queue.push({
				type: "tool-end",
				callId: call.id,
				ok: false,
				durationMs: Date.now() - startedAt,
				summary: "invalid arguments",
				content,
			});
			return toolMessage(call, content);
		}

		let progress = "";
		const ctx: ToolContext = {
			workspaceRoot: this.deps.workspaceRoot,
			cwd: this.deps.cwd,
			approve: (req: ApprovalRequest) => this.decide(tool, req, queue, state),
			log: (evt: ToolLogEvent) => {
				if (evt.type === "progress") progress = evt.text;
			},
			signal: state.signal,
			denyPaths: this.deps.config.tools.denyPaths,
			timeoutMs: this.deps.config.tools.bash.timeoutMs,
		};

		let ok = false;
		let content: string;
		let summary: string;
		try {
			const result = await tool.run(args, ctx);
			ok = result.ok;
			content =
				result.content.length > 0
					? result.content
					: ok
						? "(no output)"
						: "(failed with no output)";
			// Renderers prepend the tool name, so summaries must not repeat it.
			const metaSummary = result.meta?.["summary"];
			if (typeof metaSummary === "string" && metaSummary.length > 0) {
				summary = stripToolName(metaSummary, tool.name);
			} else if (progress.length > 0) summary = stripToolName(progress, tool.name);
			else if (ok) summary = "ok";
			// A bare "failed" tells the operator nothing. The first line of tool output
			// is the reason (missing path, no match, blocked command), so show it.
			else summary = stripToolName(firstLine(content, TOOL_SUMMARY_LIMIT), tool.name);
		} catch (err) {
			// A tool blowing up is usually the model's fault (bad path, denied
			// command). Report it back as tool output instead of killing the run.
			const interrupted = isAbortError(err) || state.aborted;
			content = interrupted
				? `Error: ${tool.name} was interrupted before it completed.`
				: `Error: ${tool.name} failed: ${errText(err)}`;
			summary = interrupted ? "interrupted" : firstLine(errText(err), TOOL_SUMMARY_LIMIT);
		}

		queue.push({
			type: "tool-end",
			callId: call.id,
			ok,
			durationMs: Date.now() - startedAt,
			summary,
			content,
		});
		return toolMessage(call, content);
	}

	// ---- approval ----------------------------------------------------------

	private policyFor(tool: Tool, req: ApprovalRequest): ApprovalPolicy {
		if (req.risk === "exec" || tool.name === "bash") return this.deps.config.tools.bash.approval;
		return this.deps.config.tools.edit.approval;
	}

	private escapesWorkspace(req: ApprovalRequest): boolean {
		const text = req.detail === undefined ? req.summary : `${req.summary}\n${req.detail}`;
		const matches = text.match(PATH_PATTERN);
		if (matches === null) return false;
		const root = resolve(this.deps.workspaceRoot);
		for (const raw of matches) {
			const candidate = raw.replace(/[.,;:)\]}]+$/, "");
			if (candidate.length === 0) continue;
			if (candidate.startsWith("~")) return true;
			const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(this.deps.cwd, candidate);
			const rel = relative(root, abs);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
		}
		return false;
	}

	private async decide(
		tool: Tool,
		req: ApprovalRequest,
		queue: EventQueue<AgentEvent>,
		state: RunState,
	): Promise<boolean> {
		if (tool.readOnly) return true;
		const policy = this.policyFor(tool, req);
		if (policy === "never") return true;
		if (policy === "unsafe-only" && req.risk !== "exec" && !this.escapesWorkspace(req)) return true;
		if (state.abandoned || state.aborted) return false;

		const { promise, resolve: answer } = Promise.withResolvers<boolean>();
		let settled = false;
		const settle = (approved: boolean): void => {
			if (settled) return;
			settled = true;
			state.release(settle);
			answer(approved);
		};
		state.hold(settle);
		// Two channels, first settle wins: an interactive UI answers through the
		// event's `resolve`, a programmatic host through `deps.approve`.
		queue.push({ type: "approval", request: req, resolve: settle });
		void this.deps.approve(req).then(settle, () => settle(false));
		return await promise;
	}

	// ---- history -----------------------------------------------------------

	private used(): number {
		let total = 0;
		for (const n of this.tokens) total += n;
		return total;
	}

	private append(msg: Message, queue?: EventQueue<AgentEvent>): void {
		const tokens = messageTokens(msg);
		this.messages.push(msg);
		this.tokens.push(tokens);
		this.deps.store.append(this.sessionId, msg, tokens);
		if (queue !== undefined) this.enforceBudget(queue);
	}

	private enforceBudget(queue: EventQueue<AgentEvent>): void {
		if (this.used() <= this.window * this.deps.config.agent.compactThresholdPct) return;

		const result = compact({
			messages: this.messages,
			tokens: this.tokens,
			window: this.window,
			reservePct: this.deps.config.agent.contextReservePct,
		});
		if (result.removed === 0) return;

		this.messages = result.messages;
		this.tokens = result.tokens;
		this.deps.store.replaceMessages(
			this.sessionId,
			this.messages.map((msg, i) => ({ msg, tokens: this.tokens[i] ?? messageTokens(msg) })),
		);
		queue.push({
			type: "compaction",
			removedMessages: result.removed,
			freedTokens: result.freed,
		});
	}
}
