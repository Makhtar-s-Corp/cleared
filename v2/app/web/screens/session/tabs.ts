// The session screen's four tabs (docs/v2/milestone-2-plan.md, decision 30,
// lane 20), as pure functions the tests run under Node:
//   Plan: the session plan (lane 17) with its confidence, Go and Change;
//   Terminal: the timeline and the composer of milestone 1; once the owner
//     took the session over, the web terminal on its harness (no command to
//     run on the server: owner request of 2026-10-22 17:26; lane 32's
//     components/terminal/);
//   Editor: the changed files and a file's diff against the ticket's base,
//     opened for editing by lane 32 (components/editor/);
//   Browser: the session's trial environment from the preview listener's
//     own origin (decision 20), else milestone 1's "Screen so far".
// The Plan tab also lists the ticket's steps across services (decision 26,
// lane 27), this session's marked, once the ticket has two or more, and
// asks about the code (decision 28, matrix C11): the tower bar's ask to the
// reader, about the session's service, opened on its /ask/:id screen.
//
// The browser may only `import type` from v2/src, so the container's name
// is copied here and a test keeps it equal to session-runtime.ts's.
import type { AskBody, EditorLinks, SessionFile, SessionPlan, TakenOver, TicketStep } from '../../../../src/api/types.ts';
import type { Harness, Role } from '../../../../src/session/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
import { fixed } from '../../lib/time.ts';
import { QUESTION_MAX, askBody, questionProblem } from '../ask/model.ts';
import { clock, who } from './model.ts';

export const TABS = ['plan', 'terminal', 'editor', 'browser'] as const;
export type Tab = (typeof TABS)[number];
export const DEFAULT_TAB: Tab = 'terminal';

