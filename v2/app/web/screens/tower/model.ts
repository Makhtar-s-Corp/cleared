// The tower (tower.png): the bar to create a ticket or open the lead, what
// needs the human (a plan the lead proposes among it), the live sessions
// with their current phrase, the lead's card with its state and last line,
// the plans under way, and what landed today with its duration.
// towerModel and the wording functions are pure, so the tests run them
// without a browser; loadTower reads the service, and Tower.tsx draws it.
import type { InboxItem, LeadMessage, LeadPhase, LeadState, Plan, PlanItemInbox, PlanItemState, SessionSummary } from '../../../../src/api/types.ts';
import type { Harness, Role } from '../../../../src/session/contract.ts';
import type { SessionPhase } from '../../../../src/session/events.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
import type { ScreenContext } from '../../lib/screen.ts';

export type TowerData = {
  readonly sessions: readonly SessionSummary[];
  readonly inbox: readonly InboxItem[];
  readonly tickets: readonly Ticket[];
  readonly lead: LeadState | null;              // null when the service has no lead to show
  readonly leadLine: string | null;             // the last thing the lead said to the owner
  readonly plans: readonly Plan[];
  readonly weekLeft: number | null;             // the share of the week left; no route reports it yet
};

// The lead's ticket (LEAD_TICKET in src/lead/contract.ts, which the browser
// cannot import at run time): a plan or a question of the lead carries it.
export const LEAD_TICKET = 'lead';

// The longest draft the bar hands to the lead's screen, which reads as much.
export const DRAFT_MAX = 2000;

// The local tracker's default done state (DEFAULT_STATES.done in
// src/tickets/contract.ts, which the browser cannot import at run time).
export const DONE_STATE = 'Done';

const LIVE_PHASES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting_human', 'reviewing']);

export type NeedCard = {
  readonly kind: InboxItem['kind'];
  readonly id: string;
  readonly href: string;
  readonly ticket: string;                      // empty for the lead's items
  readonly owner: 'team' | 'lead';
  readonly minutes: number;
  readonly title: string;
  readonly detail: string;                      // from the data; may be empty
  readonly detailKey: string | undefined;       // a catalog sentence after it
  readonly detailValues: Readonly<Record<string, string>>;
};

export type LiveCard = {
  readonly id: string;
  readonly role: Role;
  readonly ticket: string;
  readonly title: string;
  readonly status: string;
  readonly harness: Harness;
  readonly model: string;
  readonly minutes: number;
  readonly phase: SessionPhase;
};

export type LandedRow = { readonly ticket: string; readonly title: string; readonly time: string; readonly minutes: number };

export type LeadCard = {
  readonly phase: LeadPhase;
  readonly percent: number | null;
  readonly refreshedMinutes: number | null;
  readonly line: string | null;
};

// One segment of a plan's bar per item; a cancelled item has none.
export type Segment = 'landed' | 'running' | 'approval' | 'held' | 'waiting';

export type PlanRow = {
  readonly id: string;
  readonly title: string;
  readonly paused: boolean;
  readonly landed: number;
  readonly running: number;
  readonly approval: number;
  readonly held: number;
  readonly total: number;
  readonly next: string | null;                 // the title of the next item to start
  readonly segments: readonly Segment[];
};

export type TowerModel = {
  readonly needs: readonly NeedCard[];
  readonly live: readonly LiveCard[];
  readonly landed: readonly LandedRow[];
  readonly lead: LeadCard | null;
  readonly plans: readonly PlanRow[];
  readonly weekLeft: number | null;
};

const minutesSince = (from: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));

// 'claude-opus-5-5' reads 'claude · opus-5.5'; another harness's model is kept as it is.
export function formatModel(harness: Harness, model: string): string {
  const name = harness === 'claude-code' ? 'claude' : harness;
  const short = model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2');
  return `${name} · ${short}`;
}

// 'claude-sonnet-5-5' reads 'Sonnet', as the capture names a reviewer.
function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? (match[1] as string).charAt(0).toUpperCase() + (match[1] as string).slice(1).toLowerCase() : model;
}

