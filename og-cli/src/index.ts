#!/usr/bin/env bun
/**
 * og — agentic coding CLI for any OpenAI-compatible endpoint.
 *
 * Heavy modules are imported dynamically so `--help`, `--version` and argument
 * errors never touch sqlite or the provider. og never starts an inference
 * server: point `endpoint` at one that is already listening (see
 * ../../og-llama-cpp for a local llama.cpp server).
 */

import manifest from "../package.json" with { type: "json" };
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Agent } from "./agent/types.ts";
import { ConfigError, type OgConfig } from "./config/schema.ts";
import type { ApprovalRequest } from "./tools/types.ts";
import { bold, cyan, decideApproval, dim, formatError, green, red } from "./ui/render.ts";
import { EXIT_ERROR, EXIT_OK, type ApprovalHandler, type RebuildRequest, type RebuildResult, type UiDeps } from "./ui/types.ts";

interface Flags {
	json: boolean;
	print: boolean;
	promptParts: string[];
	continueLatest: boolean;
	verbose: boolean;
	model?: string;
	resume?: string;
	cwd?: string;
	endpoint?: string;
	contextWindow?: number;
	maxSteps?: number;
}

type Command =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "models"; action: "list" }
	| { kind: "models"; action: "use"; key: string }
	| { kind: "completion"; shell: "powershell" | "bash" }
	| { kind: "sessions"; action: "list" }
	| { kind: "sessions"; action: "show" | "rm"; id: string }
	| { kind: "chat" };

interface ParsedArgs {
	command: Command;
	flags: Flags;
}

const SESSION_ACTIONS = ["list", "show", "rm"] as const;
const MODELS_ACTIONS = ["list", "use"] as const;
const COMPLETION_SHELLS = ["powershell", "bash"] as const;

