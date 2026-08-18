/**
 * Model-facing tool behaviour. These are the strings and side effects the model
 * actually sees, so the assertions are on output shape and on the filesystem,
 * never on internals.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "../src/config/load.ts";
import type { OgConfig } from "../src/config/schema.ts";
import { createTools } from "../src/tools/registry.ts";
import { readFiles } from "../src/tools/state.ts";
import {
	SandboxError,
	ToolValidationError,
	type ApprovalRequest,
	type Tool,
	type ToolContext,
} from "../src/tools/types.ts";

const WIN = process.platform === "win32";

const created: string[] = [];

function tmpWs(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "og-tools-")));
	created.push(dir);
	return dir;
}

function config(patch: (cfg: OgConfig) => void = () => {}): OgConfig {
	const cfg = structuredClone(DEFAULT_CONFIG);
	patch(cfg);
	return cfg;
}

function toolNamed(cfg: OgConfig, name: string): Tool {
	const tool = createTools(cfg).find((t) => t.name === name);
	if (tool === undefined) throw new Error(`no such tool: ${name}`);
	return tool;
}

interface Spy {
	ctx: ToolContext;
	calls: ApprovalRequest[];
	/** Filesystem snapshot of `watch` taken at each approval call. */
	seen: Array<string | null>;
}

/**
 * A context whose `approve` records what the filesystem looked like when it was
 * asked. That is what proves approval precedes the side effect.
 */
function spyCtx(
	cfg: OgConfig,
	ws: string,
	opts: { answer?: boolean; watch?: string; cwd?: string } = {},
): Spy {
	const calls: ApprovalRequest[] = [];
	const seen: Array<string | null> = [];
	const watch = opts.watch;
	const ctx: ToolContext = {
		workspaceRoot: ws,
		cwd: opts.cwd ?? ws,
		approve: (req: ApprovalRequest) => {
			calls.push(req);
			seen.push(
				watch !== undefined && fs.existsSync(watch) ? fs.readFileSync(watch, "utf8") : null,
			);
			return Promise.resolve(opts.answer ?? true);
		},
		log: () => {},
		signal: new AbortController().signal,
		denyPaths: cfg.tools.denyPaths,
		timeoutMs: cfg.tools.bash.timeoutMs,
	};
	return { ctx, calls, seen };
}

beforeEach(() => {
	// Cross-tool session state is module-level by design; isolate every test.
	readFiles.clear();
});

