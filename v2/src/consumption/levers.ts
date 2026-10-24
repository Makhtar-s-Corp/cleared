// The levers of the Consumption screen (docs/v2/requirements-matrix.md, O15):
// three settings the owner turns in one click to slow the spend, kept in
// consumption_levers (one row per lever and project) and read by the parts
// they act on, never copied:
//
//   model      the author model of the sessions that start from now on (flow/
//              engine.ts #authorModel); never the reviewer's, which the
//              reviewer must differ from
//   maxLanes   the most steps of one ticket that run at once, whatever the
//              plan says (flow/engine.ts, the step limit)
//   paused     the schedules start nothing while it is on; a run due meanwhile
//              is taken once at the resume, as after a stop of the service
//              (schedules/scheduler.ts)
//
// A lever that was never set reads as off: the configuration's own values.
import type { DatabaseSync } from 'node:sqlite';

export const LEVERS_TABLE = `CREATE TABLE IF NOT EXISTS consumption_levers (
  project TEXT NOT NULL, lever TEXT NOT NULL, value TEXT NOT NULL, by_user TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (project, lever)
)`;

// The models the owner may choose for the authors, cheapest last.
export const AUTHOR_MODELS: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const MAX_LANES = 8;

// The author models the owner may choose, in one place for the options the
// screen draws and the validation of a change: the list, the configured
// author (the default in force) and the model stored earlier, which stay
// choices when the list drifts from the configuration; never the reviewers'.
export function modelChoices(config: { readonly authorModel: string; readonly reviewerModel: string }, stored: string | null): string[] {
  return [...new Set([...AUTHOR_MODELS, config.authorModel, ...(stored ? [stored] : [])])].filter((model) => model !== config.reviewerModel);
}

export type Levers = {
  readonly model: string | null;        // null: the configuration's author model
  readonly maxLanes: number | null;     // null: the plan's own limit
  readonly paused: boolean;
};

export type LeversChange = { readonly model?: string | null; readonly maxLanes?: number | null; readonly paused?: boolean };

export const NO_LEVERS: Levers = { model: null, maxLanes: null, paused: false };

export class LeverError extends Error {
  override name = 'LeverError';
}

export type LeverReader = { read(): Levers };

export class LeverStore implements LeverReader {
  readonly #db: DatabaseSync;
  readonly #project: string;

  constructor(db: DatabaseSync, project: string) {
    this.#db = db;
    this.#project = project;
  }

  read(): Levers {
    let rows: { lever: string; value: string }[];
    try {
      rows = this.#db.prepare('SELECT lever, value FROM consumption_levers WHERE project = ?').all(this.#project) as { lever: string; value: string }[];
    } catch (error) {
      // A service whose lead module has not created the table yet: nothing is set.
      if (error instanceof Error && /no such table/.test(error.message)) return NO_LEVERS;
      throw error;
    }
    const value = (name: string) => rows.find((row) => row.lever === name)?.value;
    const lanes = Number(value('maxLanes'));
    return {
      model: value('model') ?? null,
      maxLanes: Number.isInteger(lanes) && lanes >= 1 ? lanes : null,
      paused: value('paused') === '1',
    };
  }

  // Applies a change, refused whole when a part is not valid. `reviewerModel`
  // is the model the reviewers use: the author's may not be the same;
  // `authorModel` is the configured one, a choice as the screen offers it.
  set(change: LeversChange, by: string, at: string, reviewerModel: string, authorModel: string = AUTHOR_MODELS[0] as string): Levers {
    const known = new Set(['model', 'maxLanes', 'paused']);
    const unknown = Object.keys(change).filter((key) => !known.has(key));
    if (unknown.length > 0) throw new LeverError(`unknown lever: ${unknown.join(', ')}`);
    if (Object.keys(change).length === 0) throw new LeverError('name a lever to change: model, maxLanes or paused');
    if (change.model !== undefined && change.model !== null) {
      if (change.model === reviewerModel) throw new LeverError(`the author's model cannot be the reviewers' (${reviewerModel}): another model reviews the work`);
      const choices = modelChoices({ authorModel, reviewerModel }, this.read().model);
      if (!choices.includes(change.model)) throw new LeverError(`model must be one of ${choices.join(', ')}, or null for the configured one`);
    }
    if (change.maxLanes !== undefined && change.maxLanes !== null && (!Number.isInteger(change.maxLanes) || change.maxLanes < 1 || change.maxLanes > MAX_LANES)) {
      throw new LeverError(`maxLanes is a whole number from 1 to ${MAX_LANES}, or null for the plan's own limit`);
    }
    if (change.paused !== undefined && typeof change.paused !== 'boolean') throw new LeverError('paused is true or false');
    this.#db.exec('BEGIN');
    try {
      if (change.model !== undefined) this.#write('model', change.model === null ? null : change.model, by, at);
      if (change.maxLanes !== undefined) this.#write('maxLanes', change.maxLanes === null ? null : String(change.maxLanes), by, at);
      if (change.paused !== undefined) this.#write('paused', change.paused ? '1' : null, by, at);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.read();
  }

  // A null value puts the lever back to off: its row is deleted.
  #write(lever: string, value: string | null, by: string, at: string): void {
    if (value === null) {
      this.#db.prepare('DELETE FROM consumption_levers WHERE project = ? AND lever = ?').run(this.#project, lever);
      return;
    }
    this.#db.prepare(`INSERT INTO consumption_levers (project, lever, value, by_user, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (project, lever) DO UPDATE SET value = excluded.value, by_user = excluded.by_user, at = excluded.at`).run(this.#project, lever, value, by, at);
  }
}
