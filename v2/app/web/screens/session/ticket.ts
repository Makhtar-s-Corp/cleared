// The session view follows the ticket, not the session id
// (docs/v2/ui-overhaul-plan.md, 2.3.1, 2.3.2 and U6, lane 36): one thread
// of the ticket's sessions in the order they started, a handover row
// before each session after the first ("Reviewer (Sonnet) took over at
// 09:20; the author's work is above"), Author and Reviewer as filters of
// that thread rather than links to other pages. The view acts on the
// ticket's live session, whatever its role: its status, its composer, its
// Take over. The right column says what the ticket's sessions changed,
// checked and spent, and the Editor holds the ticket's diff, which the
// author made and the reviewer reads. Pure, so the tests run it under Node.
import type { CaptureChoice, ProductionCheck, SessionPlan, SessionSummary, TicketCost } from '../../../../src/api/types.ts';
import type { ChangedFile, TimedEdit } from '../../components/editor/model.ts';
import type { Translate } from '../../lib/i18n.ts';
import type { ScreenContext } from '../../lib/screen.ts';
import { lasted, quantity } from '../../lib/time.ts';
import { ENDED, clock, family, latestOf, stepsOf, type Row, type SessionThread, type StepTotal } from './model.ts';

export type ThreadRole = 'author' | 'reviewer';
export type Filter = 'all' | ThreadRole;

// A session of the ticket, and its thread once its stream said something.
export type TicketPart = { readonly summary: SessionSummary; readonly thread: SessionThread | undefined };

export type Handover = {
  readonly kind: 'handover';
  readonly session: string;                               // the session that starts here
  readonly at: string;
  readonly role: ThreadRole;
  readonly model: string;                                 // its model's family: Opus, Sonnet...
  readonly after: ThreadRole;                             // the role of the session before it
};
export type ThreadEntry = { readonly kind: 'row'; readonly session: string; readonly role: SessionSummary['role']; readonly row: Row } | Handover;

const threadRole = (summary: SessionSummary): summary is SessionSummary & { role: ThreadRole } => summary.role === 'author' || summary.role === 'reviewer';
const byStart = (a: { readonly startedAt: string }, b: { readonly startedAt: string }) => Date.parse(a.startedAt) - Date.parse(b.startedAt);

// The sessions of a ticket the thread follows: its authors and reviewers, oldest first.
export function ticketSessions(all: readonly SessionSummary[], ticket: string): SessionSummary[] {
  return all.filter((s) => s.ticket === ticket && threadRole(s)).sort(byStart);
}

// A session someone works in: running, waiting, or taken over.
export const isLive = (summary: SessionSummary): boolean => !ENDED.has(summary.phase) || Boolean(summary.takenOver);

// The sessions a view draws: the ticket's authors and reviewers when the
// address names one of them; else the session alone (a lead's, a reader's:
// review of 251, F1), which has a thread of its own and no ticket's.
export function viewSessions(all: readonly SessionSummary[], named: SessionSummary): SessionSummary[] {
  if (!threadRole(named)) return [all.find((s) => s.id === named.id) ?? named];
  const own = ticketSessions(all, named.ticket);
  return own.some((s) => s.id === named.id) ? own : ticketSessions([...own, named], named.ticket);
}

// The session the view acts on: the newest live one; else the one the
// address names, when it is the ticket's; else the newest.
export function actingSession(sessions: readonly SessionSummary[], asked: string): SessionSummary | undefined {
  const ordered = [...sessions].sort(byStart);
  return ordered.filter(isLive).at(-1) ?? ordered.find((s) => s.id === asked) ?? ordered.at(-1);
}

// The ticket's parts a view holds; a view of one session alone (a component's test) is its own one part.
export const partsOf = (view: { readonly parts?: readonly TicketPart[] | undefined; readonly summary: SessionSummary; readonly thread: SessionThread }): readonly TicketPart[] =>
  view.parts ?? [{ summary: view.summary, thread: view.thread }];

const sorted = (parts: readonly TicketPart[]) => [...parts].sort((a, b) => byStart(a.summary, b.summary));

// One thread of the ticket: each session's rows, a handover row before each
// session after the first; a filter keeps one role's rows, and no handover.
// A message of the review channel is logged on both sides (issue 291): the
// whole ticket shows it once, on the session it reached.
export function ticketThread(parts: readonly TicketPart[], filter: Filter): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  let before: ThreadRole | undefined;
  for (const { summary, thread } of sorted(parts)) {
    const role = summary.role;
    if (filter === 'all' && before !== undefined && threadRole(summary)) out.push({ kind: 'handover', session: summary.id, at: summary.startedAt, role: summary.role, model: family(summary.model), after: before });
    before = threadRole(summary) ? summary.role : undefined;
    if (filter !== 'all' && filter !== role) continue;
    for (const row of thread?.rows ?? []) {
      if (filter === 'all' && row.kind === 'channel' && row.from === role) continue;
      out.push({ kind: 'row', session: summary.id, role, row });
    }
  }
  return out;
}

export function handoverLine(handover: Handover, t: Translate): string {
  const values = { model: handover.model, time: clock(handover.at) };
  if (handover.role === handover.after) return t(`handover_again_${handover.role}`, values);
  return t(`handover_${handover.role}`, values);
}

export type FilterOption = { readonly filter: Filter; readonly label: string; readonly disabled: boolean };

