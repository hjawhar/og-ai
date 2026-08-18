/**
 * Layered configuration resolution:
 *   DEFAULT_CONFIG -> ~/.og/config.json -> <workspace>/.og/config.json -> OG_* env -> overrides
 * Objects merge recursively (so `profiles` merges per key, and a user may override a
 * single field of a single profile); arrays replace wholesale.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OgConfig, ModelProfile } from "./schema.ts";
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

/** Qwen3-Coder author-recommended sampling. */
const QWEN_SAMPLING = {
	temperature: 0.7,
	topP: 0.8,
	topK: 20,
	minP: 0,
	repeatPenalty: 1.05,
} as const;

/**
 * Profile values are measured, not guessed, on an RTX 5070 Ti (16302 MiB) with
 * llama.cpp b10488 / CUDA 13.3. The binding constraint is VRAM: once resident
 * memory passes ~15.4 GiB the driver silently spills to host RAM and throughput
 * collapses by ~8x (measured: 15750 MiB -> 120 tok/s prefill, 29 tok/s gen).
 * Every profile below is sized to leave >= 1.2 GiB of headroom for the desktop.
 *
 * Measured (6k-token prefill, 256-token generation, q8_0 KV, flash attention):
 *   qwen3-coder-30b       14714 MiB   1476 tok/s prefill    82 tok/s gen
 *   qwen3-coder-30b-long  15082 MiB   1238 tok/s prefill    70 tok/s gen
 *   qwen3-coder-30b-fast  14569 MiB   2957 tok/s prefill   137 tok/s gen
 */
export const DEFAULT_CONFIG: OgConfig = {
	endpoint: "http://127.0.0.1:8127",
	model: "qwen3-coder-30b",
	stateDir: path.join(HOME, ".og"),
	profiles: {
		// Default: best quality/context balance that still fits with headroom.
		"qwen3-coder-30b": {
			file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
			ctx: 32768,
			nGpuLayers: 99,
			nCpuMoe: 14,
			cacheTypeK: "q8_0",
			cacheTypeV: "q8_0",
			flashAttn: true,
			contextWindow: 32768,
			...QWEN_SAMPLING,
		},
		// Same weights, 64k context; pays ~15% throughput for 2x context.
		"qwen3-coder-30b-long": {
			file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
			ctx: 65536,
			nGpuLayers: 99,
			nCpuMoe: 18,
			cacheTypeK: "q8_0",
			cacheTypeV: "q8_0",
			flashAttn: true,
			contextWindow: 65536,
			...QWEN_SAMPLING,
		},
		// Lower-precision weights, far more experts resident on GPU: ~1.7x faster.
		"qwen3-coder-30b-fast": {
			file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf",
			ctx: 32768,
			nGpuLayers: 99,
			nCpuMoe: 4,
			cacheTypeK: "q8_0",
			cacheTypeV: "q8_0",
			flashAttn: true,
			contextWindow: 32768,
			...QWEN_SAMPLING,
		},
		// 24B dense at Q4 leaves room for only 8k of KV cache on 16 GiB.
		// Measured: c8192 ngl99 -> 15045 MiB, 2292 tok/s prefill, 51 tok/s gen.
		// Partial offload to reach 32k costs 3.6x generation speed (14 tok/s),
		// so full offload with a short window is the only sane operating point.
		"devstral-24b": {
			file: "Devstral-Small-2507-Q4_K_M.gguf",
			ctx: 8192,
			nGpuLayers: 99,
			cacheTypeK: "q8_0",
			cacheTypeV: "q8_0",
			flashAttn: true,
			contextWindow: 8192,
			temperature: 0.15,
			topP: 0.95,
		},
	},
	engine: {
		autoStart: true,
		binDir: path.join(HOME, ".local", "llama.cpp", "current"),
		modelsDir: path.join(HOME, "models"),
		host: "127.0.0.1",
		port: 8127,
		threads: Math.max(4, Math.floor(os.cpus().length / 2)),
		batchSize: 2048,
		ubatchSize: 512,
		slots: 1,
		startupTimeoutSec: 240,
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
	const noAutostart = process.env["OG_NO_AUTOSTART"]?.trim().toLowerCase();
	if (noAutostart !== undefined && noAutostart !== "" && !["0", "false", "no", "off"].includes(noAutostart)) {
		layer["engine"] = { autoStart: false };
	}
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

/** Shape-checks the merged layers and hands back a trusted OgConfig. */
function validate(raw: Record<string, unknown>): OgConfig {
	const endpoint = raw["endpoint"];
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		throw new ConfigError("invalid config: `endpoint` must be a non-empty URL string");
	}
	try {
		new URL(endpoint);
	} catch {
		throw new ConfigError(`invalid config: \`endpoint\` is not a valid URL: ${endpoint}`);
	}
	if (typeof raw["stateDir"] !== "string" || raw["stateDir"].length === 0) {
		throw new ConfigError("invalid config: `stateDir` must be a non-empty path");
	}

	const profiles = requireObject(raw["profiles"], "profiles");
	if (Object.keys(profiles).length === 0) {
		throw new ConfigError("invalid config: `profiles` must contain at least one model profile");
	}
	for (const [key, value] of Object.entries(profiles)) {
		const profile = requireObject(value, `profiles.${key}`);
		if (typeof profile["file"] !== "string" || profile["file"].length === 0) {
			throw new ConfigError(`invalid config: \`profiles.${key}.file\` must be a GGUF filename or absolute path`);
		}
		const ctx = requirePositiveNumber(profile["ctx"], `profiles.${key}.ctx`);
		const window = requirePositiveNumber(profile["contextWindow"], `profiles.${key}.contextWindow`);
		if (window > ctx) {
			throw new ConfigError(
				`invalid config: \`profiles.${key}.contextWindow\` (${window}) must be <= \`profiles.${key}.ctx\` (${ctx})`,
			);
		}
	}

	const model = raw["model"];
	if (typeof model !== "string" || !Object.hasOwn(profiles, model)) {
		throw new ConfigError(
			`invalid config: \`model\` ${JSON.stringify(model)} is not a known profile; available: ${Object.keys(profiles).join(", ")}`,
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
	requireObject(raw["engine"], "engine");
	const tools = requireObject(raw["tools"], "tools");
	requireObject(tools["bash"], "tools.bash");
	requireObject(tools["edit"], "tools.edit");
	if (!Array.isArray(tools["denyPaths"])) {
		throw new ConfigError("invalid config: `tools.denyPaths` must be an array of glob patterns");
	}

	// Checked above: the merged record carries every field OgConfig declares.
	return raw as unknown as OgConfig;
}

export function loadConfig(opts: { workspaceRoot: string; overrides?: Partial<OgConfig> }): OgConfig {
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
	return validate(merged);
}

/** Resolves a profile by key, defaulting to the active `cfg.model`. */
export function profileOf(cfg: OgConfig, key?: string): ModelProfile {
	const wanted = key ?? cfg.model;
	const profile = cfg.profiles[wanted];
	if (!profile) {
		throw new ConfigError(
			`unknown model profile "${wanted}"; available: ${Object.keys(cfg.profiles).join(", ") || "(none)"}`,
		);
	}
	return profile;
}
