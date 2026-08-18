/**
 * llama-server argv is the real contract with the engine: a silently dropped or
 * reordered flag does not fail loudly, it costs ~8x throughput (VRAM spill) or
 * silently disables native tool calls. These tests pin flag/value adjacency for
 * the measured profiles, plus the model-path resolution rules.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "../src/config/load.ts";
import { ConfigError, type OgConfig, type ModelProfile } from "../src/config/schema.ts";
import { buildServerArgs, resolveModelPath } from "../src/engine/args.ts";

const GGUFS = [
	"Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
	"Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf",
	"Devstral-Small-2507-Q4_K_M.gguf",
];

let root = "";
let modelsDir = "";

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "og-args-"));
	modelsDir = path.join(root, "models");
	fs.mkdirSync(modelsDir, { recursive: true });
	for (const name of GGUFS) fs.writeFileSync(path.join(modelsDir, name), "GGUF");
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Fresh config per test so mutations never leak between cases. */
function cfgWith(mutate?: (cfg: OgConfig) => void): OgConfig {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.engine.modelsDir = modelsDir;
	mutate?.(cfg);
	return cfg;
}

function profileOrThrow(cfg: OgConfig, key: string): ModelProfile {
	const profile = cfg.profiles[key];
	if (!profile) throw new Error(`test fixture is missing profile ${key}`);
	return profile;
}

/** Value immediately following `flag` — asserts adjacency, not mere membership. */
function valueOf(args: readonly string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	return at === -1 ? undefined : args[at + 1];
}

describe("buildServerArgs", () => {
	test("default profile carries the measured VRAM-safe flag set", () => {
		const cfg = cfgWith();
		const args = buildServerArgs(cfg, "qwen3-coder-30b");

		expect(valueOf(args, "-m")).toBe(path.join(modelsDir, GGUFS[0] as string));
		expect(valueOf(args, "--alias")).toBe("qwen3-coder-30b");
		expect(valueOf(args, "-ngl")).toBe("99");
		expect(valueOf(args, "--n-cpu-moe")).toBe("14");
		expect(valueOf(args, "-c")).toBe("32768");
		expect(valueOf(args, "--cache-type-k")).toBe("q8_0");
		expect(valueOf(args, "--cache-type-v")).toBe("q8_0");
		expect(valueOf(args, "--flash-attn")).toBe("on");
		expect(args).toContain("--jinja");
		expect(valueOf(args, "--host")).toBe("127.0.0.1");
		expect(valueOf(args, "--port")).toBe("8127");

		// Each flag appears once: a duplicate would let the last one win silently.
		for (const flag of ["-m", "--alias", "-ngl", "--n-cpu-moe", "-c", "--flash-attn", "--jinja"]) {
			expect(args.filter((arg) => arg === flag).length).toBe(1);
		}
	});

	test("host and port come from engine config, not hardcoded", () => {
		const cfg = cfgWith((c) => {
			c.engine.host = "0.0.0.0";
			c.engine.port = 9191;
		});
		const args = buildServerArgs(cfg, "qwen3-coder-30b");
		expect(valueOf(args, "--host")).toBe("0.0.0.0");
		expect(valueOf(args, "--port")).toBe("9191");
	});

	test("long profile keeps 64k context with its measured expert split", () => {
		const args = buildServerArgs(cfgWith(), "qwen3-coder-30b-long");
		expect(valueOf(args, "-c")).toBe("65536");
		expect(valueOf(args, "--n-cpu-moe")).toBe("18");
		expect(valueOf(args, "--alias")).toBe("qwen3-coder-30b-long");
	});

	test("fast profile points at the Q3 weights", () => {
		const args = buildServerArgs(cfgWith(), "qwen3-coder-30b-fast");
		expect(valueOf(args, "-m")).toBe(path.join(modelsDir, GGUFS[1] as string));
		expect(valueOf(args, "--n-cpu-moe")).toBe("4");
	});

	test("dense profile omits --n-cpu-moe entirely", () => {
		const args = buildServerArgs(cfgWith(), "devstral-24b");
		expect(args).not.toContain("--n-cpu-moe");
		expect(valueOf(args, "-ngl")).toBe("99");
		expect(valueOf(args, "-c")).toBe("8192");
	});

	test("flashAttn false emits --flash-attn off", () => {
		const cfg = cfgWith((c) => {
			profileOrThrow(c, "qwen3-coder-30b").flashAttn = false;
		});
		expect(valueOf(buildServerArgs(cfg, "qwen3-coder-30b"), "--flash-attn")).toBe("off");
	});

	test("omitted sampling knobs emit no flag at all", () => {
		const cfg = cfgWith((c) => {
			const profile = profileOrThrow(c, "qwen3-coder-30b");
			delete profile.topK;
			delete profile.minP;
		});
		const args = buildServerArgs(cfg, "qwen3-coder-30b");
		expect(args).not.toContain("--top-k");
		expect(args).not.toContain("--min-p");
		expect(valueOf(args, "--temp")).toBe("0.7");
		expect(valueOf(args, "--top-p")).toBe("0.8");
	});

	test("extraArgs are appended last so they can override earlier flags", () => {
		const cfg = cfgWith((c) => {
			profileOrThrow(c, "qwen3-coder-30b").extraArgs = ["--override-kv", "tokenizer.ggml.eos=int:1"];
		});
		const args = buildServerArgs(cfg, "qwen3-coder-30b");
		expect(args.slice(-2)).toEqual(["--override-kv", "tokenizer.ggml.eos=int:1"]);
	});

	test("argv is deterministic across calls", () => {
		const cfg = cfgWith();
		expect(buildServerArgs(cfg, "qwen3-coder-30b")).toEqual(buildServerArgs(cfg, "qwen3-coder-30b"));
	});

	test("unknown profile key is rejected before any argv is built", () => {
		expect(() => buildServerArgs(cfgWith(), "ghost-model")).toThrow(ConfigError);
	});
});

