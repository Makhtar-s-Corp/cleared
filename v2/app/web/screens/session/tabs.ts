// The session screen's four tabs (docs/v2/milestone-2-plan.md, decision 30,
// lane 20), as pure functions the tests run under Node:
//   Plan: the session plan (lane 17) with its confidence, Go and Change;
//   Terminal: the timeline and the composer of milestone 1; once the owner
//     took the session over, the command that resumes it on the server
//     (lane 32 mounts the web terminal beside it);
//   Editor: the changed files and a file's diff against the ticket's base,
//     read only (lane 32 makes it editable);
//   Browser: the session's trial environment from the preview listener's
//     own origin (decision 20), else milestone 1's "Screen so far".
//
// The browser may only `import type` from v2/src, so the container's name
// is copied here and a test keeps it equal to session-runtime.ts's.
import type { SessionFile, SessionPlan, TakenOver } from '../../../../src/api/types.ts';
import type { Role } from '../../../../src/session/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
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

// --------------------------------------------------------------- terminal

export const containerName = (session: string): string => `cleared-v2-${session}-session`;

// What resumes the session in a terminal on the server (decision 30): the
// harness's own session id is Cleared's (images/session/runner/main.ts).
export const resumeCommand = (session: string): string => `docker exec -it ${containerName(session)} claude --resume ${session}`;

export type TakeoverView =
  | { readonly kind: 'free'; readonly can: boolean }        // can: Take over is offered
  | { readonly kind: 'mine'; readonly at: string }
  | { readonly kind: 'other'; readonly at: string };

// Take over is an author's live session's (the service refuses the rest);
// an ended session is nobody's any more.
export function takeoverOf(options: { readonly takenOver: TakenOver | null | undefined; readonly me: string; readonly role: Role; readonly ended: boolean }): TakeoverView {
  if (options.ended) return { kind: 'free', can: false };
  if (options.takenOver) return options.takenOver.by === options.me ? { kind: 'mine', at: options.takenOver.at } : { kind: 'other', at: options.takenOver.at };
  return { kind: 'free', can: options.role === 'author' };
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

// "on filter-api": the workspace service a session works on.
export function serviceLine(service: string | undefined, t: Translate): string | undefined {
  return service ? t('service_line', { name: service }) : undefined;
}
