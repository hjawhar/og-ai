/**
 * OpenAI-compatible streaming provider. The only thing in og that speaks to an
 * inference server: it never spawns, supervises or introspects one, so a local
 * llama.cpp server, OpenAI itself and any gateway are interchangeable here.
 */

import type {
	ChatRequest,
	EndpointHealth,
	FinishReason,
	Message,
	Provider,
	ServedModel,
	StreamEvent,
	ToolCall,
	ToolSpec,
} from "./types.ts";
import { ProviderError } from "./types.ts";

interface WireToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface WireMessage {
	role: Message["role"];
	content: string;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
	name?: string;
}

/** Accumulator for a tool call arriving as indexed deltas. */
interface PendingCall {
	id: string;
	name: string;
	args: string;
}

const RETRYABLE_STATUS: Record<number, true> = {
	408: true,
	409: true,
	425: true,
	429: true,
	500: true,
	502: true,
	503: true,
	504: true,
	529: true,
};

/** Strips internal-only fields and reshapes tool metadata into wire format. */
function toWire(msg: Message): WireMessage {
	const wire: WireMessage = { role: msg.role, content: msg.content };
	if (msg.role === "tool") {
		if (msg.toolCallId !== undefined) wire.tool_call_id = msg.toolCallId;
		if (msg.name !== undefined) wire.name = msg.name;
		return wire;
	}
	if (msg.toolCalls && msg.toolCalls.length > 0) {
		wire.tool_calls = msg.toolCalls.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.name, arguments: call.arguments },
		}));
	}
	return wire;
}

function mapFinishReason(raw: string | null | undefined, sawToolCalls: boolean): FinishReason {
	if (raw === "tool_calls" || raw === "function_call") return "tool_calls";
	if (raw === "length" || raw === "max_tokens") return "length";
	if (sawToolCalls && (raw === null || raw === undefined)) return "tool_calls";
	return "stop";
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	if (typeof err !== "object" || err === null || !("name" in err)) return false;
	return err.name === "AbortError" || err.name === "TimeoutError";
}

