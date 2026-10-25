#!/usr/bin/env node
// What moved since the last wake of the project lead, from what tracker and
// GitHub say now and what was seen before. No model: this is the pre-check
// that decides whether a session is worth starting.
//
//   wake.ts <previous state.json> <tracker changes.json> <github pulls.json> <agent ids.txt> <time read> [<lane reports.json> [<kinds worth a session> [down|up [<finished reviews.json> [<statuses watched> [<night runs.json>]]]]]]
//       down: GitHub is down, its pull requests are not read
//       <time read>: taken before tracker and GitHub were asked, so that
//       nothing created while they answered falls between two wakes
//       prints {events: [...], next: {...}}
//
// An event is something only the user or the outside world did: a comment or
// a ticket of the user, a pull request opened, made ready, merged or closed,
// its checks turning green or red. What agents wrote is never an event,
// with one exception: the report of a review the dispatcher ran, which is
// handed to the lead as it is (review_done).
//
// Not every event is worth a session: with a list of the kinds that are
// ([lead] wake_on), the others wait in the state and are handed to the next
// session that something else starts. Nothing is lost, and a draft opened or
// a ticket filed for later no longer starts a model that has nothing to decide.
import { readFileSync } from 'node:fs';
import { runAsCommand } from './conf.ts';

type Comment = { id: string; body?: string | null; createdAt: string; url?: string | null; agent?: boolean };
type Issue = { id: string; identifier?: string | null; title?: string | null; url?: string | null; state?: string | null; project?: unknown; description?: string | null;
  createdAt: string; updatedAt?: string | null; firstVisibleAt?: string; agent?: boolean; comments?: Comment[] };
type Check = { conclusion?: string | null; status?: string | null };
type Pull = { number: number; state: string; isDraft?: boolean; title?: string; headRefName?: string; updatedAt: string; statusCheckRollup?: Check[];
  changedFiles?: number; additions?: number; deletions?: number };
type LaneReport = { id: string; at: string; lane?: string; branch?: string; text?: string | null };
type Review = { id: string; at: string; pr?: number; ticket?: string; outcome?: string; commit?: string; text?: string | null };
type Night = { databaseId: number; status?: string | null; conclusion?: string | null; updatedAt: string; url?: string; headSha?: string };
type KnownPull = { state: string; checks: string; files?: number; additions?: number; deletions?: number };
type WakeEvent = { kind: string; at: string; checks?: string; [field: string]: unknown };
type WakeState = { at: string; seen?: string[]; pulls?: Record<string, KnownPull>; states?: Record<string, string>; waiting?: WakeEvent[] };

// What says "an agent wrote this". The first two are the marks tracker.ts puts;
// the third is the habit of the old project lead, kept while both run.
const AGENT_MARKS = [/^>\s*Écrit par un agent/, /^>\s*Ticket ouvert par un agent/, /^>\s*Written by an agent/, /^>\s*Ticket opened by an agent/, /^(?:Chef de projet|Project lead)\s*:/];
// And what the tracker itself says an agent wrote (its author is an
// application), when it can tell: no mark and no identifier needed then.
const byAgent = (text: string | null | undefined, id: string, agentIds: Set<string>, flagged: unknown = false) => flagged === true || agentIds.has(id) || AGENT_MARKS.some((mark) => mark.test((text ?? '').trimStart()));

const excerpt = (text: string | null | undefined, length = 600) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

// A text kept as it was written, line breaks included; only one out of all proportion is cut.
const whole = (text: string | null | undefined, length: number) => {
  const kept = (text ?? '').trim();
  return kept.length > length ? `${kept.slice(0, length)}…` : kept;
};

