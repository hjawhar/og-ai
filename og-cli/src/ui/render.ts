/**
 * Pure presentation helpers. No I/O, no mutation of anything but the single
 * module-level colour toggle, so every function here is trivially testable:
 * same inputs (plus the toggle) always produce the same string.
 */

import { DEFAULT_CONTEXT_WINDOW } from "../config/load.ts";
import type { OgConfig, ApprovalPolicy, ModelSpec } from "../config/schema.ts";
import type { EndpointHealth } from "../provider/types.ts";
import type { ApprovalRequest } from "../tools/types.ts";

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

const CODES = {
	bold: "1",
	dim: "2",
	red: "31",
	green: "32",
	yellow: "33",
	cyan: "36",
} as const;

type ColourName = keyof typeof CODES;

/**
 * Colour decision, split out as a pure predicate so tests never depend on the
 * ambient environment. `NO_COLOR` (any non-empty value) always wins.
 */
export function supportsColor(env: Record<string, string | undefined>, isTty: boolean): boolean {
	const no = env.NO_COLOR;
	if (no !== undefined && no !== "") return false;
	const force = env.FORCE_COLOR;
	if (force !== undefined && force !== "" && force !== "0") return true;
	if (env.TERM === "dumb") return false;
	return isTty;
}

let colourEnabled = supportsColor(process.env, process.stdout.isTTY === true);

export function setColor(on: boolean): void {
	colourEnabled = on;
}

function paint(name: ColourName, text: string): string {
	if (!colourEnabled || text === "") return text;
	return `${ESC}${CODES[name]}m${text}${RESET}`;
}

export const bold = (t: string): string => paint("bold", t);
export const dim = (t: string): string => paint("dim", t);
export const red = (t: string): string => paint("red", t);
export const green = (t: string): string => paint("green", t);
export const yellow = (t: string): string => paint("yellow", t);
export const cyan = (t: string): string => paint("cyan", t);

/** Spinner frames for single-line status updates. */
export const spinnerFrames: readonly string[] = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

export function spinnerFrame(tick: number): string {
	const frames = spinnerFrames;
	if (frames.length === 0) return "";
	const i = ((Math.trunc(tick) % frames.length) + frames.length) % frames.length;
	return frames[i] ?? "";
}

