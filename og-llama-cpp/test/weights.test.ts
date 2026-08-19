/**
 * The only destructive path in this repository, so its refusals are pinned as
 * hard as its successes. Two properties matter: a filename that arrives from a
 * browser can never name a file outside the models directory, and a split model
 * is removed as a set — deleting one shard of three does not free a model, it
 * leaves 20 GiB that still looks installed and no longer loads.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { remove, shardsOf, targetsFor, WeightsError } from "../ui/server/weights.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "og-weights-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A file of `bytes` bytes, so a freed-space total is checkable. */
function touch(name: string, bytes: number): string {
	const full = path.join(dir, name);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, Buffer.alloc(bytes));
	return full;
}

describe("targetsFor", () => {
	test("a plain filename resolves inside the models directory", () => {
		expect(targetsFor(dir, "model-Q4_K_M.gguf")).toEqual([path.resolve(dir, "model-Q4_K_M.gguf")]);
	});

	test("anything that is not a bare filename is refused, never sanitised", () => {
		// Each of these would delete a file the operator did not name.
		for (const name of ["../secrets.gguf", "..\\secrets.gguf", "sub/model.gguf", "sub\\model.gguf", "/etc/model.gguf", "..", "."]) {
			expect(() => targetsFor(dir, name)).toThrow(WeightsError);
		}
	});

	test("a non-GGUF name is refused: this route removes weights and nothing else", () => {
		expect(() => targetsFor(dir, "config.json")).toThrow(/not a .gguf file/);
		expect(() => targetsFor(dir, "")).toThrow(/required/);
	});

	test("a shard names the whole set, in order", () => {
		const targets = targetsFor(dir, "big-00002-of-00003.gguf");
		expect(targets.map((full) => path.basename(full))).toEqual([
			"big-00001-of-00003.gguf",
			"big-00002-of-00003.gguf",
			"big-00003-of-00003.gguf",
		]);
	});

	test("the refused names carry a 400, so a route answers without guessing", () => {
		try {
			targetsFor(dir, "../escape.gguf");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(WeightsError);
			expect((error as WeightsError).status).toBe(400);
		}
	});
});

describe("shardsOf", () => {
	test("an ordinary model is a set of one, so a caller needs no special case", () => {
		expect(shardsOf("model-Q4_K_M.gguf")).toEqual(["model-Q4_K_M.gguf"]);
	});

	test("a split model names every file a confirmation prompt must list", () => {
		expect(shardsOf("big-00001-of-00002.gguf")).toEqual(["big-00001-of-00002.gguf", "big-00002-of-00002.gguf"]);
	});
});

describe("remove", () => {
	test("deletes the file and reports what it freed", () => {
		touch("model-Q4_K_M.gguf", 4096);
		const removal = remove(dir, "model-Q4_K_M.gguf");
		expect(removal.deleted).toEqual(["model-Q4_K_M.gguf"]);
		expect(removal.freedBytes).toBe(4096);
		expect(existsSync(path.join(dir, "model-Q4_K_M.gguf"))).toBe(false);
	});

	test("a split model goes as a set, whichever shard was named", () => {
		touch("big-00001-of-00003.gguf", 1024);
		touch("big-00002-of-00003.gguf", 2048);
		touch("big-00003-of-00003.gguf", 512);
		const removal = remove(dir, "big-00002-of-00003.gguf");
		expect(removal.deleted.length).toBe(3);
		expect(removal.freedBytes).toBe(3584);
		for (const shard of shardsOf("big-00001-of-00003.gguf")) {
			expect(existsSync(path.join(dir, shard))).toBe(false);
		}
	});

	test("a missing shard is not an error: the goal is that none of them remain", () => {
		touch("big-00001-of-00002.gguf", 1024);
		const removal = remove(dir, "big-00001-of-00002.gguf");
		expect(removal.deleted).toEqual(["big-00001-of-00002.gguf"]);
		expect(removal.freedBytes).toBe(1024);
	});

	test("a name that is not there is a 404, not a silent success", () => {
		try {
			remove(dir, "absent.gguf");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(WeightsError);
			expect((error as WeightsError).status).toBe(404);
		}
	});

	test("nothing outside the models directory is ever touched", () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "og-outside-"));
		try {
			const victim = path.join(outside, "victim.gguf");
			writeFileSync(victim, Buffer.alloc(16));
			const escape = path.join("..", path.basename(outside), "victim.gguf");
			expect(() => remove(dir, escape)).toThrow(WeightsError);
			expect(existsSync(victim)).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
