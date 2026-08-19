/**
 * SSE parsing is the highest-risk code in the harness: it runs on every token,
 * network chunk boundaries fall wherever the kernel puts them, and llama.cpp
 * streams tool-call arguments as indexed fragments. Every test here drives a
 * real HTTP server on an ephemeral port that replays canned wire bytes, so the
 * chunking the parser sees is genuine rather than simulated.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/load.ts";
import { ConfigError } from "../src/config/schema.ts";
import type { ModelSpec, OgConfig } from "../src/config/schema.ts";
import { OpenAIProvider } from "../src/provider/openai.ts";
import { createProvider } from "../src/provider/registry.ts";
import { ProviderError, type Message, type StreamEvent, type ToolSpec } from "../src/provider/types.ts";

const servers: Bun.Server<undefined>[] = [];
let releaseHeldStreams: (() => void) | undefined;

afterEach(() => {
	releaseHeldStreams?.();
	releaseHeldStreams = undefined;
	for (const server of servers) server.stop(true);
	servers.length = 0;
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function provider(endpoint: string): OpenAIProvider {
	return new OpenAIProvider({ endpoint, model: "test-model", contextWindow: 32768, id: "qwen3-coder-30b" });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Replays `chunks` as distinct network writes; the parser must survive the splits. */
function sse(chunks: readonly string[], opts?: { hold?: boolean }): Response {
	const encoder = new TextEncoder();
	const held = new Promise<void>((resolve) => {
		releaseHeldStreams = resolve;
	});
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			if (opts?.hold) await held;
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function frame(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function textFrame(delta: string): string {
	return frame({ choices: [{ index: 0, delta: { content: delta } }] });
}

/** One indexed tool-call delta, exactly as llama.cpp's --jinja server emits them. */
function toolFrame(index: number, patch: { id?: string; name?: string; args?: string }): string {
	const fn: Record<string, string> = {};
	if (patch.name !== undefined) fn["name"] = patch.name;
	if (patch.args !== undefined) fn["arguments"] = patch.args;
	const call: Record<string, unknown> = { index, type: "function", function: fn };
	if (patch.id !== undefined) call["id"] = patch.id;
	return frame({ choices: [{ index: 0, delta: { tool_calls: [call] } }] });
}

const FINISH_STOP = frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const FINISH_TOOLS = frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
const DONE = "data: [DONE]\n\n";

describe("chat streaming", () => {
	test("text deltas arrive in order and terminate with exactly one done", async () => {
		const endpoint = serve(() => sse([textFrame("Hel"), textFrame("lo, "), textFrame("world"), FINISH_STOP, DONE]));
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));

		expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : ""))).toEqual([
			"Hel",
			"lo, ",
			"world",
		]);
		expect(events.filter((e) => e.type === "done")).toHaveLength(1);
		expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
	});

	test("a network chunk boundary inside an SSE line does not corrupt the stream", async () => {
		const wire = [textFrame("alpha"), textFrame("beta"), FINISH_STOP, DONE].join("");
		// Split mid-token inside the first frame's JSON string, and again mid-frame.
		const cut = wire.indexOf("alpha") + 2;
		expect(cut).toBeGreaterThan(2);
		const endpoint = serve(() => sse([wire.slice(0, cut), wire.slice(cut, cut + 30), wire.slice(cut + 30)]));

		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(events).toEqual([
			{ type: "text", delta: "alpha" },
			{ type: "text", delta: "beta" },
			{ type: "done", finishReason: "stop" },
		]);
	});

	test("reasoning_content is surfaced separately from content", async () => {
		const endpoint = serve(() =>
			sse([
				frame({ choices: [{ index: 0, delta: { reasoning_content: "let me think" } }] }),
				textFrame("answer"),
				FINISH_STOP,
				DONE,
			]),
		);
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(events.slice(0, 2)).toEqual([
			{ type: "reasoning", delta: "let me think" },
			{ type: "text", delta: "answer" },
		]);
	});

	test("comments, keep-alives and unspaced data fields are ignored", async () => {
		const endpoint = serve(() =>
			sse([
				": ping\n\n",
				"\n\n",
				`data:${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
				":\n\n",
				"event: message\nid: 7\n\n",
				FINISH_STOP,
				DONE,
				frame({ choices: [{ index: 0, delta: { content: "after done" } }] }),
			]),
		);
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(events).toEqual([
			{ type: "text", delta: "ok" },
			{ type: "done", finishReason: "stop" },
		]);
	});

	test("usage from the final chunk is emitted before done", async () => {
		const endpoint = serve(() =>
			sse([
				textFrame("x"),
				FINISH_STOP,
				frame({ choices: [], usage: { prompt_tokens: 6144, completion_tokens: 256 } }),
				DONE,
			]),
		);
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(events.slice(-2)).toEqual([
			{ type: "usage", promptTokens: 6144, completionTokens: 256 },
			{ type: "done", finishReason: "stop" },
		]);
	});

	test("a trailing frame without its blank line is still parsed", async () => {
		const endpoint = serve(() => sse([textFrame("tail"), 'data: {"choices":[{"index":0,"finish_reason":"stop"}]}']));
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(events).toEqual([
			{ type: "text", delta: "tail" },
			{ type: "done", finishReason: "stop" },
		]);
	});
});

describe("tool call accumulation", () => {
	test("fragmented arguments split across chunk boundaries yield one parsed call", async () => {
		const args = JSON.stringify({ path: "src/deep/nested/file.ts", content: 'const s = "hi";\nexport {};\n' });
		const wire = [
			toolFrame(0, { id: "call_abc", name: "write", args: "" }),
			toolFrame(0, { args: args.slice(0, 11) }),
			toolFrame(0, { args: args.slice(11, 34) }),
			toolFrame(0, { args: args.slice(34) }),
			FINISH_TOOLS,
			DONE,
		].join("");

		// Both cuts land inside a JSON string within a data line.
		const cutInName = wire.indexOf('"write"') + 3;
		const cutInArgs = wire.lastIndexOf("nested") + 2;
		expect(cutInName).toBeGreaterThan(3);
		expect(cutInArgs).toBeGreaterThan(cutInName);
		const endpoint = serve(() =>
			sse([wire.slice(0, cutInName), wire.slice(cutInName, cutInArgs), wire.slice(cutInArgs)]),
		);

		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "write it" }] }));
		const calls = events.filter((e) => e.type === "tool_call");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			type: "tool_call",
			call: { id: "call_abc", name: "write", arguments: args },
		});
		expect(JSON.parse(args)).toEqual({
			path: "src/deep/nested/file.ts",
			content: 'const s = "hi";\nexport {};\n',
		});
		expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
	});

	test("two calls at indices 0 and 1 are both emitted in index order", async () => {
		const endpoint = serve(() =>
			sse([
				toolFrame(0, { id: "call_a", name: "read", args: '{"path":' }),
				toolFrame(0, { args: '"a.ts"}' }),
				toolFrame(1, { id: "call_b", name: "grep", args: '{"pattern":"TODO"' }),
				toolFrame(1, { args: "}" }),
				FINISH_TOOLS,
				DONE,
			]),
		);
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "go" }] }));
		const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
		expect(calls).toEqual([
			{ id: "call_a", name: "read", arguments: '{"path":"a.ts"}' },
			{ id: "call_b", name: "grep", arguments: '{"pattern":"TODO"}' },
		]);
		expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
	});

	test("missing finish_reason still reports tool_calls when a call was emitted", async () => {
		const endpoint = serve(() =>
			sse([toolFrame(0, { id: "call_a", name: "ls", args: '{"path":"."}' }), DONE]),
		);
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "go" }] }));
		expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
	});

	test("empty arguments default to an empty JSON object", async () => {
		const endpoint = serve(() => sse([toolFrame(0, { id: "call_a", name: "ls", args: "" }), FINISH_TOOLS, DONE]));
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "go" }] }));
		const call = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
		expect(call).toEqual([{ id: "call_a", name: "ls", arguments: "{}" }]);
	});

	test("unparseable arguments produce a single error done and no tool_call", async () => {
		const endpoint = serve(() =>
			sse([
				toolFrame(0, { id: "call_a", name: "edit", args: '{"path":"a.ts","old":' }),
				FINISH_TOOLS,
				DONE,
			]),
		);
		const events = await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "go" }] }));

		expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
		const dones = events.filter((e) => e.type === "done");
		expect(dones).toHaveLength(1);
		const done = dones[0];
		expect(done?.type === "done" ? done.finishReason : undefined).toBe("error");
		expect(done?.type === "done" ? done.error : undefined).toContain("edit");
	});
});

describe("abort handling", () => {
	test("aborting mid-stream ends with finishReason aborted", async () => {
		const endpoint = serve(() => sse([textFrame("partial ")], { hold: true }));
		const controller = new AbortController();

		const events: StreamEvent[] = [];
		for await (const event of provider(endpoint).chat({
			messages: [{ role: "user", content: "hi" }],
			signal: controller.signal,
		})) {
			events.push(event);
			if (event.type === "text") controller.abort();
		}

		expect(events).toEqual([
			{ type: "text", delta: "partial " },
			{ type: "done", finishReason: "aborted" },
		]);
	});

	test("a pre-aborted signal yields only done and never contacts the server", async () => {
		let requests = 0;
		const endpoint = serve(() => {
			requests += 1;
			return sse([FINISH_STOP, DONE]);
		});
		const controller = new AbortController();
		controller.abort();

		const events = await collect(
			provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }], signal: controller.signal }),
		);
		expect(events).toEqual([{ type: "done", finishReason: "aborted" }]);
		expect(requests).toBe(0);
	});
});

describe("HTTP failures", () => {
	test("503 is a retryable ProviderError carrying the status", async () => {
		const endpoint = serve(() => new Response("slots are full", { status: 503 }));
		let err: unknown;
		try {
			await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		} catch (caught) {
			err = caught;
		}
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).retryable).toBe(true);
		expect((err as ProviderError).status).toBe(503);
		expect((err as ProviderError).message).toContain("slots are full");
	});

	test("404 is a non-retryable ProviderError", async () => {
		const endpoint = serve(() => new Response("no such route", { status: 404 }));
		let err: unknown;
		try {
			await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		} catch (caught) {
			err = caught;
		}
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).retryable).toBe(false);
		expect((err as ProviderError).status).toBe(404);
	});

	test("an unreachable endpoint is retryable", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
		const endpoint = `http://127.0.0.1:${server.port}`;
		server.stop(true);

		let err: unknown;
		try {
			await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));
		} catch (caught) {
			err = caught;
		}
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).retryable).toBe(true);
	});
});

