/**
 * Removing weights from the models directory.
 *
 * The only destructive operation in this server, so its rules are here rather
 * than inline in a route handler: a filename arrives from a browser, and the one
 * mistake that must be impossible is treating it as a path. Every name is
 * required to be a bare `.gguf` basename — no separators, no `..`, no drive
 * letter — and is then joined to the configured models directory and checked to
 * still be inside it. A name that fails is refused, never sanitised into
 * something adjacent.
 *
 * `gguf-split` weights are removed as a set. llama.cpp opens shard 1 and expects
 * its siblings beside it, so deleting one shard does not free a model, it breaks
 * one: the remaining 20 GiB are then unusable and look installed.
 */
import { statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { shardPaths, splitOf } from "./hub.ts";

export class WeightsError extends Error {
	/** What the route should answer with. */
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "WeightsError";
		this.status = status;
	}
}

export interface Removal {
	/** Files actually unlinked, in the order they were removed. */
	deleted: string[];
	freedBytes: number;
}

/**
 * Every file that removing `file` will take with it, as absolute paths, in shard
 * order. Pure: no filesystem access beyond resolving the paths, so the rules it
 * enforces are checkable without a models directory.
 */
export function targetsFor(modelsDir: string, file: string): string[] {
	if (file.length === 0) throw new WeightsError("`file` is required", 400);
	// A basename, and nothing that could reach outside the directory. `basename`
	// is not used to *fix* the input: a name that needed fixing is a name this
	// server should not act on.
	if (file !== path.basename(file) || file.includes("/") || file.includes("\\") || file === "." || file === "..") {
		throw new WeightsError(`'${file}' is not a plain filename`, 400);
	}
	if (!file.toLowerCase().endsWith(".gguf")) throw new WeightsError(`'${file}' is not a .gguf file`, 400);

	const root = path.resolve(modelsDir);
	const targets: string[] = [];
	for (const shard of shardPaths(file)) {
		const full = path.resolve(root, shard);
		// Belt and braces: the checks above already exclude separators, so this can
		// only fire if they are ever loosened.
		if (path.dirname(full) !== root) throw new WeightsError(`'${shard}' resolves outside ${root}`, 400);
		targets.push(full);
	}
	return targets;
}

/** Names of every file removing `file` takes with it, for a confirmation prompt. */
export function shardsOf(file: string): string[] {
	return splitOf(file) === undefined ? [file] : shardPaths(file);
}

/**
 * Unlinks the set. A shard that is already gone is not an error — the goal is
 * that none of them remain — but the file the caller named must exist, so a typo
 * reads as 404 rather than as a successful no-op.
 */
export function remove(modelsDir: string, file: string): Removal {
	const targets = targetsFor(modelsDir, file);
	const primary = targets[0];
	if (primary === undefined) throw new WeightsError(`'${file}' resolved to nothing`, 400);
	let primarySize: number;
	try {
		primarySize = statSync(primary).size;
	} catch {
		throw new WeightsError(`no ${file} in ${path.resolve(modelsDir)}`, 404);
	}

	const removal: Removal = { deleted: [], freedBytes: 0 };
	for (const target of targets) {
		let size: number;
		try {
			size = target === primary ? primarySize : statSync(target).size;
		} catch {
			continue; // never there, or removed by someone else
		}
		try {
			unlinkSync(target);
		} catch (error) {
			// Windows refuses to unlink a file another process has mapped, which is
			// exactly what a running llama-server does to its weights. The OS message
			// is more use than anything invented here, and partial progress is
			// reported rather than hidden.
			const detail = error instanceof Error ? error.message : String(error);
			throw new WeightsError(
				removal.deleted.length === 0
					? `could not delete ${path.basename(target)}: ${detail}`
					: `deleted ${removal.deleted.join(", ")}, then could not delete ${path.basename(target)}: ${detail}`,
				500,
			);
		}
		removal.deleted.push(path.basename(target));
		removal.freedBytes += size;
	}
	return removal;
}
