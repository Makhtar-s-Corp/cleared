// The inbox (inbox.png): what waits for the human, oldest first by kind, then
// what was handled today, and the detail of the item chosen: a release to
// approve or send back, a permission to allow or deny, a question to answer.
// The model and the wording are pure (data and a translator in, text out)
// so the tests run them under Node; the gestures are functions of the
// shell's api(), so the tests run them against the app; Inbox.tsx draws the
// screen and wires both to the page.
//
// Every gesture goes through lane 6's forwarding (/api/service/*) with the
// signed-in user: the answer route of lane 7, and the approval route of
// lane 8 with its Undo. Lane 8 holds the 60-second grace in the service, so
// "Approve" calls the route at once with the versions shown and the screen
// counts down to the `dueAt` it answers; Undo is the service's Undo route.
//
// A request the policy refused never waited for the human: lane 7's inbox
// does not list it (issue 145, item 4), and the session screen shows it as a
// row of its own. What the inbox handles is a request settled without the
// person while it was on screen: the answer route then says nothing waits,
// and the screen says so instead of offering buttons that cannot work.
//
// Milestone 2 adds the lead's plan: the inbox item carries only its totals,
// so the detail reads the plan (GET /api/plans/:id) and shows lane 8's plan
// panel; Approve calls the plan's route at once, with no grace, since
// starting a ticket is reversible (decision 6). The lead's question is
// answered on the lead's screen: the session answer route refuses the lead's
// session (issue 168, item 3), so the inbox shows it and links there.
import type { ApproveBody, InboxItem, PermissionItem, Plan, PlanItem, PlanItemInbox, QuestionItem, ReleaseItem, SessionSummary } from '../../../../src/api/types.ts';
import type { Decision } from '../../../../src/session/contract.ts';
import type { Question, ToolInput } from '../../../../src/session/events.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';
import { formatDuration, planStateLine } from '../../plan-panel/model.ts';

// The local tracker's default name of the state a ticket is sent back to
// (DEFAULT_STATES.todo of src/tickets/contract.ts, which the browser cannot
// import; a test keeps the two equal).
export const TODO_STATE = 'Todo';
// The lead's ticket (LEAD_TICKET in src/lead/contract.ts, which the browser
// cannot import; a test keeps the two equal): a plan and a question of the
// lead carry it, and the screen never shows it.
export const LEAD_TICKET = 'lead';
// The grace lane 8's service holds before it writes an approval, used only
// when its answer gives no `dueAt`.
export const GRACE_MS = 60_000;
export const RECOMMENDED = /\s*\(Recommended\)\s*$/i;

// What a gesture of this page left on an item until the service's list catches up.
export type Local =
  | { readonly kind: 'busy' }                                  // a call is on its way
  | { readonly kind: 'confirm' }                               // Send back asked once
  | { readonly kind: 'grace'; readonly dueAt: string }         // approved, Undo possible until dueAt
  | { readonly kind: 'approved'; readonly at: string }
  | { readonly kind: 'sent_back'; readonly at: string }
  | { readonly kind: 'answered'; readonly decision: Decision['kind'] }
  | { readonly kind: 'plan_approved'; readonly at: string }   // a plan has no grace: its tickets start
  | { readonly kind: 'settled' };                              // settled without the person

export type InboxView = {
  readonly items: readonly InboxItem[];
  readonly tickets: readonly Ticket[];
  readonly sessions: readonly SessionSummary[];
  readonly selected: string | undefined;                       // the item the address names
  readonly open: boolean;                                      // chosen in the address: on a phone the detail is its own page
  readonly me: { readonly id: string; readonly name: string };
  readonly now: Date;
  readonly local: ReadonlyMap<string, Local>;
  readonly frame: 'desktop' | 'phone';
  readonly plans?: ReadonlyMap<string, Plan>;                  // the plans read so far, by id
  readonly language?: 'en' | 'fr';                             // for the numbers: 0.30 or 0,30
};

// ---------------------------------------------------------------- the model

