/**
 * Compaction runs unattended on long sessions; a bug here corrupts the
 * transcript in ways llama.cpp's chat template rejects outright (orphaned tool
 * replies) or that silently lose the system prompt. Every test below asserts an
 * invariant of the returned history rather than a particular drop count.
 */

import { describe, expect, test } from "bun:test";

import { compact, estimateTokens, messageTokens } from "../src/agent/context.ts";
import type { Message } from "../src/provider/types.ts";

const MARKER_PREFIX = "[earlier context omitted:";

/**
 * `turns` conversations, each: user -> assistant with two tool calls -> two tool
 * replies -> assistant summary. That is the shape the agent loop actually
 * persists, and the shape most likely to break when messages are dropped.
 */
function transcript(turns: number): Message[] {
	const messages: Message[] = [
		{ role: "system", content: `SYSTEM PROMPT ${"s".repeat(200)}` },
	];
	for (let t = 0; t < turns; t++) {
		messages.push({ role: "user", content: `question ${t} ${"q".repeat(80)}` });
		messages.push({
			role: "assistant",
			content: "",
			toolCalls: [
				{ id: `call-${t}-a`, name: "read", arguments: `{"path":"file${t}.ts"}` },
				{ id: `call-${t}-b`, name: "grep", arguments: `{"pattern":"x${t}"}` },
			],
		});
		messages.push({
			role: "tool",
			content: `file${t}.ts contents ${"c".repeat(120)}`,
			toolCallId: `call-${t}-a`,
			name: "read",
		});
		messages.push({
			role: "tool",
			content: `2 matches ${"m".repeat(60)}`,
			toolCallId: `call-${t}-b`,
			name: "grep",
		});
		messages.push({ role: "assistant", content: `answer ${t} ${"a".repeat(100)}` });
	}
	return messages;
}

/** Every tool reply must still be preceded by the assistant turn that asked for it. */
function assertToolRepliesArePaired(messages: readonly Message[]): void {
	const announced = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const call of msg.toolCalls ?? []) announced.add(call.id);
			continue;
		}
		if (msg.role !== "tool") continue;
		expect(msg.toolCallId).toBeDefined();
		expect(announced.has(msg.toolCallId as string)).toBe(true);
	}
}

describe("token estimation", () => {
	test("estimateTokens is monotonic and never zero for non-empty text", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("a")).toBe(1);
		expect(estimateTokens("a".repeat(36))).toBe(10);
		expect(estimateTokens("a".repeat(360))).toBeGreaterThan(estimateTokens("a".repeat(36)));
	});

	test("messageTokens accounts for tool calls and reasoning, not just content", () => {
		const plain: Message = { role: "assistant", content: "hello" };
		const withCalls: Message = {
			role: "assistant",
			content: "hello",
			toolCalls: [{ id: "1", name: "read", arguments: '{"path":"a.ts"}' }],
		};
		const withReasoning: Message = { role: "assistant", content: "hello", reasoning: "think ".repeat(20) };
		expect(messageTokens(withCalls)).toBeGreaterThan(messageTokens(plain));
		expect(messageTokens(withReasoning)).toBeGreaterThan(messageTokens(plain));
	});
});

