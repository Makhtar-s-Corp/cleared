// The harness pick (issue #329, docs/v2/requirements-matrix.md P213): a
// one-service ticket runs as variants (flow/variants.ts, P75), one per
// harness named, and once every variant has ended the flow keeps, by
// itself, the cheapest of those whose tests passed. The others stop and
// their containers go, as the owner's choice does; the kept one is
// reviewed and published, so it is the pull request.
//
//   green     the variant committed a change against the base, and the
//             declared test command (ProjectSettings.testCommand) ran alone
//             in its own session and exited 0, read from the ledger as the
//             reviewer's run is (review-tests.ts). None declared, or none
//             green: nothing is kept by itself, and the owner chooses in
//             the inbox as for plain variants
//   cheapest  the fewest tokens (consumption/ticket-cost.ts sessionsCost)
//             when every green variant reports tokens; else the shortest
//             agent time, since Cursor reports no tokens; then the other
//             measure, then the position. Never dollars: Codex and Cursor
//             report none, and a figure for one harness only ranks nothing
//   the gate  the harnesses the owner enabled, CLEARED_V2_PICK_HARNESSES
//             (Claude Code alone by default): the real Codex and Cursor
//             wait for the owner's trials (docs/adapters.md)
//   the stop  a variant whose harness has a window at or above the week
//             stop (CLEARED_V2_WEEK_STOP_PERCENT) does not start, and fails
//             with the reason; the others go on
//
// The wins are counted from ticket_variants, per ticket type: the type is
// read from the ticket's labels when the run starts.
import type { DatabaseSync } from 'node:sqlite';
import type { HarnessWins, TicketType } from '../api/types.ts';
import type { Harness } from '../session/contract.ts';
import { FlowConfigError } from './config.ts';

export const PICK_HARNESSES: readonly Harness[] = ['claude-code', 'codex', 'cursor'];

export type PickHarness = { readonly harness: Harness; readonly model?: string };

// Claude Code alone until the owner enables the others.
export const PICK_DEFAULT: readonly PickHarness[] = [{ harness: 'claude-code' }];

// The share of a window past which no variant starts, when the service sets none: the plans' 85 %.
export const PICK_STOP_PERCENT = 85;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

// CLEARED_V2_PICK_HARNESSES: `claude-code,codex,cursor=<model>`, each at
// most once. Claude Code's and Codex's model may be named; Cursor's must
// be, as the adapter has no default one.
export function pickHarnessesOf(value: string | undefined): readonly PickHarness[] {
  const words = (value ?? '').split(',').map((word) => word.trim()).filter(Boolean);
  if (words.length === 0) return PICK_DEFAULT;
  const seen = new Set<string>();
  return words.map((word) => {
    const [name = '', model, ...rest] = word.split('=').map((part) => part.trim());
    if (!(PICK_HARNESSES as readonly string[]).includes(name)) throw new FlowConfigError(`CLEARED_V2_PICK_HARNESSES names ${PICK_HARNESSES.join(', ')}, not "${name}"`);
    if (seen.has(name)) throw new FlowConfigError(`CLEARED_V2_PICK_HARNESSES names ${name} twice`);
    seen.add(name);
    if (rest.length > 0 || (model !== undefined && !MODEL.test(model))) throw new FlowConfigError(`CLEARED_V2_PICK_HARNESSES: "${word}" is a harness, or a harness=model`);
    if (model === undefined && name === 'cursor') throw new FlowConfigError('CLEARED_V2_PICK_HARNESSES: cursor needs its model, cursor=<model>');
    return { harness: name as Harness, ...(model === undefined ? {} : { model }) };
  });
}

// The types of P214's templates. A ticket's type is its first label among them, else other.
export const TICKET_TYPES: readonly TicketType[] = ['bug', 'review', 'ci', 'question', 'other'];

export function ticketType(labels: readonly string[]): TicketType {
  for (const label of labels) {
    const word = label.trim().toLowerCase();
    if (word !== 'other' && (TICKET_TYPES as readonly string[]).includes(word)) return word as TicketType;
  }
  return 'other';
}

// What the author of a variant in a pick is told besides the ticket and its place among the variants.
export function pickPrompt(testCommand: readonly string[] | undefined): string {
  if (!testCommand || testCommand.length === 0)
    return 'Each variant runs on its own agent. The service declares no test command, so the owner compares the variants and chooses one.';
  const command = testCommand.join(' ');
  return [
    'Each variant runs on its own agent. Once all have ended, the variant kept is the cheapest whose last run of the tests passed.',
    `Commit your change, then run \`${command}\` alone, not in a pipe or a list: a variant whose last run of it did not pass is not kept.`,
  ].join('\n');
}

export type PickEntry = {
  readonly position: number;
  readonly harness: Harness;
  readonly green: boolean;
  readonly tokens: number | null;                   // null when the harness reports none
  readonly workMs: number;
};

export type PickMeasure = 'tokens' | 'time';

// The variant kept, and by which measure; undefined when none is green.
export function pickWinner(entries: readonly PickEntry[]): { readonly position: number; readonly measure: PickMeasure } | undefined {
  const green = entries.filter((entry) => entry.green);
  if (green.length === 0) return undefined;
  const measure: PickMeasure = green.every((entry) => entry.tokens !== null && entry.tokens > 0) ? 'tokens' : 'time';
  const tokens = (entry: PickEntry) => entry.tokens ?? Number.POSITIVE_INFINITY;
  const sorted = [...green].sort((a, b) => (measure === 'tokens'
    ? tokens(a) - tokens(b) || a.workMs - b.workMs
    : a.workMs - b.workMs || tokens(a) - tokens(b)) || a.position - b.position);
  return { position: (sorted[0] as PickEntry).position, measure };
}

// The wins per ticket type and harness, over the picks that ended: a
// variant counts once it ran (a session started), whatever became of it;
// `green` the ones that committed a change and whose tests passed, `wins`
// the ones the pick kept (the owner's choice is not a win). In the types'
// order, then the harnesses'.
export function harnessWins(db: DatabaseSync, project: string): HarnessWins[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ticket_variants'").get()) return [];
  const columns = (db.prepare('PRAGMA table_info(ticket_variants)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('pick')) return [];
  const rows = db.prepare(`SELECT v.kind AS type, v.harness AS harness, COUNT(*) AS runs,
      SUM(CASE WHEN v.tests = 'passed' AND v.files <> '[]' THEN 1 ELSE 0 END) AS green, SUM(v.won) AS wins
    FROM ticket_variants v
    WHERE v.project = ? AND v.pick = 1 AND v.session IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ticket_variants o WHERE o.ticket = v.ticket AND o.round = v.round AND o.state IN ('waiting', 'running'))
    GROUP BY v.kind, v.harness`).all(project) as { type: string; harness: string; runs: number; green: number; wins: number }[];
  const order = (type: string) => TICKET_TYPES.indexOf(type as TicketType);
  return rows
    .map((row) => ({ type: row.type as TicketType, harness: row.harness as Harness, runs: Number(row.runs), green: Number(row.green), wins: Number(row.wins) }))
    .sort((a, b) => order(a.type) - order(b.type) || PICK_HARNESSES.indexOf(a.harness) - PICK_HARNESSES.indexOf(b.harness));
}
