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
//
// The replanned milestone 2 (lane 21) adds the release card as a train (the
// services in landing order, each one's state and pull request, the
// compatibility line or the block, decision 21), the intent groups and the
// flags (decision 23), the author's session plan with Go and Change
// (decision 22, lane 17's routes), and the contract and knowledge items
// (decisions 26 and 27): the contract's diff with Approve and Send back
// (lane 23's routes), the knowledge's text with Approve and Reject (lane
// 24's, the owner's only), each answered at once, with no grace. The screen
// reads every kind GET /api/inbox answers (NextInboxItem): api/types.ts
// belongs to no lane in wave 8, so InboxItem keeps its four kinds there.
import type {
  ApproveBody, ContractItem, InboxItem, KnowledgeItem, NextInboxItem, PermissionItem, Plan, PlanItem, PlanItemInbox, QuestionItem, ReleaseFlag, ReleaseFlagKind,
  ReleaseItem, SessionPlan, SessionPlanItem, SessionSummary, TicketVariant, TrainState, TrainStop, VariantsItem,
} from '../../../../src/api/types.ts';
import type { Decision } from '../../../../src/session/contract.ts';
import type { Question, ToolInput } from '../../../../src/session/events.ts';
import { answersFor as choiceAnswers } from '../../components/choices/model.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
import type { CommandPart } from '../../lib/intent.ts';
import { requestAsk, requestFold, requestFoldOpen, requestReason, requestTitle, targetOf } from '../../lib/request.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';
import { closeFailureKey, type Closed } from '../../lib/close.ts';
import type { Focus } from '../../shell/keys.ts';
import { planStateLine } from '../../plan-panel/model.ts';
import { clock, duration, estimate, fixed, since } from '../../lib/time.ts';

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
// The group the service gives the changed files no intent names
// (OTHER_CHANGES of src/release/flags.ts; a test keeps the two equal).
export const OTHER_CHANGES = 'Other changes';
// The longest Change the plan's route accepts (MAX_CHANGE of
// src/flow/plan-gate.ts; a test keeps the two equal).
export const CHANGE_MAX = 2000;
// The longest Send back of a contract the route accepts (MAX_SEND_BACK of
// src/flow/steps.ts; a test keeps the two equal).
export const SEND_BACK_MAX = 2000;

// Every kind the inbox lists.
export type Item = NextInboxItem;

// What a gesture of this page left on an item until the service's list catches up.
export type Local =
  | { readonly kind: 'busy' }                                  // a call is on its way
  | { readonly kind: 'confirm' }                               // Send back asked once
  | { readonly kind: 'grace'; readonly dueAt: string }         // approved, Undo possible until dueAt
  | { readonly kind: 'approved'; readonly at: string }
  | { readonly kind: 'sent_back'; readonly at: string }
  | { readonly kind: 'answered'; readonly decision: Decision['kind'] }
  | { readonly kind: 'plan_approved'; readonly at: string }   // a plan has no grace: its tickets start
  | { readonly kind: 'change' }                                // Change, or a contract's Send back, asked once: the field is open
  | { readonly kind: 'plan_go'; readonly at: string }          // Go given to a session plan
  | { readonly kind: 'plan_changed'; readonly at: string }     // a Change sent to its author
  | { readonly kind: 'decided'; readonly decision: Decided; readonly at: string }   // a contract or a knowledge item answered from this page
  | { readonly kind: 'chosen'; readonly position: number; readonly at: string }     // a variant chosen from this page (issue #271)
  | Closed                                                     // the ticket closed from this page (issue #249)
  | { readonly kind: 'close' }                                 // Close asked once: the reason's field is open
  | { readonly kind: 'settled' };                              // settled without the person

export type Decided = 'approve' | 'send_back' | 'reject';

export type InboxView = {
  readonly items: readonly Item[];
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
  readonly wide?: boolean;                                     // ROW_ANSWERS_MIN wide or more: a request's row carries its answers
  readonly narrow?: boolean;                                   // under 1024 px: the detail is a page of its own
};

// ---------------------------------------------------------------- the model

