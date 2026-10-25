// What the wake tries again by itself, with no model, as lib/common.sh's
// flush_outbox, open_queued_merges and close_tickets_left_open did
// (docs/v2/milestone-4-plan.md, step c): the comments the hourly limit held
// back, the go-lives that only waited, and the tickets a go-live could not
// close.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { agoUtc, confGet, confSoft, ledgerEvent, lockFile, ORCH_HOME, readJson, scratchDir, shownLeft, tracker, userMessage, writeWhole } from './script.ts';

const oneLine = (text: string, length: number): string => Array.from(text.replace(/\n/g, ' ')).slice(0, length).join('');

// The comments the hourly limit held back leave in one grouped comment on
// the ticket of the reports, as soon as the user may be written again.
// Nothing is removed before the tracker has it.
export function flushOutbox(state: string): void {
  const box = join(state, 'tracker-outbox');
  const md = (dir: string) => { try { return readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { return []; } };
  // What a wake killed while sending had taken aside comes back first.
  let entries: string[] = [];
  try { entries = readdirSync(box).sort(); } catch { return; }
  for (const left of entries.filter((name) => name.startsWith('sending.'))) {
    const dir = join(box, left);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of md(dir)) renameSync(join(dir, name), join(box, name));
    try { rmdirSync(dir); } catch { /* something else is in it */ }
  }
  const waiting = md(box);
  if (waiting.length === 0) return;
  // Taken aside first: a report that arrives while these are sent is not
  // among them, and stays for the next time.
  const sending = mkdtempSync(join(box, 'sending.'));
  for (const name of waiting) renameSync(join(box, name), join(sending, name));
  const grouped = scratchDir('cleared-grouped-');
  try {
    let text = `${userMessage('grouped_reports', { count: String(waiting.length) })}\n`;
    for (const name of waiting) text += `\n### ${name.replace(/--.*/s, '')}\n\n${readFileSync(join(sending, name), 'utf8')}`;
    const file = join(grouped.path, 'grouped.md');
    writeFileSync(file, text);
    const sent = tracker(['comment', confSoft('lead', 'report_on'), file, userMessage('grouped_sender')]);
    // Not sent: back where they were, for the next wake.
    if (sent.status !== 0) for (const name of md(sending)) renameSync(join(sending, name), join(box, name));
  } finally {
    grouped.remove();
    rmSync(sending, { recursive: true, force: true });
  }
}

