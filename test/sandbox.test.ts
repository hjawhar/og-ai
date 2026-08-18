/**
 * The sandbox is the only thing standing between a confused model and the rest
 * of the machine, so these tests target escape routes rather than helpers:
 * relative traversal, absolute paths, reparse points, and the deny list.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	isDenied,
	isTextFile,
	relative,
	resolveInWorkspace,
	truncate,
} from "../src/tools/sandbox.ts";
import { SandboxError, type ToolContext } from "../src/tools/types.ts";

const DENY = ["**/.env", "**/.ssh/**"] as const;

const created: string[] = [];

function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.push(dir);
	return dir;
}

function ctxFor(root: string, denyPaths: readonly string[] = DENY): ToolContext {
	return {
		workspaceRoot: root,
		cwd: root,
		approve: () => Promise.resolve(true),
		log: () => {},
		signal: new AbortController().signal,
		denyPaths,
		timeoutMs: 5_000,
	};
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveInWorkspace confinement", () => {
	test("relative traversal out of the workspace is rejected", () => {
		const ws = tmpDir("og-sbx-");
		const ctx = ctxFor(ws);
		expect(() => resolveInWorkspace(ctx, "../../outside.txt")).toThrow(SandboxError);
		expect(() => resolveInWorkspace(ctx, "../outside.txt")).toThrow(/escapes the workspace/);
		// A traversal that lands back inside is fine.
		fs.mkdirSync(path.join(ws, "sub"));
		expect(resolveInWorkspace(ctx, "sub/../inside.txt")).toBe(path.join(ws, "inside.txt"));
	});

	test("an absolute path outside the workspace is rejected", () => {
		const ws = tmpDir("og-sbx-");
		const outside = tmpDir("og-out-");
		const victim = path.join(outside, "secret.txt");
		fs.writeFileSync(victim, "secret", "utf8");
		expect(() => resolveInWorkspace(ctxFor(ws), victim)).toThrow(SandboxError);
	});

	test("the workspace root itself resolves and a nested new file is allowed", () => {
		const ws = tmpDir("og-sbx-");
		const ctx = ctxFor(ws);
		expect(resolveInWorkspace(ctx, ".")).toBe(path.resolve(ws));
		// Must not require the file to exist: write/edit resolve before creating.
		expect(resolveInWorkspace(ctx, "a/b/new.txt")).toBe(path.join(ws, "a", "b", "new.txt"));
	});

	test("a directory link inside the workspace pointing outside is rejected", () => {
		const ws = tmpDir("og-sbx-");
		const outside = tmpDir("og-out-");
		fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
		const link = path.join(ws, "escape");

		try {
			fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
		} catch (err) {
			// Unprivileged accounts without Developer Mode cannot create links.
			console.log(`skipping link-escape case: ${(err as Error).message}`);
			return;
		}

		try {
			const ctx = ctxFor(ws);
			expect(fs.existsSync(path.join(link, "secret.txt"))).toBe(true);
			expect(() => resolveInWorkspace(ctx, "escape/secret.txt")).toThrow(SandboxError);
			expect(() => resolveInWorkspace(ctx, "escape")).toThrow(SandboxError);
		} finally {
			try {
				fs.unlinkSync(link);
			} catch {
				fs.rmdirSync(link);
			}
		}
	});
});

describe("deny list", () => {
	test("deny-listed paths throw and lookalike names do not", () => {
		const ws = tmpDir("og-sbx-");
		const ctx = ctxFor(ws);

		expect(() => resolveInWorkspace(ctx, ".env")).toThrow(SandboxError);
		expect(() => resolveInWorkspace(ctx, ".env")).toThrow(/deny-listed/);
		expect(() => resolveInWorkspace(ctx, "packages/app/.env")).toThrow(SandboxError);
		expect(() => resolveInWorkspace(ctx, "home/.ssh/id_rsa")).toThrow(SandboxError);
		expect(() => resolveInWorkspace(ctx, "home/.ssh/nested/deep.key")).toThrow(SandboxError);

		// Substring matching would be a false positive here; glob matching is not.
		expect(resolveInWorkspace(ctx, "config.environment.ts")).toBe(
			path.join(ws, "config.environment.ts"),
		);
		expect(resolveInWorkspace(ctx, "src/.environment/notes.md")).toBe(
			path.join(ws, "src", ".environment", "notes.md"),
		);
		expect(resolveInWorkspace(ctx, "ssh/config")).toBe(path.join(ws, "ssh", "config"));
	});

	test("isDenied matches on both absolute and workspace-relative forms", () => {
		const ws = tmpDir("og-sbx-");
		const abs = path.join(ws, "app", ".env");
		expect(isDenied(DENY, abs, ws)).toBe(true);
		expect(isDenied(DENY, abs)).toBe(true);
		expect(isDenied(DENY, path.join(ws, "app", "env.ts"), ws)).toBe(false);
		expect(isDenied([], abs, ws)).toBe(false);
		// A bare directory pattern denies everything beneath it.
		expect(isDenied(["secrets"], path.join(ws, "secrets", "k.txt"), ws)).toBe(true);
	});

	test("a deny-listed link target is caught through the link", () => {
		const ws = tmpDir("og-sbx-");
		const real = path.join(ws, "real.env");
		fs.writeFileSync(real, "K=v", "utf8");
		const link = path.join(ws, "alias.txt");
		try {
			fs.symlinkSync(real, link, "file");
		} catch (err) {
			console.log(`skipping link-to-denied case: ${(err as Error).message}`);
			return;
		}
		// `real.env` is not itself denied, so this only proves link resolution runs.
		const ctx = ctxFor(ws, ["**/real.env"]);
		expect(() => resolveInWorkspace(ctx, "alias.txt")).toThrow(SandboxError);
	});
});

