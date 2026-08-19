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
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { measuredNote } from "./catalog.ts";
import * as downloads from "./downloads.ts";
import { bestFitting, fitFor, HEADROOM_MIB, type Fit, type Gpu } from "./fit.ts";
import { readGguf, type GgufInfo } from "./gguf.ts";
import * as hub from "./hub.ts";
import { hardwareOf, isRecord, probeServer, readEngine, readGpus, type EngineInfo, type Hardware, type ServedModel } from "./hardware.ts";
import * as launcher from "./launcher.ts";
import { remove, shardsOf, WeightsError } from "./weights.ts";

const WIN = process.platform === "win32";
const HOME = os.homedir();
/** ui/server -> ui -> og-llama-cpp */
const PROJECT_ROOT = path.resolve(import.meta.dir, "..", "..");
const UI_ROOT = path.resolve(import.meta.dir, "..");
const DIST = path.join(UI_ROOT, "dist", "ui", "browser");
const SERVE_SCRIPT = path.join(PROJECT_ROOT, "serve.ts");
const DEFAULT_CTX = 32768;
const MIB = 1024 * 1024;

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

Searching Hugging Face needs no credentials, but a gated repository (Google's own
Gemma weights, Meta's Llama) answers 401 until its licence is accepted and a
token is in this process's environment as HF_TOKEN or HUGGING_FACE_HUB_TOKEN.

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
	/**
	 * Why this file must not be served yet. `downloading` means a `.part` sibling
	 * sits beside it; `short` means the file's own tensor table needs more bytes
	 * than the file has, which is a transfer that died. Both are read from the
	 * filesystem and the file's own header — there is no catalogued size to
	 * compare against any more, and a GGUF that is short fails minutes into
	 * loading with a tensor-count error.
	 */
	incomplete?: { reason: "downloading" | "short"; haveBytes: number; expectBytes?: number };
	/**
	 * Every file that removing this one takes with it. `[file]` for an ordinary
	 * model; a whole `gguf-split` set otherwise, because llama.cpp opens shard 1
	 * and expects its siblings, so removing one shard breaks a model rather than
	 * freeing it.
	 */
	shards: string[];
	/**
	 * Why this file cannot be deleted right now, as a sentence to show. Absent
	 * when it can. Decided here rather than in the browser: the obstacles are a
	 * running server holding the file mapped and a transfer about to rename over
	 * it, and only this process knows both.
	 */
	blocked?: string;
}

interface StateResponse {
	hardware: Hardware;
	engine: EngineInfo;
	server: {
		url: string;
		reachable: boolean;
		models: ServedModel[];
		launchedHere: boolean;
		launching: boolean;
		pid?: number;
		/** Weights this process launched, when it launched any. */
		file?: string;
		log: string[];
	};
	installed: InstalledModel[];
	/** Every download this process knows about, keyed the way it was started. */
	downloads: Record<string, downloads.DownloadView>;
	/** Whether a gated Hugging Face repository could be fetched at all. */
	hubTokenPresent: boolean;
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

/**
 * Filenames compared the way the filesystem compares them. NTFS is
 * case-insensitive, so `qwen2.5-coder-0.5b-instruct-q4_k_m.gguf` and
 * `Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf` are one file; treating them as two
 * reports installed weights as missing and offers a download over them.
 */
function fold(name: string): string {
	return WIN ? name.toLowerCase() : name;
}

function installedModels(modelsDir: string, ctx: number, gpu: Gpu | undefined, ramFreeMiB: number, held: HeldWeights): InstalledModel[] {
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
		const model: InstalledModel = {
			file,
			path: full,
			sizeBytes,
			moe,
			fit: fitFor({ file, sizeBytes, info, moe, ctx, gpu, ramFreeMiB }),
			shards: shardsOf(file),
		};
		if (info?.arch !== undefined) model.arch = info.arch;
		if (info?.blockCount !== undefined) model.layers = info.blockCount;
		if (info?.trainedContext !== undefined) model.trainedContext = info.trainedContext;
		if (info?.expertCount !== undefined) model.experts = info.expertCount;
		const measured = measuredNote(file);
		if (measured !== undefined) model.measured = measured;
		const incomplete = incompleteness(full, sizeBytes, info);
		if (incomplete !== undefined) model.incomplete = incomplete;
		const blocked = blockedReason(file, held);
		if (blocked !== undefined) model.blocked = blocked;
		models.push(model);
	}
	return models;
}

