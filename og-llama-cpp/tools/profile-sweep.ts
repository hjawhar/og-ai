#!/usr/bin/env bun
/**
 * Measures VRAM use, prefill throughput and generation throughput for candidate
 * llama-server launch profiles, so the profile numbers in src/config/load.ts stay
 * grounded after an engine upgrade or a weights change.
 *
 * The binding constraint on a 16 GiB card is VRAM. Once resident memory passes
 * roughly 15.4 GiB the NVIDIA driver silently pages weights to host RAM and
 * throughput drops about 8x while the server still reports healthy. So one server
 * is started per case, nvidia-smi is sampled while the model is loaded, a
 * prefill-heavy request is issued, then the server is torn down.
 *
 *   bun run tools/profile-sweep.ts
 *   bun run tools/profile-sweep.ts --cases '[{"label":"probe","file":"model.gguf","ctx":32768,"ncmoe":14}]'
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
const HOME = os.homedir();
const INSTALLER = WIN ? ".\\install-engine.ps1" : "./install-engine.sh";

interface SweepCase {
	label: string;
	file: string;
	ctx: number;
	/** CPU-resident MoE layers; 0 or absent keeps every expert on the GPU. */
	ncmoe?: number;
	ngl?: number;
}

interface Options {
	binDir: string;
	modelsDir: string;
	port: number;
	headroomFloorMiB: number;
	prefillTokens: number;
	generateTokens: number;
	cases: SweepCase[];
}

const Q4 = "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf";
const Q3 = "Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf";

const DEFAULT_CASES: SweepCase[] = [
	{ label: "qwen3-coder-30b", file: Q4, ctx: 32768, ncmoe: 14 },
	{ label: "qwen3-coder-30b-long", file: Q4, ctx: 65536, ncmoe: 18 },
	{ label: "qwen3-coder-30b-fast", file: Q3, ctx: 32768, ncmoe: 4 },
];

const USAGE = `usage: bun run tools/profile-sweep.ts [options]

Starts llama-server once per case, samples VRAM, measures prefill and generation
throughput, then tears the server down.

  --bin-dir <path>          llama.cpp bin directory (default ${path.join(HOME, ".local", "llama.cpp", "current")})
  --models-dir <path>       weights directory for relative case files (default ${path.join(HOME, "models")})
  --port <n>                port the probe server listens on (default 8127)
  --headroom-floor-mib <n>  free VRAM below this is the driver's spill regime (default 1000)
  --prefill-tokens <n>      approximate prompt length in tokens (default 6000)
  --generate-tokens <n>     tokens to generate per case (default 256)
  --cases <json|path>       JSON array of { label, file, ctx, ncmoe?, ngl? }, inline or a file path
  --help                    print this and exit

Requires a built engine; run ${INSTALLER} first.`;

/** ~4.2 chars/token of realistic source text. */
const UNIT =
	'function processRecord(record, options) { const merged = Object.assign({}, defaults, options); if (!record.id) throw new Error("missing id"); return { ...merged, id: record.id, hash: hashOf(record) }; } ';

const HEALTH_ATTEMPTS = 150;
const HEALTH_INTERVAL_MS = 2000;
const HEALTH_TIMEOUT_MS = 3000;
const COMPLETION_TIMEOUT_MS = 900_000;
/** The driver needs a moment to release the allocation before the next case loads. */
const SETTLE_AFTER_OK_MS = 5000;
const SETTLE_AFTER_FAILURE_MS = 4000;

interface Vram {
	used: number;
	total: number;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function parseArgs(argv: string[]): Options {
	const raw = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token === "--help" || token === "-h") {
			console.log(USAGE);
			process.exit(0);
		}
		if (!token.startsWith("--")) fail(`unexpected argument: ${token}\n\n${USAGE}`);
		const eq = token.indexOf("=");
		if (eq !== -1) {
			raw.set(token.slice(2, eq), token.slice(eq + 1));
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) fail(`--${token.slice(2)} needs a value\n\n${USAGE}`);
		raw.set(token.slice(2), value);
		i++;
	}

	const known: Record<string, true> = {
		"bin-dir": true,
		"models-dir": true,
		port: true,
		"headroom-floor-mib": true,
		"prefill-tokens": true,
		"generate-tokens": true,
		cases: true,
	};
	for (const key of raw.keys()) {
		if (known[key] !== true) fail(`unknown option: --${key}\n\n${USAGE}`);
	}

	const int = (key: string, fallback: number): number => {
		const value = raw.get(key);
		if (value === undefined) return fallback;
		const parsed = Number.parseInt(value, 10);
		if (!Number.isInteger(parsed) || parsed <= 0) fail(`--${key} must be a positive integer, got ${value}`);
		return parsed;
	};

	const casesArg = raw.get("cases");
	return {
		binDir: raw.get("bin-dir") ?? path.join(HOME, ".local", "llama.cpp", "current"),
		modelsDir: raw.get("models-dir") ?? path.join(HOME, "models"),
		port: int("port", 8127),
		headroomFloorMiB: int("headroom-floor-mib", 1000),
		prefillTokens: int("prefill-tokens", 6000),
		generateTokens: int("generate-tokens", 256),
		cases: casesArg === undefined ? DEFAULT_CASES : parseCases(casesArg),
	};
}