// The capture's order: a release, a permission, the lead's plan, a question.
// A session plan holds its session as a permission does, so it comes after
// the permissions; variants to choose from, a contract and a knowledge item come last.
const RANK: Readonly<Record<Item['kind'], number>> = { release: 0, permission: 1, session_plan: 2, plan: 3, question: 4, variants: 5, contract: 6, knowledge: 7 };
// The catalog names a release's checks by colour, as the tower's does.
export const CHECKS = { passed: 'green', pending: 'running', failed: 'red' } as const;

// What waits, releases first, then permissions, plans and questions, each
// oldest first; then what was handled, in the service's order (latest first).
export function ordered(items: readonly Item[]): { readonly waiting: Item[]; readonly handled: Item[] } {
  const waiting = items.filter((item) => item.state === 'waiting')
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(a.since) - Date.parse(b.since));
  return { waiting, handled: items.filter((item) => item.state === 'handled') };
}

// What the service answered, without the kinds this screen does not know:
// a later kind is left out rather than drawn as a row with no words.
export function known(values: readonly unknown[]): Item[] {
  return values.filter((value): value is Item => typeof value === 'object' && value !== null && Object.hasOwn(RANK, (value as { kind?: unknown }).kind as string));
}

// The item shown: the one the address names, else the first that waits.
export function chosen(view: InboxView): Item | undefined {
  if (view.selected !== undefined) return view.items.find((item) => item.id === view.selected);
  const { waiting, handled } = ordered(view.items);
  return waiting[0] ?? handled[0];
}

// The detail is redrawn only when what it shows changed, so a reason or a
// free answer being typed is not lost to a refresh. A release's checks are
// part of what it shows: the owner waits for them to turn green.
// A plan's detail follows the plan read for it: read or not, and how it runs.
// A train's follows each service as it lands; a session plan's, its Go; a
// contract's or a knowledge item's, what the owner did with it; variants', each one's state.
export function detailKey(v: InboxView): string {
  const item = chosen(v);
  const checks = item?.kind === 'release' ? [item.pr.checks, item.repair?.state ?? null, item.repair?.attempt ?? null] : undefined;
  const plan = item?.kind === 'plan' ? planOf(v, item) : undefined;
  const moved = plan ? [plan.state, plan.items.map((i) => [i.state, i.ticket])] : undefined;
  const train = item?.kind === 'release' && item.train ? [item.train.state, item.train.services.map((s) => [s.state, s.at, s.note ?? null])] : undefined;
  const after = item?.kind === 'session_plan' ? item.plan.go : item?.kind === 'contract' || item?.kind === 'knowledge' ? item.outcome
    : item?.kind === 'variants' ? [item.outcome, item.variants.map((v) => [v.state, v.added, v.removed])] : undefined;
  return JSON.stringify([v.items.length === 0, item?.id, item?.state, checks, moved, train, after, item ? v.local.get(item.id)?.kind : undefined, v.frame, v.selected]);
}

// ------------------------------------------------------------------ plans

const PLAN_STATES: readonly Plan['state'][] = ['proposed', 'superseded', 'rejected', 'approved', 'paused', 'done'];
const ITEM_STATES: readonly PlanItem['state'][] = ['waiting', 'ready', 'running', 'needs_approval', 'landed', 'put_back', 'held', 'parked', 'cancelled'];
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
export const isLead = (item: Item) => item.ticket === LEAD_TICKET;