// The go-lives merge-pr.ts could not do at once, tried again now, oldest
// first, one a wake (a merge takes the host for a while). No model: the same
// command, with every check again. One that is refused for good leaves the
// queue: written to the ledger (merge_refused).
export function openQueuedMerges(state: string): void {
  const queue = join(state, 'merge-queue');
  const hoursSetting = confSoft('merge', 'queue_hours');
  const hours = /^[0-9]+$/.test(hoursSetting) ? Number(hoursSetting) : 24;
  const attemptsSetting = confSoft('merge', 'queue_max_attempts');
  const maxAttempts = /^[1-9][0-9]*$/.test(attemptsSetting) ? Number(attemptsSetting) : 30;
  let names: string[];
  try { names = readdirSync(queue).filter((name) => name.endsWith('.json')); } catch { return; }
  if (names.length === 0) return;
  const at = (path: string) => { const entry = readJson<{ at?: unknown }>(path); return entry && entry.at !== null && entry.at !== undefined ? String(entry.at) : ''; };
  const ordered = names.map((name) => join(queue, name)).map((path) => [`${at(path)}\t${path}`, path] as const)
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([, path]) => path);
  for (const entry of ordered) {
    const record = readJson<{ pr?: unknown; ticket?: unknown; announcement?: unknown; attempts?: unknown; at?: unknown }>(entry);
    if (!record || typeof record.pr !== 'number' || typeof record.ticket !== 'string') {
      ledgerEvent({ kind: 'merge_refused', detail: `an entry of the queue of go-lives (${basename(entry)}) cannot be read: removed, the go-live is to be asked for again` });
      rmSync(entry, { force: true });
      continue;
    }
    const pr = String(record.pr);
    const ticket = record.ticket;
    const said = record.announcement === null || record.announcement === undefined || record.announcement === false ? '' : String(record.announcement);
    let code: number;
    let why: string;
    const env = { ...process.env, ORCH_FROM_QUEUE: '1' };
    if (process.env.ORCH_BROKER_SECRET) {
      // Test fixtures execute the old merge checks with a fixture-only key.
      const run = spawnSync(join(ORCH_HOME, 'merge-pr.ts'), [pr, ticket, ...(said ? [said] : [])], { env, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
      code = run.status ?? 1;
      why = (run.stderr ?? '').replace(/\n+$/, '');
    } else if (said && !readable(said)) {
      code = 69;
      why = `queued announcement cannot be read: ${said}`;
    } else {
      const run = spawnSync(join(ORCH_HOME, 'release-request.mjs'), ['request_release', ticket, pr], { env, encoding: 'utf8', input: said ? readFileSync(said) : '', stdio: ['pipe', 'ignore', 'pipe'] });
      code = run.status ?? 1;
      why = (run.stderr ?? '').replace(/\n+$/, '');
    }
    // A process crash can also exit 1. Only this broker marker makes it a
    // definitive refusal; otherwise it uses the bounded retry path.
    if (code === 1 && !why.startsWith('release broker definitive refusal\n')) code = 69;
    const leave = () => { rmSync(entry, { force: true }); rmSync(join(queue, `${pr}.announcement.md`), { force: true }); };
    if (code === 0) { leave(); return; }
    if (code === 1 || code === 6) {
      ledgerEvent({ kind: 'merge_refused', ticket, value: Number(pr), detail: `the go-live of #${pr} left the queue after a definitive broker refusal: ${oneLine(why, 400)}` });
      leave();
      continue;
    }
    const kept = record.attempts === null || record.attempts === undefined || record.attempts === false ? 0 : record.attempts;
    let attempts = /^[0-9]+$/.test(String(kept)) ? Number(kept) : 0;
    if (code !== 5) {
      attempts += 1;
      writeWhole(entry, `${JSON.stringify({ ...record, attempts }, null, 2)}\n`);
    }
    // Busy waits are bounded by age; other failures also have an attempt cap.
    const since = record.at === null || record.at === undefined ? '' : String(record.at);
    if (attempts >= maxAttempts || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(since) || since < agoUtc(hours * 3600_000)) {
      ledgerEvent({ kind: 'merge_refused', ticket, value: Number(pr), detail: `the go-live of #${pr} left the queue after ${attempts} failed attempts or ${hours} hours (${oneLine(why, 300)}): ask for it again` });
      leave();
    }
  }
}

const readable = (path: string): boolean => { try { readFileSync(path); return true; } catch { return false; } };

// A go-live was done, and its ticket could not be closed because GitHub did
// not say what became of another pull request shown on it (merge-pr.ts marks
// the record): asked again at each wake, with no model, under the lock of
// the go-lives since both write these records. Nothing is given up in
// silence: while that pull request is open or unknown, or while the tracker
// does not answer or has not written yet who moved the ticket, the mark stays
// and the next wake tries again. The ticket is closed only if it still is
// where the user put it himself; if it is not, it is left as it is, and said.
export function closeTicketsLeftOpen(state: string): void {
  const dir = join(state, 'validations');
  let records: string[];
  try { records = readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => join(dir, name)); } catch { return; }
  if (records.length === 0) return;
  const go = confGet('tracker', 'go_state');
  const lock = lockFile(join(state, 'merge.lock'), 0);
  if (!lock) return;
  try {
    for (const path of records) {
      const record = readJson<{ closing?: unknown; ticket?: unknown }>(path);
      if (record?.closing !== true) continue;
      const ticket = String(record.ticket ?? 'null');
      const left = shownLeft(path);
      if (left.open !== 0 || left.unknown !== 0) continue;
      const moved = tracker(['moved-by-owner', ticket, go]);
      if (moved.status === 0) {
        if (tracker(['move', ticket, confGet('tracker', 'done_state')]).status !== 0) continue;
      } else if (moved.status === 5 || moved.status === 6) {
        ledgerEvent({ kind: 'ticket_left_open', ticket, detail: `everything shown on ${ticket} is live or closed, but the ticket is no longer in « ${go} » by the user's own hand (he moved it, or someone else did): the wake leaves it as it is and closes nothing. Tell the user where the ticket stands` });
      } else continue;
      const now = readJson<Record<string, unknown>>(path) ?? {};
      delete now.closing;
      writeWhole(path, `${JSON.stringify(now, null, 2)}\n`);
    }
  } finally {
    lock.release();
  }
}

