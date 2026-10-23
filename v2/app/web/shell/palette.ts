// The command palette's items (docs/v2/ui-overhaul-plan.md, 2.2.2, lane
// 35), from what the cache holds: what waits for the person, the gestures
// of the screen shown, the screens, the sessions by ticket and title, then
// the theme, the shortcut sheet and the sidebar. Pure: Palette.tsx draws
// the items and runs them.
//
// A gesture is a button the screen already draws (Take over, Give back,
// Go, Approve, Allow once...): the palette lists it while the screen shows
// it, enabled, and pressing the item presses that button, so the screen's
// own code does the work and the palette adds none of its own. A field's
// gesture ("Write a message") focuses the field.
import type { ScreenName } from '../lib/routes.ts';
import type { Translate } from '../lib/i18n.ts';
import { needId, needTitle, type NeedCard } from '../screens/tower/model.ts';
import { duration } from '../lib/time.ts';
import { NAV, type SessionRow, type Theme } from './model.ts';

export type PaletteGroup = 'waiting' | 'actions' | 'goto' | 'sessions' | 'general';

export type PaletteRun =
  | { readonly kind: 'navigate'; readonly href: string }
  | { readonly kind: 'gesture'; readonly id: string }
  | { readonly kind: 'theme' }
  | { readonly kind: 'sheet' }
  | { readonly kind: 'sidebar' };

export type PaletteItem = {
  readonly id: string;
  readonly group: PaletteGroup;
  readonly label: string;
  readonly detail?: string;
  readonly keywords: readonly string[];
  readonly shortcut?: readonly string[];
  readonly run: PaletteRun;
};

export type Gesture = { readonly id: string; readonly screen: ScreenName; readonly selector: string; readonly label: string; readonly focus?: boolean };

// The selectors are the screens' own ids and data-act names; a hidden kept
// session has set its ids aside (lib/stack.tsx), so an id names the shown one.
export const GESTURES: readonly Gesture[] = [
  { id: 'new_ticket', screen: 'tower', selector: '#ask-input', label: 'cmd_new_ticket', focus: true },
  { id: 'new_goal', screen: 'tower', selector: '[data-lead="goal"]', label: 'cmd_new_goal' },
  { id: 'ask_lead', screen: 'tower', selector: '[data-lead="lead"]', label: 'cmd_ask_lead' },
  { id: 'ask_code', screen: 'tower', selector: '[data-bar="ask"]', label: 'cmd_ask_code' },
  { id: 'recipe', screen: 'tower', selector: '[data-bar="recipe"]', label: 'cmd_recipe' },
  { id: 'allow_once', screen: 'inbox', selector: '#detail [data-act="allow_once"]', label: 'cmd_allow_once' },
  { id: 'allow_always', screen: 'inbox', selector: '#detail [data-act="allow_always"]', label: 'cmd_allow_always' },
  { id: 'reject_once', screen: 'inbox', selector: '#detail [data-act="reject_once"]', label: 'cmd_reject_once' },
  { id: 'answer', screen: 'inbox', selector: '#detail [data-act="answer"]', label: 'cmd_answer' },
  { id: 'approve', screen: 'inbox', selector: '#detail [data-act="approve"]', label: 'cmd_approve' },
  { id: 'approve_plan', screen: 'inbox', selector: '#detail [data-act="approve_plan"]', label: 'cmd_approve_plan' },
  { id: 'inbox_go', screen: 'inbox', selector: '#detail [data-act="plan_go"]', label: 'cmd_go' },
  { id: 'session_allow_once', screen: 'session', selector: '[data-answer="allow_once"]', label: 'cmd_allow_once' },
  { id: 'session_allow_always', screen: 'session', selector: '[data-answer="allow_always"]', label: 'cmd_allow_always' },
  { id: 'session_reject_once', screen: 'session', selector: '[data-answer="reject_once"]', label: 'cmd_reject_once' },
  { id: 'takeover', screen: 'session', selector: '#takeover', label: 'cmd_takeover' },
  { id: 'giveback', screen: 'session', selector: '#giveback', label: 'cmd_giveback' },
  { id: 'session_go', screen: 'session', selector: '[data-act="plan_go"]', label: 'cmd_go' },
  { id: 'message', screen: 'session', selector: '#message', label: 'cmd_message', focus: true },
  { id: 'lead_message', screen: 'lead', selector: '#reply-text', label: 'cmd_lead_message', focus: true },
];

export type PaletteInput = {
  readonly screen: ScreenName;
  readonly needs: readonly NeedCard[];
  readonly sessions: readonly SessionRow[];
  readonly gestures: readonly string[];                  // the ids of GESTURES the screen shows now
  readonly theme: Theme;
  readonly t: Translate;                                 // the shell's catalog over the tower's
};

