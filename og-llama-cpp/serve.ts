#!/usr/bin/env bun
/**
 * Runs the installed llama-server in the foreground, one measured serving
 * profile per key.
 *
 * This file is the only place a llama-server argv is built. Clients are plain
 * OpenAI-compatible HTTP consumers: they point at http://host:port and neither
 * spawn nor supervise anything. So the offload knobs that decide whether a model
 * fits in 16 GiB live here, beside the installers that produce the binary and the
 * sweep that measured them (docs/benchmarks.md §4), not in any client's config.
 *
 * Flag names were verified against llama.cpp build b10488 (`llama-server --help`);
 * a build bump means re-checking them — see docs/upgrading.md.
 *
 * Operator tooling: self-contained by design, so it imports nothing but node:*
 * and Bun builtins and can be copied to another box on its own.
 *
 *   bun run serve.ts
 *   bun run serve.ts --profile qwen3-coder-30b-long
 *   bun run serve.ts --list
 *   bun run serve.ts --dry-run -- --verbose
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
const HOME = os.homedir();
const INSTALLER = WIN ? ".\\install-engine.ps1" : "./install-engine.sh";

/**
 * Server-side sampling defaults. A client that sends `temperature`/`top_p` in its
 * request body overrides these per request; they only decide what a bare
 * `/v1/chat/completions` with no sampling fields gets.
 */
interface Sampling {
	temp: number;
	topP: number;
	topK?: number;
	minP?: number;
	repeatPenalty?: number;
}

interface Profile {
	file: string;
	ctx: number;
	ngl: number;
	/** CPU-resident MoE layers; absent keeps every expert on the GPU (dense models). */
	ncmoe?: number;
	sampling: Sampling;
}

interface Options {
	profile: string;
	root: string;
	modelsDir: string;
	/** Weights override; absolute, or relative to the models dir. */
	model?: string;
	ctx?: number;
	ngl?: number;
	ncmoe?: number;
	threads: number;
	host: string;
	port: number;
	alias?: string;
	dryRun: boolean;
	/** Everything after `--`, appended to the argv verbatim. */
	extra: string[];
}

const Q4 = "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf";
const Q3 = "Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf";

/** Qwen3-Coder's published sampling recipe. */
const QWEN: Sampling = { temp: 0.7, topP: 0.8, topK: 20, minP: 0, repeatPenalty: 1.05 };

/**
 * The chosen rows of docs/benchmarks.md §4 — every ctx/ngl/n-cpu-moe triple here
 * was measured on the reference 16303 MiB card and keeps >= 1.2 GiB of VRAM free,
 * which is what stops the driver paging weights to host RAM at 8x the cost.
 * Changing a number here without a re-run of tools/profile-sweep.ts makes the
 * measurement record a lie.
 */
const PROFILES: Record<string, Profile> = {
	"qwen3-coder-30b": { file: Q4, ctx: 32768, ngl: 99, ncmoe: 14, sampling: QWEN },
	"qwen3-coder-30b-long": { file: Q4, ctx: 65536, ngl: 99, ncmoe: 18, sampling: QWEN },
	"qwen3-coder-30b-fast": { file: Q3, ctx: 32768, ngl: 99, ncmoe: 4, sampling: QWEN },
	"devstral-24b": { file: "Devstral-Small-2507-Q4_K_M.gguf", ctx: 8192, ngl: 99, sampling: { temp: 0.15, topP: 0.95 } },
};

const DEFAULT_PROFILE = "qwen3-coder-30b";

const DEFAULTS: Options = {
	profile: DEFAULT_PROFILE,
	// Both installers publish the running build as <root>/current.
	root: process.env["OG_LLAMA_ROOT"] ?? path.join(HOME, ".local", "llama.cpp"),
	modelsDir: process.env["OG_MODELS_DIR"] ?? path.join(HOME, "models"),
	// Half the logical cores: the other half serve the expert layers the offload
	// split leaves on the CPU, and oversubscribing them costs generation tok/s.
	threads: Math.max(4, Math.floor(os.cpus().length / 2)),
	host: "127.0.0.1",
	port: 8127,
	dryRun: false,
	extra: [],
};

