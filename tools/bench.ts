#!/usr/bin/env bun
/**
 * Raw kernel throughput per model via llama-bench, with no KV-cache pressure.
 *
 * Reports the ceiling the GPU can reach for a given weights file and offload
 * split. These numbers are deliberately optimistic: they use a short context, so
 * they exclude the KV cache that dominates VRAM in real agent sessions. Use
 * tools/profile-sweep.ts for numbers that reflect an actual serving profile.
 *
 * Operator tooling: self-contained by design, so it never imports from src/**.
 */
import os from "node:os";
import path from "node:path";

const WINDOWS = process.platform === "win32";

interface Options {
	binDir: string;
	modelsDir: string;
	promptTokens: number;
	generateTokens: number;
	repetitions: number;
}

interface Run {
	label: string;
	file: string;
	/** Expert layers left on the CPU; 0 keeps the whole model on the GPU. */
	ncmoe: number;
}

const RUNS: readonly Run[] = [
	{
		label: "Qwen3-Coder-30B-A3B Q3_K_XL, all experts on GPU",
		file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf",
		ncmoe: 0,
	},
	{
		label: "Qwen3-Coder-30B-A3B Q4_K_XL, 14 expert layers on CPU",
		file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
		ncmoe: 14,
	},
	{
		label: "Devstral-Small-2507 Q4_K_M, dense",
		file: "Devstral-Small-2507-Q4_K_M.gguf",
		ncmoe: 0,
	},
];

/**
 * llama-bench prints its table on stdout but device banners on stderr; the
 * PowerShell original merged both with `2>&1` and kept only these three shapes.
 */
const KEEP = /^\||^build:|compute capability/;

const HOME = os.homedir();
const DEFAULTS: Options = {
	// Both install-engine.sh and install-engine.ps1 publish the current build here.
	binDir: path.join(HOME, ".local", "llama.cpp", "current"),
	modelsDir: path.join(HOME, "models"),
	promptTokens: 2048,
	generateTokens: 128,
	repetitions: 2,
};

const USAGE = `Usage: bun run tools/bench.ts [options]

Raw kernel throughput per model via llama-bench, at short context (no KV-cache
pressure). Use tools/profile-sweep.ts for serving-profile numbers.

Options:
  --bin-dir <path>        llama.cpp binaries (default: ${DEFAULTS.binDir})
  --models-dir <path>     GGUF weights (default: ${DEFAULTS.modelsDir})
  --prompt-tokens <n>     prefill tokens per run (default: ${DEFAULTS.promptTokens})
  --generate-tokens <n>   generated tokens per run (default: ${DEFAULTS.generateTokens})
  --repetitions <n>       repetitions per run (default: ${DEFAULTS.repetitions})
  --help                  print this message and exit`;

class UsageError extends Error {}

function positiveInt(flag: string, raw: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new UsageError(`${flag} expects a positive integer, got '${raw}'`);
	return value;
}

function parseArgs(argv: readonly string[]): Options | "help" {
	const options: Options = { ...DEFAULTS };
	let index = 0;

	while (index < argv.length) {
		const arg = argv[index++] ?? "";
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
			case "--bin-dir":
				options.binDir = valueFor();
				break;
			case "--models-dir":
				options.modelsDir = valueFor();
				break;
			case "--prompt-tokens":
				options.promptTokens = positiveInt(flag, valueFor());
				break;
			case "--generate-tokens":
				options.generateTokens = positiveInt(flag, valueFor());
				break;
			case "--repetitions":
				options.repetitions = positiveInt(flag, valueFor());
				break;
			default:
				throw new UsageError(`unknown option '${arg}'`);
		}
	}
	return options;
}

function emit(line: string): void {
	const text = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (KEEP.test(text)) console.log(text);
}

/** Filter as lines arrive: a three-model sweep takes minutes, so nothing is buffered to the end. */
async function forwardFiltered(stream: ReadableStream<Uint8Array>): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	for await (const chunk of stream) {
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) emit(line);
	}
	pending += decoder.decode();
	if (pending.length > 0) emit(pending);
}

async function main(): Promise<number> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed === "help") {
		console.log(USAGE);
		return 0;
	}
	const options = parsed;

	const bench = path.join(options.binDir, WINDOWS ? "llama-bench.exe" : "llama-bench");
	if (!(await Bun.file(bench).exists())) {
		const installer = WINDOWS ? "llama-cpp-installation\\install-engine.ps1" : "llama-cpp-installation/install-engine.sh";
		console.error(`${path.basename(bench)} not found in ${options.binDir}; run ${installer} first`);
		return 1;
	}

	for (const run of RUNS) {
		const model = path.join(options.modelsDir, run.file);
		if (!(await Bun.file(model).exists())) {
			console.log(`skipping ${run.label}: ${model} not present`);
			continue;
		}
		console.log("");
		console.log(`=== ${run.label} ===`);

		const cmd = [
			bench,
			"-m",
			model,
			"-ngl",
			"99",
			"-p",
			String(options.promptTokens),
			"-n",
			String(options.generateTokens),
			"-r",
			String(options.repetitions),
		];
		if (run.ncmoe > 0) cmd.push("--n-cpu-moe", String(run.ncmoe));

		const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		await Promise.all([forwardFiltered(proc.stdout), forwardFiltered(proc.stderr)]);
		// A model that fails to load must not abort the remaining runs, matching
		// the original's $ErrorActionPreference = 'Continue'.
		await proc.exited;
	}
	return 0;
}

try {
	process.exitCode = await main();
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`bench: ${error.message}`);
		console.error("");
		console.error(USAGE);
	} else {
		console.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
	}
	process.exitCode = 1;
}
