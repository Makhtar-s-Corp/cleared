// The schedules' tables (docs/v2/milestone-2-plan.md, decision 29), module
// tables of the lead module, which registers the schedules with the plan
// runner:
//
//   schedules       a recipe or a goal, `at` a time or `every` period, the
//                   budget of each ticket, the week-share cap, who created
//                   it (whose approval its plans carry), enabled, and the
//                   next and last run; a removed schedule keeps its row,
//                   with when it was removed, so its id is never given again
//   schedule_runs   each run, ran or failed, with the plan it started (or
//                   the goal it sent, until the lead's plan for it is
//                   approved) and the budget it gave, which the flow's
//                   start reads by plan
import type { DatabaseSync } from 'node:sqlite';
import type { Schedule } from '../api/types.ts';
import type { UserId } from '../session/contract.ts';

export const SCHEDULE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, recipe TEXT, goal TEXT, parameters TEXT NOT NULL,
  at TEXT, every TEXT, budget_usd REAL NOT NULL, week_cap_percent REAL NOT NULL, created_by TEXT NOT NULL,
  enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL, removed_at TEXT
)`,
  `CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, schedule TEXT NOT NULL, project TEXT NOT NULL, at TEXT NOT NULL,
  outcome TEXT NOT NULL, reason TEXT, note TEXT, plan TEXT, goal TEXT, message INTEGER,
  budget_usd REAL NOT NULL, created_by TEXT NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS schedule_runs_plan ON schedule_runs (plan)',
];

export type NewSchedule = Omit<Schedule, 'id' | 'lastRunAt' | 'createdAt' | 'enabled'>;

export type ScheduleRun = {
  readonly schedule: string;
  readonly at: string;
  readonly outcome: 'ran' | 'failed';
  readonly reason?: string;
  readonly note?: string;
  readonly plan?: string;
  readonly goal?: string;
  readonly message?: number;
  readonly budgetUsd: number;
  readonly createdBy: UserId;
};

// A goal's run whose plan the lead has not proposed, or the scheduler not approved, yet.
export type GoalRun = { readonly id: number; readonly schedule: string; readonly goal: string; readonly budgetUsd: number; readonly createdBy: UserId };

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export class ScheduleStore {
  #db: DatabaseSync;
  #project: string;

  constructor(db: DatabaseSync, project: string) {
    this.#db = db;
    this.#project = project;
  }

  #schedule(row: Row): Schedule {
    return {
      id: String(row.id), recipe: str(row.recipe), goal: str(row.goal), parameters: JSON.parse(String(row.parameters)) as Record<string, string>,
      at: str(row.at), every: str(row.every), budgetUsd: Number(row.budget_usd), weekCapPercent: Number(row.week_cap_percent),
      createdBy: String(row.created_by), enabled: Number(row.enabled) === 1, nextRunAt: str(row.next_run_at), lastRunAt: str(row.last_run_at), createdAt: String(row.created_at),
    };
  }

  add(input: NewSchedule, at: string): Schedule {
    // Every row counts, a removed schedule's included: its runs stay its own.
    let n = Number((this.#db.prepare('SELECT COUNT(*) AS n FROM schedules').get() as Row).n) + 1;
    while (this.#db.prepare('SELECT 1 FROM schedules WHERE id = ?').get(`sch-${n}`)) n++;
    const id = `sch-${n}`;
    this.#db.prepare(`INSERT INTO schedules (id, project, recipe, goal, parameters, at, every, budget_usd, week_cap_percent, created_by, enabled, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, this.#project, input.recipe, input.goal, JSON.stringify(input.parameters), input.at, input.every, input.budgetUsd, input.weekCapPercent, input.createdBy, input.nextRunAt, at);
    return this.get(id) as Schedule;
  }

  get(id: string): Schedule | undefined {
    const row = this.#db.prepare('SELECT * FROM schedules WHERE id = ? AND project = ? AND removed_at IS NULL').get(id, this.#project) as Row | undefined;
    return row ? this.#schedule(row) : undefined;
  }

  list(): Schedule[] {
    return (this.#db.prepare('SELECT * FROM schedules WHERE project = ? AND removed_at IS NULL ORDER BY created_at, id').all(this.#project) as Row[]).map((row) => this.#schedule(row));
  }

  remove(id: string, at: string): boolean {
    return Number(this.#db.prepare('UPDATE schedules SET removed_at = ?, enabled = 0, next_run_at = NULL WHERE id = ? AND project = ? AND removed_at IS NULL').run(at, id, this.#project).changes) > 0;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.#db.prepare('UPDATE schedules SET enabled = ? WHERE id = ? AND project = ?').run(enabled ? 1 : 0, id, this.#project);
  }

  // The enabled schedules whose next run has come, oldest first.
  due(now: string): Schedule[] {
    return (this.#db.prepare('SELECT * FROM schedules WHERE project = ? AND enabled = 1 AND removed_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id').all(this.#project, now) as Row[])
      .map((row) => this.#schedule(row));
  }

  // Takes the run due at `due` for this call, moving the schedule to its
  // next run (none: a schedule `at` a time is then disabled); true when this
  // call took it, so a run is started once.
  claim(id: string, due: string, next: string | null, at: string): boolean {
    return Number(this.#db.prepare(`UPDATE schedules SET next_run_at = ?, last_run_at = ?, enabled = CASE WHEN ? IS NULL THEN 0 ELSE enabled END
      WHERE id = ? AND project = ? AND enabled = 1 AND next_run_at = ?`).run(next, at, next, id, this.#project, due).changes) > 0;
  }

  record(run: ScheduleRun): number {
    const result = this.#db.prepare(`INSERT INTO schedule_runs (schedule, project, at, outcome, reason, note, plan, goal, message, budget_usd, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.schedule, this.#project, run.at, run.outcome, run.reason ?? null, run.note ?? null, run.plan ?? null, run.goal ?? null, run.message ?? null, run.budgetUsd, run.createdBy);
    return Number(result.lastInsertRowid);
  }

  // The schedule's last run, ran or failed, and why it failed.
  lastRun(schedule: string): { readonly outcome: 'ran' | 'failed'; readonly reason: string | null } | undefined {
    const row = this.#db.prepare('SELECT outcome, reason FROM schedule_runs WHERE project = ? AND schedule = ? ORDER BY id DESC LIMIT 1').get(this.#project, schedule) as Row | undefined;
    return row ? { outcome: String(row.outcome) as 'ran' | 'failed', reason: str(row.reason) } : undefined;
  }

  setRunPlan(run: number, plan: string): void {
    this.#db.prepare('UPDATE schedule_runs SET plan = ? WHERE id = ?').run(plan, run);
  }

  goalRunsWaiting(since: string): GoalRun[] {
    return (this.#db.prepare("SELECT id, schedule, goal, budget_usd, created_by FROM schedule_runs WHERE project = ? AND outcome = 'ran' AND goal IS NOT NULL AND plan IS NULL AND at >= ? ORDER BY id")
      .all(this.#project, since) as Row[])
      .map((row) => ({ id: Number(row.id), schedule: String(row.schedule), goal: String(row.goal), budgetUsd: Number(row.budget_usd), createdBy: String(row.created_by) }));
  }

  // The budget a schedule gave the plan's tickets; undefined for a plan no schedule started.
  budgetOfPlan(plan: string): number | undefined {
    const row = this.#db.prepare('SELECT budget_usd FROM schedule_runs WHERE project = ? AND plan = ? ORDER BY id DESC LIMIT 1').get(this.#project, plan) as Row | undefined;
    return row ? Number(row.budget_usd) : undefined;
  }
}
