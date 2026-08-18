/**
 * Lifecycle management for the local llama.cpp server.
 *
 * Design notes:
 *  - The endpoint is authoritative. A healthy server at `cfg.endpoint` is always
 *    adopted, whether this process started it, a previous `og` run started it,
 *    or the user launched it by hand. We never start a second server.
 *  - Cross-process races are serialised with an exclusive lock file; in-process
 *    races share one in-flight promise.
 *  - The child is fully detached and its stdio appended to `engine.log`, so the
 *    server outlives the CLI (fast subsequent starts) and its output survives
 *    for diagnostics.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ConfigError, type OgConfig } from "../config/schema.ts";
import { buildServerArgs } from "./args.ts";

export interface EngineStatus {
	running: boolean;
	endpoint: string;
	model?: string;
	pid?: number;
	vramUsedMiB?: number;
	vramTotalMiB?: number;
}

interface EngineRecord {
	pid: number;
	port: number;
	profile: string;
	startedAt: number;
}

const HEALTH_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 1_000;
const LOCK_STALE_MS = 5 * 60 * 1_000;
const LOCK_POLL_MS = 250;
const KILL_ESCALATE_MS = 5_000;
const LOG_TAIL_LINES = 20;

export class EngineSupervisor {
	private readonly cfg: OgConfig;
	private readonly endpoint: string;
	private readonly stateDir: string;
	private readonly logFile: string;
	private readonly recordFile: string;
	private readonly lockFile: string;
	private inflight: Promise<{ endpoint: string; started: boolean }> | null = null;

	constructor(cfg: OgConfig, opts?: { logFile?: string }) {
		this.cfg = cfg;
		this.endpoint = cfg.endpoint.replace(/\/+$/, "");
		this.stateDir = cfg.stateDir;
		this.logFile = opts?.logFile ?? path.join(cfg.stateDir, "engine.log");
		this.recordFile = path.join(cfg.stateDir, "engine.json");
		this.lockFile = path.join(cfg.stateDir, "engine.lock");
	}

	/** The command line a user would type to start this server themselves. */
	commandLine(profileKey = this.cfg.model): string {
		const args = buildServerArgs(this.cfg, profileKey);
		return [this.binPath(), ...args].map(quoteArg).join(" ");
	}

	async status(): Promise<EngineStatus> {
		const healthy = await this.probeHealth();
		if (!healthy) {
			return { running: false, endpoint: this.endpoint };
		}

		const [model, vram] = await Promise.all([this.loadedModel(), readVram()]);
		const pid = this.readRecord()?.pid;

		const out: EngineStatus = { running: true, endpoint: this.endpoint };
		if (model !== undefined) out.model = model;
		if (pid !== undefined) out.pid = pid;
		if (vram !== undefined) {
			out.vramUsedMiB = vram.used;
			out.vramTotalMiB = vram.total;
		}
		return out;
	}

	ensureRunning(): Promise<{ endpoint: string; started: boolean }> {
		if (this.inflight) return this.inflight;
		const run = (async () => {
			try {
				return await this.ensureRunningImpl();
			} finally {
				this.inflight = null;
			}
		})();
		this.inflight = run;
		return run;
	}

	/**
	 * Terminates the server recorded in engine.json. A healthy server we have no
	 * record of is reported, never killed: it belongs to another tool or user.
	 */
	async stop(): Promise<void> {
		const record = this.readRecord();
		if (record) {
			await terminate(record.pid);
			fs.rmSync(this.recordFile, { force: true });
			return;
		}
		if (await this.probeHealth()) {
			throw new Error(
				`A server is answering at ${this.endpoint} but og has no record of starting it ` +
					`(${this.recordFile} is absent), so its process cannot be identified. ` +
					`Stop it wherever it was launched.`,
			);
		}
	}

	// ---------------------------------------------------------------- internals

	private binPath(): string {
		const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
		return path.join(this.cfg.engine.binDir, exe);
	}

	private async probeHealth(): Promise<boolean> {
		try {
			const res = await fetch(`${this.endpoint}/health`, {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	/** Model alias reported by the running server, if it exposes one. */
	private async loadedModel(): Promise<string | undefined> {
		try {
			const res = await fetch(`${this.endpoint}/props`, {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			if (!res.ok) return undefined;
			const props = (await res.json()) as {
				model_alias?: unknown;
				model_path?: unknown;
				default_generation_settings?: { model?: unknown };
				models?: unknown;
			};
			const candidates: unknown[] = [
				props.model_alias,
				props.default_generation_settings?.model,
				Array.isArray(props.models) ? props.models[0] : undefined,
				props.model_path,
			];
			for (const candidate of candidates) {
				if (typeof candidate === "string" && candidate.length > 0) {
					return candidate.includes("/") || candidate.includes("\\")
						? path.basename(candidate)
						: candidate;
				}
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	private readRecord(): EngineRecord | undefined {
		try {
			const raw = JSON.parse(fs.readFileSync(this.recordFile, "utf8")) as Partial<EngineRecord>;
			if (typeof raw.pid !== "number" || !Number.isFinite(raw.pid)) return undefined;
			return {
				pid: raw.pid,
				port: typeof raw.port === "number" ? raw.port : this.cfg.engine.port,
				profile: typeof raw.profile === "string" ? raw.profile : this.cfg.model,
				startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
			};
		} catch {
			return undefined;
		}
	}

	private writeRecord(record: EngineRecord): void {
		fs.mkdirSync(this.stateDir, { recursive: true });
		fs.writeFileSync(this.recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	}

	private async ensureRunningImpl(): Promise<{ endpoint: string; started: boolean }> {
		if (await this.probeHealth()) return { endpoint: this.endpoint, started: false };

		const profileKey = this.cfg.model;
		if (!this.cfg.engine.autoStart) {
			throw new ConfigError(
				`No inference server reachable at ${this.endpoint} and engine.autoStart is false.\n` +
					`Start it manually, then re-run:\n\n  ${this.commandLine(profileKey)}\n\n` +
					`Or set engine.autoStart = true in your og config.`,
			);
		}

		// Argv (and therefore the model path) is validated before we take the lock.
		const args = buildServerArgs(this.cfg, profileKey);
		const bin = this.binPath();
		if (!fs.existsSync(bin)) {
			throw new ConfigError(
				`llama-server not found at ${bin}. Fix engine.binDir in your og config.`,
			);
		}

		fs.mkdirSync(this.stateDir, { recursive: true });
		const lockFd = await this.acquireLock();
		if (lockFd === null) {
			// Another process won the lock and brought the server up while we waited.
			return { endpoint: this.endpoint, started: false };
		}

		try {
			// Re-probe: the lock holder may have finished between our first probe
			// and our acquisition.
			if (await this.probeHealth()) return { endpoint: this.endpoint, started: false };

			const logFd = fs.openSync(this.logFile, "a");
			const banner = `\n=== og: starting ${bin} (${profileKey}) at ${new Date().toISOString()} ===\n`;
			let child: ChildProcess;
			try {
				fs.writeFileSync(logFd, banner);
				child = spawn(bin, args, {
					cwd: this.cfg.engine.binDir,
					detached: true,
					stdio: ["ignore", logFd, logFd],
					windowsHide: true,
				});
			} catch (err) {
				fs.closeSync(logFd);
				throw err;
			}
			fs.closeSync(logFd);
			child.unref();

			// Mutated from event callbacks; read through locals so the poll loop
			// sees each observation exactly once.
			const watch: { error: Error | null; exited: boolean } = { error: null, exited: false };
			child.once("error", (err: Error) => {
				watch.error = err;
			});
			child.once("exit", () => {
				watch.exited = true;
			});

			const pid = child.pid;
			if (pid === undefined) {
				throw new Error(`Failed to spawn ${bin}: the OS assigned no pid.`);
			}

			const deadline = Date.now() + this.cfg.engine.startupTimeoutSec * 1_000;
			for (;;) {
				if (await this.probeHealth()) {
					this.writeRecord({
						pid,
						port: this.cfg.engine.port,
						profile: profileKey,
						startedAt: Date.now(),
					});
					return { endpoint: this.endpoint, started: true };
				}
				const spawnError = watch.error;
				if (spawnError !== null) {
					await terminate(pid);
					throw new Error(
						`Failed to launch llama-server: ${spawnError.message}\n${this.logTail()}`,
					);
				}
				if (watch.exited) {
					throw new Error(
						`llama-server exited before becoming healthy.\n` +
							`Command: ${[bin, ...args].map(quoteArg).join(" ")}\n${this.logTail()}`,
					);
				}
				if (Date.now() >= deadline) {
					await terminate(pid);
					throw new Error(
						`llama-server did not report healthy at ${this.endpoint}/health within ` +
							`${this.cfg.engine.startupTimeoutSec}s.\n` +
							`Command: ${[bin, ...args].map(quoteArg).join(" ")}\n${this.logTail()}`,
					);
				}
				await sleep(POLL_INTERVAL_MS);
			}
		} finally {
			this.releaseLock(lockFd);
		}
	}

	/**
	 * Exclusive create of the lock file. Returns the fd on success, or `null`
	 * when another process held the lock and the server became healthy while we
	 * were waiting. Locks older than LOCK_STALE_MS are broken.
	 */
	private async acquireLock(): Promise<number | null> {
		const deadline = Date.now() + this.cfg.engine.startupTimeoutSec * 1_000 + LOCK_STALE_MS;
		for (;;) {
			try {
				const fd = fs.openSync(this.lockFile, "wx");
				fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
				return fd;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}

			if (await this.probeHealth()) return null;

			let age = Number.POSITIVE_INFINITY;
			try {
				age = Date.now() - fs.statSync(this.lockFile).mtimeMs;
			} catch {
				// Lock vanished; retry immediately.
				continue;
			}
			if (age > LOCK_STALE_MS) {
				fs.rmSync(this.lockFile, { force: true });
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for another og process to start the engine ` +
						`(lock: ${this.lockFile}). Delete the lock file if no server is starting.`,
				);
			}
			await sleep(LOCK_POLL_MS);
		}
	}

	private releaseLock(fd: number): void {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed */
		}
		try {
			fs.rmSync(this.lockFile, { force: true });
		} catch {
			/* already removed */
		}
	}

	private logTail(): string {
		let text: string;
		try {
			text = fs.readFileSync(this.logFile, "utf8");
		} catch {
			return `(no engine log at ${this.logFile})`;
		}
		const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
		const tail = lines.slice(-LOG_TAIL_LINES);
		return `Last ${tail.length} line(s) of ${this.logFile}:\n${tail.join("\n")}`;
	}
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function quoteArg(arg: string): string {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Kill a process tree: taskkill on Windows, SIGTERM then SIGKILL elsewhere. */
async function terminate(pid: number): Promise<void> {
	if (!isAlive(pid)) return;

	if (process.platform === "win32") {
		const proc = Bun.spawn(["taskkill", "/T", "/F", "/PID", String(pid)], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		await proc.exited;
		return;
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + KILL_ESCALATE_MS;
	while (Date.now() < deadline) {
		await sleep(200);
		if (!isAlive(pid)) return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* exited between the check and the signal */
	}
}

/**
 * GPU memory in use and installed, best effort; absent nvidia-smi is not an
 * error. Callers use the gap to detect the driver's host-RAM spill regime,
 * where llama.cpp keeps working but runs roughly 8x slower.
 */
async function readVram(): Promise<{ used: number; total: number } | undefined> {
	if (process.platform !== "win32" && process.platform !== "linux") return undefined;
	try {
		const proc = Bun.spawn(
			["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
			{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
		);
		const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (proc.exitCode !== 0) return undefined;
		let used = 0;
		let total = 0;
		let seen = false;
		for (const line of text.split(/\r?\n/)) {
			const [rawUsed, rawTotal] = line.split(",");
			const u = Number.parseInt((rawUsed ?? "").trim(), 10);
			const t = Number.parseInt((rawTotal ?? "").trim(), 10);
			if (Number.isFinite(u) && Number.isFinite(t)) {
				used += u;
				total += t;
				seen = true;
			}
		}
		return seen ? { used, total } : undefined;
	} catch {
		return undefined;
	}
}
