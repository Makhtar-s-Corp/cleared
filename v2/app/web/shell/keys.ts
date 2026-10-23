// The app's keyboard (docs/v2/ui-overhaul-plan.md, 2.2.3, lane 35): one
// table, SHORTCUTS, that the shortcut sheet lists and resolveKey reads, so
// a key is in the sheet if and only if it does something. A screen's own
// keys (the inbox's A, T and R in lane 37) go in SCREEN_KEYS under its name:
// the sheet lists them on that screen, and the screen binds them itself.
// No React and no DOM here, so the node tests read it.
import type { ScreenName } from '../lib/routes.ts';

export type GoScreen = 'tower' | 'inbox' | 'sessions' | 'lead';

export type Action =
  | { readonly kind: 'palette' }
  | { readonly kind: 'sheet' }
  | { readonly kind: 'sidebar' }
  | { readonly kind: 'go'; readonly to: GoScreen }
  | { readonly kind: 'next' }
  | { readonly kind: 'previous' }
  | { readonly kind: 'open' }
  | { readonly kind: 'back' }
  | { readonly kind: 'tab'; readonly n: number }
  | { readonly kind: 'send' };

// global: anywhere but a field; list: the rows of the screen shown;
// session: a session's screen; field: while typing in a form's field.
export type Scope = 'global' | 'list' | 'session' | 'field';

export type Shortcut = {
  readonly id: string;
  readonly keys: readonly string[];           // pressed in order; Mod is Cmd on a Mac, Ctrl elsewhere
  readonly scope: Scope;
  readonly label: string;                     // the shell catalog's key
  readonly action: Action;
  readonly screens?: readonly ScreenName[];   // only there; absent: every screen
};

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'palette', keys: ['Mod+K'], scope: 'global', label: 'key_palette', action: { kind: 'palette' } },
  { id: 'sheet', keys: ['?'], scope: 'global', label: 'key_sheet', action: { kind: 'sheet' } },
  { id: 'sidebar', keys: ['['], scope: 'global', label: 'key_sidebar', action: { kind: 'sidebar' } },
  { id: 'go_tower', keys: ['G', 'T'], scope: 'global', label: 'key_go_tower', action: { kind: 'go', to: 'tower' } },
  { id: 'go_inbox', keys: ['G', 'I'], scope: 'global', label: 'key_go_inbox', action: { kind: 'go', to: 'inbox' } },
  { id: 'go_sessions', keys: ['G', 'S'], scope: 'global', label: 'key_go_sessions', action: { kind: 'go', to: 'sessions' } },
  { id: 'go_lead', keys: ['G', 'P'], scope: 'global', label: 'key_go_lead', action: { kind: 'go', to: 'lead' } },
  { id: 'next', keys: ['J'], scope: 'list', label: 'key_next', action: { kind: 'next' } },
  { id: 'previous', keys: ['K'], scope: 'list', label: 'key_previous', action: { kind: 'previous' } },
  { id: 'open', keys: ['Enter'], scope: 'list', label: 'key_open', action: { kind: 'open' } },
  { id: 'back', keys: ['Esc'], scope: 'list', label: 'key_back', action: { kind: 'back' } },
  ...[1, 2, 3, 4].map((n): Shortcut => ({ id: `tab_${n}`, keys: [String(n)], scope: 'session', label: `key_tab_${n}`, action: { kind: 'tab', n }, screens: ['session'] })),
  { id: 'send', keys: ['Mod+Enter'], scope: 'field', label: 'key_send', action: { kind: 'send' } },
];

// The keys a screen binds itself, listed in the sheet on that screen.
export const SCREEN_KEYS: Readonly<Partial<Record<ScreenName, readonly Shortcut[]>>> = {};

export const sheetRows = (screen: ScreenName): readonly Shortcut[] =>
  [...SHORTCUTS.filter((s) => !s.screens || s.screens.includes(screen)), ...(SCREEN_KEYS[screen] ?? [])];

// A G waits this long for its second key.
export const CHORD_MS = 1200;

// Where the key was typed: nowhere in particular, a form's field, the
// terminal (whose keys are the shell's own), or a link or a button.
export type Focus = 'none' | 'field' | 'terminal' | 'control';

export type KeyInput = { readonly key: string; readonly meta: boolean; readonly ctrl: boolean; readonly alt: boolean; readonly shift: boolean; readonly composing?: boolean };
export type KeyContext = { readonly screen: ScreenName; readonly focus: Focus; readonly overlay: boolean; readonly mac: boolean; readonly now: number };
export type Chord = { readonly key: string; readonly at: number } | null;

const CHORDS: Readonly<Record<string, GoScreen>> = { t: 'tower', i: 'inbox', s: 'sessions', p: 'lead' };

export function resolveKey(input: KeyInput, context: KeyContext, chord: Chord): { readonly action: Action | null; readonly chord: Chord } {
  const none = { action: null, chord: null } as const;
  if (input.composing || context.focus === 'terminal' || context.overlay) return none;
  const mod = context.mac ? input.meta && !input.ctrl : input.ctrl && !input.meta;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (mod && !input.alt) {
    if (key === 'k') return { action: { kind: 'palette' }, chord: null };
    if (key === 'Enter' && context.focus === 'field') return { action: { kind: 'send' }, chord: null };
    return none;
  }
  // AltGr arrives as Ctrl and Alt on Windows: [ and ? typed with it (a French keyboard) are themselves.
  const altGraph = input.ctrl && input.alt && !input.meta && (key === '[' || key === '?');
  if ((!altGraph && (input.meta || input.ctrl || input.alt)) || context.focus === 'field') return none;
  const pending = chord && context.now - chord.at <= CHORD_MS ? chord : null;
  if (pending) {
    const to = CHORDS[key];
    if (to) return { action: { kind: 'go', to }, chord: null };
    // Another key drops the chord and is read as itself.
  }
  switch (key) {
    case 'g': return { action: null, chord: { key: 'g', at: context.now } };
    case '?': return { action: { kind: 'sheet' }, chord: null };
    case '[': return { action: { kind: 'sidebar' }, chord: null };
    case 'j': return { action: { kind: 'next' }, chord: null };
    case 'k': return { action: { kind: 'previous' }, chord: null };
    case 'Escape': return { action: { kind: 'back' }, chord: null };
    // Enter on a link or a button is the browser's: it follows or presses it.
    case 'Enter': return context.focus === 'control' ? none : { action: { kind: 'open' }, chord: null };
    case '1': case '2': case '3': case '4':
      return context.screen === 'session' ? { action: { kind: 'tab', n: Number(key) }, chord: null } : none;
    default: return none;
  }
}

// How a key is written in the sheet and the palette: Enter and Esc in the
// person's language (Entrée, Échap) when a translator is given.
export function keyLabel(token: string, mac: boolean, t?: (key: string) => string): string {
  if (token === 'Mod') return mac ? '⌘' : 'Ctrl';
  if (token === 'Enter') return mac ? '↵' : t ? t('key_cap_enter') : 'Enter';
  if (token === 'Esc') return t ? t('key_cap_esc') : 'Esc';
  return token.length === 1 ? token.toUpperCase() : token;
}

// A shortcut's keys as the tokens drawn, one <kbd> each: "Mod+K" is two.
export const keyTokens = (shortcut: Pick<Shortcut, 'keys'>): string[] => shortcut.keys.flatMap((key) => key.split('+'));
