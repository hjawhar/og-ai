/**
 * Context accounting and history compaction.
 *
 * Token counts are cheap character-based estimates: the agent loop calls these
 * on every append, so an HTTP round-trip to the backend tokenizer is not an
 * option. The estimate is deliberately slightly pessimistic (3.6 chars/token)
 * because overshooting the window is fatal while undershooting only wastes a
 * little context.
 */

import type { Message } from "../provider/types.ts";

/** Average characters per token for code-heavy English text. */
const CHARS_PER_TOKEN = 3.6;

/** Per-message framing cost (role markers, delimiters) in the chat template. */
const MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function messageTokens(msg: Message): number {
	let total = MESSAGE_OVERHEAD;
	total += estimateTokens(msg.content);
	if (msg.reasoning !== undefined) total += estimateTokens(msg.reasoning);
	if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
		total += estimateTokens(JSON.stringify(msg.toolCalls));
	}
	if (msg.name !== undefined) total += estimateTokens(msg.name);
	return total;
}

export interface CompactInput {
	messages: Message[];
	tokens: number[];
	/** Usable context window in tokens. */
	window: number;
	/** Fraction of the window reserved for the next response and tool results. */
	reservePct: number;
}

export interface CompactResult {
	messages: Message[];
	tokens: number[];
	/** Original messages dropped (the synthetic marker is not counted). */
	removed: number;
	/** Token total of the dropped messages. */
	freed: number;
}

function marker(removed: number, freed: number): Message {
	return {
		role: "user",
		content: `[earlier context omitted: ${removed} messages, ~${freed} tokens]`,
	};
}

/**
 * A turn is a user message plus every assistant/tool message that follows it.
 * Any messages preceding the first user message form a leading pseudo-turn.
 * Dropping whole turns is what keeps assistant tool-call messages glued to
 * their `role: "tool"` replies -- an orphaned tool message makes llama.cpp's
 * jinja chat template fail outright.
 */
function splitTurns(body: readonly Message[]): Array<{ start: number; end: number }> {
	const turns: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < body.length; i++) {
		const msg = body[i];
		if (msg === undefined) continue;
		const last = turns[turns.length - 1];
		if (last === undefined || msg.role === "user") turns.push({ start: i, end: i });
		else last.end = i;
	}
	return turns;
}

/**
 * Pure and total: always returns a usable history. Drops the oldest complete
 * turns until the estimate fits `window * (1 - reservePct)`; the last turn is
 * never dropped, so an oversized final turn is returned as-is with an honest
 * `removed` count rather than being mangled.
 */
export function compact(input: CompactInput): CompactResult {
	const { messages, window, reservePct } = input;
	const tok = messages.map((m, i) => input.tokens[i] ?? messageTokens(m));
	const reserve = Math.min(Math.max(reservePct, 0), 0.9);
	const limit = Math.max(0, Math.floor(window * (1 - reserve)));

	const total = tok.reduce((a, b) => a + b, 0);
	if (total <= limit) {
		return { messages: messages.slice(), tokens: tok, removed: 0, freed: 0 };
	}

	const headCount = messages[0]?.role === "system" ? 1 : 0;
	const headTokens = tok.slice(0, headCount).reduce((a, b) => a + b, 0);
	const body = messages.slice(headCount);
	const bodyTok = tok.slice(headCount);

	const turns = splitTurns(body);
	const turnTokens = turns.map((t) =>
		bodyTok.slice(t.start, t.end + 1).reduce((a, b) => a + b, 0),
	);
	// suffixTokens[k] = token total of turns k..end
	const suffixTokens = new Array<number>(turns.length + 1).fill(0);
	for (let k = turns.length - 1; k >= 0; k--) {
		suffixTokens[k] = (suffixTokens[k + 1] ?? 0) + (turnTokens[k] ?? 0);
	}

	const maxDrop = Math.max(0, turns.length - 1);
	if (maxDrop === 0) {
		return { messages: messages.slice(), tokens: tok, removed: 0, freed: 0 };
	}

	let chosen = maxDrop;
	for (let k = 1; k <= maxDrop; k++) {
		const first = turns[0];
		const boundary = turns[k];
		if (first === undefined || boundary === undefined) break;
		const removed = boundary.start - first.start;
		const freed = (suffixTokens[0] ?? 0) - (suffixTokens[k] ?? 0);
		const cost = messageTokens(marker(removed, freed));
		if (headTokens + cost + (suffixTokens[k] ?? 0) <= limit) {
			chosen = k;
			break;
		}
	}

	const first = turns[0];
	const boundary = turns[chosen];
	if (first === undefined || boundary === undefined) {
		return { messages: messages.slice(), tokens: tok, removed: 0, freed: 0 };
	}

	const removed = boundary.start - first.start;
	const freed = (suffixTokens[0] ?? 0) - (suffixTokens[chosen] ?? 0);
	const note = marker(removed, freed);

	const outMessages: Message[] = [
		...messages.slice(0, headCount),
		note,
		...body.slice(boundary.start),
	];
	const outTokens: number[] = [
		...tok.slice(0, headCount),
		messageTokens(note),
		...bodyTok.slice(boundary.start),
	];

	return { messages: outMessages, tokens: outTokens, removed, freed };
}
