/**
 * The peak table is the one place here holding numbers nobody measured on this
 * box, so it is pinned against NVIDIA's own published figures: every row must
 * reproduce the FP32 TFLOPS the vendor prints for that card from nothing but its
 * SM count and rated boost clock. A typo in an SM count or a clock shows up as a
 * failure here rather than as a plausible-looking wrong number in the UI.
 *
 * Pure arithmetic: no GPU and no nvidia-smi are needed to run this.
 */
import { describe, expect, test } from "bun:test";

import { computePeak } from "../ui/server/compute.ts";

/**
 * NVIDIA's published peak FP32 (non-tensor, "shader") TFLOPS per card.
 *
 * Sources: RTX Blackwell GPU Architecture whitepaper Appendix A/B/C (5090, 5080,
 * 5070 Ti, 5070); videocardz spec database cross-checked against NVIDIA's compare
 * page (5060 Ti, 5060, 5050); Ada GPU Architecture whitepaper Table 1 and
 * Appendix A/B (4090, 4080, 3090 Ti, 3080 Ti); NVIDIA's compare page, which
 * prints "Ada Lovelace <n> TFLOPS" (4080 SUPER, 4070 Ti SUPER, 4070 Ti, 4070
 * SUPER, 4070, 4060 Ti, 4060); Ampere GA102 whitepaper Appendix A Tables 9-10
 * (3090, 3070).
 */
const PUBLISHED_FP32: Readonly<Record<string, number>> = {
	"NVIDIA GeForce RTX 5090": 104.8,
	"NVIDIA GeForce RTX 5080": 56.3,
	"NVIDIA GeForce RTX 5070 Ti": 43.9,
	"NVIDIA GeForce RTX 5070": 30.9,
	"NVIDIA GeForce RTX 5060 Ti": 23.7,
	"NVIDIA GeForce RTX 5060": 19.2,
	"NVIDIA GeForce RTX 5050": 13.2,
	"NVIDIA GeForce RTX 4090": 82.6,
	"NVIDIA GeForce RTX 4080 SUPER": 52,
	"NVIDIA GeForce RTX 4080": 48.7,
	"NVIDIA GeForce RTX 4070 Ti SUPER": 44,
	"NVIDIA GeForce RTX 4070 Ti": 40,
	"NVIDIA GeForce RTX 4070 SUPER": 36,
	"NVIDIA GeForce RTX 4070": 29,
	"NVIDIA GeForce RTX 4060 Ti": 22,
	"NVIDIA GeForce RTX 4060": 15,
	"NVIDIA GeForce RTX 3090 Ti": 40,
	"NVIDIA GeForce RTX 3090": 35.6,
	"NVIDIA GeForce RTX 3080 Ti": 34.1,
	"NVIDIA GeForce RTX 3070": 20.3,
};

/** Compute capability per generation, as `nvidia-smi --query-gpu=compute_cap` prints it. */
function capOf(name: string): string {
	if (name.includes("RTX 50")) return "12.0";
	return name.includes("RTX 40") ? "8.9" : "8.6";
}

describe("published FP32 peaks", () => {
	/**
	 * 1.5%, not 1%: NVIDIA prints shader TFLOPS to two significant figures on the
	 * compare page, and the RTX 4070 SUPER's "36 TFLOPS" is a rounded 35.5. The
	 * whitepaper-sourced rows all land inside 0.11%.
	 */
	for (const [name, published] of Object.entries(PUBLISHED_FP32)) {
		test(name, () => {
			const peak = computePeak(name, capOf(name));
			expect(peak).toBeDefined();
			const derived = peak?.fp32Tflops ?? 0;
			expect(Math.abs(derived - published) / published).toBeLessThan(0.015);
		});
	}
});

