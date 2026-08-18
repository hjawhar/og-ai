/**
 * SQLite-backed session persistence (bun:sqlite, WAL).
 *
 * The store is the single source of truth for conversation history: the agent
 * loop appends as it goes and rewrites history wholesale after compaction.
 * Message round-trips are lossless for the full `Message` shape, and absent
 * optional fields are omitted rather than set to `undefined`, as required by
 * `exactOptionalPropertyTypes`.
 */

import { Database, type Statement } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import type { Message, Role, ToolCall } from "../provider/types.ts";
import type { SessionRecord, SessionStore, StoredMessage } from "./types.ts";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  reasoning TEXT,
  tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd_updated ON sessions(cwd, updated_at DESC);
`;

interface SessionRow {
	id: string;
	cwd: string;
	model: string;
	title: string;
	created_at: number;
	updated_at: number;
	prompt_tokens: number;
	completion_tokens: number;
}

interface MessageRow {
	seq: number;
	role: string;
	content: string;
	tool_calls: string | null;
	tool_call_id: string | null;
	name: string | null;
	reasoning: string | null;
	tokens: number;
	created_at: number;
}

const DEFAULT_LIST_LIMIT = 50;

function toRecord(row: SessionRow): SessionRecord {
	return {
		id: row.id,
		cwd: row.cwd,
		model: row.model,
		title: row.title,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		promptTokens: row.prompt_tokens,
		completionTokens: row.completion_tokens,
	};
}

function toStored(row: MessageRow): StoredMessage {
	const msg: StoredMessage = {
		role: row.role as Role,
		content: row.content,
		seq: row.seq,
		tokens: row.tokens,
		createdAt: row.created_at,
	};
	if (row.tool_calls !== null) msg.toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
	if (row.tool_call_id !== null) msg.toolCallId = row.tool_call_id;
	if (row.name !== null) msg.name = row.name;
	if (row.reasoning !== null) msg.reasoning = row.reasoning;
	return msg;
}

class SqliteSessionStore implements SessionStore {
	private readonly db: Database;
	private readonly statements: Statement[] = [];

	private readonly qInsertSession: Statement;
	private readonly qGetSession: Statement;
	private readonly qListAll: Statement;
	private readonly qListByCwd: Statement;
	private readonly qLatest: Statement;
	private readonly qNextSeq: Statement;
	private readonly qInsertMessage: Statement;
	private readonly qTouchSession: Statement;
	private readonly qMessages: Statement;
	private readonly qDeleteMessages: Statement;
	private readonly qAddUsage: Statement;
	private readonly qSetTitle: Statement;
	private readonly qDeleteSession: Statement;

	private readonly txAppend: (args: {
		sessionId: string;
		msg: Message;
		tokens: number;
		now: number;
	}) => StoredMessage;
	private readonly txReplace: (args: {
		sessionId: string;
		msgs: Array<{ msg: Message; tokens: number }>;
		now: number;
	}) => void;

	constructor(dbPath: string) {
		this.db = new Database(dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec(SCHEMA_SQL);

		const versionRow = this.db.query("SELECT version FROM schema_version LIMIT 1").get() as
			| { version: number }
			| null;
		if (versionRow === null) {
			this.db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
		}

		this.qInsertSession = this.prepare(
			`INSERT INTO sessions (id, cwd, model, title, created_at, updated_at)
			 VALUES ($id, $cwd, $model, $title, $now, $now)`,
		);
		this.qGetSession = this.prepare("SELECT * FROM sessions WHERE id = $id");
		this.qListAll = this.prepare(
			"SELECT * FROM sessions ORDER BY updated_at DESC, id DESC LIMIT $limit",
		);
		this.qListByCwd = this.prepare(
			"SELECT * FROM sessions WHERE cwd = $cwd ORDER BY updated_at DESC, id DESC LIMIT $limit",
		);
		this.qLatest = this.prepare(
			"SELECT * FROM sessions WHERE cwd = $cwd ORDER BY updated_at DESC, id DESC LIMIT 1",
		);
		this.qNextSeq = this.prepare(
			"SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE session_id = $id",
		);
		this.qInsertMessage = this.prepare(
			`INSERT INTO messages
			   (session_id, seq, role, content, tool_calls, tool_call_id, name, reasoning, tokens, created_at)
			 VALUES ($session_id, $seq, $role, $content, $tool_calls, $tool_call_id, $name, $reasoning, $tokens, $created_at)`,
		);
		this.qTouchSession = this.prepare("UPDATE sessions SET updated_at = $now WHERE id = $id");
		this.qMessages = this.prepare(
			`SELECT seq, role, content, tool_calls, tool_call_id, name, reasoning, tokens, created_at
			 FROM messages WHERE session_id = $id ORDER BY seq ASC`,
		);
		this.qDeleteMessages = this.prepare("DELETE FROM messages WHERE session_id = $id");
		this.qAddUsage = this.prepare(
			`UPDATE sessions
			 SET prompt_tokens = prompt_tokens + $prompt,
			     completion_tokens = completion_tokens + $completion,
			     updated_at = $now
			 WHERE id = $id`,
		);
		this.qSetTitle = this.prepare(
			"UPDATE sessions SET title = $title, updated_at = $now WHERE id = $id",
		);
		this.qDeleteSession = this.prepare("DELETE FROM sessions WHERE id = $id");

		this.txAppend = this.db.transaction(
			(args: { sessionId: string; msg: Message; tokens: number; now: number }) => {
				const seqRow = this.qNextSeq.get({ $id: args.sessionId }) as { next: number } | null;
				const seq = seqRow?.next ?? 0;
				this.insertRow(args.sessionId, seq, args.msg, args.tokens, args.now);
				this.qTouchSession.run({ $id: args.sessionId, $now: args.now });
				return { ...args.msg, seq, tokens: args.tokens, createdAt: args.now };
			},
		);

		this.txReplace = this.db.transaction(
			(args: {
				sessionId: string;
				msgs: Array<{ msg: Message; tokens: number }>;
				now: number;
			}) => {
				this.qDeleteMessages.run({ $id: args.sessionId });
				args.msgs.forEach((entry, index) => {
					this.insertRow(args.sessionId, index, entry.msg, entry.tokens, args.now);
				});
				this.qTouchSession.run({ $id: args.sessionId, $now: args.now });
			},
		);
	}

	private prepare(sql: string): Statement {
		const stmt = this.db.prepare(sql);
		this.statements.push(stmt);
		return stmt;
	}

	private insertRow(
		sessionId: string,
		seq: number,
		msg: Message,
		tokens: number,
		now: number,
	): void {
		this.qInsertMessage.run({
			$session_id: sessionId,
			$seq: seq,
			$role: msg.role,
			$content: msg.content,
			$tool_calls: msg.toolCalls === undefined ? null : JSON.stringify(msg.toolCalls),
			$tool_call_id: msg.toolCallId ?? null,
			$name: msg.name ?? null,
			$reasoning: msg.reasoning ?? null,
			$tokens: tokens,
			$created_at: now,
		});
	}

	private requireSession(id: string): void {
		const row = this.qGetSession.get({ $id: id }) as SessionRow | null;
		if (row === null) throw new Error(`Unknown session: ${id}`);
	}

	create(init: { cwd: string; model: string; title?: string }): SessionRecord {
		const id = crypto.randomUUID();
		const now = Date.now();
		this.qInsertSession.run({
			$id: id,
			$cwd: init.cwd,
			$model: init.model,
			$title: init.title ?? "",
			$now: now,
		});
		return {
			id,
			cwd: init.cwd,
			model: init.model,
			title: init.title ?? "",
			createdAt: now,
			updatedAt: now,
			promptTokens: 0,
			completionTokens: 0,
		};
	}

	get(id: string): SessionRecord | undefined {
		const row = this.qGetSession.get({ $id: id }) as SessionRow | null;
		return row === null ? undefined : toRecord(row);
	}

	list(opts?: { cwd?: string; limit?: number }): SessionRecord[] {
		const limit = opts?.limit ?? DEFAULT_LIST_LIMIT;
		const rows =
			opts?.cwd === undefined
				? (this.qListAll.all({ $limit: limit }) as SessionRow[])
				: (this.qListByCwd.all({ $cwd: opts.cwd, $limit: limit }) as SessionRow[]);
		return rows.map(toRecord);
	}

	latest(cwd: string): SessionRecord | undefined {
		const row = this.qLatest.get({ $cwd: cwd }) as SessionRow | null;
		return row === null ? undefined : toRecord(row);
	}

	append(sessionId: string, msg: Message, tokens: number): StoredMessage {
		this.requireSession(sessionId);
		return this.txAppend({ sessionId, msg, tokens, now: Date.now() });
	}

	messages(sessionId: string): StoredMessage[] {
		const rows = this.qMessages.all({ $id: sessionId }) as MessageRow[];
		return rows.map(toStored);
	}

	replaceMessages(sessionId: string, msgs: Array<{ msg: Message; tokens: number }>): void {
		this.requireSession(sessionId);
		this.txReplace({ sessionId, msgs, now: Date.now() });
	}

	addUsage(sessionId: string, promptTokens: number, completionTokens: number): void {
		this.qAddUsage.run({
			$id: sessionId,
			$prompt: promptTokens,
			$completion: completionTokens,
			$now: Date.now(),
		});
	}

	setTitle(sessionId: string, title: string): void {
		this.qSetTitle.run({ $id: sessionId, $title: title, $now: Date.now() });
	}

	delete(id: string): void {
		this.qDeleteSession.run({ $id: id });
	}

	close(): void {
		for (const stmt of this.statements) stmt.finalize();
		this.statements.length = 0;
		this.db.close();
	}
}

export function openSessionStore(stateDir: string): SessionStore {
	fs.mkdirSync(stateDir, { recursive: true });
	return new SqliteSessionStore(path.join(stateDir, "sessions.db"));
}