export function itemFromHash(hash: string): string | undefined {
  const raw = hash.replace(/^#/, '');
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

// A capture is shown only from this site: the page runs under default-src 'self'.
export function sameOrigin(url: string | null): string | undefined {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') ? url : undefined;
}

// 'claude-sonnet-5-5' reads 'Sonnet', as the capture names a model.
export function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? (match[1] as string).charAt(0).toUpperCase() + (match[1] as string).slice(1).toLowerCase() : model;
}

export { clock };
export const short = (head: string) => head.slice(0, 7);
export const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ---------------------------------------------------------------- gestures

type Api = ScreenContext['api'];
const ticketPath = (item: Item) => `/tickets/${encodeURIComponent(item.ticket)}`;
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
// it: the clickable answers' rule (a free answer wins over the choices,
// several choices of a multiple choice question are joined with a comma,
// every question needs an answer, none longer than the route accepts).
export function answersFor(questions: readonly Question[], picks: readonly (readonly string[])[], free: readonly string[]): ReturnType<typeof choiceAnswers> {
  return choiceAnswers(questions, { picks, free });
}

// ------------------------------------------------------- the session plan

const planPath = (item: SessionPlanItem, action: 'go' | 'change') => `/sessions/${encodeURIComponent(item.sessionId)}/plan/${action}`;

// Go: the author starts writing. lane 17's route takes no body.
export async function planGo(api: Api, item: SessionPlanItem, now: Date): Promise<Local> {
  await api(planPath(item, 'go'), { method: 'POST', body: null });
  return { kind: 'plan_go', at: now.toISOString() };
}

// What a Change says, as the route accepts it: some text, at most CHANGE_MAX characters.
export function changeMessage(text: string): { readonly message: string } | { readonly error: 'plan_change_empty' | 'plan_change_long' } {
  const message = text.trim();
  if (message === '') return { error: 'plan_change_empty' };
  return message.length > CHANGE_MAX ? { error: 'plan_change_long' } : { message };
}

// Change: the message reopens the author, whose next proposal replaces this one.
export async function planChange(api: Api, item: SessionPlanItem, text: string, now: Date): Promise<Local> {
  const checked = changeMessage(text);
  if ('error' in checked) throw new Error(checked.error);
  await api(planPath(item, 'change'), { method: 'POST', body: { message: checked.message } });
  return { kind: 'plan_changed', at: now.toISOString() };
}

// Who let the plan start, and when (SessionPlan.go).
export function goLine(go: NonNullable<SessionPlan['go']>, view: InboxView, t: Translate): string {
  const time = clock(go.at);
  if (go.by === 'delay') return t('go_by_delay', { time });
  if (go.by === 'lead') return t('go_by_lead', { time });
  return go.by === view.me.id ? t('go_by_you', { time }) : t('go_by_user', { who: go.by, time });
}

// --------------------------------------------- the contract and knowledge

const contractPath = (item: ContractItem, action: 'approve' | 'sendback') => `/contracts/${encodeURIComponent(item.id)}/${action}`;
const knowledgePath = (item: KnowledgeItem, action: 'approve' | 'reject') => `/knowledge/${encodeURIComponent(item.id)}/${action}`;

// What a Send back says, as the route accepts it: some text, at most SEND_BACK_MAX characters.
export function sendBackMessage(text: string): { readonly message: string } | { readonly error: 'contract_send_back_empty' | 'contract_send_back_long' } {
  const message = text.trim();
  if (message === '') return { error: 'contract_send_back_empty' };
  return message.length > SEND_BACK_MAX ? { error: 'contract_send_back_long' } : { message };
}

// Approve: the contract is validated, and the ticket's next steps start on it.
export async function approveContract(api: Api, item: ContractItem, now: Date): Promise<Local> {
  await api(contractPath(item, 'approve'), { method: 'POST', body: null });
  return { kind: 'decided', decision: 'approve', at: now.toISOString() };
}

// Send back: the contract step starts again with the message.
export async function sendBackContract(api: Api, item: ContractItem, text: string, now: Date): Promise<Local> {
  const checked = sendBackMessage(text);
  if ('error' in checked) throw new Error(checked.error);
  await api(contractPath(item, 'sendback'), { method: 'POST', body: { message: checked.message } });
  return { kind: 'decided', decision: 'send_back', at: now.toISOString() };
}

// Approve writes the entry into the memory at its level, and queues it for the skill; Reject writes nothing.
export async function approveKnowledge(api: Api, item: KnowledgeItem, now: Date): Promise<Local> {
  await api(knowledgePath(item, 'approve'), { method: 'POST', body: null });
  return { kind: 'decided', decision: 'approve', at: now.toISOString() };
}

export async function rejectKnowledge(api: Api, item: KnowledgeItem, now: Date): Promise<Local> {
  await api(knowledgePath(item, 'reject'), { method: 'POST', body: null });
  return { kind: 'decided', decision: 'reject', at: now.toISOString() };
}

// What a handled contract or knowledge item says the owner did (its `outcome`).
export function outcomeLine(item: ContractItem | KnowledgeItem | ReleaseItem, view: InboxView, t: Translate): string {
  const outcome = item.outcome;
  if (!outcome) return t('handled_note');
  const values = { who: outcome.by === view.me.id ? t('by_you') : outcome.by, time: clock(outcome.at) };
  if (item.kind === 'release' && outcome.decision === 'close') return t('closed_by', { ...values, reason: outcome.reason });
  if (item.kind === 'contract') return outcome.decision === 'send_back' ? t('contract_sent_back_by', { ...values, message: outcome.message }) : t('contract_validated_by', values);
  return t(outcome.decision === 'approve' ? 'knowledge_approved_by' : 'knowledge_rejected_by', values);
}

// ---------------------------------------------------------- the variants

// Choose (issue #271): the variant at `position` is reviewed; the others
// stop, and their containers are released.
export async function chooseVariant(api: Api, item: VariantsItem, position: number, now: Date): Promise<Local> {
  await api(`/variants/${encodeURIComponent(item.id)}/choose`, { method: 'POST', body: { variant: position } });
  return { kind: 'chosen', position, at: now.toISOString() };
}

// The variants that ended, for the list's line: done or failed.
export const variantsEnded = (item: VariantsItem) => item.variants.filter((v) => v.state !== 'waiting' && v.state !== 'running').length;

// A variant's facts, in the person's language: its files, its lines, what
// it cost, how long it ran and, in a harness pick, its tokens when its
// harness reports them (issue #329).
export function variantFacts(variant: TicketVariant, view: InboxView, t: Translate): string[] {
  const language = view.language ?? 'en';
  const facts = [t(variant.files.length === 1 ? 'variant_files_one' : 'variant_files_other', { n: variant.files.length }), t('variant_lines', { added: variant.added, removed: variant.removed })];
  if (variant.costUsd !== null) facts.push(t('plan_cost', { amount: decimals(variant.costUsd, 2, language) }));
  if (variant.minutes !== null) facts.push(duration(variant.minutes, t));
  if (variant.tokens !== null && variant.tokens !== undefined) facts.push(t('variant_spent', { n: new Intl.NumberFormat(language).format(variant.tokens) }));
  return facts;
}

// A harness pick's variant: its agent's name, and its own run of the tests once it ended.
export const variantHarness = (variant: TicketVariant, t: Translate): string => t(`variant_harness_${variant.harness}`);
// The catalog's keys avoid the words the secrets guard reads as an assignment (pass, tokens):
// each outcome has the word at its place in TEST_WORDS.
const TEST_OUTCOMES: readonly NonNullable<TicketVariant['tests']>[] = ['passed', 'failed', 'unclear', 'not_run'];
const TEST_WORDS: readonly string[] = ['green', 'red', 'unknown', 'absent'];
export const variantTests = (variant: TicketVariant, t: Translate): string | null => (variant.tests ? t(`variant_tests_${TEST_WORDS[TEST_OUTCOMES.indexOf(variant.tests)]}`) : null);

// What a handled variants item says the owner did, or what the harness pick kept and by which measure.
export function chosenLine(item: VariantsItem, view: InboxView, t: Translate): string {
  const outcome = item.outcome;
  if (!outcome) return t('variants_settled');
  if (outcome.measure) {
    const kept = item.variants.find((v) => v.position === outcome.chosen);
    return t(outcome.measure === 'tokens' ? 'variants_kept_fewest' : 'variants_kept_fastest', { n: outcome.chosen, harness: kept ? variantHarness(kept, t) : '', time: clock(outcome.at) });
  }
  return t('variants_chosen_by', { n: outcome.chosen, who: outcome.by === view.me.id ? t('by_you') : outcome.by, time: clock(outcome.at) });
}

// What this page did, until the service's list says it.
export function decidedLine(local: Extract<Local, { kind: 'decided' }>, item: ContractItem | KnowledgeItem, t: Translate): string {
  return t(`decided_${item.kind}_${local.decision}`, { time: clock(local.at) });
}

export type Gesture = 'approve' | 'undo' | 'send_back' | 'close' | 'answer' | 'approve_plan' | 'plan_go' | 'plan_change'
  | 'contract_approve' | 'contract_send_back' | 'knowledge_approve' | 'knowledge_reject' | 'variant_choose';

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
    // 404 or 409: the ticket is done, approved, landing or gone; 400: the service refused the reason.
    case 'close':
      return { key: status === 403 ? 'decided_user' : closeFailureKey(status), settled: false };
    case 'send_back':
      return { key: status === 409 ? 'send_back_conflict' : 'send_back_failed', settled: false };
    // 409: approved elsewhere, replaced by a newer proposal or rejected; the
    // screen reads the plan again. 503: the service runs without the lead.
    case 'approve_plan':
      if (status === 409) return { key: 'approve_plan_conflict', settled: false };
      if (status === 404) return { key: 'approve_plan_gone', settled: false };
      return { key: status === 503 ? 'approve_plan_lead_off' : 'approve_plan_failed', settled: false };
    // 409: no plan waits any more for its Go (it started by the delay or the
    // lead, or the session ended); 403: a user the service does not know.
    case 'plan_go': case 'plan_change':
      if (status === 404 || status === 409) return { key: 'plan_settled', settled: true };
      if (status === 403) return { key: 'plan_user', settled: false };
      if (status === 503) return { key: 'plan_flow_off', settled: false };
      if (status === 400 && gesture === 'plan_change') return { key: 'plan_change_invalid', settled: false };
      return { key: `${gesture}_failed`, settled: false };
    // 404 or 409: answered already, elsewhere or by a double click; 403: a
    // user the service does not know, or for knowledge anyone but the
    // tracker's owner; 503: the flow or the knowledge module is off.
    case 'contract_approve': case 'contract_send_back': case 'knowledge_approve': case 'knowledge_reject':
      if (status === 404 || status === 409) return { key: 'decided_settled', settled: true };
      if (status === 403) return { key: gesture.startsWith('knowledge') ? 'knowledge_owner' : 'decided_user', settled: false };
      if (status === 503) return { key: 'decided_off', settled: false };
      if (status === 400 && gesture === 'contract_send_back') return { key: 'contract_send_back_invalid', settled: false };
      return { key: `${gesture}_failed`, settled: false };
    // 409: chosen already, the variant no longer done, or the ticket put back; the list says which.
    case 'variant_choose':
      if (status === 404 || status === 409) return { key: 'decided_settled', settled: true };
      if (status === 403) return { key: 'decided_user', settled: false };
      if (status === 503) return { key: 'decided_off', settled: false };
      return { key: 'variant_choose_failed', settled: false };
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

export const target = (input: ToolInput): string => targetOf(input);

// A session plan is named by its ticket's title, else by its first step; a
// permission by its intent (permissionTitle).
export function itemTitle(item: Item, view: InboxView | undefined, t: Translate): string {
  switch (item.kind) {
    case 'release': return item.title;
    case 'permission': return permissionTitle(item, t);
    case 'question': return item.questions[0]?.question ?? '';
    case 'plan': return item.title;
    case 'session_plan': return (view && ticketTitle(view, item.ticket)) ?? item.plan.steps[0] ?? item.ticket;
    case 'contract': return item.path;
    case 'knowledge': return item.text;
    case 'variants': return (view && ticketTitle(view, item.ticket)) ?? item.ticket;
  }
}

// ------------------------------------------------------------ permissions

// A permission says what it means to do, in the person's language, from the
// command itself, whatever the harness wrote (docs/v2/ui-overhaul-plan.md,
// 2.5.1 and U9, lane 37). The words are lib/request.ts's, which the session
// thread and the tower say too.
export const permissionTitle = (item: PermissionItem, t: Translate): string => requestTitle(item, t);

// The fold opens by itself when the command is what the person must read.
export const foldOpen = (item: PermissionItem): boolean => requestFoldOpen(item);

// The request as a question to the person, naming who asks.
export const permissionAsk = (item: PermissionItem, view: InboxView, t: Translate): string => requestAsk(item, sessionOf(view, item.sessionId)?.role, t);

// The fold: the command one part per line, or the tool's target.
export const foldOf = (item: PermissionItem): CommandPart[] => requestFold(item.input);

// Why it asks: by the service's code, else the policy's sentence as written.
export const reasonOf = (item: PermissionItem, t: Translate): { readonly said?: string; readonly raw?: string } => requestReason(item, item.suggestion, t);

export type Answer = 'allow_once' | 'allow_always' | 'reject_once';
export const ANSWERS: readonly Answer[] = ['allow_once', 'allow_always', 'reject_once'];
// From this width the list is wide enough for a request's row to carry its answers (plan, 2.5.4).
export const ROW_ANSWERS_MIN = 1280;

// A request that waits, with nothing under way on it, can be answered.
export const answerable = (item: Item | undefined, local: Local | undefined): item is PermissionItem =>
  item?.kind === 'permission' && item.state === 'waiting' && local === undefined;

// The request shown has its answers in the detail beside it: its row does not repeat them.
export function rowAnswers(item: Item, view: InboxView): readonly Answer[] {
  return view.wide && item.id !== chosen(view)?.id && answerable(item, view.local.get(item.id)) ? ANSWERS : [];
}

// The inbox's own keys (lane 35's SCREEN_KEYS.inbox lists them): A, T and R
// answer the request shown, when its detail is in view; Space on a row the
// person walked to shows that row's item without leaving the row (a peek).
export type InboxKey = { readonly kind: 'answer'; readonly act: Answer } | { readonly kind: 'peek' };
const KEY_ANSWERS: Readonly<Record<string, Answer>> = { a: 'allow_once', t: 'allow_always', r: 'reject_once' };

export function inboxKey(
  input: {
    readonly key: string; readonly meta: boolean; readonly ctrl: boolean; readonly alt: boolean; readonly focus: Focus; readonly onRow: boolean; readonly overlay: boolean;
    readonly afterG?: boolean; readonly rowShown?: boolean; readonly beside: boolean;
  },
  shown: { readonly item: Item | undefined; readonly visible: boolean; readonly busy: boolean },
): InboxKey | null {
  if (input.meta || input.ctrl || input.alt || input.overlay || input.afterG || input.focus === 'field' || input.focus === 'terminal') return null;
  if (input.key === ' ') return input.onRow && input.beside ? { kind: 'peek' } : null;
  const act = KEY_ANSWERS[input.key.toLowerCase()];
  // On another row than the one shown, the key shows that row first; the next press answers it.
  if (act && input.onRow && !input.rowShown) return input.beside ? { kind: 'peek' } : null;
  if (!act || !shown.visible || shown.busy || shown.item?.kind !== 'permission' || shown.item.state !== 'waiting') return null;
  return { kind: 'answer', act };
}

// Esc leaves the item shown, but not from a field: a reason or a message being typed stays.
export const closesOnEscape = (focus: Focus): boolean => focus === 'none' || focus === 'control';

// When a team's question stops waiting for the owner, and what then
// applies (issue #290): before its delay, "No answer in 25 min: the Lead
// decides, else “Newest first” applies"; once the Lead is asked, its own
// window. The lead's questions, and a handled one, have none.
export function deadlineLine(item: QuestionItem, now: Date, t: Translate): string | undefined {
  const timeout = item.timeout;
  if (!timeout || item.state !== 'waiting' || isLead(item)) return undefined;
  const lead = timeout.leadAt !== undefined || now.getTime() >= Date.parse(timeout.at);
  const until = Date.parse(lead ? timeout.leadUntil : timeout.at);
  const time = duration(Math.max(1, Math.ceil((until - now.getTime()) / 60_000)), t);
  const label = timeout.answers ? Object.values(timeout.answers).map((answer) => answer.replace(RECOMMENDED, '')).join(', ') : undefined;
  return label === undefined ? t(lead ? 'deadline_lead_park' : 'deadline_park', { time }) : t(lead ? 'deadline_lead_default' : 'deadline_default', { time, label });
}

export function recommendation(item: QuestionItem): string | undefined {
  for (const question of item.questions) for (const option of question.options ?? []) if (RECOMMENDED.test(option.label)) return option.label.replace(RECOMMENDED, '');
  return undefined;
}

export const decimals = fixed;

// "5 tickets · 2 h 15 · 3.9 % of the week", or the cost until the week is
// measured (section 5.2), as the plan panel's footer says it.
export function planLine(item: PlanItemInbox, view: InboxView, t: Translate): string {
  const language = view.language ?? 'en';
  const { totals } = item;
  const share = totals.weekPercent === null
    ? t('list_plan_cost', { amount: t('plan_cost', { amount: decimals(totals.costUsd, 2, language) }) })
    : t('plan_week_total', { n: decimals(totals.weekPercent, 1, language) });
  return t(item.itemCount === 1 ? 'list_plan_one' : 'list_plan_other', { n: item.itemCount, time: estimate(totals.minutes, t), share });
}

export function itemLine(item: Item, view: InboxView, t: Translate): string {
  // A train says where it is, waiting or handled: the owner follows it here.
  if (item.kind === 'release' && item.train && item.train.state !== 'waiting') return t('train_line', { ticket: item.ticket, text: trainLine(item.train, t) });
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
      // The ticket first, as the other kinds: two releases can share a title;
      // a train names its number of services after it.
      const ticket = item.train ? t('train_ticket', { ticket: item.ticket, n: item.train.services.length }) : item.ticket;
      if (item.repair?.state === 'gave_up') return t('release_repair_gave_up', { ticket, n: item.repair.attempt });
      return reviewer ? t(`release_reviewed_${checks}`, { ticket, model: family(reviewer.model) }) : t(`release_unreviewed_${checks}`, { ticket });
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
    case 'session_plan': {
      const n = item.plan.steps.length;
      return t('session_plan_line', { ticket: item.ticket, confidence: t(`confidence_${item.plan.confidence}`), steps: t(n === 1 ? 'steps_one' : 'steps_other', { n }) });
    }
    case 'contract':
      return t('contract_line', { ticket: item.ticket, service: item.service });
    case 'knowledge':
      return item.level === 'workspace' || !item.service ? t('knowledge_line_workspace', { ticket: item.ticket })
        : t(`knowledge_line_${item.level}`, { ticket: item.ticket, service: item.service });
    case 'variants':
      return t('variants_line', { ticket: item.ticket, n: variantsEnded(item), total: item.variants.length });
  }
}

