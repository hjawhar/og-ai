/**
 * `/stats` has two hard contracts: collection never fails on a machine that is
 * missing a probe, and rendering never emits a line wider than the terminal
 * (the caller pins these lines, so an overflow corrupts the whole frame).
 *
 * A third one is new and just as load-bearing: /stats describes this machine and
 * this client's configuration. The inference server is another process on the
 * far side of HTTP, so nothing here may claim to know its build, its weights or
 * its VRAM — reporting a number og cannot observe is worse than omitting it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/load.ts";
import type { OgConfig } from "../src/config/schema.ts";
import { setColor, visibleWidth } from "../src/ui/render.ts";
import { collectSystemInfo, renderSystemInfo, type SystemInfo } from "../src/ui/sysinfo.ts";

const WIDTHS = [20, 40, 80, 120, 200] as const;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

beforeEach(() => {
	setColor(false);
});

afterEach(() => {
	setColor(false);
});

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
		runtime: { bun: "1.3.14", nodeApi: "24.3.0" },
		endpoint: { url: "http://127.0.0.1:8127", model: "qwen3-coder-30b", contextWindow: 32768 },
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
					cpu: { model: `Vendor ${"Very".repeat(40)} CPU`, logicalCores: 256, speedMHz: 4700 },
					endpoint: {
						url: `https://gateway.example.com/${"deep/".repeat(60)}v1`,
						model: `org/${"x".repeat(300)}-instruct`,
						contextWindow: 1_048_576,
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
		for (const heading of ["host", "cpu", "memory", "runtime", "endpoint"]) {
			expect(lines).toContain(heading);
		}
		expect(text).toContain("win32 10.0.26200 (x64)");
		expect(text).toContain("workstation");
		expect(text).toContain("8 physical");
		expect(text).toContain("16 logical");
		expect(text).toContain("4700 MHz");
		expect(text).toContain("1.3.14");
		expect(text).toContain("24.3.0");
	});

	test("reports where requests go, under what name, and with what budget", () => {
		const text = renderSystemInfo(
			makeInfo({
				endpoint: {
					url: "https://openrouter.ai/api/v1",
					model: "qwen/qwen3-coder-30b-a3b-instruct",
					contextWindow: 65536,
				},
			}),
			200,
		).join("\n");

		expect(text).toContain("https://openrouter.ai/api/v1");
		// The wire name, not the config key: that is what the server was asked for.
		expect(text).toContain("qwen/qwen3-coder-30b-a3b-instruct");
		expect(text).toContain("65536 tok");
	});

	test("claims nothing about the server it cannot observe", () => {
		// og no longer starts, inspects or measures an inference server, so every
		// figure that used to come from one is gone rather than stale.
		const text = renderSystemInfo(makeInfo(), 200).join("\n").toLowerCase();
		for (const forbidden of [
			"gpu",
			"vram",
			"nvidia",
			"gguf",
			"weights",
			"bin dir",
			"models dir",
			"reachable",
			"unreachable",
			"llama",
			"build",
		]) {
			expect(text, forbidden).not.toContain(forbidden);
		}
		// And the shape itself carries no room for them.
		expect(Object.keys(makeInfo()).sort()).toEqual([
			"cpu",
			"endpoint",
			"memory",
			"os",
			"runtime",
			"uptimeSec",
		]);
	});

	test("omits absent optional fields instead of leaking undefined", () => {
		const bare: SystemInfo = {
			os: { platform: "linux", release: "", arch: "", hostname: "" },
			cpu: { model: "", logicalCores: 1, speedMHz: 0 },
			memory: { totalBytes: 0, freeBytes: 0 },
			runtime: { bun: "1.3.14", nodeApi: "24.3.0" },
			endpoint: { url: "http://10.0.0.4:8127", model: "devstral-24b", contextWindow: 8192 },
			uptimeSec: 0,
		};
		const lines = renderSystemInfo(bare, 80);
		const text = lines.join("\n");
		expect(text).not.toContain("undefined");
		expect(text).not.toContain("NaN");
		// Missing physical core count degrades to the logical count alone.
		expect(text).toContain("1 logical");
		expect(text).not.toContain("physical");
		// An unreported clock is a missing probe, so that row disappears entirely.
		expect(text).not.toContain("MHz");
		expect(text).not.toContain("hostname");
		expect(text).toContain("unknown");
		// The endpoint block never degrades: it is configuration, always present.
		expect(text).toContain("http://10.0.0.4:8127");
		expect(text).toContain("8192 tok");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	test("formats memory at the unit boundaries", () => {
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
		for (const [totalBytes, expected] of sizes) {
			const text = renderSystemInfo(makeInfo({ memory: { totalBytes, freeBytes: 0 } }), 100)
				.join("\n")
				.replace(/[ \t]+/g, " ");
			expect(text, String(totalBytes)).toContain(`installed ${expected}`);
		}
	});

	test("a free figure larger than installed cannot read as negative use", () => {
		const text = renderSystemInfo(
			makeInfo({ memory: { totalBytes: 64 * GIB, freeBytes: 999 * GIB } }),
			100,
		).join("\n");
		expect(text).toContain("64.0 GiB");
		expect(text).toContain("0%");
		// A signed byte figure would mean the clamp let used bytes go negative. Scoped
		// to the memory block: model names legitimately contain "-30b"-shaped text.
		const inUse = text.split("\n").find((line) => line.includes("in use")) ?? "";
		expect(inUse).not.toMatch(/-\d/);
	});

	test("a fully used machine reads as 100%, and an idle one as 0%", () => {
		const full = renderSystemInfo(
			makeInfo({ memory: { totalBytes: 64 * GIB, freeBytes: 0 } }),
			100,
		).join("\n");
		expect(full).toContain("100%");

		const idle = renderSystemInfo(
			makeInfo({ memory: { totalBytes: 64 * GIB, freeBytes: 64 * GIB } }),
			100,
		).join("\n");
		expect(idle).toContain("0%");
		expect(idle).not.toContain("100%");
	});
});

describe("collectSystemInfo", () => {
	test("describes this machine without throwing", async () => {
		const info = await collectSystemInfo(DEFAULT_CONFIG);
		expect(info.cpu.logicalCores).toBeGreaterThanOrEqual(1);
		expect(info.memory.totalBytes).toBeGreaterThan(0);
		expect(info.os.platform.length).toBeGreaterThan(0);
		expect(info.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(info.runtime.bun.length).toBeGreaterThan(0);
		expect(info.runtime.nodeApi.length).toBeGreaterThan(0);
		if (info.cpu.physicalCores !== undefined) {
			expect(info.cpu.physicalCores).toBeGreaterThanOrEqual(1);
			expect(info.cpu.physicalCores).toBeLessThanOrEqual(info.cpu.logicalCores);
		}
		// Whatever came back must render at a real terminal width.
		for (const line of renderSystemInfo(info, 100)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	}, 20_000);

	test("the endpoint block is read from config, with no network at all", async () => {
		// A port nothing is listening on: collection must not care. The entry is
		// declared here because og ships none — it discovers them.
		const config: OgConfig = {
			...DEFAULT_CONFIG,
			endpoint: "http://127.0.0.1:1",
			model: "local-model",
			models: { "local-model": { contextWindow: 65536 } },
		};
		const info = await collectSystemInfo(config);
		expect(info.endpoint).toEqual({
			url: "http://127.0.0.1:1",
			model: "local-model",
			contextWindow: 65536,
		});
	}, 20_000);

	test("a per-model endpoint and wire id are what /stats reports", async () => {
		const config: OgConfig = {
			...DEFAULT_CONFIG,
			endpoint: "http://127.0.0.1:8127",
			model: "hosted",
			models: {
				hosted: {
					id: "deepseek-chat",
					endpoint: "https://api.deepseek.com",
					contextWindow: 131_072,
				},
			},
		};
		const info = await collectSystemInfo(config);
		expect(info.endpoint).toEqual({
			url: "https://api.deepseek.com",
			model: "deepseek-chat",
			contextWindow: 131_072,
		});
	}, 20_000);
});
