/**
 * Machine and inference-stack introspection, backing `/stats`.
 *
 * Collection is deliberately split from rendering: `collectSystemInfo` is the
 * only part that touches the OS, spawns probes or reads the filesystem, and
 * every one of those probes is best effort — a missing `nvidia-smi`, an absent
 * models directory or a llama.cpp build that predates `--version` yields an
 * omitted optional field or an empty array, never a rejected promise. That way
 * `/stats` still reports what it *can* see on a half-provisioned machine.
 *
 * `renderSystemInfo` is pure and total: same input, same lines, and every line
 * fits the requested width so the caller can drop them straight into a pinned
 * region without re-measuring.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OgConfig } from "../config/schema.ts";
import { bold, dim, elapsed, formatBytes, green, progressBar, red, truncateLine } from "./render.ts";

export interface GpuInfo {
	name: string;
	memoryTotalMiB: number;
	memoryUsedMiB: number;
	driverVersion: string;
	computeCap: string;
	utilizationPct?: number;
	temperatureC?: number;
}

export interface WeightsInfo {
	file: string;
	bytes: number;
}

export interface SystemInfo {
	os: { platform: string; release: string; arch: string; hostname: string };
	cpu: { model: string; physicalCores?: number; logicalCores: number; speedMHz: number };
	memory: { totalBytes: number; freeBytes: number };
	gpus: GpuInfo[];
	runtime: { bun: string; nodeApi: string };
	engine: {
		binDir: string;
		resolvedBuild?: string;
		serverVersion?: string;
		endpoint: string;
		running: boolean;
		modelsDir: string;
		weights: WeightsInfo[];
	};
	uptimeSec: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** Probe timeout. `--version` and `nvidia-smi` answer in milliseconds; a hang is a broken install. */
const PROBE_TIMEOUT_MS = 5_000;

interface Capture {
	/** stdout and stderr concatenated: llama.cpp prints its banner to either, depending on build. */
	text: string;
	exitCode: number | null;
	timedOut: boolean;
}

/**
 * Spawn, capture both streams, and give up after `timeoutMs`. Never throws:
 * a missing binary surfaces as `undefined`, exactly like a failing one.
 */
