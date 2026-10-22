// The shell's rules that need no browser: when the "Lead · always on" pill
// shows, how many items wait in the inbox, and the theme the button sets.
import type { LeadState } from '../../../src/api/types.ts';

export const INBOX_MS = 15_000;
export const THEME_KEY = 'cleared-v2-theme';

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
