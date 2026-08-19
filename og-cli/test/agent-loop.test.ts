/**
 * The orchestration contract of the agent loop, driven by a scripted provider
 * and fake tools over a real SQLite session store in a temp directory. What is
 * asserted here is what a UI and a resumed session depend on: event order,
 * exactly one terminal event, and the persisted transcript.
 *
 * Ordering is forced with promise gates rather than sleeps, so "the slow tool"
 * is slow by causality, not by wall clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { messageTokens } from "../src/agent/context.ts";
import { createAgent } from "../src/agent/loop.ts";
import type { Agent, AgentEvent } from "../src/agent/types.ts";
import { DEFAULT_CONFIG } from "../src/config/load.ts";
import type { OgConfig } from "../src/config/schema.ts";
import type { ChatRequest, EndpointHealth, Provider, StreamEvent } from "../src/provider/types.ts";
import { ProviderError } from "../src/provider/types.ts";
import { openSessionStore } from "../src/session/store.ts";
import type { SessionStore } from "../src/session/types.ts";
import {
	ToolValidationError,
	type ApprovalRequest,
	type Tool,
	type ToolContext,
	type ToolResult,
} from "../src/tools/types.ts";

/** One provider turn: a canned event stream, a thrown failure, or a live generator. */
type ScriptStep = StreamEvent[] | Error | ((req: ChatRequest) => AsyncGenerator<StreamEvent>);

const DONE_STOP: StreamEvent = { type: "done", finishReason: "stop" };
const DONE_TOOLS: StreamEvent = { type: "done", finishReason: "tool_calls" };

class FakeProvider implements Provider {
	readonly id = "fake";
	readonly model = "fake-model";
	readonly endpoint = "http://127.0.0.1:8127";
	readonly nativeToolCalls = true;
	readonly contextWindow: number;
	/** Every request the loop made, in order, including the history it sent. */
	readonly requests: ChatRequest[] = [];

	private readonly script: ScriptStep[];
	private cursor = 0;

	constructor(script: ScriptStep[], contextWindow = 32_768) {
		this.script = script;
		this.contextWindow = contextWindow;
	}

	async *chat(req: ChatRequest): AsyncGenerator<StreamEvent> {
		this.requests.push(req);
		const step = this.script[this.cursor++] ?? [DONE_STOP];
		if (step instanceof Error) throw step;
		if (typeof step === "function") {
			yield* step(req);
			return;
		}
		for (const ev of step) yield ev;
	}

	health(): Promise<EndpointHealth> {
		return Promise.resolve({ reachable: true, status: 200 });
	}
}

interface FakeToolSpec {
	name: string;
	/** Read-only tools bypass approval entirely in the loop. Defaults to true. */
	readOnly?: boolean;
	/** When set, the tool asks for approval with this risk before acting. */
	risk?: ApprovalRequest["risk"];
	content?: string;
	throws?: Error;
	validateThrows?: Error;
	/** Blocks completion until this settles: deterministic "slow tool". */
	waitFor?: Promise<void>;
	/** Called just before this tool returns, to unblock a waiter. */
	release?: () => void;
}

/** The order in which tools started and finished, for ordering assertions. */
interface ToolTrace {
	started: string[];
	finished: string[];
}

function fakeTool(spec: FakeToolSpec, trace: ToolTrace): Tool {
	return {
		name: spec.name,
		description: `fake ${spec.name}`,
		parameters: { type: "object", properties: {}, additionalProperties: true },
		readOnly: spec.readOnly ?? true,
		validate: (raw: unknown) => {
			if (spec.validateThrows !== undefined) throw spec.validateThrows;
			return raw;
		},
		run: async (_args: unknown, ctx: ToolContext): Promise<ToolResult> => {
			trace.started.push(spec.name);
			if (spec.risk !== undefined) {
				const approved = await ctx.approve({
					tool: spec.name,
					summary: `${spec.name}: do the thing`,
					risk: spec.risk,
				});
				if (!approved) {
					trace.finished.push(spec.name);
					return { ok: false, content: `${spec.name}: denied by user, nothing was done` };
				}
			}
			if (spec.waitFor !== undefined) await spec.waitFor;
			spec.release?.();
			trace.finished.push(spec.name);
			if (spec.throws !== undefined) throw spec.throws;
			return { ok: true, content: spec.content ?? `${spec.name}: ok` };
		},
	};
}