const USAGE = `Usage: bun run serve.ts [options] [-- extra llama-server args]

Runs llama-server in the foreground with one of the serving profiles measured in
docs/benchmarks.md. Any OpenAI-compatible client — the sibling og-cli included —
just points at http://host:port; nothing here supervises a client and no client
supervises this.

Options:
  --profile <key>       serving profile (default: ${DEFAULT_PROFILE})
  --list                print the profile table and exit
  --model <path>        weights override, absolute or relative to the models dir
  --models-dir <path>   GGUF weights (default: ${DEFAULTS.modelsDir}, env OG_MODELS_DIR)
  --root <path>         llama.cpp install root (default: ${DEFAULTS.root}, env OG_LLAMA_ROOT)
  --ctx <n>             context size override
  --ngl <n>             GPU layers override
  --n-cpu-moe <n>       CPU-resident expert layers override (0 keeps every expert on the GPU)
  --threads <n>         CPU threads (default on this box: ${DEFAULTS.threads})
  --host <h>            bind address (default: ${DEFAULTS.host})
  --port <n>            port (default: ${DEFAULTS.port})
  --alias <s>           model name the server reports (default: the profile key)
  --dry-run             print the exact command line and exit, launching nothing
  --help                print this message and exit

Runs in the foreground with inherited stdio, so llama.cpp's own log is your log,
and exits with the server's exit code. Ctrl-C kills the whole pid tree: a leaked
llama-server holds 15 GiB of VRAM until it is found.

Requires a built engine; run ${INSTALLER} first.`;

class UsageError extends Error {}

function positiveInt(flag: string, raw: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new UsageError(`${flag} expects a positive integer, got '${raw}'`);
	return value;
}

function parseArgs(argv: readonly string[]): Options | "help" | "list" {
	const options: Options = { ...DEFAULTS, extra: [] };
	let index = 0;

	while (index < argv.length) {
		const arg = argv[index++] ?? "";
		if (arg === "--") {
			// Verbatim tail: an operator experimenting with a flag this tool does
			// not model must not have to edit this file.
			options.extra = [...argv.slice(index)];
			break;
		}
		// Accept both `--flag value` and `--flag=value`.
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		const valueFor = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[index];
			if (next === undefined) throw new UsageError(`${flag} expects a value`);
			index++;
			return next;
		};

		switch (flag) {
			case "--help":
			case "-h":
				return "help";
			case "--list":
				return "list";
			case "--profile":
				options.profile = valueFor();
				break;
			case "--model":
				options.model = valueFor();
				break;
			case "--models-dir":
				options.modelsDir = valueFor();
				break;
			case "--root":
				options.root = valueFor();
				break;
			case "--ctx":
				options.ctx = positiveInt(flag, valueFor());
				break;
			case "--ngl":
				options.ngl = positiveInt(flag, valueFor());
				break;
			case "--n-cpu-moe": {
				// 0 is meaningful here — it is "every expert resident" — so this one
				// flag accepts zero where the other counts do not.
				const raw = valueFor();
				const value = Number(raw);
				if (!Number.isInteger(value) || value < 0) {
					throw new UsageError(`${flag} expects a non-negative integer, got '${raw}'`);
				}
				options.ncmoe = value;
				break;
			}
			case "--threads":
				options.threads = positiveInt(flag, valueFor());
				break;
			case "--host":
				options.host = valueFor();
				break;
			case "--port":
				options.port = positiveInt(flag, valueFor());
				break;
			case "--alias":
				options.alias = valueFor();
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			default:
				throw new UsageError(`unknown option '${arg}'`);
		}
	}
	return options;
}

