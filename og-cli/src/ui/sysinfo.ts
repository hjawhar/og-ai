/**
 * Machine and runtime introspection, backing `/stats`.
 *
 * Collection is deliberately split from rendering: `collectSystemInfo` is the
 * only part that touches the OS or spawns a probe, and every probe is best
 * effort — a core-count query that is absent, refused or slow yields an omitted
 * optional field, never a rejected promise. That way `/stats` still reports
 * what it *can* see on a locked-down machine.
 *
 * Nothing here speaks to the endpoint: the inference server lives on the far
 * side of HTTP, in another process this CLI does not own. The endpoint block
 * therefore reports what the client is configured to send, not what a server
 * answered.
 *
 * `renderSystemInfo` is pure and total: same input, same lines, and every line
 * fits the requested width so the caller can drop them straight into a pinned
 * region without re-measuring.
 */

import fs from "node:fs";
import os from "node:os";

import { endpointOf, modelSpecOf, wireModelOf } from "../config/load.ts";
import type { OgConfig } from "../config/schema.ts";
import { bold, dim, elapsed, formatBytes, progressBar, truncateLine } from "./render.ts";

export interface SystemInfo {
	os: { platform: string; release: string; arch: string; hostname: string };
	cpu: { model: string; physicalCores?: number; logicalCores: number; speedMHz: number };
	memory: { totalBytes: number; freeBytes: number };
	runtime: { bun: string; nodeApi: string };
	/** Where chat requests go and under what name; configuration, not a probe. */
	endpoint: { url: string; model: string; contextWindow: number };
	uptimeSec: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** Probe timeout. A core-count query answers in milliseconds; a hang is a broken machine. */
const PROBE_TIMEOUT_MS = 5_000;

interface Capture {
	/** stdout and stderr concatenated: probes are not consistent about which one they answer on. */
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

export async function collectSystemInfo(config: OgConfig): Promise<SystemInfo> {
	const cpus = os.cpus();
	const first = cpus[0];
	const physicalCores = await readPhysicalCores();
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
		runtime: { bun: Bun.version, nodeApi: process.versions.node },
		endpoint: {
			url: endpointOf(config),
			model: wireModelOf(config),
			contextWindow: modelSpecOf(config).contextWindow,
		},
		uptimeSec: Math.max(0, Math.round(os.uptime())),
	};
}

/**
 * GiB/MiB with one decimal, the resolution people compare memory at. The unit
 * is chosen from the *rounded* value, so a hair under a gibibyte reads as
 * `1.0 GiB` rather than the self-contradicting `1024.0 MiB`. Sub-mebibyte
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

/** `  label      value`; one indent, one value column, every section. */
function entry(label: string, value: string): string {
	return `  ${dim(label.padEnd(LABEL_WIDTH))} ${value}`;
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

	section("runtime");
	lines.push(entry("bun", info.runtime.bun));
	lines.push(entry("node api", info.runtime.nodeApi));

	section("endpoint");
	lines.push(entry("url", info.endpoint.url));
	lines.push(entry("model", info.endpoint.model));
	lines.push(entry("context", `${info.endpoint.contextWindow} tok`));

	return lines.map((line) => truncateLine(line, cols));
}
