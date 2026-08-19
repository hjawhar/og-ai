/**
 * The Hugging Face index behind the UI's model explorer.
 *
 * `catalog.ts` is six files somebody here actually measured. This is the other
 * half of "what else can I run": the Hub's own search, filtered to repositories
 * that ship GGUF, because llama.cpp loads nothing else — a repository of
 * safetensors is not a thing this engine can serve, so it is not offered.
 *
 * Three Hub endpoints, all public for public repositories:
 *   GET /api/models?search=&filter=gguf&expand[]=...   repository list
 *   GET /api/models/<id>?blobs=true                    per-file sizes
 *   GET /<id>/resolve/main/<path> with a Range header   the file's own GGUF head
 * The third is the one worth having: 4 MiB of a 16 GiB file carries the metadata
 * that sizes a KV cache, so "does this fit" can be answered with arithmetic
 * instead of a guess *before* the download, which is the whole point of this UI.
 *
 * Gated repositories (Google's own Gemma weights, Meta's Llama) answer 401
 * without an accepted licence and a token, so `HF_TOKEN` is forwarded when the
 * environment has one and `gated` is reported either way: a 16 GiB transfer that
 * dies on its first byte should be predictable, not a surprise.
 *
 * Read-only. Only downloads.ts writes weights, and only the installers write
 * under $OG_LLAMA_ROOT.
 */
import { isRecord } from "./hardware.ts";
import { parseGguf, type GgufInfo } from "./gguf.ts";

const MIB = 1024 * 1024;
const HUB = "https://huggingface.co";
/** Repos scanned per browse. The Hub's own cap is 100; 48 is already more than a person reads. */
export const MAX_LIMIT = 48;
export const DEFAULT_LIMIT = 24;
/** Same windows readGguf uses locally: the tensor table grows with tensor count. */
const HEAD_WINDOWS = [4 * MIB, 48 * MIB] as const;
/**
 * Repo file lists are cached because a browse asks for two dozen at once and
 * flipping a filter must not re-ask the Hub for any of them. Ten minutes: long
 * enough to make filtering instant, short enough that a repo which gains a quant
 * shows it without restarting the server.
 */
const REPO_TTL_MS = 10 * 60 * 1000;
/** Simultaneous Hub requests. 12 in parallel measured 368 ms; 8 is polite and no slower in practice. */
const FETCH_WIDTH = 8;

export class HubError extends Error {
	/** What this server should answer with. 401/403 pass through; everything else is a 502. */
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "HubError";
		this.status = status;
	}
}

export interface HubRepo {
	/** `<owner>/<name>`, the Hub's own identifier. */
	id: string;
	downloads: number;
	likes: number;
	/** Hugging Face requires accepted terms; without a token the download will 401. */
	gated: boolean;
	/** The repository's own tags, minus the machine-generated ones nobody reads. */
	tags: string[];
	pipeline?: string;
	updatedAt?: string;
}

export interface HubFile {
	/** Path inside the repository, which may sit in a quantisation subdirectory. */
	rfilename: string;
	/** Flat name it lands under in the models dir; the dir serve.ts reads is flat. */
	file: string;
	quant?: string;
	/** Total across every shard, so the number is what the download will transfer. */
	sizeBytes: number;
	/** 1 for a normal file; gguf-split weights need every part. */
	shards: number;
	downloadKey: string;
}

export interface HubModel {
	repo: HubRepo;
	files: HubFile[];
}

/**
 * GGUF files a repository ships that are not weights. A vision projector and a
 * multi-token-prediction head are separate modules llama.cpp takes through flags
 * serve.ts does not build; an importance matrix is quantisation input that is not
 * a model at all. Being small is the dangerous part — a 183 MiB imatrix beside a
 * 30B coder reads as the one thing on the page that comfortably fits, and
 * launches into nothing.
 *
 * Matched as whole name tokens rather than as substrings or prefixes, because the
 * marker lands wherever the publisher put it: `mmproj-F16.gguf`,
 * `MTP/mtp-gemma-4-31B-it-BF16.gguf`, `imatrix_unsloth.gguf` and
 * `Kwaipilot_KAT-Coder-V2.5-Dev-imatrix.gguf` are all the same case.
 */