const pad = (n: number) => String(n).padStart(2, '0');

// The catalog names a release's checks by colour.
const CHECKS = { passed: 'green', pending: 'running', failed: 'red' } as const;

function need(item: InboxItem, now: Date): NeedCard {
  const lead = item.ticket === LEAD_TICKET;
  const base = {
    kind: item.kind, id: item.id, ticket: lead ? '' : item.ticket, owner: lead ? 'lead' : 'team', minutes: minutesSince(item.since, now),
    href: item.kind === 'plan' ? `/plans/${encodeURIComponent(item.planId)}` : lead ? '/lead' : `/inbox#${encodeURIComponent(item.id)}`,
  } as const;
  switch (item.kind) {
    case 'release': {
      const reviewer = item.sessions.find((s) => s.role === 'reviewer');
      const checks = CHECKS[item.pr.checks];
      const key = reviewer ? `release_reviewed_${checks}` : `release_unreviewed_${checks}`;
      return { ...base, title: item.title, detail: '', detailKey: key, detailValues: reviewer ? { model: family(reviewer.model) } : {} };
    }
    case 'permission': {
      const input = item.input;
      let title = item.tool;
      if (input.kind === 'execute') title = input.description || input.command;
      else if ('path' in input && input.path) title = input.path;
      return { ...base, title, detail: 'reason' in item.suggestion ? item.suggestion.reason : '', detailKey: 'permission_paused', detailValues: {} };
    }
    case 'question': {
      const [first, ...others] = item.questions;
      return { ...base, title: first?.question ?? '', detail: others.map((q) => q.question).join(' '), detailKey: lead ? 'question_lead' : 'question_paused', detailValues: {} };
    }
    case 'plan':
      return { ...base, title: item.title, detail: '', detailKey: 'plan_proposes', detailValues: proposal(item) };
  }
}

// What a plan card says of the plan; renderTowerBody words it.
function proposal(item: PlanItemInbox): Record<string, string> {
  const { minutes, costUsd, weekPercent } = item.totals;
  return { n: String(item.itemCount), minutes: String(minutes), cost: costUsd.toFixed(2), ...(weekPercent === null ? {} : { week: String(Math.round(weekPercent * 10) / 10) }) };
}

const UNDER_WAY: ReadonlySet<Plan['state']> = new Set(['approved', 'paused']);
const SEGMENT: Readonly<Record<PlanItemState, Segment | null>> = {
  landed: 'landed', running: 'running', needs_approval: 'approval', held: 'held', put_back: 'waiting', ready: 'waiting', waiting: 'waiting', cancelled: null,
};

function planRow(plan: Plan): PlanRow {
  const items = [...plan.items].filter((i) => i.state !== 'cancelled').sort((a, b) => a.position - b.position);
  const count = (segment: Segment) => items.filter((i) => SEGMENT[i.state] === segment).length;
  return {
    id: plan.id, title: plan.title, paused: plan.state === 'paused', total: items.length,
    landed: count('landed'), running: count('running'), approval: count('approval'), held: count('held'),
    next: items.find((i) => SEGMENT[i.state] === 'waiting')?.title ?? null,
    segments: items.map((i) => SEGMENT[i.state] ?? 'waiting'),
  };
}

// The lead's last line in the owner's thread, read after `after`: its
// message, its plan or its question, never the owner's line nor a refresh.
export type LeadThread = { readonly after: number; readonly line: string | null };

export function lastLeadLine(messages: readonly LeadMessage[], previous: LeadThread): LeadThread {
  let { after, line } = previous;
  for (const message of messages) {
    if (message.seq <= after) continue;
    after = message.seq;
    if (message.by === 'lead' && message.kind !== 'refresh' && message.text.trim()) line = message.text.trim();
  }
  return { after, line };
}