// The tab an address opens: its hash, else the Terminal.
export function tabOf(hash: string): Tab {
  const name = hash.replace(/^#/, '');
  return (TABS as readonly string[]).includes(name) ? name as Tab : DEFAULT_TAB;
}

// The tab a key moves to, as the ARIA tabs pattern does: the arrows wrap.
export function nextTab(tab: Tab, key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'): Tab {
  const at = TABS.indexOf(tab);
  const index = key === 'Home' ? 0 : key === 'End' ? TABS.length - 1 : (at + (key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
  return TABS[index] as Tab;
}

// ------------------------------------------------------------------- plan

export type PlanView =
  | { readonly kind: 'none' }
  | { readonly kind: 'plan'; readonly plan: SessionPlan; readonly waiting: boolean; readonly canAct: boolean };

export function planView(plan: SessionPlan | null | undefined, options: { readonly ended: boolean; readonly takenOver: boolean }): PlanView {
  if (!plan) return { kind: 'none' };
  const waiting = plan.go === null;
  return { kind: 'plan', plan, waiting, canAct: waiting && !options.ended && !options.takenOver };
}

// Who gave the plan its Go, and when.
export function goLine(plan: Pick<SessionPlan, 'go'>, me: string, t: Translate): string | undefined {
  const go = plan.go;
  if (!go) return undefined;
  const time = clock(go.at);
  if (go.by === 'delay') return t('plan_go_delay', { time });
  if (go.by === 'lead') return t('plan_go_lead', { time });
  return t('plan_go_by', { who: who(go.by, { me }, t), time });
}

// The Change's message, as the route takes it (flow/plan-gate.ts).
export const CHANGE_MAX = 2000;
export function changeProblem(text: string): 'empty' | 'too_long' | undefined {
  if (!text.trim()) return 'empty';
  return text.length > CHANGE_MAX ? 'too_long' : undefined;
}

// The ask from the Plan tab: the tower bar's rules, the session's service
// picked. A `service:path:line` of the workspace names its own service.
export const planAskBody = (text: string, service: string | undefined, services: readonly string[]): AskBody =>
  askBody(text, services, service ? [service] : []);

export function planAskProblem(text: string, t: Translate): string | undefined {
  const problem = questionProblem(text);
  if (!problem) return undefined;
  return problem === 'empty' ? t('ask_question_empty') : t('ask_question_long', { n: QUESTION_MAX });
}

// What the reader reads: the base branch, never the session's checkout.
export const planAskScope = (service: string | undefined, t: Translate): string =>
  service ? t('plan_ask_scope', { service }) : t('plan_ask_scope_platform');

// --------------------------------------------------------------- terminal

export type TakeoverView =
  | { readonly kind: 'free'; readonly can: boolean }        // can: Take over is offered
  | { readonly kind: 'mine'; readonly at: string }
  | { readonly kind: 'other'; readonly at: string };

// Take over is an author's or a reviewer's live session's (the reviewer's
// by the owner's decision of 2026-10-22 22:01; the service refuses the
// rest); an ended session is nobody's any more.
export function takeoverOf(options: { readonly takenOver: TakenOver | null | undefined; readonly me: string; readonly role: Role; readonly ended: boolean }): TakeoverView {
  if (options.ended) return { kind: 'free', can: false };
  if (options.takenOver) return options.takenOver.by === options.me ? { kind: 'mine', at: options.takenOver.at } : { kind: 'other', at: options.takenOver.at };
  return { kind: 'free', can: options.role === 'author' || options.role === 'reviewer' };
}

// ---------------------------------------------------------------- handover

export type HandoverView =
  | { readonly kind: 'none' }
  | { readonly kind: 'offer'; readonly to: 'claude-code' | 'codex' };

// Hand over (flow/takeover.ts, B6.3) is offered on a live author's session
// nobody has taken over, to the other harness of the contract. Cursor's
// session, a reviewer's, the lead's and an ended one get none; a session the
// watchdog stopped while it waited for a person is not ended, the answer
// resumes it, and it is the stuck one a handover is for. The service checks
// the rest.
export function handoverOf(options: { readonly takeover: TakeoverView; readonly role: Role; readonly harness: Harness; readonly ended: boolean }): HandoverView {
  if (options.ended || options.role !== 'author' || options.takeover.kind !== 'free' || !options.takeover.can) return { kind: 'none' };
  if (options.harness === 'claude-code') return { kind: 'offer', to: 'codex' };
  if (options.harness === 'codex') return { kind: 'offer', to: 'claude-code' };
  return { kind: 'none' };
}

// The offer for a session as the screen holds it. A session the watchdog
// stopped is not ended for this: its phase reads stopped, but the answer
// resumes it (`dormant`).
export function handoverFor(options: { readonly takenOver: TakenOver | null | undefined; readonly me: string; readonly role: Role; readonly harness: Harness; readonly ended: boolean; readonly dormant: boolean; readonly planWaits: boolean }): HandoverView {
  const ended = options.ended && !options.dormant;
  if (options.planWaits) return { kind: 'none' };         // the plan's Go or Change comes first (the service answers 409)
  return handoverOf({ takeover: takeoverOf({ takenOver: options.takenOver, me: options.me, role: options.role, ended }), role: options.role, harness: options.harness, ended });
}

// ----------------------------------------------------------------- editor

export type DiffLine = { readonly kind: 'same' | 'add' | 'del'; readonly text: string; readonly old?: number; readonly new?: number };

const linesOf = (text: string | undefined): string[] => {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

// A line diff of the base and the file: the longest common subsequence,
// the removed lines before the added ones at each change. Both sides are
// cut at 400 lines by the route, so the table stays small.
export function lineDiff(base: string | undefined, current: string | undefined): DiffLine[] {
  const a = linesOf(base);
  const b = linesOf(current);
  const n = a.length;
  const m = b.length;
  const longest: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (longest[i] as number[])[j] = a[i] === b[j] ? (longest[i + 1] as number[])[j + 1] as number + 1 : Math.max((longest[i + 1] as number[])[j] as number, (longest[i] as number[])[j + 1] as number);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string, old: i + 1, new: j + 1 });
      i++;
      j++;
    } else if (i < n && (j >= m || ((longest[i + 1] as number[])[j] as number) >= ((longest[i] as number[])[j + 1] as number))) {
      out.push({ kind: 'del', text: a[i] as string, old: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] as string, new: j + 1 });
      j++;
    }
  }
  return out;
}

export function diffCounts(lines: readonly DiffLine[]): { readonly added: number; readonly removed: number } {
  return { added: lines.filter((line) => line.kind === 'add').length, removed: lines.filter((line) => line.kind === 'del').length };
}

// The file alone, numbered.
export function fileLines(text: string): DiffLine[] {
  return linesOf(text).map((line, index) => ({ kind: 'same', text: line, new: index + 1 }));
}

// A file the route cut at 400 lines says so.
export function cutNote(file: SessionFile, t: Translate): string | undefined {
  return file.cut ? t('editor_cut', { shown: 400, lines: file.lines }) : undefined;
}

// ---------------------------------------------------------------- browser

