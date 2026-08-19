/**
 * "Will this model run well on this card?" — the one question the UI exists to
 * answer before a launch rather than after.
 *
 * The failure being prevented is silent: past roughly 15.4 GiB resident on the
 * reference 16303 MiB card, the driver pages weights to host RAM, `/health` stays
 * green, answers stay correct, and throughput drops ~8x (docs/benchmarks.md §5).
 * So the verdict is not "does it load" — everything loads — but "does it load
 * with enough VRAM left that the driver never starts paging".
 *
 * A measured row for the same file and context always wins over the arithmetic.
 */
import { MEASURED, measuredNote } from "./catalog.ts";
import { kvCacheMiB, type GgufInfo } from "./gguf.ts";

const MIB = 1024 * 1024;

/**
 * Free VRAM every shipped profile is sized to leave. From docs/benchmarks.md §5:
 * the measured spill cliff sits ~386 MiB above the fastest safe configuration and
 * an idle Windows desktop alone holds 968 MiB, so a tighter margin is one browser
 * window away from 8x slower.
 */
export const HEADROOM_MIB = 1200;

/**
 * Runtime VRAM the file size does not account for: CUDA context, compute buffers
 * and the graph allocator. Derived, not picked — Q4_K_XL at ctx 32768 with
 * --n-cpu-moe 14 computes to 13839 MiB of weights plus KV cache and measured
 * 14714 MiB resident, a gap of ~875 MiB.
 */
export const RUNTIME_MIB = 900;

export type Verdict = "gpu" | "offload" | "partial" | "cpu" | "no" | "unknown";

export interface Fit {
	verdict: Verdict;
	label: string;
	/** One sentence of arithmetic, written here so every surface shows the same working. */
	detail: string;
	weightsMiB: number;
	kvMiB?: number;
	budgetMiB: number;
	/** Flag that gets this model under the budget: `--n-cpu-moe N` or `-ngl N`. */
	suggestion?: string;
	measured?: string;
}

export interface Gpu {
	index: number;
	name: string;
	totalMiB: number;
	usedMiB: number;
	freeMiB: number;
}

export interface FitInput {
	file: string;
	sizeBytes: number;
	info?: GgufInfo | undefined;
	moe: boolean;
	ctx: number;
	gpu?: Gpu | undefined;
	ramFreeMiB: number;
}

export function fitFor(input: FitInput): Fit {
	const weightsMiB = input.sizeBytes / MIB;
	const budgetMiB = input.gpu === undefined ? 0 : Math.max(0, input.gpu.totalMiB - HEADROOM_MIB);
	const kv = input.info === undefined ? undefined : kvCacheMiB(input.info, input.ctx);
	const fit: Fit = { verdict: "unknown", label: "unknown", detail: "", weightsMiB, budgetMiB };
	if (kv !== undefined) fit.kvMiB = kv;
	const measured = measuredNote(input.file);
	if (measured !== undefined) fit.measured = measured;

	if (input.gpu === undefined) return withoutGpu(fit, weightsMiB, input.ramFreeMiB);

	const exact = (MEASURED[input.file] ?? []).find((row) => row.ctx === input.ctx);
	if (exact !== undefined) {
		fit.verdict = exact.ncmoe === undefined ? "gpu" : "offload";
		fit.label = exact.ncmoe === undefined ? "fits on the GPU (measured)" : "fits with expert offload (measured)";
		if (exact.ncmoe !== undefined) fit.suggestion = `--n-cpu-moe ${exact.ncmoe}`;
		fit.detail =
			`Measured on the reference 16303 MiB card: ${exact.vramMiB} MiB resident at ctx ${exact.ctx}` +
			`${exact.ncmoe === undefined ? " with every layer on the GPU" : ` with --n-cpu-moe ${exact.ncmoe}`}, ` +
			`${exact.prefill} tok/s prefill and ${exact.gen} tok/s generation. This card has ${input.gpu.totalMiB} MiB.`;
		return fit;
	}

	const need = weightsMiB + (kv ?? 0) + RUNTIME_MIB;
	const kvText = kv === undefined ? "an unknown KV cache (metadata unreadable)" : `${fmtMiB(kv)} KV at ctx ${input.ctx}`;
	if (need <= budgetMiB) {
		fit.verdict = "gpu";
		fit.label = "fits on the GPU";
		fit.detail = `${fmtMiB(weightsMiB)} weights + ${kvText} + ${RUNTIME_MIB} MiB runtime = ${fmtMiB(need)}, inside the ${fmtMiB(budgetMiB)} budget.`;
		return fit;
	}

	const overflow = need - budgetMiB;
	const layers = input.info?.blockCount ?? 0;
	const expertBytes = input.info?.expertBytes ?? 0;
	if (input.moe && layers > 0 && expertBytes > 0) {
		const perLayerMiB = expertBytes / MIB / layers;
		const layersToMove = Math.min(layers, Math.ceil(overflow / perLayerMiB));
		if (layersToMove < layers) {
			fit.verdict = "offload";
			fit.label = "fits with expert offload";
			fit.suggestion = `--n-cpu-moe ${layersToMove}`;
			fit.detail =
				`${fmtMiB(weightsMiB)} weights + ${kvText} + ${RUNTIME_MIB} MiB runtime overshoots the ${fmtMiB(budgetMiB)} budget ` +
				`by ${fmtMiB(overflow)}. Moving ${layersToMove} of ${layers} expert layers to the CPU (${fmtMiB(perLayerMiB)} each) covers it.`;
			return fit;
		}
	}

	if (layers > 0 && kv !== undefined && kv + RUNTIME_MIB < budgetMiB) {
		const perLayerMiB = weightsMiB / layers;
		const layersOnGpu = Math.max(0, Math.floor((budgetMiB - kv - RUNTIME_MIB) / perLayerMiB));
		fit.verdict = "partial";
		fit.label = "partial offload only";
		fit.suggestion = `-ngl ${layersOnGpu}`;
		fit.detail =
			`Only ${layersOnGpu} of ${layers} layers fit beside a ${fmtMiB(kv)} KV cache inside the ${fmtMiB(budgetMiB)} budget. ` +
			`Measured cost of partial offload on the dense 24B: 0.49x generation at half the layers, 0.27x at a third.`;
		return fit;
	}

	return withoutGpu(fit, weightsMiB, input.ramFreeMiB, budgetMiB);
}

function withoutGpu(fit: Fit, weightsMiB: number, ramFreeMiB: number, budgetMiB?: number): Fit {
	const runnable = weightsMiB < ramFreeMiB;
	fit.verdict = runnable ? "cpu" : "no";
	fit.label = runnable ? "CPU only" : "too large for this machine";
	if (budgetMiB === undefined) {
		fit.detail = runnable
			? `No CUDA device visible. ${fmtMiB(weightsMiB)} of weights would run from RAM, roughly two orders of magnitude slower.`
			: `No CUDA device, and ${fmtMiB(weightsMiB)} of weights exceeds ${fmtMiB(ramFreeMiB)} of free RAM.`;
		return fit;
	}
	fit.detail = runnable
		? `${fmtMiB(weightsMiB)} of weights against a ${fmtMiB(budgetMiB)} VRAM budget: it would run from RAM at a fraction of the speed.`
		: `${fmtMiB(weightsMiB)} of weights exceeds both the ${fmtMiB(budgetMiB)} VRAM budget and ${fmtMiB(ramFreeMiB)} of free RAM.`;
	return fit;
}

export function fmtMiB(value: number): string {
	return value >= 1024 ? `${(value / 1024).toFixed(2)} GiB` : `${Math.round(value)} MiB`;
}
