/**
 * The GGUF reader is what makes a fit verdict possible for a model nobody has
 * benchmarked, so it is checked against a synthesised file with known values and
 * against whatever real weights happen to be installed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { kvCacheMiB, readGguf } from "../ui/server/gguf.ts";

const MIB = 1024 * 1024;

/** Little-endian GGUF v3 writer, just enough to exercise the reader. */
class GgufWriter {
	private readonly chunks: Buffer[] = [];

	u32(value: number): this {
		const buffer = Buffer.allocUnsafe(4);
		buffer.writeUInt32LE(value, 0);
		this.chunks.push(buffer);
		return this;
	}

	u64(value: number): this {
		const buffer = Buffer.allocUnsafe(8);
		buffer.writeBigUInt64LE(BigInt(value), 0);
		this.chunks.push(buffer);
		return this;
	}

	str(value: string): this {
		const bytes = Buffer.from(value, "utf8");
		return this.u64(bytes.length).raw(bytes);
	}

	raw(buffer: Buffer): this {
		this.chunks.push(buffer);
		return this;
	}

	/** key, then value type 4 (uint32), then the value. */
	kvU32(key: string, value: number): this {
		return this.str(key).u32(4).u32(value);
	}

	kvString(key: string, value: string): this {
		return this.str(key).u32(8).str(value);
	}

	/** A fixed-width array the reader must skip without decoding. */
	kvU32Array(key: string, count: number): this {
		this.str(key).u32(9).u32(4).u64(count);
		return this.raw(Buffer.alloc(count * 4));
	}

	tensor(name: string, elements: number, type: number): this {
		return this.str(name).u32(1).u64(elements).u32(type).u64(0);
	}

