// The pure parts of the milestone 2 proof (scripts/proof-j2.ts,
// docs/v2/milestone-2-plan.md, section 1): what changed between two readings
// of the state, the timeline the night watch keeps from them, the check of
// the planted commitments and of "3 after 2", the facts read from the
// ledger (notifications, the lead's turns and cost, each ticket's sessions),
// and the durations table the run writes. Lane 29 adds what the replanned
// milestone 2 shows: each session plan and its Go, the release cards'
// groups and flags, what the morning leaves to the owner, and for the
// multi-service proof (scripts/proof-j2-multi.ts) the trains, the fake's
// calls and step 11's terminal and editor, with their own table.
import type { DatabaseSync } from 'node:sqlite';
import type { LeadCommitment, LeadMessage } from '../src/api/types.ts';

// ---- one reading of the state ----------------------------------------------

export type Snapshot = {
  readonly at: string;
  readonly lead: { readonly generation: number; readonly phase: string; readonly percent: number | null; readonly highestPercent: number | null; readonly refreshCount: number; readonly openCommitments: number };
  readonly plan: { readonly id: string; readonly state: string; readonly items: readonly { readonly position: number; readonly title: string; readonly state: string; readonly ticket: string | null; readonly after: readonly number[] }[] } | null;
  readonly inbox: readonly { readonly id: string; readonly kind: string; readonly ticket: string }[];            // waiting items
  readonly sessions: readonly { readonly id: string; readonly ticket: string; readonly role: string; readonly phase: string }[];   // live, the lead's left out
  readonly notifications: number | null;                                                                            // notification_sent so far, when the ledger is read
};

// The lines the night watch prints and captures on: what differs from the last reading.
export function changes(prev: Snapshot | undefined, next: Snapshot): string[] {
  if (!prev) {
    const plan = next.plan ? `plan ${next.plan.state}, ${next.plan.items.map((i) => `${i.position}:${i.state}`).join(' ')}` : 'no plan';
    return [`first reading: lead generation ${next.lead.generation} (${next.lead.phase}), ${plan}, ${next.inbox.length} waiting in the inbox, ${next.sessions.length} live sessions`];
  }
  const lines: string[] = [];
  if (next.lead.generation !== prev.lead.generation) lines.push(`lead: generation ${prev.lead.generation} → ${next.lead.generation} (refresh ${next.lead.refreshCount})`);
  const round = (p: number | null) => (p === null ? null : Math.round(p));
  if (round(next.lead.percent) !== round(prev.lead.percent)) lines.push(`lead: context ${round(prev.lead.percent) ?? '?'} % → ${round(next.lead.percent) ?? '?'} %`);
  if (next.plan && prev.plan && next.plan.state !== prev.plan.state) lines.push(`plan: ${prev.plan.state} → ${next.plan.state}`);
  for (const item of next.plan?.items ?? []) {
    const before = prev.plan?.items.find((i) => i.position === item.position);
    if (before && before.state !== item.state) lines.push(`item ${item.position} (${item.ticket ?? before.ticket ?? 'no ticket'}): ${before.state} → ${item.state}`);
  }
  const ids = (list: readonly { readonly id: string }[]) => new Set(list.map((x) => x.id));
  const [inboxBefore, inboxNow] = [ids(prev.inbox), ids(next.inbox)];
  for (const item of next.inbox) if (!inboxBefore.has(item.id)) lines.push(`inbox: + ${item.kind} ${item.id} (${item.ticket})`);
  for (const item of prev.inbox) if (!inboxNow.has(item.id)) lines.push(`inbox: − ${item.kind} ${item.id} (${item.ticket})`);
  const [sessionsBefore, sessionsNow] = [ids(prev.sessions), ids(next.sessions)];
  for (const s of prev.sessions) if (!sessionsNow.has(s.id)) lines.push(`session: − ${s.role} ${s.id} (${s.ticket})`);
  for (const s of next.sessions) {
    if (!sessionsBefore.has(s.id)) { lines.push(`session: + ${s.role} ${s.id} (${s.ticket}) ${s.phase}`); continue; }
    const before = prev.sessions.find((x) => x.id === s.id);
    if (before && before.phase !== s.phase) lines.push(`session: ${s.id} (${s.ticket}) ${before.phase} → ${s.phase}`);
  }
  if (next.notifications !== prev.notifications) lines.push(`notifications: ${prev.notifications ?? '?'} → ${next.notifications ?? '?'}`);
  return lines;
}

// ---- the timeline ----------------------------------------------------------

export type ItemTimeline = { title: string; ticket: string | null; states: Record<string, string> };   // state → first seen at
export type Wait = { readonly kind: string; readonly ticket: string; readonly seenAt: string; goneAt: string | null };
export type Timeline = { items: Record<number, ItemTimeline>; waits: Record<string, Wait>; maxRunning: number };

export const newTimeline = (): Timeline => ({ items: {}, waits: {}, maxRunning: 0 });

// Adds one reading: the first time each item is seen in each state, each
// inbox item from when it was first seen to when it was gone, and the most
// items seen running at once.
export function track(timeline: Timeline, snap: Snapshot): Timeline {
  let running = 0;
  for (const item of snap.plan?.items ?? []) {
    const kept = timeline.items[item.position] ??= { title: item.title, ticket: null, states: {} };
    if (item.ticket) kept.ticket = item.ticket;
    kept.states[item.state] ??= snap.at;
    if (item.state === 'running') running++;
  }
  timeline.maxRunning = Math.max(timeline.maxRunning, running);
  const waiting = new Set(snap.inbox.map((i) => i.id));
  for (const item of snap.inbox) timeline.waits[item.id] ??= { kind: item.kind, ticket: item.ticket, seenAt: snap.at, goneAt: null };
  for (const [id, wait] of Object.entries(timeline.waits)) if (wait.goneAt === null && !waiting.has(id)) wait.goneAt = snap.at;
  return timeline;
}

