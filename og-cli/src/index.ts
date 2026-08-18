#!/usr/bin/env bun
/**
 * og — local-first agentic coding CLI.
 *
 * Heavy modules are imported dynamically so `--help`, `--version` and argument
 * errors never touch sqlite, the provider or the engine supervisor.
 */

import manifest from "../package.json" with { type: "json" };
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Agent } from "./agent/types.ts";
import { ConfigError, type OgConfig } from "./config/schema.ts";
import type { ApprovalRequest } from "./tools/types.ts";
import { bold, cyan, decideApproval, dim, elapsed, formatBytes, formatError, formatWarn, green, red } from "./ui/render.ts";
import { EXIT_ERROR, EXIT_OK, type ApprovalHandler, type RebuildRequest, type RebuildResult, type UiDeps } from "./ui/types.ts";

interface Flags {
	json: boolean;
	print: boolean;
	promptParts: string[];
	continueLatest: boolean;
	noAutostart: boolean;
	verbose: boolean;
	model?: string;
	resume?: string;
	cwd?: string;
	endpoint?: string;
	maxSteps?: number;
}

type Command =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "models"; action: "list" }
	| { kind: "models"; action: "use"; key: string }
	| { kind: "completion"; shell: "powershell" | "bash" }
	| { kind: "engine"; action: "start" | "stop" | "status" }
	| { kind: "sessions"; action: "list" }
	| { kind: "sessions"; action: "show" | "rm"; id: string }
	| { kind: "chat" };

interface ParsedArgs {
	command: Command;
	flags: Flags;
}

const ENGINE_ACTIONS = ["start", "stop", "status"] as const;
const SESSION_ACTIONS = ["list", "show", "rm"] as const;
const MODELS_ACTIONS = ["list", "use"] as const;
const COMPLETION_SHELLS = ["powershell", "bash"] as const;
/** Below this free VRAM the CUDA driver starts spilling weights to host RAM. */
const VRAM_HEADROOM_WARN_MIB = 700;

