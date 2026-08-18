import fs from "node:fs";
import path from "node:path";
import type { OgConfig } from "../config/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import {
	argObject,
	relative,
	reqString,
	reqText,
	resolveInWorkspace,
	truncate,
	unknownFields,
} from "./sandbox.ts";
import { fileKey, readFiles } from "./state.ts";

export interface WriteArgs {
	path: string;
	content: string;
}

const FIELDS = ["path", "content"] as const;
const DETAIL_PREVIEW_BYTES = 4000;

export function createWriteTool(cfg: OgConfig): Tool<WriteArgs> {
	return {
		name: "write",
		description:
			"Create a new file, or replace an existing file's entire contents. Read the file first if it already exists; prefer the edit tool for small changes. Output: one line stating the path, bytes written, and created/overwrote.",
		readOnly: false,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file path." },
				content: { type: "string", description: "Full file contents to write." },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		validate(raw: unknown): WriteArgs {
			const o = argObject("write", raw);
			unknownFields("write", o, FIELDS);
			return {
				path: reqString("write", o, "path"),
				content: reqText("write", o, "content"),
			};
		},
		run(args: WriteArgs, ctx: ToolContext): Promise<ToolResult> {
			return runWrite(cfg, args, ctx);
		},
	};
}

async function runWrite(cfg: OgConfig, args: WriteArgs, ctx: ToolContext): Promise<ToolResult> {
	const abs = resolveInWorkspace(ctx, args.path);
	const rel = relative(ctx.workspaceRoot, abs);
	const key = fileKey(abs);

	let existing: fs.Stats | undefined;
	try {
		existing = fs.statSync(abs);
	} catch {
		existing = undefined;
	}
	if (existing?.isDirectory()) {
		return { ok: false, content: `write failed: ${rel} is a directory` };
	}
	if (existing !== undefined && !readFiles.has(key)) {
		return {
			ok: false,
			content: `write refused: ${rel} already exists and has not been read in this session. Call read on ${rel} first, then write (or use edit for a targeted change).`,
		};
	}

	const bytes = Buffer.byteLength(args.content, "utf8");
	const verb = existing === undefined ? "create" : "overwrite";
	const approved = await ctx.approve({
		tool: "write",
		summary: `write: ${verb} ${rel} (${bytes} bytes)`,
		detail: truncate(args.content, DETAIL_PREVIEW_BYTES),
		risk: "write",
	});
	if (!approved) return { ok: false, content: "denied by user" };

	try {
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, args.content, "utf8");
	} catch (err) {
		return { ok: false, content: `write failed: ${rel}: ${(err as Error).message}` };
	}

	readFiles.add(key);
	const summary = `wrote ${rel}: ${bytes} bytes (${existing === undefined ? "created" : "overwrote"})`;
	ctx.log({ type: "progress", tool: "write", text: summary });

	return {
		ok: true,
		content: truncate(summary, cfg.tools.maxOutputBytes),
		meta: { path: rel, bytes, created: existing === undefined },
	};
}