export type Outcome = { readonly state: 'done' | 'open' | 'broken'; readonly note: string };

// "3 after 2" (planted commitment 3): item `item` starts only once item
// `after` landed. Read from the first time each was seen so.
export function orderCheck(timeline: Timeline, item: number, after: number): Outcome {
  const started = timeline.items[item]?.states.running;
  const landed = timeline.items[after]?.states.landed;
  if (!started) return { state: 'open', note: `item ${item} has not started${landed ? `; item ${after} landed at ${landed}` : ''}` };
  if (landed && Date.parse(started) >= Date.parse(landed)) return { state: 'done', note: `item ${item} started at ${started}, after item ${after} landed at ${landed}` };
  return { state: 'broken', note: `item ${item} started at ${started}, ${landed ? `before item ${after} landed at ${landed}` : `and item ${after} has not landed`}` };
}

// ---- the planted commitments -----------------------------------------------

// What the owner tells the lead in the evening (section 1, step 8; lane 11),
// and how a commitment the lead recorded for it is recognised: by its words,
// since the lead writes it in its own.
export const PLANTED = [
  { key: 'first_landing', text: 'When the first ticket lands, tell me how long it took from start to live.', match: /how long|start to live/i },
  { key: 'reminder', text: 'Tomorrow at 08:00, remind me to check the texts of the page.', match: /remind|08:00|texts? of the page/i },
] as const;

export type CommitmentOutcome = {
  readonly key: string; readonly planted: string; readonly state: 'done' | 'open' | 'lost' | 'not_recorded'; readonly ids: readonly string[];
  readonly due: string | null; readonly fulfilledAt: string | null; readonly note: string | null;
};

// `recorded` holds, per planted commitment, the ids the lead made in the
// turn that answered it (step 4): those are judged first, whatever their
// words; the words are the fallback, for a commitment made again later.
// Done when one is done, open when one is open; lost when the lead recorded
// one and holds it no more; not_recorded when it never recorded one.
export function commitmentOutcomes(commitments: readonly LeadCommitment[], recorded: Readonly<Record<string, readonly string[]>> = {}): CommitmentOutcome[] {
  return PLANTED.map((planted) => {
    const ids = recorded[planted.key] ?? [];
    const found = commitments.filter((c) => ids.includes(c.id) || planted.match.test(c.text));
    const done = found.find((c) => c.state === 'done');
    const kept = done ?? found[0];
    const missing = ids.length > 0 ? 'lost' : 'not_recorded';
    return {
      key: planted.key, planted: planted.text, state: done ? 'done' : found.length > 0 ? 'open' : missing, ids: found.map((c) => c.id),
      due: kept?.due ?? null, fulfilledAt: kept?.fulfilledAt ?? null, note: kept?.note ?? null,
    };
  });
}

// ---- the morning -----------------------------------------------------------

export type Morning = {
  readonly at: string;
  readonly waitingByKind: Record<string, number>;
  readonly itemsByState: Record<string, number>;
  readonly nightMessages: readonly { readonly at: string; readonly by: string; readonly text: string }[];
};

const count = (values: readonly string[]): Record<string, number> => values.reduce<Record<string, number>>((all, v) => ({ ...all, [v]: (all[v] ?? 0) + 1 }), {});

// Step 6: what waits at 08:00 by kind, the tickets by state, and the lead's
// thread over the night (its messages and the refresh lines).
export function morningSummary(snap: Snapshot, messages: readonly LeadMessage[], since: string): Morning {
  const from = Date.parse(since);
  const to = Date.parse(snap.at);
  return {
    at: snap.at,
    waitingByKind: count(snap.inbox.map((i) => i.kind)),
    itemsByState: count((snap.plan?.items ?? []).map((i) => i.state)),
    nightMessages: messages
      .filter((m) => m.by !== 'owner' && Date.parse(m.at) >= from && Date.parse(m.at) <= to)
      .map((m) => ({ at: m.at, by: m.by, text: m.kind === 'refresh' ? `generation ${m.generation ?? '?'} starts` : m.text })),
  };
}

// ---- the ledger ------------------------------------------------------------

// The status the Claude Code adapter gives a session whose runner waits for a
// new login after an authentication error (v2/src/session/adapters/claude-code/map.ts).
// The runner relaunches the session in the same container once the login
// file holds a new token (v2/images/session/runner/main.ts): its next turn
// starts. The owner chose this (plan question 1, option b); the proof counts each cut.
export const LOGIN_WAIT = 'Waiting for a new login';

// `ended`: the session ended without its next turn (a lead whose generation
// was replaced, a session stopped), so the cut was not relaunched.
export type LoginCut = { readonly session: string; readonly role: string; readonly ticket: string; readonly at: string; readonly relaunchedAt: string | null; readonly seconds: number | null; readonly ended: boolean };

export type LedgerFacts = {
  readonly notifications: { readonly count: number; readonly byKind: Record<string, number>; readonly firstAt: Record<string, string> };
  readonly lead: { readonly generations: number; readonly turns: number; readonly costUsd: number; readonly highestPercent: number | null; readonly compactions: number };
  // Each ticket from its first session's start to its last session's last
  // update, and when the release watch first saw it healthy (the row the
  // flow reads to call it landed, flow/ledger.ts).
  readonly tickets: Record<string, { readonly sessions: number; readonly reviewRounds: number; readonly costUsd: number; readonly startedAt: string; readonly lastAt: string; readonly landedAt: string | null }>;
  readonly maxLive: number;                                 // the most tickets in those spans at once
  readonly loginCuts: readonly LoginCut[];
};

