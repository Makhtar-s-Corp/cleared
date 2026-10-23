// The tower (tower.png): the bar to create a ticket or open the lead, what
// needs the human (a plan the lead proposes among it), the live sessions
// with their current phrase, the lead's card with its state and last line,
// the plans under way, and what landed today with its duration. In a
// workspace of several services (lane 22), a line with each service's state,
// each live session's service, and the services a new ticket names. The
// milestone 2 additions (lane 27): a live session's step across services
// ("step 2 of 4, filter-api"), the contract and knowledge items among what
// needs the owner, the schedules in the plans card with their next run, "Run
// a recipe" with its parameters, and "Ask about the code" (screens/ask/).
// towerModel and the wording functions are pure, so the tests run them
// without a browser; loadTower reads the service, and Tower.tsx draws it.
import type {
  ApiSessionPhase, ContractItem, CreateTicketBody, InboxItem, KnowledgeItem, LeadMessage, LeadPhase, LeadState, NextInboxItem, Plan, PlanItemInbox, PlanItemState, Recipe,
  ReleaseItem, RunRecipeBody, Schedule, SessionPlanItem, SessionSummary, TicketStep, TrainState, Workspace,
} from '../../../../src/api/types.ts';
import type { Harness, Role } from '../../../../src/session/contract.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ago, clock, duration, estimate } from '../../lib/time.ts';
import { requestReason, requestTitle, type Request } from '../../lib/request.ts';
import type { Verdict } from '../../../../src/session/policy.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';

export type TowerData = {
  readonly sessions: readonly SessionSummary[];
  readonly inbox: readonly NextInboxItem[];
  readonly tickets: readonly Ticket[];
  readonly lead: LeadState | null;              // null when the service has no lead to show
  readonly leadLine: string | null;             // the last thing the lead said to the owner
  readonly plans: readonly Plan[];
  readonly weekLeft: number | null;             // the share of the week left; no route reports it yet
  readonly workspace?: Workspace | null;        // null or absent when GET /api/workspace could not be read
  readonly recipes?: readonly Recipe[] | null;  // null or absent: the service has no recipes to run (lane 26's route)
  readonly schedules?: readonly Schedule[] | null;
  readonly steps?: Readonly<Record<string, readonly TicketStep[]>>;   // a live ticket's steps, by ticket, in a workspace of several services
};

// The lead's ticket (LEAD_TICKET in src/lead/contract.ts, which the browser
// cannot import at run time): a plan or a question of the lead carries it.
export const LEAD_TICKET = 'lead';

// The longest draft the bar hands to the lead's screen, which reads as much.
export const DRAFT_MAX = 2000;

// The local tracker's default done state (DEFAULT_STATES.done in
// src/tickets/contract.ts, which the browser cannot import at run time).
export const DONE_STATE = 'Done';

// A paused session (taken over, decision 30) is live too: someone works in it.
const LIVE_PHASES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting_human', 'reviewing', 'paused']);

// The kinds the tower draws: a later kind is left out until its card is
// drawn, instead of breaking the tower.
type TowerKind = NextInboxItem['kind'];
type NeedItem = InboxItem | SessionPlanItem | ContractItem | KnowledgeItem;
const NEED_KINDS: ReadonlySet<string> = new Set<TowerKind>(['release', 'permission', 'question', 'plan', 'session_plan', 'contract', 'knowledge']);
const isNeed = (item: NextInboxItem): item is NeedItem => NEED_KINDS.has(item.kind);

export type NeedCard = {
  readonly kind: TowerKind;
  readonly id: string;
  readonly href: string;
  readonly ticket: string;                      // empty for the lead's items
  readonly owner: 'team' | 'lead';
  readonly minutes: number;
  readonly title: string;
  readonly titleKey?: string;                   // a catalog title in place of the data's (a contract: "Contract of filter-api")
  readonly detail: string;                      // from the data; may be empty
  readonly detailKey: string | undefined;       // a catalog sentence after it
  readonly detailValues: Readonly<Record<string, string>>;
  readonly request?: Request & { readonly suggestion: Verdict };   // a permission: titled and explained as the inbox does (lane 37)
};

