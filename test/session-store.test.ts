/**
 * Session persistence must be lossless: the agent loop replays exactly what the
 * store hands back, so a dropped `toolCalls` blob or a resequenced history is
 * indistinguishable from the model changing its mind. These tests pin the
 * round-trip shape, seq assignment, ordering and cascade behaviour.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Message } from "../src/provider/types.ts";
import { openSessionStore } from "../src/session/store.ts";
import type { SessionStore } from "../src/session/types.ts";

const dirs: string[] = [];
const stores: SessionStore[] = [];

afterEach(() => {
	for (const store of stores) {
		try {
			store.close();
		} catch {
			// Already closed by the test that exercised reopen semantics.
		}
	}
	stores.length = 0;
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	dirs.length = 0;
});

function freshDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "og-store-"));
	dirs.push(dir);
	return dir;
}

function open(stateDir: string): SessionStore {
	const store = openSessionStore(stateDir);
	stores.push(store);
	return store;
}

/** Busy-waits until `Date.now()` strictly advances, so updated_at ordering is deterministic. */
function advanceClock(): void {
	const start = Date.now();
	while (Date.now() === start) {
		// Spin: clock granularity is coarser than session creation.
	}
}

const ASSISTANT_WITH_TOOLS: Message = {
	role: "assistant",
	content: "Reading the file first.",
	reasoning: "The user asked about src/a.ts, so read it before editing.",
	toolCalls: [
		{ id: "call_0", name: "read", arguments: '{"path":"src/a.ts"}' },
		{ id: "call_1", name: "grep", arguments: '{"pattern":"export function","path":"src"}' },
	],
};

describe("message round-trip", () => {
	test("preserves toolCalls, toolCallId, name and reasoning verbatim", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "C:\\work\\repo", model: "qwen3-coder-30b" });

		store.append(session.id, ASSISTANT_WITH_TOOLS, 42);
		store.append(
			session.id,
			{ role: "tool", content: "export function a() {}", toolCallId: "call_0", name: "read" },
			17,
		);

		const [assistant, tool] = store.messages(session.id);
		if (!assistant) throw new Error("assistant message was not persisted");
		expect(assistant.createdAt).toBeGreaterThan(0);
		// Timestamp neutralised so toEqual still proves the exact key set.
		expect({ ...assistant, createdAt: 0 }).toEqual({
			...ASSISTANT_WITH_TOOLS,
			seq: 0,
			tokens: 42,
			createdAt: 0,
		});
		expect(tool?.toolCallId).toBe("call_0");
		expect(tool?.name).toBe("read");
		expect(tool?.tokens).toBe(17);
	});

	test("absent optionals stay absent rather than becoming undefined keys", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m" });
		const stored = store.append(session.id, { role: "user", content: "hi" }, 3);

		const expectedKeys = ["content", "createdAt", "role", "seq", "tokens"];
		expect(Object.keys(stored).sort()).toEqual(expectedKeys);
		const [roundTripped] = store.messages(session.id);
		expect(Object.keys(roundTripped ?? {}).sort()).toEqual(expectedKeys);
		expect("toolCalls" in (roundTripped ?? {})).toBe(false);
		expect("reasoning" in (roundTripped ?? {})).toBe(false);
	});

	test("an empty toolCalls array is preserved, not collapsed to absent", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m" });
		store.append(session.id, { role: "assistant", content: "done", toolCalls: [] }, 1);
		expect(store.messages(session.id)[0]?.toolCalls).toEqual([]);
	});

	test("content with newlines, quotes and unicode survives", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m" });
		const content = 'line1\n\tline2 "quoted" \\ back — ✓ 日本語\r\nend';
		store.append(session.id, { role: "user", content }, 9);
		expect(store.messages(session.id)[0]?.content).toBe(content);
	});
});

describe("sequencing", () => {
	test("seq is monotonic from zero across appends", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m" });
		const seqs = [0, 1, 2, 3].map((n) => store.append(session.id, { role: "user", content: `m${n}` }, 1).seq);
		expect(seqs).toEqual([0, 1, 2, 3]);
		expect(store.messages(session.id).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
	});

	test("replaceMessages resequences from 0 and later appends continue after it", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m" });
		for (const n of [0, 1, 2, 3, 4]) store.append(session.id, { role: "user", content: `m${n}` }, 1);

		store.replaceMessages(session.id, [
			{ msg: { role: "system", content: "summary of 5 turns" }, tokens: 30 },
			{ msg: { role: "user", content: "m4" }, tokens: 1 },
		]);

		expect(store.messages(session.id).map((m) => [m.seq, m.content])).toEqual([
			[0, "summary of 5 turns"],
			[1, "m4"],
		]);

		const appended = store.append(session.id, { role: "assistant", content: "next" }, 2);
		expect(appended.seq).toBe(2);
		expect(store.messages(session.id).map((m) => m.seq)).toEqual([0, 1, 2]);
	});

	test("replaceMessages with an empty history resets sequencing to 0", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m" });
		store.append(session.id, { role: "user", content: "a" }, 1);
		store.replaceMessages(session.id, []);
		expect(store.messages(session.id)).toEqual([]);
		expect(store.append(session.id, { role: "user", content: "b" }, 1).seq).toBe(0);
	});

	test("unknown session id is rejected on append and replaceMessages", () => {
		const store = open(freshDir());
		expect(() => store.append("no-such-session", { role: "user", content: "x" }, 1)).toThrow(
			/Unknown session/,
		);
		expect(() => store.replaceMessages("no-such-session", [])).toThrow(/Unknown session/);
	});
});