/** Human duration: 840ms, 3.2s, 1m04s, 2h07m. Never throws, never negative. */
export function elapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) {
		const sec = Math.floor(totalSec - totalMin * 60);
		return `${totalMin}m${String(sec).padStart(2, "0")}s`;
	}
	const hours = Math.floor(totalMin / 60);
	const min = totalMin - hours * 60;
	return `${hours}h${String(min).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"] as const;
	let value = bytes / 1024;
	let unit: string = units[0];
	for (let i = 1; i < units.length && value >= 1024; i++) {
		value /= 1024;
		unit = units[i] ?? unit;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Visible width in characters, ignoring SGR escapes. */
export function visibleWidth(text: string): number {
	return text.replace(ANSI_RE, "").length;
}

/**
 * Hard-truncate to `width` visible characters, preserving escape sequences so a
 * truncated coloured line still resets. Used for carriage-return status lines.
 */
export function truncateLine(text: string, width: number): string {
	if (!Number.isFinite(width) || width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let out = "";
	let seen = 0;
	let sawEscape = false;
	for (let i = 0; i < text.length; ) {
		if (text.startsWith(ESC, i)) {
			const end = text.indexOf("m", i);
			if (end !== -1) {
				out += text.slice(i, end + 1);
				sawEscape = true;
				i = end + 1;
				continue;
			}
		}
		if (seen >= width - 1) break;
		out += text[i] ?? "";
		seen++;
		i++;
	}
	return `${out}\u2026${sawEscape ? RESET : ""}`;
}

/**
 * Word-wrap to `width` columns, preserving existing newlines and the leading
 * indentation of each source line. Words longer than `width` are split.
 */
export function wrap(text: string, width: number): string {
	if (!Number.isFinite(width) || width <= 1) return text;
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		const indentMatch = /^[ \t]*/.exec(rawLine);
		const indent = indentMatch ? indentMatch[0] : "";
		const body = rawLine.slice(indent.length);
		if (body === "") {
			out.push(indent === "" ? "" : indent.replace(/\s+$/, ""));
			continue;
		}
		const limit = Math.max(width - indent.length, 8);
		let line = "";
		for (const word of body.split(/ +/)) {
			let piece = word;
			while (visibleWidth(piece) > limit) {
				if (line !== "") {
					out.push(indent + line);
					line = "";
				}
				out.push(indent + piece.slice(0, limit));
				piece = piece.slice(limit);
			}
			if (line === "") line = piece;
			else if (visibleWidth(line) + 1 + visibleWidth(piece) <= limit) line += ` ${piece}`;
			else {
				out.push(indent + line);
				line = piece;
			}
		}
		if (line !== "") out.push(indent + line);
	}
	return out.join("\n");
}

/** Compact one-line entry announcing a tool call. */
export function formatToolStart(name: string, summary: string): string {
	const head = `${dim("\u2022")} ${cyan(name)}`;
	return summary === "" ? head : `${head} ${dim(summary)}`;
}

/** Terminal form of the same entry, with outcome and duration. */
export function formatToolEnd(name: string, ok: boolean, durationMs: number, summary: string): string {
	const mark = ok ? green("\u2713") : red("\u2717");
	const label = ok ? cyan(name) : red(name);
	const parts = [`${mark} ${label}`];
	if (summary !== "") parts.push(dim(summary));
	parts.push(dim(`(${elapsed(durationMs)})`));
	return parts.join(" ");
}

export function formatUsage(
	promptTokens: number,
	completionTokens: number,
	contextUsedPct: number,
	contextTokens?: number,
	contextWindow?: number,
): string {
	const pct = Number.isFinite(contextUsedPct) ? `${Math.round(contextUsedPct)}%` : "?";
	const counts =
		contextTokens !== undefined && contextWindow !== undefined && contextWindow > 0
			? ` (${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)})`
			: "";
	return dim(`tokens ${promptTokens}\u2191 ${completionTokens}\u2193 \u00b7 context ${pct}${counts}`);
}

/**
 * Determinate gauge. Blocks render everywhere Windows Terminal, WezTerm and
 * modern VT emulators are used; set `OG_ASCII=1` for a legacy console.
 */
export function progressBar(fraction: number, width = 10): string {
	const cells = Math.max(1, Math.trunc(width));
	const safe = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
	// Round, but never show a full bar below 100% or an empty one above 0%.
	let filled = Math.round(safe * cells);
	if (filled === 0 && safe > 0) filled = 1;
	if (filled === cells && safe < 1) filled = cells - 1;
	const ascii = process.env["OG_ASCII"] !== undefined && process.env["OG_ASCII"] !== "";
	const [on, off] = ascii ? ["=", "."] : ["\u2588", "\u2591"];
	return `${on.repeat(filled)}${dim(off.repeat(cells - filled))}`;
}

/** Compact token count: 812, 3.1k, 128k. */
export function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "?";
	const n = Math.round(tokens);
	if (n < 1000) return String(n);
	const thousands = n / 1000;
	return thousands < 100 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * Context occupancy as a gauge plus both absolute numbers, e.g.
 * `ctx ███░░░░░░░ 27% 8.9k/32k`. Colour escalates as headroom disappears,
 * because a full context is what triggers history compaction.
 */
export function formatContext(usedTokens: number, windowTokens: number): string {
	if (!Number.isFinite(windowTokens) || windowTokens <= 0) return dim("ctx ?");
	const fraction = Math.min(Math.max(usedTokens / windowTokens, 0), 1);
	const pct = Math.round(fraction * 100);
	const paintPct = fraction >= 0.85 ? red : fraction >= 0.6 ? yellow : green;
	const counts = `${formatTokenCount(usedTokens)}/${formatTokenCount(windowTokens)}`;
	return `${dim("ctx")} ${progressBar(fraction)} ${paintPct(`${pct}%`)} ${dim(counts)}`;
}

/**
 * Decoding throughput. Samples shorter than a quarter second are withheld: at
 * two or three deltas the ratio swings into the hundreds and reads as a lie.
 */
export function formatTokensPerSec(completionTokens: number, wallMs: number): string {
	if (wallMs < 250 || completionTokens <= 0) return "\u2013 tok/s";
	return `${(completionTokens / (wallMs / 1000)).toFixed(1)} tok/s`;
}

/** Colourise text that looks like a unified diff; other lines pass through. */
export function formatDiffish(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("@@")) out.push(cyan(line));
		else if (line.startsWith("+++") || line.startsWith("---")) out.push(bold(line));
		else if (line.startsWith("+")) out.push(green(line));
		else if (line.startsWith("-")) out.push(red(line));
		else out.push(line);
	}
	return out.join("\n");
}

export function formatError(msg: string): string {
	return `${red("error")} ${msg}`;
}

export function formatWarn(msg: string): string {
	return `${yellow("warn")} ${msg}`;
}

/**
 * Which configured policy governs a request. Exec risk (and `bash` itself) is
 * governed by `tools.bash.approval`; every other mutating request by
 * `tools.edit.approval`; read-only requests are never gated.
 */
export function approvalPolicyFor(config: OgConfig, req: ApprovalRequest): ApprovalPolicy {
	if (req.risk === "read") return "never";
	if (req.tool === "bash" || req.risk === "exec") return config.tools.bash.approval;
	return config.tools.edit.approval;
}

/**
 * Non-interactive approval decision: exactly the documented policy semantics.
 * "never" auto-approves, "always" refuses without a human, "unsafe-only"
 * approves everything that is not exec-risk.
 */
export function decideApproval(config: OgConfig, req: ApprovalRequest): boolean {
	const policy = approvalPolicyFor(config, req);
	if (policy === "never") return true;
	if (policy === "always") return false;
	return req.risk !== "exec";
}

/** Everything the `og models` table draws from. Named because it reached six arguments. */
export interface ModelsView {
	config: OgConfig;
	health: EndpointHealth;
	/** Endpoint the health probe actually asked. */
	endpoint: string;
	/** Model a request would carry right now; `""` when nothing has been discovered. */
	active: string;
	/** `.gguf` filenames in the models directory. Shown, never acted on. */
	installed?: readonly string[];
	/** Print configured entries the endpoint is not serving. */
	all?: boolean;
}

/**
 * The `og models` table: three kinds of row, because each answers a question the
 * other two cannot.
 *
 * **serving now** — from the endpoint, the only authority on what a request will
 * actually reach, with the context window the server itself reported. llama.cpp
 * answers to any name with whatever it loaded, so this is the row that cannot be
 * wrong.
 *
 * **on disk** — `.gguf` files in the models directory. og cannot load one; it
 * starts no server. They are listed because leaving them out was worse: someone
 * who had just downloaded three models saw names they had never chosen and
 * reasonably concluded og was lying to them.
 *
 * **configured** — knobs an operator wrote: a context window, sampling, a key
 * variable. Nothing is shipped here, so any row of this kind is theirs. Entries
 * beyond the active one are counted rather than printed unless `all`.
 */
export function formatModels(view: ModelsView): string {
	const { config, health, endpoint, active } = view;
	const served = health.models ?? [];
	const all = view.all === true;
	const lines: string[] = [];

	const keyFor = (id: string): string | undefined =>
		Object.keys(config.models).find((key) => (config.models[key]?.id ?? key) === id);

	const rows: { name: string; spec?: ModelSpec; window?: number; tag: string }[] = [];
	for (const model of served) {
		const key = keyFor(model.id);
		const spec = key === undefined ? undefined : config.models[key];
		rows.push({
			name: key ?? model.id,
			...(spec === undefined ? {} : { spec }),
			...(model.contextWindow === undefined ? {} : { window: model.contextWindow }),
			tag: green("serving now"),
		});
	}

	// Files present but not loaded. Matched by the alias convention serve.ts uses —
	// the filename without `.gguf` — so the running model is not listed twice.
	for (const file of view.installed ?? []) {
		const name = file.replace(/\.gguf$/i, "");
		if (served.some((model) => model.id === name)) continue;
		const spec = config.models[name];
		rows.push({ name, ...(spec === undefined ? {} : { spec }), tag: cyan("on disk, not loaded") });
	}

	let hidden = 0;
	for (const [key, spec] of Object.entries(config.models)) {
		if (served.some((model) => model.id === (spec.id ?? key))) continue;
		if (rows.some((row) => row.name === key)) continue;
		if (!all && key !== active) {
			hidden++;
			continue;
		}
		const own = spec.endpoint ?? config.endpoint;
		// Nothing answered means nothing is known: "not loaded" would be a claim this
		// probe cannot make.
		rows.push({ name: key, spec, tag: own !== endpoint ? dim(`other endpoint ${own}`) : health.reachable ? dim("not loaded") : "" });
	}

	const width = Math.max(...rows.map((row) => row.name.length), 10);
	for (const row of rows) {
		const mark = row.name === active ? green("*") : " ";
		lines.push(`${mark} ${bold(row.name.padEnd(width))}${row.tag === "" ? "" : `  ${row.tag}`}`);
		lines.push(`  ${" ".repeat(width)}  ${dim(knobsOf(row.spec, row.window))}`);
	}
	if (hidden > 0) {
		// No command named here: this block is printed by both the CLI and the REPL,
		// and each spells its own ("og models --all" / "/models all") in its footer.
		lines.push(dim(`  ${hidden} more configured and not being served`));
	}

	if (!health.reachable) {
		lines.unshift(`${formatWarn(`nothing answered at ${endpoint}`)}${health.detail === undefined ? "" : dim(` — ${health.detail}`)}`);
		lines.push(dim("  og starts no server: run one with og-llama-cpp's `bun run serve.ts`, or its model UI."));
	} else if (served.length === 0) {
		lines.unshift(formatWarn(`${endpoint} answered but named no model — it is still loading, or nothing is loaded`));
	} else if (active !== "" && !served.some((model) => model.id === wireOf(config, active))) {
		// The failure this whole listing exists to surface: og sends a name the
		// endpoint does not have, gets the loaded model's answer anyway, and sizes
		// its context from the wrong entry.
		const first = served[0]?.id ?? "";
		lines.push("");
		lines.push(formatWarn(`the active model ${bold(active)} is not what ${endpoint} is serving`));
		lines.push(dim(`  og models use ${first}   sets it; og -m ${first} uses it once`));
	}
	return `${lines.join("\n")}\n`;
}

function wireOf(config: OgConfig, key: string): string {
	return config.models[key]?.id ?? key;
}

/**
 * Knobs og will apply. `served` is the window the endpoint said it allocated: it
 * wins over a configured number and is labelled, because the two disagreeing is
 * the failure that makes a server truncate a prompt silently. With neither, the
 * fallback is named as a fallback rather than presented as a fact.
 */
function knobsOf(spec: ModelSpec | undefined, served?: number): string {
	const knobs: string[] = [];
	if (served !== undefined) knobs.push(`window ${served} (as served)`);
	else if (spec !== undefined) knobs.push(`window ${spec.contextWindow}`);
	else knobs.push(`window ${DEFAULT_CONTEXT_WINDOW} (og's fallback — the endpoint did not say)`);
	if (served !== undefined && spec !== undefined && spec.contextWindow !== served) {
		knobs.push(`configured ${spec.contextWindow}`);
	}
	if (spec === undefined) return knobs.join(" \u00b7 ");
	if (spec.maxTokens !== undefined) knobs.push(`max-tokens ${spec.maxTokens}`);
	if (spec.temperature !== undefined) knobs.push(`temp ${spec.temperature}`);
	if (spec.topP !== undefined) knobs.push(`top-p ${spec.topP}`);
	if (spec.topK !== undefined) knobs.push(`top-k ${spec.topK}`);
	if (spec.minP !== undefined) knobs.push(`min-p ${spec.minP}`);
	if (spec.repeatPenalty !== undefined) knobs.push(`repeat-penalty ${spec.repeatPenalty}`);
	// The variable name, never its value: og prints config, not secrets.
	if (spec.apiKeyEnv !== undefined) knobs.push(`key from $${spec.apiKeyEnv}`);
	return knobs.join(" \u00b7 ");
}
