/**
 * Weight downloads. Streams to `<file>.gguf.part` and renames on completion, so a
 * half-written file never looks like usable weights: a truncated GGUF fails at
 * load with a tensor-count error minutes in, which is the worst time to find out.
 */
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

import type { CatalogEntry } from "./catalog.ts";

const MIB = 1024 * 1024;
/** Flush cadence: without it the writer buffers the whole 17 GiB in memory. */
const FLUSH_EVERY_BYTES = 64 * MIB;

export type DownloadState = "downloading" | "done" | "error" | "cancelled";

export interface DownloadView {
	state: DownloadState;
	receivedBytes: number;
	totalBytes: number;
	error?: string;
	/** Average since the download started, which is what an operator wants. */
	mbps: number;
}

interface Download {
	key: string;
	file: string;
	receivedBytes: number;
	totalBytes: number;
	state: DownloadState;
	error?: string;
	startedAt: number;
	controller: AbortController;
}

const downloads = new Map<string, Download>();

export function start(entry: CatalogEntry, modelsDir: string): void {
	const existing = downloads.get(entry.key);
	if (existing?.state === "downloading") return;
	const record: Download = {
		key: entry.key,
		file: entry.file,
		receivedBytes: 0,
		totalBytes: entry.sizeBytes,
		state: "downloading",
		startedAt: Date.now(),
		controller: new AbortController(),
	};
	downloads.set(entry.key, record);
	// Deliberately not awaited: progress is polled from /api/state.
	void run(record, entry, modelsDir);
}

async function run(record: Download, entry: CatalogEntry, modelsDir: string): Promise<void> {
	const target = path.join(modelsDir, entry.file);
	const part = `${target}.part`;
	try {
		mkdirSync(modelsDir, { recursive: true });
		const res = await fetch(entry.url, { signal: record.controller.signal, redirect: "follow" });
		if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		// The server's own content-length beats the catalogued one: a drifted
		// constant must never decide when a file is complete.
		const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
		if (Number.isFinite(declared) && declared > 0) record.totalBytes = declared;

		const sink = Bun.file(part).writer();
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
			remove(part);
			return;
		}
		// Same-directory rename is atomic on both platforms, which is the property
		// that makes the .part convention worth anything.
		renameSync(part, target);
		record.state = "done";
	} catch (err) {
		if (record.state === "cancelled") {
			remove(part);
			return;
		}
		record.state = "error";
		record.error = err instanceof Error ? err.message : String(err);
		remove(part);
	}
}

export function cancel(key: string): boolean {
	const record = downloads.get(key);
	if (record === undefined) return false;
	record.state = "cancelled";
	record.controller.abort();
	return true;
}

/** Aborts everything in flight; `run` removes the partial files. */
export function cancelAll(): void {
	for (const record of downloads.values()) {
		if (record.state === "downloading") cancel(record.key);
	}
}

export function viewOf(key: string): DownloadView | undefined {
	const record = downloads.get(key);
	if (record === undefined) return undefined;
	const seconds = Math.max(0.001, (Date.now() - record.startedAt) / 1000);
	const view: DownloadView = {
		state: record.state,
		receivedBytes: record.receivedBytes,
		totalBytes: record.totalBytes,
		mbps: record.receivedBytes / MIB / seconds,
	};
	if (record.error !== undefined) view.error = record.error;
	return view;
}

function remove(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Never written, or already gone.
	}
}
