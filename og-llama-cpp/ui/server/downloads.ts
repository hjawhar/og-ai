/**
 * Weight downloads. Each part streams to `<file>.gguf.part` and is renamed on
 * completion, so a half-written file never looks like usable weights: a truncated
 * GGUF fails at load with a tensor-count error minutes in, which is the worst
 * time to find out.
 *
 * A job is a list of parts because gguf-split weights are useless one shard at a
 * time — llama.cpp opens shard 1 and expects to find its siblings beside it, so
 * "downloaded" has to mean the whole set.
 */
import { mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { authHeaders } from "./hub.ts";

const MIB = 1024 * 1024;
/** Flush cadence: without it the writer buffers the whole 17 GiB in memory. */
const FLUSH_EVERY_BYTES = 64 * MIB;

export type DownloadState = "downloading" | "done" | "error" | "cancelled";

export interface DownloadPart {
	/** Flat name in the models dir. */
	file: string;
	url: string;
	/** As published by whoever hosts it; the response's own content-length wins. */
	sizeBytes: number;
}

export interface DownloadJob {
	key: string;
	parts: DownloadPart[];
}

export interface DownloadView {
	state: DownloadState;
	receivedBytes: number;
	totalBytes: number;
	error?: string;
	/** Average since the download started, which is what an operator wants. */
	mbps: number;
	/** The part being written now, or the last one written. */
	file: string;
	/** Both present only for split weights, and 1-based. */
	partIndex?: number;
	partCount?: number;
}

interface Download {
	key: string;
	parts: DownloadPart[];
	/** 0-based index into `parts`. */
	part: number;
	/** Across every part, including ones already on disk. */
	receivedBytes: number;
	state: DownloadState;
	error?: string;
	startedAt: number;
	controller: AbortController;
}

const downloads = new Map<string, Download>();

export function start(job: DownloadJob, modelsDir: string): void {
	const existing = downloads.get(job.key);
	if (existing?.state === "downloading") return;
	if (job.parts.length === 0) return;
	const record: Download = {
		key: job.key,
		parts: [...job.parts],
		part: 0,
		receivedBytes: 0,
		state: "downloading",
		startedAt: Date.now(),
		controller: new AbortController(),
	};
	downloads.set(job.key, record);
	// Deliberately not awaited: progress is polled from /api/state.
	void run(record, modelsDir);
}

async function run(record: Download, modelsDir: string): Promise<void> {
	try {
		mkdirSync(modelsDir, { recursive: true });
		for (let index = 0; index < record.parts.length; index++) {
			const part = record.parts[index];
			if (part === undefined) continue;
			record.part = index;
			const target = path.join(modelsDir, part.file);
			// A finished shard from an earlier attempt is not downloaded twice: after a
			// failure on shard 3 of 4, re-running must not re-fetch 30 GiB.
			const done = sizeOnDisk(target);
			if (done !== undefined && done === part.sizeBytes) {
				record.receivedBytes += done;
				continue;
			}
			await fetchPart(record, part, target);
			if (record.state === "cancelled") return;
		}
		record.state = "done";
	} catch (error) {
		if (record.state === "cancelled") return;
		record.state = "error";
		record.error = error instanceof Error ? error.message : String(error);
	}
}

async function fetchPart(record: Download, part: DownloadPart, target: string): Promise<void> {
	const temp = `${target}.part`;
	const before = record.receivedBytes;
	try {
		const res = await fetch(part.url, { signal: record.controller.signal, redirect: "follow", headers: authHeaders(part.url) });
		if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status} ${res.statusText} for ${part.file}`);
		// The server's own content-length beats the catalogued one: a drifted
		// constant must never decide when a file is complete.
		const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
		if (Number.isFinite(declared) && declared > 0) part.sizeBytes = declared;

		const sink = Bun.file(temp).writer();
		let sinceFlush = 0;
		try {
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				sink.write(chunk);
				record.receivedBytes += chunk.byteLength;
				sinceFlush += chunk.byteLength;
				if (sinceFlush >= FLUSH_EVERY_BYTES) {
					await sink.flush();
					sinceFlush = 0;
				}
			}
		} finally {
			await sink.end();
		}

		if (record.state === "cancelled") {
			remove(temp);
			return;
		}
		// Same-directory rename is atomic on both platforms, which is the property
		// that makes the .part convention worth anything.
		renameSync(temp, target);
	} catch (error) {
		remove(temp);
		// Bytes of the failed part are not progress; a retry starts it again.
		record.receivedBytes = before;
		throw error;
	}
}

export function cancel(key: string): boolean {
	const record = downloads.get(key);
	if (record === undefined) return false;
	record.state = "cancelled";
	record.controller.abort();
	return true;
}

/** Aborts everything in flight; `fetchPart` removes the partial files. */
export function cancelAll(): void {
	for (const record of downloads.values()) {
		if (record.state === "downloading") cancel(record.key);
	}
}

export function viewOf(key: string): DownloadView | undefined {
	const record = downloads.get(key);
	if (record === undefined) return undefined;
	const seconds = Math.max(0.001, (Date.now() - record.startedAt) / 1000);
	const current = record.parts[Math.min(record.part, record.parts.length - 1)];
	const view: DownloadView = {
		state: record.state,
		receivedBytes: record.receivedBytes,
		totalBytes: record.parts.reduce((total, part) => total + part.sizeBytes, 0),
		mbps: record.receivedBytes / MIB / seconds,
		file: current?.file ?? "",
	};
	if (record.parts.length > 1) {
		view.partIndex = record.part + 1;
		view.partCount = record.parts.length;
	}
	if (record.error !== undefined) view.error = record.error;
	return view;
}

/** Every download this process knows about, keyed the way it was started. */
export function all(): Record<string, DownloadView> {
	const views: Record<string, DownloadView> = {};
	for (const key of downloads.keys()) {
		const view = viewOf(key);
		if (view !== undefined) views[key] = view;
	}
	return views;
}

/**
 * Whether a transfer in flight is writing this filename. Deleting a file a
 * download is about to rename into place would either lose the transfer or
 * resurrect the file seconds later, so the caller refuses instead.
 */
export function isArriving(file: string): boolean {
	for (const record of downloads.values()) {
		if (record.state !== "downloading") continue;
		if (record.parts.some((part) => part.file === file)) return true;
	}
	return false;
}

function sizeOnDisk(file: string): number | undefined {
	try {
		return statSync(file).size;
	} catch {
		return undefined;
	}
}

function remove(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Never written, or already gone.
	}
}