describe("outgoing request payload", () => {
	const TOOL: ToolSpec = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	};

	const MESSAGES: Message[] = [
		{ role: "system", content: "you are og" },
		{ role: "user", content: "fix the off-by-one" },
		{
			role: "assistant",
			content: "",
			reasoning: "internal trace that must never reach the wire",
			toolCalls: [{ id: "call_0", name: "read", arguments: '{"path":"src/fizzbuzz.ts"}' }],
		},
		{ role: "tool", content: "for (let i = 1; i < n; i++)", toolCallId: "call_0", name: "read" },
	];

	test("wire body streams, maps tool calls and drops internal reasoning", async () => {
		let body: Record<string, unknown> | undefined;
		const endpoint = serve(async (req) => {
			expect(new URL(req.url).pathname).toBe("/v1/chat/completions");
			expect(req.headers.get("authorization")).toBe("Bearer secret-key");
			body = (await req.json()) as Record<string, unknown>;
			return sse([FINISH_STOP, DONE]);
		});

		const client = new OpenAIProvider({
			endpoint: `${endpoint}/`,
			model: "test-model",
			apiKey: "secret-key",
			contextWindow: 32768,
			id: "qwen3-coder-30b",
		});
		await collect(client.chat({ messages: MESSAGES, tools: [TOOL], temperature: 0.2, maxTokens: 8192 }));

		expect(body?.["stream"]).toBe(true);
		expect(body?.["stream_options"]).toEqual({ include_usage: true });
		expect(body?.["model"]).toBe("test-model");
		expect(body?.["temperature"]).toBe(0.2);
		expect(body?.["max_tokens"]).toBe(8192);
		expect(body?.["tools"]).toEqual([
			{ type: "function", function: { name: "read", description: "Read a file", parameters: TOOL.parameters } },
		]);

		// toEqual on the whole array proves `reasoning` is absent, not merely unused.
		expect(body?.["messages"]).toEqual([
			{ role: "system", content: "you are og" },
			{ role: "user", content: "fix the off-by-one" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "call_0", type: "function", function: { name: "read", arguments: '{"path":"src/fizzbuzz.ts"}' } },
				],
			},
			{
				role: "tool",
				content: "for (let i = 1; i < n; i++)",
				tool_call_id: "call_0",
				name: "read",
			},
		]);
	});

	test("optional request fields are omitted when unset", async () => {
		let body: Record<string, unknown> | undefined;
		const endpoint = serve(async (req) => {
			body = (await req.json()) as Record<string, unknown>;
			return sse([FINISH_STOP, DONE]);
		});
		await collect(provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }] }));

		expect(Object.keys(body ?? {}).sort()).toEqual(["messages", "model", "stream", "stream_options"]);
	});

	test("sampling knobs are sent under their OpenAI-compatible wire names", async () => {
		let body: Record<string, unknown> | undefined;
		const endpoint = serve(async (req) => {
			body = (await req.json()) as Record<string, unknown>;
			return sse([FINISH_STOP, DONE]);
		});
		await collect(
			provider(endpoint).chat({
				messages: [{ role: "user", content: "hi" }],
				temperature: 0.2,
				maxTokens: 4096,
				topP: 0.8,
				topK: 20,
				minP: 0,
				repeatPenalty: 1.05,
			}),
		);

		expect(body?.["temperature"]).toBe(0.2);
		expect(body?.["max_tokens"]).toBe(4096);
		expect(body?.["top_p"]).toBe(0.8);
		expect(body?.["top_k"]).toBe(20);
		// Zero is a meaningful min-p, so presence — not truthiness — decides.
		expect(body?.["min_p"]).toBe(0);
		expect(body?.["repeat_penalty"]).toBe(1.05);
	});

	test("each extension appears only when its own field is set", async () => {
		// OpenAI proper rejects unknown request fields outright, so a knob og was
		// not asked for must not appear at all — not even as null.
		let body: Record<string, unknown> | undefined;
		const endpoint = serve(async (req) => {
			body = (await req.json()) as Record<string, unknown>;
			return sse([FINISH_STOP, DONE]);
		});
		await collect(
			provider(endpoint).chat({ messages: [{ role: "user", content: "hi" }], topK: 20 }),
		);

		expect(Object.keys(body ?? {}).sort()).toEqual([
			"messages",
			"model",
			"stream",
			"stream_options",
			"top_k",
		]);
	});

	test("configured headers are merged in but cannot displace og's own", async () => {
		let seen: Headers | undefined;
		const endpoint = serve((req) => {
			seen = req.headers;
			return sse([FINISH_STOP, DONE]);
		});

		const client = new OpenAIProvider({
			endpoint,
			model: "test-model",
			apiKey: "secret-key",
			contextWindow: 32768,
			id: "qwen3-coder-30b",
			headers: {
				"http-referer": "https://og.local",
				"x-title": "og",
				// A gateway config must not be able to break JSON transport or
				// silently downgrade the bearer token og resolved.
				"content-type": "text/plain",
				authorization: "Bearer attacker",
			},
		});
		await collect(client.chat({ messages: [{ role: "user", content: "hi" }] }));

		expect(seen?.get("http-referer")).toBe("https://og.local");
		expect(seen?.get("x-title")).toBe("og");
		expect(seen?.get("content-type")).toBe("application/json");
		expect(seen?.get("authorization")).toBe("Bearer secret-key");
	});
});

