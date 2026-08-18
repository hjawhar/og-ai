/**
 * Cross-tool session state. Deliberately module-level: one `og` process serves
 * one session, and the read-before-overwrite guard must be visible to every
 * tool instance created by the registry.
 */

import path from "node:path";

const WIN = process.platform === "win32";

/** Canonical key for a filesystem path, case-folded on win32. */
export function fileKey(abs: string): string {
	const resolved = path.resolve(abs).replaceAll("\\", "/");
	return WIN ? resolved.toLowerCase() : resolved;
}

/** Absolute paths (via `fileKey`) the model has read during this session. */
export const readFiles: Set<string> = new Set<string>();
