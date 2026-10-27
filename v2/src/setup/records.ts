// The records of the assistant's steps (docs/v2/milestone-5-plan.md, section
// 1: each step's time from the assistant's own records, split into the
// person's time and the machine's). A step is shown (its page opened, the
// first time counts), the machine works on it (a check, a build: measured
// by the step's code), then it is done or skipped. The person's time is the
// time from shown to done or skipped, less the machine's; never below zero.
import type { DatabaseSync } from 'node:sqlite';
import { isStepId, type StepId } from './types.ts';

export const SETUP_STEPS_TABLE = `CREATE TABLE IF NOT EXISTS v2_setup_steps (
  step TEXT PRIMARY KEY, shown_at TEXT, done_at TEXT, skipped_at TEXT, machine_ms INTEGER NOT NULL DEFAULT 0
)`;

export type StepRecord = {
  readonly step: StepId;
  readonly shownAt: string | null;
  readonly doneAt: string | null;
  readonly skippedAt: string | null;
  readonly personMs: number;
  readonly machineMs: number;
};

type Row = { step: string; shown_at: string | null; done_at: string | null; skipped_at: string | null; machine_ms: number };

const known = (step: string): StepId => {
  if (!isStepId(step)) throw new Error(`unknown step ${step}`);
  return step;
};

export class SetupRecords {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, options: { readonly now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  #at(): string {
    return this.#now().toISOString();
  }

  shown(step: StepId): void {
    this.#db.prepare('INSERT INTO v2_setup_steps (step, shown_at) VALUES (?, ?) ON CONFLICT (step) DO UPDATE SET shown_at = COALESCE(shown_at, excluded.shown_at)').run(known(step), this.#at());
  }

  machine(step: StepId, ms: number): void {
    const add = Math.max(0, Math.round(ms));
    this.#db.prepare('INSERT INTO v2_setup_steps (step, machine_ms) VALUES (?, ?) ON CONFLICT (step) DO UPDATE SET machine_ms = machine_ms + excluded.machine_ms').run(known(step), add);
  }

  // Done: a skip before it no longer counts. Done without being shown counts
  // from then. `at`: when it was done, if not now (the first ticket went
  // live before its page looked), never before it was shown.
  done(step: StepId, at: string = this.#at()): void {
    this.#db.prepare('INSERT INTO v2_setup_steps (step, shown_at, done_at) VALUES (?, ?, ?) ON CONFLICT (step) DO UPDATE SET shown_at = COALESCE(shown_at, excluded.shown_at), done_at = MAX(excluded.done_at, COALESCE(shown_at, excluded.done_at)), skipped_at = NULL').run(known(step), at, at);
  }

  skipped(step: StepId): void {
    const at = this.#at();
    this.#db.prepare('INSERT INTO v2_setup_steps (step, shown_at, skipped_at) VALUES (?, ?, ?) ON CONFLICT (step) DO UPDATE SET shown_at = COALESCE(shown_at, excluded.shown_at), skipped_at = excluded.skipped_at, done_at = NULL').run(known(step), at, at);
  }

  get(step: StepId): StepRecord | undefined {
    const row = this.#db.prepare('SELECT step, shown_at, done_at, skipped_at, machine_ms FROM v2_setup_steps WHERE step = ?').get(known(step)) as Row | undefined;
    return row ? record(row) : undefined;
  }

  all(): StepRecord[] {
    return (this.#db.prepare('SELECT step, shown_at, done_at, skipped_at, machine_ms FROM v2_setup_steps').all() as Row[]).filter((row) => isStepId(row.step)).map(record);
  }
}

function record(row: Row): StepRecord {
  const end = row.done_at ?? row.skipped_at;
  const spent = end && row.shown_at ? Date.parse(end) - Date.parse(row.shown_at) : 0;
  return {
    step: row.step as StepId, shownAt: row.shown_at, doneAt: row.done_at, skippedAt: row.skipped_at,
    personMs: Math.max(0, spent - row.machine_ms), machineMs: row.machine_ms,
  };
}