describe("resolveModelPath", () => {
	test("absolute profile.file is used as-is", () => {
		const elsewhere = path.join(root, "elsewhere");
		fs.mkdirSync(elsewhere, { recursive: true });
		const abs = path.join(elsewhere, "Custom-Model-Q5_K_M.gguf");
		fs.writeFileSync(abs, "GGUF");

		const cfg = cfgWith((c) => {
			profileOrThrow(c, "qwen3-coder-30b").file = abs;
		});
		expect(resolveModelPath(cfg, "qwen3-coder-30b")).toBe(abs);
	});

	test("relative profile.file is joined to engine.modelsDir", () => {
		expect(resolveModelPath(cfgWith(), "devstral-24b")).toBe(path.join(modelsDir, GGUFS[2] as string));
	});

	test("missing weights throw ConfigError listing the GGUFs actually present", () => {
		const cfg = cfgWith((c) => {
			profileOrThrow(c, "qwen3-coder-30b").file = "Typo-In-The-Filename.gguf";
		});

		let err: unknown;
		try {
			resolveModelPath(cfg, "qwen3-coder-30b");
		} catch (caught) {
			err = caught;
		}
		expect(err).toBeInstanceOf(ConfigError);
		const message = (err as Error).message;
		expect(message).toContain("Typo-In-The-Filename.gguf");
		for (const name of GGUFS) expect(message).toContain(name);
	});

	test("empty models directory reports that no GGUFs were found", () => {
		const emptyDir = path.join(root, "empty-models");
		fs.mkdirSync(emptyDir, { recursive: true });
		const cfg = cfgWith((c) => {
			c.engine.modelsDir = emptyDir;
		});
		expect(() => resolveModelPath(cfg, "qwen3-coder-30b")).toThrow(/No \.gguf files found/);
	});
});