function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Flags = {
		json: false,
		print: false,
		promptParts: [],
		continueLatest: false,
		noAutostart: false,
		verbose: false,
	};
	const positional: string[] = [];
	let help = false;
	let version = false;
	let index = 0;

	const valueFor = (name: string, inline: string | undefined): string => {
		if (inline !== undefined) return inline;
		const next = argv[index];
		if (next === undefined || (next.startsWith("-") && next !== "-")) throw new ConfigError(`${name} requires a value`);
		index++;
		return next;
	};

	while (index < argv.length) {
		const arg = argv[index++] ?? "";
		if (arg === "--") {
			positional.push(...argv.slice(index));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			const inline = eq === -1 ? undefined : arg.slice(eq + 1);
			switch (name) {
				case "help":
					help = true;
					break;
				case "version":
					version = true;
					break;
				case "json":
					flags.json = true;
					break;
				case "print":
					flags.print = true;
					if (inline !== undefined) flags.promptParts.push(inline);
					else {
						const next = argv[index];
						if (next !== undefined && !next.startsWith("-")) {
							flags.promptParts.push(next);
							index++;
						}
					}
					break;
				case "model":
					flags.model = valueFor("--model", inline);
					break;
				case "continue":
					flags.continueLatest = true;
					break;
				case "resume":
					flags.resume = valueFor("--resume", inline);
					break;
				case "cwd":
					flags.cwd = valueFor("--cwd", inline);
					break;
				case "endpoint":
					flags.endpoint = valueFor("--endpoint", inline);
					break;
				case "no-autostart":
					flags.noAutostart = true;
					break;
				case "max-steps": {
					const raw = valueFor("--max-steps", inline);
					const parsed = Number.parseInt(raw, 10);
					if (!Number.isFinite(parsed) || parsed < 1) throw new ConfigError(`--max-steps expects a positive integer, got "${raw}"`);
					flags.maxSteps = parsed;
					break;
				}
				case "verbose":
					flags.verbose = true;
					break;
				default:
					throw new ConfigError(`unknown option --${name}`);
			}
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			const chars = [...arg.slice(1)];
			for (let c = 0; c < chars.length; c++) {
				const flag = chars[c] ?? "";
				const remainder = chars.slice(c + 1).join("");
				switch (flag) {
					case "h":
						help = true;
						break;
					case "v":
						flags.verbose = true;
						break;
					case "c":
						flags.continueLatest = true;
						break;
					case "j":
						flags.json = true;
						break;
					case "p":
						flags.print = true;
						if (remainder !== "") flags.promptParts.push(remainder);
						else {
							const next = argv[index];
							if (next !== undefined && !next.startsWith("-")) {
								flags.promptParts.push(next);
								index++;
							}
						}
						c = chars.length;
						break;
					case "m":
						flags.model = valueFor("-m", remainder === "" ? undefined : remainder);
						c = chars.length;
						break;
					case "r":
						flags.resume = valueFor("-r", remainder === "" ? undefined : remainder);
						c = chars.length;
						break;
					default:
						throw new ConfigError(`unknown option -${flag}`);
				}
			}
			continue;
		}
		positional.push(arg);
	}

	if (help) return { command: { kind: "help" }, flags };
	if (version) return { command: { kind: "version" }, flags };

	const head = positional[0];
	const subcommandAllowed = flags.promptParts.length === 0;
	if (subcommandAllowed && head === "models") {
		const raw = positional[1] ?? "list";
		const action = MODELS_ACTIONS.find((candidate) => candidate === raw);
		if (action === undefined) {
			throw new ConfigError(`og models expects ${MODELS_ACTIONS.join("|")}, got "${raw}"`);
		}
		if (action === "list") return { command: { kind: "models", action: "list" }, flags };
		const key = positional[2];
		if (key === undefined) throw new ConfigError("og models use requires a profile key — see `og models`");
		return { command: { kind: "models", action: "use", key }, flags };
	}
	if (subcommandAllowed && head === "completion") {
		const raw = positional[1];
		const shell = COMPLETION_SHELLS.find((candidate) => candidate === raw);
		if (shell === undefined) {
			throw new ConfigError(`og completion expects ${COMPLETION_SHELLS.join("|")}, got "${raw ?? "nothing"}"`);
		}
		return { command: { kind: "completion", shell }, flags };
	}
	if (subcommandAllowed && head === "engine") {
		const action = positional[1] ?? "status";
		if (!ENGINE_ACTIONS.includes(action as (typeof ENGINE_ACTIONS)[number])) {
			throw new ConfigError(`og engine expects ${ENGINE_ACTIONS.join("|")}, got "${action}"`);
		}
		return { command: { kind: "engine", action: action as (typeof ENGINE_ACTIONS)[number] }, flags };
	}
	if (subcommandAllowed && head === "sessions") {
		const raw = positional[1] ?? "list";
		const action = SESSION_ACTIONS.find((candidate) => candidate === raw);
		if (action === undefined) {
			throw new ConfigError(`og sessions expects ${SESSION_ACTIONS.join("|")}, got "${raw}"`);
		}
		if (action === "list") return { command: { kind: "sessions", action: "list" }, flags };
		const id = positional[2];
		if (id === undefined) throw new ConfigError(`og sessions ${action} requires a session id`);
		return { command: { kind: "sessions", action, id }, flags };
	}

	flags.promptParts.push(...positional);
	return { command: { kind: "chat" }, flags };
}

function helpText(version: string): string {
	return `${bold("og")} ${version} — local-first agentic coding CLI

${bold("usage")}
  og [options] [prompt...]              interactive REPL, or one-shot when a prompt is given
  og -p "fix the failing test"          headless run, assistant text on stdout
  og engine start|stop|status           manage the local llama.cpp server
  og sessions list|show <id>|rm <id>    inspect stored sessions
  og models [list]                      list model profiles with size and availability
  og models use <key>                   set the default model profile
  og completion powershell|bash         print a shell completion script

${bold("options")}
  -p, --print [prompt]   headless (non-interactive) run; reads stdin when piped
      --json             emit JSONL agent events plus a final result line (implies -p)
  -m, --model <profile>  model profile key to use
  -c, --continue         continue the latest session for this directory
  -r, --resume <id>      resume a specific session
      --cwd <dir>        run against another directory
      --endpoint <url>   OpenAI-compatible base URL of the inference server
      --no-autostart     never launch llama-server; fail if the endpoint is down
      --max-steps <n>    cap model turns for this run
  -v, --verbose          reasoning, turn boundaries and raw error stacks
      --version          print version
  -h, --help             this text

${bold("notes")}
  Piped stdin is used as the prompt: ${dim("git diff | og -p 'review this'")}
  Tab completes commands, model keys and paths inside the REPL.
  Shell completion: ${
		process.platform === "win32"
			? "og completion powershell | Out-String | Invoke-Expression"
			: 'eval "$(og completion bash)"'
	}
  Exit codes: 0 ok, 1 error, 2 max steps reached, 130 aborted.`;
}