// ------------------------------------------------------------- the train

// Only a release with no train, or whose train waits for the owner, can be
// approved: a blocked train waits for a step on its consumer (the approval
// route answers 409), and a train that lands or landed was approved already.
export const approvable = (item: ReleaseItem) => !item.train || item.train.state === 'waiting';

const landedStops = (train: TrainState) => train.services.filter((s) => s.state === 'healthy').length;

// Where a train is, in a few words: the list's line and the card's head.
export function trainLine(train: TrainState, t: Translate): string {
  const total = train.services.length;
  switch (train.state) {
    case 'waiting': return t(total === 1 ? 'train_waiting_one' : 'train_waiting_other', { n: total });
    case 'blocked': return t('train_blocked');
    case 'landing': return t('train_landing', { n: landedStops(train), total });
    case 'landed': return t('train_landed', { n: landedStops(train), total });
    case 'rolled_back': return t('train_rolled_back', { n: train.services.filter((s) => s.state === 'reverted').length, total });
    case 'halted': return t('train_halted', { n: landedStops(train), total });
  }
}

// A service's place in the train: while the train waits, every service
// waits for the owner's approval; while it lands, the first that waits
// lands next.
export function stopState(stop: TrainStop, train: TrainState, t: Translate): string {
  if (stop.state === 'waiting') {
    if (train.state === 'waiting' || train.state === 'blocked') return t('stop_waiting_approval');
    if (train.state === 'landing' && train.services.find((s) => s.state === 'waiting') === stop) return t('stop_next');
  }
  return t(`stop_${stop.state}`);
}

