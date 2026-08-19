/**
 * Weights sitting on this machine.
 *
 * og cannot load one. It is a client, it starts no server, and a `.gguf` on disk
 * is not something it can act on — that is the engine's job
 * (`og-llama-cpp/serve.ts` or its model UI). This exists because leaving the
 * question unanswered was worse: an operator who had just downloaded three models
 * ran `og models`, saw names they had never chosen, and reasonably concluded og
 * was lying to them. So the files are listed, plainly marked as not being served,
 * beside the one that is.
 *
 * A directory read, nothing more: no metadata parsing, no size arithmetic, no
 * verdicts. Everything that reads a GGUF header lives in the other project.
 */
import { readdirSync, statSync } from "node:fs";

/**
 * `.gguf` filenames in `dir`, sorted. Empty when the directory is missing or
 * unreadable, which is the normal case for someone pointing og at a remote
 * endpoint and never downloading anything.
 */
export function installedWeights(dir: string): string[] {
	try {
		if (!statSync(dir).isDirectory()) return [];
		return readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".gguf"))
			.sort();
	} catch {
		return [];
	}
}

/**
 * The name a served model would answer to for this file: `serve.ts` aliases a
 * model to its filename without the extension, so that is what `/v1/models`
 * reports and what a row must be matched against to avoid listing the running
 * model twice.
 */
export function servedNameOf(file: string): string {
	return file.replace(/\.gguf$/i, "");
}