/**
 * Static import so `bun build --compile` inlines the manifest: a compiled
 * dist/og has no package.json beside it to read at runtime.
 */
function readVersion(): string {
	return typeof manifest.version === "string" ? manifest.version : "0.0.0-dev";
}

/** Nearest ancestor containing `.git`, else `start` itself. */
function findWorkspaceRoot(start: string): string {
	let dir = start;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/** Runs `work` while printing a one-line elapsed-seconds note to stderr. */
async function withProgress<T>(label: string, work: Promise<T>): Promise<T> {
	const err = process.stderr;
	const tty = err.isTTY === true;
	const startedAt = Date.now();
	if (!tty) err.write(`${label}\n`);
	const timer = tty ? setInterval(() => err.write(`\r\u001b[2K${dim(`${label} ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)}`), 500) : undefined;
	try {
		return await work;
	} finally {
		clearInterval(timer);
		if (tty) err.write("\r\u001b[2K");
	}
}

async function main(): Promise<number> {
	const { command, flags } = parseArgs(process.argv.slice(2));
	const out = process.stdout;
	const err = process.stderr;

	if (command.kind === "help") {
		out.write(`${helpText(readVersion())}\n`);
		return EXIT_OK;
	}
	if (command.kind === "version") {
		out.write(`${readVersion()}\n`);
		return EXIT_OK;
	}
	if (command.kind === "completion") {
		// Shell completion must work before any config or engine exists.
		const { bashCompletion, powershellCompletion } = await import("./ui/completion.ts");
		out.write(`${command.shell === "powershell" ? powershellCompletion("og") : bashCompletion("og")}\n`);
		return EXIT_OK;
	}

	const cwd = flags.cwd === undefined ? process.cwd() : resolve(flags.cwd);
	if (!existsSync(cwd)) throw new ConfigError(`--cwd does not exist: ${cwd}`);
	const workspaceRoot = findWorkspaceRoot(cwd);

	// Lazy on purpose: --help/--version and argument errors must not load config,
	// sqlite, the provider or the engine supervisor.
	const { loadConfig } = await import("./config/load.ts");
	const overrides: Partial<OgConfig> = {};
	if (flags.endpoint !== undefined) overrides.endpoint = flags.endpoint;
	if (flags.model !== undefined) overrides.model = flags.model;
	const config = loadConfig(Object.keys(overrides).length === 0 ? { workspaceRoot } : { workspaceRoot, overrides });

	if (command.kind === "models") {
		// Lazy: `og models` needs the path resolver but never the engine or store.
		const { resolveModelPath } = await import("./engine/args.ts");

		if (command.action === "use") {
			if (config.profiles[command.key] === undefined) {
				throw new ConfigError(`unknown profile "${command.key}"; available: ${Object.keys(config.profiles).join(", ")}`);
			}
			// Persisted at machine level so every workspace picks it up; a workspace
			// `.og/config.json` still wins, which is the documented layering.
			const file = join(config.stateDir, "config.json");
			let existing: Record<string, unknown> = {};
			if (existsSync(file)) {
				const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
			}
			existing["model"] = command.key;
			mkdirSync(config.stateDir, { recursive: true });
			writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
			out.write(`default model \u2192 ${bold(command.key)} ${dim(`(written to ${file})`)}\n`);
			const { EngineSupervisor } = await import("./engine/supervisor.ts");
			const status = await new EngineSupervisor(config).status();
			if (status.running && status.model !== undefined && status.model !== command.key) {
				out.write(`${dim(`engine is still serving "${status.model}" — run \`og engine stop\` to load the new weights`)}\n`);
			}
			return EXIT_OK;
		}

		out.write(`${dim(`models dir ${config.engine.modelsDir}`)}\n`);
		for (const [key, profile] of Object.entries(config.profiles)) {
			const mark = key === config.model ? green("*") : " ";
			let state: string;
			try {
				const path = resolveModelPath(config, key);
				state = `${green("present")} ${formatBytes(statSync(path).size)} ${dim(path)}`;
			} catch (error) {
				state = `${red("missing")} ${dim(error instanceof Error ? error.message : String(error))}`;
			}
			out.write(`${mark} ${bold(key.padEnd(22))} ${state}\n`);
			out.write(`  ${dim(`ctx ${profile.ctx} \u00b7 window ${profile.contextWindow} \u00b7 ngl ${profile.nGpuLayers}${profile.nCpuMoe === undefined ? "" : ` \u00b7 n-cpu-moe ${profile.nCpuMoe}`} \u00b7 kv ${profile.cacheTypeK}/${profile.cacheTypeV} \u00b7 temp ${profile.temperature}`)}\n`);
		}
		out.write(`${dim("og models use <key> sets the default; /models switch <key> changes it for one session")}\n`);
		return EXIT_OK;
	}

	// Lazy: only commands that actually touch state open the database.
	const { openSessionStore } = await import("./session/store.ts");
	const store = openSessionStore(config.stateDir);
	try {
		const { EngineSupervisor } = await import("./engine/supervisor.ts");
		const supervisor = new EngineSupervisor(config);

		if (command.kind === "engine") {
			if (command.action === "status") {
				const status = await supervisor.status();
				out.write(`${status.running ? green("running") : red("stopped")} ${status.endpoint}\n`);
				if (status.model !== undefined) out.write(`${dim(`model ${status.model}`)}\n`);
				if (status.pid !== undefined) out.write(`${dim(`pid ${status.pid}`)}\n`);
				if (status.vramUsedMiB !== undefined) {
					const total = status.vramTotalMiB;
					out.write(`${dim(`vram ${status.vramUsedMiB}${total === undefined ? "" : ` / ${total}`} MiB`)}\n`);
				}
				if (flags.verbose) out.write(`${dim(supervisor.commandLine())}\n`);
				return status.running ? EXIT_OK : EXIT_ERROR;
			}
			if (command.action === "stop") {
				// stop() refuses to kill a server og did not launch; report that verbatim.
				try {
					await supervisor.stop();
				} catch (error) {
					err.write(`${formatError(error instanceof Error ? error.message : String(error))}\n`);
					return EXIT_ERROR;
				}
				out.write("engine stopped\n");
				return EXIT_OK;
			}
			const startedAt = Date.now();
			const result = await withProgress("starting engine…", supervisor.ensureRunning());
			out.write(`${result.started ? `engine started in ${elapsed(Date.now() - startedAt)}` : "engine already running"} at ${result.endpoint}\n`);
			return EXIT_OK;
		}

		if (command.kind === "sessions") {
			if (command.action === "list") {
				const records = store.list({ limit: 20 });
				if (records.length === 0) {
					out.write(`${dim("no sessions yet")}\n`);
					return EXIT_OK;
				}
				for (const record of records) {
					const when = new Date(record.updatedAt).toISOString().replace("T", " ").slice(0, 16);
					out.write(`${bold(record.id)} ${dim(`${when} \u00b7 ${record.model} \u00b7 ${record.promptTokens + record.completionTokens} tok \u00b7 ${record.cwd}`)}\n`);
					if (record.title !== "") out.write(`  ${record.title}\n`);
				}
				return EXIT_OK;
			}
			const record = store.get(command.id);
			if (record === undefined) throw new ConfigError(`no session "${command.id}"`);
			if (command.action === "rm") {
				store.delete(command.id);
				out.write(`removed ${command.id}\n`);
				return EXIT_OK;
			}
			out.write(`${bold(record.id)} ${dim(`${record.model} \u00b7 ${record.cwd}`)}\n`);
			for (const message of store.messages(record.id)) {
				out.write(`\n${cyan(message.role)} ${dim(`#${message.seq} \u00b7 ${message.tokens} tok`)}\n`);
				if (message.content !== "") out.write(`${message.content}\n`);
				for (const call of message.toolCalls ?? []) out.write(`${dim(`→ ${call.name} ${call.arguments}`)}\n`);
			}
			return EXIT_OK;
		}

		if (!flags.noAutostart) {
			const result = await withProgress("starting engine…", supervisor.ensureRunning());
			if (result.started) err.write(`${dim(`engine ready at ${result.endpoint}`)}\n`);
			// A near-full GPU means the driver is paging weights to host RAM, which
			// costs roughly 8x throughput while still "working". Warn, don't fail.
			const status = await supervisor.status();
			if (status.vramUsedMiB !== undefined && status.vramTotalMiB !== undefined) {
				const headroom = status.vramTotalMiB - status.vramUsedMiB;
				if (headroom < VRAM_HEADROOM_WARN_MIB) {
					err.write(
						`${formatWarn(
							`only ${headroom} MiB of VRAM free (${status.vramUsedMiB}/${status.vramTotalMiB} MiB used). ` +
								`The driver may spill to host RAM and run ~8x slower. Close GPU-heavy apps, ` +
								`raise nCpuMoe for profile "${config.model}", or switch to a smaller profile.`,
						)}\n`,
					);
				}
			}
		}

		const { createProvider } = await import("./provider/registry.ts");
		const { createTools } = await import("./tools/registry.ts");
		const { createAgent } = await import("./agent/loop.ts");

		let provider = createProvider(config);
		const tools = createTools(config);

		let approvalHandler: ApprovalHandler | null = null;
		const approve = (req: ApprovalRequest): Promise<boolean> => (approvalHandler === null ? Promise.resolve(decideApproval(config, req)) : approvalHandler(req));

		let sessionId: string;
		if (flags.resume !== undefined) {
			const record = store.get(flags.resume);
			if (record === undefined) throw new ConfigError(`no session "${flags.resume}" — see \`og sessions list\``);
			sessionId = record.id;
		} else if (flags.continueLatest) {
			sessionId = (store.latest(cwd) ?? store.create({ cwd, model: config.model })).id;
		} else {
			sessionId = store.create({ cwd, model: config.model }).id;
		}

		const buildAgent = (): Agent =>
			createAgent({ config, provider, tools, store, sessionId, workspaceRoot, cwd, approve });

		const rebuild = async (req: RebuildRequest): Promise<RebuildResult> => {
			let engineRestartRequired = false;
			if (req.model !== undefined && req.model !== config.model) {
				const next = config.profiles[req.model];
				if (next === undefined) throw new ConfigError(`unknown profile "${req.model}"`);
				engineRestartRequired = config.profiles[config.model]?.file !== next.file;
				config.model = req.model;
				provider = createProvider(config);
			}
			const selector = req.session ?? "keep";
			if (selector === "new") {
				sessionId = store.create({ cwd, model: config.model }).id;
			} else if (selector !== "keep") {
				if (store.get(selector.id) === undefined) throw new ConfigError(`no session "${selector.id}"`);
				sessionId = selector.id;
			}
			return { agent: buildAgent(), sessionId, model: config.model, engineRestartRequired };
		};

		const stdinPiped = process.stdin.isTTY !== true;
		let prompt = flags.promptParts.join(" ").trim();
		if (prompt === "" && stdinPiped) prompt = (await Bun.stdin.text()).trim();
		if (prompt === "" && (flags.print || flags.json)) {
			throw new ConfigError("--print needs a prompt argument or piped stdin");
		}

		const ui: UiDeps = {
			config,
			agent: buildAgent(),
			supervisor,
			store,
			sessionId,
			workspaceRoot,
			cwd,
			verbose: flags.verbose,
			version: readVersion(),
			setApprovalHandler: (handler) => {
				approvalHandler = handler;
			},
			rebuild,
			...(flags.maxSteps === undefined ? {} : { maxSteps: flags.maxSteps }),
		};

		if (prompt !== "") {
			// Lazy: the two surfaces are mutually exclusive per invocation.
			const { runHeadless } = await import("./ui/headless.ts");
			return await runHeadless({ ...ui, prompt, json: flags.json });
		}
		if (stdinPiped) throw new ConfigError("no prompt: pass one as an argument, pipe it on stdin, or run og in a terminal");
		const { runTui } = await import("./ui/tui.ts");
		return await runTui(ui);
	} finally {
		store.close();
	}
}

const verboseRequested = process.argv.includes("-v") || process.argv.includes("--verbose");
let exitCode: number;
try {
	exitCode = await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(error instanceof ConfigError ? `${red("config error")} ${message}\n` : `${formatError(message)}\n`);
	if (verboseRequested && error instanceof Error && error.stack !== undefined) process.stderr.write(`${error.stack}\n`);
	else process.stderr.write(`${dim("run with --verbose for details")}\n`);
	exitCode = EXIT_ERROR;
}

await new Promise<void>((done) => {
	process.stdout.write("", () => done());
});
process.exit(exitCode);
