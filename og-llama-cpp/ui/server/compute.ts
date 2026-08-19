/**
 * Peak arithmetic throughput of the installed card — the ceiling a measured
 * tok/s can be read against, so "43 tok/s" can be seen for what it is: a
 * memory-bandwidth result on a card with 175 TFLOPS of idle tensor cores.
 *
 * This is the one file in the repository holding numbers nobody measured here,
 * and it is confined to a single shape: a peak derived from a published SM count
 * and rated boost clock. Nothing here belongs in docs/benchmarks.md, which stays
 * a record of real runs, and the UI labels every figure "peak".
 *
 * Two of the three inputs cannot come from the machine:
 *  - SM count. `nvidia-smi --help-query-gpu` has no field for it (checked on the
 *    reference box: the closest are `clocks.sm` and `clocks.max.sm`), `nvidia-smi
 *    -q` prints only the architecture name, and the engine's `--list-devices`
 *    prints name plus memory.
 *  - Rated boost clock. `clocks.max.sm` reports 3090 MHz on the reference
 *    RTX 5070 Ti against a rated 2452 MHz boost, so deriving peaks from the live
 *    clock query would overstate every figure by 26%.
 * Hence the table. A card that is not in it returns undefined and the UI omits
 * the line: a missing peak is a gap, a guessed one is a lie.
 */

/**
 * Dense per-SM-per-clock issue rates. Identical across every consumer generation
 * covered here, which is why they are constants rather than a per-architecture
 * table: solving NVIDIA's own published peaks for FLOP/SM/clk lands on the same
 * four numbers on Ampere GA10x, Ada AD10x and Blackwell GB20x.
 *
 *   RTX 5090, 170 SM @ 2.407 GHz: 104.8 FP32 -> 256.1, 419 dense FP16 -> 1024.0,
 *     209.5 dense FP16/FP32-acc -> 512.0, 838 dense INT8 -> 2048.0
 *   RTX 4090, 128 SM @ 2.52 GHz:  82.6 -> 256.0, 330.3 -> 1024.0, 165.2 -> 512.0, 660.6 -> 2048.0
 *   RTX 3090 Ti, 84 SM @ 1.86 GHz: 40 -> 256.0, 160 -> 1024.1, 80 -> 512.0, 320 -> 2048.1
 *
 * Sources: NVIDIA RTX Blackwell GPU Architecture whitepaper (Appendix A/B/C),
 * NVIDIA Ada GPU Architecture whitepaper (Table 1, Appendix A/B), NVIDIA Ampere
 * GA102 whitepaper (Appendix A Tables 9-10).
 */
const DENSE = {
	/** CUDA cores: 128 FP32 lanes x 2 for the FMA. */
	fp32: 256,
	/** Tensor cores, FP16/BF16 in with FP16 accumulate — the figure spec sheets publish. */
	fp16: 1024,
	/**
	 * Same inputs, FP32 accumulate: GeForce halves that path, and it is the one
	 * cuBLAS and llama.cpp's f16 kernels take, so it is the rate a matmul here
	 * can actually reach. BF16 always accumulates in FP32, so it lands here too.
	 */
	fp16Fp32Acc: 512,
	/** Tensor cores, INT8 in with INT32 accumulate. No accumulate split. */
	int8: 2048,
} as const;

/**
 * Architecture per CUDA compute capability, as `nvidia-smi --query-gpu=compute_cap`
 * reports it. Deliberately only the three whose per-SM rates are verified above:
 * Hopper and datacenter Blackwell issue different rates, so an unrecognised
 * capability yields no peak rather than a wrong one.
 */
const ARCH: Readonly<Record<string, string>> = {
	"8.6": "Ampere 3rd-gen tensor cores",
	"8.9": "Ada Lovelace 4th-gen tensor cores",
	"12.0": "Blackwell 5th-gen tensor cores",
};

interface CardSpec {
	readonly sm: number;
	/** Rated boost clock in GHz — NVIDIA's peaks are all quoted at boost. */
	readonly boostGhz: number;
}

/**
 * SM count and rated boost clock per card, keyed by the exact name
 * `nvidia-smi --query-gpu=name` prints. Reference/Founders clocks only; a
 * factory-OC board runs faster than the peak shown here.
 *
 * Every row is cross-checked against NVIDIA's own published FP32 TFLOPS in
 * test/compute.test.ts. Cards NVIDIA never published a checkable peak for are
 * left out: RTX 3070 Ti, 3060 Ti and 3060 (no precise FP32 figure anywhere in
 * the GA102 whitepaper, the product pages or the launch articles), and RTX 3080,
 * whose 10 GB and 12 GB boards differ by two SMs while `nvidia-smi` prints one
 * name for both.
 */
