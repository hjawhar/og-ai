/**
 * The Hugging Face index is the one place in this repository that reads a shape
 * nobody here controls, so its parsing is pinned against recorded responses.
 * Pure: no network, no GPU, no weights. The live calls are verified by hand
 * against huggingface.co, which is what `listRepos`/`model`/`inspect` wrap.
 *
 * Two properties matter beyond "it parses". A quant read wrongly out of a
 * filename offers the operator a file that is not the one they picked, and a
 * split model counted as one shard downloads weights llama.cpp cannot open.
 */
import { describe, expect, test } from "bun:test";

import {
	browseParams,
	DEFAULT_PRESET,
	downloadKeyOf,
	flatName,
	isNotWeights,
	MAX_LIMIT,
	parseModel,
	parseSearch,
	presetOf,
	PRESETS,
	quantOf,
	resolveUrl,
	shardPaths,
	sizeIndex,
	sortOf,
	splitOf,
} from "../ui/server/hub.ts";

/** A trimmed `GET /api/models?...&expand[]=...` response, field-for-field as the Hub sends it. */
const SEARCH_BODY: unknown = [
	{
		_id: "69cd2e52ea37eb5eb635f98a",
		id: "unsloth/gemma-4-31B-it-GGUF",
		gated: false,
		lastModified: "2026-06-05T10:35:42.000Z",
		likes: 581,
		downloads: 507570,
		tags: ["gguf", "gemma4", "unsloth", "google", "base_model:google/gemma-4-31B-it", "license:apache-2.0", "endpoints_compatible", "region:us"],
		pipeline_tag: "image-text-to-text",
	},
	{
		id: "google/gemma-4-31b-it-qat-GGUF",
		gated: "manual",
		likes: 12,
		downloads: 900,
		tags: ["gguf"],
	},
	// No id: not addressable, so not offerable.
	{ likes: 3, downloads: 4 },
];

/** A trimmed `GET /api/models/<id>?blobs=true` response for a repository with split weights. */
const MODEL_BODY: unknown = {
	id: "unsloth/gemma-4-31B-it-GGUF",
	gated: false,
	lastModified: "2026-06-05T10:35:42.000Z",
	likes: 581,
	downloads: 507570,
	tags: ["gguf", "gemma4"],
	// Real shape: this is an MoE, and the Hub still publishes a dense-looking
	// model_type. Nothing in the pre-download path may claim otherwise.
	config: { model_type: "gemma4", architectures: ["Gemma4ForConditionalGeneration"] },
	siblings: [
		{ rfilename: "README.md", size: 8192 },
		{ rfilename: "mmproj-F16.gguf", size: 954843264, lfs: { size: 954843264 } },
		{ rfilename: "MTP/mtp-gemma-4-31B-it-Q8_0.gguf", size: 136, lfs: { size: 461766816 } },
		{ rfilename: "gemma-4-31B-it-imatrix.gguf", size: 136, lfs: { size: 191_889_408 } },
		{ rfilename: "imatrix_unsloth.gguf", size: 136, lfs: { size: 191_889_408 } },
		{ rfilename: "UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00001-of-00002.gguf", size: 136, lfs: { size: 16_000_000_000 } },
		{ rfilename: "UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00002-of-00002.gguf", size: 136, lfs: { size: 4_000_000_000 } },
		{ rfilename: "gemma-4-31B-it-UD-Q2_K_XL.gguf", size: 136, lfs: { size: 11_000_000_000 } },
	],
};

describe("quantOf", () => {
	test("reads every naming scheme these repositories actually use", () => {
		expect(quantOf("Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf")).toBe("UD-Q4_K_XL");
		expect(quantOf("Devstral-Small-2507-Q4_K_M.gguf")).toBe("Q4_K_M");
		expect(quantOf("qwen2.5-coder-7b-instruct-q4_k_m.gguf")).toBe("Q4_K_M");
		expect(quantOf("model-IQ4_XS.gguf")).toBe("IQ4_XS");
		expect(quantOf("mtp-gemma-4-31B-it-BF16.gguf")).toBe("BF16");
		expect(quantOf("gemma-4-31B-it-qat-q4_0-unquantized.gguf")).toBe("Q4_0");
	});

	test("the quant survives being in a directory name and being split", () => {
		expect(quantOf("UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00001-of-00002.gguf")).toBe("UD-Q4_K_XL");
		expect(quantOf("Q8_0/split-00003-of-00009.gguf")).toBe("Q8_0");
	});

	test("a name that publishes no quant says so instead of guessing", () => {
		expect(quantOf("model.gguf")).toBeUndefined();
		expect(quantOf("Qwen3-Coder-30B-A3B-Instruct.gguf")).toBeUndefined();
	});
});

