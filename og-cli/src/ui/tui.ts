import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { estimateTokens, messageTokens } from "../agent/context.ts";
import type { Agent, AgentRunOptions } from "../agent/types.ts";
import { endpointOf, modelSpecOf, wireModelOf } from "../config/load.ts";
import type { ModelSpec } from "../config/schema.ts";
import type { Role } from "../provider/types.ts";
import type { ApprovalRequest } from "../tools/types.ts";
import { type BarState, collapseHome, renderBar, renderPrompt } from "./chrome.ts";
import { completeLine } from "./completion.ts";
import {
	bold,
	decideApproval,
	dim,
	elapsed,
	formatContext,
	formatDiffish,
	formatError,
	formatTokenCount,
	formatTokensPerSec,
	formatToolEnd,
	formatUsage,
	green,
	progressBar,
	red,
	wrap,
	yellow,
} from "./render.ts";
import { StatusBar } from "./statusbar.ts";
import { collectSystemInfo, renderSystemInfo } from "./sysinfo.ts";
import { EXIT_ERROR, EXIT_OK, type RebuildRequest, type UiDeps } from "./types.ts";

const HISTORY_LIMIT = 500;
const DOUBLE_INTERRUPT_MS = 2000;
const STATUS_INTERVAL_MS = 120;
const DETAIL_LINE_LIMIT = 40;

/**
 * Tokens already committed to history. Used as the baseline for the live context
 * gauge between usage events, which only arrive at the end of a turn.
 */
function historyTokens(agent: Agent): number {
	let total = 0;
	for (const message of agent.history()) total += messageTokens(message);
	return total;
}
/** Deltas further apart than this are stalls, not decoding time. */
const MAX_DELTA_GAP_MS = 2000;

/** One completed request, kept in memory to answer `/usage`. */
interface RunMetrics {
	model: string;
	steps: number;
	wallMs: number;
	/** Decode-only milliseconds, excluding prefill and tool time. */
	genMs: number;
	completionTokens: number;
	promptTokens: number;
	/** Prompt submitted -> first streamed token. */
	ttftMs?: number;
	/** One prefill latency per model turn within the run. */
	turnTtftsMs: number[];
	stopReason: string;
}

/**
 * Transcript writer. Everything it emits is permanent scrollback; the volatile
 * state lives in the pinned row owned by `StatusBar`, so this class only has to
 * track whether the cursor sits at the start of a line.
 */
class Transcript {
	private atLineStart = true;

	constructor(private readonly out: typeof process.stdout) {}

	/** Streams model output verbatim. */
	text(chunk: string): void {
		if (chunk === "") return;
		this.out.write(chunk);
		this.atLineStart = chunk.endsWith("\n");
	}

	/** Appends one permanent transcript line. */
	line(text: string): void {
		if (!this.atLineStart) this.out.write("\n");
		this.out.write(`${text}\n`);
		this.atLineStart = true;
	}

	/** Writes without a trailing newline; used for inline questions. */
	inline(text: string): void {
		if (!this.atLineStart) this.out.write("\n");
		this.out.write(text);
		this.atLineStart = false;
	}

	/** Ensures the next output starts on a fresh row. */
	breakLine(): void {
		if (!this.atLineStart) {
			this.out.write("\n");
			this.atLineStart = true;
		}
	}
}

interface Keypress {
	name: string;
	ctrl: boolean;
	str: string;
}

/** "No answer": non-TTY sessions and torn-down stdin, read as a denial. */
const NO_KEY: Keypress = { name: "", ctrl: false, str: "" };

