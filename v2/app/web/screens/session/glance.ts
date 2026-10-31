// The session in five seconds (the owner's request of 2026-10-31, issue #499):
// the one thing it expects from the person, what it does now in one sentence,
// where the ticket is, its cost and duration, its result. Pure, so the tests run
// it under Node (test/session/glance.test.tsx); Session.tsx draws what it says.
//
// The sentence comes from the catalog alone. A harness's status and a command's
// description are its own words, in any language and full of paths, so they stay
// in the fold; a command the table cannot say is "a command".
//
// The stage is the ticket's, out of five, read from what the service knows. No
// event says which step of its own plan an agent has reached, so the screen lists
// that plan without a mark rather than invent a position in it (decisions log,
// lane j7-session).
import type { NextInboxItem, SessionPlan } from '../../../../src/api/types.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { blocksOf, runsOf, type Run } from '../../components/markdown/model.ts';
import { intentSentence, intentsOf } from '../../lib/intent.ts';
import type { Translate } from '../../lib/i18n.ts';
import { opaque } from '../../lib/request.ts';
import { count, lasted } from '../../lib/time.ts';
import { ENDED, phaseOf, takenOverOf, type QuestionRow, type RequestState, type Row, type SessionThread, type SessionView, type ToolRow } from './model.ts';
import { partsOf, type TicketPart } from './ticket.ts';

export type PullRequest = { readonly number: number; readonly url: string };
export type PendingAction = { readonly total: number } & (
  | { readonly kind: 'permission'; readonly session: string; readonly requestId: string; readonly row: ToolRow; readonly request: RequestState }
  | { readonly kind: 'question'; readonly session: string; readonly requestId: string; readonly row: QuestionRow }
  | { readonly kind: 'plan'; readonly session: string; readonly plan: SessionPlan }
  | { readonly kind: 'review'; readonly what: NextInboxItem['kind']; readonly href: string; readonly pr?: PullRequest }
  | { readonly kind: 'giveback' }
);
export const STAGES = ['prepare', 'write', 'review', 'decide', 'ship'] as const;
export type StageKey = (typeof STAGES)[number];
export type Stage = { readonly key: StageKey; readonly state: 'done' | 'current' | 'failed' | 'todo' };
export type StageView = { readonly stages: readonly Stage[]; readonly current: number; readonly total: number };
export type Capture = { readonly kind: 'before' | 'after' | 'video' | 'production'; readonly service: string; readonly href: string };
export type Result = { readonly pr?: PullRequest; readonly captures: readonly Capture[] };
export type ServiceHome = { readonly name: string; readonly url: string };

// A session's phase as the screen reads it: its row says when it ended, else its thread (model.ts phaseOf).
const phaseOfPart = ({ summary, thread }: TicketPart) => (ENDED.has(summary.phase) ? summary.phase : thread?.state?.phase ?? summary.phase);
// A session that can still answer: running, or stopped by the watchdog while it waited (the answer resumes it).
const answers = (part: TicketPart): boolean => !ENDED.has(phaseOfPart(part)) || part.summary.dormant === true;
const THREADS_SAY: ReadonlySet<NextInboxItem['kind']> = new Set(['permission', 'question', 'session_plan']);
const waitingHere = (inbox: readonly NextInboxItem[], ticket: string) => inbox.filter((item) => item.ticket === ticket && item.state === 'waiting');

// What the person is asked for, never another ticket's: their own take over
// first, then the oldest request or question of the ticket's sessions, then its
// plan, then what waits in the inbox for this ticket, which signs there.
export function pendingAction(view: SessionView, inbox: readonly NextInboxItem[]): PendingAction | null {
  const taken = takenOverOf(view);
  if (taken && !ENDED.has(phaseOf(view))) {
    if (taken.by === view.me) return { kind: 'giveback', total: 1 };
  }
  const parts = partsOf(view);
  const asked = parts.filter(answers).flatMap((part) => (part.thread?.pending ?? []).flatMap((id) => {
    const row = part.thread?.rows.find((candidate) => (candidate.kind === 'question' && candidate.requestId === id) || (candidate.kind === 'tool' && candidate.request?.requestId === id && candidate.request.state === 'waiting'));
    if (!row || view.answers?.has(id)) return [];
    return [{ part, id, row: row as ToolRow | QuestionRow }];
  })).sort((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at));
  const first = asked[0];
  if (first) {
    const total = asked.length;
    if (first.row.kind === 'question') return { kind: 'question', session: first.part.summary.id, requestId: first.id, row: first.row, total };
    return { kind: 'permission', session: first.part.summary.id, requestId: first.id, row: first.row, request: first.row.request as RequestState, total };
  }
  if (!taken) {
    const planning = parts.filter((part) => part.summary.role === 'author' && answers(part) && part.thread?.plan?.go === null).at(-1);
    if (planning?.thread?.plan) return { kind: 'plan', session: planning.summary.id, plan: planning.thread.plan, total: 1 };
  }
  const waiting = waitingHere(inbox, view.summary.ticket).filter((item) => !THREADS_SAY.has(item.kind));
  const item = waiting.find((one) => one.kind === 'release') ?? waiting[0];
  if (!item) return null;
  const pr = item.kind === 'release' ? { number: item.pr.number, url: item.pr.url } : undefined;
  return { kind: 'review', what: item.kind, href: `/inbox#${encodeURIComponent(item.id)}`, ...(pr ? { pr } : {}), total: waiting.length };
}

