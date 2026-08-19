/**
 * What the UI offers to download, and what has actually been measured.
 *
 * Both tables are data, not logic: the catalogue is a short curated list rather
 * than a mirror of Hugging Face, and MEASURED is a verbatim copy of the chosen
 * rows of docs/benchmarks.md §4. Changing a MEASURED number without re-running
 * tools/profile-sweep.ts makes the measurement record a lie.
 */

export interface CatalogEntry {
	key: string;
	name: string;
	/** Parameter count as published; MoE models keep only a few billion active. */
	params: string;
	quant: string;
	moe: boolean;
	file: string;
	url: string;
	/** content-length of the URL above, verified by HEAD on 2026-08-19. */
	sizeBytes: number;
	note: string;
}

export interface MeasuredRow {
	ctx: number;
	ncmoe?: number;
	vramMiB: number;
	prefill: number;
	gen: number;
}

const QWEN3_REPO = "https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main";

export const CATALOG: CatalogEntry[] = [
	{
		key: "qwen3-coder-30b-q4",
		name: "Qwen3-Coder-30B-A3B-Instruct",
		params: "30B MoE (~3B active)",
		quant: "UD-Q4_K_XL",
		moe: true,
		file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
		url: `${QWEN3_REPO}/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf`,
		sizeBytes: 17665334432,
		note: "The measured default: ctx 32768 at --n-cpu-moe 14 -> 14714 MiB, 82.1 tok/s.",
	},
	{
		key: "qwen3-coder-30b-q3",
		name: "Qwen3-Coder-30B-A3B-Instruct",
		params: "30B MoE (~3B active)",
		quant: "UD-Q3_K_XL",
		moe: true,
		file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf",
		url: `${QWEN3_REPO}/Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf`,
		sizeBytes: 13806312608,
		note: "1.7x faster than Q4 (136.5 tok/s measured), measurably looser at structured output.",
	},
	{
		key: "devstral-24b-q4",
		name: "Devstral-Small-2507",
		params: "24B dense",
		quant: "Q4_K_M",
		moe: false,
		file: "Devstral-Small-2507-Q4_K_M.gguf",
		url: "https://huggingface.co/unsloth/Devstral-Small-2507-GGUF/resolve/main/Devstral-Small-2507-Q4_K_M.gguf",
		sizeBytes: 14333918432,
		note: "Dense: full offload leaves room for only 8k of q8_0 KV on 16 GiB (51.3 tok/s measured).",
	},
	{
		key: "qwen2.5-coder-14b-q4",
		name: "Qwen2.5-Coder-14B-Instruct",
		params: "14B dense",
		quant: "Q4_K_M",
		moe: false,
		file: "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
		url: "https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
		sizeBytes: 8988111072,
		note: "Not benchmarked here. Dense and small enough to leave real KV room.",
	},
	{
		key: "qwen2.5-coder-7b-q4",
		name: "Qwen2.5-Coder-7B-Instruct",
		params: "7B dense",
		quant: "Q4_K_M",
		moe: false,
		file: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
		url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
		sizeBytes: 4683073536,
		note: "Not benchmarked here. Fits with a large KV cache on any 8 GiB+ card.",
	},
	{
		key: "qwen2.5-coder-0.5b-q4",
		name: "Qwen2.5-Coder-0.5B-Instruct",
		params: "0.5B dense",
		quant: "Q4_K_M",
		moe: false,
		file: "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
		url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
		sizeBytes: 491400064,
		note: "Smoke target: loads in under a second, useless for real work.",
	},
];

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
