/**
 * Completion is spliced straight into the user's input buffer, so the tests
 * here defend the readline contract (every match is a full replacement for the
 * returned substring, and that substring is a suffix of the line) alongside the
 * ranking rules. Path cases run against a temp tree, never the repo.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bashCompletion, completeLine, powershellCompletion, type CompletionContext } from "../src/ui/completion.ts";

const FLAGS = [
	"-p",
	"--print",
	"--json",
	"-m",
	"--model",
	"-c",
	"--continue",
	"-r",
	"--resume",
	"--cwd",
	"--endpoint",
	"--no-autostart",
	"--max-steps",
	"-v",
	"--verbose",
	"--version",
	"-h",
	"--help",
] as const;

const created: string[] = [];

function tmpTree(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "og-completion-"));
	created.push(dir);
	fs.mkdirSync(path.join(dir, "src"));
	fs.mkdirSync(path.join(dir, "src", "nested"));
	fs.mkdirSync(path.join(dir, ".git"));
	fs.writeFileSync(path.join(dir, "src", "alpha.ts"), "");
	fs.writeFileSync(path.join(dir, "src", "beta.ts"), "");
	fs.writeFileSync(path.join(dir, "src", ".hidden.ts"), "");
	fs.writeFileSync(path.join(dir, "readme.md"), "");
	return dir;
}

/** Every line exercised anywhere in this file, for the suffix invariant sweep. */
const probed: string[] = [];

function ctxAt(cwd: string): CompletionContext {
	return {
		commands: ["help", "models", "model", "usage", "quit"],
		subcommands: { models: ["list", "switch", "info"], usage: ["reset"] },
		modelKeys: ["qwen3-coder", "gpt-oss-20b", "glm-4.6"],
		cwd,
	};
}

