// The shell's rules that need no browser: when the "Lead · always on" pill
// shows, how many items wait in the inbox, and the theme the button sets.
// The sidebar's (lane 35, docs/v2/ui-overhaul-plan.md, 2.2.1 and U8): its
// screens, the inbox's count, the lead's dot, the live sessions grouped by
// state, and how wide it is at each width.
import type { LeadState, SessionSummary } from '../../../src/api/types.ts';
import type { Role } from '../../../src/session/contract.ts';
import type { ScreenName } from '../lib/routes.ts';
import type { GoScreen } from './keys.ts';

export const INBOX_MS = 15_000;
export const THEME_KEY = 'cleared-v2-theme';
export const SIDEBAR_KEY = 'cleared-v2-sidebar';

export type Theme = 'light' | 'dark';

// The pill says the lead is always on while a generation is live, and
// while it refreshes from one generation to the next, which is part of
// being always on. Starting (no generation yet) and down are not.
export function leadPillShown(state: LeadState | null): boolean {
  return state !== null && (state.phase === 'idle' || state.phase === 'working' || state.phase === 'refreshing');
}

export function waitingCount(items: readonly { readonly state: string }[]): number {
  return items.filter((item) => item.state === 'waiting').length;
}

// The theme on <html>, as theme.js set it before the page painted.
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme, save: boolean): void {
  document.documentElement.dataset.theme = theme;
  if (!save) return;
  try { localStorage.setItem(THEME_KEY, theme); }
  catch { /* the choice lasts for this page only */ }
}

// Every screen, in order, each with its chord (keys.ts): the palette's Go to lists them all.
export type NavItem = { readonly screen: ScreenName; readonly href: string; readonly label: string; readonly go: GoScreen; readonly chord: readonly string[] };

export const SCREENS: readonly NavItem[] = [
  { screen: 'tower', href: '/', label: 'nav_tower', go: 'tower', chord: ['G', 'T'] },
  { screen: 'inbox', href: '/inbox', label: 'nav_inbox', go: 'inbox', chord: ['G', 'I'] },
  { screen: 'session', href: '/sessions', label: 'nav_sessions', go: 'sessions', chord: ['G', 'S'] },
  { screen: 'lead', href: '/lead', label: 'nav_plans', go: 'lead', chord: ['G', 'P'] },
  { screen: 'consumption', href: '/consumption', label: 'nav_consumption', go: 'consumption', chord: ['G', 'C'] },
  { screen: 'services', href: '/services', label: 'nav_services', go: 'services', chord: ['G', 'M'] },
];

// The sidebar's screens: the development's (the product owner's decision of 2026-10-25, 11:14, P227). Consumption
// is reached by the quota gauge at the sidebar's foot, the palette, its chord and the account menu; the service map
// (milestone 4, M6) by the tower's line of services, the palette and its chord.
export const NAV: readonly NavItem[] = SCREENS.filter((item) => item.screen !== 'consumption' && item.screen !== 'services');

export const hrefOf = (to: GoScreen): string => SCREENS.find((item) => item.go === to)?.href ?? '/';

// The inbox's count as the badge draws it; nothing when nothing waits.
export function inboxBadge(waiting: number | null): string | null {
  if (waiting === null || waiting <= 0) return null;
  return waiting > 99 ? '99+' : String(waiting);
}

// The lead's dot beside Plans: undefined until the shell has read the lead.
export type LeadDot = 'on' | 'starting' | 'down' | 'unknown';

export function leadDot(state: LeadState | null | undefined): LeadDot {
  if (state === undefined) return 'unknown';
  if (leadPillShown(state)) return 'on';
  return state?.phase === 'starting' ? 'starting' : 'down';
}

// A team's session as the sidebar and the palette list it.
export type SessionState = 'waiting' | 'working' | 'reviewing' | 'ended';
export type SessionRow = { readonly id: string; readonly ticket: string; readonly title: string; readonly role: Role; readonly state: SessionState };

function stateOf(session: SessionSummary): SessionState {
  const phase: string = session.phase;
  if (phase === 'waiting_human') return 'waiting';
  if (phase === 'reviewing') return 'reviewing';
  if (phase === 'starting' || phase === 'working' || phase === 'paused' || session.takenOver) return 'working';
  return 'ended';
}

// The authors' and reviewers' sessions, the live ones first, each under
// its ticket's title; the lead's and a question's are not a team's.
export function sessionRows(sessions: readonly SessionSummary[], tickets: readonly { readonly id: string; readonly title: string }[]): SessionRow[] {
  const titles = new Map(tickets.map((ticket) => [ticket.id, ticket.title]));
  const rows = sessions.filter((s) => s.role === 'author' || s.role === 'reviewer')
    .map((s): SessionRow => ({ id: s.id, ticket: s.ticket, title: titles.get(s.ticket) ?? s.ticket, role: s.role, state: stateOf(s) }));
  return [...rows.filter((row) => row.state !== 'ended'), ...rows.filter((row) => row.state === 'ended')];
}

export type SessionGroup = { readonly key: Exclude<SessionState, 'ended'>; readonly rows: readonly SessionRow[] };

export function sessionGroups(rows: readonly SessionRow[]): SessionGroup[] {
  return (['waiting', 'working', 'reviewing'] as const)
    .map((key) => ({ key, rows: rows.filter((row) => row.state === key) }))
    .filter((group) => group.rows.length > 0);
}

// open: the full sidebar; rail: its icons only; bar: four icons at the
// foot of a phone. A wide screen opens it from 1400 px; below, a laptop or
// a tablet has the rail, which leaves the session screen's three columns
// their room; what `[` stored wins on both.
export type SidebarMode = 'open' | 'rail' | 'bar';
export const OPEN_FROM = 1400;
export const RAIL_FROM = 768;

export function sidebarMode(stored: string | null, width: number): SidebarMode {
  if (width < RAIL_FROM) return 'bar';
  if (stored === 'open' || stored === 'rail') return stored;
  return width >= OPEN_FROM ? 'open' : 'rail';
}

export const toggledSidebar = (mode: SidebarMode): 'open' | 'rail' => (mode === 'open' ? 'rail' : 'open');
