/**
 * Configuration decides which endpoint is dialled, which wire model name is
 * sent and how many tokens the agent believes it may spend, so a layering bug
 * does not crash — it silently talks to the wrong server or overruns the
 * server's real context window and gets the prompt truncated behind og's back.
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

import {
	DEFAULT_CONFIG,
	DEFAULT_CONTEXT_WINDOW,
	endpointOf,
	modelSpecOf,
	resolveActiveModel,
	wireModelOf,
} from "../src/config/load.ts";
import type { ServedModel } from "../src/provider/types.ts";
import { ConfigError } from "../src/config/schema.ts";
import type { ModelSpec, OgConfig } from "../src/config/schema.ts";

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
		...(spec.contextWindow !== undefined ? { contextWindow: spec.contextWindow } : {}),
	});
	out.config = cfg;
	out.hasEngineKey = Object.hasOwn(cfg, "engine");
	if (spec.modelSpecKey !== undefined) out.modelSpec = load.modelSpecOf(cfg, spec.modelSpecKey);
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
	hasEngineKey?: boolean;
	modelSpec?: ModelSpec;
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
	/** Forwarded as `loadConfig({ contextWindow })`, i.e. `--context-window`. */
	contextWindow?: number;
	modelSpecKey?: string;
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
			...(spec.contextWindow !== undefined ? { contextWindow: spec.contextWindow } : {}),
			...(spec.modelSpecKey !== undefined ? { modelSpecKey: spec.modelSpecKey } : {}),
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

function specOrThrow(cfg: OgConfig | undefined, key: string): ModelSpec {
	const spec = cfg?.models[key];
	if (!spec) throw new Error(`resolved config is missing model ${key}`);
	return spec;
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
		// Nothing is shipped to pick, so the model stays unchosen until discovery.
		expect(result.config?.model).toBe("");
	});

	test("home layer alone is applied when no workspace config exists", () => {
		const result = resolveConfig({
			home: { model: "home-model", models: { "home-model": { contextWindow: 4096 } }, endpoint: "https://api.example.com/v1-compat" },
		});
		expect(result.config?.model).toBe("home-model");
		expect(result.config?.endpoint).toBe("https://api.example.com/v1-compat");
		// The entry a layer declared is the only one there: og ships none.
		expect(Object.keys(result.config?.models ?? {})).toEqual(["home-model"]);
	});

	test("a model patch merges per key and leaves sibling models intact", () => {
		const result = resolveConfig({
			home: { models: { alpha: { contextWindow: 8192, topP: 0.9 }, beta: { contextWindow: 65536 } } },
			ws: { models: { alpha: { contextWindow: 16384 } } },
		});

		// The workspace patch replaces one field and leaves the rest of that entry.
		expect(specOrThrow(result.config, "alpha")).toEqual({ contextWindow: 16384, topP: 0.9 });
		expect(Object.keys(result.config?.models ?? {}).sort()).toEqual(["alpha", "beta"]);
		expect(specOrThrow(result.config, "beta").contextWindow).toBe(65536);
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
			ws: { endpoint: "http://file.local:1", model: "file-model", models: { "file-model": { contextWindow: 4096 } } },
			env: {
				OG_ENDPOINT: "http://env.local:2",
				OG_MODEL: "env-model",
				OG_API_KEY: "env-key",
				OG_STATE_DIR: "C:\\env-state",
				OG_MODELS_DIR: "C:\\env-weights",
			},
		});

		expect(result.config?.endpoint).toBe("http://env.local:2");
		// A name only the environment gave is synthesised: no entry has to exist first.
		expect(result.config?.model).toBe("env-model");
		expect(result.config?.apiKey).toBe("env-key");
		expect(result.config?.stateDir).toBe("C:\\env-state");
		expect(result.config?.modelsDir).toBe("C:\\env-weights");
	});

	test("only those five variables exist: an OG_* knob og dropped is inert", () => {
		// og no longer starts a server, so there is nothing to opt out of. The
		// variable must be ignored outright rather than resurrect a hidden branch.
		// `stateDir` and `modelsDir` are derived from each case's own temp home, so
		// they are the fields two runs cannot agree on.
		const shape = (result: CaseResult): string =>
			JSON.stringify({ ...result.config, stateDir: "", modelsDir: "" });

		const bare = resolveConfig({});
		const withGhosts = resolveConfig({ env: { OG_NO_AUTOSTART: "1", OG_LOCAL_ENDPOINT: "1" } });
		expect(withGhosts.ok).toBe(true);
		expect(shape(withGhosts)).toBe(shape(bare));
	});

	test("explicit overrides beat the environment layer", () => {
		const result = resolveConfig({
			env: { OG_ENDPOINT: "http://env.local:2", OG_MODEL: "env-model" },
			overrides: { endpoint: "http://flag.local:3", model: "flag-model" },
		});
		expect(result.config?.endpoint).toBe("http://flag.local:3");
		expect(result.config?.model).toBe("flag-model");
	});

	test("overrides merge nested objects rather than replacing them", () => {
		const result = resolveConfig({ overrides: { agent: { maxSteps: 3 } } });
		expect(result.config?.agent.maxSteps).toBe(3);
		expect(result.config?.agent.contextReservePct).toBe(DEFAULT_CONFIG.agent.contextReservePct);
	});
});