function complete(line: string, cwd = process.cwd()): [string[], string] {
	probed.push(line);
	return completeLine(line, ctxAt(cwd));
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("slash commands", () => {
	test("a bare slash offers every command, slash included", () => {
		const [matches, substring] = complete("/");
		expect(matches).toEqual(["/help", "/models", "/model", "/usage", "/quit"]);
		expect(substring).toBe("/");
	});

	test("a prefix filters and the match replaces the whole token", () => {
		const [matches, substring] = complete("/mod");
		expect(matches).toEqual(["/models", "/model"]);
		expect(substring).toBe("/mod");
	});

	test("an exact command name still completes itself", () => {
		expect(complete("/quit")[0]).toEqual(["/quit"]);
	});

	test("an unknown prefix offers nothing", () => {
		expect(complete("/zz")[0]).toEqual([]);
	});

	test("command matching is case-sensitive", () => {
		expect(complete("/Mod")[0]).toEqual([]);
	});
});

describe("subcommands", () => {
	test("a trailing space after the command lists its subcommands", () => {
		const [matches, substring] = complete("/models ");
		expect(matches).toEqual(["list", "switch", "info"]);
		expect(substring).toBe("");
	});

	test("a partial subcommand filters and replaces only the partial", () => {
		const [matches, substring] = complete("/models li");
		expect(matches).toEqual(["list"]);
		expect(substring).toBe("li");
	});

	test("a command without subcommands offers nothing for prose arguments", () => {
		expect(complete("/help topics")[0]).toEqual([]);
	});
});

describe("model keys", () => {
	test("/models switch completes profile keys", () => {
		const [matches, substring] = complete("/models switch ");
		expect(matches).toEqual(["qwen3-coder", "gpt-oss-20b", "glm-4.6"]);
		expect(substring).toBe("");
	});

	test("/models info narrows profile keys by prefix", () => {
		expect(complete("/models info g")[0]).toEqual(["gpt-oss-20b", "glm-4.6"]);
	});

	test("/model completes profile keys directly", () => {
		const [matches, substring] = complete("/model qwen");
		expect(matches).toEqual(["qwen3-coder"]);
		expect(substring).toBe("qwen");
	});

	test("an unrelated subcommand does not leak model keys", () => {
		expect(complete("/models list q")[0]).toEqual([]);
	});
});

describe("paths", () => {
	test("directories come first and carry a trailing slash", () => {
		const dir = tmpTree();
		const [matches, substring] = complete("./", dir);
		expect(substring).toBe("./");
		expect(matches).toEqual(["./src/", "./readme.md"]);
	});

	test("a nested partial completes inside the named directory", () => {
		const dir = tmpTree();
		const [matches, substring] = complete("read ./src/", dir);
		expect(substring).toBe("./src/");
		expect(matches).toEqual(["./src/nested/", "./src/alpha.ts", "./src/beta.ts"]);
	});

	test("hidden entries stay hidden until the segment starts with a dot", () => {
		const dir = tmpTree();
		expect(complete("./src/a", dir)[0]).toEqual(["./src/alpha.ts"]);
		expect(complete("./src/", dir)[0]).not.toContain("./src/.hidden.ts");
		expect(complete("./src/.", dir)[0]).toEqual(["./src/.hidden.ts"]);
		expect(complete(".g", dir)[0]).toEqual([]); // not path-like: no separator
		expect(complete("./.", dir)[0]).toEqual(["./.git/"]);
	});

	test("a bare relative token with a separator resolves against ctx.cwd", () => {
		const dir = tmpTree();
		const [matches, substring] = complete("src/al", dir);
		expect(substring).toBe("src/al");
		expect(matches).toEqual(["src/alpha.ts"]);
	});

	test("an absolute token completes against itself", () => {
		const dir = tmpTree();
		const token = `${dir.replace(/\\/g, "/")}/src/`;
		const [matches, substring] = complete(`open ${token}`, dir);
		expect(substring).toBe(token);
		expect(matches).toEqual([`${token}nested/`, `${token}alpha.ts`, `${token}beta.ts`]);
	});

	test("~/ expands to the home directory", () => {
		const home = os.homedir();
		const expected = fs
			.readdirSync(home, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith("."))
			.some((entry) => entry.isDirectory());
		const [matches, substring] = complete("~/");
		expect(substring).toBe("~/");
		expect(matches.length).toBeGreaterThan(0);
		for (const match of matches) expect(match.startsWith("~/")).toBe(true);
		if (expected) expect(matches[0]?.endsWith("/")).toBe(true);
	});

	test("a nonexistent directory yields no completions instead of throwing", () => {
		const dir = tmpTree();
		expect(complete("./does-not-exist/x", dir)).toEqual([[], "./does-not-exist/x"]);
		expect(complete("/n0/s1/u2/c3/h4/", dir)[0]).toEqual([]);
	});

	test("an unreadable target yields no completions", () => {
		const dir = tmpTree();
		// A regular file is not a directory: readdir fails, completion stays quiet.
		expect(complete("./readme.md/", dir)[0]).toEqual([]);
	});
});

describe("prose", () => {
	test("an ordinary sentence offers nothing", () => {
		const dir = tmpTree();
		expect(complete("fix the bug in", dir)[0]).toEqual([]);
		expect(complete("fix the bug in ", dir)[0]).toEqual([]);
		expect(complete("readme.md", dir)[0]).toEqual([]);
		expect(complete("", dir)[0]).toEqual([]);
	});
});

describe("readline contract", () => {
	test("the returned substring is always a suffix of the line", () => {
		const dir = tmpTree();
		const lines = [
			...probed,
			"/",
			"/m",
			"/models switch qwen",
			"./src/",
			"~/",
			"a b c",
			"   ",
			"/models  switch  g",
			"C:",
			"..",
			"~",
		];
		expect(lines.length).toBeGreaterThan(20);
		for (const line of lines) {
			const [matches, substring] = completeLine(line, ctxAt(dir));
			expect(line.endsWith(substring)).toBe(true);
			for (const match of matches) {
				expect(typeof match).toBe("string");
				expect(match.length).toBeGreaterThanOrEqual(substring.length);
			}
		}
	});

	test("splicing a match reproduces a coherent line", () => {
		const dir = tmpTree();
		const [matches, substring] = completeLine("read ./sr", ctxAt(dir));
		const line = "read ./sr";
		const spliced = line.slice(0, line.length - substring.length) + matches[0];
		expect(spliced).toBe("read ./src/");
	});
});

describe("shell scripts", () => {
	const scripts = [
		["powershell", powershellCompletion()],
		["bash", bashCompletion()],
	] as const;

	for (const [kind, script] of scripts) {
		test(`${kind} script names the binary, is ASCII, and covers every flag`, () => {
			expect(script.length).toBeGreaterThan(200);
			expect(script).toContain("og");
			expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(script)).toBe(true);
			for (const flag of FLAGS) expect(script).toContain(flag);
			for (const word of ["engine", "sessions", "models", "completion", "start", "stop", "status", "list", "show", "rm", "use", "powershell", "bash"]) {
				expect(script).toContain(word);
			}
		});

		test(`${kind} script honours a custom binary name`, () => {
			const custom = kind === "powershell" ? powershellCompletion("ogx") : bashCompletion("ogx");
			expect(custom).toContain("ogx");
		});
	}

	test("powershell registers a native completer and never invokes the binary", () => {
		const script = powershellCompletion();
		expect(script).toContain("Register-ArgumentCompleter -Native -CommandName 'og'");
		expect(script).toContain("System.Management.Automation.CompletionResult");
		expect(script).not.toMatch(/(^|\n)\s*(&|og\s+completion|Invoke-Expression)/);
	});

	test("bash defines a compgen-based function and registers it", () => {
		const script = bashCompletion();
		expect(script).toContain("COMPREPLY=(");
		expect(script).toContain('compgen -W "$candidates" -- "$cur"');
		expect(script).toMatch(/complete -F _og_complete og\b/);
	});
});

afterAll(() => {
	for (const dir of created.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
