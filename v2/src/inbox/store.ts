// The inbox's items and their state, kept in ledger.db so that a restart
// keeps what waits and "Handled today" has something to show. The shapes
// are the API's (api/types.ts); this file stores them, it does not decide
// what is asked: the flow does.
import type { DatabaseSync } from 'node:sqlite';
import type { ContractItem, InboxItem, KnowledgeItem, KnowledgeLevel, NextInboxItem, PermissionItem, PlanItemInbox, QuestionItem, ReleaseItem, SessionPlan, SessionPlanItem, TrainState } from '../api/types.ts';
import { LEAD_TICKET } from '../lead/contract.ts';
import type { SessionId, UserId } from '../session/contract.ts';

export const INBOX_TABLE = `CREATE TABLE IF NOT EXISTS flow_inbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket TEXT NOT NULL, project TEXT NOT NULL,
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, since TEXT NOT NULL,
  state TEXT NOT NULL, handled_at TEXT, handled_by TEXT, payload TEXT NOT NULL
)`;

const DAY_MS = 24 * 3600_000;

// The kinds that are requests of a session, which wait while it lives and
// leave with it: a permission, a question, its session plan waiting for a
// Go (lane 17). A contract or a knowledge item outlives its session: the
// owner validates a contract step after it ended, and a handover's
// knowledge is proposed when the session is over.
const SESSION_KINDS = "('permission', 'question', 'session_plan')";

type Base = { readonly ticket: string; readonly project: string };
type Row = Record<string, unknown>;