describe("published dense tensor peaks", () => {
	/**
	 * One anchor per generation, from the same whitepaper tables: FP16 with FP16
	 * accumulate, FP16 with FP32 accumulate, and INT8. Sparsity doubles all three
	 * in NVIDIA's marketing figures and is excluded here.
	 */
	const anchors = [
		{ name: "NVIDIA GeForce RTX 5090", cap: "12.0", fp16: 419, fp16Fp32Acc: 209.5, int8: 838 },
		{ name: "NVIDIA GeForce RTX 4090", cap: "8.9", fp16: 330.3, fp16Fp32Acc: 165.2, int8: 660.6 },
		{ name: "NVIDIA GeForce RTX 3090 Ti", cap: "8.6", fp16: 160, fp16Fp32Acc: 80, int8: 320 },
	];

	for (const anchor of anchors) {
		test(anchor.name, () => {
			const peak = computePeak(anchor.name, anchor.cap);
			expect(peak).toBeDefined();
			expect(peak?.fp16Tflops).toBeCloseTo(anchor.fp16, 0);
			expect(peak?.fp16Fp32AccTflops).toBeCloseTo(anchor.fp16Fp32Acc, 0);
			expect(peak?.int8Tops).toBeCloseTo(anchor.int8, 0);
		});
	}

	test("GeForce halves FP16 with FP32 accumulate, and int8 is 8x the shaders", () => {
		const peak = computePeak("NVIDIA GeForce RTX 5070 Ti", "12.0");
		expect(peak).toBeDefined();
		if (peak === undefined) return;
		// Each figure is rounded to one decimal on its own, so the per-SM ratios
		// (x2, x4, x8) survive only to within that rounding, not exactly.
		const ratio = (a: number, b: number): number => Math.abs(a - b) / b;
		expect(ratio(peak.fp16Fp32AccTflops, peak.fp16Tflops / 2)).toBeLessThan(0.005);
		expect(ratio(peak.fp16Tflops, peak.fp32Tflops * 4)).toBeLessThan(0.005);
		expect(ratio(peak.int8Tops, peak.fp32Tflops * 8)).toBeLessThan(0.005);
	});
});

describe("the reference card", () => {
	test("matches the whitepaper row for the box in docs/benchmarks.md", () => {
		expect(computePeak("NVIDIA GeForce RTX 5070 Ti", "12.0")).toEqual({
			arch: "Blackwell 5th-gen tensor cores",
			sm: 70,
			boostGhz: 2.452,
			fp32Tflops: 43.9,
			fp16Tflops: 175.8,
			fp16Fp32AccTflops: 87.9,
			int8Tops: 351.5,
		});
	});

	test("tolerates the casing and spacing of any nvidia-smi build", () => {
		const canonical = computePeak("NVIDIA GeForce RTX 5070 Ti", "12.0");
		expect(computePeak("  nvidia geforce rtx 5070 ti ", " 12.0 ")).toEqual(canonical);
		expect(computePeak("NVIDIA  GeForce   RTX 5070 Ti", "12.0")).toEqual(canonical);
	});
});

describe("refusing to guess", () => {
	test("an unlisted card has no peak", () => {
		// GTX 1080 Ti: Pascal, no tensor cores, and deliberately not in the table.
		expect(computePeak("NVIDIA GeForce GTX 1080 Ti", "6.1")).toBeUndefined();
	});

	test("a listed card on an unverified capability has no peak", () => {
		// Hopper and datacenter Blackwell issue different per-SM rates, so an
		// unknown capability must not borrow the consumer ones.
		expect(computePeak("NVIDIA GeForce RTX 5070 Ti", "9.0")).toBeUndefined();
		expect(computePeak("NVIDIA GeForce RTX 5070 Ti", "")).toBeUndefined();
	});

	test("RTX 3080 stays out: one name, two SM counts", () => {
		// The 10 GB board is 68 SM and the 12 GB board is 70 SM, and nvidia-smi
		// prints "NVIDIA GeForce RTX 3080" for both.
		expect(computePeak("NVIDIA GeForce RTX 3080", "8.6")).toBeUndefined();
	});
});