const lower = (text: string) => text.charAt(0).toLocaleLowerCase() + text.slice(1);

// What a command means, when the table reads it whole and it names no program of its own.
function commandSaid(command: string, who: string, t: Translate): string {
  const intents = intentsOf(command);
  // Run as root is not what its words say: the table reads past `sudo`, the fold shows it.
  const asRoot = /(?:^|[\s;&|])(?:sudo|doas)\s/.test(command);
  if (intents.length === 0 || intents.some((intent) => intent.kind === 'unknown') || opaque(command) || asRoot) return t('glance_doing_command', { who });
  return t('glance_doing_intent', { who, intent: lower(intentSentence(command, t)) });
}

function rowSaid(row: Row | undefined, who: string, t: Translate): string {
  if (row?.kind === 'read') return t('glance_doing_read', { who });
  if (row?.kind === 'edits') return t('glance_doing_edit', { who });
  if (row?.kind !== 'tool') return t('glance_doing_work', { who });
  switch (row.input?.kind) {
    case 'read': return t('glance_doing_read', { who });
    case 'edit': case 'delete': case 'move': return t('glance_doing_edit', { who });
    case 'search': return t('glance_doing_search', { who });
    case 'fetch': return t('glance_doing_fetch', { who });
    case 'execute': return commandSaid(row.input.command, who, t);
    default: return t('glance_doing_work', { who });
  }
}

const FAILURE_KEYS: Readonly<Record<string, string>> = { container_failed: 'glance_failed_container', container_lost: 'glance_failed_lost' };

function endedSaid(view: SessionView, t: Translate): string {
  const phase = phaseOf(view);
  if (phase === 'failed') {
    const last = view.thread.rows.findLast((row) => row.kind === 'error');
    const code = last?.kind === 'error' ? last.code ?? '' : '';
    return t(FAILURE_KEYS[code] ?? 'glance_failed');
  }
  if (phase === 'stopped') return t('glance_stopped');
  switch (view.ticket?.status) {
    case 'Needs Approval': return t('glance_ready');
    case 'Ready to Ship': return t('glance_shipping');
    case 'Done': return t('glance_done');
    case 'In Review': return view.summary.role === 'author' ? t('glance_review_next') : t('glance_session_done');
    default: return t('glance_session_done');
  }
}

// One sentence, in the person's language: never a path, a command or the harness's words.
export function doingNow(view: SessionView, t: Translate): string {
  const phase = phaseOf(view);
  const ended = ENDED.has(phase);
  const taken = takenOverOf(view);
  if (taken && !ended) return t(taken.by === view.me ? 'glance_taken_you' : 'glance_taken_other');
  const action = pendingAction(view, []);
  if (action?.kind === 'permission') return t('glance_waiting_permission');
  if (action?.kind === 'question') return t('glance_waiting_question');
  if (action?.kind === 'plan') return t('glance_waiting_plan');
  if (ended) return endedSaid(view, t);
  if (phase === 'starting') return t('glance_starting');
  if (phase === 'waiting_human') return t('glance_idle');
  const who = t(view.summary.role === 'reviewer' ? 'glance_who_reviewer' : 'glance_who_agent');
  return rowSaid(view.thread.rows.at(-1), who, t);
}

// Whether the author has begun to write: its plan has its agreement, or it changed something.
const writing = (thread: SessionThread | undefined): boolean =>
  Boolean(thread?.plan?.go) || (thread?.state?.files.length ?? 0) > 0 || (thread?.rows ?? []).some((row) => row.kind === 'edits' || (row.kind === 'tool' && row.input?.kind === 'edit'));

// The ticket's stage, the newest fact first: its state, then what waits, then the session that acts.
export function stageOf(view: SessionView, inbox: readonly NextInboxItem[]): StageView | null {
  const { role } = view.summary;
  if (role !== 'author' && role !== 'reviewer') return null;
  const status = view.ticket?.status;
  const phase = phaseOf(view);
  const stopped = phase === 'failed' || phase === 'stopped';
  const finished = status === 'Done';
  const reviewWaits = waitingHere(inbox, view.summary.ticket).some((item) => item.kind === 'release');
  const authorActs = role === 'author' && !ENDED.has(phase);
  let key: StageKey;
  if (finished || status === 'Ready to Ship') key = 'ship';
  else if (status === 'Needs Approval' || reviewWaits) key = 'decide';
  else if (role === 'reviewer' || (status === 'In Review' && !authorActs)) key = 'review';
  else key = partsOf(view).filter((part) => part.summary.role === 'author').some((part) => writing(part.thread)) ? 'write' : 'prepare';
  const at = STAGES.indexOf(key);
  const nowState: Stage['state'] = finished ? 'done' : stopped && !view.summary.dormant ? 'failed' : 'current';
  return {
    stages: STAGES.map((one, index) => ({ key: one, state: index < at ? 'done' : index === at ? nowState : 'todo' })),
    current: at + 1,
    total: STAGES.length,
  };
}

