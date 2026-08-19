/**
 * Provider contract. Any OpenAI-compatible endpoint (a local llama.cpp server,
 * OpenAI itself, a gateway) is reduced to this interface so the agent loop never
 * learns backend specifics — and so nothing above it can reach a process.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A model-requested tool invocation. `arguments` is a raw JSON string as emitted by the model. */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface Message {
	role: Role;
	/** Text content. Empty string when an assistant turn is pure tool calls. */
	content: string;
	/** Present only on assistant turns that requested tools. */
	toolCalls?: ToolCall[];
	/** Present only on `role: "tool"` turns; must match a prior ToolCall.id. */
	toolCallId?: string;
	/** Tool name echoed back on `role: "tool"` turns. */
	name?: string;
	/** Model reasoning trace, when the backend separates it from content. */
	reasoning?: string;
}

/** JSON Schema subset used for tool parameter declarations. */
export interface JSONSchema {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JSONSchema;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "aborted" | "error";

export type StreamEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	/** Emitted once per tool call, only when its arguments are complete and parseable. */
	| { type: "tool_call"; call: ToolCall }
	| { type: "usage"; promptTokens: number; completionTokens: number }
	| { type: "done"; finishReason: FinishReason; error?: string };

export interface ChatRequest {
	messages: Message[];
	tools?: ToolSpec[];
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	/**
	 * llama.cpp / vLLM sampling extensions, sent only when set: OpenAI's API
	 * rejects request fields it does not know.
	 */
	topK?: number;
	minP?: number;
	repeatPenalty?: number;
	stop?: string[];
	signal?: AbortSignal;
}

/** Outcome of an endpoint reachability probe. */
export interface EndpointHealth {
	/** True when the server answered at all — 401 and 404 are answers. */
	reachable: boolean;
	/** HTTP status of the probe that answered. */
	status?: number;
	/** Transport failure detail when nothing answered. */
	detail?: string;
}

export interface ProviderInfo {
	/** Model key from config, e.g. "qwen3-coder-30b". */
	id: string;
	/** Model identifier sent to the backend. */
	model: string;
	/** Base URL this provider talks to, after any per-model override. */
	endpoint: string;
	/** Usable context window in tokens. */
	contextWindow: number;
	/** True when the backend natively parses tool calls (any server with a chat template). */
	nativeToolCalls: boolean;
}

export interface Provider extends ProviderInfo {
	/** Streaming chat completion. Must always terminate with a single `done` event. */
	chat(req: ChatRequest): AsyncIterable<StreamEvent>;
	/** Cheap reachability probe used as a preflight before a run. */
	health(): Promise<EndpointHealth>;
}

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryable = false,
	) {
		super(message);
		this.name = "ProviderError";
	}
}