afterEach(() => {
	for (const dir of created.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("read", () => {
	function tenLineWs(): string {
		const ws = tmpWs();
		fs.writeFileSync(
			path.join(ws, "ten.txt"),
			Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
			"utf8",
		);
		return ws;
	}

	test("returns NNN| prefixed lines and a trailing summary", async () => {
		const cfg = config();
		const ws = tenLineWs();
		const spy = spyCtx(cfg, ws);
		const read = toolNamed(cfg, "read");

		const res = await read.run(read.validate({ path: "ten.txt" }), spy.ctx);
		expect(res.ok).toBe(true);
		const out = res.content.split("\n");
		// Width is padded to the widest line number in the window.
		expect(out[0]).toBe(" 1|line1");
		expect(out[8]).toBe(" 9|line9");
		expect(out[9]).toBe("10|line10");
		expect(out.at(-1)).toBe("ten.txt: 10 lines (complete)");
		for (const line of out.slice(0, 10)) expect(line).toMatch(/^ *\d+\|/);
		expect(res.meta).toMatchObject({ path: "ten.txt", totalLines: 10, shownLines: 10 });
		// Read-only: never asks for approval.
		expect(spy.calls).toHaveLength(0);
	});

	test("offset and limit window the output honestly", async () => {
		const cfg = config();
		const ws = tenLineWs();
		const spy = spyCtx(cfg, ws);
		const read = toolNamed(cfg, "read");

		const res = await read.run(read.validate({ path: "ten.txt", offset: 3, limit: 2 }), spy.ctx);
		expect(res.ok).toBe(true);
		expect(res.content.split("\n")).toEqual([
			"3|line3",
			"4|line4",
			"ten.txt: showed lines 3-4 of 10",
		]);

		const past = await read.run(read.validate({ path: "ten.txt", offset: 99 }), spy.ctx);
		expect(past.ok).toBe(false);
		expect(past.content).toContain("offset 99 is past the end");
	});

	test("rejects binary files and missing files without throwing", async () => {
		const cfg = config();
		const ws = tmpWs();
		fs.writeFileSync(path.join(ws, "bin.dat"), Buffer.from([0x61, 0x00, 0x62, 0x63]));
		const spy = spyCtx(cfg, ws);
		const read = toolNamed(cfg, "read");

		const bin = await read.run(read.validate({ path: "bin.dat" }), spy.ctx);
		expect(bin.ok).toBe(false);
		expect(bin.content).toContain("looks binary");

		const missing = await read.run(read.validate({ path: "nope.txt" }), spy.ctx);
		expect(missing.ok).toBe(false);
		expect(missing.content).toContain("no such file");
	});

	test("a deny-listed path throws SandboxError instead of returning content", async () => {
		const cfg = config();
		const ws = tmpWs();
		fs.writeFileSync(path.join(ws, ".env"), "TOKEN=abc", "utf8");
		const spy = spyCtx(cfg, ws);
		const read = toolNamed(cfg, "read");

		await expect(read.run(read.validate({ path: ".env" }), spy.ctx)).rejects.toBeInstanceOf(
			SandboxError,
		);
	});
});

describe("write", () => {
	test("refuses to overwrite a file that has not been read this session", async () => {
		const cfg = config();
		const ws = tmpWs();
		const target = path.join(ws, "keep.txt");
		fs.writeFileSync(target, "original", "utf8");
		const spy = spyCtx(cfg, ws, { watch: target });
		const write = toolNamed(cfg, "write");

		const res = await write.run(write.validate({ path: "keep.txt", content: "clobber" }), spy.ctx);
		expect(res.ok).toBe(false);
		expect(res.content).toContain("write refused");
		expect(res.content).toContain("has not been read in this session");
		expect(fs.readFileSync(target, "utf8")).toBe("original");
		// Refusal happens before approval is even requested.
		expect(spy.calls).toHaveLength(0);
	});

	test("succeeds after the file has been read", async () => {
		const cfg = config();
		const ws = tmpWs();
		const target = path.join(ws, "keep.txt");
		fs.writeFileSync(target, "original", "utf8");
		const spy = spyCtx(cfg, ws, { watch: target });
		const read = toolNamed(cfg, "read");
		const write = toolNamed(cfg, "write");

		await read.run(read.validate({ path: "keep.txt" }), spy.ctx);
		const res = await write.run(write.validate({ path: "keep.txt", content: "clobber" }), spy.ctx);
		expect(res.ok).toBe(true);
		expect(res.content).toBe("wrote keep.txt: 7 bytes (overwrote)");
		expect(fs.readFileSync(target, "utf8")).toBe("clobber");
		// Approval was asked exactly once, and the file was still untouched then.
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.risk).toBe("write");
		expect(spy.seen[0]).toBe("original");
	});

	test("creates parent directories for a new file", async () => {
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const write = toolNamed(cfg, "write");

		const res = await write.run(
			write.validate({ path: "a/b/c/new.ts", content: "export const x = 1;\n" }),
			spy.ctx,
		);
		expect(res.ok).toBe(true);
		expect(res.content).toContain("(created)");
		expect(fs.readFileSync(path.join(ws, "a", "b", "c", "new.ts"), "utf8")).toBe(
			"export const x = 1;\n",
		);
		expect(spy.calls[0]?.summary).toContain("create a/b/c/new.ts");
	});

	test("a denied approval writes nothing at all", async () => {
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws, { answer: false });
		const write = toolNamed(cfg, "write");

		const res = await write.run(write.validate({ path: "new.txt", content: "nope" }), spy.ctx);
		expect(res.ok).toBe(false);
		expect(res.content).toBe("denied by user");
		expect(fs.existsSync(path.join(ws, "new.txt"))).toBe(false);
		expect(spy.calls).toHaveLength(1);
	});
});

describe("edit", () => {
	function wsWith(content: string): { ws: string; file: string } {
		const ws = tmpWs();
		const file = path.join(ws, "src.ts");
		fs.writeFileSync(file, content, "utf8");
		return { ws, file };
	}

	test("a successful edit returns a unified diff and applies it", async () => {
		const cfg = config();
		const { ws, file } = wsWith("const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const spy = spyCtx(cfg, ws, { watch: file });
		const edit = toolNamed(cfg, "edit");

		const res = await edit.run(
			edit.validate({ path: "src.ts", oldString: "const b = 2;", newString: "const b = 42;" }),
			spy.ctx,
		);
		expect(res.ok).toBe(true);
		expect(res.content).toContain("edited src.ts: 1 replacement");
		expect(res.content).toContain("@@");
		expect(res.content).toContain("-const b = 2;");
		expect(res.content).toContain("+const b = 42;");
		expect(fs.readFileSync(file, "utf8")).toBe("const a = 1;\nconst b = 42;\nconst c = 3;\n");
		// The diff was shown for approval while the file still held the old text.
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.detail).toContain("+const b = 42;");
		expect(spy.seen[0]).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
	});

	test("zero, ambiguous and missing-file failures carry distinct guidance", async () => {
		const cfg = config();
		const { ws, file } = wsWith("dup\ndup\nunique\n");
		const spy = spyCtx(cfg, ws);
		const edit = toolNamed(cfg, "edit");

		const zero = await edit.run(
			edit.validate({ path: "src.ts", oldString: "absent", newString: "x" }),
			spy.ctx,
		);
		expect(zero.ok).toBe(false);
		expect(zero.content).toContain("oldString not found in src.ts");
		expect(zero.content).toContain("Re-read the file");

		const ambiguous = await edit.run(
			edit.validate({ path: "src.ts", oldString: "dup", newString: "x" }),
			spy.ctx,
		);
		expect(ambiguous.ok).toBe(false);
		expect(ambiguous.content).toContain("matches 2 times in src.ts");
		expect(ambiguous.content).toContain("replaceAll: true");

		const missing = await edit.run(
			edit.validate({ path: "gone.ts", oldString: "a", newString: "b" }),
			spy.ctx,
		);
		expect(missing.ok).toBe(false);
		expect(missing.content).toContain("no such file: gone.ts");
		expect(missing.content).toContain("write tool");

		// All three messages are distinguishable to the model.
		expect(new Set([zero.content, ambiguous.content, missing.content]).size).toBe(3);
		// Nothing was approved and nothing changed.
		expect(spy.calls).toHaveLength(0);
		expect(fs.readFileSync(file, "utf8")).toBe("dup\ndup\nunique\n");
	});

	test("replaceAll changes every occurrence", async () => {
		const cfg = config();
		const { ws, file } = wsWith("dup\ndup\nunique\n");
		const spy = spyCtx(cfg, ws);
		const edit = toolNamed(cfg, "edit");

		const res = await edit.run(
			edit.validate({ path: "src.ts", oldString: "dup", newString: "one", replaceAll: true }),
			spy.ctx,
		);
		expect(res.ok).toBe(true);
		expect(res.content).toContain("2 replacements");
		expect(fs.readFileSync(file, "utf8")).toBe("one\none\nunique\n");
	});

	test("identical oldString and newString is a validation error", () => {
		const cfg = config();
		const edit = toolNamed(cfg, "edit");
		expect(() => edit.validate({ path: "src.ts", oldString: "same", newString: "same" })).toThrow(
			ToolValidationError,
		);
	});

	test("a denied approval leaves the file untouched", async () => {
		const cfg = config();
		const { ws, file } = wsWith("const a = 1;\n");
		const spy = spyCtx(cfg, ws, { answer: false, watch: file });
		const edit = toolNamed(cfg, "edit");

		const res = await edit.run(
			edit.validate({ path: "src.ts", oldString: "1", newString: "2" }),
			spy.ctx,
		);
		expect(res.ok).toBe(false);
		expect(res.content).toBe("denied by user");
		expect(fs.readFileSync(file, "utf8")).toBe("const a = 1;\n");
	});
});

describe("glob and grep", () => {
	function searchWs(): string {
		const ws = tmpWs();
		fs.mkdirSync(path.join(ws, "src", "deep"), { recursive: true });
		fs.mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
		fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
		fs.writeFileSync(path.join(ws, "src", "a.ts"), "const needle = 1;\n", "utf8");
		fs.writeFileSync(
			path.join(ws, "src", "deep", "b.ts"),
			"needle\nneedle\nneedle\nother\n",
			"utf8",
		);
		fs.writeFileSync(path.join(ws, "node_modules", "pkg", "c.ts"), "needle\n", "utf8");
		fs.writeFileSync(path.join(ws, ".git", "d.ts"), "needle\n", "utf8");
		return ws;
	}

	test("glob returns workspace-relative forward-slash paths and skips node_modules/.git", async () => {
		const cfg = config();
		const ws = searchWs();
		const spy = spyCtx(cfg, ws);
		const glob = toolNamed(cfg, "glob");

		const res = await glob.run(glob.validate({ pattern: "**/*.ts" }), spy.ctx);
		expect(res.ok).toBe(true);
		const hits = res.content.split("\n").slice(0, -1);
		expect(hits.sort()).toEqual(["src/a.ts", "src/deep/b.ts"]);
		for (const hit of hits) expect(hit).not.toContain("\\");
		expect(res.content).not.toContain("node_modules");
		expect(res.content).not.toContain(".git/");
		expect(res.content.split("\n").at(-1)).toContain("2 of 2 matches under .");
		expect(spy.calls).toHaveLength(0);
	});

	test("glob reports a no-match honestly", async () => {
		const cfg = config();
		const ws = searchWs();
		const spy = spyCtx(cfg, ws);
		const glob = toolNamed(cfg, "glob");

		const res = await glob.run(glob.validate({ pattern: "**/*.rs" }), spy.ctx);
		expect(res.ok).toBe(true);
		expect(res.content).toContain("no files match **/*.rs");
	});

	test("grep reports relative path:line: text and skips node_modules/.git", async () => {
		const cfg = config();
		const ws = searchWs();
		const spy = spyCtx(cfg, ws);
		const grep = toolNamed(cfg, "grep");

		const res = await grep.run(grep.validate({ pattern: "needle" }), spy.ctx);
		expect(res.ok).toBe(true);
		const hits = res.content.split("\n").slice(0, -1);
		expect(hits).toContain("src/a.ts:1: const needle = 1;");
		expect(hits).toContain("src/deep/b.ts:2: needle");
		expect(hits).toHaveLength(4);
		for (const hit of hits) {
			expect(hit).not.toContain("\\");
			expect(hit).not.toContain("node_modules");
			expect(hit).not.toContain(".git");
		}
		expect(res.content.split("\n").at(-1)).toContain(
			"4 matches in 2 of 2 files scanned under .",
		);
		expect(spy.calls).toHaveLength(0);
	});

	test("grep honours its limit and says so", async () => {
		const cfg = config();
		const ws = searchWs();
		const spy = spyCtx(cfg, ws);
		const grep = toolNamed(cfg, "grep");

		const res = await grep.run(grep.validate({ pattern: "needle", limit: 2 }), spy.ctx);
		expect(res.ok).toBe(true);
		const out = res.content.split("\n");
		expect(out).toHaveLength(3);
		expect(out.at(-1)).toContain("stopped at limit 2");
	});

	test("an invalid regex is a validation error, not a crash mid-scan", () => {
		const cfg = config();
		const grep = toolNamed(cfg, "grep");
		expect(() => grep.validate({ pattern: "([unclosed" })).toThrow(ToolValidationError);
		expect(() => grep.validate({ pattern: "([unclosed" })).toThrow(
			/not a valid regular expression/,
		);
	});
});

describe("bash", () => {
	const echoOk = WIN ? "Write-Output hello" : "echo hello";
	const sleeper = WIN ? "Start-Sleep -Seconds 30" : "sleep 30";
	const markerCmd = WIN ? "Set-Content -Path marker.txt -Value x" : "printf x > marker.txt";
	const ranCmd = WIN ? "Set-Content -Path ran.txt -Value x" : "printf x > ran.txt";

	test("a benign command succeeds and reports its exit code", async () => {
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const bash = toolNamed(cfg, "bash");

		const res = await bash.run(bash.validate({ command: echoOk }), spy.ctx);
		expect(res.ok).toBe(true);
		expect(res.content).toContain("hello");
		expect(res.content).toContain("exit code: 0");
		expect(res.meta).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.risk).toBe("exec");
	});

	test("a non-zero exit is reported as failure with the real code", async () => {
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const bash = toolNamed(cfg, "bash");

		const res = await bash.run(bash.validate({ command: "exit 3" }), spy.ctx);
		expect(res.ok).toBe(false);
		expect(res.content).toContain("exit code: 3");
		expect(res.meta).toMatchObject({ exitCode: 3 });
	});

	test("a deny-pattern command is blocked without spawning or asking", async () => {
		const cfg = config((c) => {
			c.tools.bash.denyPatterns = ["marker\\.txt"];
		});
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const bash = toolNamed(cfg, "bash");

		const res = await bash.run(bash.validate({ command: markerCmd }), spy.ctx);
		expect(res.ok).toBe(false);
		expect(res.content).toContain("bash blocked");
		expect(res.content).toContain("deny pattern");
		expect(res.meta).toMatchObject({ blockedBy: "marker\\.txt" });
		// Never spawned: the command's only side effect did not happen.
		expect(fs.existsSync(path.join(ws, "marker.txt"))).toBe(false);
		// Never asked: a blocked command is not an approval question.
		expect(spy.calls).toHaveLength(0);
	});

	test("timeoutMs kills the command and reports the timeout", async () => {
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const bash = toolNamed(cfg, "bash");

		const started = Date.now();
		const res = await bash.run(bash.validate({ command: sleeper, timeoutMs: 700 }), spy.ctx);
		const wall = Date.now() - started;
		expect(res.ok).toBe(false);
		expect(res.content).toContain("timed out after 700ms and was killed");
		expect(res.meta).toMatchObject({ timedOut: true });
		// A 30s sleeper must not have been waited out.
		expect(wall).toBeLessThan(15_000);
	}, 20_000);

	// A grandchild is the interesting case: `sh -c` does not make a process
	// group, so killing only the shell leaves the sleeper running *and* holding
	// the stdout pipe open, which used to hang the tool forever.
	test("timeoutMs kills grandchildren, not just the shell", async () => {
		if (WIN) return;
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const bash = toolNamed(cfg, "bash");
		// A sleep duration nothing else on this machine is waiting out, so pgrep
		// can only match the grandchild this test started.
		const marker = `sleep 31${String(process.pid).slice(-3)}`;
		const nested = `sh -c '${marker}' & wait`;

		const res = await bash.run(bash.validate({ command: nested, timeoutMs: 700 }), spy.ctx);
		expect(res.meta).toMatchObject({ timedOut: true });

		const survivors = Bun.spawnSync(["pgrep", "-f", marker]);
		expect(new TextDecoder().decode(survivors.stdout).trim()).toBe("");
	}, 20_000);

	test("disabled bash refuses clearly and runs nothing", async () => {
		const cfg = config((c) => {
			c.tools.bash.enabled = false;
		});
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const bash = toolNamed(cfg, "bash");

		const res = await bash.run(bash.validate({ command: ranCmd }), spy.ctx);
		expect(res.ok).toBe(false);
		expect(res.content).toContain("bash is disabled");
		expect(res.content).toContain("tools.bash.enabled = false");
		expect(fs.existsSync(path.join(ws, "ran.txt"))).toBe(false);
		expect(spy.calls).toHaveLength(0);
	});

	test("a cwd outside the workspace throws SandboxError", async () => {
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws);
		const bash = toolNamed(cfg, "bash");

		await expect(
			bash.run(bash.validate({ command: echoOk, cwd: "../.." }), spy.ctx),
		).rejects.toBeInstanceOf(SandboxError);
		expect(spy.calls).toHaveLength(0);
	});

	test("a denied approval never spawns the command", async () => {
		const cfg = config();
		const ws = tmpWs();
		const spy = spyCtx(cfg, ws, { answer: false });
		const bash = toolNamed(cfg, "bash");

		const res = await bash.run(bash.validate({ command: ranCmd }), spy.ctx);
		expect(res.ok).toBe(false);
		expect(res.content).toBe("denied by user");
		expect(fs.existsSync(path.join(ws, "ran.txt"))).toBe(false);
		expect(spy.calls).toHaveLength(1);
	});
});