const CARDS: Readonly<Record<string, CardSpec>> = {
	// Blackwell GB20x — whitepaper Appendix A/B/C for the top four; videocardz
	// spec database cross-checked against NVIDIA's compare page for the rest.
	"NVIDIA GeForce RTX 5090": { sm: 170, boostGhz: 2.407 },
	"NVIDIA GeForce RTX 5080": { sm: 84, boostGhz: 2.617 },
	"NVIDIA GeForce RTX 5070 Ti": { sm: 70, boostGhz: 2.452 },
	"NVIDIA GeForce RTX 5070": { sm: 48, boostGhz: 2.512 },
	"NVIDIA GeForce RTX 5060 Ti": { sm: 36, boostGhz: 2.572 },
	"NVIDIA GeForce RTX 5060": { sm: 30, boostGhz: 2.497 },
	"NVIDIA GeForce RTX 5050": { sm: 20, boostGhz: 2.572 },
	// Ada AD10x — whitepaper for the 4090/4080, NVIDIA's compare page for the
	// rest (SM = CUDA cores / 128, which both whitepapers state as fixed).
	"NVIDIA GeForce RTX 4090": { sm: 128, boostGhz: 2.52 },
	"NVIDIA GeForce RTX 4080 SUPER": { sm: 80, boostGhz: 2.55 },
	"NVIDIA GeForce RTX 4080": { sm: 76, boostGhz: 2.505 },
	"NVIDIA GeForce RTX 4070 Ti SUPER": { sm: 66, boostGhz: 2.61 },
	"NVIDIA GeForce RTX 4070 Ti": { sm: 60, boostGhz: 2.61 },
	"NVIDIA GeForce RTX 4070 SUPER": { sm: 56, boostGhz: 2.475 },
	"NVIDIA GeForce RTX 4070": { sm: 46, boostGhz: 2.475 },
	"NVIDIA GeForce RTX 4060 Ti": { sm: 34, boostGhz: 2.535 },
	"NVIDIA GeForce RTX 4060": { sm: 24, boostGhz: 2.46 },
	// Ampere GA10x — GA102 whitepaper, plus the Ada whitepaper's comparison column.
	"NVIDIA GeForce RTX 3090 Ti": { sm: 84, boostGhz: 1.86 },
	"NVIDIA GeForce RTX 3090": { sm: 82, boostGhz: 1.695 },
	"NVIDIA GeForce RTX 3080 Ti": { sm: 80, boostGhz: 1.665 },
	"NVIDIA GeForce RTX 3070": { sm: 46, boostGhz: 1.725 },
};

/** Case- and whitespace-insensitive lookup, built once. */
const BY_NAME = new Map<string, CardSpec>(Object.entries(CARDS).map(([name, spec]) => [nameKey(name), spec]));

export interface ComputePeak {
	/** Architecture and tensor-core generation, for the note under the numbers. */
	readonly arch: string;
	readonly sm: number;
	readonly boostGhz: number;
	/** CUDA cores, FP32 FMA. */
	readonly fp32Tflops: number;
	/** Tensor cores, dense FP16 with FP16 accumulate. */
	readonly fp16Tflops: number;
	/** Tensor cores, dense FP16/BF16 with FP32 accumulate: half of `fp16Tflops` on GeForce. */
	readonly fp16Fp32AccTflops: number;
	/** Tensor cores, dense INT8. Sparsity would double it; llama.cpp uses none. */
	readonly int8Tops: number;
}

/**
 * Peak throughput for a card, or undefined when either the model or its compute
 * capability is unknown. Both inputs come straight from `nvidia-smi`.
 */
export function computePeak(name: string, computeCap: string): ComputePeak | undefined {
	const card = BY_NAME.get(nameKey(name));
	const arch = ARCH[computeCap.trim()];
	if (card === undefined || arch === undefined) {
		return undefined;
	}
	// SMs x GHz x FLOP/clk gives GFLOP/s; /1000 for TFLOP/s (and OP/s -> TOP/s).
	const smGhz = card.sm * card.boostGhz;
	return {
		arch,
		sm: card.sm,
		boostGhz: card.boostGhz,
		fp32Tflops: round1((smGhz * DENSE.fp32) / 1000),
		fp16Tflops: round1((smGhz * DENSE.fp16) / 1000),
		fp16Fp32AccTflops: round1((smGhz * DENSE.fp16Fp32Acc) / 1000),
		int8Tops: round1((smGhz * DENSE.int8) / 1000),
	};
}

function nameKey(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** One decimal: NVIDIA publishes these to three significant figures at most. */
function round1(value: number): number {
	return Math.round(value * 10) / 10;
}
