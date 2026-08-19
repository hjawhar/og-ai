/**
 * Just enough GGUF reading to answer "does this fit": the metadata that sizes a
 * KV cache, and the tensor table so MoE expert weights can be separated from the
 * rest (they are what `--n-cpu-moe` moves to the CPU).
 *
 * Format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md — magic,
 * version, tensor count, KV count, then the metadata pairs, then one record per
 * tensor. Tensor *data* follows all of that, so the head of the file is enough
 * and a 17 GiB model costs one 4 MiB read.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

const MIB = 1024 * 1024;

export interface GgufInfo {
	arch: string;
	name?: string;
	blockCount?: number;
	headCountKv?: number;
	headCount?: number;
	embeddingLength?: number;
	keyLength?: number;
	trainedContext?: number;
	expertCount?: number;
	/** Bytes of MoE expert tensors, summed from the tensor table. */
	expertBytes: number;
	/** Bytes of every tensor, as a cross-check against the file size. */
	tensorBytes: number;
}

type GgufValue = string | number | bigint | boolean | GgufValue[];

/** GGUF scalar type ids mapped to their width in bytes. */
const SCALAR_WIDTH: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;

/**
 * Bytes per weight for the ggml types that appear in shipped GGUFs: block quants
 * store a fixed-size struct per block, so this is block bytes over block
 * elements. Used only to size expert tensors, where a few percent of error
 * changes no verdict.
 */
const BYTES_PER_ELEMENT: Record<number, number> = {
	0: 4, // f32
	1: 2, // f16
	2: 18 / 32, // q4_0
	3: 20 / 32, // q4_1
	6: 22 / 32, // q5_0
	7: 24 / 32, // q5_1
	8: 34 / 32, // q8_0
	9: 36 / 32, // q8_1
	10: 84 / 256, // q2_K
	11: 110 / 256, // q3_K
	12: 144 / 256, // q4_K
	13: 176 / 256, // q5_K
	14: 210 / 256, // q6_K
	15: 292 / 256, // q8_K
	16: 66 / 256, // iq2_xxs
	17: 74 / 256, // iq2_xs
	18: 98 / 256, // iq3_xxs
	19: 82 / 256, // iq1_s
	20: 50 / 32, // iq4_nl
	21: 110 / 256, // iq3_s
	22: 82 / 256, // iq2_s
	23: 136 / 256, // iq4_xs
	24: 1, // i8
	25: 2, // i16
	26: 4, // i32
	30: 2, // bf16
};

/**
 * q8_0 stores 32 values in 34 bytes, and q8_0 is the KV cache type serve.ts asks
 * for — halving cache VRAM against f16 at no measurable quality cost is what
 * decides whether the weights fit on this card.
 */
const KV_BYTES_PER_ELEM = 34 / 32;

/** Metadata plus the tensor table, or undefined when the file is not readable GGUF. */
export function readGguf(file: string): GgufInfo | undefined {
	// A 4 MiB head covers every model tried here; the retry exists because the
	// tensor table grows with tensor count and a 235B model would overflow it.
	for (const window of [4 * MIB, 48 * MIB]) {
		let buffer: Buffer;
		try {
			buffer = readHead(file, window);
		} catch {
			return undefined;
		}
		const info = parse(buffer);
		if (info !== undefined) return info;
		if (buffer.length < window) return undefined; // whole file read, still unparseable
	}
	return undefined;
}

