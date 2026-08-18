/**
 * Configuration decides which weights load and how much VRAM they take, so a
 * layering bug does not crash — it silently changes model behaviour or spills to
 * host RAM at 1/8th throughput.
 *
 * `src/config/load.ts` captures `os.homedir()` at module load, so the home layer
 * cannot be redirected inside an already-loaded process. Every `loadConfig` case
 * therefore runs in a child `bun` process with HOME/USERPROFILE pointed at a
 * temp directory: the home layer is real, deterministic, and the developer's own
 * ~/.og/config.json can never influence the result.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "../src/config/load.ts";
import type { OgConfig, ModelProfile } from "../src/config/schema.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LOAD_MODULE = path.join(REPO_ROOT, "src", "config", "load.ts");
const SCHEMA_MODULE = path.join(REPO_ROOT, "src", "config", "schema.ts");
const MARKER = "##ACE##";

const CHILD_SCRIPT = `import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
// Dynamic: the module path arrives in the spec, and it must not load until this
// process has already been started with a redirected home directory.
const load = await import(pathToFileURL(spec.loadModule).href);
const schema = await import(pathToFileURL(spec.schemaModule).href);

const before = JSON.stringify(load.DEFAULT_CONFIG);
const out = { ok: false, homedir: os.homedir() };
try {
	const cfg = load.loadConfig({
		workspaceRoot: spec.workspaceRoot,
		...(spec.overrides ? { overrides: spec.overrides } : {}),
	});
	out.config = cfg;
	if (spec.profileKey !== undefined) out.profile = load.profileOf(cfg, spec.profileKey);
	out.ok = true;
} catch (err) {
	out.name = err instanceof Error ? err.name : typeof err;
	out.message = err instanceof Error ? err.message : String(err);
	out.isConfigError = err instanceof schema.ConfigError;
}
out.defaultsUnchanged = before === JSON.stringify(load.DEFAULT_CONFIG);
console.log(${JSON.stringify(MARKER)} + JSON.stringify(out));
`;

interface CaseResult {
	ok: boolean;
	homedir: string;
	defaultsUnchanged: boolean;
	config?: OgConfig;
	profile?: ModelProfile;
	name?: string;
	message?: string;
	isConfigError?: boolean;
}

interface CaseSpec {
	/** Contents of `<home>/.og/config.json`; a string is written verbatim. */
	home?: unknown;
	/** Contents of `<workspace>/.og/config.json`; a string is written verbatim. */
	ws?: unknown;
	env?: Record<string, string>;
	overrides?: Record<string, unknown>;
	profileKey?: string;
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	roots.length = 0;
});

function writeLayer(dir: string, contents: unknown): void {
	fs.mkdirSync(path.join(dir, ".og"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".og", "config.json"),
		typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
	);
}

