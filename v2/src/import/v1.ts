// Reading a v1 ledger for the import (docs/v2/milestone-4-plan.md, section
// 3.3): the tickets v1 measured, as samples of the plans' estimates, and the
// decision files the owner approved. Never a write to v1's file or folder:
// SQLite opened read-only on a ledger in WAL mode still makes its -shm and
// -wal files beside it, so the ledger and its log are copied into a private
// temporary folder and read there, then the copy is removed.
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PlanItem } from '../api/types.ts';

type Size = PlanItem['size'];
type Lane = PlanItem['lane'];

export type V1Sample = {
  readonly ticket: string;
  readonly lane: Lane;
  readonly size: Size;
  readonly minutes: number;
  readonly tokens: number | null;           // its runs' tokens, said but not estimated from
  readonly lines: number | null;            // the lines its merged pull request changed
  readonly measuredAt: string;
};

export type V1Skip = { readonly ticket: string; readonly reason: 'no_size' | 'unreadable' };

// A decision file the owner approved in v1, its text as approved, and
// v1's record of the approval (null when v1 holds none).
export type V1Approval = { readonly id: string; readonly path: string; readonly content: string; readonly by: string | null; readonly at: string | null };

export type V1Data = {
  readonly measured: number;                // tickets with a ticket_measured event
  readonly samples: readonly V1Sample[];
  readonly skipped: readonly V1Skip[];
  readonly approvals: readonly V1Approval[];
  readonly handovers: number;               // not imported (section 3.3)
};

export class V1ImportError extends Error {
  override name = 'V1ImportError';
  readonly code: 'not_found' | 'not_v1' | 'same_file';
  readonly path: string;
  constructor(code: V1ImportError['code'], path: string) {
    super(`${code}: ${path}`);
    this.code = code;
    this.path = path;
  }
}

const SIZES: ReadonlySet<string> = new Set(['xs', 's', 'm', 'l']);
const byTicket = (a: { readonly ticket: string }, b: { readonly ticket: string }) => a.ticket.localeCompare(b.ticket, 'en', { numeric: true });

// v1 had no sizes: the lines a ticket's pull request changed stand for one.
export function sizeOfLines(lines: number): Size {
  if (lines <= 20) return 'xs';
  if (lines <= 100) return 's';
  if (lines <= 400) return 'm';
  return 'l';
}

