import fs from "node:fs";
import type { OgConfig } from "../config/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import {
	argObject,
	isTextFile,
	optBool,
	relative,
	reqString,
	reqText,
	resolveInWorkspace,
	truncate,
	unknownFields,
} from "./sandbox.ts";
import { ToolValidationError } from "./types.ts";
import { fileKey, readFiles } from "./state.ts";

export interface EditArgs {
	path: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
}

const FIELDS = ["path", "oldString", "newString", "replaceAll"] as const;
const CONTEXT_LINES = 3;
/** Above this many differing lines a full line-diff is not worth the O(n*m) table. */
const DIFF_CELL_BUDGET = 4_000_000;

export function createEditTool(cfg: OgConfig): Tool<EditArgs> {
	return {
		name: "edit",
		description:
			"Replace an exact string in an existing file. oldString must appear exactly once unless replaceAll is true, and must be copied verbatim from a prior read including indentation. Output: a unified diff of the change.",
		readOnly: false,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file path." },
				oldString: { type: "string", description: "Exact text to find, copied from the file." },
				newString: { type: "string", description: "Replacement text. May be empty to delete." },
				replaceAll: {
					type: "boolean",
					description: "Replace every occurrence instead of requiring a unique match.",
				},
			},
			required: ["path", "oldString", "newString"],
			additionalProperties: false,
		},
		validate(raw: unknown): EditArgs {
			const o = argObject("edit", raw);
			unknownFields("edit", o, FIELDS);
			const oldString = reqString("edit", o, "oldString");
			const newString = reqText("edit", o, "newString");
			if (oldString === newString) {
				throw new ToolValidationError('edit: field "newString" must differ from "oldString"');
			}
			const args: EditArgs = { path: reqString("edit", o, "path"), oldString, newString };
			const replaceAll = optBool("edit", o, "replaceAll");
			if (replaceAll !== undefined) args.replaceAll = replaceAll;
			return args;
		},
		run(args: EditArgs, ctx: ToolContext): Promise<ToolResult> {
			return runEdit(cfg, args, ctx);
		},
	};
}

async function runEdit(cfg: OgConfig, args: EditArgs, ctx: ToolContext): Promise<ToolResult> {
	const abs = resolveInWorkspace(ctx, args.path);
	const rel = relative(ctx.workspaceRoot, abs);

	let buf: Buffer;
	try {
		const stat = fs.statSync(abs);
		if (stat.isDirectory()) {
			return { ok: false, content: `edit failed: ${rel} is a directory` };
		}
		buf = fs.readFileSync(abs);
	} catch {
		return {
			ok: false,
			content: `edit failed: no such file: ${rel}. Use the write tool to create it.`,
		};
	}
	if (!isTextFile(buf)) {
		return { ok: false, content: `edit failed: ${rel} looks binary and cannot be edited as text` };
	}

	const before = buf.toString("utf8");
	const matches = countMatches(before, args.oldString);
	if (matches === 0) {
		return {
			ok: false,
			content: `edit failed: oldString not found in ${rel}. Re-read the file and copy the target text exactly, including indentation and line endings.`,
		};
	}
	if (matches > 1 && args.replaceAll !== true) {
		return {
			ok: false,
			content: `edit failed: oldString matches ${matches} times in ${rel}. Add surrounding context to make it unique, or pass replaceAll: true to change all ${matches} occurrences.`,
		};
	}

	const after =
		args.replaceAll === true
			? before.replaceAll(args.oldString, args.newString)
			: before.replace(args.oldString, args.newString);

	const diff = unifiedDiff(rel, before, after);
	const approved = await ctx.approve({
		tool: "edit",
		summary: `edit: ${rel} (${matches} ${matches === 1 ? "replacement" : "replacements"})`,
		detail: truncate(diff, cfg.tools.maxOutputBytes),
		risk: "write",
	});
	if (!approved) return { ok: false, content: "denied by user" };

	try {
		fs.writeFileSync(abs, after, "utf8");
	} catch (err) {
		return { ok: false, content: `edit failed: ${rel}: ${(err as Error).message}` };
	}
	readFiles.add(fileKey(abs));

	const header = `edited ${rel}: ${matches} ${matches === 1 ? "replacement" : "replacements"}`;
	ctx.log({ type: "progress", tool: "edit", text: header });

	return {
		ok: true,
		content: truncate(`${header}\n${diff}`, cfg.tools.maxOutputBytes),
		meta: { path: rel, replacements: matches, bytes: Buffer.byteLength(after, "utf8") },
	};
}