// Who took a session over (decision 30): the signed-in person, or another
// account, which the app cannot name (no route maps an id to a name).
export type TakenOverCard = { readonly you: boolean; readonly minutes: number };

export type LiveCard = {
  readonly id: string;
  readonly role: Role;
  readonly ticket: string;
  readonly title: string;
  readonly status: string;
  readonly harness: Harness;
  readonly model: string;
  readonly minutes: number;
  readonly phase: ApiSessionPhase;
  readonly service: string | null;              // in a workspace of several services
  readonly takenOver: TakenOverCard | null;
  readonly step: LiveStep | null;               // its step, for a ticket of two steps or more
};

// "step 2 of 4, filter-api": a session's step of its ticket (decision 26).
export type LiveStep = { readonly position: number; readonly total: number; readonly service: string };

// A schedule of the plans card (decision 29), the next run first.
export type ScheduleRow = { readonly id: string; readonly name: string; readonly enabled: boolean; readonly nextRunAt: string | null; readonly budgetUsd: number };

// A service of the workspace line: its live sessions, and its train: a
// landing in progress on it, else a train rolled back in the inbox's day.
export type ServiceRow = { readonly name: string; readonly live: number; readonly landing: string | null; readonly rolledBack: string | null };

export type LandedRow = { readonly ticket: string; readonly title: string; readonly time: string; readonly minutes: number };