describe("health", () => {
	test("one GET to /v1/models is the whole probe, and its body names the served models", async () => {
		const routes: string[] = [];
		const endpoint = serve((req) => {
			routes.push(`${req.method} ${new URL(req.url).pathname}`);
			// `meta.n_ctx` is what llama.cpp reports; a gateway that omits it is the
			// second entry.
			return Response.json({ data: [{ id: "test-model", meta: { n_ctx: 8192 } }, { id: "other-model" }] });
		});

		// The ids matter as much as the status: llama.cpp answers a request with
		// whatever it loaded regardless of the name asked for, so this list is the
		// only proof of which model a request would actually reach — and `n_ctx` is
		// the window it actually allocated, which og would otherwise have to guess.
		expect(await provider(endpoint).health()).toEqual({
			reachable: true,
			status: 200,
			models: [{ id: "test-model", contextWindow: 8192 }, { id: "other-model" }],
		});
		// Exactly one request: every OpenAI-compatible server exposes this route,
		// and a second probe could not tell reachability apart from the first,
		// because a transport failure fails per host rather than per path.
		expect(routes).toEqual(["GET /v1/models"]);
	});

	test("a nonsense n_ctx is ignored rather than believed", async () => {
		const endpoint = serve(() => Response.json({ data: [{ id: "m", meta: { n_ctx: -1 } }, { id: "n", meta: { n_ctx: "lots" } }] }));
		expect((await provider(endpoint).health()).models).toEqual([{ id: "m" }, { id: "n" }]);
	});

	test("an answer that is not a model list leaves the served set unknown, not empty", async () => {
		// Absent and empty mean different things downstream: empty says the server
		// named nothing, which for llama.cpp means it is still loading.
		const endpoint = serve(() => Response.json({ object: "list" }));
		const health = await provider(endpoint).health();
		expect(health.reachable).toBe(true);
		expect(health.models).toBeUndefined();
	});

	test("a served list with no usable ids is empty rather than absent", async () => {
		const endpoint = serve(() => Response.json({ data: [] }));
		expect((await provider(endpoint).health()).models).toEqual([]);
	});

	test("a 404 model list is still an answer: something is listening", async () => {
		// The preflight's only job is to tell "nothing is listening" from "the
		// server disagrees with you", so any HTTP status settles it and the
		// server's own error text is what the user goes on to see.
		const routes: string[] = [];
		const endpoint = serve((req) => {
			routes.push(new URL(req.url).pathname);
			return new Response("nope", { status: 404 });
		});
		// A non-2xx body is not a model list, so nothing is claimed about what is served.
		expect(await provider(endpoint).health()).toEqual({ reachable: true, status: 404 });
		expect(routes).toEqual(["/v1/models"]);
	});

	test("a 401 is reachable: an auth failure is the server talking", async () => {
		const endpoint = serve(() => new Response("invalid api key", { status: 401 }));
		expect(await provider(endpoint).health()).toEqual({ reachable: true, status: 401 });
	});

	test("a 503 from a server still warming up is reachable, not missing", async () => {
		const endpoint = serve(() => new Response("loading model", { status: 503 }));
		expect(await provider(endpoint).health()).toEqual({ reachable: true, status: 503 });
	});

	test("only a transport failure is unreachable, and it explains itself", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
		const endpoint = `http://127.0.0.1:${server.port}`;
		server.stop(true);

		const health = await provider(endpoint).health();
		expect(health.reachable).toBe(false);
		expect(health.status).toBeUndefined();
		expect(health.detail).toBeTruthy();
	});
});