/**
 * Whether a file on disk is not yet servable, answered from the file rather than
 * from a catalogued byte count: a `.part` sibling means a transfer is running,
 * and a tensor table that needs more bytes than the file holds means one died.
 * The second test is one-directional — it proves short, never proves complete —
 * which is the honest shape for this, since only the header is read.
 */
function incompleteness(full: string, sizeBytes: number, info: GgufInfo | undefined): InstalledModel["incomplete"] {
	if (existsSync(`${full}.part`)) return { reason: "downloading", haveBytes: sizeBytes };
	if (info !== undefined && info.tensorBytes > sizeBytes) {
		return { reason: "short", haveBytes: sizeBytes, expectBytes: Math.round(info.tensorBytes) };
	}
	return undefined;
}

/** What a running server and an in-flight transfer are holding, for one snapshot. */
interface HeldWeights {
	/** Weights this process launched, when it launched any. */
	launched: string | null;
	/** Model ids the server names, which serve.ts aliases from the filename. */
	servedIds: string[];
}

/**
 * Why a file cannot be deleted, as the sentence the page shows. Two obstacles,
 * both real: a running llama-server holds its weights mapped, which on Windows
 * makes the file undeletable and everywhere makes deleting it a way to break a
 * live server; and a transfer in flight would rename over the name seconds later.
 *
 * The served-id comparison is the fallback for a server this process did not
 * start: serve.ts aliases a model to its filename without the extension, so that
 * is what the server reports.
 */
function blockedReason(file: string, held: HeldWeights): string | undefined {
	if (downloads.isArriving(file)) return "a download is writing this file — cancel it first";
	const shards = shardsOf(file).map(fold);
	if (held.launched !== null && shards.includes(fold(held.launched))) {
		return "the server started here has this file open — stop the server first";
	}
	const stem = fold(file.replace(/\.gguf$/i, ""));
	if (held.servedIds.some((id) => fold(id) === stem)) {
		return "the running server is serving this file — stop it first";
	}
	return undefined;
}

async function snapshot(options: Options, ctx: number): Promise<StateResponse> {
	const [gpus, engine, probe] = await Promise.all([readGpus(), readEngine(options.root), probeServer(options.serverPort)]);
	const hardware = hardwareOf(gpus, HEADROOM_MIB);
	const gpu = gpus[0];
	const launched = launcher.status();
	const held: HeldWeights = { launched: launched.file, servedIds: probe.models.map((model) => model.id) };
	const installed = installedModels(options.modelsDir, ctx, gpu, hardware.ramFreeMiB, held);

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
			...(launched.file === null ? {} : { file: launched.file }),
			log: launched.log,
		},
		installed,
		downloads: downloads.all(),
		hubTokenPresent: hub.hubToken() !== undefined,
		modelsDir: options.modelsDir,
		ctx,
	};
}

type FitFilter = "any" | "runs" | "gpu";
type GatedFilter = "any" | "open";

function fitFilterOf(raw: string | null): FitFilter {
	if (raw === null || raw.length === 0 || raw === "any") return "any";
	if (raw === "runs" || raw === "gpu") return raw;
	throw new hub.HubError(`unknown fit '${raw}'; expected any, runs or gpu`, 400);
}

