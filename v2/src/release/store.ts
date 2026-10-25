// The release trains, in ledger.db (docs/v2/milestone-2-plan.md, decision
// 21): one row per release item of a ticket of a workspace of several
// services, with its services in landing order and how far each one went.
// The train is read again from here at every tick, so a new process goes on
// where the last one stopped. What the card shows of it is view().
import type { DatabaseSync } from 'node:sqlite';
import type { TrainServiceState, TrainState } from '../api/types.ts';
import type { UserId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';

export const TRAIN_TABLE = `CREATE TABLE IF NOT EXISTS release_trains (
  item TEXT PRIMARY KEY, ticket TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL,
  stops TEXT NOT NULL, compatibility TEXT, blocked TEXT, announcement TEXT NOT NULL,
  approver TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`;

// One service of the train. `requestedAt` is the request time its own lock
// kept for `head`; `signed`, whether the owner's move bound to that record
// was written; `askedAt`, when its merge was first asked; `next`, when a
// merge its lock queued is asked again.
export type Stop = {
  readonly service: string;
  readonly pr: { readonly number: number; readonly url: string };
  readonly head: string;
  readonly requestedAt: string;
  readonly state: TrainServiceState;
  readonly at: string | null;
  readonly note: string | null;
  readonly signed: boolean;
  readonly askedAt: string | null;
  readonly mergedAt: string | null;
  readonly next: string | null;
};

export type Train = {
  readonly item: string;                       // the release item of the inbox
  readonly ticket: TicketId;
  readonly project: string;
  readonly state: TrainState['state'];
  readonly stops: readonly Stop[];
  readonly compatibility: string | null;
  readonly blocked: TrainState['blocked'];
  readonly announcement: string;               // what merge-pr.ts announces of each landing
  readonly approver: UserId | null;            // the owner who approved the card, kept by the approval route
};

type Row = Record<string, unknown>;

const ACTIVE = ['blocked', 'waiting', 'landing'];

export class TrainStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(TRAIN_TABLE);
  }

  #train(row: Row): Train {
    return {
      item: String(row.item), ticket: String(row.ticket), project: String(row.project), state: String(row.state) as Train['state'],
      stops: JSON.parse(String(row.stops)) as Stop[], compatibility: row.compatibility === null ? null : String(row.compatibility),
      blocked: row.blocked === null ? null : JSON.parse(String(row.blocked)) as Train['blocked'], announcement: String(row.announcement),
      approver: row.approver === null ? null : String(row.approver),
    };
  }

  add(train: Omit<Train, 'approver'>): Train {
    const at = this.#now().toISOString();
    this.#db.prepare('INSERT INTO release_trains (item, ticket, project, state, stops, compatibility, blocked, announcement, approver, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(train.item, train.ticket, train.project, train.state, JSON.stringify(train.stops), train.compatibility, train.blocked ? JSON.stringify(train.blocked) : null, train.announcement, at, at);
    return this.get(train.item) as Train;
  }

  get(item: string): Train | undefined {
    const row = this.#db.prepare('SELECT * FROM release_trains WHERE item = ?').get(item) as Row | undefined;
    return row ? this.#train(row) : undefined;
  }

  has(item: string): boolean {
    return this.#db.prepare('SELECT 1 FROM release_trains WHERE item = ?').get(item) !== undefined;
  }

  // The ticket's newest train, whatever its state.
  latest(ticket: TicketId): Train | undefined {
    const row = this.#db.prepare('SELECT * FROM release_trains WHERE ticket = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(ticket) as Row | undefined;
    return row ? this.#train(row) : undefined;
  }

  // The trains not over yet, oldest first.
  active(project: string): Train[] {
    return (this.#db.prepare(`SELECT * FROM release_trains WHERE project = ? AND state IN (${ACTIVE.map(() => '?').join(', ')}) ORDER BY created_at, rowid`).all(project, ...ACTIVE) as Row[])
      .map((row) => this.#train(row));
  }

  update(item: string, change: { readonly state?: Train['state']; readonly stops?: readonly Stop[] }): Train {
    const known = this.get(item);
    if (!known) throw new Error(`no train for ${item}`);
    this.#db.prepare('UPDATE release_trains SET state = ?, stops = ?, updated_at = ? WHERE item = ?')
      .run(change.state ?? known.state, JSON.stringify(change.stops ?? known.stops), this.#now().toISOString(), item);
    return this.get(item) as Train;
  }

  // A ticket published again replaces its trains not over yet: they are
  // halted, so the owner's approval of the new card never lands an older one.
  haltActive(ticket: TicketId): void {
    this.#db.prepare(`UPDATE release_trains SET state = 'halted', updated_at = ? WHERE ticket = ? AND state IN (${ACTIVE.map(() => '?').join(', ')})`)
      .run(this.#now().toISOString(), ticket, ...ACTIVE);
  }

  // The approval route keeps who approved a waiting train, and forgets it on Undo.
  setApprover(item: string, by: UserId | null): void {
    this.#db.prepare("UPDATE release_trains SET approver = ?, updated_at = ? WHERE item = ? AND state = 'waiting'").run(by, this.#now().toISOString(), item);
  }
}

// What the card shows.
export function view(train: Train): TrainState {
  return {
    state: train.state,
    services: train.stops.map((stop) => ({ service: stop.service, pr: stop.pr, state: stop.state, at: stop.at, head: stop.head, note: stop.note })),
    compatibility: train.compatibility,
    blocked: train.blocked,
  };
}