interface Harness {
	agent: Agent;
	config: OgConfig;
	provider: FakeProvider;
	store: SessionStore;
	sessionId: string;
	trace: ToolTrace;
	/** Approval requests routed to the programmatic host (`deps.approve`). */
	asked: ApprovalRequest[];
}

const openStores: SessionStore[] = [];
const created: string[] = [];

function harness(opts: {
	script: ScriptStep[];
	tools?: FakeToolSpec[];
	contextWindow?: number;
	approveAnswer?: boolean;
	patch?: (cfg: OgConfig) => void;
}): Harness {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "og-loop-"));
	created.push(root);
	const ws = path.join(root, "ws");
	fs.mkdirSync(ws);

	const config = structuredClone(DEFAULT_CONFIG);
	// Baseline: no approval prompts unless a test asks for them.
	config.tools.bash.approval = "never";
	config.tools.edit.approval = "never";
	config.stateDir = path.join(root, "state");
	opts.patch?.(config);

	const store = openSessionStore(config.stateDir);
	openStores.push(store);
	const session = store.create({ cwd: ws, model: "fake-model" });

	const trace: ToolTrace = { started: [], finished: [] };
	const provider = new FakeProvider(opts.script, opts.contextWindow ?? 32_768);
	const asked: ApprovalRequest[] = [];

	const agent = createAgent({
		config,
		provider,
		tools: (opts.tools ?? []).map((spec) => fakeTool(spec, trace)),
		store,
		sessionId: session.id,
		workspaceRoot: ws,
		cwd: ws,
		approve: (req: ApprovalRequest) => {
			asked.push(req);
			return Promise.resolve(opts.approveAnswer ?? true);
		},
	});

	return { agent, config, provider, store, sessionId: session.id, trace, asked };
}

async function drain(agent: Agent, prompt: string, maxSteps?: number): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const ev of agent.run(maxSteps === undefined ? { prompt } : { prompt, maxSteps })) {
		events.push(ev);
	}
	return events;
}