export type BrowserView =
  | { readonly kind: 'frame'; readonly src: string }
  | { readonly kind: 'here_only' }                          // a loopback preview, from another device
  | { readonly kind: 'none' };                              // no trial environment: milestone 1's screen

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])$/;

export function browserView(options: { readonly id: string; readonly previewKey: string | null | undefined; readonly previewOrigin: string | undefined; readonly pageHost: string }): BrowserView {
  if (!options.previewKey || !options.previewOrigin) return { kind: 'none' };
  let origin: URL;
  try { origin = new URL(options.previewOrigin); } catch { return { kind: 'none' }; }
  if (LOOPBACK.test(origin.hostname) && !LOOPBACK.test(options.pageHost)) return { kind: 'here_only' };
  return { kind: 'frame', src: `${origin.origin}/preview/${encodeURIComponent(options.id)}/${encodeURIComponent(options.previewKey)}/` };
}

// ---------------------------------------------------------------- service

// "on filter-api", and "on filter-api · step 2 of 4" for a session of a
// ticket in steps: the workspace service a session works on, and its step.
export function serviceLine(service: string | undefined, t: Translate, step?: Pick<StepsView, 'current' | 'total'> | null): string | undefined {
  if (!service) return undefined;
  return step && step.current !== null ? t('service_line_step', { name: service, n: step.current, total: step.total }) : t('service_line', { name: service });
}

// ------------------------------------------------------------------ steps

export type StepRow = {
  readonly position: number;
  readonly kind: TicketStep['kind'];
  readonly service: string;
  readonly after: readonly number[];
  readonly state: TicketStep['state'];
  readonly costUsd: number | null;
  readonly current: boolean;                                // this session's step
};
export type StepsView = { readonly rows: readonly StepRow[]; readonly current: number | null; readonly total: number };

// The ticket's steps in order, this session's marked; none for a ticket of
// one step (a one-service ticket), whose screen stays as it was.
export function stepsView(steps: readonly TicketStep[] | null | undefined, session: string): StepsView | null {
  if (!Array.isArray(steps) || steps.length < 2) return null;
  const rows = [...steps].sort((a, b) => a.position - b.position).map((step): StepRow => ({
    position: step.position, kind: step.kind, service: step.service, after: step.after, state: step.state, costUsd: step.costUsd, current: step.session === session,
  }));
  return { rows, current: rows.find((row) => row.current)?.position ?? null, total: rows.length };
}

const listOf = (after: readonly number[], t: Translate) => (after.length <= 1 ? after.join('') : `${after.slice(0, -1).join(', ')} ${t('ticket_step_and')} ${after.at(-1)}`);

// "Integration · guestbook · after 2 and 3".
export function stepLine(row: StepRow, t: Translate): string {
  return [t(`ticket_step_${row.kind}`), row.service, ...(row.after.length ? [t('ticket_step_after', { list: listOf(row.after, t) })] : [])].join(' · ');
}

// What a step's sessions spent, once one ran.
export function stepCost(row: StepRow, language: 'en' | 'fr', t: Translate): string | undefined {
  if (row.costUsd === null) return undefined;
  const amount = fixed(row.costUsd, 2, language);
  return t('ticket_step_cost', { amount });
}

// Open in an editor (flow/editor.ts): the service's answer, kept only when
// every link is the address of the editor it names (vscode:// or cursor://,
// no space, quote or angle bracket), so the screen never puts anything else
// in an href; null when there is nothing to offer.
const EDITOR_SCHEMES: Readonly<Record<string, string>> = { vscode: 'vscode:', cursor: 'cursor:' };
export function editorOffer(answer: unknown): EditorLinks | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const { mode, links } = answer as { mode?: unknown; links?: unknown };
  if ((mode !== 'local' && mode !== 'ssh') || !Array.isArray(links) || links.length === 0) return null;
  const kept: { editor: 'vscode' | 'cursor'; url: string }[] = [];
  for (const link of links as { editor?: unknown; url?: unknown }[]) {
    if (typeof link !== 'object' || link === null || typeof link.editor !== 'string' || typeof link.url !== 'string') return null;
    const scheme = EDITOR_SCHEMES[link.editor];
    if (!scheme || !link.url.startsWith(`${scheme}//`) || /[\s"'<>\\`]/.test(link.url)) return null;
    kept.push({ editor: link.editor as 'vscode' | 'cursor', url: link.url });
  }
  return { mode, links: kept };
}
