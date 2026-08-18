import { readdirSync, readFileSync } from "node:fs";

import type { OgConfig } from "../config/schema.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import {
	argObject,
	optInt,
	optString,
	relative,
	reqString,
	resolveInWorkspace,
	truncate,
	unknownFields,
} from "./sandbox.ts";

export interface BashArgs {
	command: string;
	cwd?: string;
	timeoutMs?: number;
}

const FIELDS = ["command", "cwd", "timeoutMs"] as const;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30 * 60_000;
/**
 * How long the pipes may still be read after the process has exited. Buffered
 * bytes arrive immediately; anything longer means an orphaned grandchild holds
 * the write end and its output is never coming.
 */
const DRAIN_GRACE_MS = 250;
const WIN = process.platform === "win32";

export function createBashTool(cfg: OgConfig): Tool<BashArgs> {
	const shell = WIN ? "powershell" : "sh";
	return {
		name: "bash",
		description:
			`Run a shell command (${shell}) inside the workspace and capture its output. Use for builds, tests, git, and package managers; use read/glob/grep for inspecting files instead. Output: the command's interleaved stdout+stderr followed by its exit code.`,
		readOnly: false,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Command line to execute." },
				cwd: {
					type: "string",
					description: "Workspace-relative working directory. Defaults to the current directory.",
				},
				timeoutMs: {
					type: "integer",
					description: `Kill the command after this many milliseconds. Default ${cfg.tools.bash.timeoutMs}.`,
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
		validate(raw: unknown): BashArgs {
			const o = argObject("bash", raw);
			unknownFields("bash", o, FIELDS);
			const args: BashArgs = { command: reqString("bash", o, "command") };
			const cwd = optString("bash", o, "cwd");
			if (cwd !== undefined) args.cwd = cwd;
			const timeoutMs = optInt("bash", o, "timeoutMs", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
			if (timeoutMs !== undefined) args.timeoutMs = timeoutMs;
			return args;
		},
		run(args: BashArgs, ctx: ToolContext): Promise<ToolResult> {
			return runBash(cfg, args, ctx);
		},
	};
}

/** Config deny patterns are regexes; a malformed one degrades to a literal substring test. */
function matchDenyPattern(pattern: string, command: string): boolean {
	try {
		return new RegExp(pattern, "i").test(command);
	} catch {
		return command.toLowerCase().includes(pattern.toLowerCase());
	}
}

async function runBash(cfg: OgConfig, args: BashArgs, ctx: ToolContext): Promise<ToolResult> {
	if (!cfg.tools.bash.enabled) {
		return {
			ok: false,
			content: "bash is disabled in this configuration (tools.bash.enabled = false); it cannot run any command.",
		};
	}

	for (const pattern of cfg.tools.bash.denyPatterns) {
		if (pattern === "") continue;
		if (matchDenyPattern(pattern, args.command)) {
			return {
				ok: false,
				content: `bash blocked: the command matches the deny pattern /${pattern}/i and was not executed. Choose a different approach.`,
				meta: { blockedBy: pattern },
			};
		}
	}

	const cwdAbs = resolveInWorkspace(ctx, args.cwd ?? ".");
	const cwdRel = relative(ctx.workspaceRoot, cwdAbs);
	const timeoutMs = args.timeoutMs ?? cfg.tools.bash.timeoutMs;

	const approved = await ctx.approve({
		tool: "bash",
		summary: `bash: ${args.command.length > 120 ? `${args.command.slice(0, 120)}…` : args.command}`,
		detail: `cwd: ${cwdRel}\ntimeout: ${timeoutMs}ms\n\n${args.command}`,
		risk: "exec",
	});
	if (!approved) return { ok: false, content: "denied by user" };

	const cmd = WIN
		? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", args.command]
		: ["/bin/sh", "-lc", args.command];

	let proc: Bun.ReadableSubprocess;
	try {
		proc = Bun.spawn(cmd, {
			cwd: cwdAbs,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
	} catch (err) {
		return { ok: false, content: `bash failed to start: ${(err as Error).message}` };
	}

	const chunks: string[] = [];
	let timedOut = false;
	let aborted = false;

	// Collected before anything dies: once the shell is gone its children are
	// reparented to init and the chain that identifies them is lost.
	const killTree = (): void => {
		if (WIN) {
			try {
				Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(proc.pid)], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
			} catch {
				proc.kill(9);
			}
			return;
		}
		const doomed = [...descendants(proc.pid), proc.pid];
		try {
			// Reaps anything that did make its own group (`setsid`, job control).
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			/* the shell is not a group leader: fall through to the pid list */
		}
		for (const pid of doomed) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	};

	const timer = setTimeout(() => {
		timedOut = true;
		killTree();
	}, timeoutMs);

	const onAbort = (): void => {
		aborted = true;
		killTree();
	};
	ctx.signal.addEventListener("abort", onAbort, { once: true });
	if (ctx.signal.aborted) onAbort();

	// A killed shell can leave a grandchild holding the write end of the pipes,
	// in which case the streams never reach EOF; the exit status is the
	// authoritative signal, so the reads only get a bounded window after it.
	const drainGuard = new AbortController();
	const drained = Promise.all([
		pump(proc.stdout, chunks, drainGuard.signal),
		pump(proc.stderr, chunks, drainGuard.signal),
	]);
	let exitCode: number;
	try {
		exitCode = await proc.exited;
		await Promise.race([drained, Bun.sleep(DRAIN_GRACE_MS)]);
	} finally {
		clearTimeout(timer);
		ctx.signal.removeEventListener("abort", onAbort);
		drainGuard.abort();
	}
	// pump never rejects; awaiting it means no reader still appends to `chunks`.
	await drained;

	const raw = chunks.join("").replaceAll("\r\n", "\n");
	const body = raw.trim() === "" ? "(no output)" : raw.trimEnd();

	const status = timedOut
		? `timed out after ${timeoutMs}ms and was killed`
		: aborted
			? "cancelled and killed"
			: `exit code: ${exitCode}`;
	const header = `$ ${args.command}${cwdRel === "." ? "" : `   (cwd: ${cwdRel})`}`;
	const content = truncate(`${header}\n${body}\n${status}`, cfg.tools.maxOutputBytes);

	ctx.log({ type: "progress", tool: "bash", text: status });

	return {
		ok: !timedOut && !aborted && exitCode === 0,
		content,
		meta: { command: args.command, cwd: cwdRel, exitCode, timedOut, aborted },
	};
}

async function pump(
	stream: ReadableStream<Uint8Array<ArrayBuffer>>,
	sink: string[],
	stopReading: AbortSignal,
): Promise<void> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	// A pending read resolves `{ done: true }` once the reader is cancelled, so
	// this is what lets an abandoned pipe stop blocking the tool result.
	const stop = (): void => {
		void reader.cancel().catch(() => {});
	};
	stopReading.addEventListener("abort", stop, { once: true });
	if (stopReading.aborted) stop();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) sink.push(decoder.decode(value, { stream: true }));
		}
	} catch {
		/* stream torn down by a kill; keep whatever arrived */
	} finally {
		stopReading.removeEventListener("abort", stop);
		const tail = decoder.decode();
		if (tail !== "") sink.push(tail);
		reader.releaseLock();
	}
}

/**
 * Descendants of `root`, deepest first, from /proc. The pid tree is the only
 * dependency-free way to reach grandchildren: `sh -c` does not create a process
 * group, so a negative-pid signal reaches nothing on Linux.
 */
function descendants(root: number): number[] {
	if (process.platform !== "linux") return [];
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return [];
	}
	const childrenOf = new Map<number, number[]>();
	for (const entry of entries) {
		const pid = Number.parseInt(entry, 10);
		if (!Number.isInteger(pid)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			continue; // exited between listing and read
		}
		// Field 2 is the executable name in parentheses and may itself contain
		// spaces or parentheses, so ppid is read relative to the last ')'.
		const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
		const ppid = Number.parseInt(fields[1] ?? "", 10);
		if (!Number.isInteger(ppid)) continue;
		const siblings = childrenOf.get(ppid);
		if (siblings === undefined) childrenOf.set(ppid, [pid]);
		else siblings.push(pid);
	}
	const found: number[] = [];
	const walk = (pid: number): void => {
		for (const child of childrenOf.get(pid) ?? []) {
			walk(child);
			found.push(child);
		}
	};
	walk(root);
	return found;
}