function readHead(file: string, bytes: number): Buffer {
	const size = statSync(file).size;
	const want = Math.min(bytes, size);
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(want);
		const read = readSync(fd, buffer, 0, want, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

/** Returns undefined when the buffer ends mid-structure, so the caller can retry larger. */
function parse(buffer: Buffer): GgufInfo | undefined {
	if (buffer.length < 24 || buffer.toString("latin1", 0, 4) !== "GGUF") return undefined;
	const version = buffer.readUInt32LE(4);
	if (version < 2 || version > 3) return undefined;
	const tensorCount = Number(buffer.readBigUInt64LE(8));
	const kvCount = Number(buffer.readBigUInt64LE(16));
	let offset = 24;

	const metadata = new Map<string, GgufValue>();
	for (let index = 0; index < kvCount; index++) {
		const key = readString(buffer, offset);
		if (key === undefined) return undefined;
		const value = readValue(buffer, key.next);
		if (value === undefined) return undefined;
		metadata.set(key.value, value.value);
		offset = value.next;
	}

	let expertBytes = 0;
	let tensorBytes = 0;
	for (let index = 0; index < tensorCount; index++) {
		const name = readString(buffer, offset);
		if (name === undefined) return undefined;
		offset = name.next;
		if (offset + 4 > buffer.length) return undefined;
		const dims = buffer.readUInt32LE(offset);
		offset += 4;
		// dims * u64 shape, then u32 type, then u64 data offset.
		if (offset + dims * 8 + 12 > buffer.length) return undefined;
		let elements = 1;
		for (let dim = 0; dim < dims; dim++) {
			elements *= Number(buffer.readBigUInt64LE(offset));
			offset += 8;
		}
		const type = buffer.readUInt32LE(offset);
		offset += 12;
		const bytes = elements * (BYTES_PER_ELEMENT[type] ?? 0.5);
		tensorBytes += bytes;
		// llama.cpp names fused expert tensors `blk.N.ffn_{gate,up,down}_exps.weight`.
		if (name.value.includes("_exps.")) expertBytes += bytes;
	}

	const archValue = metadata.get("general.architecture");
	const arch = typeof archValue === "string" ? archValue : "unknown";
	const info: GgufInfo = { arch, expertBytes, tensorBytes };
	const name = metadata.get("general.name");
	if (typeof name === "string" && name.length > 0) info.name = name;

	const number = (suffix: string): number | undefined => {
		const value = metadata.get(`${arch}.${suffix}`);
		if (typeof value === "number") return value;
		if (typeof value === "bigint") return Number(value);
		return undefined;
	};
	const blockCount = number("block_count");
	if (blockCount !== undefined) info.blockCount = blockCount;
	const headCountKv = number("attention.head_count_kv");
	if (headCountKv !== undefined) info.headCountKv = headCountKv;
	const headCount = number("attention.head_count");
	if (headCount !== undefined) info.headCount = headCount;
	const embeddingLength = number("embedding_length");
	if (embeddingLength !== undefined) info.embeddingLength = embeddingLength;
	const keyLength = number("attention.key_length");
	if (keyLength !== undefined) info.keyLength = keyLength;
	const trainedContext = number("context_length");
	if (trainedContext !== undefined) info.trainedContext = trainedContext;
	const expertCount = number("expert_count");
	if (expertCount !== undefined) info.expertCount = expertCount;
	return info;
}

function readString(buffer: Buffer, offset: number): { value: string; next: number } | undefined {
	if (offset + 8 > buffer.length) return undefined;
	const length = Number(buffer.readBigUInt64LE(offset));
	const start = offset + 8;
	if (start + length > buffer.length) return undefined;
	return { value: buffer.toString("utf8", start, start + length), next: start + length };
}

function readValue(buffer: Buffer, offset: number): { value: GgufValue; next: number } | undefined {
	if (offset + 4 > buffer.length) return undefined;
	return readTyped(buffer, offset + 4, buffer.readUInt32LE(offset));
}

function readTyped(buffer: Buffer, offset: number, type: number): { value: GgufValue; next: number } | undefined {
	if (type === TYPE_STRING) return readString(buffer, offset);
	if (type === TYPE_ARRAY) {
		if (offset + 12 > buffer.length) return undefined;
		const itemType = buffer.readUInt32LE(offset);
		const count = Number(buffer.readBigUInt64LE(offset + 4));
		let cursor = offset + 12;
		const width = SCALAR_WIDTH[itemType];
		if (width !== undefined) {
			// Fixed-width items: skip the block instead of decoding 150k token scores.
			const end = cursor + width * count;
			if (end > buffer.length) return undefined;
			return { value: [], next: end };
		}
		for (let index = 0; index < count; index++) {
			const item = readTyped(buffer, cursor, itemType);
			if (item === undefined) return undefined;
			cursor = item.next;
		}
		return { value: [], next: cursor };
	}
	const width = SCALAR_WIDTH[type];
	if (width === undefined || offset + width > buffer.length) return undefined;
	const next = offset + width;
	switch (type) {
		case 0:
			return { value: buffer.readUInt8(offset), next };
		case 1:
			return { value: buffer.readInt8(offset), next };
		case 2:
			return { value: buffer.readUInt16LE(offset), next };
		case 3:
			return { value: buffer.readInt16LE(offset), next };
		case 4:
			return { value: buffer.readUInt32LE(offset), next };
		case 5:
			return { value: buffer.readInt32LE(offset), next };
		case 6:
			return { value: buffer.readFloatLE(offset), next };
		case 7:
			return { value: buffer.readUInt8(offset) !== 0, next };
		case 10:
			return { value: buffer.readBigUInt64LE(offset), next };
		case 11:
			return { value: buffer.readBigInt64LE(offset), next };
		case 12:
			return { value: buffer.readDoubleLE(offset), next };
		default:
			return undefined;
	}
}

/**
 * MiB the q8_0 KV cache needs at `ctx`: K and V, one entry per token per KV head
 * per layer. Undefined when the metadata does not carry the shape.
 */
export function kvCacheMiB(info: GgufInfo, ctx: number): number | undefined {
	const layers = info.blockCount;
	const heads = info.headCountKv ?? info.headCount;
	const headDim =
		info.keyLength ??
		(info.embeddingLength !== undefined && info.headCount !== undefined && info.headCount > 0
			? info.embeddingLength / info.headCount
			: undefined);
	if (layers === undefined || heads === undefined || headDim === undefined) return undefined;
	return (2 * layers * ctx * heads * headDim * KV_BYTES_PER_ELEM) / MIB;
}
