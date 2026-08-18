import type { JSONSchema } from "../provider/types.ts";

export interface ApprovalRequest {
	tool: string;
	/** One-line human summary, e.g. `bash: rm -rf build`. */
	summary: string;
	/** Optional detail body: diff, full command, file list. */
	detail?: string;
	/** Danger classification drives default policy. */
	risk: "read" | "write" | "exec";
}

export type ToolLogEvent =
	| { type: "start"; tool: string; summary: string }
	| { type: "progress"; tool: string; text: string }
	| { type: "end"; tool: string; ok: boolean; durationMs: number; summary: string };

export interface ToolContext {
	/** Absolute workspace root; all path access is confined to it. */
	workspaceRoot: string;
	/** Absolute cwd for relative path resolution and command execution. */
	cwd: string;
	/** Returns false when the user denies; tools must abort cleanly on denial. */
	approve(req: ApprovalRequest): Promise<boolean>;
	log(evt: ToolLogEvent): void;
	signal: AbortSignal;
	/** Deny-list of absolute-or-glob paths that must never be read or written. */
	denyPaths: readonly string[];
	/** Per-tool wall clock budget. */
	timeoutMs: number;
}

export interface ToolResult {
	ok: boolean;
	/** Text handed back to the model. Must be self-describing on failure. */
	content: string;
	/** Not shown to the model; used by the UI. */
	meta?: Record<string, unknown>;
}

export interface Tool<A = unknown> {
	name: string;
	description: string;
	parameters: JSONSchema;
	/** Read-only tools bypass approval entirely. */
	readOnly: boolean;
	/** Throws ToolValidationError on malformed model arguments. */
	validate(raw: unknown): A;
	run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolValidationError";
	}
}

export class SandboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxError";
	}
}