// The whole ticket, then its latest author and reviewer by their model; a role not started yet waits.
export function filterOptions(sessions: readonly SessionSummary[], t: Translate): FilterOption[] {
  const role = (name: ThreadRole): FilterOption => {
    const found = latestOf(sessions, name);
    return found ? { filter: name, label: t(`tab_${name}`, { model: family(found.model) }), disabled: false } : { filter: name, label: t(`tab_${name}_waiting`), disabled: true };
  };
  return [{ filter: 'all', label: t('filter_all'), disabled: false }, role('author'), role('reviewer')];
}

// The ticket's changed files, as its sessions' states say them: the newest
// session's counts for a file, and the files of the sessions before it kept
// (a reviewer changes none).
export function ticketFiles(parts: readonly TicketPart[]): ChangedFile[] {
  const out = new Map<string, ChangedFile>();
  for (const { thread } of sorted(parts)) for (const file of thread?.state?.files ?? []) out.set(file.path, { path: file.path, added: file.added, removed: file.removed });
  return [...out.values()];
}

// The ticket's checks go on: each by its name, in the order they first came, with the newest session's value.
export function ticketChecks(parts: readonly TicketPart[]): { readonly name: string; readonly state: 'passed' | 'pending' | 'failed' }[] {
  const out = new Map<string, { readonly name: string; readonly state: 'passed' | 'pending' | 'failed' }>();
  for (const { thread } of sorted(parts)) for (const check of thread?.state?.checks ?? []) out.set(check.name, { name: check.name, state: check.state });
  return [...out.values()];
}

// The time by step of every session of the ticket, added up by step.
export function ticketSteps(parts: readonly TicketPart[], now: number): StepTotal[] {
  const out = new Map<string, StepTotal>();
  for (const { thread } of sorted(parts)) {
    if (!thread) continue;
    for (const step of stepsOf(thread, now)) {
      const total = out.get(step.name);
      out.set(step.name, total ? { ...total, ms: total.ms + step.ms, count: total.count + step.count, open: total.open || step.open } : step);
    }
  }
  return [...out.values()];
}

// The session plan the ticket works to: the latest author's.
export function ticketPlan(parts: readonly TicketPart[]): SessionPlan | null {
  return sorted(parts).filter((p) => p.summary.role === 'author').reverse().find((p) => p.thread?.plan)?.thread?.plan ?? null;
}

// Every edit the ticket's sessions made, in time, for the Editor's last turn.
export function editsOf(parts: readonly TicketPart[]): TimedEdit[] {
  const out: TimedEdit[] = [];
  for (const { thread } of sorted(parts)) {
    for (const row of thread?.rows ?? []) {
      if (row.kind === 'edits') for (const edit of row.each) out.push({ path: row.path, ...edit });
      else if (row.kind === 'tool' && row.input?.kind === 'edit' && !(row.output && 'ok' in row.output && !row.output.ok)) out.push({ path: row.input.path, added: row.input.added, removed: row.input.removed, at: row.at });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// What a resolved ticket's sessions used (P211, the service's
// consumption/ticket-cost.ts), as facts the card keeps whole: its tokens,
// the agents' time over the ticket's, and the dollars only when every
// session reported them; none before the cost is read or when no turn
// finished. Never euros.
// A resolved ticket's production page (P218): when each service's was
// captured, with the capture's address through the app, or why it was not.
// The service is named when the ticket has several.
export type ProductionFact = { readonly text: string; readonly href?: string };
export function productionFacts(checks: readonly ProductionCheck[] | null | undefined, ticket: string, t: Translate): ProductionFact[] {
  if (!checks || checks.length === 0) return [];
  const several = checks.length > 1;
  return checks.flatMap((check): ProductionFact[] => {
    if (check.file) {
      const href = `/api/service/tickets/${encodeURIComponent(ticket)}/proof/${encodeURIComponent(check.service)}/${check.file}`;
      const text = several ? t('production_captured_service', { service: check.service, time: clock(check.at) }) : t('production_captured', { time: clock(check.at) });
      return [{ text }, { text: t('production_open'), href }];
    }
    const why = t(check.missing === 'unwatched' ? 'production_unwatched' : check.missing === 'no_browser' ? 'production_no_browser' : 'production_failed');
    return [{ text: several ? t('production_service', { service: check.service, why }) : capitalised(why) }];
  });
}
const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function ticketCostFacts(cost: TicketCost | null | undefined, language: 'en' | 'fr', t: Translate): string[] {
  if (!cost || cost.tokens === null) return [];
  const facts = [t('ticket_cost_use', { count: quantity(cost.tokens, t) }), t('ticket_cost_time', { work: lasted(cost.workMs, t), elapsed: lasted(cost.elapsedMs, t) })];
  if (cost.costUsd === null) return facts;
  const usd = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: cost.costUsd < 1 ? 4 : 2 }).format(cost.costUsd);
  return [...facts, t('ticket_cost_usd', { usd })];
}

// The human's choice of the proof receipt's captures on the ticket (P226,
// issue #368): Auto, the service's rule decides from the change; On and
// Off win over it. Posted to the service, which keeps it on the ticket.
export const CAPTURE_CHOICES = ['auto', 'on', 'off'] as const satisfies readonly CaptureChoice['choice'][];
export function chooseCaptures(api: ScreenContext['api'], ticket: string, choice: CaptureChoice['choice']): Promise<CaptureChoice> {
  return api<CaptureChoice>(`/tickets/${encodeURIComponent(ticket)}/captures`, { method: 'POST', body: { choice } });
}