/** Interactive REPL. Returns the process exit code. */
export async function runTui(deps: UiDeps): Promise<number> {
	const { config, store } = deps;
	const out = process.stdout;
	const tty = out.isTTY === true && process.stdin.isTTY === true;
	const live = new Transcript(out);
	const bar = new StatusBar(out, tty);

	let agent = deps.agent;
	let sessionId = deps.sessionId;
	let modelKey = config.model;
	let currentRun: AbortController | null = null;
	let approveAll = false;
	let lastInterrupt = 0;
	let exitRequested = false;
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;
	/** Per-run metrics, newest last; drives `/usage`. */
	const runs: RunMetrics[] = [];

	const historyPath = join(config.stateDir, "history");
	const historyNewestFirst = loadHistory(historyPath);

	// One interface for the whole session: stdin ownership stays unambiguous, and
	// Ctrl+C keeps arriving as readline's SIGINT event even while a run streams.
	const rl = createInterface({
		input: process.stdin,
		output: out,
		terminal: tty,
		history: [...historyNewestFirst],
		historySize: HISTORY_LIMIT,
		removeHistoryDuplicates: true,
		prompt: "> ",
		completer: (line: string): [string[], string] =>
			completeLine(line, {
				commands: COMMAND_NAMES,
				subcommands: COMMAND_SUBCOMMANDS,
				modelKeys: Object.keys(config.models),
				cwd: deps.cwd ?? process.cwd(),
			}),
	});

	// State shown in the pinned row. Authoritative between runs; a run supplies the
	// live `run` block and clears it when it settles.
	const barState: BarState = {
		model: modelKey,
		cwd: collapseHome(deps.cwd ?? process.cwd(), homedir()),
		endpoint: endpointOf(config, modelKey),
		contextTokens: historyTokens(agent),
		contextWindow: modelSpecOf(config, modelKey).contextWindow,
		sessionTokens: 0,
		title: store.get(sessionId)?.title ?? "",
	};

	const paintBar = (): void => {
		if (!tty) return;
		barState.model = modelKey;
		barState.title = store.get(sessionId)?.title ?? barState.title;
		barState.sessionTokens = totalPromptTokens + totalCompletionTokens;
		bar.set(renderBar(barState, out.columns ?? 80));
	};

	const onResize = (): void => {
		bar.resize();
		paintBar();
	};
	out.on("resize", onResize);

	const queued: string[] = [];
	let lineWaiter: ((value: string | null) => void) | null = null;
	let keyWaiter: ((key: Keypress) => void) | null = null;
	let inputClosed = false;

	rl.on("line", (value) => {
		const waiter = lineWaiter;
		if (waiter !== null) {
			lineWaiter = null;
			waiter(value);
			return;
		}
		// Typed while a run was streaming: keep it for the next turn.
		queued.push(value);
	});
	rl.on("close", () => {
		inputClosed = true;
		const waiter = lineWaiter;
		if (waiter !== null) {
			lineWaiter = null;
			waiter(null);
		}
		// A pending approval must never outlive stdin: settle it as "no answer",
		// which the caller reads as a denial.
		const pendingKey = keyWaiter;
		if (pendingKey !== null) {
			keyWaiter = null;
			pendingKey(NO_KEY);
		}
	});

	const nextLine = (): Promise<string | null> => {
		const buffered = queued.shift();
		if (buffered !== undefined) return Promise.resolve(buffered);
		if (inputClosed) return Promise.resolve(null);
		// State lives in the pinned row, so the prompt itself stays a bare marker and
		// the row the cursor is on is never repainted by us.
		paintBar();
		rl.setPrompt(tty ? renderPrompt(false) : "> ");
		rl.prompt();
		const { promise, resolve } = Promise.withResolvers<string | null>();
		lineWaiter = resolve;
		return promise;
	};

	/**
	 * One keypress, via readline's own keypress stream so raw-mode ownership is
	 * never contested. The echoed character is removed from readline's line
	 * buffer afterwards so it cannot leak into the next prompt.
	 */
	const readKey = (): Promise<Keypress> => {
		if (!tty || inputClosed) return Promise.resolve(NO_KEY);
		const { promise, resolve } = Promise.withResolvers<Keypress>();
		const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
			process.stdin.off("keypress", onKeypress);
			keyWaiter = null;
			rl.write(null, { ctrl: true, name: "u" });
			resolve({ name: key?.name ?? "", ctrl: key?.ctrl === true, str: str ?? "" });
		};
		keyWaiter = (settled) => {
			process.stdin.off("keypress", onKeypress);
			resolve(settled);
		};
		process.stdin.on("keypress", onKeypress);
		return promise;
	};

	const interrupt = (): void => {
		const now = Date.now();
		// At idle the cursor sits after readline's "> " prompt, which LiveLine does
		// not know about; break the row so the notice starts clean.
		if (tty && currentRun === null) out.write("\n");
		if (now - lastInterrupt < DOUBLE_INTERRUPT_MS) {
			exitRequested = true;
			currentRun?.abort();
			live.line(dim("^C exiting"));
			rl.close();
			return;
		}
		lastInterrupt = now;
		if (currentRun !== null) {
			currentRun.abort();
			live.line(dim("^C aborting run — press Ctrl+C again within 2s to exit"));
			return;
		}
		live.line(dim("(press Ctrl+C again within 2s to exit)"));
		rl.prompt();
	};

	rl.on("SIGINT", interrupt);
	// Without a terminal readline never sees ^C itself, so take the real signal.
	if (!tty) process.on("SIGINT", interrupt);

	const askApproval = async (req: ApprovalRequest): Promise<boolean> => {
		if (approveAll) {
			live.line(`${green("\u2713")} ${dim(`auto-approved (all): ${req.tool} ${req.summary}`)}`);
			return true;
		}
		if (!tty) return decideApproval(config, req);
		live.breakLine();
		const width = Math.max((out.columns ?? 80) - 2, 40);
		live.line("");
		live.line(`${yellow("approval required")} ${bold(req.tool)} ${dim(`risk: ${req.risk}`)}`);
		live.line(wrap(`  ${req.summary}`, width));
		if (req.detail !== undefined && req.detail !== "") {
			const detailLines = req.detail.split("\n");
			live.line(formatDiffish(wrap(indent(detailLines.slice(0, DETAIL_LINE_LIMIT).join("\n")), width)));
			if (detailLines.length > DETAIL_LINE_LIMIT) live.line(dim(`  \u2026 ${detailLines.length - DETAIL_LINE_LIMIT} more lines`));
		}
		live.inline(`  ${dim("[y] approve  [n] deny  [a] approve all in this run")} `);
		const key = await readKey();
		if (key.ctrl && (key.name === "c" || key.name === "d")) {
			currentRun?.abort();
			live.line(`${red("\u2717")} ${dim("denied (interrupted)")}`);
			return false;
		}
		const answer = key.str.toLowerCase();
		if (answer === "a") {
			approveAll = true;
			live.line(`${green("\u2713")} ${dim("approved — remaining calls in this run are auto-approved")}`);
			return true;
		}
		const approved = answer === "y";
		live.line(approved ? `${green("\u2713")} ${dim("approved")}` : `${red("\u2717")} ${dim("denied")}`);
		return approved;
	};

	deps.setApprovalHandler?.(askApproval);

	const runPrompt = async (prompt: string): Promise<void> => {
		const controller = new AbortController();
		currentRun = controller;
		approveAll = false;
		const startedAt = Date.now();
		const active = new Map<string, { name: string; summary: string; startedAt: number }>();
		let runCompletion = 0;
		// Throughput must reflect GPU decoding only. Wall-clock time spans prefill
		// and tool execution, which drags the figure down while the model is idle.
		let runPromptTokens = 0;
		let genMs = 0;
		let lastDeltaAt: number | undefined;
		/** Time to first token: prompt submitted -> first streamed delta. */
		let ttftMs: number | undefined;
		/** Per-turn prefill latency; a multi-step run pays it once per turn. */
		const turnTtfts: number[] = [];
		let turnStartedAt = startedAt;
		let turnHasToken = false;
		const markDelta = (): void => {
			const now = Date.now();
			if (ttftMs === undefined) ttftMs = now - startedAt;
			if (!turnHasToken) {
				turnHasToken = true;
				turnTtfts.push(now - turnStartedAt);
			}
			if (lastDeltaAt !== undefined) genMs += Math.min(now - lastDeltaAt, MAX_DELTA_GAP_MS);
			lastDeltaAt = now;
		};

		// Context occupancy, updated live. The authoritative figure only arrives with
		// the usage event at the end of a turn, so between turns we track a local
		// estimate: the persisted history plus whatever has streamed since.
		let contextTokens = historyTokens(deps.agent);
		let contextWindow = modelSpecOf(deps.config, modelKey).contextWindow;
		let streamedTokens = 0;

		let phase: "prefill" | "generating" = "prefill";
		let steps = 0;
		let stopReason = "error";
		let tick = 0;

		const renderStatus = (): void => {
			const now = Date.now();
			const first = active.values().next();
			const busyTool = first.done === true ? undefined : first.value;
			const label =
				busyTool !== undefined
					? `${busyTool.name} ${elapsed(now - busyTool.startedAt)}${active.size > 1 ? ` +${active.size - 1}` : ""}`
					: phase === "prefill"
						? "reading context"
						: "generating";
			barState.contextTokens = contextTokens + streamedTokens;
			barState.contextWindow = contextWindow;
			barState.run = {
				tick,
				phase: label,
				wallMs: now - startedAt,
				tokensPerSec: genMs >= 250 && runCompletion > 0 ? runCompletion / (genMs / 1000) : 0,
				...(ttftMs === undefined ? {} : { ttftMs }),
			};
			paintBar();
		};

		const timer = tty
			? setInterval(() => {
					tick++;
					renderStatus();
				}, STATUS_INTERVAL_MS)
			: undefined;
		renderStatus();

		const options: AgentRunOptions = {
			prompt,
			signal: controller.signal,
			...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
		};

		try {
			for await (const event of agent.run(options)) {
				switch (event.type) {
					case "turn-start":
						steps = event.step;
						// Every turn re-sends the whole history: the model is reading
						// before it writes, and that is where the wait actually goes.
						phase = "prefill";
						turnStartedAt = Date.now();
						turnHasToken = false;
						if (deps.verbose === true) live.line(dim(`— turn ${event.step} —`));
						renderStatus();
						break;
					case "text":
						phase = "generating";
						streamedTokens += estimateTokens(event.delta);
						markDelta();
						live.text(event.delta);
						break;
					case "reasoning":
						phase = "generating";
						streamedTokens += estimateTokens(event.delta);
						markDelta();
						if (deps.verbose === true) live.text(dim(event.delta));
						break;
					case "tool-start":
						lastDeltaAt = undefined;
						active.set(event.call.id, { name: event.call.name, summary: event.summary, startedAt: Date.now() });
						renderStatus();
						break;
					case "tool-end": {
						const info = active.get(event.callId);
						active.delete(event.callId);
						live.line(formatToolEnd(info?.name ?? event.callId, event.ok, event.durationMs, event.summary));
						break;
					}
					case "approval":
						// deps.approve (wired to askApproval) owns the decision; both
						// paths race and the loser is ignored, so never answer twice.
						if (deps.setApprovalHandler === undefined) event.resolve(await askApproval(event.request));
						break;
					case "usage":
						lastDeltaAt = undefined;
						runCompletion += event.completionTokens;
						runPromptTokens += event.promptTokens;
						totalPromptTokens += event.promptTokens;
						totalCompletionTokens += event.completionTokens;
						// Authoritative occupancy: drop the local estimate.
						contextTokens = event.contextTokens;
						contextWindow = event.contextWindow;
						streamedTokens = 0;
						if (deps.verbose === true) {
							live.line(
								formatUsage(event.promptTokens, event.completionTokens, event.contextUsedPct, event.contextTokens, event.contextWindow),
							);
						}
						break;
					case "compaction":
						contextTokens = Math.max(0, contextTokens - event.freedTokens);
						live.line(dim(`compacted ${event.removedMessages} messages, freed ${event.freedTokens} tokens`));
						break;
					case "error":
						live.line(formatError(event.message));
						break;
					case "done":
						steps = event.steps;
						stopReason = event.stopReason;
						break;
				}
			}
		} catch (error) {
			live.line(formatError(error instanceof Error ? error.message : String(error)));
			if (deps.verbose === true && error instanceof Error && error.stack !== undefined) live.line(dim(error.stack));
		} finally {
			clearInterval(timer);
			currentRun = null;
			// The pinned row returns to its idle form; the run's final occupancy is
			// authoritative, so it stays on screen.
			delete barState.run;
			barState.contextTokens = contextTokens;
			barState.contextWindow = contextWindow;
			live.breakLine();
		}

		const wall = Date.now() - startedAt;
		runs.push({
			model: modelKey,
			steps,
			wallMs: wall,
			genMs,
			completionTokens: runCompletion,
			promptTokens: runPromptTokens,
			turnTtftsMs: turnTtfts,
			stopReason,
			...(ttftMs === undefined ? {} : { ttftMs }),
		});

		const reason = stopReason === "stop" ? "" : ` \u00b7 ${stopReason}`;
		const ttftPart = ttftMs === undefined ? "" : ` \u00b7 ttft ${elapsed(ttftMs)}`;
		live.line(
			dim(
				`${steps} step${steps === 1 ? "" : "s"} \u00b7 ${elapsed(wall)} \u00b7 ${formatTokensPerSec(runCompletion, genMs)} gen${ttftPart}${reason}`,
			),
		);
	};

	const rebuildInto = async (req: RebuildRequest): Promise<void> => {
		if (deps.rebuild === undefined) {
			live.line(formatError("this build cannot switch model or session (no rebuild hook supplied)"));
			return;
		}
		const result = await deps.rebuild(req);
		agent = result.agent;
		sessionId = result.sessionId;
		modelKey = result.model;
		// A different session or model changes every header field that is not cwd.
		barState.model = modelKey;
		barState.endpoint = endpointOf(config, modelKey);
		barState.contextWindow = modelSpecOf(config, modelKey).contextWindow;
		barState.contextTokens = historyTokens(agent);
		barState.title = store.get(sessionId)?.title ?? "";
	};

	const slash = async (input: string): Promise<"continue" | "exit"> => {
		const [rawCmd = "", ...rest] = input.slice(1).split(/\s+/);
		const cmd = rawCmd.toLowerCase();
		const arg = rest.join(" ").trim();
		switch (cmd) {
			case "help":
				for (const line of helpLines()) live.line(line);
				return "continue";
			case "exit":
			case "quit":
				return "exit";
			case "model":
			case "models": {
				const [sub = "", ...subRest] = arg.split(/\s+/);
				const target = subRest.join(" ").trim();
				const action = sub.toLowerCase();

				// `/models` and `/models list` both list; `/model <key>` stays valid
				// because it is the shape people type from muscle memory.
				if (action === "" || action === "list") {
					// Same two-line shape and the same words as `og models`, so the
					// REPL and the CLI never describe one model two ways.
					for (const [key, spec] of Object.entries(config.models)) {
						const mark = key === modelKey ? green("*") : " ";
						const facts = [`window ${spec.contextWindow}`];
						if (spec.maxTokens !== undefined) facts.push(`max-tokens ${spec.maxTokens}`);
						facts.push(...samplingKnobs(spec));
						// The variable name, never its value: og prints config, not secrets.
						if (spec.apiKeyEnv !== undefined) facts.push(`key from $${spec.apiKeyEnv}`);
						live.line(`${mark} ${bold(key.padEnd(22))} ${dim(`${spec.id ?? key} @ ${spec.endpoint ?? config.endpoint}`)}`);
						live.line(`  ${dim(facts.join(" \u00b7 "))}`);
					}
					live.line(dim("/models switch <key> changes model; /models info <key> shows everything"));
					return "continue";
				}

				if (action === "info") {
					const key = target === "" ? modelKey : target;
					const spec = config.models[key];
					if (spec === undefined) {
						live.line(formatError(`unknown model "${key}" — known: ${Object.keys(config.models).join(", ")}`));
						return "continue";
					}
					const knobs = samplingKnobs(spec);
					const headerKeys = Object.keys(spec.headers ?? {});
					live.line(bold(key));
					live.line(dim(`  wire id  ${spec.id ?? key}`));
					live.line(dim(`  endpoint ${spec.endpoint ?? `${config.endpoint} (top-level default)`}`));
					// The variable name only: a bearer token must never reach the transcript.
					live.line(dim(`  api key  ${spec.apiKeyEnv === undefined ? "top-level apiKey" : `$${spec.apiKeyEnv}`}`));
					live.line(dim(`  headers  ${headerKeys.length === 0 ? "none" : headerKeys.join(", ")}`));
					live.line(dim(`  window   ${spec.contextWindow} tok`));
					live.line(
						dim(`  max out  ${spec.maxTokens === undefined ? `${config.agent.maxTokens} (from agent.maxTokens)` : `${spec.maxTokens} tok`}`),
					);
					live.line(
						dim(`  sampling ${knobs.length === 0 ? `temp ${config.agent.temperature} (from agent.temperature)` : knobs.join(" \u00b7 ")}`),
					);
					return "continue";
				}

				// `/models switch x` and the shorthand `/model x`.
				const key = action === "switch" || action === "use" ? target : arg;
				if (key === "") {
					live.line(formatError("usage: /models switch <key> — see /models list"));
					return "continue";
				}
				if (config.models[key] === undefined) {
					live.line(formatError(`unknown model "${key}" — known: ${Object.keys(config.models).join(", ")}`));
					return "continue";
				}
				if (key === modelKey) {
					live.line(dim(`already on ${key}`));
					return "continue";
				}
				await rebuildInto({ model: key });
				live.line(dim(`model \u2192 ${modelKey}`));
				paintBar();
				return "continue";
			}
			case "stats": {
				live.line(dim("collecting machine info\u2026"));
				const info = await collectSystemInfo(config);
				for (const line of renderSystemInfo(info, Math.max((out.columns ?? 80) - 2, 32))) live.line(line);
				return "continue";
			}
			case "usage": {
				const spec = modelSpecOf(config, modelKey);
				const window = spec.contextWindow;
				const used = historyTokens(agent);
				const record = store.get(sessionId);
				const modelRuns = runs.filter((r) => r.model === modelKey);
				const last = modelRuns[modelRuns.length - 1];
				const knobs = samplingKnobs(spec);

				live.line(bold(`model ${modelKey}`));
				live.line(
					dim(
						`  ${wireModelOf(config, modelKey)} \u00b7 ${endpointOf(config, modelKey)}${knobs.length === 0 ? "" : ` \u00b7 ${knobs.join(" \u00b7 ")}`}`,
					),
				);

				live.line(bold("context"));
				live.line(`  ${formatContext(used, window)}`);
				live.line(
					dim(
						`  reserve ${Math.round(config.agent.contextReservePct * 100)}% \u00b7 compaction at ${Math.round(config.agent.compactThresholdPct * 100)}% (${formatTokenCount(window * config.agent.compactThresholdPct)}) \u00b7 ${formatTokenCount(Math.max(0, window - used))} free`,
					),
				);

				live.line(bold("this session"));
				live.line(
					dim(
						`  ${runs.length} run${runs.length === 1 ? "" : "s"} \u00b7 ${totalPromptTokens}\u2191 ${totalCompletionTokens}\u2193 = ${formatTokenCount(totalPromptTokens + totalCompletionTokens)} tok`,
					),
				);
				if (record !== undefined) {
					live.line(
						dim(
							`  stored total ${formatTokenCount(record.promptTokens + record.completionTokens)} tok across ${store.messages(sessionId).length} messages`,
						),
					);
				}

				if (last === undefined) {
					live.line(dim("no runs yet on this model — throughput and ttft appear after the first prompt"));
					return "continue";
				}

				// A dash reads as "broken". Below a usable sample, state the sample.
				const decodeRate = (tokens: number, ms: number): string =>
					ms >= 250 && tokens > 0
						? `${(tokens / (ms / 1000)).toFixed(1)} tok/s`
						: `${tokens} tok in ${elapsed(ms)} (sample too short to rate)`;

				live.line(bold("last run"));
				live.line(
					dim(
						`  ${last.steps} step${last.steps === 1 ? "" : "s"} \u00b7 ${elapsed(last.wallMs)} wall \u00b7 decode ${decodeRate(last.completionTokens, last.genMs)} \u00b7 ttft ${last.ttftMs === undefined ? "n/a" : elapsed(last.ttftMs)}${last.stopReason === "stop" ? "" : ` \u00b7 ${last.stopReason}`}`,
					),
				);

				const decodeTokens = modelRuns.reduce((sum, r) => sum + r.completionTokens, 0);
				const decodeMs = modelRuns.reduce((sum, r) => sum + r.genMs, 0);
				const ttfts = modelRuns.flatMap((r) => r.turnTtftsMs);
				live.line(bold(`across ${modelRuns.length} run${modelRuns.length === 1 ? "" : "s"} on this model`));
				live.line(dim(`  decode ${decodeRate(decodeTokens, decodeMs)} over ${formatTokenCount(decodeTokens)} generated tokens`));
				if (ttfts.length > 0) {
					const sorted = [...ttfts].sort((a, b) => a - b);
					const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
					const median = sorted[Math.floor(sorted.length / 2)] ?? mean;
					live.line(
						dim(
							`  ttft over ${sorted.length} turn${sorted.length === 1 ? "" : "s"}: median ${elapsed(median)} \u00b7 mean ${elapsed(mean)} \u00b7 min ${elapsed(sorted[0] ?? 0)} \u00b7 max ${elapsed(sorted[sorted.length - 1] ?? 0)}`,
						),
					);
					live.line(dim("  ttft includes prefill of the whole transcript, so it grows with context"));
				}
				return "continue";
			}
			case "context": {
				const window = modelSpecOf(config, modelKey).contextWindow;
				const byRole = new Map<Role, { count: number; tokens: number }>();
				let total = 0;
				for (const message of agent.history()) {
					const tokens = messageTokens(message);
					total += tokens;
					const bucket = byRole.get(message.role) ?? { count: 0, tokens: 0 };
					bucket.count++;
					bucket.tokens += tokens;
					byRole.set(message.role, bucket);
				}
				for (const [role, bucket] of byRole) {
					const share = total > 0 ? bucket.tokens / total : 0;
					live.line(
						`  ${bold(role.padEnd(9))} ${String(bucket.count).padStart(3)} msg ${String(bucket.tokens).padStart(7)} tok ${progressBar(share, 12)} ${dim(`${Math.round(share * 100)}%`)}`,
					);
				}
				live.line(`  ${formatContext(total, window)} \u00b7 ${dim(`reserve ${Math.round(config.agent.contextReservePct * 100)}%`)}`);
				live.line(
					dim(`  compaction triggers at ${Math.round(config.agent.compactThresholdPct * 100)}% (${Math.round(window * config.agent.compactThresholdPct)} tok)`),
				);
				return "continue";
			}
			case "clear":
				await rebuildInto({ session: "new" });
				live.line(dim(`new session ${sessionId}`));
				return "continue";
			case "sessions": {
				const records = deps.cwd === undefined ? store.list({ limit: 10 }) : store.list({ cwd: deps.cwd, limit: 10 });
				if (records.length === 0) {
					live.line(dim("no sessions yet"));
					return "continue";
				}
				for (const record of records) {
					const mark = record.id === sessionId ? green("*") : " ";
					const when = new Date(record.updatedAt).toISOString().replace("T", " ").slice(0, 16);
					live.line(`${mark} ${bold(record.id)} ${dim(`${when} \u00b7 ${record.model} \u00b7 ${record.promptTokens + record.completionTokens} tok \u00b7 ${record.title === "" ? "(untitled)" : record.title}`)}`);
				}
				return "continue";
			}
			case "resume": {
				if (arg === "") {
					live.line(formatError("usage: /resume <session-id>"));
					return "continue";
				}
				if (store.get(arg) === undefined) {
					live.line(formatError(`no session "${arg}" — see /sessions`));
					return "continue";
				}
				await rebuildInto({ session: { id: arg } });
				live.line(dim(`resumed ${sessionId} (${store.messages(sessionId).length} messages)`));
				return "continue";
			}
			case "cost": {
				const record = store.get(sessionId);
				const sessionPrompt = record?.promptTokens ?? 0;
				const sessionCompletion = record?.completionTokens ?? 0;
				live.line(`  ${bold("session")}  ${sessionPrompt}\u2191 ${sessionCompletion}\u2193 = ${sessionPrompt + sessionCompletion} tok`);
				live.line(`  ${bold("this run")} ${totalPromptTokens}\u2191 ${totalCompletionTokens}\u2193 = ${totalPromptTokens + totalCompletionTokens} tok`);
				// og holds no price list and cannot read the endpoint's billing: tokens are the only honest figure.
				live.line(dim(`  ${endpointOf(config, modelKey)} \u00b7 pricing unknown to og \u2014 convert these totals yourself`));
				return "continue";
			}
			default:
				live.line(formatError(`unknown command /${cmd} — try /help`));
				return "continue";
		}
	};

	// Reserve the row FIRST: anything printed before the region exists lands on row
	// 1 and the bar then paints over it.
	bar.enable();
	live.line(`${bold("og")}${deps.version === undefined ? "" : dim(` ${deps.version}`)} ${dim(`\u00b7 ${modelKey} \u00b7 ${endpointOf(config, modelKey)}`)}`);
	if (deps.workspaceRoot !== undefined) live.line(dim(`workspace ${deps.workspaceRoot}`));
	const messageCount = store.get(sessionId) === undefined ? 0 : store.messages(sessionId).length;
	live.line(dim(`session ${sessionId} \u00b7 ${messageCount} message${messageCount === 1 ? "" : "s"} \u00b7 /help for commands`));
	paintBar();
	// A process that dies with a scroll region installed leaves the user's shell
	// scrolling inside a sub-window, so tear it down on abnormal exits too.
	const emergencyRestore = (): void => bar.disable();
	process.once("exit", emergencyRestore);
	process.once("uncaughtException", emergencyRestore);

	let exitCode = EXIT_OK;
	try {
		while (!exitRequested) {
			const input = await nextLine();
			if (input === null) break;
			const line = input.trim();
			if (line === "") continue;
			lastInterrupt = 0;
			pushHistory(historyNewestFirst, line);
			if (line.startsWith("/")) {
				try {
					if ((await slash(line)) === "exit") break;
				} catch (error) {
					live.line(formatError(error instanceof Error ? error.message : String(error)));
				}
				continue;
			}
			await runPrompt(line);
		}
	} catch (error) {
		live.line(formatError(error instanceof Error ? error.message : String(error)));
		exitCode = EXIT_ERROR;
	} finally {
		deps.setApprovalHandler?.(null);
		bar.disable();
		process.off("exit", emergencyRestore);
		process.off("uncaughtException", emergencyRestore);
		rl.off("SIGINT", interrupt);
		process.off("SIGINT", interrupt);
		out.off("resize", onResize);
		rl.close();
		saveHistory(historyPath, historyNewestFirst, config.stateDir);
	}
	out.write(`${dim("bye")}\n`);
	return exitCode;
}