export type LeadCard = {
  readonly phase: LeadPhase;
  readonly percent: number | null;
  readonly refreshed: { readonly at: string; readonly now: Date } | null;
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
  readonly services: readonly ServiceRow[];     // none for a workspace of one service
  readonly serviceNames: readonly string[];     // what a new ticket may name; none for one service
  readonly askServices: readonly string[];      // the workspace's services, whatever their number: a question's target names one
  readonly recipes: readonly Recipe[];          // none: no "Run a recipe"
  readonly schedules: readonly ScheduleRow[];
  readonly now: Date;                           // when the model was made: a schedule's next run says "tomorrow" from it
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


// The catalog names a release's checks by colour.
const CHECKS = { passed: 'green', pending: 'running', failed: 'red' } as const;

function need(item: NeedItem, now: Date, titles: ReadonlyMap<string, string>): NeedCard {
  const lead = item.ticket === LEAD_TICKET;
  const base = {
    kind: item.kind, id: item.id, ticket: lead ? '' : item.ticket, owner: lead ? 'lead' : 'team', minutes: minutesSince(item.since, now),
    href: item.kind === 'plan' ? `/plans/${encodeURIComponent(item.planId)}` : lead ? '/lead' : `/inbox#${encodeURIComponent(item.id)}`,
  } as const;
  switch (item.kind) {
    case 'release': {
      // A train blocked before approval (decision 21) cannot be approved as it is.
      if (item.train?.state === 'blocked') return { ...base, title: item.title, detail: item.train.blocked?.reason ?? '', detailKey: 'release_blocked', detailValues: {} };
      const reviewer = item.sessions.find((s) => s.role === 'reviewer');
      const checks = CHECKS[item.pr.checks];
      const key = reviewer ? `release_reviewed_${checks}` : `release_unreviewed_${checks}`;
      return { ...base, title: item.title, detail: '', detailKey: key, detailValues: reviewer ? { model: family(reviewer.model) } : {} };
    }
    // Its title and its reason are the inbox's (lib/request.ts), in the person's language.
    case 'permission':
      return { ...base, title: '', detail: '', detailKey: 'permission_paused', detailValues: {}, request: { input: item.input, tool: item.tool, reasonCode: item.reasonCode, suggestion: item.suggestion } };
    case 'question': {
      const [first, ...others] = item.questions;
      return { ...base, title: first?.question ?? '', detail: others.map((q) => q.question).join(' '), detailKey: lead ? 'question_lead' : 'question_paused', detailValues: {} };
    }
    case 'plan':
      return { ...base, title: item.title, detail: '', detailKey: 'plan_proposes', detailValues: proposal(item) };
    case 'session_plan':
      return { ...base, title: titles.get(item.ticket) ?? item.ticket, detail: item.plan.reason, detailKey: `session_plan_${item.plan.confidence}`, detailValues: {} };
    // A contract step's change waits for its validation (decision 26); a
    // handover's knowledge waits for its approval (decision 27).
    case 'contract':
      return { ...base, title: '', titleKey: 'contract_of', detail: '', detailKey: 'contract_waits', detailValues: { service: item.service, path: item.path } };
    case 'knowledge': {
      const level = item.level === 'workspace' || !item.service ? 'workspace' : item.level;
      return { ...base, title: item.text, detail: '', detailKey: `knowledge_waits_${level}`, detailValues: item.service ? { service: item.service } : {} };
    }
  }
}

export const needTitle = (card: NeedCard, t: Translate): string => (card.request ? requestTitle(card.request, t) : card.titleKey ? t(card.titleKey, card.detailValues) : card.title);

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

type Train = ReleaseItem & { readonly train: TrainState };
const isTrain = (item: NextInboxItem): item is Train => item.kind === 'release' && item.train !== undefined;

// The service a train lands now: the first one not yet healthy.
const landingNow = (train: TrainState) => train.services.find((stop) => stop.state !== 'healthy')?.service;

function serviceRows(workspace: Workspace, live: readonly LiveCard[], inbox: readonly NextInboxItem[]): ServiceRow[] {
  const trains = inbox.filter(isTrain).sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  return workspace.services.map(({ name }) => {
    const landing = trains.find((item) => item.train.state === 'landing' && landingNow(item.train) === name)?.ticket ?? null;
    const rolledBack = landing ? null : trains.find((item) => item.train.state === 'rolled_back' && item.train.services.some((stop) => stop.service === name && stop.state === 'reverted'))?.ticket ?? null;
    return { name, live: live.filter((card) => card.service === name).length, landing, rolledBack };
  });
}

export function towerModel(data: TowerData, now: Date, viewer?: string): TowerModel {
  const titles = new Map(data.tickets.map((ticket) => [ticket.id, ticket.title]));
  const several = (data.workspace?.services.length ?? 0) >= 2 ? data.workspace ?? null : null;
  // What the teams wait for comes first, oldest first; then the plans the
  // lead proposes, which wait for a decision rather than hold a session.
  const needs = data.inbox.filter((item) => item.state === 'waiting').filter(isNeed)
    .map((item) => need(item, now, titles))
    .sort((a, b) => Number(a.kind === 'plan') - Number(b.kind === 'plan') || b.minutes - a.minutes);
  // The lead's own session is its card, not a team's session; a reader's is
  // its question's, shown on /ask/:id (decision 28).
  const live = data.sessions.filter(isLive).map((s): LiveCard => ({
    id: s.id, role: s.role, ticket: s.ticket, title: titles.get(s.ticket) ?? s.ticket, status: s.status, harness: s.harness, model: s.model,
    minutes: minutesSince(s.startedAt, now), phase: s.phase, service: several ? s.service ?? null : null,
    takenOver: s.takenOver ? { you: viewer !== undefined && s.takenOver.by === viewer, minutes: minutesSince(s.takenOver.at, now) } : null,
    step: several ? liveStep(data.steps?.[s.ticket], s.id) : null,
  }));
  const today = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const landed = data.tickets.filter((ticket) => {
    if (ticket.status !== DONE_STATE) return false;
    const at = new Date(ticket.updatedAt);
    return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}` === today;
  }).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).map((ticket): LandedRow => {
    const at = new Date(ticket.updatedAt);
    return { ticket: ticket.id, title: ticket.title, time: clock(ticket.updatedAt), minutes: minutesSince(ticket.createdAt, at) };
  });
  const lead: LeadCard | null = data.lead && {
    phase: data.lead.phase, percent: data.lead.context ? Math.round(data.lead.context.percent) : null,
    refreshed: data.lead.refreshedAt && data.lead.refreshCount > 0 ? { at: data.lead.refreshedAt, now } : null, line: data.leadLine,
  };
  return {
    needs, live, landed, lead, plans: data.plans.filter((p) => UNDER_WAY.has(p.state)).map(planRow), weekLeft: data.weekLeft,
    services: several ? serviceRows(several, live, data.inbox) : [], serviceNames: several ? several.services.map((service) => service.name) : [],
    askServices: Array.isArray(data.workspace?.services) ? data.workspace.services.map((service) => service.name) : [],
    recipes: Array.isArray(data.recipes) ? data.recipes : [], schedules: Array.isArray(data.schedules) ? scheduleRows(data.schedules) : [], now,
  };
}

const isLive = (s: SessionSummary) => s.role !== 'lead' && s.role !== 'reader' && (LIVE_PHASES.has(s.phase) || Boolean(s.takenOver));

// A session's step of its ticket, for a ticket of two steps or more.
function liveStep(steps: readonly TicketStep[] | undefined, session: string): LiveStep | null {
  if (!Array.isArray(steps) || steps.length < 2) return null;
  const step = steps.find((s) => s.session === session);
  return step ? { position: step.position, total: steps.length, service: step.service } : null;
}

// The live sessions in the tower's order: what waits for the person first,
// then what works (a session taken over among them), then what reviews.
const LIVE_RANK: Readonly<Record<string, number>> = { waiting_human: 0, starting: 1, working: 1, paused: 1, reviewing: 2 };
export const liveOrder = (cards: readonly LiveCard[]): LiveCard[] =>
  [...cards].sort((a, b) => (LIVE_RANK[a.phase] ?? 1) - (LIVE_RANK[b.phase] ?? 1));

// A recipe is named by its service and its name: two services may have a recipe of one name.
export const recipeKey = (recipe: Pick<Recipe, 'service' | 'name'>): string => `${recipe.service}/${recipe.name}`;

export const stepTag = (step: LiveStep, t: Translate): string => t('live_step', { n: step.position, total: step.total, service: step.service });

// ------------------------------------------------------------- schedules

// The ones that run first, the next run first; one switched off, last.
function scheduleRows(schedules: readonly Schedule[]): ScheduleRow[] {
  const at = (row: ScheduleRow) => (row.enabled && row.nextRunAt ? Date.parse(row.nextRunAt) : Number.POSITIVE_INFINITY);
  return schedules.map((s): ScheduleRow => ({ id: s.id, name: s.recipe ?? s.goal ?? s.id, enabled: s.enabled, nextRunAt: s.nextRunAt, budgetUsd: s.budgetUsd }))
    .sort((a, b) => Number(!a.enabled) - Number(!b.enabled) || at(a) - at(b));
}

const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

// "Next run tomorrow at 03:00 · $0.50", in the server's time zone as the
// browser shows times; "Off" for one switched off.
export function scheduleLine(row: ScheduleRow, now: Date, language: 'en' | 'fr', t: Translate): string {
  if (!row.enabled) return t('schedule_off');
  const budget = t('schedule_budget', { amount: new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(row.budgetUsd) });
  if (!row.nextRunAt) return `${t('schedule_none')} · ${budget}`;
  const next = new Date(row.nextRunAt);
  const time = clock(row.nextRunAt);
  const days = Math.round((dayOf(next) - dayOf(now)) / 86_400_000);
  const when = days <= 0 ? t('schedule_next_today', { time }) : days === 1 ? t('schedule_next_tomorrow', { time })
    : t('schedule_next_day', { time, day: next.toLocaleDateString(language, { weekday: 'short' }) });
  return `${when} · ${budget}`;
}

// --------------------------------------------------------------- recipes

// The first required parameter left empty, which the form names before
// anything is posted; the service checks them again (lane 26).
export function recipeProblem(recipe: Recipe, values: Readonly<Record<string, string>>): string | undefined {
  return recipe.parameters.find((p) => p.required && !(values[p.name] ?? '').trim())?.name;
}

// What the run sends: each parameter given, trimmed; an optional one left empty is left out.
export function recipeBody(recipe: Recipe, values: Readonly<Record<string, string>>): RunRecipeBody {
  const parameters: Record<string, string> = {};
  for (const p of recipe.parameters) {
    const value = (values[p.name] ?? '').trim();
    if (value) parameters[p.name] = value;
  }
  return { parameters };
}

export type RecipeRun = { readonly accepted: true; readonly plan?: string; readonly message?: number };

export async function runRecipe(api: ScreenContext['api'], recipe: Recipe, values: Readonly<Record<string, string>>): Promise<RecipeRun> {
  if (recipeProblem(recipe, values) !== undefined) throw new Error('recipe_missing');
  return await api<RecipeRun>(`/recipes/${encodeURIComponent(recipe.name)}/run`, { method: 'POST', body: recipeBody(recipe, values) });
}

// What a run says, and where it leads: a ticket recipe runs as a one-item
// plan, approved by its runner; a goal recipe is an owner turn to the lead.
export function recipeDone(answer: RecipeRun, recipe: Recipe, t: Translate): { readonly text: string; readonly href: string | null } {
  if (recipe.kind === 'goal') return { text: t('recipe_ran_goal', { name: recipe.name }), href: '/lead' };
  return { text: t('recipe_ran_plan', { name: recipe.name }), href: answer.plan ? `/plans/${encodeURIComponent(answer.plan)}` : null };
}

export function recipeFailure(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  return status === 400 ? 'recipe_refused' : status === 404 ? 'recipe_gone' : status === 503 ? 'recipe_off' : 'recipe_failed';
}

// The services picked are dropped once the title is cleared, which hides
// their chips: none is posted with the next title unseen (issue 210, item 1).
export const pickedFor = (title: string, picked: readonly string[]): readonly string[] => (title.trim() ? picked : []);

// "3 live sessions · landing LOCAL-169", or "quiet": the sessions, then the
// train, which the line draws apart so that only a rollback is in red.
export function serviceParts(row: ServiceRow, t: Translate): { readonly live: string | null; readonly train: string | null } {
  const live = row.live > 0 ? plural(row.live, 'service_live', t) : null;
  const train = row.landing ? t('service_landing', { ticket: row.landing }) : row.rolledBack ? t('service_rolled_back', { ticket: row.rolledBack }) : null;
  return { live, train };
}

export function serviceState(row: ServiceRow, t: Translate): string {
  const { live, train } = serviceParts(row, t);
  return [live, train].filter(Boolean).join(' · ') || t('service_quiet');
}

export const serviceTone = (row: ServiceRow): string => (row.landing ? 'landing' : row.rolledBack ? 'rolled_back' : row.live > 0 ? 'live' : 'quiet');

export function takenOverText(taken: TakenOverCard, t: Translate): string {
  return t(taken.you ? 'taken_over_you' : 'taken_over_other', { age: duration(taken.minutes, t) });
}

// "18 min", "1 h 24", "2 j 4 h": the app's one formatter (lib/time.ts).
export { duration };

export function heading(count: number, t: Translate): string {
  return count <= 5 ? t(`needs_${count}`) : t('needs_many', { n: count });
}

export const plural = (n: number, key: string, t: Translate) => t(n === 1 ? `${key}_one` : `${key}_other`, { n });

// A number with the catalog's decimal mark.
const decimal = (value: string, t: Translate) => value.replace('.', t('decimal_mark'));

export function planDetail(values: Readonly<Record<string, string>>, t: Translate): string {
  const n = Number(values.n);
  const time = estimate(Number(values.minutes), t);
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

// What the bar sends to create a ticket: the title, the description only
// when one was written, and the services picked only when some were (the
// service takes a non-empty list or nothing).
export function newTicket(title: string, body: string, project: string, services: readonly string[] = []): CreateTicketBody {
  const text = body.trim();
  return { title: title.trim(), project, ...(text ? { body: text } : {}), ...(services.length ? { services: [...services] } : {}) };
}

export function createTicket(api: ScreenContext['api'], input: { readonly title: string; readonly body: string; readonly project: string; readonly services?: readonly string[] }): Promise<Ticket> {
  return api<Ticket>('/tickets', { method: 'POST', body: newTicket(input.title, input.body, input.project, input.services) });
}

// What a need's card says under its title: the item's own words, then the catalog's sentence.
export function needSentence(card: NeedCard, t: Translate): string {
  const sentence = card.kind === 'plan' ? planDetail(card.detailValues, t) : card.detailKey ? t(card.detailKey, card.detailValues) : '';
  const why = card.request ? requestReason(card.request, card.request.suggestion, t) : {};
  return [card.detail || why.said || why.raw, sentence].filter(Boolean).join(' ');
}

export function needId(card: NeedCard, t: Translate): string {
  return card.kind === 'plan' ? t('need_goal') : card.owner === 'lead' ? t('need_lead') : card.ticket;
}

export const harnessSquare = (harness: Harness): 'claude' | 'codex' | 'other' => (harness === 'claude-code' ? 'claude' : harness === 'codex' ? 'codex' : 'other');

// A session taken over does not pulse: nobody but the person works in it.
export function liveDot(phase: ApiSessionPhase, role: Role, takenOver: TakenOverCard | null = null): string {
  if (takenOver) return 'live taken';
  return phase === 'waiting_human' ? 'live waiting' : role === 'reviewer' ? 'live review' : 'live';
}

export function leadState(lead: LeadCard | null, t: Translate): { readonly text: string; readonly kind: string } {
  if (!lead || lead.phase === 'down') return { text: t('lead_down'), kind: 'down' };
  if (lead.phase === 'starting') return { text: t('lead_starting'), kind: 'starting' };
  if (lead.phase === 'refreshing') return { text: t('lead_refreshing'), kind: 'refreshing' };
  const parts = [t('lead_on')];
  if (lead.percent !== null) parts.push(t('lead_context', { n: lead.percent }));
  if (lead.refreshed !== null) parts.push(t('lead_refreshed', { ago: ago(lead.refreshed.at, lead.refreshed.now, t) }));
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
  const [sessions, inbox, tickets, lead, messages, plans, workspace, recipes, schedules] = await Promise.all([
    api<SessionSummary[]>('/sessions'), api<NextInboxItem[]>('/inbox'), api<Ticket[]>('/tickets'),
    optional<LeadState | null>('/lead', null),
    optional<LeadMessage[]>(thread.after > 0 ? `/lead/messages?after=${thread.after}` : '/lead/messages', []),
    optional<Plan[]>('/plans', []),
    optional<Workspace | null>('/workspace', null),
    optional<Recipe[] | null>('/recipes', null),
    optional<Schedule[] | null>('/schedules', null),
  ]);
  // A live author's step, in a workspace of several services only, each ticket read once.
  const live = Array.isArray(workspace?.services) && workspace.services.length >= 2 ? [...new Set(sessions.filter((s) => s.role === 'author' && isLive(s)).map((s) => s.ticket))] : [];
  const steps = Object.fromEntries(await Promise.all(live.map(async (ticket) => [ticket, await optional<TicketStep[]>(`/tickets/${encodeURIComponent(ticket)}/steps`, [])] as const)));
  const next = lastLeadLine(messages, thread);
  return { data: { sessions, inbox, tickets, lead, leadLine: next.line, plans, weekLeft: null, workspace, recipes, schedules, steps }, thread: next };
}