// One word for the checks of a pull request.
export function checksOf(rollup: Check[] = []): string {
  const states = rollup.map((check) => (check.conclusion || check.status || '').toUpperCase());
  if (states.some((state) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state))) return 'failure';
  if (states.some((state) => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING'].includes(state))) return 'pending';
  return states.includes('SUCCESS') ? 'success' : 'none';
}

// tracker is asked again for the last minutes before the previous wake: what
// was created in that margin and not seen yet still counts as new.
export const OVERLAP_MS = 10 * 60_000;
// What waits for a session is kept up to this many events, the oldest dropped.
export const WAITING_MAX = 40;
// A verdict is handed whole (the lead cannot read the report where it lies);
// only a text out of all proportion is cut.
export const REVIEW_MAX = 30_000;

export function changes(previous: WakeState | null, tracker: Issue[], pulls: Pull[], agentIds = new Set<string>(), now = new Date().toISOString(), reports: LaneReport[] = [], wakeOn: Set<string> | null = null,
  { githubDown = false, reviews = [], watchedStates = [], nights = [] }: { githubDown?: boolean; reviews?: Review[]; watchedStates?: string[]; nights?: Night[] } = {}) {
  // A state that cannot be read (no time of last wake) is no state: this
  // wake takes note of what exists, like the very first one.
  if (previous && Number.isNaN(Date.parse(previous.at))) previous = null;
  const first = !previous;
  // Newer than this is news. A ticket touched again brings its old comments
  // along: they were never seen here, and they are not news.
  // A Date minus a number is its time in milliseconds minus that number.
  const horizon = first ? null : new Date((new Date(previous!.at) as unknown as number) - OVERLAP_MS).toISOString();
  const seen = new Set(previous?.seen ?? []);
  const known: Record<string, KnownPull> = previous?.pulls ?? {};
  const events: WakeEvent[] = [];

  // The status of each ticket seen, to tell when one enters a status that
  // is watched (the user's agreement to a go-live). The agents the lead
  // runs with cannot change a status: such a move is the user's, or to be
  // refused by the script that checks who made it.
  const states: Record<string, string> = { ...(previous?.states ?? {}) };
  for (const issue of tracker) {
    const ticket = { ticket: issue.identifier, title: issue.title, url: issue.url, state: issue.state, project: issue.project };
    const newlyVisible = !seen.has(issue.id) && !first && (issue.firstVisibleAt as string) > horizon!;
    if (issue.state && states[issue.id] !== issue.state) {
      const entered = watchedStates.includes(issue.state) && !first && (issue.updatedAt ?? now) > horizon!;
      if (entered) events.push({ kind: 'ticket_moved', at: issue.updatedAt ?? now, ...ticket });
      states[issue.id] = issue.state;
    }
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      // A tracker may expose an older ticket only after its status is set.
      if (!first && (issue.createdAt > horizon! || newlyVisible) && !byAgent(issue.description, issue.id, agentIds, issue.agent)) {
        events.push({ kind: 'ticket_new', at: newlyVisible ? issue.firstVisibleAt! : issue.createdAt,
          ...ticket, text: excerpt(issue.description) });
      }
    }
    for (const comment of issue.comments ?? []) {
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      if (first || (comment.createdAt <= horizon! && !newlyVisible) || byAgent(comment.body, comment.id, agentIds, comment.agent)) continue;
      events.push({ kind: 'comment', at: newlyVisible && comment.createdAt <= horizon! ? issue.firstVisibleAt! : comment.createdAt,
        ...ticket, url: comment.url ?? issue.url, text: excerpt(comment.body) });
    }
  }

  // What a lane at work says to the lead: the last message of its terminal.
  // On the very first wake it is news too: a lane that waits is not left waiting.
  for (const report of reports) {
    if (seen.has(report.id)) continue;
    seen.add(report.id);
    events.push({ kind: 'lane_report', at: report.at, lane: report.lane, branch: report.branch, text: excerpt(report.text, 3000) });
  }

  // A review the dispatcher ran came to its end: what it says goes to the
  // lead. One that ended before the wake before is taken note of, not told.
  for (const review of reviews) {
    if (seen.has(review.id)) continue;
    seen.add(review.id);
    if (first || review.at <= horizon!) continue;
    events.push({ kind: 'review_done', at: review.at, pr: review.pr, ticket: review.ticket, outcome: review.outcome, commit: review.commit, text: whole(review.text, REVIEW_MAX) });
  }

  // The night checks: the runs the forge starts by itself on the base. A
  // green one is nobody's business: no event, nothing kept, nothing said. A
  // red one is worth a session (rule of the user, 2026-10-08). One that
  // somebody stopped is neither.
  for (const night of githubDown ? [] : nights) {
    if ((night.status ?? '').toLowerCase() !== 'completed') continue;
    const id = `night:${night.databaseId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (first || !['failure', 'timed_out', 'startup_failure'].includes((night.conclusion ?? '').toLowerCase())) continue;
    events.push({ kind: 'night_check_failed', at: night.updatedAt, run: night.databaseId, url: night.url, commit: night.headSha });
  }

  // While GitHub is down, what its pull requests seem to do (checks that it
  // cancelled itself) is no news, and nobody could act on it: they are
  // remembered as they were, and read again once it is back.
  const nextPulls: Record<string, KnownPull> = githubDown ? { ...known } : {};
  for (const pull of githubDown ? [] : pulls) {
    const state = pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : pull.isDraft ? 'draft' : 'ready';
    const checks = checksOf(pull.statusCheckRollup);
    const before = known[pull.number];
    // Kept for the app too (lib/board-collector.ts): what changed, as the same listing says it.
    const size = Object.fromEntries(([['files', pull.changedFiles], ['additions', pull.additions], ['deletions', pull.deletions]] as [string, number | undefined][]).filter(([, n]) => Number.isSafeInteger(n) && (n as number) >= 0));
    if (state === 'draft' || state === 'ready') nextPulls[pull.number] = { state, checks, ...size };
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
  // A pull request made ready with its checks already settled is as good as its checks turning.
  const worth = (event: WakeEvent) => !wakeOn || wakeOn.has(event.kind)
    || (event.kind === 'pr_ready' && wakeOn.has('pr_checks') && ['success', 'failure'].includes(event.checks as string));
  const all = [...(previous?.waiting ?? []), ...events];
  const start = events.some(worth);
  // The identifiers already seen are kept, the oldest dropped: tracker is only asked for the last hours.
  return { events: start ? all : [], next: { at: now, seen: [...seen].slice(-3000), pulls: nextPulls, states: Object.fromEntries(Object.entries(states).slice(-1500)), waiting: start ? [] : all.slice(-WAITING_MAX) } };
}

const read = (path: string | undefined, fallback: unknown) => {
  try { return JSON.parse(readFileSync(path as string, 'utf8')); } catch { return fallback; }
};

if (runAsCommand(import.meta.url)) {
  const [previousPath, trackerPath, pullsPath, agentPath, readAt, reportsPath, worthList, github, reviewsPath, watched, nightsPath] = process.argv.slice(2);
  const wakeOn = worthList?.trim() ? new Set(worthList.split(',').map((kind) => kind.trim()).filter(Boolean)) : null;
  const agentIds = new Set<string>();
  try { for (const line of readFileSync(agentPath as string, 'utf8').split('\n')) if (line.trim()) agentIds.add(line.trim()); } catch { /* none yet */ }
  const tracker = JSON.parse(readFileSync(trackerPath as string, 'utf8'));
  const pulls = JSON.parse(readFileSync(pullsPath as string, 'utf8'));
  process.stdout.write(`${JSON.stringify(changes(read(previousPath, null), tracker, pulls, agentIds, readAt || undefined, reportsPath ? read(reportsPath, []) : [], wakeOn, { githubDown: github === 'down', reviews: reviewsPath ? read(reviewsPath, []) : [], watchedStates: (watched ?? '').split(',').map((name) => name.trim()).filter(Boolean), nights: nightsPath ? read(nightsPath, []) : [] }))}\n`);
}