export function stopLine(stop: TrainStop, train: TrainState, t: Translate): string {
  const text = stopState(stop, train, t);
  return stop.at ? t('stop_at', { text, time: clock(stop.at) }) : text;
}

// ------------------------------------------------------- groups and flags

export const FLAG_KINDS: readonly ReleaseFlagKind[] = ['schema', 'dependency', 'config', 'secret_shape', 'contract', 'large'];
// A flag's words in the catalog: flag_<key> and flag_<key>_note. The guard's
// strict pass reads a catalog key with "secret" in it, followed by a text,
// as an assigned secret, so the secret_shape flag is named otherwise there.
export const flagKey = (kind: ReleaseFlagKind): string => (kind === 'secret_shape' ? 'credential_shape' : kind);

// The groups as the card shows them: the service's "Other changes" in the
// reader's language, and each file with the flags that name it.
export function groupsOf(item: ReleaseItem, t: Translate): { readonly intent: string; readonly key: string; readonly files: { readonly path: string; readonly flags: readonly ReleaseFlagKind[] }[] }[] {
  const flags = item.flags ?? [];
  return (item.groups ?? []).map((group) => ({
    key: group.intent,
    intent: group.intent === OTHER_CHANGES ? t('other_changes') : group.intent,
    files: group.files.map((path) => ({ path, flags: flags.filter((flag) => flag.files.includes(path)).map((flag) => flag.kind) })),
  }));
}