async function capture(cmd: readonly string[], timeoutMs: number): Promise<Capture | undefined> {
	try {
		const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		try {
			const [out, err] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { text: `${out}${err}`, exitCode: proc.exitCode, timedOut };
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return undefined;
	}
}

/**
 * Physical core count, per platform. Linux publishes the topology, so the
 * (physical id, core id) pairs in /proc/cpuinfo are counted rather than paying
 * for a probe process; kernels that omit those fields (common on arm64) leave
 * the field absent and `/stats` then reports logical cores only.
 */
function linuxPhysicalCores(): number | undefined {
	let text: string;
	try {
		text = fs.readFileSync("/proc/cpuinfo", "utf8");
	} catch {
		return undefined;
	}
	const cores = new Set<string>();
	// Fields are per-CPU blocks in file order: "physical id" always precedes the
	// "core id" it qualifies, so a socket with reused core ids still counts once.
	let socket = "";
	for (const line of text.split("\n")) {
		const sep = line.indexOf(":");
		if (sep < 0) continue;
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		if (key === "physical id") socket = value;
		else if (key === "core id") cores.add(`${socket}/${value}`);
	}
	return cores.size > 0 ? cores.size : undefined;
}

/**
 * Physical core count on Windows. `wmic` is absent from recent Windows 11
 * images, so PowerShell's CIM query is the fallback; both are read as
 * "sum of the positive integers that are not the column header".
 */
async function readPhysicalCores(): Promise<number | undefined> {
	if (process.platform === "linux") return linuxPhysicalCores();
	if (process.platform !== "win32") return undefined;
	const probes: readonly string[][] = [
		["wmic", "cpu", "get", "NumberOfCores"],
		[
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
		],
	];
	for (const probe of probes) {
		const result = await capture(probe, PROBE_TIMEOUT_MS);
		if (!result || result.timedOut) continue;
		let sum = 0;
		for (const line of result.text.split(/\r?\n/)) {
			const value = Number.parseInt(line.trim(), 10);
			if (Number.isFinite(value) && value > 0) sum += value;
		}
		if (sum > 0) return sum;
	}
	return undefined;
}

/** Optional numeric CSV cell: `[N/A]`, blank and garbage all mean "not reported". */
function optionalNumber(cell: string | undefined): number | undefined {
	const value = Number.parseFloat((cell ?? "").trim());
	return Number.isFinite(value) ? value : undefined;
}

/**
 * One entry per NVIDIA GPU. The query string must stay a single argv element:
 * the commas inside it are field separators for nvidia-smi, not shell syntax.
 */
async function readGpus(): Promise<GpuInfo[]> {
	const result = await capture(
		[
			"nvidia-smi",
			"--query-gpu=name,memory.total,memory.used,driver_version,compute_cap,utilization.gpu,temperature.gpu",
			"--format=csv,noheader,nounits",
		],
		PROBE_TIMEOUT_MS,
	);
	if (!result || result.timedOut || result.exitCode !== 0) return [];
	const gpus: GpuInfo[] = [];
	for (const line of result.text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const cells = line.split(",").map((cell) => cell.trim());
		const name = cells[0] ?? "";
		const total = optionalNumber(cells[1]);
		const used = optionalNumber(cells[2]);
		// Without a name and a VRAM pair the row says nothing worth printing.
		if (name === "" || total === undefined || used === undefined) continue;
		const utilization = optionalNumber(cells[5]);
		const temperature = optionalNumber(cells[6]);
		gpus.push({
			name,
			memoryTotalMiB: total,
			memoryUsedMiB: used,
			driverVersion: cells[3] ?? "",
			computeCap: cells[4] ?? "",
			...(utilization !== undefined ? { utilizationPct: utilization } : {}),
			...(temperature !== undefined ? { temperatureC: temperature } : {}),
		});
	}
	return gpus;
}

/**
 * Build tag behind `binDir`. The install layout is a `current` junction onto a
 * versioned directory, so the interesting name is the *target's* last segment;
 * a plain directory has nothing extra to report.
 */
function resolveBuild(binDir: string): string | undefined {
	try {
		const declared = path.resolve(binDir);
		const real = fs.realpathSync(declared);
		const unchanged =
			process.platform === "win32" ? real.toLowerCase() === declared.toLowerCase() : real === declared;
		if (unchanged) return undefined;
		const segment = path.basename(real);
		return segment === "" ? undefined : segment;
	} catch {
		return undefined;
	}
}

/** `--version` banner line from llama-server. It exits immediately; no server is started. */
async function readServerVersion(binDir: string): Promise<string | undefined> {
	const bin = path.join(binDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
	const result = await capture([bin, "--version"], PROBE_TIMEOUT_MS);
	if (!result || result.timedOut) return undefined;
	for (const line of result.text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.toLowerCase().startsWith("version:")) return trimmed;
	}
	return undefined;
}

/** GGUF files directly in `modelsDir`, largest first. Shards of one model sort together. */
function readWeights(modelsDir: string): WeightsInfo[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(modelsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const weights: WeightsInfo[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.toLowerCase().endsWith(".gguf")) continue;
		try {
			const stat = fs.statSync(path.join(modelsDir, entry.name));
			weights.push({ file: entry.name, bytes: stat.size });
		} catch {
			/* vanished or unreadable between listing and stat */
		}
	}
	weights.sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
	return weights;
}

export async function collectSystemInfo(input: {
	config: OgConfig;
	engineRunning: boolean;
}): Promise<SystemInfo> {
	const { config, engineRunning } = input;
	const cpus = os.cpus();
	const first = cpus[0];
	// Independent probes; each already swallows its own failures.
	const [physicalCores, gpus, serverVersion] = await Promise.all([
		readPhysicalCores(),
		readGpus(),
		readServerVersion(config.engine.binDir),
	]);
	const resolvedBuild = resolveBuild(config.engine.binDir);
	const speed = first?.speed ?? 0;
	let hostname = "";
	try {
		hostname = os.hostname();
	} catch {
		/* locked-down containers refuse the lookup; a blank name is not fatal */
	}
	return {
		os: { platform: os.platform(), release: os.release(), arch: os.arch(), hostname },
		cpu: {
			// Vendor brand strings carry runs of padding; collapse them for a stable width.
			model: (first?.model ?? "").replace(/\s+/g, " ").trim(),
			...(physicalCores !== undefined ? { physicalCores } : {}),
			logicalCores: cpus.length,
			speedMHz: Number.isFinite(speed) && speed > 0 ? speed : 0,
		},
		memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
		gpus,
		runtime: { bun: Bun.version, nodeApi: process.versions.node },
		engine: {
			binDir: config.engine.binDir,
			...(resolvedBuild !== undefined ? { resolvedBuild } : {}),
			...(serverVersion !== undefined ? { serverVersion } : {}),
			endpoint: config.endpoint,
			running: engineRunning,
			modelsDir: config.engine.modelsDir,
			weights: readWeights(config.engine.modelsDir),
		},
		uptimeSec: Math.max(0, Math.round(os.uptime())),
	};
}

/**
 * GiB/MiB with one decimal, the resolution people compare weights and VRAM at.
 * The unit is chosen from the *rounded* value, so a hair under a gibibyte reads
 * as `1.0 GiB` rather than the self-contradicting `1024.0 MiB`. Sub-mebibyte
 * values fall through to the shared byte formatter.
 */
function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	const gib = (bytes / GIB).toFixed(1);
	if (Number.parseFloat(gib) >= 1) return `${gib} GiB`;
	const mib = (bytes / MIB).toFixed(1);
	if (Number.parseFloat(mib) >= 1) return `${mib} MiB`;
	return formatBytes(bytes);
}

/** Occupancy fraction, total for any absurd pair: NaN and a zero denominator read as empty. */
function fractionOf(used: number, total: number): number {
	if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
	return Math.min(Math.max(used / total, 0), 1);
}