describe("createProvider", () => {
	/** Env vars this describe touched, with their pre-test values. */
	const savedEnv = new Map<string, string | undefined>();

	function setEnv(name: string, value: string | undefined): void {
		if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	afterEach(() => {
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		savedEnv.clear();
	});

	/** `apiKey` is applied only when given, so the no-key case really has none. */
	function config(model: string, models: Record<string, ModelSpec>, apiKey?: string): OgConfig {
		return {
			...DEFAULT_CONFIG,
			endpoint: "http://127.0.0.1:8127",
			model,
			models,
			...(apiKey === undefined ? {} : { apiKey }),
		};
	}

	test("the record key is the wire model name unless the spec overrides it", () => {
		const aliased = createProvider(
			config("qwen3-coder-30b", {
				"qwen3-coder-30b": { id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", contextWindow: 32768 },
			}),
		);
		expect(aliased.model).toBe("Qwen/Qwen3-Coder-30B-A3B-Instruct");
		// `id` is the config key: sessions and the status bar name the key, not the alias.
		expect(aliased.id).toBe("qwen3-coder-30b");
		expect(aliased.contextWindow).toBe(32768);

		const plain = createProvider(config("gpt-4o", { "gpt-4o": { contextWindow: 128_000 } }));
		expect(plain.model).toBe("gpt-4o");
	});

	test("a loopback endpoint gets the real model name, never a literal placeholder", () => {
		// og used to send "local" to any loopback server and ignore the model name.
		// Every server that matters now serves several models, so the honest name
		// is the only correct one — and no env var may bring the old behaviour back.
		setEnv("OG_LOCAL_ENDPOINT", "1");
		const local = createProvider(
			config("qwen3-coder-30b", { "qwen3-coder-30b": { contextWindow: 32768 } }),
		);
		expect(local.model).toBe("qwen3-coder-30b");
		expect(local.endpoint).toBe("http://127.0.0.1:8127");
	});

	test("a per-model endpoint wins over the top-level one", () => {
		const cfg = config("hosted", {
			hosted: { endpoint: "https://api.deepseek.com", contextWindow: 65536 },
			local: { contextWindow: 32768 },
		});
		expect(createProvider(cfg).endpoint).toBe("https://api.deepseek.com");
		expect(createProvider({ ...cfg, model: "local" }).endpoint).toBe("http://127.0.0.1:8127");
	});

	test("apiKeyEnv reads the named variable and beats the config's own key", async () => {
		let auth: string | null | undefined;
		const endpoint = serve((req) => {
			auth = req.headers.get("authorization");
			return sse([FINISH_STOP, DONE]);
		});
		setEnv("OG_TEST_PROVIDER_KEY", "sk-from-env");

		const client = createProvider(
			config(
				"hosted",
				{ hosted: { apiKeyEnv: "OG_TEST_PROVIDER_KEY", contextWindow: 8192, endpoint } },
				"sk-from-config",
			),
		);
		await collect(client.chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(auth).toBe("Bearer sk-from-env");
	});

	test("an unset or empty apiKeyEnv is a ConfigError, not an anonymous request", () => {
		for (const value of [undefined, ""]) {
			setEnv("OG_TEST_PROVIDER_KEY", value);
			const cfg = config("hosted", {
				hosted: { apiKeyEnv: "OG_TEST_PROVIDER_KEY", contextWindow: 8192 },
			});

			let err: unknown;
			try {
				createProvider(cfg);
			} catch (caught) {
				err = caught;
			}
			expect(err, JSON.stringify(value)).toBeInstanceOf(ConfigError);
			expect((err as Error).message).toContain("hosted");
			expect((err as Error).message).toContain("OG_TEST_PROVIDER_KEY");
			// The variable's name may be echoed; a value never can be.
			expect((err as Error).message).not.toContain("sk-");
		}
	});

	test("the config apiKey is used when no apiKeyEnv is named", async () => {
		let auth: string | null | undefined;
		const endpoint = serve((req) => {
			auth = req.headers.get("authorization");
			return sse([FINISH_STOP, DONE]);
		});
		const client = createProvider(
			config("hosted", { hosted: { contextWindow: 8192, endpoint } }, "sk-from-config"),
		);
		await collect(client.chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(auth).toBe("Bearer sk-from-config");
	});

	test("no key anywhere means no authorization header at all", async () => {
		let hasAuth: boolean | undefined;
		const endpoint = serve((req) => {
			hasAuth = req.headers.has("authorization");
			return sse([FINISH_STOP, DONE]);
		});
		// DEFAULT_CONFIG ships no `apiKey`, so this config genuinely has none.
		const cfg = config("local", { local: { contextWindow: 8192, endpoint } });
		expect(cfg.apiKey).toBeUndefined();

		await collect(createProvider(cfg).chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(hasAuth).toBe(false);
	});

	test("spec headers reach the wire", async () => {
		let seen: Headers | undefined;
		const endpoint = serve((req) => {
			seen = req.headers;
			return sse([FINISH_STOP, DONE]);
		});
		const client = createProvider(
			config("hosted", {
				hosted: {
					contextWindow: 8192,
					endpoint,
					headers: { "HTTP-Referer": "https://og.local", "X-Title": "og" },
				},
			}),
		);
		await collect(client.chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(seen?.get("http-referer")).toBe("https://og.local");
		expect(seen?.get("x-title")).toBe("og");
	});

	test("an unknown active model is a ConfigError from the spec lookup", () => {
		const cfg = config("ghost", { real: { contextWindow: 8192 } });
		expect(() => createProvider(cfg)).toThrow(ConfigError);
	});
});
