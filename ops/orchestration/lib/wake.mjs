#!/usr/bin/env node
// What moved since the last wake of the project lead, from what Linear and
// GitHub say now and what was seen before. No model: this is the pre-check
// that decides whether a session is worth starting.
//
//   wake.mjs <previous state.json> <linear changes.json> <github pulls.json> <agent ids.txt> <time read> [<lane reports.json>]
//       <time read>: taken before Linear and GitHub were asked, so that
//       nothing created while they answered falls between two wakes
//       prints {events: [...], next: {...}}
//
// An event is something only the user or the outside world did: a comment or
// a ticket of the user, a pull request opened, made ready, merged or closed,
// its checks turning green or red. What agents wrote is never an event.
import { readFileSync } from 'node:fs';
import { runAsCommand } from './conf.mjs';

// What says "an agent wrote this". The first two are the marks linear.sh puts;
// the third is the habit of the old project lead, kept while both run.
const AGENT_MARKS = [/^>\s*Écrit par un agent/, /^>\s*Ticket ouvert par un agent/, /^Chef de projet\s*:/];
const byAgent = (text, id, agentIds) => agentIds.has(id) || AGENT_MARKS.some((mark) => mark.test((text ?? '').trimStart()));

const excerpt = (text, length = 600) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

// One word for the checks of a pull request.
export function checksOf(rollup = []) {
  const states = rollup.map((check) => (check.conclusion || check.status || '').toUpperCase());
  if (states.some((state) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state))) return 'failure';
  if (states.some((state) => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING'].includes(state))) return 'pending';
  return states.includes('SUCCESS') ? 'success' : 'none';
}

// Linear is asked again for the last minutes before the previous wake: what
// was created in that margin and not seen yet still counts as new.
export const OVERLAP_MS = 10 * 60_000;

export function changes(previous, linear, pulls, agentIds = new Set(), now = new Date().toISOString(), reports = []) {
  // A state that cannot be read (no time of last wake) is no state: this
  // wake takes note of what exists, like the very first one.
  if (previous && Number.isNaN(Date.parse(previous.at))) previous = null;
  const first = !previous;
  // Newer than this is news. A ticket touched again brings its old comments
  // along: they were never seen here, and they are not news.
  const horizon = first ? null : new Date(new Date(previous.at) - OVERLAP_MS).toISOString();
  const seen = new Set(previous?.seen ?? []);
  const known = previous?.pulls ?? {};
  const events = [];

  for (const issue of linear) {
    const ticket = { ticket: issue.identifier, title: issue.title, url: issue.url, state: issue.state, project: issue.project };
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      // A ticket met for the first time is new only if it was created since the last wake.
      if (!first && issue.createdAt > horizon && !byAgent(issue.description, issue.id, agentIds)) {
        events.push({ kind: 'ticket_new', at: issue.createdAt, ...ticket, text: excerpt(issue.description) });
      }
    }
    for (const comment of issue.comments ?? []) {
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      if (first || comment.createdAt <= horizon || byAgent(comment.body, comment.id, agentIds)) continue;
      events.push({ kind: 'comment', at: comment.createdAt, ...ticket, url: comment.url ?? issue.url, text: excerpt(comment.body) });
    }
  }

  // What a lane at work says to the lead: the last message of its terminal.
  // On the very first wake it is news too: a lane that waits is not left waiting.
  for (const report of reports) {
    if (seen.has(report.id)) continue;
    seen.add(report.id);
    events.push({ kind: 'lane_report', at: report.at, lane: report.lane, branch: report.branch, text: excerpt(report.text, 3000) });
  }

  const nextPulls = {};
  for (const pull of pulls) {
    const state = pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : pull.isDraft ? 'draft' : 'ready';
    const checks = checksOf(pull.statusCheckRollup);
    const before = known[pull.number];
    if (state === 'draft' || state === 'ready') nextPulls[pull.number] = { state, checks };
    if (first) continue;
    const what = { pr: pull.number, title: pull.title, branch: pull.headRefName, at: pull.updatedAt };
    if (!before) {
      // Not known before: only worth a word if it is open now (an old pull request closed long ago is not news).
      if (state === 'draft' || state === 'ready') events.push({ kind: state === 'ready' ? 'pr_ready' : 'pr_opened', ...what, checks });
      continue;
    }
    if (state === 'merged' || state === 'closed') events.push({ kind: `pr_${state}`, ...what });
    else if (before.state === 'draft' && state === 'ready') events.push({ kind: 'pr_ready', ...what, checks });
    else if (before.checks !== checks && (checks === 'success' || checks === 'failure')) events.push({ kind: 'pr_checks', ...what, checks });
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // The identifiers already seen are kept, the oldest dropped: Linear is only asked for the last hours.
  return { events, next: { at: now, seen: [...seen].slice(-3000), pulls: nextPulls } };
}

const read = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};

if (runAsCommand(import.meta.url)) {
  const [previousPath, linearPath, pullsPath, agentPath, readAt, reportsPath] = process.argv.slice(2);
  const agentIds = new Set();
  try { for (const line of readFileSync(agentPath, 'utf8').split('\n')) if (line.trim()) agentIds.add(line.trim()); } catch { /* none yet */ }
  const linear = JSON.parse(readFileSync(linearPath, 'utf8'));
  const pulls = JSON.parse(readFileSync(pullsPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(changes(read(previousPath, null), linear, pulls, agentIds, readAt || undefined, reportsPath ? read(reportsPath, []) : []))}\n`);
}