const NOT_WEIGHTS = new Set(["mmproj", "mtp", "imatrix"]);

/** Whether a repository path names an auxiliary module rather than servable weights. */
export function isNotWeights(rfilename: string): boolean {
	const stem = flatName(rfilename)
		.replace(/\.gguf$/i, "")
		.toLowerCase();
	return stem.split(/[-_.]+/).some((token) => NOT_WEIGHTS.has(token));
}

export interface HubPart {
	file: string;
	url: string;
	sizeBytes: number;
}

export interface HubInspection {
	info: GgufInfo;
	/**
	 * Sharded weights: shard 1 carries the metadata that sizes the KV cache, but
	 * its tensor table only covers shard 1, so the expert-tensor total is an
	 * undercount and no `--n-cpu-moe` suggestion built on it would be honest.
	 */
	expertsUnknown: boolean;
}

/** The token, when the environment has one. One owner, so gated failures have one explanation. */
export function hubToken(): string | undefined {
	const raw = process.env["HF_TOKEN"] ?? process.env["HUGGING_FACE_HUB_TOKEN"] ?? "";
	return raw.length > 0 ? raw : undefined;
}

/**
 * Authorization for huggingface.co and nothing else. Resolve URLs redirect to a
 * pre-signed CDN host, where fetch drops the header across origins — which is
 * both correct and required: the CDN rejects a bearer token it did not ask for.
 */
export function authHeaders(url: string): Record<string, string> {
	const token = hubToken();
	if (token === undefined || !url.startsWith(`${HUB}/`)) return {};
	return { authorization: `Bearer ${token}` };
}

export function downloadKeyOf(repoId: string, rfilename: string): string {
	return `hf:${repoId}/${rfilename}`;
}

export function resolveUrl(repoId: string, rfilename: string): string {
	const encoded = rfilename
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `${HUB}/${repoId}/resolve/main/${encoded}`;
}

/** Basename: the models dir is flat, and a repository path is not a filename. */
export function flatName(rfilename: string): string {
	return rfilename.slice(rfilename.lastIndexOf("/") + 1);
}

const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** The gguf-split naming convention, or undefined for a single file. */
export function splitOf(rfilename: string): { base: string; index: number; count: number } | undefined {
	const match = SPLIT.exec(rfilename);
	if (match === null) return undefined;
	const [, base, index, count] = match;
	if (base === undefined || index === undefined || count === undefined) return undefined;
	const parsedCount = Number.parseInt(count, 10);
	if (parsedCount < 1) return undefined;
	return { base, index: Number.parseInt(index, 10), count: parsedCount };
}

/** Every path a split model needs, in order; the single path itself otherwise. */
export function shardPaths(rfilename: string): string[] {
	const split = splitOf(rfilename);
	if (split === undefined) return [rfilename];
	const paths: string[] = [];
	for (let index = 1; index <= split.count; index++) {
		paths.push(`${split.base}-${String(index).padStart(5, "0")}-of-${String(split.count).padStart(5, "0")}.gguf`);
	}
	return paths;
}

/**
 * Quantisation as published in the filename — `Q4_K_M`, `UD-Q3_K_XL`, `IQ4_XS`,
 * `BF16`. The last match wins because the quant is the trailing token of every
 * naming scheme in use, and unsloth's `UD-` prefix is part of the answer: it is a
 * different file from plain `Q4_K_XL`.
 */