describe("byte-level helpers", () => {
	test("truncate never splits a UTF-8 codepoint and reports byte counts", () => {
		const text = "é".repeat(10); // 20 bytes, 10 characters
		expect(Buffer.byteLength(text, "utf8")).toBe(20);

		// maxBytes lands mid-codepoint: back off to the previous boundary.
		const mid = truncate(text, 5);
		expect(mid).not.toContain("\uFFFD");
		expect(mid.startsWith("éé\n")).toBe(true);
		expect(mid).toContain("[truncated 16 of 20 bytes]");

		// maxBytes lands exactly on a boundary: keep everything up to it.
		const exact = truncate(text, 6);
		expect(exact).not.toContain("\uFFFD");
		expect(exact.startsWith("ééé\n")).toBe(true);
		expect(exact).toContain("[truncated 14 of 20 bytes]");

		// Every prefix length produces a clean decode.
		for (let n = 1; n <= 20; n++) {
			expect(truncate(text, n)).not.toContain("\uFFFD");
		}

		expect(truncate(text, 20)).toBe(text);
		expect(truncate(text, 999)).toBe(text);
		expect(truncate(text, 0)).toBe("");
	});

	test("relative always returns forward slashes", () => {
		const ws = tmpDir("og-sbx-");
		expect(relative(ws, path.join(ws, "a", "b", "c.txt"))).toBe("a/b/c.txt");
		expect(relative(ws, ws)).toBe(".");
		const rel = relative(ws, path.join(ws, "deep", "nest", "file.ts"));
		expect(rel).not.toContain("\\");
		// Outside the root it falls back to an absolute posix path, still slashed.
		expect(relative(ws, path.join(ws, "..", "elsewhere.txt"))).not.toContain("\\");
	});

	test("isTextFile treats a NUL-containing buffer as binary", () => {
		expect(isTextFile(new Uint8Array([0x68, 0x69, 0x00, 0x68]))).toBe(false);
		expect(isTextFile(new TextEncoder().encode("hello\n\tworld\r\n"))).toBe(true);
		expect(isTextFile(new Uint8Array(0))).toBe(true);
		// A NUL beyond the 8 KiB sample is not inspected; that is the documented heuristic.
		const late = new Uint8Array(9000).fill(0x61);
		late[8500] = 0;
		expect(isTextFile(late)).toBe(true);
	});
});