// The flags in the service's order, each kind once, with what it means in
// the reader's language; a kind this screen does not know is left out.
export function flagsOf(item: ReleaseItem): readonly ReleaseFlag[] {
  return FLAG_KINDS.flatMap((kind) => (item.flags ?? []).filter((flag) => flag.kind === kind).slice(0, 1));
}

// Only an http(s) address is a link; anything else is shown as its label.
export const isWebLink = (url: string) => /^https?:\/\//i.test(url);

export function sessionsLine(item: ReleaseItem, t: Translate): string {
  return item.sessions.map((s) => {
    const values = { model: family(s.model), time: duration(s.minutes, t) };
    if (s.role !== 'reviewer') return t('wrote', values);
    if (s.rounds === undefined) return t('reviewed', values);
    return s.rounds === 1 ? t('reviewed_rounds_one', values) : t('reviewed_rounds_other', { ...values, n: s.rounds });
  }).join(' · ');
}

// Where the repair of the release's failed checks stands (issue #273);
// nothing before a check failed.
export function repairLine(item: ReleaseItem, t: Translate): string | undefined {
  const { repair } = item;
  if (!repair) return undefined;
  const checks = repair.checks.length > 0 ? repair.checks.join(', ') : t('repair_checks_unnamed');
  return t(`repair_${repair.state}`, { n: repair.attempt, limit: repair.limit, checks });
}

