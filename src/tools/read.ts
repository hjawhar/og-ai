import fs from "node:fs";
import type { OgConfig } from "../config/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import {
	argObject,
	isTextFile,
	optInt,
	relative,
	reqString,
	resolveInWorkspace,
	truncate,
	unknownFields,
} from "./sandbox.ts";
import { fileKey, readFiles } from "./state.ts";

export interface ReadArgs {
	path: string;
	/** 1-based first line to return. */
	offset?: number;
	limit?: number;
}

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 20000;
const FIELDS = ["path", "offset", "limit"] as const;

export function createReadTool(cfg: OgConfig): Tool<ReadArgs> {
	return {
		name: "read",
		description:
			"Read a text file from the workspace. Use before editing or overwriting any file. Output: numbered lines `NNN|text` plus a final line stating total line count.",
		readOnly: true,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file path." },
				offset: { type: "integer", description: "1-based line to start at. Default 1." },
				limit: { type: "integer", description: `Max lines to return. Default ${DEFAULT_LIMIT}.` },
			},
			required: ["path"],
			additionalProperties: false,
		},
		validate(raw: unknown): ReadArgs {
			const o = argObject("read", raw);
			unknownFields("read", o, FIELDS);
			const args: ReadArgs = { path: reqString("read", o, "path") };
			const offset = optInt("read", o, "offset", 1, Number.MAX_SAFE_INTEGER);
			if (offset !== undefined) args.offset = offset;
			const limit = optInt("read", o, "limit", 1, MAX_LIMIT);
			if (limit !== undefined) args.limit = limit;
			return args;
		},
		run(args: ReadArgs, ctx: ToolContext): Promise<ToolResult> {
			return runRead(cfg, args, ctx);
		},
	};
}

async function runRead(cfg: OgConfig, args: ReadArgs, ctx: ToolContext): Promise<ToolResult> {
	const abs = resolveInWorkspace(ctx, args.path);
	const rel = relative(ctx.workspaceRoot, abs);

	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		return { ok: false, content: `read failed: no such file: ${rel}` };
	}
	if (stat.isDirectory()) {
		return { ok: false, content: `read failed: ${rel} is a directory; use the ls tool instead` };
	}

	let buf: Buffer;
	try {
		buf = fs.readFileSync(abs);
	} catch (err) {
		return { ok: false, content: `read failed: ${rel}: ${(err as Error).message}` };
	}
	if (!isTextFile(buf)) {
		return {
			ok: false,
			content: `read failed: ${rel} looks binary (${stat.size} bytes); this tool only reads text files`,
		};
	}

	const text = buf.toString("utf8");
	const lines = text.split("\n");
	// A trailing newline yields a phantom final element; drop it.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const total = lines.length;

	const offset = args.offset ?? 1;
	const limit = args.limit ?? DEFAULT_LIMIT;
	if (offset > total) {
		return {
			ok: false,
			content: `read failed: ${rel} has ${total} lines; offset ${offset} is past the end`,
		};
	}
	const start = offset - 1;
	const end = Math.min(total, start + limit);
	const width = String(end).length;

	const out: string[] = [];
	for (let i = start; i < end; i++) {
		const raw = lines[i] ?? "";
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		out.push(`${String(i + 1).padStart(width, " ")}|${line}`);
	}

	readFiles.add(fileKey(abs));

	const shown = end - start;
	const summary =
		shown === total
			? `${rel}: ${total} lines (complete)`
			: `${rel}: showed lines ${offset}-${end} of ${total}`;
	out.push(summary);

	ctx.log({ type: "progress", tool: "read", text: summary });

	return {
		ok: true,
		content: truncate(out.join("\n"), cfg.tools.maxOutputBytes),
		meta: { path: rel, totalLines: total, shownLines: shown, bytes: stat.size },
	};
}
