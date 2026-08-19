/**
 * The fit verdict decides whether an operator launches a configuration that will
 * silently run 8x slower, so its boundaries are worth pinning. Pure arithmetic:
 * no GPU, no engine and no weights are needed to run this.
 */
import { describe, expect, test } from "bun:test";

import { MEASURED } from "../ui/server/catalog.ts";
import { bestFitting, fitFor, HEADROOM_MIB, RUNTIME_MIB, type Fit, type Gpu, type Verdict } from "../ui/server/fit.ts";
import type { GgufInfo } from "../ui/server/gguf.ts";

const MIB = 1024 * 1024;

/** The reference card of docs/benchmarks.md. */
const CARD: Gpu = { index: 0, name: "NVIDIA GeForce RTX 5070 Ti", totalMiB: 16303, usedMiB: 968, freeMiB: 15335 };
const BUDGET = CARD.totalMiB - HEADROOM_MIB;

/** Qwen3-Coder-30B-A3B shape, as read from the real GGUF on the reference box. */
function moeInfo(overrides: Partial<GgufInfo> = {}): GgufInfo {
	return {
		arch: "qwen3moe",
		blockCount: 48,
		headCountKv: 4,
		headCount: 32,
		embeddingLength: 2048,
		keyLength: 128,
		expertCount: 128,
		expertBytes: 15_900 * MIB,
		tensorBytes: 16_845 * MIB,
		...overrides,
	};
}

function denseInfo(overrides: Partial<GgufInfo> = {}): GgufInfo {
	return {
		arch: "llama",
		blockCount: 40,
		headCountKv: 8,
		headCount: 32,
		embeddingLength: 5120,
		keyLength: 128,
		expertBytes: 0,
		tensorBytes: 13_000 * MIB,
		...overrides,
	};
}

describe("fitFor", () => {
	test("a small model that fits reports the budget it fits inside", () => {
		const fit = fitFor({
			file: "tiny.gguf",
			sizeBytes: 469 * MIB,
			info: denseInfo({ blockCount: 24, headCountKv: 2, keyLength: 64 }),
			moe: false,
			ctx: 32768,
			gpu: CARD,
			ramFreeMiB: 40_000,
		});
		expect(fit.verdict).toBe("gpu");
		expect(fit.budgetMiB).toBe(BUDGET);
		expect(fit.suggestion).toBeUndefined();
		expect(fit.detail).toContain(`${RUNTIME_MIB} MiB runtime`);
	});

	test("a measured file and context beats the arithmetic and quotes the run", () => {
		const rows = MEASURED["Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf"];
		const row = rows?.find((candidate) => candidate.ctx === 32768);
		expect(row?.ncmoe).toBe(14);
		const fit = fitFor({
			file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
			sizeBytes: 17665334432,
			info: moeInfo(),
			moe: true,
			ctx: 32768,
			gpu: CARD,
			ramFreeMiB: 40_000,
		});
		// The measured value, not the estimate: profile-sweep.ts actually ran this.
		expect(fit.suggestion).toBe("--n-cpu-moe 14");
		expect(fit.label).toContain("measured");
		expect(fit.detail).toContain("14714 MiB");
		expect(fit.detail).toContain("82.1 tok/s");
	});

	test("an unmeasured context falls back to the estimate and says so", () => {
		const fit = fitFor({
			file: "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf",
			sizeBytes: 17665334432,
			info: moeInfo(),
			moe: true,
			ctx: 16384,
			gpu: CARD,
			ramFreeMiB: 40_000,
		});
		expect(fit.verdict).toBe("offload");
		expect(fit.label).toBe("fits with expert offload");
		expect(fit.suggestion).toMatch(/^--n-cpu-moe \d+$/);
		// Estimated rows still carry the measured note for the file, for comparison.
		expect(fit.measured).toContain("ctx 32768 --n-cpu-moe 14");
	});
	test("expert offload is only offered while some experts stay on the GPU", () => {
		// Weights far past the card: moving every expert layer still would not fit, so
		// claiming "fits with expert offload" would be a lie. What is left is honest —
		// some layers on the GPU, the rest on the CPU.
		const fit = fitFor({
			file: "huge.gguf",
			sizeBytes: 60 * 1024 * MIB,
			info: moeInfo({ expertBytes: 20 * 1024 * MIB, tensorBytes: 60 * 1024 * MIB }),
			moe: true,
			ctx: 32768,
			gpu: CARD,
			ramFreeMiB: 80 * 1024,
		});
		expect(fit.verdict).toBe("partial");
		expect(fit.suggestion).toMatch(/^-ngl \d+$/);
		expect(fit.label).not.toContain("expert");
	});

	test("a dense model over budget gets an -ngl suggestion, not an expert split", () => {
		const fit = fitFor({
			file: "dense-24b.gguf",
			sizeBytes: 22 * 1024 * MIB,
			info: denseInfo(),
			moe: false,
			ctx: 32768,
			gpu: CARD,
			ramFreeMiB: 40_000,
		});
		expect(fit.verdict).toBe("partial");
		expect(fit.suggestion).toMatch(/^-ngl \d+$/);
		const layers = Number.parseInt(fit.suggestion?.split(" ")[1] ?? "-1", 10);
		expect(layers).toBeGreaterThanOrEqual(0);
		expect(layers).toBeLessThan(40);
	});

	test("no GPU means the honest answer is RAM, or nothing", () => {
		const runnable = fitFor({ file: "m.gguf", sizeBytes: 4 * 1024 * MIB, moe: false, ctx: 8192, ramFreeMiB: 32_000 });
		expect(runnable.verdict).toBe("cpu");
		expect(runnable.budgetMiB).toBe(0);
		expect(runnable.detail).toContain("No CUDA device");

		const hopeless = fitFor({ file: "m.gguf", sizeBytes: 400 * 1024 * MIB, moe: false, ctx: 8192, ramFreeMiB: 32_000 });
		expect(hopeless.verdict).toBe("no");
	});

	test("unreadable metadata still yields a verdict, and admits the KV cache is unknown", () => {
		const fit = fitFor({ file: "opaque.gguf", sizeBytes: 2 * 1024 * MIB, moe: false, ctx: 32768, gpu: CARD, ramFreeMiB: 40_000 });
		expect(fit.verdict).toBe("gpu");
		expect(fit.kvMiB).toBeUndefined();
		expect(fit.detail).toContain("unknown KV cache");
	});

	test("the KV cache is what pushes a borderline model over the line", () => {
		const shared = { file: "borderline.gguf", sizeBytes: 13 * 1024 * MIB, info: denseInfo(), moe: false, gpu: CARD, ramFreeMiB: 40_000 };
		const short = fitFor({ ...shared, ctx: 4096 });
		const long = fitFor({ ...shared, ctx: 131072 });
		expect(short.verdict).toBe("gpu");
		expect(long.verdict).toBe("partial");
		expect(long.kvMiB ?? 0).toBeGreaterThan(short.kvMiB ?? 0);
	});
});