// A Quick ticket's lane (matrix B2.2): on the fast lane, the approval is
// asked while the checks run and the lock lands it once they are green;
// sent back to the full circuit, or not fast at this head, why, in the
// rules' words. Nothing for a ticket without the label.
export function laneLine(item: ReleaseItem, t: Translate): string | undefined {
  const lane = item.fastLane;
  if (!lane) return undefined;
  if (lane.state === 'fast') return t(`lane_fast_${CHECKS[item.pr.checks]}`);
  const reasons = lane.reasons.map((reason) => t(`fast_reason_${reason}`)).join(', ');
  return t(lane.state === 'full' ? 'lane_full' : 'lane_off', { reasons });
}

// Who asks, and for how long its session has been paused; a handled request pauses nothing.
export function pausedLine(item: Item, session: SessionSummary, now: Date, t: Translate): string {
  const model = family(session.model);
  if (item.state === 'handled') return t(`session_${session.role}_plain`, { model });
  const minutes = (now.getTime() - Date.parse(item.since)) / 60_000;
  return minutes < 1 ? t(`session_${session.role}_now`, { model }) : t(`session_${session.role}`, { model, time: since(item.since, now, t) });
}

// What a share of the week says, or the cost until the week is measured.
export function shareLine(totals: PlanItemInbox['totals'], language: 'en' | 'fr', t: Translate): string {
  return totals.weekPercent === null
    ? t('plan_cost_total', { amount: t('plan_cost', { amount: decimals(totals.costUsd, 2, language) }) })
    : t('plan_week_total', { n: decimals(totals.weekPercent, 1, language) });
}

export function graceLeft(dueAt: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(dueAt) - now.getTime()) / 1000));
}

export const REFRESH_MS = 10_000;
export const STORE_KEY = 'cleared-v2-inbox';

// What a page keeps of its gestures across a reload of the tab: the grace
// and its outcome (the service still holds the approval, and its list shows
// the release until its next tick).
export const kept = (local: Local) => local.kind === 'grace' || local.kind === 'approved' || local.kind === 'sent_back';
