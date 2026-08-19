#!/usr/bin/env bun
/**
 * The model UI's backend: a JSON API over the local engine plus a static host for
 * the built Angular app in ../dist/ui/browser.
 *
 * It answers three questions the page renders: what weights are installed, what
 * can be downloaded, and whether each of them actually fits the GPU in this
 * machine. The third is the reason any of this exists — weights that do not fit
 * still load and still answer while the driver pages them to host RAM at ~8x the
 * cost (docs/benchmarks.md §5), and the only signal is arithmetic done first.
 *
 * Zero runtime dependencies, like everything else on the Bun side of this
 * project: `node:*` and Bun builtins only. The Angular workspace next door is the
 * one place in the repository with a package manager and a build step.
 *
 * Usage: bun run ui/server/main.ts [--port 8130] [--open]
 */
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CATALOG, measuredNote } from "./catalog.ts";
import * as downloads from "./downloads.ts";
import { fitFor, HEADROOM_MIB, type Fit, type Gpu } from "./fit.ts";
import { readGguf, type GgufInfo } from "./gguf.ts";
import { hardwareOf, isRecord, probeServer, readEngine, readGpus, type EngineInfo, type Hardware, type ServedModel } from "./hardware.ts";
import * as launcher from "./launcher.ts";

const WIN = process.platform === "win32";
const HOME = os.homedir();
/** ui/server -> ui -> og-llama-cpp */
const PROJECT_ROOT = path.resolve(import.meta.dir, "..", "..");
const UI_ROOT = path.resolve(import.meta.dir, "..");
const DIST = path.join(UI_ROOT, "dist", "ui", "browser");
const SERVE_SCRIPT = path.join(PROJECT_ROOT, "serve.ts");
const DEFAULT_CTX = 32768;

interface Options {
	host: string;
	port: number;
	root: string;
	modelsDir: string;
	/** Port serve.ts binds: the one this page probes and launches on. */
	serverPort: number;
	open: boolean;
}

const DEFAULTS: Options = {
	host: "127.0.0.1",
	port: 8130,
	root: process.env["OG_LLAMA_ROOT"] ?? path.join(HOME, ".local", "llama.cpp"),
	modelsDir: process.env["OG_MODELS_DIR"] ?? path.join(HOME, "models"),
	serverPort: 8127,
	open: false,
};

const USAGE = `Usage: bun run ui/server/main.ts [options]

Serves the model UI: the GGUF weights on this machine, the ones this repository
knows how to fetch, and whether each one fits this GPU. Launching a model hands
off to serve.ts, which owns the llama-server argv.

Options:
  --port <n>            UI port (default: ${DEFAULTS.port})
  --host <h>            UI bind address (default: ${DEFAULTS.host})
  --models-dir <path>   GGUF weights (default: ${DEFAULTS.modelsDir}, env OG_MODELS_DIR)
  --root <path>         llama.cpp install root (default: ${DEFAULTS.root}, env OG_LLAMA_ROOT)
  --server-port <n>     port llama-server is probed on and launched with (default: ${DEFAULTS.serverPort})
  --open                open the page in the default browser
  --help                print this message and exit

Build the page first: cd ui && npm run build (or bun run ui:build from the
project root). Downloads land as <name>.gguf.part and are renamed on completion,
so an interrupted transfer never looks like usable weights. Ctrl-C stops the UI,
any download it started, and any llama-server it launched.

Loopback and unauthenticated by design: it can spawn processes and write files.`;

class UsageError extends Error {}

function positiveInt(flag: string, raw: string): number {
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) throw new UsageError(`${flag} expects a positive integer, got '${raw}'`);
	return value;
}

function parseArgs(argv: readonly string[]): Options | "help" {
	const options: Options = { ...DEFAULTS };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[++index];
			if (next === undefined) throw new UsageError(`${flag} expects a value`);
			return next;
		};
		switch (flag) {
			case "--help":
			case "-h":
				return "help";
			case "--port":
				options.port = positiveInt(flag, value());
				break;
			case "--host":
				options.host = value();
				break;
			case "--models-dir":
				options.modelsDir = path.resolve(value());
				break;
			case "--root":
				options.root = path.resolve(value());
				break;
			case "--server-port":
				options.serverPort = positiveInt(flag, value());
				break;
			case "--open":
				options.open = true;
				break;
			default:
				throw new UsageError(`unknown option '${flag}'`);
		}
	}
	return options;
}