// The capture's order: a release, a permission, the lead's plan, a question.
const RANK: Readonly<Record<InboxItem['kind'], number>> = { release: 0, permission: 1, plan: 2, question: 3 };
// The catalog names a release's checks by colour, as the tower's does.
export const CHECKS = { passed: 'green', pending: 'running', failed: 'red' } as const;

// What waits, releases first, then permissions, plans and questions, each
// oldest first; then what was handled, in the service's order (latest first).
export function ordered(items: readonly InboxItem[]): { readonly waiting: InboxItem[]; readonly handled: InboxItem[] } {
  const waiting = items.filter((item) => item.state === 'waiting')
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(a.since) - Date.parse(b.since));
  return { waiting, handled: items.filter((item) => item.state === 'handled') };
}

// The item shown: the one the address names, else the first that waits.
export function chosen(view: InboxView): InboxItem | undefined {
  if (view.selected !== undefined) return view.items.find((item) => item.id === view.selected);
  const { waiting, handled } = ordered(view.items);
  return waiting[0] ?? handled[0];
}

// The detail is redrawn only when what it shows changed, so a reason or a
// free answer being typed is not lost to a refresh. A release's checks are
// part of what it shows: the owner waits for them to turn green.
// A plan's detail follows the plan read for it: read or not, and how it runs.
export function detailKey(v: InboxView): string {
  const item = chosen(v);
  const checks = item?.kind === 'release' ? item.pr.checks : undefined;
  const plan = item?.kind === 'plan' ? planOf(v, item) : undefined;
  const moved = plan ? [plan.state, plan.items.map((i) => [i.state, i.ticket])] : undefined;
  return JSON.stringify([v.items.length === 0, item?.id, item?.state, checks, moved, item ? v.local.get(item.id)?.kind : undefined, v.frame, v.selected]);
}

// ------------------------------------------------------------------ plans

const PLAN_STATES: readonly Plan['state'][] = ['proposed', 'superseded', 'rejected', 'approved', 'paused', 'done'];
const ITEM_STATES: readonly PlanItem['state'][] = ['waiting', 'ready', 'running', 'needs_approval', 'landed', 'put_back', 'held', 'cancelled'];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isEstimate = (value: unknown) => isObject(value) && isNumber(value.minutes) && isNumber(value.costUsd) && isNumber(value.samples)
  && (value.weekPercent === null || isNumber(value.weekPercent));
const isPlanItem = (value: unknown) => isObject(value) && isNumber(value.position) && isText(value.title)
  && (value.lane === 'fast' || value.lane === 'full') && Array.isArray(value.after) && value.after.every(isNumber)
  && isEstimate(value.estimate) && (value.ticket === null || isText(value.ticket)) && ITEM_STATES.includes(value.state as PlanItem['state']);

// The plan the service answered, if the panel can draw it. lane 8's panel
// looks its states up in maps and writes them into attributes, so a plan in
// a state it does not know is not handed to it (issue 177, item 2): the
// detail then shows what the inbox item says.
export function readPlan(value: unknown): Plan | undefined {
  if (!isObject(value) || !isText(value.id) || !isText(value.title) || !isText(value.summary) || !PLAN_STATES.includes(value.state as Plan['state'])) return undefined;
  if (!Array.isArray(value.items) || !value.items.every(isPlanItem) || !isEstimate(value.totals) || !isNumber(value.maxParallel)) return undefined;
  return value as unknown as Plan;
}

export const planOf = (view: InboxView, item: PlanItemInbox): Plan | undefined => view.plans?.get(item.planId);
export const isLead = (item: InboxItem) => item.ticket === LEAD_TICKET;

