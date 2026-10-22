// The plans of the lead (docs/v2/milestone-2-plan.md, section 5.1): one row
// per plan and one per item, in ledger.db, owned by the lead module. The
// item rows are the truth of where each item stands; the runner (runner.ts)
// moves them, from the flow's events and from the tickets themselves.
import type { DatabaseSync } from 'node:sqlite';
import type { Estimate, Plan, PlanItem, PlanItemState, PlanState } from '../../api/types.ts';
import type { UserId } from '../../session/contract.ts';
import type { TicketId } from '../../tickets/contract.ts';

export const PLAN_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, goal TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
  state TEXT NOT NULL, max_parallel INTEGER NOT NULL, totals TEXT NOT NULL, proposed_at TEXT NOT NULL,
  approved_at TEXT, approved_by TEXT, ended_at TEXT
)`,
  `CREATE TABLE IF NOT EXISTS plan_items (
  plan_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, lane TEXT NOT NULL,
  size TEXT NOT NULL, after TEXT NOT NULL, estimate TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL,
  put_backs INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, position)
)`,
  'CREATE INDEX IF NOT EXISTS plan_items_ticket ON plan_items(ticket)',
];

// A plan as the runner sees it: the API's shape, and per item how many
// times its ticket was put back and the last note, which the runner gives
// the author when it starts the ticket again.
export type StoredItem = PlanItem & { readonly putBacks: number; readonly note: string | null };
export type StoredPlan = Omit<Plan, 'items'> & { readonly items: readonly StoredItem[]; readonly project: string; readonly endedAt: string | null };

export type NewPlan = {
  readonly goal: string;
  readonly title: string;
  readonly summary: string;
  readonly maxParallel: number;
  readonly totals: Estimate;
  readonly items: readonly Pick<PlanItem, 'title' | 'body' | 'lane' | 'size' | 'after' | 'estimate'>[];
};

type Row = Record<string, unknown>;
const str = (row: Row, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));

// What leaves the runner's hands: an item in these states is not started again by it.
export const FINAL_ITEM_STATES: ReadonlySet<PlanItemState> = new Set(['landed', 'cancelled']);

export class PlanStore {
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

  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #item(row: Row): StoredItem {
    return {
      position: Number(row.position), title: String(row.title), body: String(row.body), lane: String(row.lane) as PlanItem['lane'],
      size: String(row.size) as PlanItem['size'], after: JSON.parse(String(row.after)) as number[], estimate: JSON.parse(String(row.estimate)) as Estimate,
      ticket: str(row, 'ticket'), state: String(row.state) as PlanItemState, putBacks: Number(row.put_backs), note: str(row, 'note'),
    };
  }

  #plan(row: Row): StoredPlan {
    const items = (this.#db.prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position').all(String(row.id)) as Row[]).map((r) => this.#item(r));
    return {
      id: String(row.id), project: String(row.project), goal: String(row.goal), title: String(row.title), summary: String(row.summary), items,
      maxParallel: Number(row.max_parallel), totals: JSON.parse(String(row.totals)) as Estimate, state: String(row.state) as PlanState,
      proposedAt: String(row.proposed_at), approvedAt: str(row, 'approved_at'), approvedBy: str(row, 'approved_by'), endedAt: str(row, 'ended_at'),
    };
  }

  get(id: string): StoredPlan | undefined {
    const row = this.#db.prepare('SELECT * FROM plans WHERE id = ? AND project = ?').get(id, this.#project) as Row | undefined;
    return row ? this.#plan(row) : undefined;
  }

  // Newest first, or only those in the states given, oldest first.
  list(states?: readonly PlanState[]): StoredPlan[] {
    const rows = states
      ? this.#db.prepare(`SELECT * FROM plans WHERE project = ? AND state IN (${states.map(() => '?').join(', ')}) ORDER BY proposed_at, id`).all(this.#project, ...states) as Row[]
      : this.#db.prepare('SELECT * FROM plans WHERE project = ? ORDER BY proposed_at DESC, id DESC').all(this.#project) as Row[];
    return rows.map((row) => this.#plan(row));
  }

  // The plan and position of a ticket the plans created.
  itemOf(ticket: TicketId): { readonly plan: StoredPlan; readonly item: StoredItem } | undefined {
    const row = this.#db.prepare('SELECT i.plan_id, i.position FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.ticket = ? AND p.project = ? ORDER BY p.proposed_at DESC LIMIT 1')
      .get(ticket, this.#project) as Row | undefined;
    const plan = row ? this.get(String(row.plan_id)) : undefined;
    const item = plan?.items.find((i) => i.position === Number(row?.position));
    return plan && item ? { plan, item } : undefined;
  }

  // Stores a proposal, and supersedes the proposals of the same goal still
  // waiting (never an approved one). Answers the new plan and the ids it superseded.
  propose(input: NewPlan): { readonly plan: StoredPlan; readonly superseded: readonly string[] } {
    return this.#transaction(() => {
      const at = this.#at();
      const superseded = (this.#db.prepare("SELECT id FROM plans WHERE project = ? AND goal = ? AND state = 'proposed'").all(this.#project, input.goal) as Row[]).map((row) => String(row.id));
      for (const id of superseded) this.#db.prepare("UPDATE plans SET state = 'superseded', ended_at = ? WHERE id = ?").run(at, id);
      const count = Number((this.#db.prepare('SELECT COUNT(*) AS n FROM plans WHERE project = ?').get(this.#project) as Row).n);
      let n = count + 1;
      while (this.#db.prepare('SELECT 1 FROM plans WHERE id = ?').get(`plan-${n}`)) n++;
      const id = `plan-${n}`;
      this.#db.prepare('INSERT INTO plans (id, project, goal, title, summary, state, max_parallel, totals, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, this.#project, input.goal, input.title, input.summary, 'proposed', input.maxParallel, JSON.stringify(input.totals), at);
      input.items.forEach((item, index) => {
        this.#db.prepare('INSERT INTO plan_items (plan_id, position, title, body, lane, size, after, estimate, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, index + 1, item.title, item.body, item.lane, item.size, JSON.stringify(item.after), JSON.stringify(item.estimate), 'waiting', at);
      });
      return { plan: this.get(id) as StoredPlan, superseded };
    });
  }

  // Moves a plan from one of `from` to `to`; true when this call moved it,
  // so that two approvals cannot both create the tickets.
  move(id: string, from: readonly PlanState[], to: PlanState, approvedBy?: UserId): boolean {
    const at = this.#at();
    const ended = to === 'superseded' || to === 'rejected' || to === 'done' ? at : null;
    const result = this.#db.prepare(`UPDATE plans SET state = ?,
      approved_at = CASE WHEN ? = 'approved' AND approved_at IS NULL THEN ? ELSE approved_at END,
      approved_by = CASE WHEN ? = 'approved' AND approved_by IS NULL THEN ? ELSE approved_by END,
      ended_at = COALESCE(?, ended_at)
      WHERE id = ? AND project = ? AND state IN (${from.map(() => '?').join(', ')})`)
      .run(to, to, at, to, approvedBy ?? null, ended, id, this.#project, ...from);
    return Number(result.changes) > 0;
  }

  setTicket(id: string, position: number, ticket: TicketId): void {
    this.#db.prepare('UPDATE plan_items SET ticket = ?, updated_at = ? WHERE plan_id = ? AND position = ? AND ticket IS NULL').run(ticket, this.#at(), id, position);
  }

  // An item's new state; `putBack` counts one more put back, `note` replaces the note.
  setItem(id: string, position: number, change: { readonly state: PlanItemState; readonly putBack?: boolean; readonly note?: string | null }): void {
    this.#db.prepare(`UPDATE plan_items SET state = ?, put_backs = put_backs + ?, note = CASE WHEN ? THEN ? ELSE note END, updated_at = ?
      WHERE plan_id = ? AND position = ?`)
      .run(change.state, change.putBack ? 1 : 0, change.note === undefined ? 0 : 1, change.note ?? null, this.#at(), id, position);
  }
}

// The API's plan, without what only the runner reads.
export function publicPlan(plan: StoredPlan): Plan {
  return {
    id: plan.id, goal: plan.goal, title: plan.title, summary: plan.summary, maxParallel: plan.maxParallel, totals: plan.totals,
    state: plan.state, proposedAt: plan.proposedAt, approvedAt: plan.approvedAt, approvedBy: plan.approvedBy,
    items: plan.items.map(({ putBacks: _p, note: _n, ...item }) => item),
  };
}
