/**
 * The measurement record, and nothing else.
 *
 * There used to be a curated download list beside this — six models with their
 * URLs and byte counts written down by hand. It is gone: the UI browses Hugging
 * Face now, so a hand-maintained list could only be a stale subset of what the
 * Hub already answers, and its `sizeBytes` constants were a second source of
 * truth for something every HTTP response states.
 *
 * What stays is the opposite of a guess. MEASURED is a verbatim copy of the
 * chosen rows of docs/benchmarks.md §4 — real runs, on the reference box, with
 * VRAM sampled from `nvidia-smi` while the model was serving. `fit.ts` lets a
 * measured row beat its own arithmetic, which is the whole reason to keep them.
 * Changing a number here without re-running tools/profile-sweep.ts makes the
 * measurement record a lie.
 */

export interface MeasuredRow {
	ctx: number;
	ncmoe?: number;
	vramMiB: number;
	prefill: number;
	gen: number;
}

/** The chosen rows of docs/benchmarks.md §4, keyed by the file they were run on. */
export const MEASURED: Record<string, MeasuredRow[]> = {
	"Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf": [
		{ ctx: 32768, ncmoe: 14, vramMiB: 14714, prefill: 1476, gen: 82.1 },
		{ ctx: 65536, ncmoe: 18, vramMiB: 15082, prefill: 1238, gen: 69.5 },
	],
	"Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf": [{ ctx: 32768, ncmoe: 4, vramMiB: 14569, prefill: 2957, gen: 136.5 }],
	"Devstral-Small-2507-Q4_K_M.gguf": [{ ctx: 8192, vramMiB: 15045, prefill: 2292, gen: 51.3 }],
};

/** Pre-formatted measured rows for one file, or undefined when nobody ran it. */
export function measuredNote(file: string): string | undefined {
	const rows = MEASURED[file];
	if (rows === undefined) return undefined;
	return rows
		.map((row) => `ctx ${row.ctx}${row.ncmoe === undefined ? "" : ` --n-cpu-moe ${row.ncmoe}`}: ${row.vramMiB} MiB, ${row.gen} tok/s`)
		.join(" · ");
}