function gatedFilterOf(raw: string | null): GatedFilter {
	if (raw === null || raw.length === 0 || raw === "any") return "any";
	if (raw === "open") return "open";
	throw new hub.HubError(`unknown gated '${raw}'; expected any or open`, 400);
}

function ctxOf(url: URL): number {
	const raw = Number.parseInt(url.searchParams.get("ctx") ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CTX;
}

/**
 * The two hardware facts a fit verdict needs, without the rest of a snapshot's
 * work: a Hub question does not need to probe llama-server or read the models dir.
 */
async function fitEnvironment(): Promise<{ gpu: Gpu | undefined; ramFreeMiB: number }> {
	const gpus = await readGpus();
	return { gpu: gpus[0], ramFreeMiB: hardwareOf(gpus, HEADROOM_MIB).ramFreeMiB };
}

/** Hub failures carry the status the operator should see; nothing else becomes a 502. */
function hubFailure(error: unknown): Response {
	if (error instanceof hub.HubError) return new Response(error.message, { status: error.status });
	return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
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
				return Response.json(await snapshot(options, ctxOf(url)));
			}
			if (pathname === "/api/hub/browse") {
				try {
					const preset = hub.presetOf(url.searchParams.get("preset") ?? hub.DEFAULT_PRESET);
					const sort = hub.sortOf(url.searchParams.get("sort") ?? preset.sort);
					const fitFilter = fitFilterOf(url.searchParams.get("fit"));
					const gatedFilter = gatedFilterOf(url.searchParams.get("gated"));
					const search = (url.searchParams.get("q") ?? "").trim();
					const ctx = ctxOf(url);
					const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
					const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, hub.MAX_LIMIT) : hub.DEFAULT_LIMIT;
					const rawMax = Number.parseFloat(url.searchParams.get("maxGiB") ?? "");
					const maxBytes = Number.isFinite(rawMax) && rawMax > 0 ? rawMax * 1024 * MIB : undefined;

					const scanned = await hub.listRepos(preset, search, sort.key, limit);
					const [files, environment] = await Promise.all([
						hub.filesFor(scanned.map((repo) => repo.id)),
						fitEnvironment(),
					]);
					const local = new Set(listGgufs(options.modelsDir).map(fold));

					const repos = [];
					for (const repo of scanned) {
						if (gatedFilter === "open" && repo.gated) continue;
						const listed = (files.get(repo.id) ?? []).map((file) => ({
							...file,
							// Split weights are installed only as a complete set: llama.cpp opens
							// shard 1 and expects every sibling beside it.
							installed: hub.shardPaths(file.rfilename).every((shard) => local.has(fold(hub.flatName(shard)))),
							// `moe: false` is not a claim that it is dense: without the file's
							// tensor table there is no expert total, so the --n-cpu-moe branch
							// cannot fire either way. /api/hub/inspect is what answers this.
							fit: fitFor({
								file: file.file,
								sizeBytes: file.sizeBytes,
								moe: false,
								ctx,
								gpu: environment.gpu,
								ramFreeMiB: environment.ramFreeMiB,
								remote: true,
							}),
						}));
						if (listed.length === 0) continue;
						// Size and fit are asked of the smallest and the best file rather than
						// of the repository: a repository is worth showing when *something* in
						// it runs, and the file table below the row says which.
						if (maxBytes !== undefined && !listed.some((file) => file.sizeBytes <= maxBytes)) continue;
						if (fitFilter !== "any") {
							const wanted = fitFilter === "gpu" ? ["gpu"] : ["gpu", "offload"];
							if (!listed.some((file) => wanted.includes(file.fit.verdict))) continue;
						}
						const best = bestFitting(listed)?.rfilename;
						repos.push({ repo, ...(best === undefined ? {} : { best }), files: listed });
					}

					return Response.json({
						preset: preset.key,
						presets: hub.PRESETS.map(({ key, label, note }) => ({ key, label, note })),
						sorts: hub.SORTS.map(({ key, label }) => ({ key, label })),
						query: {
							search,
							tags: preset.tags,
							sort: sort.key,
							fit: fitFilter,
							gated: gatedFilter,
							ctx,
							...(maxBytes === undefined ? {} : { maxGiB: rawMax }),
						},
						scanned: scanned.length,
						matched: repos.length,
						repos,
					});
				} catch (error) {
					return hubFailure(error);
				}
			}
			if (pathname === "/api/hub/inspect") {
				const repo = url.searchParams.get("repo") ?? "";
				const rfilename = url.searchParams.get("rfilename") ?? "";
				if (repo.length === 0 || rfilename.length === 0) return new Response("`repo` and `rfilename` are required", { status: 400 });
				const ctx = ctxOf(url);
				try {
					const [parts, inspection, environment] = await Promise.all([hub.partsFor(repo, rfilename), hub.inspect(repo, rfilename), fitEnvironment()]);
					const sizeBytes = parts.reduce((total, part) => total + part.sizeBytes, 0);
					const moe = (inspection.info.expertCount ?? 0) > 0 || inspection.info.expertBytes > 0;
					// Shard 1's tensor table covers shard 1 only, so its expert total is an
					// undercount: zeroing it keeps fitFor off the --n-cpu-moe branch rather
					// than letting it suggest a number derived from a fraction of the model.
					const info = inspection.expertsUnknown ? { ...inspection.info, expertBytes: 0 } : inspection.info;
					const body: Record<string, unknown> = {
						fit: fitFor({ file: hub.flatName(rfilename), sizeBytes, info, moe, ctx, gpu: environment.gpu, ramFreeMiB: environment.ramFreeMiB, remote: true }),
						moe,
						expertsUnknown: inspection.expertsUnknown,
						arch: info.arch,
					};
					if (info.blockCount !== undefined) body["layers"] = info.blockCount;
					if (info.trainedContext !== undefined) body["trainedContext"] = info.trainedContext;
					if (info.expertCount !== undefined) body["experts"] = info.expertCount;
					return Response.json(body);
				} catch (error) {
					return hubFailure(error);
				}
			}
			if (req.method === "POST" && pathname === "/api/download") {
				const body = await readJson(req);
				const repo = body["repo"];
				const rfilename = body["rfilename"];
				if (typeof repo !== "string" || repo.length === 0 || typeof rfilename !== "string" || rfilename.length === 0) {
					return new Response("`repo` and `rfilename` are required", { status: 400 });
				}
				try {
					// Parts are resolved against the repository's own file list, so a name
					// that is not in it never reaches the filesystem.
					const parts = await hub.partsFor(repo, rfilename);
					const key = hub.downloadKeyOf(repo, rfilename);
					downloads.start({ key, parts }, options.modelsDir);
					return Response.json({ started: key });
				} catch (error) {
					return hubFailure(error);
				}
			}
			if (req.method === "POST" && pathname === "/api/download/cancel") {
				const body = await readJson(req);
				const key = typeof body["key"] === "string" ? body["key"] : "";
				if (!downloads.cancel(key)) return new Response("no such download", { status: 404 });
				return Response.json({ cancelled: key });
			}
			if (req.method === "POST" && pathname === "/api/models/delete") {
				const body = await readJson(req);
				const file = body["file"];
				if (typeof file !== "string") return new Response("`file` is required", { status: 400 });
				// The same sentence the page already showed on the row, so the refusal
				// and the disabled button never disagree.
				const probe = await probeServer(options.serverPort);
				const blocked = blockedReason(file, { launched: launcher.status().file, servedIds: probe.models.map((model) => model.id) });
				if (blocked !== undefined) return new Response(blocked, { status: 409 });
				try {
					const removal = remove(options.modelsDir, file);
					return Response.json(removal);
				} catch (error) {
					if (error instanceof WeightsError) return new Response(error.message, { status: error.status });
					return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
				}
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
