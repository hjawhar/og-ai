/**
 * Pure llama-server argv construction. Kept side-effect free (apart from the
 * existence check in `resolveModelPath`) so the exact command line can be
 * printed to the user and unit-tested without touching the GPU.
 *
 * Flag names verified against llama.cpp build b10488 (`llama-server --help`).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { ConfigError, type OgConfig } from "../config/schema.ts";
import { profileOf } from "../config/load.ts";

function listGgufs(dir: string): string[] {
	try {
		if (!statSync(dir).isDirectory()) return [];
	} catch {
		return [];
	}
	try {
		return readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".gguf"))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Absolute `profile.file` is used verbatim; anything else is resolved against
 * `engine.modelsDir`. Throws ConfigError listing what is actually on disk when
 * the weights are missing, because a bad filename is the most common setup bug.
 */
export function resolveModelPath(cfg: OgConfig, profileKey: string): string {
	const profile = profileOf(cfg, profileKey);
	const modelsDir = cfg.engine.modelsDir;
	const abs = path.isAbsolute(profile.file)
		? path.normalize(profile.file)
		: path.resolve(modelsDir, profile.file);

	if (!existsSync(abs)) {
		const present = listGgufs(path.dirname(abs));
		const available =
			present.length > 0
				? `GGUF files present in ${path.dirname(abs)}:\n  ${present.join("\n  ")}`
				: `No .gguf files found in ${path.dirname(abs)}`;
		throw new ConfigError(
			`Model file for profile "${profileKey}" not found: ${abs}\n${available}`,
		);
	}
	return abs;
}

function numArg(out: string[], flag: string, value: number | undefined): void {
	if (value === undefined) return;
	out.push(flag, String(value));
}

/**
 * Deterministic argv for `llama-server`. Ordering is fixed so that logs,
 * snapshots and the "start it yourself" hint are all byte-identical.
 */
export function buildServerArgs(cfg: OgConfig, profileKey: string): string[] {
	const profile = profileOf(cfg, profileKey);
	const engine = cfg.engine;
	const args: string[] = [];

	args.push("-m", resolveModelPath(cfg, profileKey));
	args.push("--alias", profileKey);
	args.push("-ngl", String(profile.nGpuLayers));
	numArg(args, "--n-cpu-moe", profile.nCpuMoe);
	args.push("-c", String(profile.ctx));
	args.push("--cache-type-k", profile.cacheTypeK);
	args.push("--cache-type-v", profile.cacheTypeV);
	args.push("--flash-attn", profile.flashAttn ? "on" : "off");
	args.push("--jinja");
	args.push("--host", engine.host);
	args.push("--port", String(engine.port));
	args.push("-t", String(engine.threads));
	args.push("-b", String(engine.batchSize));
	args.push("-ub", String(engine.ubatchSize));
	args.push("--parallel", String(engine.slots));
	args.push("--no-webui");
	args.push("--metrics");
	args.push("--cont-batching");
	numArg(args, "--temp", profile.temperature);
	numArg(args, "--top-p", profile.topP);
	numArg(args, "--top-k", profile.topK);
	numArg(args, "--min-p", profile.minP);
	numArg(args, "--repeat-penalty", profile.repeatPenalty);
	if (profile.extraArgs) args.push(...profile.extraArgs);

	return args;
}
