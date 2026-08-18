/**
 * Path confinement and shared low-level helpers for the tool suite.
 *
 * Every tool routes filesystem access through `resolveInWorkspace` so that a
 * model can never reach outside the workspace root, and so that deny-listed
 * paths (credentials, key material, state dirs) stay unreachable even when the
 * model is given an absolute path.
 */

import fs from "node:fs";
import path from "node:path";
import { SandboxError, ToolValidationError, type ToolContext } from "./types.ts";

const WIN = process.platform === "win32";

/** Normalize any platform path to forward slashes. */
export function toPosix(p: string): string {
	return p.replaceAll("\\", "/");
}

function fold(p: string): string {
	return WIN ? p.toLowerCase() : p;
}

function isWithin(root: string, abs: string): boolean {
	const r = fold(path.resolve(root));
	const a = fold(path.resolve(abs));
	if (a === r) return true;
	const prefix = r.endsWith(path.sep) ? r : r + path.sep;
	return a.startsWith(prefix);
}

/**
 * Resolve symlinks as far as the filesystem allows: walk up to the nearest
 * existing ancestor, realpath that, then re-append the non-existent tail. This
 * catches `link -> C:\` style escapes without failing on paths being created.
 */
function realpathNearest(abs: string): string {
	let cur = path.resolve(abs);
	const tail: string[] = [];
	for (;;) {
		try {
			const real = fs.realpathSync(cur);
			if (tail.length === 0) return real;
			return path.resolve(real, ...tail.reverse());
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.resolve(abs);
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

/** Workspace-relative, forward-slash form. Falls back to the posix absolute path when outside. */
export function relative(workspaceRoot: string, abs: string): string {
	const rel = path.relative(path.resolve(workspaceRoot), path.resolve(abs));
	if (rel === "") return ".";
	if (rel.startsWith("..") || path.isAbsolute(rel)) return toPosix(path.resolve(abs));
	return toPosix(rel);
}

/**
 * True when `abs` matches any deny pattern. Patterns are matched with Bun.Glob
 * against both the forward-slash absolute path and, when `workspaceRoot` is
 * given, the workspace-relative path, so `.env` and `**\/*.pem` both work.
 */
export function isDenied(denyPaths: readonly string[], abs: string, workspaceRoot?: string): boolean {
	const absPosix = toPosix(path.resolve(abs));
	const candidates = [absPosix];
	if (workspaceRoot !== undefined) {
		const rel = relative(workspaceRoot, abs);
		if (rel !== absPosix) {
			candidates.push(rel);
			candidates.push(`./${rel}`);
		}
	}
	for (const pattern of denyPaths) {
		if (pattern === "") continue;
		const pat = toPosix(pattern);
		const folded = fold(pat);
		for (const c of candidates) {
			const cf = fold(c);
			if (cf === folded) return true;
			// A bare directory pattern denies everything beneath it.
			if (cf.startsWith(folded.endsWith("/") ? folded : `${folded}/`)) return true;
		}
		let glob: Bun.Glob;
		try {
			glob = new Bun.Glob(pat);
		} catch {
			continue;
		}
		for (const c of candidates) {
			if (glob.match(c)) return true;
			if (WIN && glob.match(c.toLowerCase())) return true;
		}
	}
	return false;
}

/**
 * Resolve a model-supplied path inside the workspace.
 * Throws SandboxError when the path escapes the root or hits the deny list.
 */
export function resolveInWorkspace(ctx: ToolContext, p: string): string {
	if (typeof p !== "string" || p.length === 0) {
		throw new SandboxError("path must be a non-empty string");
	}
	const root = path.resolve(ctx.workspaceRoot);
	const abs = path.resolve(ctx.cwd, p);
	const real = realpathNearest(abs);
	const realRoot = realpathNearest(root);
	if (!isWithin(root, abs) || !isWithin(realRoot, real)) {
		throw new SandboxError(
			`path escapes the workspace: ${toPosix(p)} resolves outside ${toPosix(root)}`,
		);
	}
	if (isDenied(ctx.denyPaths, abs, root) || isDenied(ctx.denyPaths, real, root)) {
		throw new SandboxError(`path is deny-listed and cannot be accessed: ${relative(root, abs)}`);
	}
	return abs;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Byte-accurate UTF-8 truncation that never splits a codepoint. */
export function truncate(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = encoder.encode(text);
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0) {
		const b = bytes[end];
		if (b === undefined || (b & 0xc0) !== 0x80) break;
		end--;
	}
	const kept = decoder.decode(bytes.subarray(0, end));
	return `${kept}\n… [truncated ${bytes.length - end} of ${bytes.length} bytes]`;
}

/** NUL byte / control-character ratio heuristic over the first 8 KiB. */
export function isTextFile(buf: Uint8Array): boolean {
	const n = Math.min(buf.length, 8192);
	if (n === 0) return true;
	let suspicious = 0;
	for (let i = 0; i < n; i++) {
		const b = buf[i] as number;
		if (b === 0) return false;
		if (b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d) continue;
		if (b < 0x20 || b === 0x7f) suspicious++;
	}
	return suspicious / n <= 0.1;
}

/** Human-readable byte size for listings. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes / 1024;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/* ------------------------------------------------------------------ *
 * Hand-written argument validation shared by every tool.
 * ------------------------------------------------------------------ */

/**
 * Shape of a rejected argument, phrased for a model rather than a developer.
 * Local models recover from a bad tool call far more reliably when the error
 * says what arrived instead of only what was expected.
 */
function received(value: unknown): string {
	if (value === undefined) return "nothing";
	if (value === null) return "null";
	if (Array.isArray(value)) return `an array of ${value.length}`;
	if (typeof value === "string") return `a ${value.length}-character string`;
	return `a ${typeof value}`;
}

export function argObject(tool: string, raw: unknown): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ToolValidationError(
			`${tool}: arguments must be a JSON object, received ${received(raw)}`,
		);
	}
	return raw as Record<string, unknown>;
}

export function reqString(tool: string, o: Record<string, unknown>, field: string): string {
	const v = o[field];
	if (typeof v !== "string") {
		throw new ToolValidationError(
			`${tool}: field "${field}" must be a string, received ${received(v)}; keys you sent: ${Object.keys(o).join(", ") || "none"}`,
		);
	}
	if (v.length === 0) {
		throw new ToolValidationError(`${tool}: field "${field}" must not be empty`);
	}
	return v;
}

/** Required string that is allowed to be empty (e.g. `write.content`). */
export function reqText(tool: string, o: Record<string, unknown>, field: string): string {
	const v = o[field];
	if (typeof v !== "string") {
		throw new ToolValidationError(
			`${tool}: field "${field}" must be a string, received ${received(v)}; keys you sent: ${Object.keys(o).join(", ") || "none"}`,
		);
	}
	return v;
}

export function optString(
	tool: string,
	o: Record<string, unknown>,
	field: string,
): string | undefined {
	const v = o[field];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") {
		throw new ToolValidationError(`${tool}: field "${field}" must be a string when provided`);
	}
	if (v.length === 0) return undefined;
	return v;
}

export function optInt(
	tool: string,
	o: Record<string, unknown>,
	field: string,
	min: number,
	max: number,
): number | undefined {
	const v = o[field];
	if (v === undefined || v === null) return undefined;
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
		throw new ToolValidationError(`${tool}: field "${field}" must be an integer when provided`);
	}
	if (n < min || n > max) {
		throw new ToolValidationError(`${tool}: field "${field}" must be between ${min} and ${max}`);
	}
	return n;
}

export function optBool(
	tool: string,
	o: Record<string, unknown>,
	field: string,
): boolean | undefined {
	const v = o[field];
	if (v === undefined || v === null) return undefined;
	if (typeof v === "boolean") return v;
	if (v === "true") return true;
	if (v === "false") return false;
	throw new ToolValidationError(`${tool}: field "${field}" must be a boolean when provided`);
}

export function unknownFields(
	tool: string,
	o: Record<string, unknown>,
	allowed: readonly string[],
): void {
	for (const k of Object.keys(o)) {
		if (!allowed.includes(k)) {
			throw new ToolValidationError(
				`${tool}: unknown field "${k}"; expected one of ${allowed.join(", ")}`,
			);
		}
	}
}