function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Flags = {
		json: false,
		print: false,
		promptParts: [],
		continueLatest: false,
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
				case "context-window": {
					const raw = valueFor("--context-window", inline);
					const parsed = Number.parseInt(raw, 10);
					if (!Number.isFinite(parsed) || parsed < 1) {
						throw new ConfigError(`--context-window expects a positive integer, got "${raw}"`);
					}
					flags.contextWindow = parsed;
					break;
				}
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
	return `${bold("og")} ${version} — agentic coding CLI for any OpenAI-compatible endpoint

${bold("usage")}
  og [options] [prompt...]              interactive REPL, or one-shot when a prompt is given
  og -p "fix the failing test"          headless run, assistant text on stdout
  og sessions list|show <id>|rm <id>    inspect stored sessions
  og models [list]                      list configured models with endpoint and window
  og models use <key>                   set the default model
  og completion powershell|bash         print a shell completion script

${bold("options")}
  -p, --print [prompt]      headless (non-interactive) run; reads stdin when piped
      --json                emit JSONL agent events plus a final result line (implies -p)
  -m, --model <name>        a configured model key, or any name the endpoint serves
  -c, --continue            continue the latest session for this directory
  -r, --resume <id>         resume a specific session
      --cwd <dir>           run against another directory
      --endpoint <url>      OpenAI-compatible base URL to talk to
      --context-window <n>  tokens to budget for this model
      --max-steps <n>       cap model turns for this run
  -v, --verbose             reasoning, turn boundaries and raw error stacks
      --version             print version
  -h, --help                this text

${bold("notes")}
  og never starts a server: run one first, e.g. the og-llama-cpp project's ${dim("serve.ts")}.
  Secrets belong in the environment: ${dim("OG_API_KEY")}, or ${dim("apiKeyEnv")} per model.
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

async function main(): Promise<number> {
	const { command, flags } = parseArgs(process.argv.slice(2));
	const out = process.stdout;

	if (command.kind === "help") {
		out.write(`${helpText(readVersion())}\n`);
		return EXIT_OK;
	}
	if (command.kind === "version") {
		out.write(`${readVersion()}\n`);
		return EXIT_OK;
	}
	if (command.kind === "completion") {
		// Shell completion must work before any config exists.
		const { bashCompletion, powershellCompletion } = await import("./ui/completion.ts");
		out.write(`${command.shell === "powershell" ? powershellCompletion("og") : bashCompletion("og")}\n`);
		return EXIT_OK;
	}

	const cwd = flags.cwd === undefined ? process.cwd() : resolve(flags.cwd);
	if (!existsSync(cwd)) throw new ConfigError(`--cwd does not exist: ${cwd}`);
	const workspaceRoot = findWorkspaceRoot(cwd);

	// Lazy on purpose: --help/--version and argument errors must not load config,
	// sqlite or the provider.
	const { loadConfig } = await import("./config/load.ts");
	const overrides: Partial<OgConfig> = {};
	if (flags.endpoint !== undefined) overrides.endpoint = flags.endpoint;
	if (flags.model !== undefined) overrides.model = flags.model;
	const config = loadConfig({
		workspaceRoot,
		...(Object.keys(overrides).length === 0 ? {} : { overrides }),
		...(flags.contextWindow === undefined ? {} : { contextWindow: flags.contextWindow }),
	});

	if (command.kind === "models") {
		if (command.action === "use") {
			if (config.models[command.key] === undefined) {
				throw new ConfigError(`unknown model "${command.key}"; available: ${Object.keys(config.models).join(", ")}`);
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
			return EXIT_OK;
		}

		for (const [key, spec] of Object.entries(config.models)) {
			const mark = key === config.model ? green("*") : " ";
			const knobs = [`window ${spec.contextWindow}`];
			if (spec.maxTokens !== undefined) knobs.push(`max-tokens ${spec.maxTokens}`);
			if (spec.temperature !== undefined) knobs.push(`temp ${spec.temperature}`);
			if (spec.topP !== undefined) knobs.push(`top-p ${spec.topP}`);
			if (spec.topK !== undefined) knobs.push(`top-k ${spec.topK}`);
			if (spec.minP !== undefined) knobs.push(`min-p ${spec.minP}`);
			if (spec.repeatPenalty !== undefined) knobs.push(`repeat-penalty ${spec.repeatPenalty}`);
			// The variable name, never its value: og prints config, not secrets.
			if (spec.apiKeyEnv !== undefined) knobs.push(`key from $${spec.apiKeyEnv}`);
			out.write(`${mark} ${bold(key.padEnd(22))} ${dim(`${spec.id ?? key} @ ${spec.endpoint ?? config.endpoint}`)}\n`);
			out.write(`  ${dim(knobs.join(" \u00b7 "))}\n`);
		}
		out.write(`${dim("og models use <key> sets the default; -m <name> accepts any model the endpoint serves")}\n`);
		return EXIT_OK;
	}

	// Lazy: only commands that actually touch state open the database.
	const { openSessionStore } = await import("./session/store.ts");
	const store = openSessionStore(config.stateDir);
	try {
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

		const { createProvider } = await import("./provider/registry.ts");
		const { createTools } = await import("./tools/registry.ts");
		const { createAgent } = await import("./agent/loop.ts");

		let provider = createProvider(config);
		const tools = createTools(config);

		// One preflight instead of a mid-stream surprise: a transport failure means
		// nothing is listening, which is a different problem from a server that
		// answers and then rejects the request.
		const health = await provider.health();
		if (!health.reachable) {
			throw new ConfigError(
				`no server answering at ${provider.endpoint} (${health.detail ?? "connection failed"}). ` +
					`Start one and retry — the og-llama-cpp project's \`bun run serve.ts\` runs a local llama.cpp server — ` +
					`or point og elsewhere with --endpoint.`,
			);
		}

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
			if (req.model !== undefined && req.model !== config.model) {
				if (config.models[req.model] === undefined) throw new ConfigError(`unknown model "${req.model}"`);
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
			return { agent: buildAgent(), sessionId, model: config.model };
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
