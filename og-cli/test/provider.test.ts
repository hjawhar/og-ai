/**
 * SSE parsing is the highest-risk code in the harness: it runs on every token,
 * network chunk boundaries fall wherever the kernel puts them, and llama.cpp
 * streams tool-call arguments as indexed fragments. Every test here drives a
 * real HTTP server on an ephemeral port that replays canned wire bytes, so the
 * chunking the parser sees is genuine rather than simulated.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { OpenAIProvider } from "../src/provider/openai.ts";
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
});

describe("countTokens", () => {
	test("uses /tokenize when the backend provides it", async () => {
		const endpoint = serve(async (req) => {
			expect(new URL(req.url).pathname).toBe("/tokenize");
			const payload = (await req.json()) as { content: string };
			return Response.json({ tokens: [...payload.content].map((_, i) => i) });
		});
		expect(await provider(endpoint).countTokens("abcdefghij")).toBe(10);
	});

	test("falls back to ceil(len / 3.6) and stops retrying once /tokenize 404s", async () => {
		let requests = 0;
		const endpoint = serve(() => {
			requests += 1;
			return new Response("not found", { status: 404 });
		});
		const client = provider(endpoint);
		const text = "x".repeat(100);

		expect(await client.countTokens(text)).toBe(Math.ceil(100 / 3.6));
		expect(await client.countTokens(text)).toBe(28);
		expect(requests).toBe(1);
	});

	test("a tokenize response without a tokens array falls back to the estimate", async () => {
		const endpoint = serve(() => Response.json({ error: "unsupported" }));
		expect(await provider(endpoint).countTokens("abc")).toBe(1);
	});
});

describe("health", () => {
	test("true when /health reports ok", async () => {
		const endpoint = serve(() => Response.json({ status: "ok" }));
		expect(await provider(endpoint).health()).toBe(true);
	});

	test("falls back to /v1/models when /health is absent", async () => {
		const endpoint = serve((req) =>
			new URL(req.url).pathname === "/v1/models"
				? Response.json({ data: [{ id: "test-model" }] })
				: new Response("nope", { status: 404 }),
		);
		expect(await provider(endpoint).health()).toBe(true);
	});

	test("false while the model is still loading", async () => {
		const endpoint = serve(() => new Response("loading model", { status: 503 }));
		expect(await provider(endpoint).health()).toBe(false);
	});

	test("false when the endpoint is down", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
		const endpoint = `http://127.0.0.1:${server.port}`;
		server.stop(true);
		expect(await provider(endpoint).health()).toBe(false);
	});
});