const LABEL_WIDTH = 10;
const SUB_LABEL_WIDTH = 8;

/** `  label      value`; `sub` indents deeper but keeps the same value column. */
function entry(label: string, value: string): string {
	return `  ${dim(label.padEnd(LABEL_WIDTH))} ${value}`;
}

function sub(label: string, value: string): string {
	return `    ${dim(label.padEnd(SUB_LABEL_WIDTH))} ${value}`;
}

export function renderSystemInfo(info: SystemInfo, width: number): string[] {
	// Below 20 columns nothing readable exists; clamp instead of failing the caller.
	const cols = Number.isFinite(width) ? Math.max(20, Math.trunc(width)) : 20;
	const lines: string[] = [];

	const section = (heading: string): void => {
		if (lines.length > 0) lines.push("");
		lines.push(bold(heading));
	};

	section("host");
	const release = info.os.release === "" ? "" : ` ${info.os.release}`;
	const arch = info.os.arch === "" ? "" : ` (${info.os.arch})`;
	lines.push(entry("os", `${info.os.platform}${release}${arch}`));
	if (info.os.hostname !== "") lines.push(entry("hostname", info.os.hostname));
	lines.push(entry("uptime", elapsed(info.uptimeSec * 1000)));

	section("cpu");
	lines.push(entry("model", info.cpu.model === "" ? dim("unknown") : info.cpu.model));
	const physical = info.cpu.physicalCores;
	lines.push(
		entry(
			"cores",
			physical !== undefined
				? `${physical} physical \u00b7 ${info.cpu.logicalCores} logical`
				: `${info.cpu.logicalCores} logical`,
		),
	);
	if (info.cpu.speedMHz > 0) lines.push(entry("clock", `${Math.round(info.cpu.speedMHz)} MHz`));

	section("memory");
	const totalBytes = info.memory.totalBytes;
	const freeBytes = Math.min(Math.max(info.memory.freeBytes, 0), Math.max(totalBytes, 0));
	const usedBytes = Math.max(totalBytes - freeBytes, 0);
	const ramFraction = fractionOf(usedBytes, totalBytes);
	lines.push(entry("installed", formatSize(totalBytes)));
	lines.push(
		entry(
			"in use",
			`${progressBar(ramFraction, 10)} ${Math.round(ramFraction * 100)}% ${formatSize(usedBytes)}`,
		),
	);
	lines.push(entry("free", formatSize(freeBytes)));

	section("gpu");
	if (info.gpus.length === 0) {
		lines.push(`  ${dim("no NVIDIA GPU detected")}`);
	} else {
		info.gpus.forEach((gpu, index) => {
			lines.push(entry(`gpu ${index}`, gpu.name));
			const vramFraction = fractionOf(gpu.memoryUsedMiB, gpu.memoryTotalMiB);
			// Raw MiB, because that is the unit every GPU tool and llama.cpp log uses.
			const used = Number.isFinite(gpu.memoryUsedMiB) ? Math.round(gpu.memoryUsedMiB) : 0;
			const total = Number.isFinite(gpu.memoryTotalMiB) ? Math.round(gpu.memoryTotalMiB) : 0;
			lines.push(
				sub(
					"vram",
					`${progressBar(vramFraction, 10)} ${Math.round(vramFraction * 100)}% ${used} / ${total} MiB`,
				),
			);
			const identity: string[] = [];
			if (gpu.driverVersion !== "") identity.push(`driver ${gpu.driverVersion}`);
			if (gpu.computeCap !== "") identity.push(`compute ${gpu.computeCap}`);
			if (identity.length > 0) lines.push(sub("device", identity.join(" \u00b7 ")));
			const load: string[] = [];
			if (gpu.utilizationPct !== undefined) load.push(`${Math.round(gpu.utilizationPct)}% util`);
			if (gpu.temperatureC !== undefined) load.push(`${Math.round(gpu.temperatureC)}\u00b0C`);
			if (load.length > 0) lines.push(sub("load", load.join(" \u00b7 ")));
		});
	}

	section("runtime");
	lines.push(entry("bun", info.runtime.bun));
	lines.push(entry("node api", info.runtime.nodeApi));

	section("engine");
	lines.push(entry("bin dir", info.engine.binDir));
	if (info.engine.resolvedBuild !== undefined) lines.push(entry("build", info.engine.resolvedBuild));
	if (info.engine.serverVersion !== undefined) lines.push(entry("server", info.engine.serverVersion));
	lines.push(
		entry("endpoint", `${info.engine.endpoint} ${info.engine.running ? green("reachable") : red("unreachable")}`),
	);
	lines.push(entry("models dir", info.engine.modelsDir));
	const weights = info.engine.weights;
	if (weights.length === 0) {
		lines.push(entry("weights", dim("none found")));
	} else {
		lines.push(entry("weights", `${weights.length} file${weights.length === 1 ? "" : "s"}`));
		for (const weight of weights) lines.push(sub(formatSize(weight.bytes), weight.file));
	}

	return lines.map((line) => truncateLine(line, cols));
}