function countMatches(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return count;
		count++;
		from = at + needle.length;
	}
}

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

type DiffOp = { kind: " " | "-" | "+"; text: string };

/**
 * Line-level unified diff. Common prefix and suffix are trimmed first so the
 * LCS table only covers the genuinely changed middle; oversized middles fall
 * back to a plain replace-block hunk.
 */
export function unifiedDiff(label: string, before: string, after: string): string {
	const a = splitLines(before);
	const b = splitLines(after);

	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}

	const aMid = a.slice(head, a.length - tail);
	const bMid = b.slice(head, b.length - tail);

	const ops: DiffOp[] = [];
	for (let i = 0; i < head; i++) ops.push({ kind: " ", text: a[i] as string });
	if (aMid.length * bMid.length > DIFF_CELL_BUDGET) {
		for (const line of aMid) ops.push({ kind: "-", text: line });
		for (const line of bMid) ops.push({ kind: "+", text: line });
	} else {
		ops.push(...lcsDiff(aMid, bMid));
	}
	for (let i = a.length - tail; i < a.length; i++) ops.push({ kind: " ", text: a[i] as string });

	return renderHunks(label, ops, a.length, b.length);
}

function lcsDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
	const n = a.length;
	const m = b.length;
	// table[i][j] = LCS length of a[i..] and b[j..]
	const width = m + 1;
	const table = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? (table[(i + 1) * width + (j + 1)] as number) + 1
					: Math.max(table[(i + 1) * width + j] as number, table[i * width + (j + 1)] as number);
		}
	}
	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ kind: " ", text: a[i] as string });
			i++;
			j++;
		} else if ((table[(i + 1) * width + j] as number) >= (table[i * width + (j + 1)] as number)) {
			ops.push({ kind: "-", text: a[i] as string });
			i++;
		} else {
			ops.push({ kind: "+", text: b[j] as string });
			j++;
		}
	}
	while (i < n) {
		ops.push({ kind: "-", text: a[i] as string });
		i++;
	}
	while (j < m) {
		ops.push({ kind: "+", text: b[j] as string });
		j++;
	}
	return ops;
}

function renderHunks(label: string, ops: readonly DiffOp[], aTotal: number, bTotal: number): string {
	const changed: number[] = [];
	for (let i = 0; i < ops.length; i++) {
		if ((ops[i] as DiffOp).kind !== " ") changed.push(i);
	}
	if (changed.length === 0) return `--- ${label}\n+++ ${label}\n(no textual change)`;

	// Group changed op indices into runs separated by more than 2*CONTEXT_LINES context lines.
	const groups: Array<[number, number]> = [];
	let startIdx = changed[0] as number;
	let prev = startIdx;
	for (const idx of changed.slice(1)) {
		if (idx - prev > CONTEXT_LINES * 2) {
			groups.push([startIdx, prev]);
			startIdx = idx;
		}
		prev = idx;
	}
	groups.push([startIdx, prev]);

	// Precompute the source line numbers each op refers to.
	const aLine = new Int32Array(ops.length);
	const bLine = new Int32Array(ops.length);
	let ai = 1;
	let bi = 1;
	for (let i = 0; i < ops.length; i++) {
		aLine[i] = ai;
		bLine[i] = bi;
		const kind = (ops[i] as DiffOp).kind;
		if (kind !== "+") ai++;
		if (kind !== "-") bi++;
	}

	const out: string[] = [`--- ${label}`, `+++ ${label}`];
	for (const [gStart, gEnd] of groups) {
		const from = Math.max(0, gStart - CONTEXT_LINES);
		const to = Math.min(ops.length - 1, gEnd + CONTEXT_LINES);
		let aCount = 0;
		let bCount = 0;
		for (let i = from; i <= to; i++) {
			const kind = (ops[i] as DiffOp).kind;
			if (kind !== "+") aCount++;
			if (kind !== "-") bCount++;
		}
		const aStart = aCount === 0 ? 0 : (aLine[from] as number);
		const bStart = bCount === 0 ? 0 : (bLine[from] as number);
		out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
		for (let i = from; i <= to; i++) {
			const op = ops[i] as DiffOp;
			out.push(`${op.kind}${op.text}`);
		}
	}
	out.push(`(${aTotal} lines -> ${bTotal} lines)`);
	return out.join("\n");
}
