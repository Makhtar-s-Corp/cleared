// The fast lane kept from v1 (matrix B2.2; the first plan of milestone 2,
// decision 15; docs/fast-lane.md). A ticket with the Quick label opens on it
// (its author is Haiku, engine.ts #authorModel); then v1's written rules,
// never a model, judge what merging the ticket's branch would land on the
// base: lib/fast-lane.mjs decideLane, run as it is, in a child process, on
// the service's own checkout and with the [fast_lane] settings of the
// service's base branch, never the branch's. The engine asks after each
// author session and again at the head it publishes.
//
// A rule the diff breaks sends the ticket back to the full circuit for good:
// a row of fast_lanes, which a restart keeps, says so, and every later
// author session runs on the full author model. What says nothing of the
// change (the fast lane off or its settings unreadable, a merge git cannot
// compute) is the full circuit at that head only, as v1's `keep: false`.
// The review is the full circuit's in v2 whatever the lane, and the approval
// is asked while the checks run for every ticket; the lock's merge waits for
// them. v1's lane record, which lets merge-pr.ts spare a fast merge the
// unrelated checks, is not written: a fast ticket's merge waits as any.
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { FastLane, FastReason } from '../api/types.ts';
import type { Sections } from '../workspace/config.ts';

// What the rules said at one head. `keep`: the verdict is the change's own,
// so a `full` one sends the ticket back for good. `first`: the first path
// that broke each rule, for the lead and the ticket's log, never the card.
// `problem`: why the settings could not be read.
export type FastVerdict = {
  readonly state: 'fast' | 'full';
  readonly reasons: readonly FastReason[];
  readonly keep: boolean;
  readonly head?: string;
  readonly lines?: number;
  readonly files?: number;
  readonly first?: string;
  readonly problem?: string;
};

export const FAST_LANES_TABLE = `CREATE TABLE IF NOT EXISTS fast_lanes (
  ticket TEXT PRIMARY KEY, project TEXT NOT NULL, state TEXT NOT NULL, head TEXT, reasons TEXT NOT NULL,
  lines INTEGER, files INTEGER, at TEXT NOT NULL, demoted_at TEXT
)`;

export type FastLaneRow = { readonly ticket: string; readonly state: 'fast' | 'full'; readonly head: string | null; readonly reasons: readonly FastReason[]; readonly demotedAt: string | null };

