// The lead's tables in ledger.db (docs/v2/milestone-2-plan.md, section 4),
// owned by the lead module: its generations, the owner's thread, the
// commitments, the handover records and the queue of events waiting for an
// event turn. Rows, not memory: a refresh or a restart reads them back, so
// nothing the lead promised or was told lives only in a model's context.
import type { DatabaseSync } from 'node:sqlite';
import type { LeadCommitment, LeadHandover, LeadMessage } from '../api/types.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { Question } from '../session/events.ts';
import type { TicketId } from '../tickets/contract.ts';

export const LEAD_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lead_generations (
  project TEXT NOT NULL, number INTEGER NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
  ended_at TEXT, reason TEXT, handover_id TEXT, briefing_bytes INTEGER NOT NULL, highest_percent REAL,
  PRIMARY KEY (project, number)
)`,
  // turn: for a line the lead must answer (the owner's, or the service's
  // "Plan P approved"), queued, then sent, then done once its turn ended.
  `CREATE TABLE IF NOT EXISTS lead_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, user TEXT,
  text TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER, question TEXT, plan_id TEXT, turn TEXT, turn_text TEXT
)`,
  `CREATE TABLE IF NOT EXISTS lead_commitments (
  n INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, text TEXT NOT NULL, ticket TEXT, due TEXT,
  state TEXT NOT NULL, created_at TEXT NOT NULL, fulfilled_at TEXT, note TEXT, generation INTEGER, woken_at TEXT
)`,
  `CREATE TABLE IF NOT EXISTS lead_handovers (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, generation INTEGER NOT NULL, at TEXT NOT NULL,
  summary TEXT NOT NULL, machine INTEGER NOT NULL, parts TEXT NOT NULL, messages TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS lead_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, urgent INTEGER NOT NULL, sent_at TEXT
)`,
];

export type GenerationRow = {
  readonly number: number;
  readonly sessionId: SessionId;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly reason: string | null;
  readonly handoverId: string | null;
  readonly briefingBytes: number;
  readonly highestPercent: number | null;
};

// A handover as stored: the lead's account, the structured parts the
// service wrote, and the last messages of the thread as they were.
export type HandoverRecord = LeadHandover & {
  readonly parts: string;
  readonly messages: readonly LeadMessage[];
};

export type QueuedEvent = { readonly id: number; readonly at: string; readonly kind: string; readonly text: string; readonly urgent: boolean };

export type NewMessage = {
  readonly by: LeadMessage['by'];
  readonly user?: UserId;
  readonly text: string;
  readonly kind: LeadMessage['kind'];
  readonly generation?: number;
  readonly question?: { readonly sessionId: SessionId; readonly requestId: string; readonly questions: readonly Question[] };
  readonly planId?: string;
  readonly turn?: string;               // the text the lead is sent for this line, when it is a turn
};

// An owner's line that waits for its turn, or whose turn has not ended.
export type OwnerTurn = { readonly seq: number; readonly by: LeadMessage['by']; readonly user: UserId | undefined; readonly text: string; readonly state: 'queued' | 'sent' };

type Row = Record<string, unknown>;
const str = (row: Row, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));

export class LeadStore {
  #db: DatabaseSync;
  #project: string;
  #now: () => Date;

  constructor(db: DatabaseSync, project: string, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#project = project;
    this.#now = now;
  }

  #at(): string {
    return this.#now().toISOString();
  }

  // ---- generations ---------------------------------------------------------

  #generation(row: Row): GenerationRow {
    return {
      number: Number(row.number), sessionId: String(row.session_id), startedAt: String(row.started_at), endedAt: str(row, 'ended_at'),
      reason: str(row, 'reason'), handoverId: str(row, 'handover_id'), briefingBytes: Number(row.briefing_bytes),
      highestPercent: row.highest_percent === null ? null : Number(row.highest_percent),
    };
  }

  lastGeneration(): GenerationRow | undefined {
    const row = this.#db.prepare('SELECT * FROM lead_generations WHERE project = ? ORDER BY number DESC LIMIT 1').get(this.#project) as Row | undefined;
    return row ? this.#generation(row) : undefined;
  }

  liveGeneration(): GenerationRow | undefined {
    const last = this.lastGeneration();
    return last && last.endedAt === null ? last : undefined;
  }

  // The sessions of the generations that ended: the stopped leads, whose
  // containers and networks a restart releases (issue 265).
  endedSessions(): SessionId[] {
    return (this.#db.prepare('SELECT session_id FROM lead_generations WHERE project = ? AND ended_at IS NOT NULL ORDER BY number').all(this.#project) as Row[])
      .map((row) => String(row.session_id));
  }

  startGeneration(input: { readonly number: number; readonly sessionId: SessionId; readonly briefingBytes: number }): GenerationRow {
    this.#db.prepare('INSERT INTO lead_generations (project, number, session_id, started_at, briefing_bytes) VALUES (?, ?, ?, ?, ?)')
      .run(this.#project, input.number, input.sessionId, this.#at(), input.briefingBytes);
    return this.lastGeneration() as GenerationRow;
  }

  endGeneration(number: number, reason: string, handoverId: string | null): void {
    this.#db.prepare('UPDATE lead_generations SET ended_at = ?, reason = ?, handover_id = ? WHERE project = ? AND number = ? AND ended_at IS NULL')
      .run(this.#at(), reason, handoverId, this.#project, number);
  }

  noteContext(number: number, percent: number): void {
    this.#db.prepare('UPDATE lead_generations SET highest_percent = MAX(COALESCE(highest_percent, 0), ?) WHERE project = ? AND number = ?')
      .run(percent, this.#project, number);
  }

  highestPercent(): number | null {
    const row = this.#db.prepare('SELECT MAX(highest_percent) AS p FROM lead_generations WHERE project = ?').get(this.#project) as Row;
    return row.p === null ? null : Number(row.p);
  }

  // ---- the thread ----------------------------------------------------------

  #message(row: Row): LeadMessage & { readonly turnState: string | null } {
    const question = str(row, 'question');
    const user = str(row, 'user');
    const planId = str(row, 'plan_id');
    const generation = row.generation === null ? undefined : Number(row.generation);
    return {
      seq: Number(row.seq), at: String(row.at), by: String(row.by) as LeadMessage['by'], text: String(row.text), kind: String(row.kind) as LeadMessage['kind'],
      ...(user === null ? {} : { user }),
      ...(generation === undefined ? {} : { generation }),
      // The question's state is the inbox item's: the engine fills it in.
      ...(question === null ? {} : { question: { ...(JSON.parse(question) as Omit<NonNullable<LeadMessage['question']>, 'state'>), state: 'waiting' as const } }),
      ...(planId === null ? {} : { planId }),
      turnState: str(row, 'turn'),
    };
  }

  addMessage(input: NewMessage): LeadMessage {
    const question = input.question ? JSON.stringify({ sessionId: input.question.sessionId, requestId: input.question.requestId, questions: input.question.questions }) : null;
    const row = this.#db.prepare(
      'INSERT INTO lead_messages (project, at, by, user, text, kind, generation, question, plan_id, turn, turn_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
    ).get(this.#project, this.#at(), input.by, input.user ?? null, input.text, input.kind, input.generation ?? null, question, input.planId ?? null,
      input.turn === undefined ? null : 'queued', input.turn ?? null) as Row;
    const { turnState: _turn, ...message } = this.#message(row);
    return message;
  }

  messages(after = 0, limit = 1000): LeadMessage[] {
    return (this.#db.prepare('SELECT * FROM lead_messages WHERE project = ? AND seq > ? ORDER BY seq LIMIT ?').all(this.#project, after, limit) as Row[])
      .map((row) => { const { turnState: _turn, ...message } = this.#message(row); return message; });
  }

  lastMessages(count: number): LeadMessage[] {
    return (this.#db.prepare('SELECT * FROM (SELECT * FROM lead_messages WHERE project = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(this.#project, count) as Row[])
      .map((row) => { const { turnState: _turn, ...message } = this.#message(row); return message; });
  }

  // The lines the lead still has to answer, oldest first: queued, or sent
  // to a generation whose turn did not end (a refresh, a restart).
  ownerTurns(): OwnerTurn[] {
    return (this.#db.prepare("SELECT * FROM lead_messages WHERE project = ? AND turn IN ('queued', 'sent') ORDER BY seq").all(this.#project) as Row[])
      .map((row) => ({ seq: Number(row.seq), by: String(row.by) as LeadMessage['by'], user: str(row, 'user') ?? undefined, text: String(row.turn_text), state: String(row.turn) as 'queued' | 'sent' }));
  }

  setTurnText(seq: number, text: string): void {
    this.#db.prepare('UPDATE lead_messages SET turn_text = ? WHERE project = ? AND seq = ?').run(text, this.#project, seq);
  }

  setTurn(seq: number, state: 'queued' | 'sent' | 'done'): void {
    this.#db.prepare('UPDATE lead_messages SET turn = ? WHERE project = ? AND seq = ?').run(state, this.#project, seq);
  }

  // The questions the lead asked, newest first.
  questions(): LeadMessage[] {
    return (this.#db.prepare("SELECT * FROM lead_messages WHERE project = ? AND kind = 'question' ORDER BY seq DESC").all(this.#project) as Row[])
      .map((row) => { const { turnState: _turn, ...message } = this.#message(row); return message; });
  }

  // ---- commitments ---------------------------------------------------------

  #commitment(row: Row): LeadCommitment {
    return {
      id: `c${Number(row.n)}`, text: String(row.text), ticket: str(row, 'ticket') as TicketId | null, due: str(row, 'due'),
      state: String(row.state) as LeadCommitment['state'], createdAt: String(row.created_at), fulfilledAt: str(row, 'fulfilled_at'), note: str(row, 'note'),
    };
  }

  commit(input: { readonly text: string; readonly ticket: TicketId | null; readonly due: string | null; readonly generation: number }): LeadCommitment {
    const row = this.#db.prepare("INSERT INTO lead_commitments (project, text, ticket, due, state, created_at, generation) VALUES (?, ?, ?, ?, 'open', ?, ?) RETURNING *")
      .get(this.#project, input.text, input.ticket, input.due, this.#at(), input.generation) as Row;
    return this.#commitment(row);
  }

  #number(id: string): number | undefined {
    const match = /^c(\d{1,12})$/.exec(id);
    return match ? Number(match[1]) : undefined;
  }

  // The commitment, done; undefined when it is not open.
  fulfil(id: string, note: string): LeadCommitment | undefined {
    const n = this.#number(id);
    if (n === undefined) return undefined;
    const row = this.#db.prepare("UPDATE lead_commitments SET state = 'done', fulfilled_at = ?, note = ? WHERE project = ? AND n = ? AND state = 'open' RETURNING *")
      .get(this.#at(), note, this.#project, n) as Row | undefined;
    return row ? this.#commitment(row) : undefined;
  }

  // Open first, then done, each oldest first.
  commitments(): LeadCommitment[] {
    return (this.#db.prepare("SELECT * FROM lead_commitments WHERE project = ? ORDER BY state = 'done', n").all(this.#project) as Row[]).map((row) => this.#commitment(row));
  }

  openCommitments(): LeadCommitment[] {
    return (this.#db.prepare("SELECT * FROM lead_commitments WHERE project = ? AND state = 'open' ORDER BY n").all(this.#project) as Row[]).map((row) => this.#commitment(row));
  }

  // Open commitments whose time has come and that have not woken the lead yet.
  due(now: Date): LeadCommitment[] {
    return (this.#db.prepare("SELECT * FROM lead_commitments WHERE project = ? AND state = 'open' AND due IS NOT NULL AND due <= ? AND woken_at IS NULL ORDER BY due, n").all(this.#project, now.toISOString()) as Row[])
      .map((row) => this.#commitment(row));
  }

  woken(id: string): void {
    this.#db.prepare('UPDATE lead_commitments SET woken_at = ? WHERE project = ? AND n = ?').run(this.#at(), this.#project, this.#number(id) ?? -1);
  }

  // ---- handovers -------------------------------------------------------------

  #handover(row: Row): HandoverRecord {
    return {
      id: String(row.id), generation: Number(row.generation), at: String(row.at), summary: String(row.summary), machine: Number(row.machine) === 1,
      parts: String(row.parts), messages: JSON.parse(String(row.messages)) as LeadMessage[],
    };
  }

  addHandover(input: Omit<HandoverRecord, 'at'>): HandoverRecord {
    this.#db.prepare('INSERT INTO lead_handovers (id, project, generation, at, summary, machine, parts, messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, this.#project, input.generation, this.#at(), input.summary, input.machine ? 1 : 0, input.parts, JSON.stringify(input.messages));
    return this.handover(input.id) as HandoverRecord;
  }

  handover(id: string): HandoverRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM lead_handovers WHERE project = ? AND id = ?').get(this.#project, id) as Row | undefined;
    return row ? this.#handover(row) : undefined;
  }

  handoverOf(generation: number): HandoverRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM lead_handovers WHERE project = ? AND generation = ? ORDER BY at DESC LIMIT 1').get(this.#project, generation) as Row | undefined;
    return row ? this.#handover(row) : undefined;
  }

  lastHandover(): HandoverRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM lead_handovers WHERE project = ? ORDER BY generation DESC, at DESC LIMIT 1').get(this.#project) as Row | undefined;
    return row ? this.#handover(row) : undefined;
  }

  // ---- the event queue -------------------------------------------------------

  enqueue(kind: string, text: string, urgent = false): void {
    this.#db.prepare('INSERT INTO lead_queue (project, at, kind, text, urgent) VALUES (?, ?, ?, ?, ?)').run(this.#project, this.#at(), kind, text, urgent ? 1 : 0);
  }

  pending(): QueuedEvent[] {
    return (this.#db.prepare('SELECT * FROM lead_queue WHERE project = ? AND sent_at IS NULL ORDER BY id').all(this.#project) as Row[])
      .map((row) => ({ id: Number(row.id), at: String(row.at), kind: String(row.kind), text: String(row.text), urgent: Number(row.urgent) === 1 }));
  }

  markSent(ids: readonly number[]): void {
    const statement = this.#db.prepare('UPDATE lead_queue SET sent_at = ? WHERE project = ? AND id = ?');
    for (const id of ids) statement.run(this.#at(), this.#project, id);
  }
}
