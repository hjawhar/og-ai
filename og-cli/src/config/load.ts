/**
 * Layered configuration resolution:
 *   DEFAULT_CONFIG -> ~/.og/config.json -> <workspace>/.og/config.json -> OG_* env -> overrides
 * Objects merge recursively (so `models` merges per key, and a user may override a
 * single field of a single model); arrays replace wholesale.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelSpec, OgConfig } from "./schema.ts";
import { ConfigError } from "./schema.ts";

const HOME = os.homedir();

/**
 * Commands auto-denied regardless of approval policy. Each entry is a regular
 * expression source matched case-insensitively against the whole command line.
 * Scope is deliberately catastrophic-only (filesystem/disk/machine/registry
 * destruction and remote-code-execution pipelines) — ordinary destructive work
 * such as `rm -rf build` stays under the approval gate.
 */
const BASH_DENY_PATTERNS: string[] = [
	// rm / del aimed at a filesystem root, a drive root, or the user profile
	"(^|[;&|]\\s*)rm\\s+(-{1,2}[\\w-]+\\s+)*(/|/\\*|~|~/\\*|\\$HOME|\\$\\{HOME\\}|%USERPROFILE%|\\$env:USERPROFILE|[A-Za-z]:[\\\\/]?)(\\s|$)",
	"(^|[;&|]\\s*)del\\s+(/[a-z]+\\s+)*[\"']?[A-Za-z]:[\\\\/]?[\"']?(\\s|$)",
	"\\b(rd|rmdir)\\s+(/[a-z]\\s+)+[\"']?[A-Za-z]:[\\\\/]?[\"']?(\\s|$)",
	// PowerShell recursive delete of a drive root, UNC root, or user profile
	"\\bRemove-Item\\b[^\\n]*(-Recurse|-Force)[^\\n]*[\"'\\s]([A-Za-z]:[\\\\/]?|\\\\\\\\|\\$env:USERPROFILE|~)[\"'\\s]*($|-)",
	// whole-disk and filesystem-level operations
	"\\b(mkfs(\\.\\w+)?|fdisk|diskpart|Format-Volume|Clear-Disk|Initialize-Disk|New-Partition)\\b",
	"\\bformat(\\.com)?\\s+[\"']?[A-Za-z]:",
	"\\bdd\\s+[^\\n]*\\bof=\\s*(/dev/(sd|nvme|hd|disk|vd)|\\\\\\\\\\.\\\\PhysicalDrive)",
	"\\b(cipher\\s+/w|sdelete\\b|vssadmin\\s+delete\\s+shadows|wbadmin\\s+delete)\\b",
	// machine and boot state
	"(^|[;&|`]\\s*|\\bsudo\\s+|\\bstart\\s+)(shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer)\\b",
	"\\bbcdedit\\b",
	// registry destruction
	"\\breg(\\.exe)?\\s+delete\\s+[\"']?HK(LM|EY_LOCAL_MACHINE|CR|EY_CLASSES_ROOT|U|EY_USERS)\\b",
	"\\bRemove-Item\\b[^\\n]*\\bHK(LM|CR|CU|U):",
	// download-and-execute pipelines
	"\\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\\b[^\\n]*\\|\\s*(sudo\\s+)?(ba|z|k|da|fi)?sh\\b",
	"\\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\\b[^\\n]*\\|\\s*(iex|Invoke-Expression)\\b",
	"\\b(iex|Invoke-Expression)\\s*\\(\\s*(New-Object\\s+Net\\.WebClient|Invoke-WebRequest|irm|iwr|curl)",
	// fork bomb and tree-wide permission/ownership rewrites
	":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:",
	"\\bchmod\\s+-R\\s+[0-7]{3,4}\\s+/(\\s|$)",
	"\\bchown\\s+-R\\s+[^\\n]+\\s+/(\\s|$)",
	"\\b(takeown|icacls)\\s+[\"']?[A-Za-z]:[\\\\/]?[\"']?\\s+/",
	// irreversible history rewrite of a shared branch
	"\\bgit\\s+push\\s+[^\\n]*(--force(?!-with-lease)|\\s-f\\b)[^\\n]*\\b(main|master)\\b",
];

/** Qwen3-Coder author-recommended sampling, minus temperature (see below). */
const QWEN_SAMPLING = {
	topP: 0.8,
	topK: 20,
	minP: 0,
	repeatPenalty: 1.05,
} as const;

/**
 * Context window for a model og was not told about — `og -m <name>` against an
 * arbitrary endpoint. Deliberately conservative: budgeting against a window
 * larger than the server's makes the server truncate silently, while budgeting
 * low only costs an earlier compaction. Override with `--context-window`.
 */
export const DEFAULT_CONTEXT_WINDOW = 32768;

/**
 * The shipped entries are the operating points measured in
 * og-llama-cpp/docs/benchmarks.md; `contextWindow` is the only number og needs,
 * because the offload split that makes it fit belongs to whoever starts the
 * server (og-llama-cpp/serve.ts).
 *
 * None of them sets `temperature`: `agent.temperature` (0.2) governs, which is
 * what was actually in force before — tool-call JSON degrades at the 0.7 Qwen
 * recommends for chat.
 */