type Row = Record<string, unknown>;
const cents = (n: number) => Math.round(n * 10_000) / 10_000;

function rows(db: DatabaseSync, sql: string, ...args: (string | number)[]): Row[] {
  try {
    return db.prepare(sql).all(...args) as Row[];
  } catch (error) {
    if (error instanceof Error && /no such table/.test(error.message)) return [];
    throw error;
  }
}

// The notifications sent since `since`: the one figure each reading of the
// night needs; the rest of the ledger is read once, at the end.
export function notificationCount(db: DatabaseSync, since: string): number {
  return Number(rows(db, "SELECT count(*) AS n FROM events WHERE kind = 'notification_sent' AND at >= ?", since)[0]?.n ?? 0);
}

// What the ledger says since `since` (the goal): read only, by the proof
// itself, to count what the screens do not show (brief rule 12).
export function ledgerFacts(db: DatabaseSync, since: string): LedgerFacts {
  const byKind: Record<string, number> = {};
  const firstAt: Record<string, string> = {};
  let sent = 0;
  for (const row of rows(db, "SELECT at, detail FROM events WHERE kind = 'notification_sent' AND at >= ? ORDER BY at", since)) {
    let kind = 'unknown';
    try { kind = String((JSON.parse(String(row.detail)) as { event?: unknown }).event ?? 'unknown'); } catch { /* an unreadable detail counts as unknown */ }
    sent++;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    firstAt[kind] ??= String(row.at);
  }
  // The run's sessions: those created since the goal, and the lead's that
  // were live after it. The lead's generation 1 starts with the service,
  // before the goal, and takes the whole evening (review 1 of PR 181, B1).
  const sessions = rows(db, "SELECT id, ticket, role, status, created_at, updated_at FROM sessions WHERE created_at >= ? OR (role = 'lead' AND id IN (SELECT DISTINCT session_id FROM session_events WHERE at >= ?)) ORDER BY created_at", since, since);
  const events = (types: string) => rows(db, `SELECT session_id, type, event FROM session_events WHERE at >= ? AND type IN (${types})`, since);
  const role = new Map(sessions.map((s) => [String(s.id), { ticket: String(s.ticket), role: String(s.role), status: String(s.status) }]));
  const lead = { generations: sessions.filter((s) => s.role === 'lead').length, turns: 0, costUsd: 0, highestPercent: null as number | null, compactions: 0 };
  const tickets: Record<string, { sessions: number; reviewRounds: number; costUsd: number; startedAt: string; lastAt: string; landedAt: string | null }> = {};
  for (const s of sessions) {
    if (s.role !== 'author' && s.role !== 'reviewer') continue;
    const t = tickets[String(s.ticket)] ??= { sessions: 0, reviewRounds: 0, costUsd: 0, startedAt: String(s.created_at), lastAt: String(s.updated_at), landedAt: null };
    t.sessions++;
    if (s.role === 'reviewer') t.reviewRounds++;
    if (String(s.updated_at) > t.lastAt) t.lastAt = String(s.updated_at);
  }
  for (const row of rows(db, "SELECT at, ticket FROM events WHERE kind IN ('release_watch_complete', 'release_health_unconfigured') AND at >= ? ORDER BY at", since)) {
    const t = tickets[String(row.ticket)];
    if (t && t.landedAt === null) t.landedAt = String(row.at);
  }
  // A sweep over the spans: +1 at a start, -1 at an end, a start first at the same time.
  const marks = Object.values(tickets).flatMap((t) => [{ at: Date.parse(t.startedAt), d: 1 }, { at: Date.parse(t.lastAt), d: -1 }]).sort((a, b) => a.at - b.at || b.d - a.d);
  let live = 0;
  let maxLive = 0;
  for (const mark of marks) maxLive = Math.max(maxLive, (live += mark.d));
  for (const row of events("'RUN_FINISHED', 'CUSTOM'")) {
    const of = role.get(String(row.session_id));
    if (!of) continue;
    const event = JSON.parse(String(row.event)) as { type: string; name?: string; value?: { percent?: number }; result?: { total_cost_usd?: number | null } };
    if (event.type === 'RUN_FINISHED') {
      const cost = event.result?.total_cost_usd ?? 0;
      if (of.role === 'lead') { lead.turns++; lead.costUsd += cost; }
      else if (tickets[of.ticket]) (tickets[of.ticket] as { costUsd: number }).costUsd += cost;
    } else if (of.role === 'lead' && event.name === 'cleared.context_usage' && typeof event.value?.percent === 'number') {
      lead.highestPercent = Math.max(lead.highestPercent ?? 0, event.value.percent);
    } else if (of.role === 'lead' && event.name === 'cleared.compacted') lead.compactions++;
  }
  lead.costUsd = cents(lead.costUsd);
  for (const t of Object.values(tickets)) t.costUsd = cents(t.costUsd);
  // Each login cut: from the first "waiting for a new login" to the session's next turn.
  const loginCuts: LoginCut[] = [];
  const open = new Map<string, number>();                   // session → index of its open cut
  for (const row of rows(db, "SELECT session_id, at, type, event FROM session_events WHERE at >= ? AND type IN ('STATE_DELTA', 'STATE_SNAPSHOT', 'RUN_STARTED') ORDER BY at, seq", since)) {
    const id = String(row.session_id);
    const of = role.get(id) ?? { ticket: '', role: 'unknown', status: '' };
    if (row.type === 'RUN_STARTED') {
      const index = open.get(id);
      if (index === undefined) continue;
      const cut = loginCuts[index] as LoginCut;
      loginCuts[index] = { ...cut, relaunchedAt: String(row.at), seconds: Math.round((Date.parse(String(row.at)) - Date.parse(cut.at)) / 1000) };
      open.delete(id);
    } else if (String(row.event).includes(LOGIN_WAIT) && !open.has(id)) {
      open.set(id, loginCuts.length);
      loginCuts.push({ session: id, role: of.role, ticket: of.ticket, at: String(row.at), relaunchedAt: null, seconds: null, ended: ['done', 'stopped', 'failed'].includes(of.status) });
    }
  }
  return { notifications: { count: sent, byKind, firstAt }, lead, tickets, maxLive, loginCuts };
}

