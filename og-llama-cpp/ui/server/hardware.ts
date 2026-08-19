/**
 * What this machine is, what engine is installed, and what is currently serving.
 * All three probes are best-effort by design: a missing GPU, a missing engine and
 * a dead port are all valid states the page has to render, not errors.
 */
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { computePeak } from "./compute.ts";
import type { Gpu } from "./fit.ts";

const WIN = process.platform === "win32";
const MIB = 1024 * 1024;

export interface Hardware {
	os: string;
	hostname: string;
	cpu: string;
	threads: number;
	ramTotalMiB: number;
	ramFreeMiB: number;
	gpus: Gpu[];
	headroomMiB: number;
	budgetMiB: number;
}

export interface EngineInfo {
	root: string;
	binary: string;
	present: boolean;
	build?: string;
	version?: string;
	/** Accelerators the installed binary itself reports, e.g. "CUDA0: …". */
	devices: string[];
}

export interface ServedModel {
	id: string;
	nCtx?: number;
}

export async function readGpus(): Promise<Gpu[]> {
	// compute_cap selects the per-SM tensor rates; the name selects SM count and
	// boost clock. nvidia-smi reports neither of the latter two directly.
	const text = await capture([
		"nvidia-smi",
		"--query-gpu=index,name,memory.total,memory.used,memory.free,compute_cap",
		"--format=csv,noheader,nounits",
	]);
	const gpus: Gpu[] = [];
	for (const line of text.trim().split("\n")) {
		const parts = line.split(",").map((part) => part.trim());
		if (parts.length < 6) continue;
		const index = Number.parseInt(parts[0] ?? "", 10);
		const total = Number.parseInt(parts[2] ?? "", 10);
		if (!Number.isFinite(index) || !Number.isFinite(total)) continue;
		const name = parts[1] ?? "unknown";
		const peak = computePeak(name, parts[5] ?? "");
		gpus.push({
			index,
			name,
			totalMiB: total,
			usedMiB: Number.parseInt(parts[3] ?? "0", 10),
			freeMiB: Number.parseInt(parts[4] ?? "0", 10),
			// exactOptionalPropertyTypes: an unknown card omits the field entirely.
			...(peak === undefined ? {} : { peak }),
		});
	}
	return gpus;
}

export function hardwareOf(gpus: Gpu[], headroomMiB: number): Hardware {
	const gpu = gpus[0];
	return {
		os: `${process.platform} ${os.release()} (${process.arch})`,
		hostname: os.hostname(),
		cpu: os.cpus()[0]?.model.trim() ?? "unknown",
		threads: os.cpus().length,
		ramTotalMiB: os.totalmem() / MIB,
		ramFreeMiB: os.freemem() / MIB,
		gpus,
		headroomMiB,
		budgetMiB: gpu === undefined ? 0 : Math.max(0, gpu.totalMiB - headroomMiB),
	};
}

/**
 * The installed engine, cached for the process: `--version` and `--list-devices`
 * each cost a process spawn, and neither answer changes without a reinstall.
 * A CPU-only build is the install failure worth surfacing — it loads the same
 * weights and runs ~100x slower rather than failing.
 */
let cached: EngineInfo | undefined;

export async function readEngine(root: string): Promise<EngineInfo> {
	if (cached !== undefined) return cached;
	const binary = path.join(root, "current", WIN ? "llama-server.exe" : "llama-server");
	const info: EngineInfo = { root, binary, present: existsSync(binary), devices: [] };
	if (info.present) {
		try {
			info.build = path.basename(realpathSync(path.join(root, "current")));
		} catch {
			// `current` missing or dangling: the binary path above is still the truth.
		}
		const version = (await capture([binary, "--version"])).split("\n").find((line) => line.includes("version"));
		if (version !== undefined) info.version = version.trim();
		for (const line of (await capture([binary, "--list-devices"])).split("\n")) {
			const trimmed = line.trim();
			if (/^(CUDA|Vulkan|SYCL|Metal|ROCm|HIP)\d*:/.test(trimmed)) info.devices.push(trimmed);
		}
	}
	cached = info;
	return info;
}

/**
 * What is serving on `port`, from the server's own `/v1/models`. llama.cpp
 * reports the `--alias` as the model id and the KV cache it actually allocated as
 * `meta.n_ctx`, which is the only honest source for "what am I talking to".
 */
export async function probeServer(port: number): Promise<{ reachable: boolean; models: ServedModel[] }> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return { reachable: true, models: [] };
		const body: unknown = await res.json();
		const data = isRecord(body) ? body["data"] : undefined;
		if (!Array.isArray(data)) return { reachable: true, models: [] };
		const models: ServedModel[] = [];
		for (const item of data) {
			if (!isRecord(item)) continue;
			const id = item["id"];
			if (typeof id !== "string") continue;
			const meta = isRecord(item["meta"]) ? item["meta"] : undefined;
			const nCtx = meta !== undefined && typeof meta["n_ctx"] === "number" ? meta["n_ctx"] : undefined;
			models.push(nCtx === undefined ? { id } : { id, nCtx });
		}
		return { reachable: true, models };
	} catch {
		return { reachable: false, models: [] };
	}
}

/** One canonical object guard for this server; fields stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function capture(argv: string[]): Promise<string> {
	try {
		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		await proc.exited;
		return `${out}\n${err}`;
	} catch {
		// Binary absent or not executable: an empty probe, not a crash.
		return "";
	}
}