	build(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

function synthetic(): Buffer {
	const body = new GgufWriter();
	// magic, version, tensor count, metadata count
	body.raw(Buffer.from("GGUF", "latin1")).u32(3).u64(3).u64(8);
	body
		.kvString("general.architecture", "qwen3moe")
		.kvString("general.name", "Synthetic MoE")
		.kvU32("qwen3moe.block_count", 4)
		.kvU32("qwen3moe.attention.head_count", 16)
		.kvU32("qwen3moe.attention.head_count_kv", 2)
		.kvU32("qwen3moe.embedding_length", 1024)
		.kvU32("qwen3moe.attention.key_length", 64)
		// A large fixed-width array stands in for a token vocabulary: the reader must
		// step over it rather than materialise it.
		.kvU32Array("tokenizer.ggml.token_type", 4096);
	// One f32 tensor of 1024 elements plus two q4_K expert tensors of 262144.
	body.tensor("blk.0.attn_q.weight", 1024, 0);
	body.tensor("blk.0.ffn_gate_exps.weight", 262144, 12);
	body.tensor("blk.1.ffn_up_exps.weight", 262144, 12);
	return body.build();
}

describe("readGguf", () => {
	test("reads metadata, separates expert tensors and skips vocabularies", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "gguf-test-"));
		try {
			const file = path.join(dir, "synthetic.gguf");
			writeFileSync(file, synthetic());
			const info = readGguf(file);
			expect(info).toBeDefined();
			expect(info?.arch).toBe("qwen3moe");
			expect(info?.name).toBe("Synthetic MoE");
			expect(info?.blockCount).toBe(4);
			expect(info?.headCountKv).toBe(2);
			expect(info?.keyLength).toBe(64);
			// 2 * 262144 elements at q4_K (144 bytes per 256 values).
			expect(info?.expertBytes).toBeCloseTo(2 * 262144 * (144 / 256), 0);
			// Expert bytes are a subset of all tensor bytes, never the whole file.
			expect(info?.tensorBytes ?? 0).toBeGreaterThan(info?.expertBytes ?? 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a non-GGUF file is undefined rather than a throw", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "gguf-test-"));
		try {
			const file = path.join(dir, "not-a-model.gguf");
			writeFileSync(file, Buffer.from("this is not a model", "utf8"));
			expect(readGguf(file)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a truncated header is undefined, not a partial answer", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "gguf-test-"));
		try {
			const file = path.join(dir, "cut.gguf");
			writeFileSync(file, synthetic().subarray(0, 40));
			expect(readGguf(file)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing file is undefined", () => {
		expect(readGguf(path.join(os.tmpdir(), "definitely-absent-model.gguf"))).toBeUndefined();
	});
});

describe("kvCacheMiB", () => {
	test("scales linearly with context and matches the q8_0 arithmetic", () => {
		const info = { arch: "qwen3moe", blockCount: 48, headCountKv: 4, headCount: 32, keyLength: 128, expertBytes: 0, tensorBytes: 0 };
		const at32k = kvCacheMiB(info, 32768) ?? 0;
		const at64k = kvCacheMiB(info, 65536) ?? 0;
		// 2 (K and V) * 48 layers * 32768 tokens * 4 heads * 128 dims * 34/32 bytes.
		expect(at32k).toBeCloseTo((2 * 48 * 32768 * 4 * 128 * (34 / 32)) / MIB, 1);
		expect(at64k).toBeCloseTo(at32k * 2, 1);
	});

	test("falls back to embedding_length / head_count when key_length is absent", () => {
		const withKeyLength = { arch: "llama", blockCount: 4, headCountKv: 2, headCount: 16, keyLength: 64, expertBytes: 0, tensorBytes: 0 };
		const withoutKeyLength = { arch: "llama", blockCount: 4, headCountKv: 2, headCount: 16, embeddingLength: 1024, expertBytes: 0, tensorBytes: 0 };
		expect(kvCacheMiB(withoutKeyLength, 8192)).toBeCloseTo(kvCacheMiB(withKeyLength, 8192) ?? 0, 6);
	});

	test("no shape means no number, rather than a guess", () => {
		expect(kvCacheMiB({ arch: "unknown", expertBytes: 0, tensorBytes: 0 }, 8192)).toBeUndefined();
	});

	/**
	 * Read out of the real gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf header on
	 * 2026-08-19: 30 layers, KV heads alternating 8/8/8/8/8/2, key and value
	 * length 512, a 1024-token window on every layer the pattern marks, and 256
	 * for those layers' heads.
	 */
	function gemma4() {
		const heads: number[] = [];
		const pattern: boolean[] = [];
		for (let layer = 0; layer < 30; layer++) {
			heads.push(layer % 6 === 5 ? 2 : 8);
			pattern.push(layer % 6 !== 5);
		}
		return {
			arch: "gemma4",
			blockCount: 30,
			headCount: 16,
			headCountKvLayers: heads,
			keyLength: 512,
			valueLength: 512,
			slidingWindow: 1024,
			slidingWindowPattern: pattern,
			keyLengthSwa: 256,
			valueLengthSwa: 256,
			expertBytes: 0,
			tensorBytes: 0,
		};
	}

	test("a windowed layer caches its window, not the whole context", () => {
		// 25 windowed layers: 1024 tokens * 8 heads * (256+256) * 34/32.
		// 5 full layers: 32768 tokens * 2 heads * (512+512) * 34/32.
		const expected = (25 * 1024 * 8 * 512 * (34 / 32) + 5 * 32768 * 2 * 1024 * (34 / 32)) / MIB;
		expect(kvCacheMiB(gemma4(), 32768)).toBeCloseTo(expected, 1);
		// Under half a GiB. Charging every layer the full-attention shape gives
		// 16320 MiB, which would report a model that runs as CPU-only.
		expect(kvCacheMiB(gemma4(), 32768) ?? 0).toBeLessThan(512);
	});

	test("only the full-attention layers grow with context", () => {
		const at32k = kvCacheMiB(gemma4(), 32768) ?? 0;
		const at64k = kvCacheMiB(gemma4(), 65536) ?? 0;
		// Windowed layers are already saturated at 1024 tokens, so doubling the
		// context less than doubles the cache.
		expect(at64k).toBeLessThan(at32k * 2);
		expect(at64k).toBeGreaterThan(at32k);
	});

	test("a window with no published pattern is charged as full attention", () => {
		const { slidingWindowPattern, ...withoutPattern } = gemma4();
		expect(slidingWindowPattern.length).toBe(30);
		// Overstating is the safe direction: nothing here invents which layers window.
		expect(kvCacheMiB(withoutPattern, 32768) ?? 0).toBeGreaterThan(kvCacheMiB(gemma4(), 32768) ?? 0);
	});
});

describe("real weights on this machine", () => {
	const modelsDir = process.env["OG_MODELS_DIR"] ?? path.join(os.homedir(), "models");
	const qwen3 = path.join(modelsDir, "Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf");

	test.skipIf(!existsSync(qwen3))("Qwen3-Coder-30B reads as a 48-layer MoE whose experts dominate the file", () => {
		const info = readGguf(qwen3);
		expect(info?.arch).toBe("qwen3moe");
		expect(info?.blockCount).toBe(48);
		expect(info?.expertCount).toBe(128);
		const size = statSync(qwen3).size;
		// Experts are the bulk of an A3B model: that is why --n-cpu-moe is the knob
		// that decides whether it fits.
		expect(info?.expertBytes ?? 0).toBeGreaterThan(size * 0.7);
		expect(info?.tensorBytes ?? 0).toBeLessThanOrEqual(size);
	});
});