// The highest context share the run reached: the ledger's (every generation
// live after the goal) and the lead's own record (lead_generations), the
// larger of the two, so neither hides a higher one.
export function highestShare(ledger: number | null | undefined, lead: number | null | undefined): number | null {
  const known = [ledger, lead].filter((n): n is number => typeof n === 'number');
  return known.length > 0 ? Math.max(...known) : null;
}

// ---- lane 29: the session plans, the cards, the trains, step 11 -------------

// The skipped notification step's note (plan section 2.1, the owner's
// answer to question 2 of the replan).
export const NOTIFICATIONS_SKIPPED_NOTE = 'skipped: no Mac notifications in this proof (owner decision)';

// A session plan as the gate kept it (decision 22): the last
// `cleared.session_plan` event of its session, whose `go` says who started
// it and when; `heldSeconds` from the proposal to the Go.
export type SessionPlanFact = {
  readonly session: string; readonly ticket: string; readonly service: string | null; readonly confidence: string; readonly proposedAt: string;
  readonly go: { readonly by: string; readonly at: string } | null; readonly heldSeconds: number | null;
};

export function sessionPlanFacts(db: DatabaseSync, since: string): SessionPlanFact[] {
  const plans = new Map<string, SessionPlanFact>();
  for (const r of rows(db, "SELECT e.session_id, e.event, s.ticket, s.service FROM session_events e JOIN sessions s ON s.id = e.session_id WHERE e.at >= ? AND e.type = 'CUSTOM' ORDER BY e.at, e.seq", since)) {
    const event = JSON.parse(String(r.event)) as { name?: string; value?: { confidence?: string; proposedAt?: string; go?: { by: string; at: string } | null } };
    if (event.name !== 'cleared.session_plan' || !event.value) continue;
    const { confidence = '?', proposedAt = '', go = null } = event.value;
    const session = String(r.session_id);
    const held = go ? Math.round((Date.parse(go.at) - Date.parse(proposedAt)) / 1000) : null;
    // Map keeps the first insertion's place: a session stays where its first proposal put it.
    plans.set(session, { session, ticket: String(r.ticket), service: r.service === null || r.service === undefined ? null : String(r.service), confidence, proposedAt, go: go ? { by: go.by, at: go.at } : null, heldSeconds: held !== null && Number.isFinite(held) ? held : null });
  }
  return [...plans.values()];
}

// A release card as the morning approved it (step 7): its intent groups
// with their file counts and its flags, from the item; what the screen
// showed of them, counted on the card.
export type ReleaseCard = {
  readonly ticket: string; readonly item: string; readonly at: string;
  readonly groups: readonly { readonly intent: string; readonly files: number }[]; readonly flags: readonly string[];
  readonly shown: { readonly groups: number; readonly flags: number };
};

// A train as the ledger keeps it (release_trains, decision 21): each
// service in landing order; the gap from the first service's healthy
// verdict to the next one's merge; the services reverted, oldest revert first.
export type TrainFact = {
  readonly ticket: string; readonly item: string; readonly state: string; readonly compatibility: string | null;
  readonly blocked: { readonly reason: string; readonly proposal: string } | null;
  readonly stops: readonly { readonly service: string; readonly pr: number; readonly state: string; readonly mergedAt: string | null; readonly at: string | null; readonly note: string | null }[];
  readonly gapSeconds: number | null;
  readonly revertOrder: readonly string[];
};

export function trainFacts(db: DatabaseSync): TrainFact[] {
  return rows(db, 'SELECT * FROM release_trains ORDER BY created_at, rowid').map((r) => {
    type Stop = { service: string; pr: { number: number }; state: string; mergedAt: string | null; at: string | null; note: string | null };
    const stops = (JSON.parse(String(r.stops)) as Stop[]).map((stop) => ({ service: stop.service, pr: stop.pr.number, state: stop.state, mergedAt: stop.mergedAt, at: stop.at, note: stop.note }));
    const [first, second] = stops;
    const gap = first?.state === 'healthy' && first.at && second?.mergedAt ? Math.round((Date.parse(second.mergedAt) - Date.parse(first.at)) / 1000) : null;
    const reverted = stops.filter((stop) => stop.state === 'reverted' && stop.at).sort((a, b) => Date.parse(a.at as string) - Date.parse(b.at as string));
    return {
      ticket: String(r.ticket), item: String(r.item), state: String(r.state), compatibility: r.compatibility === null ? null : String(r.compatibility),
      blocked: r.blocked === null ? null : JSON.parse(String(r.blocked)) as TrainFact['blocked'], stops, gapSeconds: gap, revertOrder: reverted.map((stop) => stop.service),
    };
  });
}