function loadHistory(path: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(-HISTORY_LIMIT)
		.reverse();
}

function pushHistory(historyNewestFirst: string[], line: string): void {
	if (historyNewestFirst[0] === line) return;
	historyNewestFirst.unshift(line);
	if (historyNewestFirst.length > HISTORY_LIMIT) historyNewestFirst.length = HISTORY_LIMIT;
}

function saveHistory(path: string, historyNewestFirst: string[], stateDir: string): void {
	try {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(path, `${[...historyNewestFirst].reverse().join("\n")}\n`, "utf8");
	} catch {
		// A read-only state dir must never break session teardown.
	}
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

/**
 * Single source of truth for the slash vocabulary: `/help`, Tab completion and
 * the dispatcher all read it, so a new command cannot be half-registered.
 */
export const COMMAND_NAMES: readonly string[] = [
	"help",
	"models",
	"model",
	"usage",
	"stats",
	"context",
	"clear",
	"sessions",
	"resume",
	"cost",
	"exit",
];

export const COMMAND_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
	models: ["list", "switch", "info"],
};

function helpLines(): string[] {
	return [
		`${bold("/help")}                  this list`,
		`${bold("/models [list]")}         configured models with endpoint, window and sampling`,
		`${bold("/models switch <key>")}   change the active model`,
		`${bold("/models info <key>")}     everything configured for one model`,
		`${bold("/usage")}                 context occupancy, token usage, decode rate and ttft`,
		`${bold("/stats")}                 machine specs, runtime and the configured endpoint`,
		`${bold("/context")}               token usage per role against the context window`,
		`${bold("/clear")}                 start a fresh session`,
		`${bold("/sessions")}              recent sessions`,
		`${bold("/resume <id>")}           continue a previous session`,
		`${bold("/cost")}                  cumulative token usage`,
		`${bold("/exit")}                  leave (Ctrl+D, or Ctrl+C twice)`,
		dim("Tab completes commands, model keys and paths; anything else is sent to the model"),
	];
}

/**
 * The sampling knobs a model actually pins, worded exactly as `og models` words
 * them. Anything unset is left to the endpoint's own default, which is
 * deliberate: OpenAI rejects `top_k`/`min_p` outright, so those only ever
 * appear for llama.cpp and vLLM models.
 */
function samplingKnobs(spec: ModelSpec): string[] {
	const parts: string[] = [];
	if (spec.temperature !== undefined) parts.push(`temp ${spec.temperature}`);
	if (spec.topP !== undefined) parts.push(`top-p ${spec.topP}`);
	if (spec.topK !== undefined) parts.push(`top-k ${spec.topK}`);
	if (spec.minP !== undefined) parts.push(`min-p ${spec.minP}`);
	if (spec.repeatPenalty !== undefined) parts.push(`repeat-penalty ${spec.repeatPenalty}`);
	return parts;
}