const plainRuns = (runs: readonly Run[]): string => runs.map((run) => (run.kind === 'text' || run.kind === 'code' ? run.text : plainRuns(run.runs))).join('');
// One line of Markdown as the sentence it says: a criterion, a step.
export const plainLine = (line: string): string => plainRuns(runsOf(line));

// A step of the agent's plan as a sentence, whatever Markdown it came in.
function plainStep(step: string): string {
  const block = blocksOf(step)[0];
  const runs = block?.kind === 'list' ? block.items[0] ?? [] : block?.kind === 'heading' || block?.kind === 'paragraph' ? block.runs : runsOf(step);
  return plainRuns(runs).replace(/^\s*\[[ xX]\]\s+/, '').trim();
}
export const planSteps = (plan: Pick<SessionPlan, 'steps'>): string[] => plan.steps.map(plainStep).filter(Boolean);

// How long the ticket's sessions have run, and what they used: what the agents
// reported in dollars when all of them did, else the tokens. Never an estimate.
export function sessionFacts(view: SessionView, t: Translate): { readonly duration: string; readonly cost?: string } {
  const parts = partsOf(view);
  const from = Math.min(...parts.map((part) => Date.parse(part.summary.startedAt)));
  const live = parts.some((part) => !ENDED.has(phaseOfPart(part)));
  const to = live ? view.now.getTime() : Math.max(...parts.map((part) => Date.parse(part.summary.updatedAt)));
  const duration = lasted(Math.max(0, to - from), t);
  const { cost } = view;
  if (cost?.costUsd !== null && cost?.costUsd !== undefined) {
    const usd = new Intl.NumberFormat(view.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: cost.costUsd < 1 ? 4 : 2 }).format(cost.costUsd);
    return { duration, cost: usd };
  }
  const usage = parts.reduce((sum, part) => sum + (part.thread?.state?.usage.inputTokens ?? 0) + (part.thread?.state?.usage.outputTokens ?? 0), 0);
  const tokens = cost?.tokens ?? usage;
  return tokens > 0 ? { duration, cost: t('glance_used', { count: count(tokens, view.language) }) } : { duration };
}

// The ticket's pull request, as the service builds it (setup/steps/first-ticket.ts
// pullRequestOf): the release card's, else its service's address and its number.
export function pullRequestOf(ticket: Ticket | undefined, services: readonly ServiceHome[], inbox: readonly NextInboxItem[]): PullRequest | undefined {
  if (!ticket) return undefined;
  const card = inbox.find((item) => item.kind === 'release' && item.ticket === ticket.id);
  if (card?.kind === 'release') return { number: card.pr.number, url: card.pr.url };
  const part = ticket.services?.find((service) => service.pr !== null);
  const home = part && services.find((service) => service.name === part.name)?.url.replace(/\.git$/, '');
  if (!part?.pr || !home || !/^https?:\/\//i.test(home)) return undefined;
  let host: string;
  try { host = new URL(home).host; } catch { return undefined; }
  return { number: part.pr, url: `${home}/${/gitlab/i.test(host) ? '-/merge_requests' : 'pull'}/${part.pr}` };
}

// The result once the ticket is through: its pull request and its receipt, the
// captures whichever session journaled them; while it waits, the action carries it.
export function resultOf(view: SessionView, services: readonly ServiceHome[], inbox: readonly NextInboxItem[]): Result | null {
  const status = view.ticket?.status;
  if (status !== 'Done' && status !== 'Ready to Ship') return null;
  const proof = (service: string, file: string) => `/api/service/tickets/${encodeURIComponent(view.summary.ticket)}/proof/${encodeURIComponent(service)}/${file}`;
  const kept = new Map<string, Capture>();
  const keep = (kind: Capture['kind'], service: string, file: string | null | undefined) => {
    if (file) kept.set(`${service} ${kind}`, { kind, service, href: proof(service, file) });
  };
  for (const part of partsOf(view)) {
    for (const got of part.thread?.proofs ?? []) {
      keep('before', got.service, got.before);
      keep('after', got.service, got.after);
      keep('video', got.service, got.video);
    }
  }
  for (const check of view.production ?? []) keep('production', check.service, check.file);
  const pr = pullRequestOf(view.ticket, services, inbox);
  return { ...(pr ? { pr } : {}), captures: [...kept.values()] };
}

export const planStepOf = (_view: SessionView): { step: number; total: number } | null => null;
export const humanSteps = (_plan: Pick<SessionPlan, 'steps'>): { text: string | null; raw: string }[] => [];