describe("session listing", () => {
	test("latest and list are newest-first and scoped by cwd", () => {
		const store = open(freshDir());
		const projectA = "C:\\work\\a";
		const projectB = "C:\\work\\b";

		const first = store.create({ cwd: projectA, model: "m" });
		advanceClock();
		const other = store.create({ cwd: projectB, model: "m" });
		advanceClock();
		const second = store.create({ cwd: projectA, model: "m" });

		expect(store.latest(projectA)?.id).toBe(second.id);
		expect(store.latest(projectB)?.id).toBe(other.id);
		expect(store.latest("C:\\work\\never-used")).toBeUndefined();

		expect(store.list({ cwd: projectA }).map((s) => s.id)).toEqual([second.id, first.id]);
		expect(store.list({ cwd: projectA, limit: 1 }).map((s) => s.id)).toEqual([second.id]);
		expect(store.list().map((s) => s.id)).toEqual([second.id, other.id, first.id]);
	});

	test("appending to an older session makes it the latest again", () => {
		const store = open(freshDir());
		const cwd = "/w";
		const older = store.create({ cwd, model: "m" });
		advanceClock();
		store.create({ cwd, model: "m" });
		advanceClock();
		store.append(older.id, { role: "user", content: "still working" }, 1);

		expect(store.latest(cwd)?.id).toBe(older.id);
	});
});

describe("session mutation", () => {
	test("addUsage accumulates and setTitle replaces the title", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m", title: "initial" });
		expect(session.title).toBe("initial");
		expect(session.promptTokens).toBe(0);

		store.addUsage(session.id, 1200, 340);
		store.addUsage(session.id, 800, 60);
		const withUsage = store.get(session.id);
		expect(withUsage?.promptTokens).toBe(2000);
		expect(withUsage?.completionTokens).toBe(400);

		store.setTitle(session.id, "fix fizzbuzz off-by-one");
		expect(store.get(session.id)?.title).toBe("fix fizzbuzz off-by-one");
		expect(store.get(session.id)?.createdAt).toBe(session.createdAt);
	});

	test("create defaults the title to an empty string", () => {
		const store = open(freshDir());
		const session = store.create({ cwd: "/w", model: "m" });
		expect(session.title).toBe("");
		expect(store.get(session.id)?.title).toBe("");
	});

	test("delete removes the session and cascades its messages", () => {
		const dir = freshDir();
		const store = open(dir);
		const doomed = store.create({ cwd: "/w", model: "m" });
		const keeper = store.create({ cwd: "/w", model: "m" });
		for (const n of [0, 1, 2]) {
			store.append(doomed.id, { role: "user", content: `d${n}` }, 1);
			store.append(keeper.id, { role: "user", content: `k${n}` }, 1);
		}

		store.delete(doomed.id);
		expect(store.get(doomed.id)).toBeUndefined();
		expect(store.messages(doomed.id)).toEqual([]);
		expect(store.messages(keeper.id)).toHaveLength(3);
		store.close();

		// Orphan rows would be invisible through the store API but corrupt the file.
		const db = new Database(path.join(dir, "sessions.db"), { readonly: true });
		try {
			const row = db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
			expect(row.n).toBe(3);
		} finally {
			db.close();
		}
	});
});

describe("durability", () => {
	test("close then reopen preserves sessions, usage and full message history", () => {
		const dir = freshDir();
		const store = open(dir);
		const session = store.create({ cwd: "C:\\work\\repo", model: "qwen3-coder-30b", title: "t" });
		store.append(session.id, ASSISTANT_WITH_TOOLS, 42);
		store.append(
			session.id,
			{ role: "tool", content: "ok", toolCallId: "call_0", name: "read" },
			5,
		);
		store.addUsage(session.id, 900, 120);
		const before = store.messages(session.id);
		store.close();

		const reopened = open(dir);
		expect(reopened.get(session.id)).toEqual({
			...session,
			promptTokens: 900,
			completionTokens: 120,
			updatedAt: reopened.get(session.id)?.updatedAt ?? 0,
		});
		expect(reopened.messages(session.id)).toEqual(before);
	});

	test("openSessionStore creates a missing state directory", () => {
		const nested = path.join(freshDir(), "deep", "state");
		const store = open(nested);
		expect(fs.existsSync(path.join(nested, "sessions.db"))).toBe(true);
		expect(store.list()).toEqual([]);
	});
});