// What blocks a running session comes first, then what ships, then the
// rest, so the three rows kept with no query hold the requests (lane 37's
// art director); the tower's order within a kind is kept.
const BLOCKS: Readonly<Record<string, number>> = { permission: 0, question: 1, session_plan: 2, release: 3, plan: 4, contract: 5, knowledge: 6 };
const blocking = (needs: readonly NeedCard[]): NeedCard[] => [...needs].sort((a, b) => (BLOCKS[a.kind] ?? 9) - (BLOCKS[b.kind] ?? 9));

export function paletteItems({ screen, needs, sessions, gestures, theme, t }: PaletteInput): PaletteItem[] {
  const waiting = blocking(needs).map((card): PaletteItem => ({
    id: `waiting-${card.id}`, group: 'waiting', label: needTitle(card, t),
    detail: [t(`need_${card.kind}`, { age: duration(card.minutes, t) }), needId(card, t)].filter(Boolean).join(' · '),
    keywords: [card.ticket, card.kind].filter(Boolean), run: { kind: 'navigate', href: card.href },
  }));
  const actions = GESTURES.filter((g) => g.screen === screen && gestures.includes(g.id)).map((g): PaletteItem => ({
    id: `gesture-${g.id}`, group: 'actions', label: t(g.label), keywords: [], run: { kind: 'gesture', id: g.id },
  }));
  const goto = NAV.map((item): PaletteItem => ({
    id: `goto-${item.go}`, group: 'goto', label: t(item.label), keywords: [], shortcut: item.chord, run: { kind: 'navigate', href: item.href },
  }));
  const rows = sessions.map((row): PaletteItem => ({
    id: `session-${row.id}`, group: 'sessions', label: row.title, detail: `${row.ticket} · ${t(`role_${row.role}`)}`,
    keywords: [row.ticket, row.ticket.replace(/^[A-Z]+-/, '')], run: { kind: 'navigate', href: `/sessions/${encodeURIComponent(row.id)}` },
  }));
  const general: PaletteItem[] = [
    { id: 'theme', group: 'general', label: t(theme === 'dark' ? 'theme_light' : 'theme_dark'), keywords: [], run: { kind: 'theme' } },
    { id: 'sheet', group: 'general', label: t('cmd_sheet'), keywords: [], shortcut: ['?'], run: { kind: 'sheet' } },
    { id: 'sidebar', group: 'general', label: t('cmd_sidebar'), keywords: [], shortcut: ['['], run: { kind: 'sidebar' } },
  ];
  return [...waiting, ...actions, ...goto, ...rows, ...general];
}

const ticketNumber = (search: string): string | undefined => /^(?:[a-z]+-)?(\d+)$/i.exec(search.trim())?.[1];

// The palette's order for a query, from cmdk's own score (`base`): a
// ticket's number typed alone (161, LOCAL-161) puts that ticket's sessions
// first, the sessions being what a number is typed for; then an item whose
// words hold what was typed outranks one that only scatters its letters
// (cmdk's subsequence match finds "upcoming" in a long unrelated title).
export function rank(id: string, search: string, keywords: readonly string[], base: number): number {
  if (base <= 0) return base;
  const number = ticketNumber(search);
  if (number && id.startsWith('session-') && keywords.includes(number)) return 1;
  const typed = search.trim().toLowerCase();
  const holds = typed !== '' && keywords.some((word) => word.toLowerCase().includes(typed));
  return holds ? Math.min(0.99, 0.9 + base / 10) : Math.min(base, 0.5);
}

// The groups in the palette's order. With no query, a fixed order; with
// one, the group of the best match first (each group's best score, `best`),
// and the sessions first for a ticket's number. cmdk sorts the items inside
// a group but leaves the groups where they are drawn, so the palette draws
// them in this order, and Enter runs the best match whatever its kind.
export const GROUPS: readonly PaletteGroup[] = ['waiting', 'actions', 'goto', 'sessions', 'general'];

export function groupOrder(search: string, best: Partial<Record<PaletteGroup, number>> = {}): readonly PaletteGroup[] {
  if (!search.trim()) return GROUPS;
  if (ticketNumber(search)) return ['sessions', ...GROUPS.filter((g) => g !== 'sessions')];
  return [...GROUPS].sort((a, b) => (best[b] ?? 0) - (best[a] ?? 0));
}

// With no query, what needs the person shows its first WAITING_MAX rows, so
// the screens are on the palette's first screen; a query searches them all.
export const WAITING_MAX = 3;

export function shownItems(items: readonly PaletteItem[], search: string): PaletteItem[] {
  if (search.trim()) return [...items];
  let waiting = 0;
  return items.filter((item) => item.group !== 'waiting' || (waiting += 1) <= WAITING_MAX);
}

export const keywordsOf = (item: PaletteItem): string[] => [item.label, item.detail ?? '', ...item.keywords];

export const GROUP_LABEL: Readonly<Record<PaletteGroup, string>> = {
  waiting: 'palette_waiting', actions: 'palette_actions', goto: 'palette_goto', sessions: 'palette_sessions', general: 'palette_general',
};
