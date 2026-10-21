// The inbox's items and their state, kept in ledger.db so that a restart
// keeps what waits and "Handled today" has something to show. The shapes
// are the API's (api/types.ts); this file stores them, it does not decide
// what is asked: the flow does.
import type { DatabaseSync } from 'node:sqlite';
import type { InboxItem, PermissionItem, QuestionItem, ReleaseItem } from '../api/types.ts';
import type { SessionId, UserId } from '../session/contract.ts';

export const INBOX_TABLE = `CREATE TABLE IF NOT EXISTS flow_inbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket TEXT NOT NULL, project TEXT NOT NULL,
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, since TEXT NOT NULL,
  state TEXT NOT NULL, handled_at TEXT, handled_by TEXT, payload TEXT NOT NULL
)`;

const DAY_MS = 24 * 3600_000;

type Base = { readonly ticket: string; readonly project: string };
type Row = Record<string, unknown>;

export class InboxStore {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  #insert(id: string, kind: InboxItem['kind'], base: Base, sessionId: string, requestId: string, since: string, payload: object): void {
    this.#db.prepare(
      'INSERT OR IGNORE INTO flow_inbox (id, kind, ticket, project, session_id, request_id, since, state, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, kind, base.ticket, base.project, sessionId, requestId, since, 'waiting', JSON.stringify(payload));
  }

  #get(id: string): InboxItem {
    return this.#item(this.#db.prepare('SELECT * FROM flow_inbox WHERE id = ?').get(id) as Row);
  }

  #item(row: Row): InboxItem {
    const payload = JSON.parse(String(row.payload)) as object;
    return {
      ...payload, id: String(row.id), kind: String(row.kind), ticket: String(row.ticket), project: String(row.project),
      since: String(row.since), state: String(row.state),
    } as InboxItem;
  }

  addPermission(input: Base & Pick<PermissionItem, 'tool' | 'input' | 'suggestion'> & { readonly sessionId: SessionId; readonly requestId: string }): PermissionItem {
    const id = `permission:${input.sessionId}:${input.requestId}`;
    this.#insert(id, 'permission', input, input.sessionId, input.requestId, this.#now().toISOString(),
      { sessionId: input.sessionId, requestId: input.requestId, tool: input.tool, input: input.input, suggestion: input.suggestion });
    return this.#get(id) as PermissionItem;
  }

  addQuestion(input: Base & Pick<QuestionItem, 'questions'> & { readonly sessionId: SessionId; readonly requestId: string }): QuestionItem {
    const id = `question:${input.sessionId}:${input.requestId}`;
    this.#insert(id, 'question', input, input.sessionId, input.requestId, this.#now().toISOString(),
      { sessionId: input.sessionId, requestId: input.requestId, questions: input.questions });
    return this.#get(id) as QuestionItem;
  }

  addRelease(input: Base & Pick<ReleaseItem, 'title' | 'announcement' | 'pr' | 'heads' | 'requestedAt' | 'captures' | 'sessions'>): ReleaseItem {
    const id = `release:${input.ticket}:${input.pr.number}:${input.requestedAt}`;
    this.#insert(id, 'release', input, '', '', this.#now().toISOString(),
      { title: input.title, announcement: input.announcement, pr: input.pr, heads: input.heads, requestedAt: input.requestedAt, captures: input.captures, sessions: input.sessions });
    return this.#get(id) as ReleaseItem;
  }

  // What waits, oldest first, then what was handled in the last day, latest first.
  list(): InboxItem[] {
    const since = new Date(this.#now().getTime() - DAY_MS).toISOString();
    const waiting = this.#db.prepare("SELECT * FROM flow_inbox WHERE state = 'waiting' ORDER BY since, id").all() as Row[];
    const handled = this.#db.prepare("SELECT * FROM flow_inbox WHERE state = 'handled' AND handled_at > ? ORDER BY handled_at DESC, id").all(since) as Row[];
    return [...waiting, ...handled].map((row) => this.#item(row));
  }

  find(sessionId: SessionId, requestId: string): InboxItem | undefined {
    const row = this.#db.prepare("SELECT * FROM flow_inbox WHERE session_id = ? AND request_id = ? AND kind != 'release'").get(sessionId, requestId) as Row | undefined;
    return row ? this.#item(row) : undefined;
  }

  waitingFor(sessionId: SessionId): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM flow_inbox WHERE session_id = ? AND state = 'waiting'").get(sessionId) as Row).n);
  }

  waitingRelease(ticket: string): ReleaseItem | undefined {
    const row = this.#db.prepare("SELECT * FROM flow_inbox WHERE ticket = ? AND kind = 'release' AND state = 'waiting' ORDER BY since DESC LIMIT 1").get(ticket) as Row | undefined;
    return row ? (this.#item(row) as ReleaseItem) : undefined;
  }

  waitingReleases(): ReleaseItem[] {
    return (this.#db.prepare("SELECT * FROM flow_inbox WHERE kind = 'release' AND state = 'waiting' ORDER BY since, id").all() as Row[]).map((row) => this.#item(row) as ReleaseItem);
  }

  // True when this call handled it: an item is handled once.
  handle(id: string, by: UserId | 'policy' | 'system'): boolean {
    const result = this.#db.prepare("UPDATE flow_inbox SET state = 'handled', handled_at = ?, handled_by = ? WHERE id = ? AND state = 'waiting'")
      .run(this.#now().toISOString(), by, id);
    return Number(result.changes) > 0;
  }

  // A session that ends leaves nothing waiting on its behalf.
  handleSession(sessionId: SessionId, by: 'policy' | 'system'): void {
    this.#db.prepare("UPDATE flow_inbox SET state = 'handled', handled_at = ?, handled_by = ? WHERE session_id = ? AND state = 'waiting'")
      .run(this.#now().toISOString(), by, sessionId);
  }
}
