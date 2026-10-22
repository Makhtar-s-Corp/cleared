// The inbox's items and their state, kept in ledger.db so that a restart
// keeps what waits and "Handled today" has something to show. The shapes
// are the API's (api/types.ts); this file stores them, it does not decide
// what is asked: the flow does.
import type { DatabaseSync } from 'node:sqlite';
import type { InboxItem, PermissionItem, PlanItemInbox, QuestionItem, ReleaseItem, TrainState } from '../api/types.ts';
import { LEAD_TICKET } from '../lead/contract.ts';
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

  // `session` is the one the approval step runs on: kept in request_id, which
  // a release has no other use for, so that it is not a request of any session.
  // A ticket of several services carries its train (lane 16); the groups and
  // the flags are kept when there are any (release/flags.ts).
  addRelease(input: Base & Pick<ReleaseItem, 'title' | 'announcement' | 'pr' | 'heads' | 'requestedAt' | 'captures' | 'sessions'> & Partial<Pick<ReleaseItem, 'train' | 'groups' | 'flags'>>, session: SessionId = ''): ReleaseItem {
    const id = `release:${input.ticket}:${input.pr.number}:${input.requestedAt}`;
    this.#insert(id, 'release', input, '', session, this.#now().toISOString(), {
      title: input.title, announcement: input.announcement, pr: input.pr, heads: input.heads, requestedAt: input.requestedAt, captures: input.captures, sessions: input.sessions,
      ...(input.train ? { train: input.train } : {}), ...(input.groups?.length ? { groups: input.groups } : {}), ...(input.flags?.length ? { flags: input.flags } : {}),
    });
    return this.#get(id) as ReleaseItem;
  }

  // A train's state as it lands: the card shows it, waiting or handled.
  setTrain(id: string, train: TrainState): void {
    this.#db.prepare("UPDATE flow_inbox SET payload = json_set(payload, '$.train', json(?)) WHERE id = ? AND kind = 'release'").run(JSON.stringify(train), id);
  }

  // A plan the lead proposed (milestone 2, section 5.1), under the lead's
  // ticket. Its plan id is kept in request_id and its session is none, so
  // that it is never a request of a session: no answer route finds it, and
  // the end of a session or a restart never handles it. The plans handle it
  // when the plan leaves `proposed`.
  addPlan(input: { readonly project: string } & Pick<PlanItemInbox, 'planId' | 'title' | 'summary' | 'itemCount' | 'totals'>): PlanItemInbox {
    const id = `plan:${input.planId}`;
    this.#insert(id, 'plan', { ticket: LEAD_TICKET, project: input.project }, '', input.planId, this.#now().toISOString(),
      { planId: input.planId, title: input.title, summary: input.summary, itemCount: input.itemCount, totals: input.totals });
    return this.#get(id) as PlanItemInbox;
  }

  // What waits, oldest first, then what was handled in the last day, latest first.
  list(): InboxItem[] {
    const since = new Date(this.#now().getTime() - DAY_MS).toISOString();
    const waiting = this.#db.prepare("SELECT * FROM flow_inbox WHERE state = 'waiting' ORDER BY since, id").all() as Row[];
    const handled = this.#db.prepare("SELECT * FROM flow_inbox WHERE state = 'handled' AND handled_at > ? ORDER BY handled_at DESC, id").all(since) as Row[];
    return [...waiting, ...handled].map((row) => this.#item(row));
  }

  find(sessionId: SessionId, requestId: string): InboxItem | undefined {
    const row = this.#db.prepare("SELECT * FROM flow_inbox WHERE session_id = ? AND request_id = ? AND kind IN ('permission', 'question')").get(sessionId, requestId) as Row | undefined;
    return row ? this.#item(row) : undefined;
  }

  waitingFor(sessionId: SessionId): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM flow_inbox WHERE session_id = ? AND state = 'waiting' AND kind IN ('permission', 'question')").get(sessionId) as Row).n);
  }

  waitingRelease(ticket: string): ReleaseItem | undefined {
    const row = this.#db.prepare("SELECT * FROM flow_inbox WHERE ticket = ? AND kind = 'release' AND state = 'waiting' ORDER BY since DESC LIMIT 1").get(ticket) as Row | undefined;
    return row ? (this.#item(row) as ReleaseItem) : undefined;
  }

  // A ticket's latest release, waiting or handled (the plans read whether a
  // Done ticket ever asked for one).
  lastRelease(ticket: string): ReleaseItem | undefined {
    const row = this.#db.prepare("SELECT * FROM flow_inbox WHERE ticket = ? AND kind = 'release' ORDER BY since DESC, id DESC LIMIT 1").get(ticket) as Row | undefined;
    return row ? (this.#item(row) as ReleaseItem) : undefined;
  }

  releaseSession(id: string): SessionId | undefined {
    const row = this.#db.prepare("SELECT request_id FROM flow_inbox WHERE id = ? AND kind = 'release'").get(id) as Row | undefined;
    return row ? String(row.request_id) || undefined : undefined;
  }

  // A release's checks, as the forge reports them now, while it waits: a
  // handled release keeps what the person saw (issue 157).
  setReleaseChecks(id: string, checks: ReleaseItem['pr']['checks']): void {
    this.#db.prepare("UPDATE flow_inbox SET payload = json_set(payload, '$.pr.checks', ?) WHERE id = ? AND kind = 'release' AND state = 'waiting'").run(checks, id);
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

  // After a restart no session is live: what a session asked and nobody
  // answered cannot be answered. Only the permissions and questions of the
  // sessions not in `live` are handled: a release and a plan wait for the
  // owner, and the lead's question waits for its next generation, which
  // receives the answer (milestone 2, section 3.3).
  handleRequests(by: 'system', live: ReadonlySet<SessionId> = new Set()): void {
    const rows = this.#db.prepare("SELECT id, session_id FROM flow_inbox WHERE state = 'waiting' AND (kind = 'permission' OR (kind = 'question' AND ticket != ?))")
      .all(LEAD_TICKET) as Row[];
    for (const row of rows) if (!live.has(String(row.session_id))) this.handle(String(row.id), by);
  }

  // A session that ends leaves nothing waiting on its behalf.
  handleSession(sessionId: SessionId, by: 'policy' | 'system'): void {
    this.#db.prepare("UPDATE flow_inbox SET state = 'handled', handled_at = ?, handled_by = ? WHERE session_id = ? AND state = 'waiting' AND kind IN ('permission', 'question')")
      .run(this.#now().toISOString(), by, sessionId);
  }
}