const QUANT = /(?:^|[-._/])((?:UD-)?(?:I?Q\d(?:_[A-Za-z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?|TQ\d_\d))(?=[-._/]|$)/gi;

export function quantOf(rfilename: string): string | undefined {
	const split = splitOf(rfilename);
	// The whole path, not the basename: repositories that ship one quant per
	// directory put the answer in the directory name and nowhere else.
	const stem = split === undefined ? rfilename.replace(/\.gguf$/i, "") : split.base;
	let found: string | undefined;
	for (const match of stem.matchAll(QUANT)) {
		const value = match[1];
		if (value !== undefined) found = value;
	}
	return found === undefined ? undefined : found.toUpperCase();
}

export function parseRepo(raw: unknown): HubRepo | undefined {
	if (!isRecord(raw)) return undefined;
	const id = raw["id"] ?? raw["modelId"];
	if (typeof id !== "string" || id.length === 0) return undefined;
	const repo: HubRepo = {
		id,
		downloads: numberOf(raw["downloads"]),
		likes: numberOf(raw["likes"]),
		// The Hub sends `false` or one of the strings "auto"/"manual", so anything
		// truthy means a licence has to be accepted before a byte will transfer.
		gated: raw["gated"] !== false && raw["gated"] !== undefined && raw["gated"] !== null,
		tags: tagsOf(raw["tags"]),
	};
	const pipeline = raw["pipeline_tag"];
	if (typeof pipeline === "string" && pipeline.length > 0) repo.pipeline = pipeline;
	const updated = raw["lastModified"];
	if (typeof updated === "string" && updated.length > 0) repo.updatedAt = updated;
	return repo;
}

export function parseSearch(raw: unknown): HubRepo[] {
	if (!Array.isArray(raw)) throw new HubError("huggingface.co returned a search body that is not a list", 502);
	const repos: HubRepo[] = [];
	for (const entry of raw) {
		const repo = parseRepo(entry);
		if (repo !== undefined) repos.push(repo);
	}
	return repos;
}

/**
 * Note what is *not* here: whether the model is MoE. The Hub's `config` does not
 * reliably say — `gemma-4-26B-A4B-it` is an MoE that publishes `model_type:
 * "gemma4"` — and the filename convention "A4B" is a convention, not metadata.
 * `inspect` reads the answer out of the file's own tensor table, which is the
 * only place it is actually written down.
 */
export function parseModel(raw: unknown): HubModel | undefined {
	const repo = parseRepo(raw);
	if (repo === undefined || !isRecord(raw)) return undefined;
	return { repo, files: collectFiles(repo.id, raw["siblings"]) };
}

/** Sizes of every `.gguf` in the repository, keyed by repository path. */
export function sizeIndex(raw: unknown): Map<string, number> {
	const sizes = new Map<string, number>();
	if (!isRecord(raw) || !Array.isArray(raw["siblings"])) return sizes;
	for (const sibling of raw["siblings"]) {
		if (!isRecord(sibling)) continue;
		const rfilename = sibling["rfilename"];
		if (typeof rfilename !== "string" || !rfilename.toLowerCase().endsWith(".gguf")) continue;
		sizes.set(rfilename, sizeOf(sibling));
	}
	return sizes;
}

/**
 * The presets are *queries*, not lists of models. Each one is a set of Hub tags
 * and a sort order, so what appears is whatever the Hub says today — there is no
 * curated list here to go stale, and `note` states the query so nobody has to
 * trust a label like "top agentic coding models" on faith.
 *
 * The tags are real Hub facets, checked against the live API: `gguf` (applied
 * automatically to any repository containing one), plus `code`, `agent`,
 * `tool-use` and `reasoning` as their authors applied them.
 */
export interface HubPreset {
	key: string;
	label: string;
	note: string;
	tags: string[];
	sort: SortKey;
}

export const PRESETS: HubPreset[] = [
	{
		key: "agentic-coding",
		label: "Agentic coding",
		note: "Hub tags gguf + code + agent, most downloaded first — models published for writing code and driving tools.",
		tags: ["gguf", "code", "agent"],
		sort: "downloads",
	},
	{
		key: "coding",
		label: "Coding",
		note: "Hub tags gguf + code, most downloaded first. Wider than agentic coding: no tool-use claim.",
		tags: ["gguf", "code"],
		sort: "downloads",
	},
	{
		key: "tool-use",
		label: "Tool use",
		note: "Hub tags gguf + tool-use, most downloaded first.",
		tags: ["gguf", "tool-use"],
		sort: "downloads",
	},
	{
		key: "reasoning",
		label: "Reasoning",
		note: "Hub tags gguf + reasoning, most downloaded first.",
		tags: ["gguf", "reasoning"],
		sort: "downloads",
	},
	{
		key: "trending",
		label: "Trending now",
		note: "Every GGUF repository by the Hub's own trending score — what is being picked up this week, coding or not.",
		tags: ["gguf"],
		sort: "trending",
	},
	{
		key: "popular",
		label: "Most downloaded",
		note: "Every GGUF repository by all-time downloads.",
		tags: ["gguf"],
		sort: "downloads",
	},
];

export const DEFAULT_PRESET = "agentic-coding";

export type SortKey = "downloads" | "trending" | "likes" | "modified";

/** Sort vocabulary, with the Hub field each one maps to. */
export const SORTS: { key: SortKey; label: string; field: string }[] = [
	{ key: "downloads", label: "Most downloaded", field: "downloads" },
	{ key: "trending", label: "Trending", field: "trendingScore" },
	{ key: "likes", label: "Most liked", field: "likes" },
	{ key: "modified", label: "Recently updated", field: "lastModified" },
];

export function presetOf(key: string): HubPreset {
	const preset = PRESETS.find((candidate) => candidate.key === key);
	if (preset === undefined) throw new HubError(`unknown preset '${key}'; expected one of ${PRESETS.map((entry) => entry.key).join(", ")}`, 400);
	return preset;
}

export function sortOf(key: string): { key: SortKey; label: string; field: string } {
	const sort = SORTS.find((candidate) => candidate.key === key);
	if (sort === undefined) throw new HubError(`unknown sort '${key}'; expected one of ${SORTS.map((entry) => entry.key).join(", ")}`, 400);
	return sort;
}

/**
 * The Hub query one browse runs. Separate from the fetch so the mapping from a
 * preset to a URL is checkable without a network: a preset that silently dropped
 * a tag would widen the list to every GGUF on the Hub and nothing would look
 * wrong.
 */
export function browseParams(preset: HubPreset, search: string, sort: SortKey, limit: number): URLSearchParams {
	const params = new URLSearchParams({ sort: sortOf(sort).field, direction: "-1", limit: String(Math.max(1, Math.min(MAX_LIMIT, limit))) });
	if (search.length > 0) params.set("search", search);
	// Tags are ANDed by the Hub, which is what makes a preset a filter rather than
	// a suggestion: `code` + `agent` returns only repositories carrying both.
	for (const tag of preset.tags) params.append("filter", tag);
	// Without expand[] the list omits `gated` and `lastModified`, and defaulting
	// `gated` to false would promise a download that 401s.
	for (const field of ["gated", "downloads", "likes", "tags", "pipeline_tag", "lastModified"]) params.append("expand[]", field);
	return params;
}

/** One page of repositories for a preset, narrowed by an optional free-text query. */
export async function listRepos(preset: HubPreset, search: string, sort: SortKey, limit: number): Promise<HubRepo[]> {
	return parseSearch(await getJson(`/api/models?${browseParams(preset, search, sort, limit).toString()}`));
}

/**
 * Every repository's file list, fetched concurrently and cached. This is what
 * makes "only show what fits" an answer rather than a guess: the Hub's search
 * results carry no file sizes, so the sizes are read per repository — 12 in
 * parallel measured 368 ms, which is cheap enough to do on every browse.
 */
export async function filesFor(repoIds: readonly string[]): Promise<Map<string, HubFile[]>> {
	const found = new Map<string, HubFile[]>();
	const pending: string[] = [];
	const now = Date.now();
	for (const id of repoIds) {
		const cached = repoCache.get(id);
		if (cached !== undefined && now - cached.at < REPO_TTL_MS) found.set(id, cached.files);
		else pending.push(id);
	}

	for (let start = 0; start < pending.length; start += FETCH_WIDTH) {
		const wave = pending.slice(start, start + FETCH_WIDTH);
		const results = await Promise.all(
			wave.map(async (id) => {
				try {
					return { id, files: (await model(id)).files };
				} catch {
					// One unreadable repository must not empty the page; it simply offers
					// no files, and the row says so.
					return { id, files: [] };
				}
			}),
		);
		for (const result of results) {
			repoCache.set(result.id, { at: Date.now(), files: result.files });
			found.set(result.id, result.files);
		}
	}
	return found;
}

const repoCache = new Map<string, { at: number; files: HubFile[] }>();

export async function model(repoId: string): Promise<HubModel> {
	const parsed = parseModel(await modelJson(repoId));
	if (parsed === undefined) throw new HubError(`huggingface.co returned no usable metadata for ${repoId}`, 502);
	return parsed;
}

/**
 * Every part of one file, sized from the repository rather than from its name, so
 * a download's total is the Hub's number and not arithmetic done here.
 */
export async function partsFor(repoId: string, rfilename: string): Promise<HubPart[]> {
	const sizes = sizeIndex(await modelJson(repoId));
	const parts: HubPart[] = [];
	for (const path of shardPaths(rfilename)) {
		const sizeBytes = sizes.get(path);
		if (sizeBytes === undefined) throw new HubError(`${repoId} has no file ${path}`, 404);
		parts.push({ file: flatName(path), url: resolveUrl(repoId, path), sizeBytes });
	}
	return parts;
}

/**
 * The remote file's own GGUF metadata, read over a Range request. This is what
 * turns a size guess into the same arithmetic an installed file gets.
 */
export async function inspect(repoId: string, rfilename: string): Promise<HubInspection> {
	const url = resolveUrl(repoId, rfilename);
	let lastError = "the header did not parse as GGUF";
	for (const window of HEAD_WINDOWS) {
		const head = await rangeGet(url, window);
		const info = parseGguf(head);
		if (info !== undefined) return { info, expertsUnknown: splitOf(rfilename) !== undefined };
		// A short read is the whole file: a larger window cannot help.
		if (head.length < window) break;
		lastError = `the first ${window / MIB} MiB did not contain a complete GGUF header`;
	}
	throw new HubError(`cannot read GGUF metadata from ${rfilename}: ${lastError}`, 502);
}

async function modelJson(repoId: string): Promise<unknown> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repoId)) throw new HubError(`'${repoId}' is not a <owner>/<name> repository id`, 400);
	return await getJson(`/api/models/${repoId}?blobs=true`);
}

