// The dispatcher's queue (docs/v2/milestone-2-plan.md, section 6), in
// ledger.db: each occurrence that may notify, until it is sent, folded into
// another one of its group, or dropped (gone, turned off, too old, nobody
// to tell). The notify module owns this one table; v1's notify_queue and
// notify_state are lib/notify.mjs's and are left alone.
//
// One row is not an occurrence: the cursor, keyed 'cursor', holds the last
// event_id of v1's events table already read. Its absence is the first run.
import type { DatabaseSync } from 'node:sqlite';

export const NOTIFY_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS v2_notify_queue (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, grp TEXT NOT NULL, ticket TEXT, facts TEXT NOT NULL,
  first_at TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, done_at TEXT
)`,
  'CREATE INDEX IF NOT EXISTS v2_notify_queue_state ON v2_notify_queue (state, grp)',
];

export type Kind = 'approval' | 'permission' | 'question' | 'plan' | 'rollback' | 'health';

// What may be said about one occurrence. The title is the only text from
// outside (a ticket's or a plan's), filtered again by lib/notify when the
// message is made; `link` is a path of the app.
export type Occurrence = {
  readonly key: string;
  readonly kind: Kind;
  readonly ticket: string | null;
  readonly group: string;                 // one notification per group every coalesce_minutes
  readonly title: string;
  readonly code: string | null;           // a health code
  readonly link: string;
  readonly from: 'lead' | null;           // a question of the project lead
  readonly at: string;                    // when it happened, or started waiting
};

export type State = 'pending' | 'seen' | 'sent' | 'grouped' | 'gone' | 'off' | 'expired' | 'undelivered' | 'failed';

export type Row = Occurrence & { readonly firstAt: string; readonly attempts: number };

type Facts = Pick<Occurrence, 'title' | 'code' | 'link' | 'from' | 'at'>;
type Raw = Record<string, unknown>;

const CURSOR = 'cursor';
const DAY_MS = 24 * 3600_000;

export class NotifyQueue {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // The last event_id read, or null before the first run.
  cursor(): number | null {
    const row = this.#db.prepare('SELECT facts FROM v2_notify_queue WHERE key = ?').get(CURSOR) as Raw | undefined;
    if (!row) return null;
    const value = (JSON.parse(String(row.facts)) as { event?: unknown }).event;
    return Number.isSafeInteger(value) ? Number(value) : 0;
  }

  setCursor(event: number, at: string): void {
    this.#db.prepare("INSERT INTO v2_notify_queue (key, kind, grp, facts, first_at, state) VALUES (?, 'cursor', '', ?, ?, 'cursor') ON CONFLICT(key) DO UPDATE SET facts = excluded.facts")
      .run(CURSOR, JSON.stringify({ event }), at);
  }

  // Kept once: the same key again is the same occurrence, whatever its state.
  add(o: Occurrence, state: 'pending' | 'seen', at: string): void {
    const facts: Facts = { title: o.title, code: o.code, link: o.link, from: o.from, at: o.at };
    this.#db.prepare('INSERT OR IGNORE INTO v2_notify_queue (key, kind, grp, ticket, facts, first_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(o.key, o.kind, o.group, o.ticket, JSON.stringify(facts), at, state);
  }

  // What waits to be sent, oldest first.
  pending(): Row[] {
    return (this.#db.prepare("SELECT * FROM v2_notify_queue WHERE state = 'pending' ORDER BY first_at, key").all() as Raw[]).map((raw) => {
      const facts = JSON.parse(String(raw.facts)) as Facts;
      return {
        key: String(raw.key), kind: String(raw.kind) as Kind, ticket: raw.ticket === null ? null : String(raw.ticket), group: String(raw.grp),
        title: facts.title, code: facts.code, link: facts.link, from: facts.from, at: facts.at, firstAt: String(raw.first_at), attempts: Number(raw.attempts),
      };
    });
  }

  finish(key: string, state: Exclude<State, 'pending' | 'seen'>, at: string): void {
    this.#db.prepare('UPDATE v2_notify_queue SET state = ?, done_at = ? WHERE key = ?').run(state, at, key);
  }

  // One more failed try; returns how many there were.
  failed(key: string): number {
    const row = this.#db.prepare('UPDATE v2_notify_queue SET attempts = attempts + 1 WHERE key = ? RETURNING attempts').get(key) as Raw;
    return Number(row.attempts);
  }

  // When the group was last told, of these kinds only when they are given.
  lastSent(group: string, kinds?: readonly string[]): number | null {
    const only = kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    const row = this.#db.prepare(`SELECT MAX(done_at) AS at FROM v2_notify_queue WHERE grp = ? AND state = 'sent'${only}`).get(group, ...(kinds ?? [])) as Raw;
    return row.at === null ? null : Date.parse(String(row.at));
  }

  // The queue keeps two weeks of what is finished.
  purge(now: number): void {
    this.#db.prepare("DELETE FROM v2_notify_queue WHERE state NOT IN ('pending', 'cursor') AND first_at < ?").run(new Date(now - 14 * DAY_MS).toISOString());
  }
}

// A health problem that another part of the service found (the lead
// engine: a generation that could not start; the plan runner: the week
// stop). Sent at the dispatcher's next tick, as any health problem: never
// held by the quiet hours. The code is one of lib/notify's HEALTH_CODES,
// else the notification says "a health problem"; nothing else of the
// problem is ever said. The same code, ticket and time is one occurrence.
export function reportHealth(db: DatabaseSync, problem: { readonly code: string; readonly ticket?: string; readonly at?: string }): void {
  const at = problem.at ?? new Date().toISOString();
  const ticket = problem.ticket ?? null;
  const code = /^[a-z_]{1,40}$/.test(problem.code) ? problem.code : 'other';
  new NotifyQueue(db).add({
    key: `health:${code}:${ticket ?? ''}:${at}`, kind: 'health', ticket, group: ticket ?? `health:${code}`, title: '', code, link: '/', from: null, at,
  }, 'pending', at);
}
