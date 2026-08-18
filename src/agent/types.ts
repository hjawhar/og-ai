import type { Message, ToolCall } from "../provider/types.ts";
import type { ApprovalRequest } from "../tools/types.ts";

/** Events surfaced by the agent loop to any UI (TUI, headless, HTTP). */
export type AgentEvent =
	| { type: "turn-start"; step: number }
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "tool-start"; call: ToolCall; summary: string }
	| { type: "tool-end"; callId: string; ok: boolean; durationMs: number; summary: string; content: string }
	| { type: "approval"; request: ApprovalRequest; resolve: (approved: boolean) => void }
	/**
	 * `contextTokens` / `contextWindow` are absolute so a UI can show occupancy
	 * without recomputing history; `contextUsedPct` is 0-100, never a fraction.
	 */
	| {
			type: "usage";
			promptTokens: number;
			completionTokens: number;
			contextTokens: number;
			contextWindow: number;
			contextUsedPct: number;
	  }
	| { type: "compaction"; removedMessages: number; freedTokens: number }
	| { type: "error"; message: string; fatal: boolean }
	| { type: "done"; steps: number; stopReason: "stop" | "max-steps" | "aborted" | "error" };

export interface AgentRunOptions {
	prompt: string;
	signal?: AbortSignal;
	/** Overrides the config default for this run. */
	maxSteps?: number;
}

export interface Agent {
	/** Streams the full lifecycle of one user request. */
	run(opts: AgentRunOptions): AsyncIterable<AgentEvent>;
	/** Current in-memory history, oldest first, including the system prompt. */
	history(): readonly Message[];
	readonly sessionId: string;
}