// Step 11 as the session's journal holds it (decisions 32 and 33): the
// terminal opened, the lines typed (each one journaled, never the
// output), its close, the human's edits, and the session's first turn
// after Give back, which carries the notice.
export type HumanFacts = {
  readonly openedAt: string | null; readonly lines: number;
  readonly closed: { readonly at: string; readonly reason: string; readonly outputBytes: number } | null;
  readonly edits: readonly { readonly path: string; readonly via: string; readonly added: number; readonly removed: number; readonly at: string }[];
  readonly noticeTurnAt: string | null;
};

export function humanFacts(db: DatabaseSync, session: string, givenBackAt: string | null): HumanFacts {
  let openedAt: string | null = null;
  let lines = 0;
  let closed: HumanFacts['closed'] = null;
  let noticeTurnAt: string | null = null;
  const edits: HumanFacts['edits'][number][] = [];
  for (const r of rows(db, "SELECT at, type, event FROM session_events WHERE session_id = ? AND type IN ('CUSTOM', 'RUN_STARTED') ORDER BY at, seq", session)) {
    const at = String(r.at);
    if (r.type === 'RUN_STARTED') {
      if (givenBackAt && noticeTurnAt === null && Date.parse(at) >= Date.parse(givenBackAt)) noticeTurnAt = at;
      continue;
    }
    const event = JSON.parse(String(r.event)) as { name?: string; value?: Record<string, unknown> };
    const value = event.value ?? {};
    if (event.name === 'cleared.terminal_opened') openedAt ??= at;
    else if (event.name === 'cleared.terminal_input') lines++;
    else if (event.name === 'cleared.terminal_closed') closed = { at, reason: String(value.reason), outputBytes: Number(value.outputBytes ?? 0) };
    else if (event.name === 'cleared.human_edit') edits.push({ path: String(value.path), via: String(value.via), added: Number(value.added ?? 0), removed: Number(value.removed ?? 0), at });
  }
  return { openedAt, lines, closed, edits, noticeTurnAt };
}

// The multi-service proof's result (scripts/proof-j2-multi.ts, section 2.2).
export type MultiResult = {
  readonly mode: 'real' | 'rehearsal';
  readonly app: string;
  readonly startedAt: string;
  readonly steps: readonly Step[];
  readonly times: Record<string, string>;                   // ticket_created_at, steps_proposed_at, contract_shown_at, contract_validated_at, ...
  readonly tickets: Record<number, string>;                 // the proof's ticket 1 to 4, by id
  readonly ticketSteps: Record<string, readonly { readonly position: number; readonly kind: string; readonly service: string; readonly state: string; readonly costUsd: number | null; readonly minutes: number | null }[]>;
  readonly trains: readonly TrainFact[];
  readonly fake: { readonly calls: number; readonly operations: Record<string, number> } | null;
  readonly human: HumanFacts | null;
  readonly saves: readonly { readonly at: string; readonly status: number; readonly kept: boolean | null }[];
  readonly sessionPlans: readonly SessionPlanFact[];
  readonly gestures: readonly { readonly at: string; readonly what: string }[];
  readonly stand_ins: readonly string[];
  readonly proposal: string | null;                         // the blocked card's proposal (step 10)
  // The questions the sessions of the proof's tickets asked, and what the proof chose (proof-inbox.ts, chooseAnswers).
  readonly questions: readonly AnsweredQuestion[];
  // The permissions the sessions of the proof's tickets asked, and how the proof answered (proof-inbox.ts, permissionAnswer).
  readonly permissions: readonly AnsweredPermission[];
  // The clean base the run started from (proof-base.ts), when it reset one.
  readonly base: BaseReport | null;
};

export type AnsweredQuestion = {
  readonly at: string;
  readonly ticket: string;
  readonly session: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string;
  readonly how: 'recommended' | 'first' | 'free';
};

// `role` and `service` are null when the proof could not read the session;
// `command` is cut to PERMISSION_COMMAND_LIMIT, and null for a request that
// is not a command.
export type AnsweredPermission = {
  readonly at: string;
  readonly ticket: string;
  readonly session: string;
  readonly role: string | null;
  readonly service: string | null;
  readonly command: string | null;
  readonly answer: 'allow_once' | 'reject_once';
  readonly rule: 'check' | 'checkout' | 'outside' | 'not_a_command';
};
export const PERMISSION_COMMAND_LIMIT = 160;

