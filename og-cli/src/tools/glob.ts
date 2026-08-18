import fs from "node:fs";
import path from "node:path";
import type { OgConfig } from "../config/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import {
	argObject,
	isDenied,
	optInt,
	optString,
	relative,
	reqString,
	resolveInWorkspace,
	truncate,
	unknownFields,
} from "./sandbox.ts";
import { SandboxError } from "./types.ts";

export interface GlobArgs {
	pattern: string;
	path?: string;
	limit?: number;
}

const FIELDS = ["pattern", "path", "limit"] as const;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
/** Hard ceiling on candidates collected before sorting, to bound memory on huge trees. */
const SCAN_CEILING = 50_000;

export function createGlobTool(cfg: OgConfig): Tool<GlobArgs> {
	return {
		name: "glob",
		description:
			"Find files by glob pattern, newest first. Use to locate files by name or extension, e.g. `src/**/*.ts`. Output: one workspace-relative path per line.",
		readOnly: true,
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Glob pattern, e.g. `**/*.ts`." },
				path: {
					type: "string",
					description: "Workspace-relative directory to search in. Defaults to the working directory.",
				},
				limit: { type: "integer", description: `Max paths to return. Default ${DEFAULT_LIMIT}.` },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		validate(raw: unknown): GlobArgs {
			const o = argObject("glob", raw);
			unknownFields("glob", o, FIELDS);
			const args: GlobArgs = { pattern: reqString("glob", o, "pattern") };
			const p = optString("glob", o, "path");
			if (p !== undefined) args.path = p;
			const limit = optInt("glob", o, "limit", 1, MAX_LIMIT);
			if (limit !== undefined) args.limit = limit;
			return args;
		},
		run(args: GlobArgs, ctx: ToolContext): Promise<ToolResult> {
			return runGlob(cfg, args, ctx);
		},
	};
}

async function runGlob(cfg: OgConfig, args: GlobArgs, ctx: ToolContext): Promise<ToolResult> {
	const root = resolveInWorkspace(ctx, args.path ?? ".");
	const rootRel = relative(ctx.workspaceRoot, root);
	try {
		if (!fs.statSync(root).isDirectory()) {
			return { ok: false, content: `glob failed: ${rootRel} is not a directory` };
		}
	} catch {
		return { ok: false, content: `glob failed: no such directory: ${rootRel}` };
	}

	let glob: Bun.Glob;
	try {
		glob = new Bun.Glob(args.pattern);
	} catch (err) {
		return { ok: false, content: `glob failed: invalid pattern: ${(err as Error).message}` };
	}

	const limit = args.limit ?? DEFAULT_LIMIT;
	const hits: Array<{ rel: string; mtime: number; size: number }> = [];
	let denied = 0;
	let scanned = 0;
	let ceilingHit = false;

	try {
		for await (const entry of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
			if (ctx.signal.aborted) {
				return { ok: false, content: "glob aborted" };
			}
			scanned++;
			if (scanned > SCAN_CEILING) {
				ceilingHit = true;
				break;
			}
			const abs = path.resolve(root, entry);
			// A pattern like `../**` can walk out; enforce confinement per hit.
			let confined: string;
			try {
				confined = resolveInWorkspace(ctx, abs);
			} catch (err) {
				if (err instanceof SandboxError) {
					denied++;
					continue;
				}
				throw err;
			}
			if (isDenied(ctx.denyPaths, confined, ctx.workspaceRoot)) {
				denied++;
				continue;
			}
			let stat: fs.Stats;
			try {
				stat = fs.statSync(confined);
			} catch {
				continue;
			}
			hits.push({
				rel: relative(ctx.workspaceRoot, confined),
				mtime: stat.mtimeMs,
				size: stat.size,
			});
		}
	} catch (err) {
		return { ok: false, content: `glob failed: ${(err as Error).message}` };
	}

	hits.sort((x, y) => (y.mtime - x.mtime !== 0 ? y.mtime - x.mtime : x.rel.localeCompare(y.rel)));
	const shown = hits.slice(0, limit);

	const lines = shown.map((h) => h.rel);
	if (lines.length === 0) {
		lines.push(`no files match ${args.pattern} under ${rootRel}`);
	} else {
		const more = hits.length > shown.length ? `, ${hits.length - shown.length} more not shown` : "";
		const ceiling = ceilingHit ? `, scan stopped at ${SCAN_CEILING} candidates` : "";
		const hidden = denied > 0 ? `, ${denied} hidden by deny rules` : "";
		lines.push(`${shown.length} of ${hits.length} matches under ${rootRel}${more}${hidden}${ceiling}`);
	}

	return {
		ok: true,
		content: truncate(lines.join("\n"), cfg.tools.maxOutputBytes),
		meta: { pattern: args.pattern, root: rootRel, matches: hits.length, shown: shown.length },
	};
}