async function getJson(pathAndQuery: string): Promise<unknown> {
	const url = `${HUB}${pathAndQuery}`;
	let res: Response;
	try {
		res = await fetch(url, { headers: { accept: "application/json", ...authHeaders(url) } });
	} catch (error) {
		throw new HubError(`cannot reach huggingface.co: ${error instanceof Error ? error.message : String(error)}`, 502);
	}
	if (!res.ok) throw new HubError(hint(res.status, `huggingface.co answered HTTP ${res.status} ${res.statusText}`), statusFor(res.status));
	try {
		return await res.json();
	} catch {
		throw new HubError("huggingface.co returned a body that is not JSON", 502);
	}
}

/**
 * The first `bytes` of a URL. A server that ignores the Range header answers 200
 * with the entire file, and streaming 16 GiB into a header parse would be the
 * worst possible way to find that out — so the body is abandoned unread.
 */
async function rangeGet(url: string, bytes: number): Promise<Buffer> {
	const controller = new AbortController();
	let res: Response;
	try {
		res = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}`, ...authHeaders(url) }, redirect: "follow", signal: controller.signal });
	} catch (error) {
		throw new HubError(`cannot reach huggingface.co: ${error instanceof Error ? error.message : String(error)}`, 502);
	}
	if (res.status === 200) {
		controller.abort();
		throw new HubError("huggingface.co ignored the range request and offered the whole file", 502);
	}
	if (res.status !== 206) throw new HubError(hint(res.status, `huggingface.co answered HTTP ${res.status} ${res.statusText} for a range request`), statusFor(res.status));
	return Buffer.from(await res.arrayBuffer());
}

function statusFor(status: number): number {
	return status === 401 || status === 403 || status === 404 ? status : 502;
}

function hint(status: number, message: string): string {
	if (status !== 401 && status !== 403) return message;
	const has = hubToken() !== undefined;
	return `${message}. This repository is gated: ${has ? "the HF_TOKEN this server is running with has not accepted its licence" : "set HF_TOKEN in the environment the UI server runs in, after accepting the licence on huggingface.co"}.`;
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The Hub mixes a repository's own tags with generated ones — `base_model:...`,
 * `license:...`, `region:us`, `endpoints_compatible`. Only the first kind says
 * anything about the model.
 */
function tagsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const skip = new Set(["endpoints_compatible", "region:us", "autotrain_compatible", "text-generation-inference", "gguf", "transformers", "imatrix"]);
	const tags: string[] = [];
	for (const tag of value) {
		if (typeof tag !== "string" || tag.includes(":") || skip.has(tag)) continue;
		tags.push(tag);
	}
	return tags;
}

function sizeOf(sibling: Record<string, unknown>): number {
	const lfs = sibling["lfs"];
	// The LFS record is the real object size; `size` degrades to the pointer file's.
	if (isRecord(lfs)) {
		const lfsSize = numberOf(lfs["size"]);
		if (lfsSize > 0) return lfsSize;
	}
	return numberOf(sibling["size"]);
}

function collectFiles(repoId: string, siblings: unknown): HubFile[] {
	if (!Array.isArray(siblings)) return [];
	const groups = new Map<string, { first: string; firstIndex: number; sizeBytes: number; shards: number }>();
	for (const sibling of siblings) {
		if (!isRecord(sibling)) continue;
		const rfilename = sibling["rfilename"];
		if (typeof rfilename !== "string" || !rfilename.toLowerCase().endsWith(".gguf")) continue;
		if (isNotWeights(rfilename)) continue;
		const split = splitOf(rfilename);
		const key = split === undefined ? rfilename : split.base;
		const size = sizeOf(sibling);
		const existing = groups.get(key);
		if (existing === undefined) {
			groups.set(key, { first: rfilename, firstIndex: split?.index ?? 1, sizeBytes: size, shards: split?.count ?? 1 });
			continue;
		}
		existing.sizeBytes += size;
		if (split !== undefined && split.index < existing.firstIndex) {
			existing.first = rfilename;
			existing.firstIndex = split.index;
		}
	}

	const files: HubFile[] = [];
	for (const group of groups.values()) {
		const file: HubFile = {
			rfilename: group.first,
			file: flatName(group.first),
			sizeBytes: group.sizeBytes,
			shards: group.shards,
			downloadKey: downloadKeyOf(repoId, group.first),
		};
		const quant = quantOf(group.first);
		if (quant !== undefined) file.quant = quant;
		files.push(file);
	}
	// Smallest first: on a fixed card the interesting question is what fits, and
	// the answer is at the top of that order.
	return files.sort((left, right) => left.sizeBytes - right.sizeBytes || left.file.localeCompare(right.file));
}
