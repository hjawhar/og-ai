/**
 * Configuration contract. Layered resolution order (later wins):
 *   defaults -> ~/.og/config.json -> <workspace>/.og/config.json -> OG_* env -> CLI flags
 * No localhost assumption is baked in: `endpoint` is always explicit so the same
 * build works against a shared LAN inference server.
 */

export interface ModelProfile {
	/** GGUF filename relative to `engine.modelsDir`, or an absolute path. */
	file: string;
	/** KV cache context length passed to llama-server (-c). */
	ctx: number;
	/** Layers offloaded to GPU (-ngl). 99 = all. */
	nGpuLayers: number;
	/** MoE expert layers kept on CPU (--n-cpu-moe). Omit for dense models. */
	nCpuMoe?: number;
	cacheTypeK: "f16" | "q8_0" | "q4_0";
	cacheTypeV: "f16" | "q8_0" | "q4_0";
	flashAttn: boolean;
	/** Logical context window the agent budgets against; <= ctx. */
	contextWindow: number;
	/** Sampling defaults recommended by the model authors. */
	temperature: number;
	topP?: number;
	topK?: number;
	minP?: number;
	repeatPenalty?: number;
	/** Extra raw llama-server args. */
	extraArgs?: string[];
}

export interface EngineConfig {
	/** Start llama-server automatically when `endpoint` is unreachable. */
	autoStart: boolean;
	/** Directory containing llama-server.exe. */
	binDir: string;
	/** Directory containing GGUF weights. */
	modelsDir: string;
	host: string;
	port: number;
	/** CPU threads for non-offloaded work. */
	threads: number;
	/** Logical batch size (-b) and physical micro-batch (-ub). */
	batchSize: number;
	ubatchSize: number;
	/** Parallel server slots (--parallel). */
	slots: number;
	/** Seconds to wait for /health to report ok. */
	startupTimeoutSec: number;
}

export type ApprovalPolicy = "always" | "never" | "unsafe-only";

export interface ToolsConfig {
	bash: {
		enabled: boolean;
		approval: ApprovalPolicy;
		timeoutMs: number;
		/** Commands auto-denied regardless of approval policy. */
		denyPatterns: string[];
	};
	edit: {
		approval: ApprovalPolicy;
	};
	/** Glob patterns never read or written by any tool. */
	denyPaths: string[];
	/** Max bytes returned to the model by a single tool call. */
	maxOutputBytes: number;
}

export interface AgentConfig {
	/** Hard cap on model turns per user request. */
	maxSteps: number;
	temperature: number;
	maxTokens: number;
	/** Fraction of the context window reserved for the response and tool results. */
	contextReservePct: number;
	/** Compact history once used tokens exceed this fraction of the window. */
	compactThresholdPct: number;
	/** Max tool calls executed concurrently within one assistant turn. */
	maxParallelTools: number;
}

export interface OgConfig {
	/** OpenAI-compatible base URL, e.g. http://127.0.0.1:8127 */
	endpoint: string;
	apiKey?: string;
	/** Active profile key in `profiles`. */
	model: string;
	profiles: Record<string, ModelProfile>;
	engine: EngineConfig;
	agent: AgentConfig;
	tools: ToolsConfig;
	/** Directory for sessions.db and logs. */
	stateDir: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}
