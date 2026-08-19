/**
 * Smoke fixture, not part of the suite: a deliberately strict OpenAI-shaped
 * endpoint. It rejects any request field OpenAI itself would reject (llama.cpp
 * extensions like top_k/min_p/repeat_penalty), demands a bearer token, and
 * insists the `model` field name one of the models it serves — the three ways a
 * client that assumes llama.cpp breaks against a real cloud API.
 *
 * Run: bun run test/fixtures/strict-openai-server.ts [port]
 */

const OPENAI_FIELDS: Record<string, true> = {
	model: true,
	messages: true,
	stream: true,
	stream_options: true,
	tools: true,
	tool_choice: true,
	temperature: true,
	top_p: true,
	max_tokens: true,
	stop: true,
	n: true,
	seed: true,
	presence_penalty: true,
	frequency_penalty: true,
	logprobs: true,
	user: true,
};

const MODELS = ["strict-gpt", "strict-gpt-mini"];
const TOKEN = process.env["STRICT_TOKEN"] ?? "test-token";
const port = Number.parseInt(process.argv[2] ?? "8199", 10);

function sse(frame: unknown): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}

const server = Bun.serve({
	port,
	idleTimeout: 30,
	async fetch(req) {
		const url = new URL(req.url);
		const auth = req.headers.get("authorization");
		if (auth !== `Bearer ${TOKEN}`) {
			console.error(`[strict] 401 ${url.pathname} auth=${auth ?? "(none)"}`);
			return Response.json({ error: { message: "missing or wrong bearer token" } }, { status: 401 });
		}
		if (url.pathname === "/v1/models") {
			return Response.json({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) });
		}
		if (url.pathname !== "/v1/chat/completions") {
			return Response.json({ error: { message: `no such route ${url.pathname}` } }, { status: 404 });
		}

		const body: unknown = await req.json();
		if (typeof body !== "object" || body === null) {
			return Response.json({ error: { message: "body must be an object" } }, { status: 400 });
		}
		const record = body as Record<string, unknown>;
		const unknown = Object.keys(record).filter((key) => OPENAI_FIELDS[key] !== true);
		if (unknown.length > 0) {
			console.error(`[strict] 400 unrecognised fields: ${unknown.join(", ")}`);
			return Response.json(
				{ error: { message: `Unrecognized request argument supplied: ${unknown.join(", ")}` } },
				{ status: 400 },
			);
		}
		const model = record["model"];
		if (typeof model !== "string" || !MODELS.includes(model)) {
			console.error(`[strict] 404 unknown model ${JSON.stringify(model)}`);
			return Response.json(
				{ error: { message: `The model \`${String(model)}\` does not exist`, type: "invalid_request_error" } },
				{ status: 404 },
			);
		}
		console.error(
			`[strict] 200 model=${model} temperature=${JSON.stringify(record["temperature"])} top_p=${JSON.stringify(record["top_p"])} max_tokens=${JSON.stringify(record["max_tokens"])} tools=${Array.isArray(record["tools"]) ? record["tools"].length : 0}`,
		);

		const reply = `ok: ${model} answered ${Array.isArray(record["messages"]) ? record["messages"].length : 0} messages`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(encoder.encode(sse({ choices: [{ delta: { role: "assistant" } }] })));
				for (const word of reply.split(" ")) {
					controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: `${word} ` } }] })));
				}
				controller.enqueue(encoder.encode(sse({ choices: [{ delta: {}, finish_reason: "stop" }] })));
				controller.enqueue(
					encoder.encode(sse({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 12 } })),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

console.error(`[strict] listening on http://127.0.0.1:${server.port} models=${MODELS.join(",")} token=${TOKEN}`);