/** Narrowing filter: keeps the discriminated union's payload types intact. */
function pick<T extends AgentEvent["type"]>(
	events: readonly AgentEvent[],
	type: T,
): Array<Extract<AgentEvent, { type: T }>> {
	return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

afterEach(() => {
	for (const store of openStores.splice(0)) store.close();
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("two-step run with tool calls", () => {
	function twoStepScript(): ScriptStep[] {
		return [
			[
				{ type: "tool_call", call: { id: "t1", name: "alpha", arguments: '{"path":"a.ts"}' } },
				{ type: "tool_call", call: { id: "t2", name: "beta", arguments: "{}" } },
				DONE_TOOLS,
			],
			[{ type: "text", delta: "all done" }, DONE_STOP],
		];
	}

	/** alpha is called first but cannot finish until beta has finished. */
	function racedTools(): FakeToolSpec[] {
		const betaFinished = Promise.withResolvers<void>();
		return [
			{ name: "alpha", waitFor: betaFinished.promise },
			{ name: "beta", release: betaFinished.resolve },
		];
	}

	test("emits turn-start, both tool pairs, then text and done(stop)", async () => {
		const h = harness({ script: twoStepScript(), tools: racedTools() });
		const events = await drain(h.agent, "fix the bug");

		expect(events.map((e) => e.type)).toEqual([
			"turn-start",
			"tool-start",
			"tool-start",
			"tool-end",
			"tool-end",
			"turn-start",
			"text",
			"done",
		]);
		expect(pick(events, "turn-start").map((e) => e.step)).toEqual([1, 2]);
		expect(pick(events, "text")[0]?.delta).toBe("all done");
		expect(pick(events, "done")).toHaveLength(1);
		expect(pick(events, "done")[0]).toMatchObject({ steps: 2, stopReason: "stop" });
		// Both calls were announced before either finished.
		expect(pick(events, "tool-start").map((e) => e.call.id)).toEqual(["t1", "t2"]);
	});

	test("persists exactly system, user, assistant(2 calls), tool, tool, assistant", async () => {
		const h = harness({ script: twoStepScript(), tools: racedTools() });
		await drain(h.agent, "fix the bug");

		const stored = h.store.messages(h.sessionId);
		expect(stored.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"tool",
			"assistant",
		]);
		expect(stored[1]?.content).toBe("fix the bug");
		expect(stored[2]?.toolCalls?.map((c) => c.id)).toEqual(["t1", "t2"]);
		expect(stored[3]).toMatchObject({ toolCallId: "t1", name: "alpha" });
		expect(stored[4]).toMatchObject({ toolCallId: "t2", name: "beta" });
		expect(stored[5]?.content).toBe("all done");
		// seq is dense and ordered, so a resume replays the same transcript.
		expect(stored.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(h.store.get(h.sessionId)?.title).toBe("fix the bug");
		// The second request carried the full history including both tool replies.
		expect(h.provider.requests).toHaveLength(2);
		expect(h.provider.requests[1]?.messages.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"tool",
		]);
	});

	test("tool messages follow the model's call order even when the first tool finishes last", async () => {
		const h = harness({ script: twoStepScript(), tools: racedTools() });
		const events = await drain(h.agent, "fix the bug");

		// beta really did finish first...
		expect(h.trace.started).toEqual(["alpha", "beta"]);
		expect(h.trace.finished).toEqual(["beta", "alpha"]);
		expect(pick(events, "tool-end").map((e) => e.callId)).toEqual(["t2", "t1"]);
		// ...yet the transcript is in the model's call order.
		expect(
			h.store
				.messages(h.sessionId)
				.filter((m) => m.role === "tool")
				.map((m) => m.toolCallId),
		).toEqual(["t1", "t2"]);
		expect(
			h.agent
				.history()
				.filter((m) => m.role === "tool")
				.map((m) => m.name),
		).toEqual(["alpha", "beta"]);
	});
});

describe("model self-correction paths", () => {
	test("an unknown tool becomes a tool error message and the run continues", async () => {
		const h = harness({
			script: [
				[{ type: "tool_call", call: { id: "u1", name: "nosuchtool", arguments: "{}" } }, DONE_TOOLS],
				[{ type: "text", delta: "sorry, fixed" }, DONE_STOP],
			],
			tools: [{ name: "alpha" }],
		});

		const events = await drain(h.agent, "go");
		expect(pick(events, "done")[0]).toMatchObject({ steps: 2, stopReason: "stop" });
		expect(pick(events, "error")).toHaveLength(0);
		expect(pick(events, "tool-end")[0]?.ok).toBe(false);

		const toolMsg = h.store.messages(h.sessionId).find((m) => m.role === "tool");
		expect(toolMsg?.toolCallId).toBe("u1");
		expect(toolMsg?.content).toContain('unknown tool "nosuchtool"');
		// The model is told what it may call instead.
		expect(toolMsg?.content).toContain("alpha");
		expect(h.trace.started).toHaveLength(0);
	});

	test("invalid tool arguments are reported back instead of ending the run", async () => {
		const h = harness({
			script: [
				[{ type: "tool_call", call: { id: "v1", name: "picky", arguments: "{}" } }, DONE_TOOLS],
				[{ type: "text", delta: "ok" }, DONE_STOP],
			],
			tools: [
				{ name: "picky", validateThrows: new ToolValidationError('picky: field "path" is required') },
			],
		});

		const events = await drain(h.agent, "go");
		expect(pick(events, "done")[0]).toMatchObject({ steps: 2, stopReason: "stop" });
		const end = pick(events, "tool-end")[0];
		expect(end?.ok).toBe(false);
		expect(end?.summary).toBe("invalid arguments");
		expect(end?.content).toContain('field "path" is required');
		// The tool body never ran.
		expect(h.trace.started).toHaveLength(0);
	});

	test("a tool that throws is reported as tool output, not a crashed run", async () => {
		const h = harness({
			script: [
				[{ type: "tool_call", call: { id: "b1", name: "boomer", arguments: "{}" } }, DONE_TOOLS],
				[{ type: "text", delta: "recovered" }, DONE_STOP],
			],
			tools: [{ name: "boomer", throws: new Error("disk on fire") }],
		});

		const events = await drain(h.agent, "go");
		expect(pick(events, "done")[0]).toMatchObject({ steps: 2, stopReason: "stop" });
		expect(pick(events, "error")).toHaveLength(0);

		const end = pick(events, "tool-end")[0];
		expect(end?.ok).toBe(false);
		expect(end?.content).toContain("boomer failed");
		expect(end?.content).toContain("disk on fire");
		expect(h.store.messages(h.sessionId).find((m) => m.role === "tool")?.content).toContain(
			"disk on fire",
		);
	});
});

describe("provider failures", () => {
	// The loop's own backoff (500ms, then 1500ms) is real time by design; this is
	// the one place a genuine delay is exercised rather than simulated.
	test("retryable errors surface as non-fatal events and then succeed", async () => {
		const h = harness({
			script: [
				new ProviderError("503 service unavailable", 503, true),
				new ProviderError("429 slow down", 429, true),
				[{ type: "text", delta: "finally" }, DONE_STOP],
			],
		});

		const events = await drain(h.agent, "go");
		const errors = pick(events, "error");
		expect(errors).toHaveLength(2);
		for (const err of errors) expect(err.fatal).toBe(false);
		expect(errors[0]?.message).toContain("503 service unavailable");
		expect(errors[0]?.message).toContain("retrying in");
		expect(errors[1]?.message).toContain("429 slow down");
		expect(pick(events, "done")[0]).toMatchObject({ steps: 1, stopReason: "stop" });
		// One attempt per failure plus the successful call; one turn overall.
		expect(h.provider.requests).toHaveLength(3);
		expect(pick(events, "turn-start")).toHaveLength(1);
		expect(h.store.messages(h.sessionId).at(-1)?.content).toBe("finally");
	}, 20_000);

	test("a non-retryable error is fatal and ends with done(error)", async () => {
		const h = harness({ script: [new ProviderError("400 bad request", 400, false)] });

		const events = await drain(h.agent, "go");
		expect(events.map((e) => e.type)).toEqual(["turn-start", "error", "done"]);
		expect(pick(events, "error")[0]).toMatchObject({ fatal: true });
		expect(pick(events, "error")[0]?.message).toContain("400 bad request");
		expect(pick(events, "done")[0]).toMatchObject({ stopReason: "error" });
		// No retry was attempted.
		expect(h.provider.requests).toHaveLength(1);
		// The user turn is still persisted, so the session can be resumed.
		expect(h.store.messages(h.sessionId).map((m) => m.role)).toEqual(["system", "user"]);
	});

	test("a stream that reports finishReason error is fatal", async () => {
		const h = harness({
			script: [
				[
					{ type: "text", delta: "half" },
					{ type: "done", finishReason: "error", error: "template rejected the request" },
				],
			],
		});

		const events = await drain(h.agent, "go");
		expect(pick(events, "done")).toHaveLength(1);
		expect(pick(events, "done")[0]).toMatchObject({ stopReason: "error" });
		expect(pick(events, "error")[0]).toMatchObject({ fatal: true });
		expect(pick(events, "error")[0]?.message).toContain("template rejected the request");
	});
});

describe("cancellation and limits", () => {
	test("aborting mid-stream yields exactly one done(aborted) and keeps the partial text", async () => {
		const controller = new AbortController();
		const h = harness({
			script: [
				async function* streamThenWaitForAbort(req: ChatRequest): AsyncGenerator<StreamEvent> {
					yield { type: "text", delta: "partial answer" };
					const signal = req.signal;
					if (signal !== undefined && !signal.aborted) {
						await new Promise<void>((settle) => {
							signal.addEventListener("abort", () => settle(), { once: true });
						});
					}
					yield { type: "done", finishReason: "aborted" };
				},
			],
		});

		const events: AgentEvent[] = [];
		for await (const ev of h.agent.run({ prompt: "go", signal: controller.signal })) {
			events.push(ev);
			if (ev.type === "text") controller.abort();
		}

		expect(pick(events, "done")).toHaveLength(1);
		expect(pick(events, "done")[0]).toMatchObject({ stopReason: "aborted" });
		expect(pick(events, "text").map((e) => e.delta)).toEqual(["partial answer"]);

		// Whatever arrived before the abort is persisted.
		const stored = h.store.messages(h.sessionId);
		expect(stored.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		expect(stored[2]?.content).toBe("partial answer");
	});

	test("an already-aborted signal stops before any provider call", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = harness({ script: [[{ type: "text", delta: "never" }, DONE_STOP]] });

		const events: AgentEvent[] = [];
		for await (const ev of h.agent.run({ prompt: "go", signal: controller.signal })) {
			events.push(ev);
		}
		expect(events.map((e) => e.type)).toEqual(["done"]);
		expect(pick(events, "done")[0]).toMatchObject({ stopReason: "aborted", steps: 0 });
		expect(h.provider.requests).toHaveLength(0);
		// The prompt is still recorded: the user did ask.
		expect(h.store.messages(h.sessionId).map((m) => m.role)).toEqual(["system", "user"]);
	});

	test("exhausting maxSteps ends with done(max-steps)", async () => {
		const toolTurn: StreamEvent[] = [
			{ type: "tool_call", call: { id: "loop", name: "alpha", arguments: "{}" } },
			DONE_TOOLS,
		];
		const h = harness({
			script: [toolTurn, toolTurn, toolTurn, toolTurn],
			tools: [{ name: "alpha" }],
		});

		const events = await drain(h.agent, "go", 2);
		expect(pick(events, "done")).toHaveLength(1);
		expect(pick(events, "done")[0]).toMatchObject({ steps: 2, stopReason: "max-steps" });
		expect(pick(events, "turn-start")).toHaveLength(2);
		expect(h.provider.requests).toHaveLength(2);
		expect(h.trace.finished).toEqual(["alpha", "alpha"]);
	});
});

describe("approval policy", () => {
	function execScript(): ScriptStep[] {
		return [
			[
				{ type: "tool_call", call: { id: "x1", name: "runner", arguments: '{"command":"ls"}' } },
				DONE_TOOLS,
			],
			[{ type: "text", delta: "done" }, DONE_STOP],
		];
	}
	const execTool: FakeToolSpec = {
		name: "runner",
		readOnly: false,
		risk: "exec",
		content: "runner: exit code: 0",
	};

	test('"never" auto-approves an exec-risk tool with no approval event', async () => {
		const h = harness({
			script: execScript(),
			tools: [execTool],
			patch: (cfg) => {
				cfg.tools.bash.approval = "never";
			},
		});

		const events = await drain(h.agent, "run it");
		expect(pick(events, "approval")).toHaveLength(0);
		expect(h.asked).toHaveLength(0);
		expect(pick(events, "tool-end")[0]?.ok).toBe(true);
		expect(pick(events, "tool-end")[0]?.content).toContain("exit code: 0");
		expect(h.trace.finished).toEqual(["runner"]);
	});

	test('"always" emits an approval event, and denying it becomes tool output', async () => {
		const h = harness({
			script: execScript(),
			tools: [execTool],
			approveAnswer: false,
			patch: (cfg) => {
				cfg.tools.bash.approval = "always";
			},
		});

		const events = await drain(h.agent, "run it");
		const approvals = pick(events, "approval");
		expect(approvals).toHaveLength(1);
		expect(approvals[0]?.request).toMatchObject({ tool: "runner", risk: "exec" });
		// The same request reached the programmatic host, which denied it.
		expect(h.asked.map((r) => r.tool)).toEqual(["runner"]);

		const end = pick(events, "tool-end")[0];
		expect(end?.ok).toBe(false);
		expect(end?.content).toContain("denied by user");
		expect(h.store.messages(h.sessionId).find((m) => m.role === "tool")?.content).toContain(
			"denied by user",
		);
		// The run still completes normally: denial is an answer, not a failure.
		expect(pick(events, "done")[0]).toMatchObject({ stopReason: "stop" });
		expect(pick(events, "error")).toHaveLength(0);
	});

	test('"always" approved by the host lets the tool proceed', async () => {
		const h = harness({
			script: execScript(),
			tools: [execTool],
			approveAnswer: true,
			patch: (cfg) => {
				cfg.tools.bash.approval = "always";
			},
		});

		const events = await drain(h.agent, "run it");
		expect(pick(events, "approval")).toHaveLength(1);
		expect(pick(events, "tool-end")[0]?.ok).toBe(true);
		expect(h.trace.finished).toEqual(["runner"]);
	});

	test("read-only tools never trigger approval under any policy", async () => {
		for (const policy of ["always", "unsafe-only", "never"] as const) {
			const h = harness({
				script: [
					[{ type: "tool_call", call: { id: "r1", name: "peek", arguments: "{}" } }, DONE_TOOLS],
					[{ type: "text", delta: "done" }, DONE_STOP],
				],
				// A read-only tool that still asks: the loop must answer without prompting.
				tools: [{ name: "peek", readOnly: true, risk: "read" }],
				approveAnswer: false,
				patch: (cfg) => {
					cfg.tools.bash.approval = policy;
					cfg.tools.edit.approval = policy;
				},
			});

			const events = await drain(h.agent, "look");
			expect(pick(events, "approval")).toHaveLength(0);
			expect(h.asked).toHaveLength(0);
			expect(pick(events, "tool-end")[0]?.ok).toBe(true);
		}
	});
});

describe("usage reporting", () => {
	test("contextUsedPct is a percentage (0-100), not a fraction", async () => {
		const window = 8192;
		const h = harness({
			script: [
				[
					{ type: "usage", promptTokens: 1234, completionTokens: 56 },
					{ type: "text", delta: "hello there" },
					DONE_STOP,
				],
			],
			contextWindow: window,
		});

		const events = await drain(h.agent, "hi");
		const usage = pick(events, "usage");
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({ promptTokens: 1234, completionTokens: 56 });

		const pct = usage[0]?.contextUsedPct ?? 0;
		// The history is a full system prompt plus two turns, so a fraction would be
		// far below 1 while a percentage is comfortably above it.
		expect(pct).toBeGreaterThan(1);
		expect(pct).toBeLessThanOrEqual(100);
		const used = h.agent.history().reduce((sum, m) => sum + messageTokens(m), 0);
		expect(used).toBeGreaterThan(100);
		expect(pct).toBeCloseTo((used / window) * 100, 6);

		// The UI draws its gauge from these absolute figures rather than recomputing
		// history, so they must agree with the percentage exactly.
		expect(usage[0]?.contextWindow).toBe(window);
		expect(usage[0]?.contextTokens).toBe(used);
		expect((usage[0]?.contextTokens ?? 0) / (usage[0]?.contextWindow ?? 1) * 100).toBeCloseTo(pct, 6);

		// Cumulative usage is persisted for session reporting.
		expect(h.store.get(h.sessionId)).toMatchObject({
			promptTokens: 1234,
			completionTokens: 56,
		});
	});

	test("no usage event is emitted when the backend reports none", async () => {
		const h = harness({ script: [[{ type: "text", delta: "hi" }, DONE_STOP]] });
		const events = await drain(h.agent, "hi");
		expect(pick(events, "usage")).toHaveLength(0);
		expect(h.store.get(h.sessionId)).toMatchObject({ promptTokens: 0, completionTokens: 0 });
	});
});

describe("history continuity", () => {
	test("a second agent over the same session resumes the stored transcript", async () => {
		const h = harness({ script: [[{ type: "text", delta: "first answer" }, DONE_STOP]] });
		await drain(h.agent, "first question");

		const resumed = createAgent({
			config: h.config,
			provider: new FakeProvider([[{ type: "text", delta: "second answer" }, DONE_STOP]]),
			tools: [],
			store: h.store,
			sessionId: h.sessionId,
			workspaceRoot: process.cwd(),
			cwd: process.cwd(),
			approve: () => Promise.resolve(true),
		});

		// The reloaded history is the stored one, with no second system prompt.
		expect(resumed.history().map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		await drain(resumed, "second question");
		expect(h.store.messages(h.sessionId).map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(h.store.messages(h.sessionId).at(-1)?.content).toBe("second answer");
		// The title still reflects the first prompt of the session.
		expect(h.store.get(h.sessionId)?.title).toBe("first question");
	});
});

describe("sampling from the active model spec", () => {
	const TEXT_TURN: ScriptStep[] = [[{ type: "text", delta: "hi" }, DONE_STOP]];

	test("every knob the spec sets reaches the ChatRequest", async () => {
		const h = harness({
			script: TEXT_TURN,
			patch: (cfg) => {
				cfg.model = "tuned";
				cfg.models["tuned"] = {
					contextWindow: 16384,
					temperature: 0.65,
					maxTokens: 2048,
					topP: 0.85,
					topK: 40,
					minP: 0.05,
					repeatPenalty: 1.1,
				};
			},
		});

		await drain(h.agent, "go");
		const req = h.provider.requests[0];
		expect(req).toBeDefined();
		expect(req?.temperature).toBe(0.65);
		expect(req?.maxTokens).toBe(2048);
		expect(req?.topP).toBe(0.85);
		expect(req?.topK).toBe(40);
		expect(req?.minP).toBe(0.05);
		expect(req?.repeatPenalty).toBe(1.1);
		// The spec's numbers, not the agent block's, which differ on every field.
		expect(h.config.agent.temperature).not.toBe(0.65);
		expect(h.config.agent.maxTokens).not.toBe(2048);
	});

	test("agent.temperature and agent.maxTokens are the fallbacks", async () => {
		const h = harness({
			script: TEXT_TURN,
			patch: (cfg) => {
				cfg.model = "bare";
				// A pass-through model: nothing but a window is known about it.
				cfg.models["bare"] = { contextWindow: 16384 };
				cfg.agent.temperature = 0.2;
				cfg.agent.maxTokens = 8192;
			},
		});

		await drain(h.agent, "go");
		const req = h.provider.requests[0];
		expect(req?.temperature).toBe(0.2);
		expect(req?.maxTokens).toBe(8192);
		// There is no agent-level default for the llama.cpp extensions: an unset
		// knob must stay off the wire rather than acquire a guessed value, because
		// OpenAI proper rejects request fields it does not recognise.
		expect(req?.topP).toBeUndefined();
		expect(req?.topK).toBeUndefined();
		expect(req?.minP).toBeUndefined();
		expect(req?.repeatPenalty).toBeUndefined();
	});

	test("minP zero and other falsey knobs are still sent", async () => {
		const h = harness({
			script: TEXT_TURN,
			patch: (cfg) => {
				cfg.model = "zeroed";
				cfg.models["zeroed"] = { contextWindow: 16384, minP: 0, topP: 0, temperature: 0 };
			},
		});

		await drain(h.agent, "go");
		const req = h.provider.requests[0];
		expect(req?.minP).toBe(0);
		expect(req?.topP).toBe(0);
		expect(req?.temperature).toBe(0);
	});

	test("a discovered model carries no sampling of its own, so the agent block governs", async () => {
		// og ships no model entries: a model adopted from the endpoint has only the
		// window the server reported, and every sampling knob then comes from `agent`.
		const h = harness({
			script: TEXT_TURN,
			patch: (cfg) => {
				cfg.models["discovered"] = { id: "discovered", contextWindow: 8192 };
				cfg.model = "discovered";
			},
		});
		await drain(h.agent, "go");
		const req = h.provider.requests[0];
		expect(req?.temperature).toBe(DEFAULT_CONFIG.agent.temperature);
		expect(req?.topP).toBeUndefined();
		expect(req?.topK).toBeUndefined();
		expect(req?.repeatPenalty).toBeUndefined();
	});
});