export const DEFAULT_CONFIG: OgConfig = {
	endpoint: "http://127.0.0.1:8127",
	model: "qwen3-coder-30b",
	stateDir: path.join(HOME, ".og"),
	models: {
		// Best quality/context balance measured on a 16 GiB card: 82.1 tok/s.
		"qwen3-coder-30b": { contextWindow: 32768, ...QWEN_SAMPLING },
		// Same weights, 64k window; pays ~15% throughput for 2x context.
		"qwen3-coder-30b-long": { contextWindow: 65536, ...QWEN_SAMPLING },
		// Q3 weights, ~1.7x faster (136.5 tok/s), measurably looser at structured output.
		"qwen3-coder-30b-fast": { contextWindow: 32768, ...QWEN_SAMPLING },
		// 24B dense: full offload leaves room for only 8k of q8_0 KV cache.
		"devstral-24b": { contextWindow: 8192, topP: 0.95 },
	},
	agent: {
		maxSteps: 60,
		temperature: 0.2,
		maxTokens: 8192,
		contextReservePct: 0.25,
		compactThresholdPct: 0.75,
		maxParallelTools: 4,
	},
	tools: {
		bash: {
			enabled: true,
			approval: "unsafe-only",
			timeoutMs: 120_000,
			denyPatterns: BASH_DENY_PATTERNS,
		},
		edit: { approval: "never" },
		denyPaths: [
			"**/.git/objects/**",
			"**/node_modules/**",
			"**/.env",
			"**/.env.*",
			"**/*.pem",
			"**/*.key",
			"**/id_rsa*",
			"**/.ssh/**",
			"**/.og/sessions.db*",
		],
		maxOutputBytes: 65536,
	},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge in place: nested objects merge, arrays and scalars replace. */
function mergeInto(base: Record<string, unknown>, patch: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const current = base[key];
		if (isPlainObject(value) && isPlainObject(current)) mergeInto(current, value);
		else base[key] = typeof value === "object" && value !== null ? structuredClone(value) : value;
	}
}

function errText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function readConfigFile(file: string): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		const code = err instanceof Error && "code" in err ? err.code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
		throw new ConfigError(`cannot read config file ${file}: ${errText(err)}`);
	}
	// Notepad and PowerShell 5.1's `Set-Content -Encoding utf8` both prepend a
	// BOM, which JSON.parse rejects. Strip it rather than blaming the operator.
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	if (text.trim().length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new ConfigError(`malformed JSON in ${file}: ${errText(err)}`);
	}
	if (!isPlainObject(parsed)) throw new ConfigError(`config file ${file} must contain a JSON object`);
	return parsed;
}

function envLayer(): Record<string, unknown> {
	const layer: Record<string, unknown> = {};
	const endpoint = process.env["OG_ENDPOINT"];
	if (endpoint) layer["endpoint"] = endpoint;
	const model = process.env["OG_MODEL"];
	if (model) layer["model"] = model;
	const apiKey = process.env["OG_API_KEY"];
	if (apiKey) layer["apiKey"] = apiKey;
	const stateDir = process.env["OG_STATE_DIR"];
	if (stateDir) layer["stateDir"] = stateDir;
	return layer;
}

function requirePositiveNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ConfigError(`invalid config: \`${field}\` must be a positive number, got ${JSON.stringify(value)}`);
	}
	return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw new ConfigError(`invalid config: \`${field}\` must be an object, got ${JSON.stringify(value)}`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new ConfigError(`invalid config: \`${field}\` must be a non-empty string, got ${JSON.stringify(value)}`);
	}
	return value;
}

function optionalNumber(value: unknown, field: string): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ConfigError(`invalid config: \`${field}\` must be a finite number, got ${JSON.stringify(value)}`);
	}
}

function requireUrl(value: string, field: string): void {
	try {
		new URL(value);
	} catch {
		throw new ConfigError(`invalid config: \`${field}\` is not a valid URL: ${value}`);
	}
}