export function towerModel(data: TowerData, now: Date): TowerModel {
  const titles = new Map(data.tickets.map((ticket) => [ticket.id, ticket.title]));
  // What the teams wait for comes first, oldest first; then the plans the
  // lead proposes, which wait for a decision rather than hold a session.
  const needs = data.inbox.filter((item) => item.state === 'waiting')
    .map((item) => need(item, now))
    .sort((a, b) => Number(a.kind === 'plan') - Number(b.kind === 'plan') || b.minutes - a.minutes);
  // The lead's own session is its card, not a team's session.
  const live = data.sessions.filter((s) => s.role !== 'lead' && LIVE_PHASES.has(s.phase)).map((s): LiveCard => ({
    id: s.id, role: s.role, ticket: s.ticket, title: titles.get(s.ticket) ?? s.ticket, status: s.status, harness: s.harness, model: s.model,
    minutes: minutesSince(s.startedAt, now), phase: s.phase,
  }));
  const today = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const landed = data.tickets.filter((ticket) => {
    if (ticket.status !== DONE_STATE) return false;
    const at = new Date(ticket.updatedAt);
    return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}` === today;
  }).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).map((ticket): LandedRow => {
    const at = new Date(ticket.updatedAt);
    return { ticket: ticket.id, title: ticket.title, time: `${pad(at.getHours())}:${pad(at.getMinutes())}`, minutes: minutesSince(ticket.createdAt, at) };
  });
  const lead: LeadCard | null = data.lead && {
    phase: data.lead.phase, percent: data.lead.context ? Math.round(data.lead.context.percent) : null,
    refreshedMinutes: data.lead.refreshedAt && data.lead.refreshCount > 0 ? minutesSince(data.lead.refreshedAt, now) : null, line: data.leadLine,
  };
  return { needs, live, landed, lead, plans: data.plans.filter((p) => UNDER_WAY.has(p.state)).map(planRow), weekLeft: data.weekLeft };
}

// "18 min", "1 h 24".
export function duration(minutes: number, t: Translate): string {
  if (minutes < 60) return t('minutes', { n: minutes });
  return t('hours_minutes', { h: Math.floor(minutes / 60), m: pad(minutes % 60) });
}

export function heading(count: number, t: Translate): string {
  return count <= 5 ? t(`needs_${count}`) : t('needs_many', { n: count });
}

export const plural = (n: number, key: string, t: Translate) => t(n === 1 ? `${key}_one` : `${key}_other`, { n });

// "40 min", "2 h", "2 h 15": a plan's estimate, already rounded by the service.
function about(minutes: number, t: Translate): string {
  if (minutes < 60) return t('minutes', { n: minutes });
  return minutes % 60 === 0 ? t('hours', { h: minutes / 60 }) : duration(minutes, t);
}

// A number with the catalog's decimal mark.
const decimal = (value: string, t: Translate) => value.replace('.', t('decimal_mark'));

export function planDetail(values: Readonly<Record<string, string>>, t: Translate): string {
  const n = Number(values.n);
  const time = about(Number(values.minutes), t);
  const key = `plan_proposes_${values.week === undefined ? 'cost' : 'week'}_${n === 1 ? 'one' : 'other'}`;
  return t(key, { n, time, week: decimal(values.week ?? '', t), cost: decimal(values.cost ?? '', t) });
}

// Where New goal and Ask the lead go: the lead's screen, with what was
// typed (the title, then the description when written) as its draft, read
// by screens/lead.ts. The draft is cut at DRAFT_MAX so the address stays
// well under the server's header limit.
export function leadHref(kind: 'goal' | 'lead', title: string, body = ''): string {
  const query = new URLSearchParams();
  if (kind === 'goal') query.set('goal', '1');
  const text = [title.trim(), body.trim()].filter(Boolean).join('\n\n').slice(0, DRAFT_MAX);
  if (text) query.set('draft', text);
  const search = query.toString();
  return search ? `/lead?${search}` : '/lead';
}

// What the bar sends to create a ticket: the title, and the description
// only when one was written.
export function newTicket(title: string, body: string, project: string): { title: string; project: string; body?: string } {
  const text = body.trim();
  return { title: title.trim(), project, ...(text ? { body: text } : {}) };
}

// What a need's card says under its title: the item's own words, then the catalog's sentence.
export function needSentence(card: NeedCard, t: Translate): string {
  const sentence = card.kind === 'plan' ? planDetail(card.detailValues, t) : card.detailKey ? t(card.detailKey, card.detailValues) : '';
  return [card.detail, sentence].filter(Boolean).join(' ');
}

export function needId(card: NeedCard, t: Translate): string {
  return card.kind === 'plan' ? t('need_goal') : card.owner === 'lead' ? t('need_lead') : card.ticket;
}

export const harnessSquare = (harness: Harness): 'claude' | 'codex' | 'other' => (harness === 'claude-code' ? 'claude' : harness === 'codex' ? 'codex' : 'other');

export function liveDot(phase: SessionPhase, role: Role): string {
  return phase === 'waiting_human' ? 'live waiting' : role === 'reviewer' ? 'live review' : 'live';
}

export function leadState(lead: LeadCard | null, t: Translate): { readonly text: string; readonly kind: string } {
  if (!lead || lead.phase === 'down') return { text: t('lead_down'), kind: 'down' };
  if (lead.phase === 'starting') return { text: t('lead_starting'), kind: 'starting' };
  if (lead.phase === 'refreshing') return { text: t('lead_refreshing'), kind: 'refreshing' };
  const parts = [t('lead_on')];
  if (lead.percent !== null) parts.push(t('lead_context', { n: lead.percent }));
  if (lead.refreshedMinutes !== null) parts.push(t('lead_refreshed', { age: duration(lead.refreshedMinutes, t) }));
  return { text: parts.join(' · '), kind: 'on' };
}

export function planProgress(row: PlanRow, t: Translate): { readonly bar: string; readonly line: string } {
  // The bar's label says every colour it shows; the line adds what comes next.
  const counts = [t('plan_landed', { n: row.landed, m: row.total })];
  if (row.running) counts.push(t('plan_running', { n: row.running }));
  if (row.approval) counts.push(t('plan_approval', { n: row.approval }));
  if (row.held) counts.push(t('plan_held', { n: row.held }));
  const next = row.next ? [t('plan_next', { title: row.next })] : [];
  return { bar: counts.join(' · '), line: [...(row.paused ? [t('plan_paused')] : []), ...counts, ...next].join(' · ') };
}

export function towerSummary(model: TowerModel, t: Translate): string {
  return [
    plural(model.live.length, 'sessions_running', t),
    ...(model.plans.length ? [plural(model.plans.length, 'plans_in_progress', t)] : []),
    plural(model.landed.length, 'landed_today_count', t),
    ...(model.weekLeft === null ? [] : [t('week_left', { n: Math.round(model.weekLeft) })]),
  ].join(' · ');
}

export const REFRESH_MS = 10_000;

// The tower's data. Sessions, inbox and tickets are the tower's own and a
// failure to read one fails the read; the lead, its thread and the plans
// are read apart, so a service without them (the lead off, or the plans
// not there yet) still shows milestone 1's tower. The thread is read after
// the last seq already seen.
export async function loadTower(api: ScreenContext['api'], thread: LeadThread): Promise<{ readonly data: TowerData; readonly thread: LeadThread }> {
  const optional = <T,>(path: string, fallback: T): Promise<T> => api<T>(path).catch(() => fallback);
  const [sessions, inbox, tickets, lead, messages, plans] = await Promise.all([
    api<SessionSummary[]>('/sessions'), api<InboxItem[]>('/inbox'), api<Ticket[]>('/tickets'),
    optional<LeadState | null>('/lead', null),
    optional<LeadMessage[]>(thread.after > 0 ? `/lead/messages?after=${thread.after}` : '/lead/messages', []),
    optional<Plan[]>('/plans', []),
  ]);
  const next = lastLeadLine(messages, thread);
  return { data: { sessions, inbox, tickets, lead, leadLine: next.line, plans, weekLeft: null }, thread: next };
}