function readNumber(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export class OpenAIProvider implements Provider {
	readonly id: string;
	readonly model: string;
	/** Trailing slashes trimmed once so every route concatenation is exact. */
	readonly endpoint: string;
	readonly contextWindow: number;
	readonly nativeToolCalls: boolean;

	private readonly apiKey: string | undefined;
	private readonly extraHeaders: Record<string, string> | undefined;

	constructor(opts: {
		endpoint: string;
		model: string;
		apiKey?: string;
		/** Extra request headers, e.g. a gateway's attribution headers. */
		headers?: Record<string, string>;
		contextWindow: number;
		nativeToolCalls?: boolean;
		id: string;
	}) {
		this.endpoint = opts.endpoint.replace(/\/+$/, "");
		this.model = opts.model;
		this.apiKey = opts.apiKey;
		this.extraHeaders = opts.headers;
		this.contextWindow = opts.contextWindow;
		this.nativeToolCalls = opts.nativeToolCalls ?? true;
		this.id = opts.id;
	}

	/**
	 * Configured headers are applied first so neither they nor a stray `apiKey`
	 * can displace the content type or the bearer token og computed.
	 */
	private headers(): Record<string, string> {
		const headers: Record<string, string> = { ...this.extraHeaders };
		headers["content-type"] = "application/json";
		if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
		return headers;
	}

	async *chat(req: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
		const signal = req.signal;
		if (signal?.aborted) {
			yield { type: "done", finishReason: "aborted" };
			return;
		}

		const body: Record<string, unknown> = {
			model: this.model,
			messages: req.messages.map(toWire),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (req.tools && req.tools.length > 0) body["tools"] = req.tools.map(specToWire);
		if (req.temperature !== undefined) body["temperature"] = req.temperature;
		if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;
		if (req.topP !== undefined) body["top_p"] = req.topP;
		if (req.topK !== undefined) body["top_k"] = req.topK;
		if (req.minP !== undefined) body["min_p"] = req.minP;
		if (req.repeatPenalty !== undefined) body["repeat_penalty"] = req.repeatPenalty;
		if (req.stop && req.stop.length > 0) body["stop"] = req.stop;

		let res: Response;
		try {
			res = await fetch(`${this.endpoint}/v1/chat/completions`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(body),
				...(signal ? { signal } : {}),
			});
		} catch (err) {
			if (isAbort(err, signal)) {
				yield { type: "done", finishReason: "aborted" };
				return;
			}
			const detail = err instanceof Error ? err.message : String(err);
			throw new ProviderError(`cannot reach ${this.endpoint}: ${detail}`, undefined, true);
		}

		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 2000);
			} catch {
				detail = "";
			}
			throw new ProviderError(
				`chat completion failed: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
				res.status,
				RETRYABLE_STATUS[res.status] === true,
			);
		}
		if (!res.body) {
			throw new ProviderError("chat completion response had no body", res.status, true);
		}

		const pending = new Map<number, PendingCall>();
		const order: number[] = [];
		let openIndex: number | undefined;
		let malformed: string | undefined;
		let sawToolCalls = false;
		let usage: { promptTokens: number; completionTokens: number } | undefined;
		let rawFinish: string | null | undefined;
		let streamEnded = false;

		/** Emits a completed call, or records the first malformed-arguments failure. */
		const flush = (index: number): StreamEvent | undefined => {
			const call = pending.get(index);
			pending.delete(index);
			if (!call) return undefined;
			const args = call.args.trim() === "" ? "{}" : call.args;
			try {
				JSON.parse(args);
			} catch (err) {
				malformed ??= `tool call ${call.name || `#${index}`} produced unparseable arguments (${
					err instanceof Error ? err.message : String(err)
				}): ${args.slice(0, 500)}`;
				return undefined;
			}
			sawToolCalls = true;
			const complete: ToolCall = { id: call.id || `call_${index}`, name: call.name, arguments: args };
			return { type: "tool_call", call: complete };
		};

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (!streamEnded) {
				let finished = false;
				try {
					const chunk = await reader.read();
					finished = chunk.done;
					if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
				} catch (err) {
					if (isAbort(err, signal)) {
						yield { type: "done", finishReason: "aborted" };
						return;
					}
					const detail = err instanceof Error ? err.message : String(err);
					throw new ProviderError(`stream read failed: ${detail}`, undefined, true);
				}
				if (finished) {
					// Flush the decoder and terminate a trailing block that lacked its blank line.
					buffer += `${decoder.decode()}\n\n`;
				}

				let cut = buffer.indexOf("\n\n");
				while (cut !== -1) {
					const block = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					cut = buffer.indexOf("\n\n");

					const payload = sseData(block);
					if (payload === undefined) continue;
					if (payload === "[DONE]") {
						// Terminal marker: anything a proxy appends after it is not ours to emit.
						streamEnded = true;
						break;
					}
					let parsed: unknown;
					try {
						parsed = JSON.parse(payload);
					} catch {
						// Keep-alives and non-JSON noise are not fatal.
						continue;
					}
					const frame = asRecord(parsed);
					if (!frame) continue;

					const frameUsage = asRecord(frame["usage"]);
					if (frameUsage) {
						usage = {
							promptTokens: readNumber(frameUsage, "prompt_tokens"),
							completionTokens: readNumber(frameUsage, "completion_tokens"),
						};
					}

					const choices = frame["choices"];
					const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
					if (!choice) continue;
					const finish = choice["finish_reason"];
					if (typeof finish === "string") rawFinish = finish;
					const delta = asRecord(choice["delta"]) ?? asRecord(choice["message"]);
					if (!delta) continue;

					const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
					if (typeof reasoning === "string" && reasoning.length > 0) {
						yield { type: "reasoning", delta: reasoning };
					}
					const content = delta["content"];
					if (typeof content === "string" && content.length > 0) {
						yield { type: "text", delta: content };
					}

					const deltaCalls = delta["tool_calls"];
					if (!Array.isArray(deltaCalls)) continue;
					for (let i = 0; i < deltaCalls.length; i++) {
						const raw = asRecord(deltaCalls[i]);
						if (!raw) continue;
						const rawIndex = raw["index"];
						const index = typeof rawIndex === "number" ? rawIndex : (openIndex ?? order.length);
						if (openIndex !== undefined && openIndex !== index) {
							// A new index supersedes the previous call: it can no longer grow.
							const event = flush(openIndex);
							if (event) yield event;
						}
						openIndex = index;
						let entry = pending.get(index);
						if (!entry) {
							entry = { id: "", name: "", args: "" };
							pending.set(index, entry);
							order.push(index);
						}
						const id = raw["id"];
						if (typeof id === "string" && id.length > 0) entry.id = id;
						const fn = asRecord(raw["function"]);
						if (!fn) continue;
						const name = fn["name"];
						if (typeof name === "string" && name.length > 0) entry.name = name;
						const args = fn["arguments"];
						if (typeof args === "string") entry.args += args;
					}
				}

				if (finished) break;
			}
		} finally {
			reader.releaseLock();
		}

		for (const index of order) {
			const event = flush(index);
			if (event) yield event;
		}

		if (signal?.aborted) {
			yield { type: "done", finishReason: "aborted" };
			return;
		}
		if (usage) {
			yield { type: "usage", promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
		}
		if (malformed !== undefined) {
			yield { type: "done", finishReason: "error", error: malformed };
			return;
		}
		yield { type: "done", finishReason: mapFinishReason(rawFinish, sawToolCalls) };
	}

	/**
	 * Reachability, not readiness: any HTTP answer (401, 404 included) proves
	 * something is listening, which is the only distinction a preflight can make
	 * without guessing a server's error vocabulary. `/v1/models` is the probe
	 * because every OpenAI-compatible server exposes it, llama.cpp included; a
	 * second route would add nothing, since a transport failure fails per host
	 * rather than per path.
	 *
	 * The body is read as well as the status, because that list is the only
	 * authority on which model a request will actually reach: llama.cpp serves
	 * whatever it loaded regardless of the name asked for, so a configured name
	 * that is not in here is a name og would be sending into a fiction.
	 */
	async health(): Promise<EndpointHealth> {
		try {
			const res = await fetch(`${this.endpoint}/v1/models`, { headers: this.headers() });
			const health: EndpointHealth = { reachable: true, status: res.status };
			const served = await servedModels(res);
			if (served !== undefined) health.models = served;
			return health;
		} catch (err) {
			return { reachable: false, detail: err instanceof Error ? err.message : String(err) };
		}
	}
}

/**
 * `{ data: [{ id, meta: { n_ctx } }] }` — the OpenAI list-models shape, plus the
 * `meta` llama.cpp adds. Undefined rather than empty when the body is unreadable
 * or shaped differently, because "answered with something else" and "answered
 * naming no model" mean different things to a caller: only the second one says
 * the server is still loading.
 *
 * `n_ctx` is read because it is the context length the server *actually*
 * allocated. Taking it from here rather than from a number og carries is what
 * stops the two disagreeing silently.
 */
async function servedModels(res: Response): Promise<ServedModel[] | undefined> {
	if (!res.ok) return undefined;
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return undefined;
	}
	if (typeof body !== "object" || body === null || !("data" in body)) return undefined;
	const data = (body as { data: unknown }).data;
	if (!Array.isArray(data)) return undefined;
	const models: ServedModel[] = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null || !("id" in entry)) continue;
		const id = (entry as { id: unknown }).id;
		if (typeof id !== "string" || id.length === 0) continue;
		const window = contextWindowOf(entry);
		models.push(window === undefined ? { id } : { id, contextWindow: window });
	}
	return models;
}

/** `meta.n_ctx` when the server reports it, ignoring anything that is not a positive integer. */
function contextWindowOf(entry: object): number | undefined {
	if (!("meta" in entry)) return undefined;
	const meta = (entry as { meta: unknown }).meta;
	if (typeof meta !== "object" || meta === null || !("n_ctx" in meta)) return undefined;
	const raw = (meta as { n_ctx: unknown }).n_ctx;
	return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function specToWire(spec: ToolSpec): Record<string, unknown> {
	return {
		type: "function",
		function: { name: spec.name, description: spec.description, parameters: spec.parameters },
	};
}

/**
 * Extracts the `data:` payload of one SSE block, joining multi-line data fields
 * and ignoring comments, keep-alives and non-data fields. Returns undefined when
 * the block carries no data.
 */
function sseData(block: string): string | undefined {
	const parts: string[] = [];
	for (const rawLine of block.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0 || line.startsWith(":")) continue;
		if (!line.startsWith("data:")) continue;
		const value = line.slice(5);
		parts.push(value.startsWith(" ") ? value.slice(1) : value);
	}
	if (parts.length === 0) return undefined;
	const joined = parts.join("\n");
	return joined.trim() === "[DONE]" ? "[DONE]" : joined;
}
