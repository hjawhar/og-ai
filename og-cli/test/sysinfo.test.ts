/**
 * `/stats` has two hard contracts: collection never fails on a machine that is
 * missing a probe, and rendering never emits a line wider than the terminal
 * (the caller pins these lines, so an overflow corrupts the whole frame).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "../src/config/load.ts";
import type { OgConfig } from "../src/config/schema.ts";
import { setColor, visibleWidth } from "../src/ui/render.ts";
import { collectSystemInfo, renderSystemInfo, type GpuInfo, type SystemInfo } from "../src/ui/sysinfo.ts";

const WIDTHS = [20, 40, 80, 120, 200] as const;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "og-sysinfo-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	setColor(false);
});

afterEach(() => {
	setColor(false);
});

afterAll(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const GPU: GpuInfo = {
	name: "NVIDIA GeForce RTX 5070 Ti",
	memoryTotalMiB: 16303,
	memoryUsedMiB: 6512,
	driverVersion: "610.88",
	computeCap: "12.0",
	utilizationPct: 37,
	temperatureC: 44,
};

/** Fully-populated fixture; each test replaces only the branch it exercises. */
function makeInfo(patch: Partial<SystemInfo> = {}): SystemInfo {
	return {
		os: { platform: "win32", release: "10.0.26200", arch: "x64", hostname: "workstation" },
		cpu: {
			model: "AMD Ryzen 7 9800X3D 8-Core Processor",
			physicalCores: 8,
			logicalCores: 16,
			speedMHz: 4700,
		},
		memory: { totalBytes: 64 * GIB, freeBytes: 24 * GIB },
		gpus: [GPU],
		runtime: { bun: "1.3.14", nodeApi: "24.3.0" },
		engine: {
			binDir: "C:\\Users\\someone\\.local\\llama.cpp\\current",
			resolvedBuild: "b10488",
			serverVersion: "version: 0.1.2-dev (build 10488, commit 9d77fa172)",
			endpoint: "http://127.0.0.1:8127",
			running: true,
			modelsDir: "C:\\Users\\someone\\models",
			weights: [{ file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf", bytes: 17_716_740_096 }],
		},
		uptimeSec: 11_530,
		...patch,
	};
}

describe("renderSystemInfo width guarantee", () => {
	for (const colour of [false, true]) {
		for (const width of WIDTHS) {
			test(`fits ${width} columns with colour ${colour ? "on" : "off"}`, () => {
				setColor(colour);
				// Values chosen to be longer than the narrow widths on purpose.
				const info = makeInfo({
					gpus: [GPU, { ...GPU, name: "NVIDIA GeForce RTX 4090 Laptop GPU", memoryUsedMiB: 15_998 }],
					engine: {
						...makeInfo().engine,
						binDir: `C:\\${"deep\\".repeat(30)}llama.cpp\\current`,
						weights: [
							{ file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf", bytes: 17_716_740_096 },
							{ file: `${"x".repeat(300)}.gguf`, bytes: 512 * MIB },
						],
					},
				});
				const lines = renderSystemInfo(info, width);
				expect(lines.length).toBeGreaterThan(10);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(line.endsWith("\n")).toBe(false);
				}
				// Colour on must actually still be colour, not silently stripped.
				if (colour) expect(lines.join("\n")).toContain("\u001b[");
			});
		}
	}

	test("clamps absurd widths instead of throwing", () => {
		for (const width of [20, 5, 1, 0, -40, Number.NaN, Number.POSITIVE_INFINITY]) {
			const lines = renderSystemInfo(makeInfo(), width);
			expect(lines.length).toBeGreaterThan(10);
			// Everything below the 20-column floor is clamped up to it, never wider.
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(20, width || 0));
		}
	});
});

describe("renderSystemInfo content", () => {
	test("labels every section", () => {
		const lines = renderSystemInfo(makeInfo(), 200);
		const text = lines.join("\n");
		// Colour is off here, so a heading is its own bare line.
		for (const heading of ["host", "cpu", "memory", "gpu", "runtime", "engine"]) {
			expect(lines).toContain(heading);
		}
		expect(text).toContain("b10488");
		expect(text).toContain("version: 0.1.2-dev (build 10488, commit 9d77fa172)");
		expect(text).toContain("http://127.0.0.1:8127");
		expect(text).toContain("reachable");
		expect(text).toContain("8 physical");
		expect(text).toContain("16 logical");
		expect(text).toContain("Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf");
		expect(text).toContain("16.5 GiB");
	});

	test("says so when there is no NVIDIA GPU, rather than rendering an empty section", () => {
		const lines = renderSystemInfo(makeInfo({ gpus: [] }), 80);
		const text = lines.join("\n");
		expect(text).toContain("no NVIDIA GPU detected");
		expect(text).not.toContain("vram");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	test("renders full and empty VRAM without lying about either", () => {
		const full = renderSystemInfo(
			makeInfo({ gpus: [{ ...GPU, memoryUsedMiB: 16_303, memoryTotalMiB: 16_303 }] }),
			100,
		).join("\n");
		expect(full).toContain("100% 16303 / 16303 MiB");

		const empty = renderSystemInfo(
			makeInfo({ gpus: [{ ...GPU, memoryUsedMiB: 0, memoryTotalMiB: 16_303 }] }),
			100,
		).join("\n");
		expect(empty).toContain("0% 0 / 16303 MiB");
		expect(empty).not.toContain("100%");
	});

	test("survives a GPU that reports a zero or nonsense VRAM total", () => {
		const text = renderSystemInfo(
			makeInfo({
				gpus: [
					{ ...GPU, memoryUsedMiB: 0, memoryTotalMiB: 0 },
					{ ...GPU, memoryUsedMiB: Number.NaN, memoryTotalMiB: Number.NaN },
				],
			}),
			100,
		).join("\n");
		expect(text).toContain("0% 0 / 0 MiB");
		expect(text).not.toContain("NaN");
		expect(text).not.toContain("Infinity");
	});

	test("omits absent optional fields instead of leaking undefined", () => {
		const bare: SystemInfo = {
			os: { platform: "linux", release: "", arch: "", hostname: "" },
			cpu: { model: "", logicalCores: 1, speedMHz: 0 },
			memory: { totalBytes: 0, freeBytes: 0 },
			gpus: [
				{
					name: "Tesla T4",
					memoryTotalMiB: 15_360,
					memoryUsedMiB: 1_024,
					driverVersion: "",
					computeCap: "",
				},
			],
			runtime: { bun: "1.3.14", nodeApi: "24.3.0" },
			engine: {
				binDir: "/opt/llama.cpp",
				endpoint: "http://10.0.0.4:8127",
				running: false,
				modelsDir: "/srv/models",
				weights: [],
			},
			uptimeSec: 0,
		};
		const lines = renderSystemInfo(bare, 80);
		const text = lines.join("\n");
		expect(text).not.toContain("undefined");
		expect(text).not.toContain("NaN");
		// Missing physical core count degrades to the logical count alone.
		expect(text).toContain("1 logical");
		expect(text).not.toContain("physical");
		// No driver/compute/util/temp reported: those rows disappear entirely.
		expect(text).not.toContain("driver");
		expect(text).not.toContain("util");
		expect(text).not.toContain("build");
		expect(text).not.toContain("server");
		expect(text).toContain("unreachable");
		expect(text).toContain("none found");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	test("formats sizes at the unit boundaries", () => {
		const sizes: [number, string][] = [
			[0, "0 B"],
			[1023, "1023 B"],
			[1024, "1.0 KiB"],
			[MIB - 1, "1.0 MiB"],
			[MIB, "1.0 MiB"],
			[1536 * 1024, "1.5 MiB"],
			[GIB - 1, "1.0 GiB"],
			[GIB, "1.0 GiB"],
			[17_716_740_096, "16.5 GiB"],
			[-1, "?"],
		];
		for (const [bytes, expected] of sizes) {
			// The size is the aligned label of the weights row, so padding is collapsed.
			const text = renderSystemInfo(
				makeInfo({
					engine: { ...makeInfo().engine, weights: [{ file: "w.gguf", bytes }] },
				}),
				100,
			)
				.join("\n")
				.replace(/[ \t]+/g, " ");
			expect(text).toContain(`${expected} w.gguf`);
		}
		// Memory uses the same scale, and a bogus free figure cannot exceed installed.
		const mem = renderSystemInfo(
			makeInfo({ memory: { totalBytes: 64 * GIB, freeBytes: 999 * GIB } }),
			100,
		).join("\n");
		expect(mem).toContain("64.0 GiB");
		expect(mem).toContain("0%");
	});
});

describe("collectSystemInfo", () => {
	test("describes this machine without throwing", async () => {
		const info = await collectSystemInfo({ config: DEFAULT_CONFIG, engineRunning: false });
		expect(info.cpu.logicalCores).toBeGreaterThanOrEqual(1);
		expect(info.memory.totalBytes).toBeGreaterThan(0);
		expect(info.os.platform.length).toBeGreaterThan(0);
		expect(info.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(info.runtime.bun.length).toBeGreaterThan(0);
		expect(info.runtime.nodeApi.length).toBeGreaterThan(0);
		expect(info.engine.running).toBe(false);
		expect(info.engine.endpoint).toBe(DEFAULT_CONFIG.endpoint);
		// Either no NVIDIA stack at all, or every reported card has real VRAM.
		for (const gpu of info.gpus) {
			expect(gpu.memoryTotalMiB).toBeGreaterThan(0);
			expect(gpu.memoryUsedMiB).toBeGreaterThanOrEqual(0);
			expect(gpu.name.length).toBeGreaterThan(0);
		}
		if (info.cpu.physicalCores !== undefined) {
			expect(info.cpu.physicalCores).toBeGreaterThanOrEqual(1);
			expect(info.cpu.physicalCores).toBeLessThanOrEqual(info.cpu.logicalCores);
		}
		// Whatever came back must render at a real terminal width.
		for (const line of renderSystemInfo(info, 100)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	}, 20_000);

	test("lists only top-level gguf weights, largest first", async () => {
		const modelsDir = tempDir();
		fs.writeFileSync(path.join(modelsDir, "small.gguf"), Buffer.alloc(2048));
		fs.writeFileSync(path.join(modelsDir, "big.gguf"), Buffer.alloc(8192));
		fs.writeFileSync(path.join(modelsDir, "notes.txt"), "not a model");
		fs.mkdirSync(path.join(modelsDir, "nested"));
		fs.writeFileSync(path.join(modelsDir, "nested", "hidden.gguf"), Buffer.alloc(4096));

		const config: OgConfig = {
			...DEFAULT_CONFIG,
			engine: { ...DEFAULT_CONFIG.engine, modelsDir, binDir: path.join(modelsDir, "no-such-bin") },
		};
		const info = await collectSystemInfo({ config, engineRunning: true });
		expect(info.engine.weights).toEqual([
			{ file: "big.gguf", bytes: 8192 },
			{ file: "small.gguf", bytes: 2048 },
		]);
		// An absent binDir is a missing probe, not an error: both fields drop out.
		expect(info.engine.resolvedBuild).toBeUndefined();
		expect(info.engine.serverVersion).toBeUndefined();
		expect(info.engine.running).toBe(true);
	}, 20_000);

	test("treats a missing models directory as no weights", async () => {
		const config: OgConfig = {
			...DEFAULT_CONFIG,
			engine: {
				...DEFAULT_CONFIG.engine,
				modelsDir: path.join(tempDir(), "definitely-absent"),
				binDir: path.join(tempDir(), "definitely-absent"),
			},
		};
		const info = await collectSystemInfo({ config, engineRunning: false });
		expect(info.engine.weights).toEqual([]);
		expect(renderSystemInfo(info, 80).join("\n")).toContain("none found");
	}, 20_000);
});
