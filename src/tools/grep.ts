import fs from "node:fs";
import path from "node:path";
import type { OgConfig } from "../config/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import {
	argObject,
	isDenied,
	isTextFile,
	optBool,
	optInt,
	optString,
	relative,
	reqString,
	resolveInWorkspace,
	toPosix,
	truncate,
	unknownFields,
} from "./sandbox.ts";
import { ToolValidationError } from "./types.ts";

export interface GrepArgs {
	pattern: string;
	path?: string;
	glob?: string;
	caseSensitive?: boolean;
	limit?: number;
}

const FIELDS = ["pattern", "path", "glob", "caseSensitive", "limit"] as const;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Directories never worth grepping. Anything else is up to `denyPaths`. */
const SKIP_DIRS: Record<string, true> = {
	".git": true,
	node_modules: true,
};

export function createGrepTool(cfg: OgConfig): Tool<GrepArgs> {
	return {
		name: "grep",
		description:
			"Search file contents with a JavaScript regular expression. Use to find where a symbol or string is used. Output: `path:line: text` per match, then a count of files scanned.",
		readOnly: true,
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "JavaScript regular expression source." },
				path: {
					type: "string",
					description: "Workspace-relative file or directory to search. Defaults to the working directory.",
				},
				glob: { type: "string", description: "Only search files matching this glob, e.g. `**/*.ts`." },
				caseSensitive: { type: "boolean", description: "Default false (case-insensitive)." },
				limit: { type: "integer", description: `Max matches to return. Default ${DEFAULT_LIMIT}.` },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		validate(raw: unknown): GrepArgs {
			const o = argObject("grep", raw);
			unknownFields("grep", o, FIELDS);
			const pattern = reqString("grep", o, "pattern");
			const caseSensitive = optBool("grep", o, "caseSensitive");
			try {
				new RegExp(pattern, caseSensitive === true ? "" : "i");
			} catch (err) {
				throw new ToolValidationError(
					`grep: field "pattern" is not a valid regular expression: ${(err as Error).message}`,
				);
			}
			const args: GrepArgs = { pattern };
			const p = optString("grep", o, "path");
			if (p !== undefined) args.path = p;
			const g = optString("grep", o, "glob");
			if (g !== undefined) args.glob = g;
			if (caseSensitive !== undefined) args.caseSensitive = caseSensitive;
			const limit = optInt("grep", o, "limit", 1, MAX_LIMIT);
			if (limit !== undefined) args.limit = limit;
			return args;
		},
		run(args: GrepArgs, ctx: ToolContext): Promise<ToolResult> {
			return runGrep(cfg, args, ctx);
		},
	};
}

async function runGrep(cfg: OgConfig, args: GrepArgs, ctx: ToolContext): Promise<ToolResult> {
	const root = resolveInWorkspace(ctx, args.path ?? ".");
	const rootRel = relative(ctx.workspaceRoot, root);

	let stat: fs.Stats;
	try {
		stat = fs.statSync(root);
	} catch {
		return { ok: false, content: `grep failed: no such file or directory: ${rootRel}` };
	}

	const re = new RegExp(args.pattern, args.caseSensitive === true ? "" : "i");
	let filter: Bun.Glob | undefined;
	if (args.glob !== undefined) {
		try {
			filter = new Bun.Glob(args.glob);
		} catch (err) {
			throw new ToolValidationError(`grep: field "glob" is invalid: ${(err as Error).message}`);
		}
	}

	const limit = args.limit ?? DEFAULT_LIMIT;
	const state = { matches: [] as string[], filesScanned: 0, filesMatched: 0, skippedBinary: 0 };

	const files: string[] = [];
	if (stat.isDirectory()) {
		collect(ctx, root, files);
	} else {
		files.push(root);
	}

	for (const file of files) {
		if (state.matches.length >= limit || ctx.signal.aborted) break;
		const rel = relative(ctx.workspaceRoot, file);
		if (filter !== undefined) {
			const fromRoot = toPosix(path.relative(root, file));
			const base = path.basename(file);
			if (!filter.match(fromRoot) && !filter.match(rel) && !filter.match(base)) continue;
		}
		searchFile(file, rel, re, limit, state);
	}

	const lines = state.matches.slice(0, limit);
	const truncatedNote = state.matches.length >= limit ? ` (stopped at limit ${limit})` : "";
	const summary =
		lines.length === 0
			? `no matches for /${args.pattern}/ in ${state.filesScanned} files under ${rootRel}`
			: `${lines.length} ${lines.length === 1 ? "match" : "matches"} in ${state.filesMatched} of ${state.filesScanned} files scanned under ${rootRel}${truncatedNote}`;
	lines.push(summary);

	return {
		ok: true,
		content: truncate(lines.join("\n"), cfg.tools.maxOutputBytes),
		meta: {
			pattern: args.pattern,
			root: rootRel,
			matches: state.matches.length,
			filesScanned: state.filesScanned,
		},
	};
}

function collect(ctx: ToolContext, dir: string, out: string[]): void {
	if (ctx.signal.aborted) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS[entry.name] === true) continue;
			if (isDenied(ctx.denyPaths, abs, ctx.workspaceRoot)) continue;
			collect(ctx, abs, out);
		} else if (entry.isFile()) {
			if (isDenied(ctx.denyPaths, abs, ctx.workspaceRoot)) continue;
			out.push(abs);
		}
	}
}

function searchFile(
	abs: string,
	rel: string,
	re: RegExp,
	limit: number,
	state: { matches: string[]; filesScanned: number; filesMatched: number; skippedBinary: number },
): void {
	let buf: Buffer;
	try {
		const stat = fs.statSync(abs);
		if (stat.size > MAX_FILE_BYTES) return;
		buf = fs.readFileSync(abs);
	} catch {
		return;
	}
	if (!isTextFile(buf)) {
		state.skippedBinary++;
		return;
	}
	state.filesScanned++;

	const lines = buf.toString("utf8").split("\n");
	let hit = false;
	for (let i = 0; i < lines.length; i++) {
		if (state.matches.length >= limit) break;
		const raw = lines[i] as string;
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!re.test(line)) continue;
		hit = true;
		const trimmed = line.trim();
		const text =
			trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
		state.matches.push(`${rel}:${i + 1}: ${text}`);
	}
	if (hit) state.filesMatched++;
}
