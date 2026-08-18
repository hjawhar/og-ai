/**
 * Minimal leveled logger. Human-readable lines go to stderr (stdout is reserved
 * for headless/JSON program output); structured single-line JSON is appended to
 * an optional log file.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
	/** Effective threshold; records below it are dropped entirely. */
	readonly level: LogLevel;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Level requested through `OG_LOG_LEVEL`, defaulting to "warn" for unset or unknown values. */
export function envLogLevel(): LogLevel {
	const raw = process.env["OG_LOG_LEVEL"]?.trim().toLowerCase();
	return LEVELS.find((l) => l === raw) ?? "warn";
}

function formatMeta(meta: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(meta)) {
		let rendered: string;
		if (value instanceof Error) rendered = `${value.name}: ${value.message}`;
		else if (typeof value === "string") rendered = value;
		else {
			try {
				rendered = JSON.stringify(value) ?? String(value);
			} catch {
				rendered = String(value);
			}
		}
		if (rendered.length > 400) rendered = `${rendered.slice(0, 400)}…`;
		parts.push(`${key}=${rendered.includes(" ") ? JSON.stringify(rendered) : rendered}`);
	}
	return parts.join(" ");
}

function jsonSafe(meta: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(meta)) {
		out[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
	}
	return out;
}

export function createLogger(opts: { level: LogLevel; file?: string }): Logger {
	const threshold = RANK[opts.level];
	const file = opts.file;
	let fileUsable = file !== undefined;
	if (file !== undefined) {
		try {
			mkdirSync(dirname(file), { recursive: true });
		} catch {
			fileUsable = false;
		}
	}

	const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
		if (RANK[level] < threshold) return;
		const ts = new Date().toISOString();
		const tail = meta && Object.keys(meta).length > 0 ? ` ${formatMeta(meta)}` : "";
		process.stderr.write(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}\n`);
		if (file !== undefined && fileUsable) {
			const record = { ts, level, msg, ...(meta ? jsonSafe(meta) : {}) };
			try {
				appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
			} catch {
				// A broken log sink must never break the run; stop retrying it.
				fileUsable = false;
			}
		}
	};

	return {
		level: opts.level,
		debug: (msg, meta) => emit("debug", msg, meta),
		info: (msg, meta) => emit("info", msg, meta),
		warn: (msg, meta) => emit("warn", msg, meta),
		error: (msg, meta) => emit("error", msg, meta),
	};
}