// One row a ticket: the last head the rules kept fast, or the demotion,
// which nothing overwrites.
export class FastLaneStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(FAST_LANES_TABLE);
  }

  get(ticket: string): FastLaneRow | undefined {
    const row = this.#db.prepare('SELECT ticket, state, head, reasons, demoted_at FROM fast_lanes WHERE ticket = ?').get(ticket) as
      { ticket: string; state: 'fast' | 'full'; head: string | null; reasons: string; demoted_at: string | null } | undefined;
    return row && { ticket: row.ticket, state: row.state, head: row.head, reasons: JSON.parse(row.reasons) as FastReason[], demotedAt: row.demoted_at };
  }

  demoted(ticket: string): boolean {
    return this.get(ticket)?.state === 'full';
  }

  // The head kept fast; nothing once the ticket is sent back.
  kept(ticket: string, project: string, verdict: FastVerdict, at: string): void {
    this.#db.prepare(`INSERT INTO fast_lanes (ticket, project, state, head, reasons, lines, files, at) VALUES (?, ?, 'fast', ?, '[]', ?, ?, ?)
      ON CONFLICT (ticket) DO UPDATE SET head = excluded.head, lines = excluded.lines, files = excluded.files, at = excluded.at WHERE fast_lanes.state = 'fast'`)
      .run(ticket, project, verdict.head ?? null, verdict.lines ?? null, verdict.files ?? null, at);
  }

  // Sent back, for good; true when this call did it.
  demote(ticket: string, project: string, verdict: Pick<FastVerdict, 'reasons' | 'head' | 'lines' | 'files'>, at: string): boolean {
    const changed = this.#db.prepare(`INSERT INTO fast_lanes (ticket, project, state, head, reasons, lines, files, at, demoted_at) VALUES (?, ?, 'full', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (ticket) DO UPDATE SET state = 'full', head = excluded.head, reasons = excluded.reasons, lines = excluded.lines, files = excluded.files, at = excluded.at, demoted_at = excluded.demoted_at
      WHERE fast_lanes.state = 'fast'`)
      .run(ticket, project, verdict.head ?? null, JSON.stringify(verdict.reasons), verdict.lines ?? null, verdict.files ?? null, at, at);
    return Number(changed.changes) > 0;
  }
}

// What the release card carries: a demotion wins over what a head said.
export function cardLane(row: FastLaneRow | undefined, verdict: FastVerdict | undefined): FastLane {
  if (row?.state === 'full') return { state: 'full', reasons: row.reasons };
  if (!verdict) return { state: 'off', reasons: ['unreadable'] };
  if (verdict.state === 'fast') return { state: 'fast', reasons: [] };
  return { state: verdict.keep ? 'full' : 'off', reasons: verdict.reasons };
}

// The rules' words, as v1's app says them (lib/i18n/en.json, app_srv_fast_reason_*),
// for the ticket's comment; the card has its own, in the app's catalogs.
const REASON_WORDS: Record<FastReason, string> = {
  empty: 'the change is empty',
  too_many_files: 'too many files changed',
  too_many_lines: 'too many lines changed',
  too_large: 'a file is too large',
  unusual_change: 'a file is deleted, renamed, linked or made executable',
  binary: 'a binary file changed',
  path_form: 'a file name the rules cannot read',
  protected: 'it touches the engine, the checks or security',
  dependency: 'it changes a dependency',
  migration: 'it touches a database migration',
  outside_safe: 'a file outside the safe list',
  file_type: 'a file of a type the fast lane does not take (code, configuration, or no plain-text extension)',
  content: 'a file gains markup, a load, a template, an escape or a hidden character',
  link: 'a file gains a link or a remote address',
  asked: 'the team needed to ask you something',
  unreadable: 'git could not read the change against the base',
  settings: 'the fast lane settings of the service cannot be read',
  disabled: 'the fast lane is off for this service',
  several_services: 'the ticket changes several services',
};

export function fallbackComment(reasons: readonly FastReason[]): string {
  return `Back to the full circuit: ${reasons.map((r) => REASON_WORDS[r]).join('; ')}. `
    + 'The next author sessions of this ticket run on the full author model, and it never comes back to the fast lane. The review and your approval are unchanged.';
}

// ---- lib/fast-lane.mjs, in a child process --------------------------------

const FAST_LANE_MODULE = new URL('../../../lib/fast-lane.mjs', import.meta.url).href;

// decideLane with a record that opened fast, so only the settings and the
// diff decide; readDiff is its own (git merge-tree into a scratch object
// folder, three readings that must agree).
const FAST_LANE_PROGRAM = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
try {
  const { decideLane } = await import(request.module);
  const result = decideLane({ conf: { sections: request.sections }, repo: request.repo, base: request.base, commit: request.commit, record: { fast_lane: { opening: 'fast', state: 'fast' } } });
  const first = Object.entries(result.offending ?? {}).map(([code, path]) => code + ': ' + path).join('; ').slice(0, 400);
  process.stdout.write(JSON.stringify({ state: result.state, reasons: result.reasons, keep: result.keep, head: result.head, lines: result.lines, files: result.files, first: first || undefined, problem: result.problem }));
} catch (error) {
  process.stderr.write(String(error && error.message || error));
  process.exitCode = 1;
}
`;

const JUDGE_TIMEOUT_MS = 60_000;

export function judgeDiff(input: { readonly sections: Sections; readonly repo: string; readonly base: string; readonly commit: string; readonly env: NodeJS.ProcessEnv }): Promise<FastVerdict> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', FAST_LANE_PROGRAM], { env: input.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), JUDGE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-1000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`the fast lane's rules: ${stderr.trim().slice(0, 300) || `exit ${code}`}`));
      try {
        const read = JSON.parse(stdout) as FastVerdict;
        resolve({
          state: read.state === 'fast' ? 'fast' : 'full', reasons: read.reasons, keep: read.keep === true,
          ...(read.head ? { head: read.head } : {}), ...(typeof read.lines === 'number' ? { lines: read.lines } : {}), ...(typeof read.files === 'number' ? { files: read.files } : {}),
          ...(read.first ? { first: read.first } : {}), ...(read.problem ? { problem: read.problem } : {}),
        });
      } catch {
        reject(new Error('the fast lane\'s rules: the answer is not JSON'));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ module: FAST_LANE_MODULE, sections: input.sections, repo: input.repo, base: input.base, commit: input.commit }));
  });
}
