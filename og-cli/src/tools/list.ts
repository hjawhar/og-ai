import fs from "node:fs";
import path from "node:path";
import type { OgConfig } from "../config/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import {
	argObject,
	formatSize,
	isDenied,
	optInt,
	optString,
	relative,
	resolveInWorkspace,
	truncate,
	unknownFields,
} from "./sandbox.ts";

export interface ListArgs {
	path?: string;
	depth?: number;
}

const FIELDS = ["path", "depth"] as const;
const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 2000;

export function createListTool(cfg: OgConfig): Tool<ListArgs> {
	return {
		name: "ls",
		description:
			"List directory contents. Use to discover what exists before reading or globbing. Output: indented entries, directories suffixed with `/`, files followed by their size.",
		readOnly: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Workspace-relative directory. Defaults to the working directory.",
				},
				depth: {
					type: "integer",
					description: `Recursion depth, 1-${MAX_DEPTH}. Default ${DEFAULT_DEPTH}.`,
				},
			},
			additionalProperties: false,
		},
		validate(raw: unknown): ListArgs {
			const o = argObject("ls", raw);
			unknownFields("ls", o, FIELDS);
			const args: ListArgs = {};
			const p = optString("ls", o, "path");
			if (p !== undefined) args.path = p;
			const depth = optInt("ls", o, "depth", 1, MAX_DEPTH);
			if (depth !== undefined) args.depth = depth;
			return args;
		},
		run(args: ListArgs, ctx: ToolContext): Promise<ToolResult> {
			return runList(cfg, args, ctx);
		},
	};
}

async function runList(cfg: OgConfig, args: ListArgs, ctx: ToolContext): Promise<ToolResult> {
	const abs = resolveInWorkspace(ctx, args.path ?? ".");
	const rel = relative(ctx.workspaceRoot, abs);

	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		return { ok: false, content: `ls failed: no such directory: ${rel}` };
	}
	if (!stat.isDirectory()) {
		return {
			ok: false,
			content: `ls failed: ${rel} is a file (${formatSize(stat.size)}); use the read tool`,
		};
	}

	const depth = args.depth ?? DEFAULT_DEPTH;
	const lines: string[] = [`${rel}/`];
	const counts = { dirs: 0, files: 0, skipped: 0 };
	walk(ctx, abs, 1, depth, lines, counts);

	if (counts.dirs === 0 && counts.files === 0) {
		lines.push("  (empty)");
	}
	const summary = `${counts.dirs} ${counts.dirs === 1 ? "directory" : "directories"}, ${counts.files} ${counts.files === 1 ? "file" : "files"}${counts.skipped > 0 ? `, ${counts.skipped} hidden by deny rules` : ""}`;
	lines.push(summary);

	return {
		ok: true,
		content: truncate(lines.join("\n"), cfg.tools.maxOutputBytes),
		meta: { path: rel, directories: counts.dirs, files: counts.files },
	};
}

function walk(
	ctx: ToolContext,
	dir: string,
	level: number,
	maxDepth: number,
	lines: string[],
	counts: { dirs: number; files: number; skipped: number },
): void {
	if (ctx.signal.aborted) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		lines.push(`${"  ".repeat(level)}(unreadable: ${(err as Error).message})`);
		return;
	}
	entries.sort((x, y) => {
		const dx = x.isDirectory() ? 0 : 1;
		const dy = y.isDirectory() ? 0 : 1;
		return dx !== dy ? dx - dy : x.name.localeCompare(y.name);
	});

	const indent = "  ".repeat(level);
	for (const entry of entries) {
		if (lines.length >= MAX_ENTRIES) {
			lines.push(`${indent}… listing truncated at ${MAX_ENTRIES} entries`);
			return;
		}
		if (entry.name === ".git") continue;
		const abs = path.join(dir, entry.name);
		if (isDenied(ctx.denyPaths, abs, ctx.workspaceRoot)) {
			counts.skipped++;
			continue;
		}
		if (entry.isDirectory()) {
			counts.dirs++;
			lines.push(`${indent}${entry.name}/`);
			if (level < maxDepth) walk(ctx, abs, level + 1, maxDepth, lines, counts);
		} else if (entry.isSymbolicLink()) {
			counts.files++;
			lines.push(`${indent}${entry.name} -> (symlink)`);
		} else {
			counts.files++;
			let size = 0;
			try {
				size = fs.statSync(abs).size;
			} catch {
				size = 0;
			}
			lines.push(`${indent}${entry.name}  ${formatSize(size)}`);
		}
	}
}