/** `--cases` is either inline JSON or a path to a JSON file holding the same array. */
function parseCases(arg: string): SweepCase[] {
	let text = arg;
	if (!arg.trimStart().startsWith("[")) {
		if (!existsSync(arg)) fail(`--cases is neither JSON nor an existing file: ${arg}`);
		try {
			text = readFileSync(arg, "utf8");
		} catch (err) {
			fail(`--cases file unreadable: ${(err as Error).message}`);
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		fail(`--cases is not valid JSON: ${(err as Error).message}`);
	}
	if (!Array.isArray(parsed) || parsed.length === 0) fail("--cases must be a non-empty JSON array");

	return parsed.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) fail(`--cases[${index}] is not an object`);
		const { label, file, ctx, ncmoe, ngl } = entry as Record<string, unknown>;
		if (typeof file !== "string" || file === "") fail(`--cases[${index}].file must be a non-empty string`);
		if (typeof ctx !== "number" || !Number.isInteger(ctx) || ctx <= 0) {
			fail(`--cases[${index}].ctx must be a positive integer`);
		}
		if (label !== undefined && typeof label !== "string") fail(`--cases[${index}].label must be a string`);
		for (const [name, value] of [
			["ncmoe", ncmoe],
			["ngl", ngl],
		] as const) {
			if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
				fail(`--cases[${index}].${name} must be a non-negative integer`);
			}
		}
		// exactOptionalPropertyTypes: absent knobs stay absent so the launch
		// defaults below apply, rather than being pinned to `undefined`.
		const kase: SweepCase = { label: label ?? path.basename(file), file, ctx };
		if (typeof ncmoe === "number") kase.ncmoe = ncmoe;
		if (typeof ngl === "number") kase.ngl = ngl;
		return kase;
	});
}

