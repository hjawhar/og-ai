/**
 * The pinned status row's content.
 *
 * One row, always: `src/ui/statusbar.ts` reserves the top line of the terminal
 * and this module decides what goes in it. Because the row cannot wrap without
 * destroying the reserved-region illusion, every segment is measured and the
 * least useful ones are dropped rather than allowed to overflow.
 *
 * Idle, with whatever model the endpoint turned out to be serving:
 * ```
 * <model> · ~/demo-ace · 127.0.0.1:8127 · ctx ██░░░░░░░░ 16% 5.2k/32.8k · 12.4k tok ── add peek() to lru
 * ```
 * Running:
 * ```
 * ⠹ <model> · generating · 4.2s · 82.1 tok/s · ttft 380ms · ctx ██░░░░░░░░ 16% 5.2k/32.8k
 * ```
 */

import {
	cyan,
	dim,
	elapsed,
	formatTokenCount,
	green,
	progressBar,
	red,
	spinnerFrame,
	truncateLine,
	visibleWidth,
	yellow,
} from "./render.ts";

export interface BarState {
	/** Active model key. */
	model: string;
	/** Working directory, home-collapsed by the caller. */
	cwd: string;
	/** Endpoint the client streams from; only its host[:port] reaches the row. */
	endpoint: string;
	contextTokens: number;
	contextWindow: number;
	/** Cumulative tokens for this session (prompt + completion). */
	sessionTokens: number;
	/** Session title, right-aligned; omitted when empty. */
	title: string;
	/** Absent while idle; present for the whole of a run. */
	run?: {
		/** Spinner phase counter. */
		tick: number;
		/** What the model is doing right now. */
		phase: string;
		wallMs: number;
		/** Decode-only throughput; 0 until there is a usable sample. */
		tokensPerSec: number;
		/** Time to first token for this run, once it has arrived. */
		ttftMs?: number;
	};
}

export const PROMPT_MARKER = "\u276f";

const SEP = " \u00b7 ";
const FILL = "\u2500";
const MIN_WIDTH = 20;

/** Collapses the home prefix so the path segment stays short. */
export function collapseHome(cwd: string, home: string): string {
	const normalise = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const path = normalise(cwd);
	const root = normalise(home);
	if (root.length === 0) return path;
	if (path.toLowerCase() === root.toLowerCase()) return "~";
	return path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? `~${path.slice(root.length)}` : path;
}

/**
 * Keeps the tail of a path (the part that identifies the project) and elides the
 * middle, because the leading directories are the least informative part.
 */
function shortenPath(path: string, max: number): string {
	if (max <= 1) return "";
	if (path.length <= max) return path;
	const segments = path.split("/");
	for (let i = 1; i < segments.length; i++) {
		const candidate = `\u2026/${segments.slice(i).join("/")}`;
		if (candidate.length <= max) return candidate;
	}
	return `\u2026${path.slice(-(max - 1))}`;
}

/**
 * Host and port only. The scheme is always http(s) and the path is always the
 * OpenAI route prefix, so neither earns a column in a row this tight; anything
 * `URL` refuses to parse is shown verbatim rather than silently blanked.
 */
function shortenEndpoint(endpoint: string): string {
	try {
		const host = new URL(endpoint).host;
		return host === "" ? endpoint : host;
	} catch {
		return endpoint;
	}
}

/** `ctx ██░░░░░░░░ 16% 5.2k/32.8k`, or a short form when the row is tight. */
function contextSegment(used: number, window: number, compact: boolean): string {
	if (!Number.isFinite(window) || window <= 0) return dim("ctx ?");
	const fraction = Math.min(Math.max(used / window, 0), 1);
	const pct = Math.round(fraction * 100);
	const paint = fraction >= 0.85 ? red : fraction >= 0.6 ? yellow : green;
	if (compact) return `${dim("ctx")} ${paint(`${pct}%`)}${dim(`/${formatTokenCount(window)}`)}`;
	return `${dim("ctx")} ${progressBar(fraction, 10)} ${paint(`${pct}%`)} ${dim(`${formatTokenCount(used)}/${formatTokenCount(window)}`)}`;
}

/**
 * Builds the row for `width` columns. Segment order is fixed; richer variants are
 * tried first and the first one that fits wins, so the model identity and the
 * context gauge survive every terminal size.
 */
export function renderBar(state: BarState, width: number): string {
	const columns = Math.max(MIN_WIDTH, Math.trunc(width));
	const title = state.title.trim();
	const run = state.run;

	const head = run === undefined ? cyan(state.model) : `${spinnerFrame(run.tick)} ${cyan(state.model)}`;

	const pathBudget = Math.max(8, Math.trunc(columns * 0.3));
	const path = dim(shortenPath(state.cwd, pathBudget));
	const endpoint = shortenEndpoint(state.endpoint);
	const tokens = dim(`${formatTokenCount(state.sessionTokens)} tok`);

	const gauge = contextSegment(state.contextTokens, state.contextWindow, false);
	const gaugeTight = contextSegment(state.contextTokens, state.contextWindow, true);

	const variants: string[][] = [];
	if (run === undefined) {
		// The endpoint is the first segment sacrificed: it is configuration people
		// set once, where the gauge and the session total change every turn.
		// An unset endpoint would otherwise leave a dangling separator in the row.
		if (endpoint !== "") variants.push([head, path, dim(endpoint), gauge, tokens]);
		variants.push([head, path, gauge, tokens]);
		variants.push([head, path, gauge]);
		variants.push([head, gauge]);
		variants.push([head, gaugeTight]);
	} else {
		const phase = dim(run.phase);
		const time = dim(elapsed(run.wallMs));
		const rate = run.tokensPerSec > 0 ? dim(`${run.tokensPerSec.toFixed(1)} tok/s`) : dim("\u2013 tok/s");
		const ttft = run.ttftMs === undefined ? undefined : dim(`ttft ${elapsed(run.ttftMs)}`);
		if (ttft !== undefined) variants.push([head, phase, time, rate, ttft, gauge]);
		variants.push([head, phase, time, rate, gauge]);
		variants.push([head, phase, rate, gauge]);
		variants.push([head, phase, gaugeTight]);
		variants.push([head, gaugeTight]);
	}

	let left = variants[variants.length - 1]?.join(SEP) ?? "";
	for (const variant of variants) {
		if (visibleWidth(variant.join(SEP)) + 2 <= columns) {
			left = variant.join(SEP);
			break;
		}
	}

	const leftWidth = visibleWidth(left);
	// The title is the first thing sacrificed: it is context, not state.
	let rightText = "";
	if (title !== "" && run === undefined) {
		const room = columns - leftWidth - 4;
		if (room >= 8) rightText = title.length <= room ? title : `${title.slice(0, room - 1)}\u2026`;
	}

	if (rightText === "") return truncateLine(left, columns);

	const fill = Math.max(1, columns - leftWidth - visibleWidth(rightText) - 2);
	return truncateLine(`${left} ${dim(FILL.repeat(fill))} ${yellow(rightText)}`, columns);
}

/** The readline prompt. Kept minimal: the state lives in the pinned row. */
export function renderPrompt(busy: boolean): string {
	return `${busy ? dim(PROMPT_MARKER) : cyan(PROMPT_MARKER)} `;
}
