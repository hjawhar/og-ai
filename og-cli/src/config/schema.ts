/**
 * Configuration contract. Layered resolution order (later wins):
 *   defaults -> ~/.og/config.json -> <workspace>/.og/config.json -> OG_* env -> CLI flags
 * Nothing here describes an inference server's internals: og talks to an
 * OpenAI-compatible endpoint over HTTP and never starts, stops or inspects one.
 * Providing that endpoint is a separate concern (see ../../og-llama-cpp for one
 * way to run a local llama.cpp server).
 */

/** One model og can talk to over an OpenAI-compatible API. */
export interface ModelSpec {
	/** Value sent as the OpenAI `model` field. Defaults to the record key. */
	id?: string;
	/** Per-model endpoint override; falls back to the top-level `endpoint`. */
	endpoint?: string;
	/**
	 * Name of the environment variable holding this model's bearer token, so a
	 * config file never has to contain a secret. Falls back to `apiKey`.
	 */
	apiKeyEnv?: string;
	/** Extra request headers, e.g. a gateway's attribution headers. */
	headers?: Record<string, string>;
	/** Usable context window in tokens; the agent budgets and compacts against it. */
	contextWindow: number;
	/** Per-model response cap; falls back to `agent.maxTokens`. */
	maxTokens?: number;
	/** Sent only when set; falls back to `agent.temperature`. */
	temperature?: number;
	topP?: number;
	/**
	 * llama.cpp / vLLM sampling extensions. OpenAI's own API rejects unknown
	 * request fields, so leave these unset for OpenAI proper.
	 */
	topK?: number;
	minP?: number;
	repeatPenalty?: number;
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
	/** Active key in `models`. */
	model: string;
	models: Record<string, ModelSpec>;
	agent: AgentConfig;
	tools: ToolsConfig;
	/** Directory for sessions.db and logs. */
	stateDir: string;
	/**
	 * Where weights live on this machine. og never loads one — it is a client and
	 * starts no server — so this is read only to *show* what is here, next to what
	 * the endpoint is actually serving. `OG_MODELS_DIR` is the same variable
	 * og-llama-cpp's installers and UI use, so one setting moves both.
	 */
	modelsDir: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}