describe("pass-through models", () => {
	test("`-m` names a model og has never heard of and it is synthesized", () => {
		const result = resolveConfig({
			overrides: { model: "gpt-4o", endpoint: "https://api.openai.com" },
			modelSpecKey: "gpt-4o",
		});

		expect(result.ok).toBe(true);
		expect(result.config?.model).toBe("gpt-4o");
		expect(result.modelSpec).toEqual({ id: "gpt-4o", contextWindow: DEFAULT_CONTEXT_WINDOW });
		// The shipped entries are still there to switch back to.
		expect(Object.keys(result.config?.models ?? {})).toHaveLength(
			Object.keys(DEFAULT_CONFIG.models).length + 1,
		);
	});

	test("OG_MODEL is equally explicit and synthesizes too", () => {
		const result = resolveConfig({
			env: { OG_MODEL: "claude-sonnet-4", OG_ENDPOINT: "https://gateway.local:8080" },
			modelSpecKey: "claude-sonnet-4",
		});
		expect(result.ok).toBe(true);
		expect(result.modelSpec).toEqual({ id: "claude-sonnet-4", contextWindow: DEFAULT_CONTEXT_WINDOW });
	});

	test("`--context-window` sizes a synthesized model", () => {
		const result = resolveConfig({
			overrides: { model: "gpt-4o" },
			contextWindow: 128_000,
			modelSpecKey: "gpt-4o",
		});
		expect(result.modelSpec).toEqual({ id: "gpt-4o", contextWindow: 128_000 });
	});

	test("`--context-window` also overrides a configured model's window", () => {
		const result = resolveConfig({
			home: { model: "local", models: { local: { contextWindow: 32768, topK: 20 }, sibling: { contextWindow: 65536 } } },
			contextWindow: 12_288,
			modelSpecKey: "local",
		});
		expect(result.config?.model).toBe("local");
		expect(result.modelSpec?.contextWindow).toBe(12_288);
		// Only the active model is resized; its siblings keep their own windows.
		expect(specOrThrow(result.config, "sibling").contextWindow).toBe(65536);
		// The sampling knobs of the configured entry survive the resize.
		expect(result.modelSpec?.topK).toBe(20);
	});

	test("an unknown `model` in a config file is still a typo, not a pass-through", () => {
		const typo = { model: "qwen3-codre-30b" };
		for (const spec of [{ home: typo }, { ws: typo }]) {
			const result = resolveConfig(spec);
			expect(result.ok).toBe(false);
			expect(result.isConfigError).toBe(true);
			expect(result.message).toContain("`model`");
			expect(result.message).toContain("qwen3-codre-30b");
			expect(result.message).toContain("is not a known model");
		}
		// Not even `--context-window` turns a file typo into a pass-through name.
		const sized = resolveConfig({ ws: { model: "qwen3-codre-30b" }, contextWindow: 4096 });
		expect(sized.isConfigError).toBe(true);
	});

	test("an explicit `-m` overrides a file typo instead of inheriting the error", () => {
		const result = resolveConfig({
			ws: { model: "qwen3-codre-30b" },
			overrides: { model: "devstral-24b" },
		});
		expect(result.ok).toBe(true);
		expect(result.config?.model).toBe("devstral-24b");
	});

	test("a synthesized model still carries the config's endpoint and key", () => {
		const result = resolveConfig({
			overrides: { model: "kimi-k2" },
			env: { OG_ENDPOINT: "https://openrouter.ai/api", OG_API_KEY: "sk-test" },
		});
		expect(result.ok).toBe(true);
		expect(result.config?.endpoint).toBe("https://openrouter.ai/api");
		expect(result.config?.apiKey).toBe("sk-test");
		// Synthesis adds nothing but the wire id and the window.
		expect(Object.keys(result.config?.models["kimi-k2"] ?? {}).sort()).toEqual([
			"contextWindow",
			"id",
		]);
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

	test("an unknown model names the available models", () => {
		const result = resolveConfig({ ws: { model: "gpt-oss-20b" } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`model`");
		expect(result.message).toContain("gpt-oss-20b");
		for (const key of Object.keys(DEFAULT_CONFIG.models)) expect(result.message).toContain(key);
	});

	test("contextWindow is the one required field of a model spec", () => {
		// Absent: a spec that declares nothing else is still rejected.
		const absent = resolveConfig({ ws: { models: { custom: { topP: 0.5 } } } });
		expect(absent.isConfigError).toBe(true);
		expect(absent.message).toContain("`models.custom.contextWindow`");
		expect(absent.message).toContain("must be a positive number");

		// Non-positive and non-numeric windows are the same failure.
		for (const contextWindow of [0, -1, "32768", null, true]) {
			const result = resolveConfig({ ws: { models: { custom: { contextWindow } } } });
			expect(result.isConfigError, JSON.stringify(contextWindow)).toBe(true);
			expect(result.message).toContain("`models.custom.contextWindow`");
		}
	});

	test("a model spec needing nothing but contextWindow loads and can be selected", () => {
		const result = resolveConfig({
			ws: { model: "house-model", models: { "house-model": { contextWindow: 16384 } } },
			modelSpecKey: "house-model",
		});
		expect(result.ok).toBe(true);
		expect(result.modelSpec).toEqual({ contextWindow: 16384 });
	});

	test("id and apiKeyEnv must be non-empty strings when present", () => {
		for (const field of ["id", "apiKeyEnv"] as const) {
			for (const value of ["", 7, null]) {
				const result = resolveConfig({
					ws: { models: { custom: { contextWindow: 8192, [field]: value } } },
				});
				expect(result.isConfigError, `${field}=${JSON.stringify(value)}`).toBe(true);
				expect(result.message).toContain(`\`models.custom.${field}\``);
				expect(result.message).toContain("must be a non-empty string");
			}
		}
	});

	test("a per-model endpoint must be a non-empty string that parses as a URL", () => {
		const empty = resolveConfig({ ws: { models: { custom: { contextWindow: 8192, endpoint: "" } } } });
		expect(empty.isConfigError).toBe(true);
		expect(empty.message).toContain("`models.custom.endpoint`");
		expect(empty.message).toContain("must be a non-empty string");

		// `URL` accepts a surprising amount ("api.example.com:443" parses as a
		// scheme), so the rejection case has to be something it truly refuses.
		const notUrl = resolveConfig({
			ws: { models: { custom: { contextWindow: 8192, endpoint: "not a url" } } },
		});
		expect(notUrl.isConfigError).toBe(true);
		expect(notUrl.message).toContain("`models.custom.endpoint`");
		expect(notUrl.message).toContain("is not a valid URL");

		const valid = resolveConfig({
			ws: {
				model: "custom",
				models: { custom: { contextWindow: 8192, endpoint: "https://api.example.com/v1-compat" } },
			},
			modelSpecKey: "custom",
		});
		expect(valid.ok).toBe(true);
		expect(valid.modelSpec?.endpoint).toBe("https://api.example.com/v1-compat");
	});

	test("sampling knobs must be finite numbers", () => {
		for (const field of ["maxTokens", "temperature", "topP", "topK", "minP", "repeatPenalty"] as const) {
			const result = resolveConfig({
				ws: { models: { custom: { contextWindow: 8192, [field]: "0.5" } } },
			});
			expect(result.isConfigError, field).toBe(true);
			expect(result.message).toContain(`\`models.custom.${field}\``);
			expect(result.message).toContain("must be a finite number");
		}
	});

	test("header values must be strings, and the offending header is named", () => {
		const result = resolveConfig({
			ws: { models: { custom: { contextWindow: 8192, headers: { "HTTP-Referer": 1 } } } },
		});
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`models.custom.headers.HTTP-Referer`");

		const ok = resolveConfig({
			ws: {
				model: "custom",
				models: {
					custom: { contextWindow: 8192, headers: { "HTTP-Referer": "https://og.local" } },
				},
			},
			modelSpecKey: "custom",
		});
		expect(ok.ok).toBe(true);
		expect(ok.modelSpec?.headers).toEqual({ "HTTP-Referer": "https://og.local" });
	});

	test("a `models` patch can never delete an entry: an empty record is a no-op", () => {
		// Merging means `"models": {}` cannot leave og with nothing to dial, from
		// either a file or a flag. Deleting a model means editing the record it
		// came from, not shadowing it with emptiness.
		const specs: CaseSpec[] = [{ ws: { models: {} } }, { overrides: { models: {} } }];
		for (const spec of specs) {
			const result = resolveConfig(spec);
			expect(result.ok).toBe(true);
			expect(Object.keys(result.config?.models ?? {}).sort()).toEqual(
				Object.keys(DEFAULT_CONFIG.models).sort(),
			);
		}
	});

	test("apiKey must be a non-empty string when present", () => {
		const result = resolveConfig({ ws: { apiKey: 12345 } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`apiKey`");
		expect(result.message).toContain("must be a non-empty string");
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

	test("denyPaths must be an array", () => {
		const result = resolveConfig({ ws: { tools: { denyPaths: "**/*.pem" } } });
		expect(result.isConfigError).toBe(true);
		expect(result.message).toContain("`tools.denyPaths`");
	});
});

describe("modelSpecOf", () => {
	test("an unchosen model yields the fallback window rather than throwing", () => {
		// og ships no entries, and a reachability probe is built before discovery
		// can name anything.
		expect(DEFAULT_CONFIG.model).toBe("");
		expect(modelSpecOf(DEFAULT_CONFIG)).toEqual({ contextWindow: DEFAULT_CONTEXT_WINDOW });
	});

	test("returns the requested spec when it exists", () => {
		const cfg: OgConfig = { ...DEFAULT_CONFIG, models: { chosen: { contextWindow: 4096, topP: 0.9 } } };
		expect(modelSpecOf(cfg, "chosen")).toEqual(cfg.models["chosen"] as ModelSpec);
	});

	test("rejects an unknown key as a ConfigError listing the known ones", () => {
		let err: unknown;
		try {
			modelSpecOf(DEFAULT_CONFIG, "ghost-model");
		} catch (caught) {
			err = caught;
		}
		expect(err).toBeInstanceOf(ConfigError);
		expect((err as Error).message).toContain('unknown model "ghost-model"');
		for (const key of Object.keys(DEFAULT_CONFIG.models)) {
			expect((err as Error).message).toContain(key);
		}
	});

	test("resolves a model synthesized by the pass-through path", () => {
		const result = resolveConfig({ overrides: { model: "mystery-7b" }, modelSpecKey: "mystery-7b" });
		expect(result.modelSpec).toEqual({ id: "mystery-7b", contextWindow: DEFAULT_CONTEXT_WINDOW });
	});
});

describe("wire model and endpoint resolution", () => {
	const cfg: OgConfig = {
		...DEFAULT_CONFIG,
		endpoint: "http://127.0.0.1:8127",
		model: "aliased",
		models: {
			aliased: { id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", contextWindow: 32768 },
			hosted: { endpoint: "https://api.deepseek.com", contextWindow: 65536 },
			plain: { contextWindow: 8192 },
		},
	};

	test("an explicit id is the wire name; otherwise the record key is", () => {
		expect(wireModelOf(cfg)).toBe("Qwen/Qwen3-Coder-30B-A3B-Instruct");
		expect(wireModelOf(cfg, "plain")).toBe("plain");
	});

	test("a per-model endpoint wins over the top-level one", () => {
		expect(endpointOf(cfg, "hosted")).toBe("https://api.deepseek.com");
		expect(endpointOf(cfg, "plain")).toBe("http://127.0.0.1:8127");
		expect(endpointOf(cfg)).toBe("http://127.0.0.1:8127");
	});
});

describe("DEFAULT_CONFIG invariants", () => {
	test("loadConfig never mutates DEFAULT_CONFIG", () => {
		// Every resolveConfig() case asserts defaultsUnchanged; this pins the
		// hardest case, where nested objects and arrays are both patched.
		const result = resolveConfig({
			home: { models: { alpha: { contextWindow: 4096, topK: 40 } }, tools: { denyPaths: [] } },
			ws: { agent: { maxSteps: 2 } },
			overrides: { models: { beta: { contextWindow: 8192, maxTokens: 4096 } } },
		});
		expect(result.defaultsUnchanged).toBe(true);
		expect(result.config?.models["alpha"]?.topK).toBe(40);
		expect(result.config?.models["beta"]?.maxTokens).toBe(4096);
		// The shipped record is empty and stays empty.
		expect(DEFAULT_CONFIG.models).toEqual({});
	});

	test("no models ship at all: every name og shows is discovered or configured", () => {
		// A table of names here could only be a guess about somebody else's machine,
		// and a wrong guess is not inert — a llama-server answers a request for a
		// model it does not have with whatever it does have.
		expect(DEFAULT_CONFIG.models).toEqual({});
		expect(DEFAULT_CONFIG.model).toBe("");
	});

	test("the fallback window is the only per-model number og carries", () => {
		// A local server reports `meta.n_ctx` and that wins; this is for endpoints
		// that say nothing. Conservative on purpose: budgeting above the server's
		// real window makes it truncate silently.
		expect(DEFAULT_CONTEXT_WINDOW).toBe(32768);
	});

	test("sampling is not pinned anywhere: agent.temperature governs", () => {
		// Nothing ships a per-model recipe, so the agent block is the single source.
		expect(DEFAULT_CONFIG.agent.temperature).toBe(0.2);
	});

	test("og knows nothing about weights, servers or offload splits", () => {
		// Scoped to the model record on purpose: `stateDir` is derived from the
		// developer's home directory and is not og's statement about anything.
		const text = JSON.stringify(DEFAULT_CONFIG.models);
		for (const forbidden of [
			"gguf",
			"file",
			"nCpuMoe",
			"nGpuLayers",
			"cacheType",
			"flashAttn",
			"binDir",
			"modelsDir",
			"port",
			"autoStart",
		]) {
			expect(text.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
		}
		// No engine section exists to be revived, on the defaults or a resolved config.
		expect(Object.hasOwn(DEFAULT_CONFIG, "engine")).toBe(false);
		expect(resolveConfig({}).hasEngineKey).toBe(false);
		// A model spec carries only client-side fields.
		const ALLOWED_SPEC_FIELDS: Record<string, true> = {
			id: true,
			endpoint: true,
			apiKeyEnv: true,
			headers: true,
			contextWindow: true,
			maxTokens: true,
			temperature: true,
			topP: true,
			topK: true,
			minP: true,
			repeatPenalty: true,
		};
		for (const [key, spec] of Object.entries(DEFAULT_CONFIG.models)) {
			for (const field of Object.keys(spec)) {
				expect(ALLOWED_SPEC_FIELDS[field] === true, `${key}.${field}`).toBe(true);
			}
		}
	});

	test("the pass-through window is conservative enough to be safe anywhere", () => {
		expect(DEFAULT_CONTEXT_WINDOW).toBe(32768);
		// A guessed window larger than the server's real one is a silent prompt
		// truncation, so the fallback stays at the most common local ceiling and
		// `--context-window` exists for anything bigger. It must still be large
		// enough to hold a response: maxTokens alone would leave no room to think.
		expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(DEFAULT_CONFIG.agent.maxTokens);
	});

	test("the default endpoint is a loopback URL: og ships pointing at nothing remote", () => {
		const url = new URL(DEFAULT_CONFIG.endpoint);
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.port).toBe("8127");
		expect(DEFAULT_CONFIG.apiKey).toBeUndefined();
	});

	test("compaction triggers no later than the context reserve boundary", () => {
		const { compactThresholdPct, contextReservePct } = DEFAULT_CONFIG.agent;
		expect(compactThresholdPct).toBeGreaterThan(0);
		expect(compactThresholdPct).toBeLessThanOrEqual(1 - contextReservePct);
	});
});

/**
 * og ships no model entries, so the active model is discovered. A `llama-server`
 * serves what it loaded and answers to any name, which is why insisting on the
 * wrong one does not fail — it returns the loaded model's output budgeted from
 * the wrong entry. This decides what og talks to, and it must never override a
 * name somebody actually chose.
 */
describe("resolveActiveModel", () => {
	const cfg = (overrides: Partial<OgConfig> = {}): OgConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...overrides });
	const served = (...models: ServedModel[]): ServedModel[] => models;

	test("nothing chosen follows the one model the endpoint serves, window and all", () => {
		const only = { id: "served-a", contextWindow: 8192 };
		expect(resolveActiveModel(cfg(), served(only), false)).toEqual(only);
	});

	test("a pinned model is never overridden, however wrong it looks", () => {
		// An explicit -m, OG_MODEL or config `model` is a statement; a typo there
		// should fail loudly rather than be quietly replaced.
		expect(resolveActiveModel(cfg(), served({ id: "served-a" }), true)).toBeUndefined();
	});

	test("nothing to adopt when the configured model is already the served one", () => {
		const config = cfg({ model: "local", models: { local: { contextWindow: 4096 } } });
		expect(resolveActiveModel(config, served({ id: "local" }), false)).toBeUndefined();
	});

	test("several served models are not guessed between", () => {
		expect(resolveActiveModel(cfg(), served({ id: "a" }, { id: "b" }), false)).toBeUndefined();
	});

	test("an endpoint naming nothing leaves the configured model alone", () => {
		expect(resolveActiveModel(cfg(), [], false)).toBeUndefined();
	});

	test("matching is against the wire name, so a spec's `id` override counts", () => {
		const config = cfg({ model: "local", models: { local: { contextWindow: 8192, id: "served-as-this" } } });
		expect(resolveActiveModel(config, served({ id: "served-as-this" }), false)).toBeUndefined();
		expect(resolveActiveModel(config, served({ id: "something-else" }), false)?.id).toBe("something-else");
	});
});

describe("shipped defaults", () => {
	test("no models are shipped: og discovers them instead of guessing about this machine", () => {
		expect(DEFAULT_CONFIG.models).toEqual({});
		// "" is the honest starting state, and validation accepts it.
		expect(DEFAULT_CONFIG.model).toBe("");
	});

	test("an unchosen model resolves to fallback knobs rather than throwing", () => {
		// A reachability probe has to be built before discovery can name anything.
		expect(modelSpecOf(DEFAULT_CONFIG).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	test("a named model with no entry is still an error: that is a typo, not a discovery", () => {
		expect(() => modelSpecOf({ ...DEFAULT_CONFIG, model: "typo" })).toThrow(ConfigError);
	});
});
