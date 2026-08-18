import type { Agent } from "../agent/types.ts";
import type { OgConfig } from "../config/schema.ts";
import type { EngineSupervisor } from "../engine/supervisor.ts";
import type { SessionStore } from "../session/types.ts";
import type { ApprovalRequest } from "../tools/types.ts";

/** Answers a tool approval request. Installed by the running UI. */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<boolean>;

/** Which session the rebuilt agent should be bound to. */
export type SessionSelector = "new" | "keep" | { readonly id: string };

export interface RebuildRequest {
	/** Defaults to "keep". */
	session?: SessionSelector;
	/** Profile key to make active; omit to keep the current one. */
	model?: string;
}

export interface RebuildResult {
	agent: Agent;
	sessionId: string;
	/** Active profile key after the rebuild. */
	model: string;
	/** True when the new profile needs a different engine process than the running one. */
	engineRestartRequired: boolean;
}

/**
 * Everything a UI surface needs. The five required members are the stable
 * contract; the optional members are wiring the CLI entrypoint supplies so the
 * TUI can switch models and sessions, and are absent for embedders that only
 * want to stream one agent run.
 */
export interface UiDeps {
	config: OgConfig;
	agent: Agent;
	supervisor: EngineSupervisor;
	store: SessionStore;
	sessionId: string;
	/** Absolute workspace root, for display and relative-path rendering. */
	workspaceRoot?: string;
	/** Absolute cwd the agent runs in. */
	cwd?: string;
	/** Per-run step cap override from `--max-steps`. */
	maxSteps?: number;
	/** `--verbose`: surface reasoning deltas, raw errors and turn boundaries. */
	verbose?: boolean;
	/** CLI version, shown in the TUI banner. */
	version?: string;
	/**
	 * Installs the handler the agent's `approve` callback delegates to, so the
	 * live UI owns the prompt. Passing null restores the config-policy default.
	 */
	setApprovalHandler?(handler: ApprovalHandler | null): void;
	/** Rebuilds provider+agent for a different profile and/or session. */
	rebuild?(req: RebuildRequest): Promise<RebuildResult>;
}

/** Result line emitted by headless JSON mode after the event stream. */
export interface HeadlessResult {
	type: "result";
	text: string;
	steps: number;
	stopReason: "stop" | "max-steps" | "aborted" | "error";
	promptTokens: number;
	completionTokens: number;
	sessionId: string;
}

/** Exit codes both surfaces agree on. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_MAX_STEPS = 2;
export const EXIT_ABORTED = 130;