export function itemFromHash(hash: string): string | undefined {
  const raw = hash.replace(/^#/, '');
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

// A capture is shown only from this site: the page runs under default-src 'self'.
export function sameOrigin(url: string | null): string | undefined {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') ? url : undefined;
}

export function elapsed(iso: string, now: Date, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return t('now');
  if (minutes < 60) return t('minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('hours', { n: hours }) : t('days', { n: Math.floor(hours / 24) });
}

export function took(minutes: number, t: Translate): string {
  if (minutes < 60) return t('took_minutes', { n: Math.max(0, Math.round(minutes)) });
  const m = Math.round(minutes) % 60;
  const h = Math.floor(Math.round(minutes) / 60);
  return m === 0 ? t('took_hours_flat', { h }) : t('took_hours', { h, m: String(m).padStart(2, '0') });
}

// 'claude-sonnet-5-5' reads 'Sonnet', as the capture names a model.
export function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? (match[1] as string).charAt(0).toUpperCase() + (match[1] as string).slice(1).toLowerCase() : model;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const short = (head: string) => head.slice(0, 7);
export const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ---------------------------------------------------------------- gestures

type Api = ScreenContext['api'];
const ticketPath = (item: InboxItem) => `/tickets/${encodeURIComponent(item.ticket)}`;
const requestPath = (item: PermissionItem | QuestionItem) =>
  `/sessions/${encodeURIComponent(item.sessionId)}/requests/${encodeURIComponent(item.requestId)}/answer`;

// The versions the approval is bound to: exactly what the release shows.
export function approveBody(item: ReleaseItem): ApproveBody {
  return { requestedAt: item.requestedAt, heads: item.heads.map(({ pr, head }) => ({ pr, head })) };
}

export async function approve(api: Api, item: ReleaseItem, now: Date): Promise<Local> {
  const answer = await api<{ readonly accepted: true; readonly dueAt?: string }>(`${ticketPath(item)}/approve`, { method: 'POST', body: approveBody(item) });
  const dueAt = typeof answer?.dueAt === 'string' && !Number.isNaN(Date.parse(answer.dueAt)) ? answer.dueAt : new Date(now.getTime() + GRACE_MS).toISOString();
  return { kind: 'grace', dueAt };
}

// POST /api/tickets/:id/approve/undo is lane 8's route; api/types.ts does not
// list it yet (lane 8's log names that follow-up), so its answer is typed here.
export async function undoApproval(api: Api, item: ReleaseItem): Promise<void> {
  await api<{ readonly undone: true }>(`${ticketPath(item)}/approve/undo`, { method: 'POST', body: null });
}

// The inbox's "Send back" has no route of its own: the ticket moves back to
// Todo, which starts a new flow (decisions log, lane 7, choice 2).
export async function sendBack(api: Api, item: ReleaseItem): Promise<void> {
  await api(`${ticketPath(item)}/move`, { method: 'POST', body: { status: TODO_STATE } });
}

// The plan's approval: one gesture, no grace (decision 6). The service
// creates the tickets, starts the first ones and answers the plan.
export async function approvePlan(api: Api, item: PlanItemInbox): Promise<Plan> {
  return await api<Plan>(`/plans/${encodeURIComponent(item.planId)}/approve`, { method: 'POST', body: null });
}

// A refusal of the plan's approval, read against the plan read again: one
// no longer proposed was approved or replaced, even when the call failed
// after the service wrote it (issue 175, item 2).
export function afterPlanRefusal(key: string, plan: Plan | undefined): string {
  return plan && plan.state !== 'proposed' ? 'approve_plan_conflict' : key;
}

export function decisionFor(kind: 'allow_once' | 'allow_always' | 'reject_once', message: string, t: Translate): Decision {
  if (kind === 'allow_once') return { kind: 'allow_once' };
  if (kind === 'allow_always') return { kind: 'allow_always', scope: 'project' };
  return { kind: 'reject_once', message: message.trim() || t('deny_default') };
}

export async function answerRequest(api: Api, item: PermissionItem | QuestionItem, decision: Decision): Promise<Local> {
  await api(requestPath(item), { method: 'POST', body: { decision } });
  return { kind: 'answered', decision: decision.kind };
}

// A question's answers, keyed by the question's text as the harness asked
// it. A free answer wins over the choices; several choices of a multiple
// choice question are joined with a comma; every question needs an answer.
export function answersFor(questions: readonly Question[], picks: readonly (readonly string[])[], free: readonly string[]):
  { readonly answers: Record<string, string>; readonly missing?: undefined } | { readonly missing: number; readonly answers?: undefined } {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const own = (free[index] ?? '').trim();
    const value = own || (picks[index] ?? []).join(', ');
    if (!value) return { missing: index };
    answers[question.question] = value;
  }
  return { answers };
}

export type Gesture = 'approve' | 'undo' | 'send_back' | 'answer' | 'approve_plan';

// How a refusal of the service reads. An answer to a request that no longer
// waits (404, or 409 for a session that stopped) was settled without the
// person: an interrupt, the session's end, or an answer from the session screen.
export function failure(error: unknown, gesture: Gesture): { readonly key: string; readonly settled: boolean } {
  const status = error instanceof ApiError ? error.status : 0;
  switch (gesture) {
    case 'answer':
      return status === 404 || status === 409 ? { key: 'answer_settled', settled: true } : { key: 'answer_failed', settled: false };
    case 'approve':
      if (status === 403) return { key: 'approve_owner', settled: false };
      if (status === 404 || status === 409) return { key: 'approve_conflict', settled: false };
      return { key: status === 503 ? 'approve_setup' : 'approve_failed', settled: false };
    case 'undo':
      return { key: status === 409 ? 'undo_late' : 'undo_failed', settled: false };
    case 'send_back':
      return { key: status === 409 ? 'send_back_conflict' : 'send_back_failed', settled: false };
    // 409: approved elsewhere, replaced by a newer proposal or rejected; the
    // screen reads the plan again. 503: the service runs without the lead.
    case 'approve_plan':
      if (status === 409) return { key: 'approve_plan_conflict', settled: false };
      if (status === 404) return { key: 'approve_plan_gone', settled: false };
      return { key: status === 503 ? 'approve_plan_lead_off' : 'approve_plan_failed', settled: false };
  }
}

// ------------------------------------------------------------------ render

export const sessionOf = (view: InboxView, id: string) => view.sessions.find((s) => s.id === id);
export const ticketTitle = (view: InboxView, id: string) => view.tickets.find((ticket) => ticket.id === id)?.title;
export const sessionLink = (id: string) => `/sessions/${encodeURIComponent(id)}`;

// The session to open for a release: its ticket's author, the latest one.
export function releaseSession(view: InboxView, ticket: string): SessionSummary | undefined {
  const mine = view.sessions.filter((s) => s.ticket === ticket).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return mine.find((s) => s.role === 'author') ?? mine[0];
}

export function target(input: ToolInput): string {
  switch (input.kind) {
    case 'read': case 'edit': case 'delete': case 'move': return input.path;
    case 'execute': return input.command;
    case 'search': return input.pattern;
    case 'fetch': return input.target;
    default: return '';
  }
}

export function itemTitle(item: InboxItem): string {
  switch (item.kind) {
    case 'release': return item.title;
    case 'permission': return item.input.kind === 'execute' && item.input.description ? item.input.description : target(item.input) || item.tool;
    case 'question': return item.questions[0]?.question ?? '';
    case 'plan': return item.title;
  }
}

export function recommendation(item: QuestionItem): string | undefined {
  for (const question of item.questions) for (const option of question.options ?? []) if (RECOMMENDED.test(option.label)) return option.label.replace(RECOMMENDED, '');
  return undefined;
}

export const decimals = (value: number, digits: number, language: 'en' | 'fr') =>
  new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value);

// "5 tickets · 2 h 15 · 3.9 % of the week", or the cost until the week is
// measured (section 5.2), as the plan panel's footer says it.
export function planLine(item: PlanItemInbox, view: InboxView, t: Translate): string {
  const language = view.language ?? 'en';
  const { totals } = item;
  const share = totals.weekPercent === null
    ? t('list_plan_cost', { amount: t('plan_cost', { amount: decimals(totals.costUsd, 2, language) }) })
    : t('plan_week_total', { n: decimals(totals.weekPercent, 1, language) });
  return t(item.itemCount === 1 ? 'list_plan_one' : 'list_plan_other', { n: item.itemCount, time: formatDuration(totals.minutes, t), share });
}

export function itemLine(item: InboxItem, view: InboxView, t: Translate): string {
  if (isLead(item)) {
    const plan = item.kind === 'plan' ? planOf(view, item) : undefined;
    if (plan && plan.state !== 'proposed') return t('lead_line', { text: planStateLine(plan, t) });
    if (item.state === 'handled') return t('lead_line', { text: t('handled_short') });
    if (item.kind === 'question') return t('lead_line', { text: t('lead_waits_short') });
  } else if (item.state === 'handled') return t('handled_line', { ticket: item.ticket });
  switch (item.kind) {
    case 'release': {
      const reviewer = item.sessions.find((s) => s.role === 'reviewer');
      const checks = CHECKS[item.pr.checks];
      // The ticket first, as the other kinds: two releases can share a title.
      return reviewer ? t(`release_reviewed_${checks}`, { ticket: item.ticket, model: family(reviewer.model) }) : t(`release_unreviewed_${checks}`, { ticket: item.ticket });
    }
    case 'permission': {
      const role = sessionOf(view, item.sessionId)?.role;
      return t(role ? `paused_${role}` : 'paused_session', { ticket: item.ticket });
    }
    case 'question': {
      const label = recommendation(item);
      if (label) return t('recommends', { ticket: item.ticket, label });
      const n = item.questions.reduce((sum, q) => sum + (q.options?.length ?? 0), 0);
      return n > 0 ? t('question_choices', { ticket: item.ticket, n }) : t('question_free', { ticket: item.ticket });
    }
    case 'plan':
      return planLine(item, view, t);
  }
}

// Only an http(s) address is a link; anything else is shown as its label.
export const isWebLink = (url: string) => /^https?:\/\//i.test(url);

export function sessionsLine(item: ReleaseItem, t: Translate): string {
  return item.sessions.map((s) => {
    const values = { model: family(s.model), time: took(s.minutes, t) };
    if (s.role !== 'reviewer') return t('wrote', values);
    if (s.rounds === undefined) return t('reviewed', values);
    return s.rounds === 1 ? t('reviewed_rounds_one', values) : t('reviewed_rounds_other', { ...values, n: s.rounds });
  }).join(' · ');
}

// Who asks, and for how long its session has been paused; a handled request pauses nothing.
export function pausedLine(item: InboxItem, session: SessionSummary, now: Date, t: Translate): string {
  const model = family(session.model);
  if (item.state === 'handled') return t(`session_${session.role}_plain`, { model });
  const minutes = (now.getTime() - Date.parse(item.since)) / 60_000;
  return minutes < 1 ? t(`session_${session.role}_now`, { model }) : t(`session_${session.role}`, { model, time: elapsed(item.since, now, t) });
}

// What a share of the week says, or the cost until the week is measured.
export function shareLine(totals: PlanItemInbox['totals'], language: 'en' | 'fr', t: Translate): string {
  return totals.weekPercent === null
    ? t('plan_cost_total', { amount: t('plan_cost', { amount: decimals(totals.costUsd, 2, language) }) })
    : t('plan_week_total', { n: decimals(totals.weekPercent, 1, language) });
}

export const verbOf = (input: ToolInput) => (input.kind === 'think' || input.kind === 'switch_mode' || input.kind === 'other' ? 'other' : input.kind);

export function graceLeft(dueAt: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(dueAt) - now.getTime()) / 1000));
}

export const REFRESH_MS = 10_000;
export const STORE_KEY = 'cleared-v2-inbox';

// What a page keeps of its gestures across a reload of the tab: the grace
// and its outcome (the service still holds the approval, and its list shows
// the release until its next tick).
export const kept = (local: Local) => local.kind === 'grace' || local.kind === 'approved' || local.kind === 'sent_back';
