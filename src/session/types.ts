import type { Message } from "../provider/types.ts";

export interface SessionRecord {
	id: string;
	cwd: string;
	model: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** Cumulative token usage for cost/perf reporting. */
	promptTokens: number;
	completionTokens: number;
}

export interface StoredMessage extends Message {
	seq: number;
	createdAt: number;
	/** Token count of this message as measured when appended. */
	tokens: number;
}

export interface SessionStore {
	create(init: { cwd: string; model: string; title?: string }): SessionRecord;
	get(id: string): SessionRecord | undefined;
	/** Most recent sessions first. */
	list(opts?: { cwd?: string; limit?: number }): SessionRecord[];
	/** Latest session for a cwd, used by `--continue`. */
	latest(cwd: string): SessionRecord | undefined;
	append(sessionId: string, msg: Message, tokens: number): StoredMessage;
	messages(sessionId: string): StoredMessage[];
	/** Replaces history after compaction. */
	replaceMessages(sessionId: string, msgs: Array<{ msg: Message; tokens: number }>): void;
	addUsage(sessionId: string, promptTokens: number, completionTokens: number): void;
	setTitle(sessionId: string, title: string): void;
	delete(id: string): void;
	close(): void;
}