describe("approval gating across the suite", () => {
	test("read-only tools declare themselves and never ask for approval", async () => {
		const cfg = config();
		const ws = tmpWs();
		fs.writeFileSync(path.join(ws, "a.txt"), "hello\n", "utf8");
		const spy = spyCtx(cfg, ws);

		const readOnly = createTools(cfg).filter((t) => t.readOnly).map((t) => t.name);
		expect(readOnly.sort()).toEqual(["glob", "grep", "ls", "read"]);
		const mutating = createTools(cfg).filter((t) => !t.readOnly).map((t) => t.name);
		expect(mutating.sort()).toEqual(["bash", "edit", "write"]);

		const read = toolNamed(cfg, "read");
		const ls = toolNamed(cfg, "ls");
		const glob = toolNamed(cfg, "glob");
		const grep = toolNamed(cfg, "grep");
		await read.run(read.validate({ path: "a.txt" }), spy.ctx);
		await ls.run(ls.validate({ path: "." }), spy.ctx);
		await glob.run(glob.validate({ pattern: "*.txt" }), spy.ctx);
		await grep.run(grep.validate({ pattern: "hello" }), spy.ctx);
		expect(spy.calls).toHaveLength(0);
	});

	test("every mutating tool asks before it touches anything", async () => {
		const cfg = config();
		const ws = tmpWs();
		const target = path.join(ws, "target.txt");
		fs.writeFileSync(target, "before\n", "utf8");

		// write: approval is asked while the old bytes are still on disk.
		const wSpy = spyCtx(cfg, ws, { watch: target });
		const read = toolNamed(cfg, "read");
		await read.run(read.validate({ path: "target.txt" }), wSpy.ctx);
		const write = toolNamed(cfg, "write");
		await write.run(write.validate({ path: "target.txt", content: "after\n" }), wSpy.ctx);
		expect(wSpy.seen).toEqual(["before\n"]);
		expect(fs.readFileSync(target, "utf8")).toBe("after\n");

		// edit: same guarantee.
		const eSpy = spyCtx(cfg, ws, { watch: target });
		const edit = toolNamed(cfg, "edit");
		await edit.run(
			edit.validate({ path: "target.txt", oldString: "after", newString: "edited" }),
			eSpy.ctx,
		);
		expect(eSpy.seen).toEqual(["after\n"]);
		expect(fs.readFileSync(target, "utf8")).toBe("edited\n");

		// bash: the process cannot have run before the question was answered.
		const marker = path.join(ws, "spawned.txt");
		const bSpy = spyCtx(cfg, ws, { watch: marker });
		const bash = toolNamed(cfg, "bash");
		await bash.run(
			bash.validate({
				command: WIN ? "Set-Content -Path spawned.txt -Value x" : "printf x > spawned.txt",
			}),
			bSpy.ctx,
		);
		expect(bSpy.seen).toEqual([null]);
		expect(fs.existsSync(marker)).toBe(true);
	}, 20_000);
});
