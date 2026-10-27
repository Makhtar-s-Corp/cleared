// The review record merge-pr.ts reads (lane 8; the contract is registry.ts
// ReviewRecorder). A review is a `runs` row with role review, source
// dispatcher, outcome done, its pull request and ticket, and a report file
// <state>/reports/<run id>.md in the format lib/reviews.ts readReport
// parses: a front matter with the reviewed commit, then the report, whose
// first « Verdict : » line is what lib/merge.ts verdictIs reads.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ReviewRecord, ReviewRecorder } from '../modules/registry.ts';

// One statement each, as lib/ledger.ts SCHEMA writes them (a test keeps them identical).
export const RUNS_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  ticket TEXT,
  role TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache INTEGER,
  cost_eur REAL,
  outcome TEXT,
  pr_number INTEGER,
  lines_changed INTEGER,
  human_decision TEXT,
  human_latency_min REAL,
  lane TEXT,
  source TEXT NOT NULL DEFAULT 'dispatcher',
  requested_model TEXT,
  exit_code INTEGER,
  tokens_cache_write INTEGER,
  tokens_total INTEGER,
  cost_basis TEXT,
  project TEXT,
  label TEXT
)`,
  'CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at)',
  'CREATE INDEX IF NOT EXISTS runs_ticket ON runs (ticket)',
  `CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticket TEXT,
  run_id TEXT,
  detail TEXT,
  value REAL,
  source TEXT NOT NULL DEFAULT 'dispatcher'
)`,
  'CREATE INDEX IF NOT EXISTS events_at ON events (at)',
];

export class ReviewRecordError extends Error {
  override name = 'ReviewRecordError';
}

export type ReviewRecorderOptions = {
  readonly stateDir: string;
  readonly verdict: string;                          // [merge] verdict: what a passing report concludes; empty: the record's
  readonly resolveHead?: (pr: number) => Promise<string | undefined>;
};

const TICKET = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_REPORT = 20_000;

// A line of the reviewer's text that reads as a verdict or as a section of the
// report is quoted, so that it cannot say the verdict, or end the report, for
// the recorder.
const neutralise = (text: string) => text.split('\n')
  .map((line) => (/^\**\s*Verdict\s*\**\s*:/i.test(line) || /^##\s/.test(line) ? `> ${line}` : line)).join('\n');

export class LedgerReviewRecorder implements ReviewRecorder {
  readonly #db: DatabaseSync;
  readonly #options: ReviewRecorderOptions;

  constructor(db: DatabaseSync, options: ReviewRecorderOptions) {
    this.#db = db;
    this.#options = options;
  }

  // The commit the reviewer read is the record's, else resolveHead's, else
  // refused. The verdict phrase is the options', from the file the lock
  // reads (CLEARED_CONF, or the project CLEARED_REPO names), else the
  // record's, the one the flow judged the review by: an install by the setup
  // assistant names neither variable (issue #445).
  async record(review: ReviewRecord): Promise<void> {
    if (!TICKET.test(review.ticket)) throw new ReviewRecordError(`not a ticket: ${review.ticket}`);
    if (!Number.isSafeInteger(review.pr) || review.pr <= 0) throw new ReviewRecordError('not a pull request number');
    if (!Number.isSafeInteger(review.round) || review.round <= 0) throw new ReviewRecordError('not a review round');
    if (!SESSION.test(review.session)) throw new ReviewRecordError('not a session id');
    if (!Number.isFinite(Date.parse(review.at))) throw new ReviewRecordError('not a time');
    const verdict = this.#options.verdict.trim() || review.verdictPhrase?.trim() || '';
    if (!verdict) throw new ReviewRecordError('[merge] verdict is not set: the record cannot say what a passing review concludes');
    const commit = review.commit ?? await this.#options.resolveHead?.(review.pr);
    if (!commit || !COMMIT.test(commit)) throw new ReviewRecordError(`the version (commit) the review read is not known for #${review.pr}`);

    const runId = `${review.ticket}-pr${review.pr}-r${review.round}-${review.session}`;
    const reports = join(this.#options.stateDir, 'reports');
    const file = join(reports, `${runId}.md`);
    const said = review.verdict === 'pass' ? verdict : 'not passed: changes requested';
    const text = `---\ncommit: ${commit}\noutcome: done\nended_at: ${review.at}\n---\n## Report\nVerdict: ${said}\n\n${neutralise(String(review.report).slice(0, MAX_REPORT))}\n`;
    mkdirSync(reports, { recursive: true, mode: 0o700 });
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`INSERT INTO runs (run_id, ticket, role, model, started_at, ended_at, outcome, pr_number, source)
        VALUES (?, ?, 'review', ?, ?, ?, 'done', ?, 'dispatcher')`).run(runId, review.ticket, review.model, review.at, review.at, review.pr);
      const part = `${file}.part`;
      writeFileSync(part, text, { mode: 0o600, flag: 'wx' });
      try { renameSync(part, file); } catch (error) { rmSync(part, { force: true }); throw error; }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
