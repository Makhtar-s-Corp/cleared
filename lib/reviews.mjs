#!/usr/bin/env node
// What the dispatcher knows of the reviews it ran, read from the ledger and
// from their reports, and who wrote a branch, read from the session log of
// its worktree. No model here: review-pr.sh and the wake decide with this.
//
//   reviews.mjs heads <pr>            the commits of that pull request already reviewed, oldest first (JSON)
//   reviews.mjs tries <pr> <commit>   how many reviews of that commit did not come to an end
//   reviews.mjs done <hours>          the reviews finished in the last hours, with what they say (JSON)
//   reviews.mjs author <worktree>     the model that wrote the last messages of the session of that worktree
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runAsCommand } from './conf.mjs';
import { openLedger } from './ledger.mjs';

// A report: its front matter, and what the reviewer wrote under « Compte rendu ».
export function readReport(text) {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const fields = {};
  for (const line of (head?.[1] ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const body = /## Compte rendu\n([\s\S]*?)(?:\n## Fichiers modifiés|$)/.exec(text)?.[1]?.trim() ?? '';
  return { commit: fields.commit ?? null, outcome: fields.outcome ?? null, ended_at: fields.ended_at ?? null, body };
}

const reportOf = (reports, runId) => {
  try { return readReport(readFileSync(join(reports, `${runId}.md`), 'utf8')); } catch { return null; }
};

// The reviews of the dispatcher for one pull request that went to their end, with the commit each one read.
// The commit comes from the report; when the report is lost, from what
// review-pr.sh wrote in the folder of the run when it opened it.
export function reviewedHeads(db, reports, pr) {
  const kept = (runId) => {
    try { return readFileSync(join(reports, '..', 'runs', runId.replace(/-review-a\d+$/, ''), 'reviewed-head'), 'utf8').trim() || null; } catch { return null; }
  };
  return db.prepare("SELECT run_id FROM runs WHERE role = 'review' AND source = 'dispatcher' AND outcome = 'done' AND pr_number = ? ORDER BY started_at").all(Number(pr))
    .map((row) => reportOf(reports, row.run_id)?.commit ?? kept(row.run_id)).filter(Boolean);
}

// How many reviews of that commit of that pull request did not come to an
// end (failed, or refused by a safeguard): the commit review-pr.sh wrote
// with each run tells which commit it was.
export function failedTries(db, reports, pr, head) {
  // One review is one folder of run, whatever the number of models it went
  // through; one that came to its end with a later model did not fail.
  const tries = new Map();
  for (const row of db.prepare("SELECT run_id, outcome FROM runs WHERE role = 'review' AND source = 'dispatcher' AND outcome IN ('failed', 'refused', 'done') AND pr_number = ?").all(Number(pr))) {
    const run = row.run_id.replace(/-review-a\d+$/, '');
    try { if (readFileSync(join(reports, '..', 'runs', run, 'reviewed-head'), 'utf8').trim() !== head) continue; } catch { continue; }
    tries.set(run, (tries.get(run) ?? false) || row.outcome === 'done');
  }
  return [...tries.values()].filter((ended) => !ended).length;
}

// Those that came to an end by themselves: one that was closed by hand has nothing to say.
export function finishedReviews(db, reports, hours = 6, now = Date.now()) {
  const since = new Date(now - hours * 3600e3).toISOString();
  // A review that left the queue without opening is told like one that ended: the lead asked for it.
  const dropped = db.prepare("SELECT event_id, at, ticket, detail FROM events WHERE kind = 'review_dropped' AND at >= ? ORDER BY at").all(since)
    .map((row) => ({ id: `review-dropped:${row.event_id}`, at: row.at, pr: Number(/#(\d+)/.exec(row.detail ?? '')?.[1] ?? 0) || null, ticket: row.ticket, outcome: 'dropped', commit: null, text: row.detail }));
  // So is a go-live that was asked for and left its queue without being done.
  // And a go-live done whose ticket could not be closed yet.
  const refused = db.prepare("SELECT event_id, kind, at, ticket, value, detail FROM events WHERE kind IN ('merge_refused', 'ticket_left_open', 'lane_stuck', 'lane_asks', 'self_update_refused', 'project_update_refused', 'subscription_stop', 'ticket_cost') AND at >= ? ORDER BY at").all(since)
    .map((row) => ({ id: `${row.kind.replace('_', '-')}:${row.event_id}`, at: row.at, pr: row.value ?? null, ticket: row.ticket, outcome: row.kind, commit: null, text: row.detail }));
  const ended = db.prepare("SELECT run_id, ticket, pr_number, outcome, ended_at FROM runs WHERE role = 'review' AND source = 'dispatcher' AND ended_at IS NOT NULL AND outcome IN ('done', 'failed', 'refused') AND ended_at >= ? ORDER BY ended_at").all(since)
    .map((row) => {
      const report = reportOf(reports, row.run_id);
      return { id: `review:${row.run_id}`, at: row.ended_at, pr: row.pr_number, ticket: row.ticket, outcome: row.outcome, commit: report?.commit ?? null, text: report?.body || '(sans compte rendu)' };
    });
  return [...ended, ...dropped, ...refused];
}

// The model of the last message the session of a worktree wrote itself.
export function authorModel(worktree, projects = join(homedir(), '.claude', 'projects')) {
  const dir = join(projects, worktree.replace(/[^A-Za-z0-9]/g, '-'));
  let logs;
  try { logs = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name)); } catch { return null; }
  if (!logs.length) return null;
  const latest = logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  let model = null;
  for (const line of readFileSync(latest, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'assistant' && !entry.isSidechain && entry.message?.model && entry.message.model !== '<synthetic>') model = entry.message.model;
  }
  return model;
}

if (runAsCommand(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  const reports = join(process.env.ORCH_STATE_DIR ?? '', 'reports');
  if (command === 'author') {
    process.stdout.write(`${authorModel(argument) ?? ''}\n`);
  } else {
    const db = openLedger(undefined, { readOnly: existsSync(join(process.env.ORCH_STATE_DIR ?? '', 'ledger.db')) });
    const out = command === 'heads' ? reviewedHeads(db, reports, argument) : command === 'tries' ? failedTries(db, reports, argument, process.argv[4]) : finishedReviews(db, reports, Number(argument) || 6);
    db.close();
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}