describe("split weights", () => {
	test("a shard resolves to the whole set, in order", () => {
		const paths = shardPaths("UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00002-of-00003.gguf");
		expect(paths).toEqual([
			"UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00001-of-00003.gguf",
			"UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00002-of-00003.gguf",
			"UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00003-of-00003.gguf",
		]);
	});

	test("an unsplit file is a set of one, so callers need no special case", () => {
		expect(splitOf("model-Q4_K_M.gguf")).toBeUndefined();
		expect(shardPaths("model-Q4_K_M.gguf")).toEqual(["model-Q4_K_M.gguf"]);
	});

	test("a four-digit counter is not the gguf-split convention and is left alone", () => {
		expect(splitOf("model-0001-of-0002.gguf")).toBeUndefined();
	});
});

describe("parseSearch", () => {
	test("keeps what the Hub said and drops what cannot be addressed", () => {
		const repos = parseSearch(SEARCH_BODY);
		expect(repos.length).toBe(2);
		const [first, second] = repos;
		expect(first?.id).toBe("unsloth/gemma-4-31B-it-GGUF");
		expect(first?.downloads).toBe(507570);
		expect(first?.gated).toBe(false);
		expect(first?.updatedAt).toBe("2026-06-05T10:35:42.000Z");
		// "manual" is gating: the download will 401 without an accepted licence.
		expect(second?.gated).toBe(true);
	});

	test("machine-generated tags are not shown as if the author chose them", () => {
		const [first] = parseSearch(SEARCH_BODY);
		expect(first?.tags).toEqual(["gemma4", "unsloth", "google"]);
	});

	test("a body that is not a list is a failure, not an empty result", () => {
		expect(() => parseSearch({ error: "nope" })).toThrow();
	});
});

describe("parseModel", () => {
	test("shards collapse into one downloadable row carrying the whole size", () => {
		const model = parseModel(MODEL_BODY);
		const split = model?.files.find((file) => file.shards > 1);
		expect(split?.rfilename).toBe("UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00001-of-00002.gguf");
		expect(split?.file).toBe("gemma-4-31B-it-UD-Q4_K_XL-00001-of-00002.gguf");
		expect(split?.shards).toBe(2);
		// The LFS size, not the 136-byte pointer, and summed across both shards.
		expect(split?.sizeBytes).toBe(20_000_000_000);
		expect(split?.quant).toBe("UD-Q4_K_XL");
	});

	test("only launchable weights are offered, smallest first", () => {
		const model = parseModel(MODEL_BODY);
		expect(model?.files.map((file) => file.quant)).toEqual(["UD-Q2_K_XL", "UD-Q4_K_XL"]);
		// A vision projector, a multi-token-prediction head and an importance matrix
		// are all GGUF and none of them are weights; serve.ts builds no flag for any.
		// They are also small, so left in they would read as the thing on the page
		// that comfortably fits.
		expect(model?.files.some((file) => /mmproj|mtp|imatrix/i.test(file.file))).toBe(false);
		// Nor is a README a model.
		expect(model?.files.some((file) => file.file.endsWith(".md"))).toBe(false);
	});

	test("download keys round-trip to a resolvable URL", () => {
		const model = parseModel(MODEL_BODY);
		const file = model?.files.find((candidate) => candidate.shards > 1);
		expect(file?.downloadKey).toBe(downloadKeyOf("unsloth/gemma-4-31B-it-GGUF", file?.rfilename ?? ""));
		expect(resolveUrl("unsloth/gemma-4-31B-it-GGUF", file?.rfilename ?? "")).toBe(
			"https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/resolve/main/UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00001-of-00002.gguf",
		);
	});
});