function samplingArgs(sampling: Sampling): string[] {
	const args = ["--temp", String(sampling.temp), "--top-p", String(sampling.topP)];
	// Presence, not truthiness: `--min-p 0` is a real setting.
	if (sampling.topK !== undefined) args.push("--top-k", String(sampling.topK));
	if (sampling.minP !== undefined) args.push("--min-p", String(sampling.minP));
	if (sampling.repeatPenalty !== undefined) args.push("--repeat-penalty", String(sampling.repeatPenalty));
	return args;
}

function printProfiles(): void {
	console.log(`${"profile".padEnd(22)} ${"ctx".padStart(6)} ${"ngl".padStart(4)} ${"cpu-moe".padStart(7)}  weights`);
	for (const [key, profile] of Object.entries(PROFILES)) {
		const ncmoe = profile.ncmoe === undefined ? "-" : String(profile.ncmoe);
		console.log(
			`${key.padEnd(22)} ${String(profile.ctx).padStart(6)} ${String(profile.ngl).padStart(4)} ${ncmoe.padStart(7)}  ${profile.file}`,
		);
		console.log(`${" ".repeat(22)} sampling: ${samplingArgs(profile.sampling).join(" ")}`);
	}
	console.log("");
	console.log(`default: ${DEFAULT_PROFILE}. Measured on the reference box; see docs/benchmarks.md §4.`);
}

function listGgufs(dir: string): string[] {
	try {
		if (!statSync(dir).isDirectory()) return [];
		return readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".gguf"))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Descendants of `root`, deepest first, from /proc. The pid tree is the only
 * dependency-free way to reach a grandchild: llama-server is not a process group
 * leader, so a negative-pid signal reaches nothing on Linux.
 */
function descendants(root: number): number[] {
	if (process.platform !== "linux") return [];
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return [];
	}
	const childrenOf = new Map<number, number[]>();
	for (const entry of entries) {
		const pid = Number.parseInt(entry, 10);
		if (!Number.isInteger(pid)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			continue; // exited between listing and read
		}
		// Field 2 is the executable name in parentheses and may itself contain
		// spaces or parentheses, so ppid is read relative to the last ')'.
		const fields = stat
			.slice(stat.lastIndexOf(")") + 1)
			.trim()
			.split(" ");
		const ppid = Number.parseInt(fields[1] ?? "", 10);
		if (!Number.isInteger(ppid)) continue;
		const siblings = childrenOf.get(ppid);
		if (siblings === undefined) childrenOf.set(ppid, [pid]);
		else siblings.push(pid);
	}
	const found: number[] = [];
	const walk = (pid: number): void => {
		for (const child of childrenOf.get(pid) ?? []) {
			walk(child);
			found.push(child);
		}
	};
	walk(root);
	return found;
}

/**
 * Kills the server and everything under it. A bare kill of the direct child can
 * leave a llama-server descendant holding the port and the GPU allocation; the
 * tree is collected before signalling because a dead parent's children are
 * reparented to init and unfindable.
 */
function killTree(pid: number): void {
	if (WIN) {
		try {
			Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(pid)], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			return;
		} catch {
			/* taskkill unavailable: fall through to the direct kill below */
		}
	}
	for (const target of [...descendants(pid), pid]) {
		try {
			process.kill(target, "SIGTERM");
		} catch {
			/* already gone */
		}
	}
	// Escalate unconditionally: a server mid-load ignores SIGTERM long enough to
	// outlive this process, and the pid is still ours to signal until we exit.
	for (const target of [...descendants(pid), pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {
			/* exited on the SIGTERM above */
		}
	}
}

let livePid: number | null = null;

/** Idempotent: a second Ctrl-C must not signal a pid the OS may have recycled. */
function teardown(): void {
	if (livePid === null) return;
	const pid = livePid;
	livePid = null;
	killTree(pid);
}

/** Printed command lines must survive being pasted back into a shell. */
function quote(token: string): string {
	if (/^[A-Za-z0-9_@%+=:,.\\/-]+$/.test(token)) return token;
	return WIN ? `"${token.replace(/"/g, '""')}"` : `'${token.replace(/'/g, "'\\''")}'`;
}

