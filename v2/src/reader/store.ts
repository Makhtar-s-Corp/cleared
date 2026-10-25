// The asks table (docs/v2/milestone-2-plan.md, decision 28), a table of the
// sessions module: one row per question to the code, its turns as JSON (the
// question, the answer, the cost, the tokens and the citations of each), its
// state and the session that answers it now. The sums are read from the turns.
import type { DatabaseSync } from 'node:sqlite';
import type { Ask, AskAnswer } from '../api/types.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { AskTarget } from './target.ts';

export const ASK_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, question TEXT NOT NULL, service TEXT, target TEXT,
  session TEXT, state TEXT NOT NULL, turns TEXT NOT NULL, week_percent REAL,
  by_user TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS asks_state ON asks(state)',
];

type Row = {
  id: string; project: string; question: string; service: string | null; target: string | null;
  session: string | null; state: Ask['state']; turns: string; week_percent: number | null;
  by_user: string; created_at: string; updated_at: string;
};

export type AskRecord = Ask & { readonly project: string };

const cents = (value: number) => Math.round(value * 1e6) / 1e6;

function toAsk(row: Row): AskRecord {
  // A turn stored before P215 has no citations.
  const turns = (JSON.parse(row.turns) as AskAnswer[]).map((turn) => (turn.citations ? turn : { ...turn, citations: [] }));
  return {
    id: row.id, project: row.project, question: row.question, service: row.service,
    target: row.target === null ? null : JSON.parse(row.target) as AskTarget,
    session: row.session, state: row.state, turns,
    costUsd: cents(turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0)),
    inputTokens: turns.reduce((sum, turn) => sum + turn.inputTokens, 0),
    outputTokens: turns.reduce((sum, turn) => sum + turn.outputTokens, 0),
    weekPercent: row.week_percent, createdAt: row.created_at, by: row.by_user,
  };
}

export class AskStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(ask: { id: string; project: string; question: string; service: string | null; target: AskTarget | null; by: UserId; at: string }): AskRecord {
    const turns: AskAnswer[] = [{ question: ask.question, answer: null, at: ask.at, costUsd: null, inputTokens: 0, outputTokens: 0, citations: [] }];
    this.#db.prepare('INSERT INTO asks (id, project, question, service, target, session, state, turns, week_percent, by_user, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)')
      .run(ask.id, ask.project, ask.question, ask.service, ask.target === null ? null : JSON.stringify(ask.target), 'starting', JSON.stringify(turns), ask.by, ask.at, ask.at);
    return this.get(ask.id) as AskRecord;
  }

  get(id: string): AskRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as Row | undefined;
    return row ? toAsk(row) : undefined;
  }

  // The asks a process may have left running.
  live(): AskRecord[] {
    return (this.#db.prepare("SELECT * FROM asks WHERE state IN ('starting', 'running', 'answered') ORDER BY created_at, id").all() as Row[]).map(toAsk);
  }

  count(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM asks').get() as { n: number }).n);
  }

  update(id: string, change: { state?: Ask['state']; session?: SessionId | null; turns?: readonly AskAnswer[]; weekPercent?: number | null; at: string }): AskRecord {
    const before = this.get(id);
    if (!before) throw new Error(`no ask ${id}`);
    this.#db.prepare('UPDATE asks SET state = ?, session = ?, turns = ?, week_percent = ?, updated_at = ? WHERE id = ?').run(
      change.state ?? before.state,
      change.session === undefined ? before.session : change.session,
      JSON.stringify(change.turns ?? before.turns),
      change.weekPercent === undefined ? before.weekPercent : change.weekPercent,
      change.at, id,
    );
    return this.get(id) as AskRecord;
  }
}