describe("sizeIndex", () => {
	test("every GGUF path maps to its object size, so a download total is the Hub's number", () => {
		const sizes = sizeIndex(MODEL_BODY);
		expect(sizes.get("UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00002-of-00002.gguf")).toBe(4_000_000_000);
		expect(sizes.has("README.md")).toBe(false);
	});
});

describe("flatName", () => {
	test("a repository path becomes a filename, because the models dir is flat", () => {
		expect(flatName("UD-Q4_K_XL/gemma-4-31B-it-UD-Q4_K_XL-00001-of-00002.gguf")).toBe("gemma-4-31B-it-UD-Q4_K_XL-00001-of-00002.gguf");
		expect(flatName("model.gguf")).toBe("model.gguf");
	});
});

describe("presets", () => {
	test("the default preset exists and is the agentic coding one the page opens on", () => {
		expect(PRESETS.some((preset) => preset.key === DEFAULT_PRESET)).toBe(true);
		expect(presetOf(DEFAULT_PRESET).tags).toEqual(["gguf", "code", "agent"]);
	});

	test("every preset filters to GGUF, because the engine loads nothing else", () => {
		for (const preset of PRESETS) {
			expect(preset.tags).toContain("gguf");
			// The note is what the UI shows instead of asking anyone to trust the label.
			expect(preset.note.length).toBeGreaterThan(0);
		}
	});

	test("an unknown preset or sort names the accepted values rather than falling back", () => {
		expect(() => presetOf("top-models")).toThrow(/unknown preset 'top-models'.*agentic-coding/s);
		expect(() => sortOf("best")).toThrow(/unknown sort 'best'.*downloads/s);
	});

	test("sort keys map to the Hub's own field names", () => {
		expect(sortOf("trending").field).toBe("trendingScore");
		expect(sortOf("modified").field).toBe("lastModified");
	});
});

describe("browseParams", () => {
	test("a preset's tags all reach the query, ANDed, alongside the expansions", () => {
		const params = browseParams(presetOf("agentic-coding"), "", "downloads", 24);
		// Dropping a tag here would silently widen the list to every GGUF on the Hub.
		expect(params.getAll("filter")).toEqual(["gguf", "code", "agent"]);
		expect(params.get("sort")).toBe("downloads");
		expect(params.get("limit")).toBe("24");
		expect(params.has("search")).toBe(false);
		// `gated` and `lastModified` are absent from the list without these.
		expect(params.getAll("expand[]")).toContain("gated");
		expect(params.getAll("expand[]")).toContain("lastModified");
	});

	test("free text narrows within the preset instead of replacing it", () => {
		const params = browseParams(presetOf("coding"), "qwen3", "likes", 10);
		expect(params.get("search")).toBe("qwen3");
		expect(params.getAll("filter")).toEqual(["gguf", "code"]);
		expect(params.get("sort")).toBe("likes");
	});

	test("the page size is clamped, so no caller can ask the Hub for thousands", () => {
		expect(browseParams(presetOf("trending"), "", "trending", 5000).get("limit")).toBe(String(MAX_LIMIT));
		expect(browseParams(presetOf("trending"), "", "trending", 0).get("limit")).toBe("1");
	});
});

describe("isNotWeights", () => {
	test("auxiliary modules are recognised wherever the publisher put the marker", () => {
		// All four of these are real names seen on the Hub.
		expect(isNotWeights("mmproj-F16.gguf")).toBe(true);
		expect(isNotWeights("MTP/mtp-gemma-4-31B-it-BF16.gguf")).toBe(true);
		expect(isNotWeights("imatrix_unsloth.gguf")).toBe(true);
		expect(isNotWeights("Kwaipilot_KAT-Coder-V2.5-Dev-imatrix.gguf")).toBe(true);
	});

	test("weights whose names merely contain those letters are not excluded", () => {
		expect(isNotWeights("Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf")).toBe(false);
		expect(isNotWeights("Devstral-Small-2507-Q4_K_M.gguf")).toBe(false);
		// A token boundary, not a substring: "mtprompt" is not "mtp".
		expect(isNotWeights("mtprompt-7B-Q4_K_M.gguf")).toBe(false);
	});
});