export type BaseReport = {
  readonly frozen: string;                                  // the frozen base branch, only ever read
  readonly run: string;                                     // the run branch, recreated from it
  readonly repos: readonly { readonly service: string; readonly commit: string; readonly closed: readonly number[] }[];
  readonly setAside: readonly string[];                     // the earlier runs' tickets put back to a clean state
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function questionLines(questions: readonly AnsweredQuestion[]): string[] {
  const out = ['## Session questions', ''];
  if (questions.length === 0) return [...out, 'No session of the proof\'s tickets asked a question.', ''];
  out.push(row('At', 'Ticket', 'Session', 'Question', 'Options', 'Answer', 'Chosen as'), row('---', '---', '---', '---', '---', '---', '---'));
  for (const q of questions) out.push(row(q.at, q.ticket, q.session.slice(0, 8), q.question, q.options.join(' / ') || 'none', q.answer, q.how));
  return [...out, ''];
}

function permissionLines(permissions: readonly AnsweredPermission[]): string[] {
  const out = ['## Session permissions', ''];
  if (permissions.length === 0) return [...out, 'No session of the proof\'s tickets asked a permission.', ''];
  out.push(row('At', 'Ticket', 'Session', 'Role', 'Service', 'Command', 'Answer', 'Rule'), row('---', '---', '---', '---', '---', '---', '---', '---'));
  for (const p of permissions) out.push(row(p.at, p.ticket, p.session.slice(0, 8), p.role ?? 'unknown', p.service ?? 'unknown', p.command ?? 'not a command', p.answer, p.rule));
  const checks = permissions.filter((p) => p.rule === 'check').length;
  return [...out, '', `${plural(checks, 'declared check')} allowed once; ${plural(permissions.length - checks, 'other request')} answered by the checkout rule.`, ''];
}

function baseLines(base: BaseReport | null): string[] {
  const out = ['## The clean base', ''];
  if (!base) return [...out, 'The run did not reset a base: it ran on the services\' branches as it found them.', ''];
  out.push(`Each run branch \`${base.run}\` was recreated from the frozen \`${base.frozen}\`.`, '', row('Service', 'Commit', 'Pull requests of earlier runs closed'), row('---', '---', '---'));
  for (const r of base.repos) out.push(row(r.service, r.commit.slice(0, 12), r.closed.map((n) => `#${n}`).join(', ') || 'none'));
  out.push('', `Earlier runs' tickets put back to a clean state: ${base.setAside.join(', ') || 'none'}.`, '');
  return out;
}

function sessionPlanLines(plans: readonly SessionPlanFact[]): string[] {
  const out = ['## Session plans', ''];
  if (plans.length === 0) return [...out, 'No session plan was read: the ledger was not read, or no author proposed one.', ''];
  out.push(row('Ticket', 'Session', 'Confidence', 'Go by', 'Go at', 'Held'), row('---', '---', '---', '---', '---', '---'));
  for (const p of plans) out.push(row(p.ticket, p.session, p.confidence, p.go?.by ?? 'no Go', p.go?.at ?? '', p.heldSeconds === null ? '' : seconds(p.heldSeconds)));
  return [...out, ''];
}

const seconds = (n: number): string => duration(new Date(0).toISOString(), new Date(n * 1000).toISOString());

function stopText(stop: TrainFact['stops'][number]): string {
  const parts = [stop.mergedAt ? `merged ${stop.mergedAt}` : null, stop.state === 'waiting' && !stop.mergedAt ? 'not landed' : stop.state === 'merged' ? null : `${stop.state}${stop.at ? ` ${stop.at}` : ''}`];
  return `${stop.service} #${stop.pr}: ${parts.filter(Boolean).join(', ')}`;
}

export function renderMultiDurations(r: MultiResult): string {
  const t = r.times;
  const steps = Object.entries(r.ticketSteps).flatMap(([ticket, list]) => list.map((s) => row(ticket, s.position, s.kind, s.service, s.state, dollars(s.costUsd), s.minutes === null ? '' : `${Math.round(s.minutes * 10) / 10} min`)));
  const saves = (status: (n: number) => boolean) => r.saves.filter((s) => status(s.status)).length;
  const out: string[] = [
    `# Milestone 2 multi-service proof: durations (${r.mode})`,
    '',
    `Run from ${r.startedAt} against ${r.app}. The proof's tickets: ${Object.entries(r.tickets).map(([n, id]) => `${n} ${id}`).join(', ') || 'none created'}.`,
    '',
    '## Steps',
    '',
    row('Step', 'Name', 'Status', 'Seen at', 'Note'),
    row('---', '---', '---', '---', '---'),
    ...r.steps.map((s) => row(s.n, s.name, s.status, s.seenAt, s.note)),
    '',
    '## Measured',
    '',
    row('Between', 'Time'),
    row('---', '---'),
    row('ticket created → steps proposed', duration(t.ticket_created_at, t.steps_proposed_at)),
    row('contract shown → validated', duration(t.contract_shown_at, t.contract_validated_at)),
    row('contract validated → fake\'s first answer', duration(t.contract_validated_at, t.fake_first_answer_at)),
    row('release approved → first merge', duration(t.approved_at, r.trains[0]?.stops[0]?.mergedAt)),
    row('second approval → first failing probe', duration(t.second_approved_at, t.first_failing_at)),
    row('block shown at', t.block_shown_at ?? 'not seen'),
    '',
    '## The steps of each ticket',
    '',
    row('Ticket', 'Step', 'Kind', 'Service', 'State', 'Cost', 'Time'),
    row('---', '---', '---', '---', '---', '---', '---'),
    ...steps,
    '',
    '## The trains',
    '',
    row('Ticket', 'State', 'Services in landing order', 'Gap between the landings'),
    row('---', '---', '---', '---'),
    ...r.trains.map((train) => row(train.ticket, train.state, train.stops.map(stopText).join('; '), train.gapSeconds === null ? '' : seconds(train.gapSeconds))),
    '',
    ...r.trains.filter((train) => train.revertOrder.length > 0).map((train) => `${train.ticket} was rolled back in this order: ${train.revertOrder.join(', then ')}.`),
    ...r.trains.filter((train) => train.blocked).map((train) => `${train.ticket} was blocked before approval: ${train.blocked?.reason ?? ''}`),
    ...(r.proposal ? [`The proposal shown: ${r.proposal}`] : []),
    '',
    '## The fake of the trial environment',
    '',
    r.fake ? `The fake answered ${plural(r.fake.calls, 'call')}${Object.keys(r.fake.operations).length ? ` (${Object.entries(r.fake.operations).map(([op, n]) => `${op} ${n}`).join(', ')})` : ''}; its first answer at ${t.fake_first_answer_at ?? 'not seen'}.` : 'The fake\'s calls were not read.',
    '',
    '## Step 11: take over, type, save, give back',
    '',
    row('Between', 'Time'),
    row('---', '---'),
    row('take over → terminal open', duration(t.take_over_at, t.terminal_open_at)),
    row('terminal open → save', duration(t.terminal_open_at, t.save_at)),
    row('save → give back', duration(t.save_at, t.give_back_at)),
    row('give back → the notice\'s turn', duration(t.give_back_at, r.human?.noticeTurnAt)),
    row('lines typed, journaled', r.human ? r.human.lines : 'not read'),
    row('terminal closed', r.human?.closed ? `${r.human.closed.reason}, ${r.human.closed.outputBytes} bytes of output (never stored)` : 'not seen'),
    '',
    row('File', 'Via', 'Lines'),
    row('---', '---', '---'),
    ...(r.human?.edits ?? []).map((e) => row(e.path, e.via, `+${e.added} -${e.removed}`)),
    '',
    `saves: ${r.saves.length}, answered 200: ${saves((n) => n === 200)}, 409: ${saves((n) => n === 409)}, refused: ${saves((n) => n !== 200 && n !== 409)}; kept after Give back: ${r.saves.filter((s) => s.kept === true).length}`,
    '',
    ...sessionPlanLines(r.sessionPlans),
    ...questionLines(r.questions),
    ...permissionLines(r.permissions),
    ...baseLines(r.base),
    '## The owner',
    '',
    row('Measure', 'Value'),
    row('---', '---'),
    row('owner gestures', r.gestures.length),
    '',
    ...r.gestures.map((g) => `- ${g.at}: ${cell(g.what)}`),
  ];
  if (r.stand_ins.length > 0) {
    out.push('', '## What the rehearsal replaced', '', 'These were stand-ins, so the rehearsal does not prove them:', '');
    for (const s of r.stand_ins) out.push(`- ${s}`);
  }
  return `${out.join('\n')}\n`;
}

// ---- the result and its table ---------------------------------------------

export type Step = { readonly n: number; readonly name: string; readonly status: 'ok' | 'failed' | 'skipped'; readonly seenAt: string; readonly note: string; readonly capture?: string };

export type ProofResult = {
  readonly mode: 'real' | 'rehearsal';
  readonly app: string;
  readonly goal: string;
  readonly startedAt: string;
  readonly steps: readonly Step[];
  readonly times: Record<string, string>;                   // goal_sent_at, first_question_at, plan_proposed_at, approved_at, first_start_at, morning_at, ...
  readonly answers: readonly { readonly at: string; readonly text: string }[];
  readonly plan: { readonly id: string; readonly title: string; readonly items: readonly { readonly position: number; readonly title: string; readonly lane: string; readonly after: readonly number[]; readonly minutes: number; readonly costUsd: number }[]; readonly totals: { readonly minutes: number; readonly costUsd: number; readonly samples: number } } | null;
  readonly items: Record<number, ItemTimeline>;
  readonly maxRunning: number;
  readonly waits: Record<string, Wait>;
  readonly morning: Morning | null;
  readonly lead: { readonly refreshCount: number; readonly highestPercent: number | null; readonly threshold: number | null; readonly generations: number | null; readonly turns: number | null; readonly costUsd: number | null; readonly compactions: number | null };
  readonly commitments: readonly CommitmentOutcome[];
  readonly order: Outcome;
  readonly notifications: LedgerFacts['notifications'] | null;
  readonly tickets: LedgerFacts['tickets'];
  readonly gestures: readonly { readonly at: string; readonly what: string }[];
  readonly planDoneAt: string | null;
  readonly stand_ins: readonly string[];                   // what the rehearsal replaced, and so does not prove
  readonly notificationsSkipped: string | null;            // why the notifications were not part of the run, when they were not
  readonly loginCuts: readonly LoginCut[] | null;          // null: the ledger was not read
  readonly sessionPlans: readonly SessionPlanFact[];       // read from the ledger: empty when it was not
  readonly cards: readonly ReleaseCard[];                  // each release card the morning approved, as it was shown
  readonly leftForOwner: { readonly knowledge: number; readonly contract: number };
};

export function duration(from: string | undefined | null, to: string | undefined | null): string {
  if (!from || !to) return 'not seen';
  const seconds = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!Number.isFinite(seconds)) return 'not seen';
  if (seconds < 0) return `-${duration(to, from)}`;
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
}