async function readVram(): Promise<Vram | null> {
	try {
		const proc = Bun.spawn(
			["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
		);
		const out = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return null;
		const line = out
			.split(/\r?\n/)
			.map((l) => l.trim())
			.find((l) => l !== "");
		if (line === undefined) return null;
		const [usedRaw, totalRaw] = line.split(",");
		const used = Number.parseInt((usedRaw ?? "").trim(), 10);
		const total = Number.parseInt((totalRaw ?? "").trim(), 10);
		if (!Number.isInteger(used) || !Number.isInteger(total)) return null;
		return { used, total };
	} catch {
		// No NVIDIA driver on this box: the VRAM columns drop out of the report
		// rather than aborting a throughput sweep that is still meaningful.
		return null;
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
 * leave a llama-server descendant holding the port and the GPU allocation, and
 * the next case then fails to bind; the tree is collected before signalling
 * because a dead parent's children are reparented to init and unfindable.
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
			process.kill(target, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

/** `-24`/`9`-wide columns of the original report; the VRAM pair drops when nvidia-smi is absent. */
function formatRow(
	label: string,
	vram: readonly [string, string] | null,
	prefill: string,
	gen: string,
	verdict: string,
): string {
	const middle = vram === null ? "" : ` ${vram[0].padStart(9)} ${vram[1].padStart(9)}`;
	return `${label.padEnd(24)}${middle} ${prefill.padStart(12)} ${gen.padStart(9)}  ${verdict}`;
}

/** Last `count` lines of a log file, indented for the failure report. */
async function logTail(file: string, count: number): Promise<string[]> {
	try {
		const text = await Bun.file(file).text();
		return text.replace(/\r?\n$/, "").split(/\r?\n/).slice(-count);
	} catch {
		return [];
	}
}

let livePid: number | null = null;

function teardown(): void {
	if (livePid !== null) {
		killTree(livePid);
		livePid = null;
	}
}

async function runCase(kase: SweepCase, opts: Options, server: string, prompt: string, hasVram: boolean): Promise<void> {
	const label = kase.label;
	const modelPath = path.isAbsolute(kase.file) ? kase.file : path.join(opts.modelsDir, kase.file);
	if (!existsSync(modelPath)) {
		console.log(`${label.padEnd(24)} missing weights: ${modelPath}`);
		return;
	}

	const serverArgs = [
		"-m",
		modelPath,
		"-ngl",
		String(kase.ngl ?? 99),
		"-c",
		String(kase.ctx),
		"--cache-type-k",
		"q8_0",
		"--cache-type-v",
		"q8_0",
		"--flash-attn",
		"on",
		"--jinja",
		"--host",
		"127.0.0.1",
		"--port",
		String(opts.port),
		"--no-webui",
		"-t",
		"8",
		"-b",
		"2048",
		"-ub",
		"512",
		"--parallel",
		"1",
	];
	if (kase.ncmoe !== undefined && kase.ncmoe > 0) serverArgs.push("--n-cpu-moe", String(kase.ncmoe));

	const log = path.join(os.tmpdir(), "og-profile-sweep.log");
	const proc = Bun.spawn([server, ...serverArgs], {
		stdin: "ignore",
		stdout: Bun.file(`${log}.out`),
		stderr: Bun.file(log),
	});
	livePid = proc.pid;

	let exited = false;
	void proc.exited.then(() => {
		exited = true;
	});

	try {
		let ready = false;
		for (let i = 0; i < HEALTH_ATTEMPTS; i++) {
			await Bun.sleep(HEALTH_INTERVAL_MS);
			if (exited) break;
			try {
				const res = await fetch(`http://127.0.0.1:${opts.port}/health`, {
					signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
				});
				const body = (await res.json().catch(() => null)) as { status?: string } | null;
				if (res.ok && body?.status === "ok") {
					ready = true;
					break;
				}
			} catch {
				/* server still loading weights */
			}
		}

		if (!ready) {
			console.log(`${label.padEnd(24)} FAILED TO START`);
			for (const line of await logTail(log, 5)) console.log(`    ${line}`);
			teardown();
			await Bun.sleep(SETTLE_AFTER_FAILURE_MS);
			return;
		}

		const vram = await readVram();
		try {
			const res = await fetch(`http://127.0.0.1:${opts.port}/completion`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					prompt,
					n_predict: opts.generateTokens,
					temperature: 0.2,
					cache_prompt: false,
				}),
				signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const result = (await res.json()) as {
				timings?: { prompt_per_second?: number; predicted_per_second?: number };
			};
			const prefill = result.timings?.prompt_per_second;
			const generate = result.timings?.predicted_per_second;
			if (prefill === undefined || generate === undefined) throw new Error("response carried no timings");

			const columns = hasVram
				? vram === null
					? (["-", "-"] as const)
					: ([String(vram.used), String(vram.total - vram.used)] as const)
				: null;
			const verdict =
				vram === null
					? "vram unmeasured"
					: vram.total - vram.used < opts.headroomFloorMiB
						? "SPILL RISK"
						: "ok";
			console.log(
				formatRow(
					label,
					columns,
					prefill.toLocaleString("en-US", { maximumFractionDigits: 0 }),
					generate.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
					verdict,
				),
			);
		} catch (err) {
			console.log(`${label.padEnd(24)} REQUEST FAILED: ${(err as Error).message}`);
		}
	} finally {
		teardown();
		await proc.exited;
	}
	await Bun.sleep(SETTLE_AFTER_OK_MS);
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const server = path.join(opts.binDir, WIN ? "llama-server.exe" : "llama-server");
	if (!existsSync(server)) {
		fail(`${path.basename(server)} not found in ${opts.binDir}; run ${INSTALLER} first`);
	}

	// Rounded, not truncated: PowerShell's `[int]` cast rounded, and the prompt
	// length is a measurement input that must not drift between the two ports.
	const prompt = UNIT.repeat(Math.max(1, Math.round((opts.prefillTokens * 4.2) / UNIT.length)));

	const idle = await readVram();
	if (idle === null) {
		console.log("nvidia-smi unavailable: VRAM columns omitted, throughput still measured");
	} else {
		console.log(`idle ${idle.used} / ${idle.total} MiB in use before any model is loaded`);
	}
	const hasVram = idle !== null;
	console.log(
		formatRow(
			"profile",
			hasVram ? (["vramMiB", "headroom"] as const) : null,
			"prefill t/s",
			"gen t/s",
			"verdict",
		),
	);

	for (const kase of opts.cases) await runCase(kase, opts, server, prompt, hasVram);
}

// Ctrl-C during a case would otherwise leave llama-server holding the GPU.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		teardown();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

try {
	await main();
} catch (err) {
	teardown();
	fail((err as Error).message);
}