/** Resolves config in a child process whose home directory is a temp dir. */
function resolveConfig(spec: CaseSpec): CaseResult {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "og-config-"));
	roots.push(root);
	const home = path.join(root, "home");
	const workspaceRoot = path.join(root, "workspace");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(workspaceRoot, { recursive: true });
	if (spec.home !== undefined) writeLayer(home, spec.home);
	if (spec.ws !== undefined) writeLayer(workspaceRoot, spec.ws);

	const scriptPath = path.join(root, "resolve.mjs");
	const specPath = path.join(root, "spec.json");
	fs.writeFileSync(scriptPath, CHILD_SCRIPT);
	fs.writeFileSync(
		specPath,
		JSON.stringify({
			loadModule: LOAD_MODULE,
			schemaModule: SCHEMA_MODULE,
			workspaceRoot,
			...(spec.overrides ? { overrides: spec.overrides } : {}),
			...(spec.profileKey !== undefined ? { profileKey: spec.profileKey } : {}),
		}),
	);

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("OG_")) continue;
		env[key] = value;
	}
	env["HOME"] = home;
	env["USERPROFILE"] = home;
	Object.assign(env, spec.env ?? {});

	const proc = Bun.spawnSync([process.execPath, "run", scriptPath, specPath], {
		cwd: REPO_ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = proc.stdout.toString();
	const at = stdout.indexOf(MARKER);
	if (at === -1) {
		throw new Error(`child produced no result\nstdout: ${stdout}\nstderr: ${proc.stderr.toString()}`);
	}
	// The child emits exactly this shape on its single marker line.
	const parsed = JSON.parse(stdout.slice(at + MARKER.length)) as CaseResult;
	expect(parsed.homedir).toBe(home);
	expect(parsed.defaultsUnchanged).toBe(true);
	return parsed;
}

function profileOrThrow(cfg: OgConfig | undefined, key: string): ModelProfile {
	const profile = cfg?.profiles[key];
	if (!profile) throw new Error(`resolved config is missing profile ${key}`);
	return profile;
}

describe("layer precedence", () => {
	test("workspace overrides home overrides defaults, merging disjoint keys", () => {
		const result = resolveConfig({
			home: { endpoint: "http://home.local:8127", agent: { maxSteps: 11 } },
			ws: { endpoint: "http://workspace.local:9000", agent: { temperature: 0.5 } },
		});

		expect(result.ok).toBe(true);
		expect(result.config?.endpoint).toBe("http://workspace.local:9000");
		// Home-only key survives the workspace layer; workspace-only key is applied.
		expect(result.config?.agent.maxSteps).toBe(11);
		expect(result.config?.agent.temperature).toBe(0.5);
		// Untouched defaults remain.
		expect(result.config?.agent.maxTokens).toBe(DEFAULT_CONFIG.agent.maxTokens);
		expect(result.config?.model).toBe("qwen3-coder-30b");
	});

	test("home layer alone is applied when no workspace config exists", () => {
		const result = resolveConfig({ home: { model: "devstral-24b", engine: { port: 8500 } } });
		expect(result.config?.model).toBe("devstral-24b");
		expect(result.config?.engine.port).toBe(8500);
		expect(result.config?.engine.host).toBe(DEFAULT_CONFIG.engine.host);
	});

	test("a profile patch merges per key and leaves sibling profiles intact", () => {
		const result = resolveConfig({
			ws: { profiles: { "qwen3-coder-30b": { nCpuMoe: 12 } } },
		});

		const patched = profileOrThrow(result.config, "qwen3-coder-30b");
		const original = DEFAULT_CONFIG.profiles["qwen3-coder-30b"] as ModelProfile;
		expect(patched).toEqual({ ...original, nCpuMoe: 12 });
		expect(Object.keys(result.config?.profiles ?? {}).sort()).toEqual(
			Object.keys(DEFAULT_CONFIG.profiles).sort(),
		);
	});

	test("arrays replace instead of concatenating", () => {
		const result = resolveConfig({
			home: { tools: { denyPaths: ["**/home-secret/**", "**/*.pem"] } },
			ws: { tools: { denyPaths: ["**/workspace-only/**"] } },
		});
		expect(result.config?.tools.denyPaths).toEqual(["**/workspace-only/**"]);

		const bashDeny = resolveConfig({ ws: { tools: { bash: { denyPatterns: ["^danger"] } } } });
		expect(bashDeny.config?.tools.bash.denyPatterns).toEqual(["^danger"]);
		// Sibling scalars of the replaced array are untouched.
		expect(bashDeny.config?.tools.bash.approval).toBe("unsafe-only");
	});

	test("empty and absent config files are both no-ops", () => {
		const result = resolveConfig({ home: "", ws: "   \n" });
		expect(result.ok).toBe(true);
		expect(result.config?.endpoint).toBe(DEFAULT_CONFIG.endpoint);
	});
});

describe("environment layer", () => {
	test("OG_* variables are applied over file layers", () => {
		const result = resolveConfig({
			ws: { endpoint: "http://file.local:1", model: "qwen3-coder-30b" },
			env: {
				OG_ENDPOINT: "http://env.local:2",
				OG_MODEL: "devstral-24b",
				OG_API_KEY: "env-key",
				OG_STATE_DIR: "C:\\env-state",
				OG_NO_AUTOSTART: "1",
			},
		});

		expect(result.config?.endpoint).toBe("http://env.local:2");
		expect(result.config?.model).toBe("devstral-24b");
		expect(result.config?.apiKey).toBe("env-key");
		expect(result.config?.stateDir).toBe("C:\\env-state");
		expect(result.config?.engine.autoStart).toBe(false);
		// The autostart flag is a nested patch: it must not wipe the rest of `engine`.
		expect(result.config?.engine.port).toBe(DEFAULT_CONFIG.engine.port);
		expect(result.config?.engine.binDir).toBeTruthy();
	});

	test("falsey OG_NO_AUTOSTART values leave autostart enabled", () => {
		for (const value of ["0", "false", "no", "off", ""]) {
			const result = resolveConfig({ env: { OG_NO_AUTOSTART: value } });
			expect(result.config?.engine.autoStart).toBe(true);
		}
	});

	test("explicit overrides beat the environment layer", () => {
		const result = resolveConfig({
			env: { OG_ENDPOINT: "http://env.local:2", OG_MODEL: "devstral-24b" },
			overrides: { endpoint: "http://flag.local:3", model: "qwen3-coder-30b-fast" },
		});
		expect(result.config?.endpoint).toBe("http://flag.local:3");
		expect(result.config?.model).toBe("qwen3-coder-30b-fast");
	});

	test("overrides merge nested objects rather than replacing them", () => {
		const result = resolveConfig({ overrides: { agent: { maxSteps: 3 } } });
		expect(result.config?.agent.maxSteps).toBe(3);
		expect(result.config?.agent.contextReservePct).toBe(DEFAULT_CONFIG.agent.contextReservePct);
	});
});

describe("validation", () => {
	test("malformed JSON names the offending file", () => {
		const result = resolveConfig({ ws: '{ "endpoint": "http://x:1", }' });
		expect(result.ok).toBe(false);
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("malformed JSON in");
		expect(result.message).toContain(path.join(".og", "config.json"));
	});

	test("a UTF-8 BOM is tolerated: Notepad and PowerShell 5.1 write one", () => {
		const result = resolveConfig({ ws: `\uFEFF{ "agent": { "maxSteps": 7 } }` });
		expect(result.ok).toBe(true);
		expect(result.config?.agent.maxSteps).toBe(7);
	});

	test("a non-object config file is rejected", () => {
		const result = resolveConfig({ home: "[1,2,3]" });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("must contain a JSON object");
	});

	test("a non-URL endpoint is rejected", () => {
		const result = resolveConfig({ ws: { endpoint: "not a url" } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`endpoint`");
		expect(result.message).toContain("not a url");
	});

	test("an unknown model names the available profiles", () => {
		const result = resolveConfig({ ws: { model: "gpt-oss-20b" } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`model`");
		expect(result.message).toContain("gpt-oss-20b");
		for (const key of Object.keys(DEFAULT_CONFIG.profiles)) expect(result.message).toContain(key);
	});

	test("contextWindow larger than ctx is rejected with the profile path", () => {
		const result = resolveConfig({ ws: { profiles: { "qwen3-coder-30b": { contextWindow: 40000 } } } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`profiles.qwen3-coder-30b.contextWindow`");
		expect(result.message).toContain("32768");
	});

	test("non-positive ctx is rejected with the profile path", () => {
		for (const ctx of [0, -1]) {
			const result = resolveConfig({ ws: { profiles: { "devstral-24b": { ctx } } } });
			expect(result.isConfigError).toBe(true);
			expect(result.message).toContain("`profiles.devstral-24b.ctx`");
		}
	});

	test("contextReservePct outside (0, 0.9) is rejected", () => {
		for (const value of [0, 0.9, 1.5, -0.1]) {
			const result = resolveConfig({ ws: { agent: { contextReservePct: value } } });
			expect(result.isConfigError).toBe(true);
			expect(result.message).toContain("`agent.contextReservePct`");
		}
	});

	test("maxParallelTools below 1 or non-integer is rejected", () => {
		for (const value of [0, -2, 1.5]) {
			const result = resolveConfig({ ws: { agent: { maxParallelTools: value } } });
			expect(result.isConfigError).toBe(true);
			expect(result.message).toContain("`agent.maxParallelTools`");
		}
	});

	test("a profile without a file is rejected", () => {
		const result = resolveConfig({ ws: { profiles: { custom: { file: "", ctx: 8192, contextWindow: 8192 } } } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`profiles.custom.file`");
	});

	test("denyPaths must be an array", () => {
		const result = resolveConfig({ ws: { tools: { denyPaths: "**/*.pem" } } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`tools.denyPaths`");
	});

	test("profileOf rejects an unknown key and lists the known ones", () => {
		const result = resolveConfig({ profileKey: "ghost-model" });
		expect(result.ok).toBe(false);
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain('unknown model profile "ghost-model"');
		expect(result.message).toContain("qwen3-coder-30b");
	});

	test("profileOf returns the requested profile when it exists", () => {
		const result = resolveConfig({ profileKey: "qwen3-coder-30b-fast" });
		expect(result.ok).toBe(true);
		expect(result.profile).toEqual(DEFAULT_CONFIG.profiles["qwen3-coder-30b-fast"] as ModelProfile);
	});

	test("a valid custom profile can be added and selected", () => {
		const result = resolveConfig({
			ws: {
				model: "custom",
				profiles: {
					custom: {
						file: "Custom-Q4.gguf",
						ctx: 16384,
						nGpuLayers: 99,
						cacheTypeK: "q8_0",
						cacheTypeV: "q8_0",
						flashAttn: true,
						contextWindow: 16384,
						temperature: 0.2,
					},
				},
			},
			profileKey: "custom",
		});
		expect(result.ok).toBe(true);
		expect(result.profile?.ctx).toBe(16384);
		expect(Object.keys(result.config?.profiles ?? {})).toHaveLength(
			Object.keys(DEFAULT_CONFIG.profiles).length + 1,
		);
	});
});

describe("DEFAULT_CONFIG invariants", () => {
	test("loadConfig never mutates DEFAULT_CONFIG", () => {
		// Every resolveConfig() case asserts defaultsUnchanged; this pins the
		// hardest case, where nested objects and arrays are both patched.
		const result = resolveConfig({
			home: { profiles: { "qwen3-coder-30b": { nCpuMoe: 20 } }, tools: { denyPaths: [] } },
			ws: { agent: { maxSteps: 2 } },
			overrides: { engine: { slots: 4 } },
		});
		expect(result.defaultsUnchanged).toBe(true);
		expect(result.config?.engine.slots).toBe(4);
	});

	test("every profile is internally consistent and VRAM-plausible", () => {
		const KV_TYPES: Record<string, true> = { f16: true, q8_0: true, q4_0: true };
		for (const [key, profile] of Object.entries(DEFAULT_CONFIG.profiles)) {
			expect(profile.contextWindow, key).toBeLessThanOrEqual(profile.ctx);
			expect(profile.contextWindow, key).toBeGreaterThan(0);
			expect(profile.nGpuLayers, key).toBeGreaterThan(0);
			expect(KV_TYPES[profile.cacheTypeK] === true, key).toBe(true);
			expect(KV_TYPES[profile.cacheTypeV] === true, key).toBe(true);
			// The measured VRAM sweep assumed flash attention on; off changes the budget.
			expect(profile.flashAttn, key).toBe(true);
			expect(profile.file.endsWith(".gguf"), key).toBe(true);
			expect(path.basename(profile.file), key).toBe(profile.file);
		}
	});

	test("the default model key exists and MoE splits match the measured sweep", () => {
		expect(DEFAULT_CONFIG.profiles[DEFAULT_CONFIG.model]).toBeDefined();
		const measured: Record<string, { ctx: number; nCpuMoe?: number }> = {
			"qwen3-coder-30b": { ctx: 32768, nCpuMoe: 14 },
			"qwen3-coder-30b-long": { ctx: 65536, nCpuMoe: 18 },
			"qwen3-coder-30b-fast": { ctx: 32768, nCpuMoe: 4 },
			"devstral-24b": { ctx: 8192 },
		};
		for (const [key, expected] of Object.entries(measured)) {
			const profile = DEFAULT_CONFIG.profiles[key];
			expect(profile?.ctx, key).toBe(expected.ctx);
			expect(profile?.nCpuMoe, key).toBe(expected.nCpuMoe);
		}
	});

	test("the default endpoint and the engine port agree", () => {
		expect(new URL(DEFAULT_CONFIG.endpoint).port).toBe(String(DEFAULT_CONFIG.engine.port));
	});

	test("compaction triggers no later than the context reserve boundary", () => {
		const { compactThresholdPct, contextReservePct } = DEFAULT_CONFIG.agent;
		expect(compactThresholdPct).toBeGreaterThan(0);
		expect(compactThresholdPct).toBeLessThanOrEqual(1 - contextReservePct);
	});

	test("the batch geometry llama-server requires holds", () => {
		expect(DEFAULT_CONFIG.engine.ubatchSize).toBeLessThanOrEqual(DEFAULT_CONFIG.engine.batchSize);
		expect(DEFAULT_CONFIG.engine.slots).toBeGreaterThanOrEqual(1);
		expect(DEFAULT_CONFIG.engine.threads).toBeGreaterThanOrEqual(4);
	});
});