export function readV1(path: string): V1Data {
  if (!existsSync(path) || !statSync(path).isFile()) throw new V1ImportError('not_found', path);
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v1-import-'));
  try {
    const copy = join(dir, 'ledger.db');
    copyFileSync(path, copy);
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(copy);
    } catch {
      throw new V1ImportError('not_v1', path);
    }
    try {
      return read(db, path);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function read(db: DatabaseSync, path: string): V1Data {
  let tables: Set<string>;
  try {
    tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  } catch {
    throw new V1ImportError('not_v1', path);
  }
  if (!tables.has('runs') || !tables.has('events')) throw new V1ImportError('not_v1', path);

  // Each ticket's last measure.
  const last = new Map<string, { at: string; detail: string | null }>();
  for (const row of db.prepare("SELECT at, ticket, detail FROM events WHERE kind = 'ticket_measured' AND ticket IS NOT NULL ORDER BY event_id").all() as { at: string; ticket: string; detail: string | null }[]) {
    const before = last.get(row.ticket);
    if (!before || !(Date.parse(row.at) < Date.parse(before.at))) last.set(row.ticket, row);
  }
  const runs = db.prepare('SELECT started_at, tokens_total, tokens_in, tokens_out, tokens_cache, tokens_cache_write, lines_changed, pr_number FROM runs WHERE ticket = ?');
  const label = tables.has('tracker_tickets') ? db.prepare('SELECT labels FROM tracker_tickets WHERE id = ?') : undefined;
  const samples: V1Sample[] = [];
  const skipped: V1Skip[] = [];
  for (const [ticket, measure] of last) {
    const detail = parse(measure.detail);
    const todo = Date.parse(String(detail?.todo_at));
    const done = Date.parse(String(detail?.done_at));
    if (!detail || !Number.isFinite(todo) || !Number.isFinite(done)) {
      skipped.push({ ticket, reason: 'unreadable' });
      continue;
    }
    const all = runs.all(ticket) as Record<string, unknown>[];
    const span = all.filter((run) => { const at = Date.parse(String(run.started_at)); return at >= todo && at <= done; });
    // From its first run, else from Todo, less the owner's answer; one decimal.
    const start = span.length ? Math.min(...span.map((run) => Date.parse(String(run.started_at)))) : todo;
    const wait = typeof detail.human_wait_min === 'number' ? detail.human_wait_min : 0;
    const minutes = Math.max(0, Math.round(((done - start) / 60_000 - wait) * 10) / 10);
    const lines = linesOf(all, Number(detail.pr));
    const size = sizeLabel(label, ticket) ?? (lines === null ? undefined : sizeOfLines(lines));
    if (!size) {
      skipped.push({ ticket, reason: 'no_size' });
      continue;
    }
    samples.push({ ticket, lane: detail.lane === 'fast' ? 'fast' : 'full', size, minutes, tokens: tokensOf(span), lines, measuredAt: measure.at });
  }
  return { measured: last.size, samples: samples.sort(byTicket), skipped: skipped.sort(byTicket), ...memory(db, tables) };
}

function parse(text: string | null): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text ?? '') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

// A `size:<s>` label on the ledger's own tracker ticket (LOCAL-<n>).
function sizeLabel(label: ReturnType<DatabaseSync['prepare']> | undefined, ticket: string): Size | undefined {
  const number = /^LOCAL-([1-9][0-9]*)$/.exec(ticket)?.[1];
  if (!label || !number) return undefined;
  const row = label.get(Number(number)) as { labels?: string } | undefined;
  let labels: unknown;
  try { labels = JSON.parse(row?.labels ?? '[]'); } catch { return undefined; }
  if (!Array.isArray(labels)) return undefined;
  const size = labels.find((l): l is string => typeof l === 'string' && l.startsWith('size:') && SIZES.has(l.slice(5)));
  return size?.slice(5) as Size | undefined;
}

// The lines of the measured pull request's last run that changed some,
// as v1's board reads them; any run's when the measure names no pull request.
function linesOf(runs: readonly Record<string, unknown>[], pr: number): number | null {
  const changed = runs
    .filter((run) => Number.isSafeInteger(run.lines_changed) && (run.lines_changed as number) > 0 && (!(pr > 0) || Number(run.pr_number) === pr))
    .sort((a, b) => Date.parse(String(a.started_at)) - Date.parse(String(b.started_at)));
  const lines = changed.at(-1)?.lines_changed;
  return typeof lines === 'number' ? lines : null;
}

// lib/ledger.mjs totalTokens, over the runs of the span.
function tokensOf(runs: readonly Record<string, unknown>[]): number | null {
  let total: number | null = null;
  for (const run of runs) {
    const parts = [run.tokens_in, run.tokens_out, run.tokens_cache, run.tokens_cache_write].filter((n): n is number => typeof n === 'number');
    const tokens = typeof run.tokens_total === 'number' ? run.tokens_total : parts.length ? parts.reduce((a, b) => a + b, 0) : null;
    if (tokens !== null) total = (total ?? 0) + tokens;
  }
  return total;
}

// The decision files lib/memory indexed and the owner approved, each with
// the last memory_approved event that names it.
function memory(db: DatabaseSync, tables: ReadonlySet<string>): Pick<V1Data, 'approvals' | 'handovers'> {
  if (!tables.has('memory_entries')) return { approvals: [], handovers: 0 };
  const records = new Map<string, { by: string; at: string }>();
  for (const row of db.prepare("SELECT at, detail FROM events WHERE kind = 'memory_approved' ORDER BY event_id").all() as { at: string; detail: string | null }[]) {
    const detail = parse(row.detail);
    if (typeof detail?.id === 'string' && typeof detail.by === 'string') records.set(detail.id, { by: detail.by, at: row.at });
  }
  const approvals = (db.prepare("SELECT id, content, source_where FROM memory_entries WHERE type = 'decision' AND source_who = 'script:file-index' AND status = 'approved'").all() as { id: string; content: string; source_where: string }[])
    .map((row) => ({ id: row.id, path: row.source_where, content: row.content, by: records.get(row.id)?.by ?? null, at: records.get(row.id)?.at ?? null }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const handovers = Number((db.prepare("SELECT count(*) AS n FROM memory_entries WHERE type = 'handover'").get() as { n: number }).n);
  return { approvals, handovers };
}