async function main(): Promise<number> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed === "help") {
		console.log(USAGE);
		return 0;
	}
	if (parsed === "list") {
		printProfiles();
		return 0;
	}
	const opts = parsed;

	const profile = PROFILES[opts.profile];
	if (profile === undefined) {
		throw new UsageError(`unknown profile '${opts.profile}'; known profiles: ${Object.keys(PROFILES).join(", ")}`);
	}

	const server = path.join(opts.root, "current", WIN ? "llama-server.exe" : "llama-server");
	const file = opts.model ?? profile.file;
	const weights = path.isAbsolute(file) ? path.normalize(file) : path.resolve(opts.modelsDir, file);
	const ncmoe = opts.ncmoe ?? profile.ncmoe;
	// A weights override makes the profile key a lie as a model name: clients see
	// the alias in /v1/models, so it names the file that is actually loaded unless
	// the operator said otherwise.
	const alias = opts.alias ?? (opts.model === undefined ? opts.profile : path.basename(weights).replace(/\.gguf$/i, ""));

	const args = [
		"-m",
		weights,
		"--alias",
		alias,
		"-ngl",
		String(opts.ngl ?? profile.ngl),
	];
	// Omitted rather than passed as 0, which is what the flag's absence means.
	if (ncmoe !== undefined && ncmoe > 0) args.push("--n-cpu-moe", String(ncmoe));
	args.push(
		"-c",
		String(opts.ctx ?? profile.ctx),
		// q8_0 KV halves cache VRAM against f16 at no measurable quality cost, and
		// on this card the cache is what decides whether the weights fit.
		"--cache-type-k",
		"q8_0",
		"--cache-type-v",
		"q8_0",
		"--flash-attn",
		"on",
		// Tool calling needs the model's own chat template, not llama.cpp's generic one.
		"--jinja",
		"--host",
		opts.host,
		"--port",
		String(opts.port),
		"-t",
		String(opts.threads),
		"-b",
		"2048",
		"-ub",
		"512",
		// One slot: a single agent session gets the whole KV cache instead of a share of it.
		"--parallel",
		"1",
		"--cont-batching",
		"--no-webui",
		"--metrics",
		...samplingArgs(profile.sampling),
		...opts.extra,
	);

	const commandLine = [server, ...args].map(quote).join(" ");
	if (opts.dryRun) {
		// No existence checks: the point of --dry-run is reviewing the argv, which
		// must work on a box that has neither the engine nor the weights yet.
		console.log(commandLine);
		return 0;
	}

	if (!existsSync(server)) {
		console.error(`llama-server not found at ${server}`);
		console.error(`Run ${INSTALLER} first, or pass --root <dir> if the engine lives elsewhere.`);
		return 1;
	}
	if (!existsSync(weights)) {
		const dir = path.dirname(weights);
		const present = listGgufs(dir);
		console.error(`weights not found: ${weights}`);
		console.error(
			present.length > 0
				? `GGUF files present in ${dir}:\n  ${present.join("\n  ")}`
				: `No .gguf files in ${dir}`,
		);
		return 1;
	}

	console.log(
		`serving ${path.basename(weights)} as "${alias}" at ctx ${opts.ctx ?? profile.ctx} (profile ${opts.profile}) on http://${opts.host}:${opts.port}`,
	);
	// Foreground with inherited stdio: llama.cpp's own log is the operator's log,
	// and there is no supervisor here to interpret it.
	const proc = Bun.spawn({ cmd: [server, ...args], stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	livePid = proc.pid;
	try {
		return await proc.exited;
	} finally {
		teardown();
	}
}

// A Ctrl-C that leaks a llama-server holding 15 GiB of VRAM is a bug, so the
// tree dies before this process does.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		teardown();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

try {
	process.exitCode = await main();
} catch (error) {
	teardown();
	if (error instanceof UsageError) {
		console.error(`serve: ${error.message}`);
		console.error("");
		console.error(USAGE);
	} else {
		console.error(`serve: ${error instanceof Error ? error.message : String(error)}`);
	}
	process.exitCode = 1;
}