/** Shape-checks the merged layers and hands back a trusted OgConfig. */
function validate(raw: Record<string, unknown>): OgConfig {
	const endpoint = raw["endpoint"];
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		throw new ConfigError("invalid config: `endpoint` must be a non-empty URL string");
	}
	requireUrl(endpoint, "endpoint");
	optionalString(raw["apiKey"], "apiKey");
	if (typeof raw["stateDir"] !== "string" || raw["stateDir"].length === 0) {
		throw new ConfigError("invalid config: `stateDir` must be a non-empty path");
	}

	// No emptiness check: layers merge rather than replace, so the shipped models
	// always survive a user's `models` block and the record cannot be empty.
	const models = requireObject(raw["models"], "models");
	for (const [key, value] of Object.entries(models)) {
		const spec = requireObject(value, `models.${key}`);
		requirePositiveNumber(spec["contextWindow"], `models.${key}.contextWindow`);
		optionalString(spec["id"], `models.${key}.id`);
		optionalString(spec["apiKeyEnv"], `models.${key}.apiKeyEnv`);
		const modelEndpoint = optionalString(spec["endpoint"], `models.${key}.endpoint`);
		if (modelEndpoint !== undefined) requireUrl(modelEndpoint, `models.${key}.endpoint`);
		optionalNumber(spec["maxTokens"], `models.${key}.maxTokens`);
		optionalNumber(spec["temperature"], `models.${key}.temperature`);
		optionalNumber(spec["topP"], `models.${key}.topP`);
		optionalNumber(spec["topK"], `models.${key}.topK`);
		optionalNumber(spec["minP"], `models.${key}.minP`);
		optionalNumber(spec["repeatPenalty"], `models.${key}.repeatPenalty`);
		if (spec["headers"] !== undefined) {
			const headers = requireObject(spec["headers"], `models.${key}.headers`);
			for (const [name, headerValue] of Object.entries(headers)) {
				if (typeof headerValue !== "string") {
					throw new ConfigError(
						`invalid config: \`models.${key}.headers.${name}\` must be a string, got ${JSON.stringify(headerValue)}`,
					);
				}
			}
		}
	}

	const model = raw["model"];
	if (typeof model !== "string" || !Object.hasOwn(models, model)) {
		throw new ConfigError(
			`invalid config: \`model\` ${JSON.stringify(model)} is not a known model; available: ${Object.keys(models).join(", ")}`,
		);
	}

	const agent = requireObject(raw["agent"], "agent");
	const reserve = agent["contextReservePct"];
	if (typeof reserve !== "number" || !Number.isFinite(reserve) || reserve <= 0 || reserve >= 0.9) {
		throw new ConfigError(
			`invalid config: \`agent.contextReservePct\` must be > 0 and < 0.9, got ${JSON.stringify(reserve)}`,
		);
	}
	const parallel = agent["maxParallelTools"];
	if (typeof parallel !== "number" || !Number.isInteger(parallel) || parallel < 1) {
		throw new ConfigError(
			`invalid config: \`agent.maxParallelTools\` must be an integer >= 1, got ${JSON.stringify(parallel)}`,
		);
	}
	const tools = requireObject(raw["tools"], "tools");
	requireObject(tools["bash"], "tools.bash");
	requireObject(tools["edit"], "tools.edit");
	if (!Array.isArray(tools["denyPaths"])) {
		throw new ConfigError("invalid config: `tools.denyPaths` must be an array of glob patterns");
	}

	// Checked above: the merged record carries every field OgConfig declares.
	return raw as unknown as OgConfig;
}

export function loadConfig(opts: {
	workspaceRoot: string;
	overrides?: Partial<OgConfig>;
	/** Context window for the active model; the only knob a pass-through name needs. */
	contextWindow?: number;
}): OgConfig {
	// Cloned so DEFAULT_CONFIG stays pristine; the merge walker works on plain records.
	const merged = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
	// Overrides are typed but structurally a record from the walker's point of view.
	const overrides = opts.overrides as Record<string, unknown> | undefined;
	const layers: (Record<string, unknown> | undefined)[] = [
		readConfigFile(path.join(HOME, ".og", "config.json")),
		readConfigFile(path.join(opts.workspaceRoot, ".og", "config.json")),
		envLayer(),
		overrides,
	];
	for (const layer of layers) {
		if (layer) mergeInto(merged, layer);
	}

	// A model name og has never heard of is not an error when the operator named
	// it explicitly (`-m gpt-4o`, OG_MODEL): any OpenAI-compatible server names
	// its own models, and demanding a config entry first would make `-m` useless
	// against every endpoint but the configured one. A name coming from a config
	// file is still validated, so a typo there is caught instead of silently
	// dialling a model the server does not have.
	const models = isPlainObject(merged["models"]) ? merged["models"] : undefined;
	const active = merged["model"];
	const explicit = typeof overrides?.["model"] === "string" ? overrides["model"] : process.env["OG_MODEL"];
	if (models !== undefined && typeof active === "string" && active.length > 0) {
		if (!Object.hasOwn(models, active) && active === explicit) {
			models[active] = { id: active, contextWindow: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW };
		} else if (opts.contextWindow !== undefined) {
			const spec = models[active];
			if (isPlainObject(spec)) spec["contextWindow"] = opts.contextWindow;
		}
	}

	return validate(merged);
}

/** Resolves a model spec by key, defaulting to the active `cfg.model`. */
export function modelSpecOf(cfg: OgConfig, key?: string): ModelSpec {
	const wanted = key ?? cfg.model;
	const spec = cfg.models[wanted];
	if (!spec) {
		throw new ConfigError(
			`unknown model "${wanted}"; available: ${Object.keys(cfg.models).join(", ") || "(none)"}`,
		);
	}
	return spec;
}

/** Wire model name sent to the endpoint: an explicit `id`, else the record key. */
export function wireModelOf(cfg: OgConfig, key?: string): string {
	const wanted = key ?? cfg.model;
	return modelSpecOf(cfg, wanted).id ?? wanted;
}

/** Endpoint this model is served from: its own override, else the global one. */
export function endpointOf(cfg: OgConfig, key?: string): string {
	return modelSpecOf(cfg, key).endpoint ?? cfg.endpoint;
}