/**
 * Which quantisation the browser recommends out of one repository. This is the
 * one number-shaped decision the page makes for the operator, so its order is
 * pinned: a wrong answer here sends someone to a 30 GiB download that pages to
 * host RAM, or to a Q2 when a Q4 would have fitted.
 */
describe("bestFitting", () => {
	function file(name: string, sizeGiB: number, verdict: Verdict) {
		const fit: Fit = { verdict, label: verdict, detail: "", weightsMiB: sizeGiB * 1024, budgetMiB: BUDGET };
		return { rfilename: name, sizeBytes: sizeGiB * 1024 * MIB, fit };
	}

	test("a better verdict wins even when it is the smaller file", () => {
		const best = bestFitting([file("big.gguf", 30, "cpu"), file("small.gguf", 9, "gpu")]);
		expect(best?.rfilename).toBe("small.gguf");
	});

	test("among equal verdicts the largest wins, because it is the better quant", () => {
		const best = bestFitting([file("q3.gguf", 12, "offload"), file("q4.gguf", 16, "offload"), file("q2.gguf", 9, "offload")]);
		expect(best?.rfilename).toBe("q4.gguf");
	});

	test("expert offload beats partial offload, which beats running from RAM", () => {
		expect(bestFitting([file("a.gguf", 20, "partial"), file("b.gguf", 17, "offload")])?.rfilename).toBe("b.gguf");
		expect(bestFitting([file("a.gguf", 20, "cpu"), file("b.gguf", 25, "partial")])?.rfilename).toBe("b.gguf");
	});

	test("a CPU-only set still gets a recommendation, since that machine can still run it", () => {
		expect(bestFitting([file("a.gguf", 20, "cpu"), file("b.gguf", 24, "cpu")])?.rfilename).toBe("b.gguf");
	});

	test("nothing runnable is undefined rather than the least bad option", () => {
		expect(bestFitting([file("huge.gguf", 400, "no"), file("bigger.gguf", 900, "no")])).toBeUndefined();
		expect(bestFitting([])).toBeUndefined();
	});
});
