// The human's choice of the proof receipt's captures on a ticket (issue
// #368, matrix P226): Auto lets the rule decide (flow/capture-need.ts), On
// and Off win over it. One row a ticket in the ledger, which a restart
// keeps, with the person who chose and when (B5.9a); a ticket without a
// row is on Auto. The
// tracker's ticket is not changed: the ticket store has no field for it,
// and the choice is the flow's, as the fast lane's row is (flow/fast-lane.ts).
import type { DatabaseSync } from 'node:sqlite';
import type { CaptureChoice } from '../api/types.ts';
import type { CaptureChoiceName } from './capture-need.ts';

export const CAPTURE_CHOICES_TABLE = `CREATE TABLE IF NOT EXISTS capture_choices (
  ticket TEXT PRIMARY KEY, project TEXT NOT NULL, choice TEXT NOT NULL, by_user TEXT NOT NULL, at TEXT NOT NULL
)`;

export const AUTO_CHOICE: CaptureChoice = { choice: 'auto', by: null, at: null };

export class CaptureChoiceStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(CAPTURE_CHOICES_TABLE);
  }

  get(ticket: string): CaptureChoice {
    const row = this.#db.prepare('SELECT choice, by_user, at FROM capture_choices WHERE ticket = ?').get(ticket) as { choice: CaptureChoiceName; by_user: string; at: string } | undefined;
    return row ? { choice: row.choice, by: row.by_user, at: row.at } : AUTO_CHOICE;
  }

  set(ticket: string, project: string, choice: CaptureChoiceName, by: string, at: string): CaptureChoice {
    this.#db.prepare(`INSERT INTO capture_choices (ticket, project, choice, by_user, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(ticket) DO UPDATE SET choice = excluded.choice, by_user = excluded.by_user, at = excluded.at`).run(ticket, project, choice, by, at);
    return { choice, by, at };
  }
}
