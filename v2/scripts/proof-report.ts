// The pure parts of the milestone 2 proof (scripts/proof-j2.ts,
// docs/v2/milestone-2-plan.md, section 1): what changed between two readings
// of the state, the timeline the night watch keeps from them, the check of
// the planted commitments and of "3 after 2", the facts read from the
// ledger (notifications, the lead's turns and cost, each ticket's sessions),
// and the durations table the run writes.
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
  readonly key: string; readonly planted: string; readonly state: 'done' | 'open' | 'lost'; readonly ids: readonly string[];
  readonly due: string | null; readonly fulfilledAt: string | null; readonly note: string | null;
};

// Done when a commitment for it is done, open when one is open, lost when
// the lead holds none (never recorded, or dropped by a refresh).
export function commitmentOutcomes(commitments: readonly LeadCommitment[]): CommitmentOutcome[] {
  return PLANTED.map((planted) => {
    const found = commitments.filter((c) => planted.match.test(c.text));
    const done = found.find((c) => c.state === 'done');
    const kept = done ?? found[0];
    return {
      key: planted.key, planted: planted.text, state: done ? 'done' : found.length > 0 ? 'open' : 'lost', ids: found.map((c) => c.id),
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

export type LedgerFacts = {
  readonly notifications: { readonly count: number; readonly byKind: Record<string, number>; readonly firstAt: Record<string, string> };
  readonly lead: { readonly generations: number; readonly turns: number; readonly costUsd: number; readonly highestPercent: number | null; readonly compactions: number };
  // Each ticket from its first session's start to its last session's last update.
  readonly tickets: Record<string, { readonly sessions: number; readonly reviewRounds: number; readonly costUsd: number; readonly startedAt: string; readonly lastAt: string }>;
  readonly maxLive: number;                                 // the most tickets in those spans at once
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
  const sessions = rows(db, 'SELECT id, ticket, role, created_at, updated_at FROM sessions WHERE created_at >= ? ORDER BY created_at', since);
  const events = (types: string) => rows(db, `SELECT session_id, type, event FROM session_events WHERE at >= ? AND type IN (${types})`, since);
  const role = new Map(sessions.map((s) => [String(s.id), { ticket: String(s.ticket), role: String(s.role) }]));
  const lead = { generations: sessions.filter((s) => s.role === 'lead').length, turns: 0, costUsd: 0, highestPercent: null as number | null, compactions: 0 };
  const tickets: Record<string, { sessions: number; reviewRounds: number; costUsd: number; startedAt: string; lastAt: string }> = {};
  for (const s of sessions) {
    if (s.role !== 'author' && s.role !== 'reviewer') continue;
    const t = tickets[String(s.ticket)] ??= { sessions: 0, reviewRounds: 0, costUsd: 0, startedAt: String(s.created_at), lastAt: String(s.updated_at) };
    t.sessions++;
    if (s.role === 'reviewer') t.reviewRounds++;
    if (String(s.updated_at) > t.lastAt) t.lastAt = String(s.updated_at);
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
  return { notifications: { count: sent, byKind, firstAt }, lead, tickets, maxLive };
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
    row('plan proposed → plan notification sent', duration(t.plan_proposed_at, r.notifications?.firstAt.plan)),
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
    row('generations started after the goal', r.lead.generations ?? 'not read'),
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
    r.notifications ? `${r.notifications.count} sent.` : 'The ledger was not read: no count.',
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