interface InstalledModel {
	file: string;
	path: string;
	sizeBytes: number;
	arch?: string;
	layers?: number;
	trainedContext?: number;
	experts?: number;
	moe: boolean;
	fit: Fit;
	measured?: string;
	catalogKey?: string;
	/**
	 * Set when the file is shorter than the catalogued content-length — a download
	 * in flight, or a transfer that died. Serving it would fail minutes into
	 * loading with a tensor-count error.
	 */
	incomplete?: { haveBytes: number; expectBytes: number };
}

interface StateResponse {
	hardware: Hardware;
	engine: EngineInfo;
	server: { url: string; reachable: boolean; models: ServedModel[]; launchedHere: boolean; launching: boolean; pid?: number; log: string[] };
	installed: InstalledModel[];
	catalog: (Omit<(typeof CATALOG)[number], never> & { installed: boolean; fit: Fit; download?: downloads.DownloadView })[];
	modelsDir: string;
	ctx: number;
}

/** GGUF metadata is cached by mtime: parsing is cheap, but not once per poll per file. */
const ggufCache = new Map<string, { mtimeMs: number; info: GgufInfo | undefined }>();

function inspect(file: string): GgufInfo | undefined {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
	const cached = ggufCache.get(file);
	if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.info;
	const info = readGguf(file);
	ggufCache.set(file, { mtimeMs, info });
	return info;
}

function listGgufs(dir: string): string[] {
	try {
		if (!statSync(dir).isDirectory()) return [];
		return readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".gguf"))
			.sort();
	} catch {
		return [];
	}
}

function installedModels(modelsDir: string, ctx: number, gpu: Gpu | undefined, ramFreeMiB: number): InstalledModel[] {
	const models: InstalledModel[] = [];
	for (const file of listGgufs(modelsDir)) {
		const full = path.join(modelsDir, file);
		let sizeBytes: number;
		try {
			sizeBytes = statSync(full).size;
		} catch {
			continue; // deleted between listing and stat
		}
		const info = inspect(full);
		const moe = (info?.expertCount ?? 0) > 0 || (info?.expertBytes ?? 0) > 0;
		const entry = CATALOG.find((candidate) => candidate.file === file);
		// Fit is answered for the finished file: a verdict that changes the moment a
		// download completes would be worse than useless.
		const expectBytes = entry?.sizeBytes ?? sizeBytes;
		const model: InstalledModel = {
			file,
			path: full,
			sizeBytes,
			moe,
			fit: fitFor({ file, sizeBytes: expectBytes, info, moe, ctx, gpu, ramFreeMiB }),
		};
		if (info?.arch !== undefined) model.arch = info.arch;
		if (info?.blockCount !== undefined) model.layers = info.blockCount;
		if (info?.trainedContext !== undefined) model.trainedContext = info.trainedContext;
		if (info?.expertCount !== undefined) model.experts = info.expertCount;
		const measured = measuredNote(file);
		if (measured !== undefined) model.measured = measured;
		if (entry !== undefined) {
			model.catalogKey = entry.key;
			if (sizeBytes < entry.sizeBytes) model.incomplete = { haveBytes: sizeBytes, expectBytes: entry.sizeBytes };
		}
		models.push(model);
	}
	return models;
}

async function snapshot(options: Options, ctx: number): Promise<StateResponse> {
	const [gpus, engine, probe] = await Promise.all([readGpus(), readEngine(options.root), probeServer(options.serverPort)]);
	const hardware = hardwareOf(gpus, HEADROOM_MIB);
	const gpu = gpus[0];
	const installed = installedModels(options.modelsDir, ctx, gpu, hardware.ramFreeMiB);
	const launched = launcher.status();

	const catalog = CATALOG.map((entry) => {
		const local = installed.find((model) => model.file === entry.file);
		const fit = local?.fit ?? fitFor({ file: entry.file, sizeBytes: entry.sizeBytes, moe: entry.moe, ctx, gpu, ramFreeMiB: hardware.ramFreeMiB });
		const download = downloads.viewOf(entry.key);
		return {
			...entry,
			installed: local !== undefined && local.incomplete === undefined,
			fit,
			...(download === undefined ? {} : { download }),
		};
	});

	return {
		hardware,
		engine,
		server: {
			url: `http://127.0.0.1:${options.serverPort}`,
			reachable: probe.reachable,
			models: probe.models,
			launchedHere: launched.pid !== null,
			// A llama-server binds its port and answers 503 for the seconds or minutes
			// it spends loading a 16 GiB file, so "answering" is not "ready": until it
			// names a model, it is still loading.
			launching: launched.pid !== null && probe.models.length === 0,
			...(launched.pid === null ? {} : { pid: launched.pid }),
			log: launched.log,
		},
		installed,
		catalog,
		modelsDir: options.modelsDir,
		ctx,
	};
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await req.json();
		return isRecord(body) ? body : {};
	} catch {
		return {};
	}
}