describe("compact", () => {
	test("does nothing when the history already fits", () => {
		const messages = transcript(1);
		const tokens = messages.map(messageTokens);
		const res = compact({ messages, tokens, window: 100_000, reservePct: 0.25 });
		expect(res.removed).toBe(0);
		expect(res.freed).toBe(0);
		expect(res.messages).toEqual(messages);
		expect(res.messages).not.toContain(undefined);
		expect(res.messages.some((m) => m.content.startsWith(MARKER_PREFIX))).toBe(false);
	});

	test("keeps the system message at index 0 and inserts exactly one marker after it", () => {
		const messages = transcript(6);
		const tokens = messages.map(messageTokens);
		const system = messages[0] as Message;

		const res = compact({ messages, tokens, window: 400, reservePct: 0.25 });

		expect(res.removed).toBeGreaterThan(0);
		expect(res.messages[0]).toBe(system);
		expect(res.messages[0]?.role).toBe("system");
		expect(res.messages[1]?.role).toBe("user");
		expect(res.messages[1]?.content.startsWith(MARKER_PREFIX)).toBe(true);
		const markers = res.messages.filter((m) => m.content.startsWith(MARKER_PREFIX));
		expect(markers).toHaveLength(1);
		// The marker states what it replaced.
		expect(res.messages[1]?.content).toContain(`${res.removed} messages`);
		expect(res.messages[1]?.content).toContain(`~${res.freed} tokens`);
	});

	test("never separates an assistant tool-call turn from its tool replies", () => {
		const messages = transcript(8);
		const tokens = messages.map(messageTokens);

		// Squeeze hard from generous to brutal; the invariant must hold at every size.
		for (const window of [4000, 2000, 1200, 800, 500, 300, 200, 120]) {
			const res = compact({ messages, tokens, window, reservePct: 0.25 });
			assertToolRepliesArePaired(res.messages);
			// A surviving tool reply is never the first body message either.
			expect(res.messages[1]?.role).not.toBe("tool");
		}
	});

	test("removed and freed describe exactly what was dropped", () => {
		const messages = transcript(6);
		const tokens = messages.map(messageTokens);

		const res = compact({ messages, tokens, window: 500, reservePct: 0.25 });

		// Survivors are the original tail, untouched and in order.
		const tail = res.messages.slice(2);
		expect(tail).toEqual(messages.slice(1 + res.removed));
		for (let i = 0; i < tail.length; i++) {
			expect(tail[i]).toBe(messages[1 + res.removed + i]);
		}
		// removed counts original messages only; the marker is not one of them.
		expect(res.messages).toHaveLength(messages.length - res.removed + 1);
		// freed is the token total of exactly those dropped messages.
		const droppedTokens = tokens
			.slice(1, 1 + res.removed)
			.reduce((a, b) => a + b, 0);
		expect(res.freed).toBe(droppedTokens);
		// tokens stay aligned with messages, and the marker's cost is real.
		expect(res.tokens).toHaveLength(res.messages.length);
		expect(res.tokens[1]).toBe(messageTokens(res.messages[1] as Message));
		// Dropping ends on a turn boundary: the first survivor starts a user turn.
		expect(res.messages[2]?.role).toBe("user");
	});

	test("an oversized final turn is returned intact with honest counters", () => {
		const messages: Message[] = [
			{ role: "system", content: "system" },
			{ role: "user", content: "x".repeat(20_000) },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"huge.ts"}' }],
			},
			{ role: "tool", content: "y".repeat(20_000), toolCallId: "c1", name: "read" },
		];
		const tokens = messages.map(messageTokens);

		const res = compact({ messages, tokens, window: 128, reservePct: 0.25 });

		expect(res.messages).toEqual(messages);
		expect(res.messages).toHaveLength(4);
		expect(res.removed).toBe(0);
		expect(res.freed).toBe(0);
		assertToolRepliesArePaired(res.messages);
	});

	test("keeps the newest turn even when every older turn must go", () => {
		const messages = transcript(5);
		const tokens = messages.map(messageTokens);

		const res = compact({ messages, tokens, window: 1, reservePct: 0.25 });

		// The last five messages are the newest complete turn.
		expect(res.messages.slice(2)).toEqual(messages.slice(-5));
		expect(res.removed).toBe(messages.length - 1 - 5);
		assertToolRepliesArePaired(res.messages);
	});

	test("works without a leading system message", () => {
		const messages = transcript(4).slice(1);
		const tokens = messages.map(messageTokens);

		const res = compact({ messages, tokens, window: 400, reservePct: 0.25 });

		expect(res.removed).toBeGreaterThan(0);
		expect(res.messages[0]?.content.startsWith(MARKER_PREFIX)).toBe(true);
		assertToolRepliesArePaired(res.messages);
	});

	test("is pure: the input arrays and messages are not mutated", () => {
		const messages = transcript(6);
		const tokens = messages.map(messageTokens);
		const messagesBefore = structuredClone(messages);
		const tokensBefore = tokens.slice();
		const lengthBefore = messages.length;

		const res = compact({ messages, tokens, window: 500, reservePct: 0.25 });

		expect(messages).toHaveLength(lengthBefore);
		expect(messages).toEqual(messagesBefore);
		expect(tokens).toEqual(tokensBefore);
		// The result is a fresh array, not an alias of the input.
		expect(res.messages).not.toBe(messages);
		expect(res.tokens).not.toBe(tokens);
	});

	test("a missing token entry is recomputed rather than treated as zero", () => {
		const messages = transcript(3);
		const res = compact({ messages, tokens: [], window: 100_000, reservePct: 0.25 });
		expect(res.tokens).toEqual(messages.map(messageTokens));
	});

	test("an absurd reservePct is clamped instead of emptying the history", () => {
		const messages = transcript(4);
		const tokens = messages.map(messageTokens);
		const res = compact({ messages, tokens, window: 4000, reservePct: 5 });
		expect(res.messages.length).toBeGreaterThan(1);
		expect(res.messages[0]?.role).toBe("system");
		assertToolRepliesArePaired(res.messages);
	});
});
