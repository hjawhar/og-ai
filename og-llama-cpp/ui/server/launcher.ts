/**
 * Starts and stops a llama-server on behalf of the page — by spawning `serve.ts`,
 * never by assembling flags. The serving argv is built in exactly one place, and
 * this is not it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
/** Bounded so a server left running for a day cannot grow this process. */
const LOG_LIMIT = 400;

export interface LaunchRequest {
	/** GGUF filename, resolved by serve.ts against its models dir. */
	file: string;
	ctx?: number;
	/** 0 keeps every expert on the GPU; serve.ts omits the flag for it. */
	ncmoe?: number;
	alias?: string;
}

export interface LaunchOptions {
	serveScript: string;
	cwd: string;
	root: string;
	modelsDir: string;
	port: number;
}

interface Launched {
	pid: number | null;
	launching: boolean;
	log: string[];
}

const state: Launched = { pid: null, launching: false, log: [] };

export function status(): { pid: number | null; launching: boolean; log: string[] } {
	return { pid: state.pid, launching: state.launching, log: state.log.slice(-60) };
}

export function launch(options: LaunchOptions, request: LaunchRequest): number | null {
	stop();
	const argv = [
		"bun",
		"run",
		options.serveScript,
		"--model",
		request.file,
		"--models-dir",
		options.modelsDir,
		"--root",
		options.root,
		"--port",
		String(options.port),
	];
	if (request.ctx !== undefined) argv.push("--ctx", String(request.ctx));
	if (request.ncmoe !== undefined) argv.push("--n-cpu-moe", String(request.ncmoe));
	if (request.alias !== undefined) argv.push("--alias", request.alias);

	state.log = [`$ ${argv.slice(1).join(" ")}`];
	state.launching = true;
	const child = Bun.spawn(argv, {
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		onExit: (_proc, code, signal) => {
			state.launching = false;
			if (state.pid === child.pid) state.pid = null;
			push(`--- serve.ts exited (${code === null ? `signal ${signal ?? "?"}` : `code ${code}`}) ---`);
		},
	});
	state.pid = child.pid;
	void pump(child.stdout);
	void pump(child.stderr);
	return state.pid;
}

export function stop(): void {
	const pid = state.pid;
	state.pid = null;
	state.launching = false;
	if (pid !== null) killTree(pid);
}

function push(line: string): void {
	if (state.log.length >= LOG_LIMIT) state.log.shift();
	state.log.push(line);
}

async function pump(stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
	if (stream === undefined || typeof stream === "number") return;
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) push(line.replace(/\r$/, ""));
	}
	if (buffer.length > 0) push(buffer);
}

/**
 * The direct child is `bun run serve.ts`, which itself spawns llama-server, so
 * killing only the child leaves a server holding ~15 GiB of VRAM until someone
 * goes looking for it. The tree is collected before signalling because a dead
 * parent's children are reparented and become unfindable.
 */
function killTree(pid: number): void {
	if (WIN) {
		try {
			Bun.spawn(["taskkill.exe", "/T", "/F", "/PID", String(pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			return;
		} catch {
			// taskkill unavailable: fall through to the signal path.
		}
	}
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		for (const target of [...descendants(pid), pid]) {
			try {
				process.kill(target, signal);
			} catch {
				// Already gone.
			}
		}
	}
}

/** Descendants of `root`, deepest first, from /proc. Empty off Linux. */
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
			stat = readFileSync(path.join("/proc", entry, "stat"), "utf8");
		} catch {
			continue; // exited between listing and read
		}
		// Field 2 is the executable name in parentheses and may contain spaces or
		// parentheses itself, so ppid is read relative to the last ')'.
		const ppid = Number.parseInt(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[1] ?? "", 10);
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