const cell = (text: unknown) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const row = (...cells: unknown[]) => `| ${cells.map(cell).join(' | ')} |`;
const dollars = (n: number | null | undefined) => (n === null || n === undefined ? 'not read' : `$${n.toFixed(2)}`);

export function renderDurations(r: ProofResult): string {
  const t = r.times;
  const lastAnswer = r.answers.at(-1)?.at;
  const out: string[] = [
    `# Milestone 2 proof: durations (${r.mode})`,
    '',
    `Run from ${r.startedAt} against ${r.app}. Goal: ${r.goal}`,
    '',
    '## Steps',
    '',
    row('Step', 'Name', 'Status', 'Seen at', 'Note'),
    row('---', '---', '---', '---', '---'),
    ...r.steps.map((s) => row(s.n, s.name, s.status, s.seenAt, s.note)),
    '',
    '## Measured',
    '',
    row('Between', 'Time'),
    row('---', '---'),
    row('goal sent → first question', duration(t.goal_sent_at, t.first_question_at)),
    row('last answer → plan proposed', duration(lastAnswer, t.plan_proposed_at)),
    ...(r.notificationsSkipped ? [] : [row('plan proposed → plan notification sent', duration(t.plan_proposed_at, r.notifications?.firstAt.plan))]),
    row('plan proposed → approved', duration(t.plan_proposed_at, t.approved_at)),
    row('approved → first session start', duration(t.approved_at, t.first_start_at)),
    row('goal sent → plan done', r.planDoneAt ? duration(t.goal_sent_at, r.planDoneAt) : 'the plan is not done'),
    '',
    `Questions asked: ${r.answers.length}. Most plan items running at once: ${r.maxRunning}.`,
    '',
    '## Plan items',
    '',
    row('Item', 'Title', 'Ticket', 'Started', 'Needs approval', 'Landed', 'Put back'),
    row('---', '---', '---', '---', '---', '---', '---'),
    ...Object.entries(r.items).map(([n, i]) => row(n, i.title, i.ticket ?? '', i.states.running ?? '', i.states.needs_approval ?? '', i.states.landed ?? '', i.states.put_back ?? i.states.held ?? '')),
    '',
    '## The lead',
    '',
    row('Measure', 'Value'),
    row('---', '---'),
    row('refreshes', r.lead.refreshCount),
    row('highest context share', `${r.lead.highestPercent ?? 'not read'} %${r.lead.threshold !== null ? ` (threshold ${r.lead.threshold} %)` : ''}`),
    row('generations live after the goal', r.lead.generations ?? 'not read'),
    row('turns', r.lead.turns ?? 'not read'),
    row('cost', dollars(r.lead.costUsd)),
    row('compactions by Claude Code', r.lead.compactions ?? 'not read'),
    '',
    '## Commitments',
    '',
    row('Planted', 'Outcome', 'Ids', 'Due', 'Fulfilled at', 'Note'),
    row('---', '---', '---', '---', '---', '---'),
    ...r.commitments.map((c) => row(c.key, c.state, c.ids.join(', '), c.due ?? '', c.fulfilledAt ?? '', c.note ?? '')),
    row('"3 after 2"', r.order.state, '', '', '', r.order.note),
    '',
    '## Notifications',
    '',
    r.notificationsSkipped
      ? `Skipped: ${r.notificationsSkipped.replace(/^skipped:\s*/i, '')}. The waits are read from the inbox.${r.notifications ? ` The service still recorded ${r.notifications.count} sent, for the record only: it is not a pass or a fail (the dispatcher's first tick sends nothing).` : ''}`
      : r.notifications ? `${r.notifications.count} sent.` : 'The ledger was not read: no count.',
    '',
    row('Kind', 'Sent'),
    row('---', '---'),
    ...Object.entries(r.notifications?.byKind ?? {}).map(([kind, n]) => row(kind, n)),
    '',
    '## Tickets',
    '',
    row('Ticket', 'Sessions', 'Review rounds', 'Cost'),
    row('---', '---', '---', '---'),
    ...Object.entries(r.tickets).map(([id, c]) => row(id, c.sessions, c.reviewRounds, dollars(c.costUsd))),
    '',
    '## Waits',
    '',
    row('Kind', 'Ticket', 'Seen', 'Gone', 'Waited'),
    row('---', '---', '---', '---', '---'),
    ...Object.values(r.waits).map((w) => row(w.kind, w.ticket, w.seenAt, w.goneAt ?? 'still waiting', w.goneAt ? duration(w.seenAt, w.goneAt) : '')),
    '',
  ];
  out.push(...sessionPlanLines(r.sessionPlans));
  out.push('## Release cards', '');
  if (r.cards.length === 0) out.push('No release card was approved by the proof.', '');
  else {
    out.push(row('Ticket', 'Item', 'Groups', 'Flags', 'Seen on the card'), row('---', '---', '---', '---', '---'));
    for (const c of r.cards) out.push(row(c.ticket, c.item, c.groups.map((g) => `${g.intent} (${plural(g.files, 'file')})`).join('; '), c.flags.join(', '), `${plural(c.shown.groups, 'group')}, ${plural(c.shown.flags, 'flag')} on screen`));
    out.push('');
  }
  out.push(`Left to the owner: ${plural(r.leftForOwner.knowledge, 'knowledge item')}, ${plural(r.leftForOwner.contract, 'contract item')}.`, '');
  out.push('## Login cuts', '');
  if (r.loginCuts === null) out.push('The ledger was not read: no count.', '');
  else if (r.loginCuts.length === 0) out.push('No login cut.', '');
  else {
    out.push(`${r.loginCuts.length} login cuts, ${r.loginCuts.filter((c) => c.relaunchedAt).length} relaunched.`, '', row('Cut at', 'Role', 'Ticket', 'Relaunched at', 'Lasted'), row('---', '---', '---', '---', '---'));
    for (const c of r.loginCuts) out.push(row(c.at, c.role, c.ticket, c.relaunchedAt ?? (c.ended ? 'not relaunched: the session ended' : 'not relaunched'), c.relaunchedAt ? duration(c.at, c.relaunchedAt) : ''));
    // How a cut is read, and its one known blind spot (review 1, F5).
    out.push('', 'A cut runs from the session\'s first "Waiting for a new login" to its next turn. After a service restart, a snapshot that repeats that status with no turn after it reads as a cut still open.');
    out.push('');
  }
  if (r.morning) {
    out.push('## The morning', '', `At ${r.morning.at}: waiting ${JSON.stringify(r.morning.waitingByKind)}; plan items ${JSON.stringify(r.morning.itemsByState)}.`, '');
    for (const m of r.morning.nightMessages) out.push(`- ${m.at} (${m.by}): ${cell(m.text)}`);
    out.push('');
  }
  out.push('## The owner', '', row('Measure', 'Value'), row('---', '---'), row('owner gestures', r.gestures.length), '');
  for (const g of r.gestures) out.push(`- ${g.at}: ${cell(g.what)}`);
  if (r.stand_ins.length > 0) {
    out.push('', '## What the rehearsal replaced', '', 'These were stand-ins, so the rehearsal does not prove them:', '');
    for (const s of r.stand_ins) out.push(`- ${s}`);
  }
  return `${out.join('\n')}\n`;
}