export class InboxStore {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  #insert(id: string, kind: NextInboxItem['kind'], base: Base, sessionId: string, requestId: string, since: string, payload: object): void {
    this.#db.prepare(
      'INSERT OR IGNORE INTO flow_inbox (id, kind, ticket, project, session_id, request_id, since, state, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, kind, base.ticket, base.project, sessionId, requestId, since, 'waiting', JSON.stringify(payload));
  }

  #get(id: string): NextInboxItem {
    return this.#item(this.#db.prepare('SELECT * FROM flow_inbox WHERE id = ?').get(id) as Row);
  }

  #item(row: Row): NextInboxItem {
    const payload = JSON.parse(String(row.payload)) as object;
    return {
      ...payload, id: String(row.id), kind: String(row.kind), ticket: String(row.ticket), project: String(row.project),
      since: String(row.since), state: String(row.state),
    } as NextInboxItem;
  }

  // One item by its id, of any kind; undefined when there is none.
  item(id: string): NextInboxItem | undefined {
    const row = this.#db.prepare('SELECT * FROM flow_inbox WHERE id = ?').get(id) as Row | undefined;
    return row ? this.#item(row) : undefined;
  }

  // Handles a waiting item of `kind` and writes what the person did into
  // it; true when this call handled it, so an item is answered once.
  #settle(id: string, kind: 'contract' | 'knowledge', by: UserId, outcome: object): boolean {
    const result = this.#db.prepare("UPDATE flow_inbox SET state = 'handled', handled_at = ?, handled_by = ?, payload = json_set(payload, '$.outcome', json(?)) WHERE id = ? AND kind = ? AND state = 'waiting'")
      .run(this.#now().toISOString(), by, JSON.stringify(outcome), id, kind);
    return Number(result.changes) > 0;
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

  // The session plan an author proposed, waiting for its Go (decision 22,
  // lane 17). Its id is kept in request_id, which no answer route reads
  // (find() looks for permissions and questions only), and it is a request
  // of its session: it counts in waitingFor and leaves with the session.
  addSessionPlan(input: Base & { readonly sessionId: SessionId; readonly service?: string; readonly plan: SessionPlan }): SessionPlanItem {
    // Numbered per session: a plan changed and proposed again in the same second is a new item.
    const n = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM flow_inbox WHERE kind = 'session_plan' AND session_id = ?").get(input.sessionId) as Row).n) + 1;
    const id = `session_plan:${input.sessionId}:${n}`;
    this.#insert(id, 'session_plan', input, input.sessionId, id, this.#now().toISOString(),
      { sessionId: input.sessionId, ...(input.service ? { service: input.service } : {}), plan: input.plan });
    return this.#get(id) as SessionPlanItem;
  }

  // The session's plan that waits for its Go, if one does.
  sessionPlan(sessionId: SessionId): SessionPlanItem | undefined {
    const row = this.#db.prepare("SELECT * FROM flow_inbox WHERE session_id = ? AND kind = 'session_plan' AND state = 'waiting' ORDER BY since DESC, id DESC LIMIT 1").get(sessionId) as Row | undefined;
    return row ? (this.#item(row) as SessionPlanItem) : undefined;
  }

  // A contract step's diff for the owner's validation (decision 26). Lane 23
  // adds it when the step ends and handles it from its Approve and Send back
  // routes; one item per step and session, so a step sent back and run
  // again proposes a new one.
  addContract(input: Base & Pick<ContractItem, 'sessionId' | 'step' | 'service' | 'path' | 'diff'>): ContractItem {
    const id = `contract:${input.ticket}:${input.step}:${input.sessionId}`;
    this.#insert(id, 'contract', input, input.sessionId, input.step, this.#now().toISOString(),
      { sessionId: input.sessionId, step: input.step, service: input.service, path: input.path, diff: input.diff, outcome: null });
    return this.#get(id) as ContractItem;
  }

  // The contract items, oldest first: those waiting, or of a ticket or a state.
  contracts(filter: { readonly ticket?: string; readonly state?: 'waiting' | 'handled' } = {}): ContractItem[] {
    return this.#of('contract', filter) as ContractItem[];
  }

  // True when this call handled it: Approve, or Send back with the message.
  handleContract(id: string, by: UserId, outcome: { readonly decision: 'approve' } | { readonly decision: 'send_back'; readonly message: string }): boolean {
    const at = this.#now().toISOString();
    return this.#settle(id, 'contract', by, outcome.decision === 'approve' ? { decision: 'approve', by, at } : { decision: 'send_back', message: outcome.message, by, at });
  }

  // A lesson or a decision a handover proposed (decision 27). Lane 24 adds
  // it, one per entry, and handles it from its Approve and Reject routes.
  addKnowledge(input: Base & { readonly sessionId: SessionId; readonly text: string; readonly level: KnowledgeLevel; readonly service: string | null }): KnowledgeItem {
    if (input.text.trim() === '') throw new Error('a knowledge item has a text');
    if (input.level !== 'workspace' && !input.service) throw new Error(`a knowledge item of the ${input.level} level names its service`);
    const n = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM flow_inbox WHERE kind = 'knowledge' AND session_id = ?").get(input.sessionId) as Row).n) + 1;
    const id = `knowledge:${input.sessionId}:${n}`;
    this.#insert(id, 'knowledge', input, input.sessionId, String(n), this.#now().toISOString(),
      { sessionId: input.sessionId, text: input.text, level: input.level, service: input.level === 'workspace' ? null : input.service, outcome: null });
    return this.#get(id) as KnowledgeItem;
  }

  knowledge(filter: { readonly ticket?: string; readonly state?: 'waiting' | 'handled' } = {}): KnowledgeItem[] {
    return this.#of('knowledge', filter) as KnowledgeItem[];
  }

  // True when this call handled it.
  handleKnowledge(id: string, by: UserId, decision: 'approve' | 'reject'): boolean {
    return this.#settle(id, 'knowledge', by, { decision, by, at: this.#now().toISOString() });
  }

  #of(kind: 'contract' | 'knowledge', filter: { readonly ticket?: string; readonly state?: 'waiting' | 'handled' }): NextInboxItem[] {
    const rows = this.#db.prepare('SELECT * FROM flow_inbox WHERE kind = ? AND state = ? AND (? IS NULL OR ticket = ?) ORDER BY since, rowid')
      .all(kind, filter.state ?? 'waiting', filter.ticket ?? null, filter.ticket ?? null) as Row[];
    return rows.map((row) => this.#item(row));
  }

  // What waits, oldest first, then what was handled in the last day, latest
  // first, of every kind the store keeps.
  items(): NextInboxItem[] {
    const since = new Date(this.#now().getTime() - DAY_MS).toISOString();
    const waiting = this.#db.prepare("SELECT * FROM flow_inbox WHERE state = 'waiting' ORDER BY since, id").all() as Row[];
    const handled = this.#db.prepare("SELECT * FROM flow_inbox WHERE state = 'handled' AND handled_at > ? ORDER BY handled_at DESC, id").all(since) as Row[];
    return [...waiting, ...handled].map((row) => this.#item(row));
  }

  // The same items, as GET /api/inbox answers them. Typed as milestone 2's
  // kinds until the screens that map every kind join the replanned ones
  // (NextInboxItem: lanes 21 and 27); a reader that switches on the kind
  // meets a session plan, a contract or a knowledge item as a kind it does
  // not know, which the notifications and the lead's state skip.
  list(): InboxItem[] {
    return this.items() as InboxItem[];
  }

  find(sessionId: SessionId, requestId: string): InboxItem | undefined {
    const row = this.#db.prepare("SELECT * FROM flow_inbox WHERE session_id = ? AND request_id = ? AND kind IN ('permission', 'question')").get(sessionId, requestId) as Row | undefined;
    return row ? (this.#item(row) as InboxItem) : undefined;
  }

  // What a session waits for from a person: its permissions, its questions
  // and its session plan.
  waitingFor(sessionId: SessionId): number {
    return Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM flow_inbox WHERE session_id = ? AND state = 'waiting' AND kind IN ${SESSION_KINDS}`).get(sessionId) as Row).n);
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
  // answered cannot be answered. Only the permissions, questions and session
  // plans of the sessions not in `live` are handled: a release, a plan, a
  // contract and a knowledge item wait for the owner, and the lead's
  // question waits for its next generation, which receives the answer
  // (milestone 2, section 3.3).
  handleRequests(by: 'system', live: ReadonlySet<SessionId> = new Set()): void {
    const rows = this.#db.prepare("SELECT id, session_id FROM flow_inbox WHERE state = 'waiting' AND (kind IN ('permission', 'session_plan') OR (kind = 'question' AND ticket != ?))")
      .all(LEAD_TICKET) as Row[];
    for (const row of rows) if (!live.has(String(row.session_id))) this.handle(String(row.id), by);
  }

  // A session that ends leaves nothing waiting on its behalf.
  handleSession(sessionId: SessionId, by: 'policy' | 'system'): void {
    this.#db.prepare(`UPDATE flow_inbox SET state = 'handled', handled_at = ?, handled_by = ? WHERE session_id = ? AND state = 'waiting' AND kind IN ${SESSION_KINDS}`)
      .run(this.#now().toISOString(), by, sessionId);
  }
}