/**
 * Static files for the built Angular app, with an index.html fallback so a deep
 * link survives a reload. A missing build is reported, not 404'd: forgetting the
 * build step is the likeliest reason this ever happens.
 */
async function serveStatic(pathname: string): Promise<Response> {
	const index = Bun.file(path.join(DIST, "index.html"));
	if (!(await index.exists())) {
		return new Response(`The UI is not built yet.\n\nRun:  cd ${UI_ROOT} && npm run build\nThen reload this page. The JSON API on /api/* works regardless.\n`, {
			status: 503,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	const relative = pathname.replace(/^\/+/, "");
	if (relative !== "") {
		const candidate = path.resolve(DIST, relative);
		// Containment check: a request path must not escape the build output.
		if (candidate.startsWith(DIST)) {
			const file = Bun.file(candidate);
			if (await file.exists()) return new Response(file);
		}
	}
	return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function main(): Promise<number> {
	let parsed: Options | "help";
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`model-ui: ${error.message}\n\n${USAGE}\n`);
			return 1;
		}
		throw error;
	}
	if (parsed === "help") {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const options = parsed;
	const launchOptions: launcher.LaunchOptions = {
		serveScript: SERVE_SCRIPT,
		cwd: PROJECT_ROOT,
		root: options.root,
		modelsDir: options.modelsDir,
		port: options.serverPort,
	};

	const ui = Bun.serve({
		hostname: options.host,
		port: options.port,
		idleTimeout: 30,
		async fetch(req) {
			const url = new URL(req.url);
			const { pathname } = url;

			if (pathname === "/api/state") {
				const raw = Number.parseInt(url.searchParams.get("ctx") ?? "", 10);
				return Response.json(await snapshot(options, Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CTX));
			}
			if (req.method === "POST" && pathname === "/api/download") {
				const body = await readJson(req);
				const entry = CATALOG.find((candidate) => candidate.key === body["key"]);
				if (entry === undefined) return new Response(`unknown catalog key ${JSON.stringify(body["key"])}`, { status: 404 });
				downloads.start(entry, options.modelsDir);
				return Response.json({ started: entry.key });
			}
			if (req.method === "POST" && pathname === "/api/download/cancel") {
				const body = await readJson(req);
				const key = typeof body["key"] === "string" ? body["key"] : "";
				if (!downloads.cancel(key)) return new Response("no such download", { status: 404 });
				return Response.json({ cancelled: key });
			}
			if (req.method === "POST" && pathname === "/api/serve") {
				const engine = await readEngine(options.root);
				if (!engine.present) {
					const installer = WIN ? ".\\install-engine.ps1" : "./install-engine.sh";
					return new Response(`no llama-server at ${engine.binary} — run ${installer} first`, { status: 409 });
				}
				const body = await readJson(req);
				const file = body["file"];
				if (typeof file !== "string" || file.length === 0) return new Response("`file` is required", { status: 400 });
				const request: launcher.LaunchRequest = { file };
				const ctx = body["ctx"];
				if (typeof ctx === "number" && ctx > 0) request.ctx = Math.trunc(ctx);
				const ncmoe = body["ncmoe"];
				if (typeof ncmoe === "number" && ncmoe >= 0) request.ncmoe = Math.trunc(ncmoe);
				const alias = body["alias"];
				if (typeof alias === "string" && alias.length > 0) request.alias = alias;
				const pid = launcher.launch(launchOptions, request);
				return Response.json({ launched: file, pid });
			}
			if (req.method === "POST" && pathname === "/api/server/stop") {
				launcher.stop();
				return Response.json({ stopped: true });
			}
			if (pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

			return await serveStatic(pathname);
		},
	});

	const address = `http://${options.host}:${ui.port}`;
	process.stdout.write(`model-ui on ${address}\n`);
	process.stdout.write(`  models dir  ${options.modelsDir}\n`);
	process.stdout.write(`  engine root ${options.root}\n`);
	process.stdout.write(`  server port ${options.serverPort} (launches go through ${SERVE_SCRIPT})\n`);
	if (options.open) {
		const opener = WIN ? ["cmd", "/c", "start", "", address] : process.platform === "darwin" ? ["open", address] : ["xdg-open", address];
		try {
			Bun.spawn(opener, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		} catch {
			// Headless box: the address printed above is enough.
		}
	}
	// Bun.serve holds the loop open; teardown happens in the signal handlers below.
	await new Promise<void>(() => {});
	return 0;
}

// Anything this process started dies with it: a leaked llama-server holds the GPU,
// and a leaked download leaves a .part file that is not usable weights.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		launcher.stop();
		downloads.cancelAll();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

process.exitCode = await main();
