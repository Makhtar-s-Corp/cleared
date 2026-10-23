// The shell's keyboard (docs/v2/ui-overhaul-plan.md, 2.2.3, lane 35): the
// table the sheet lists is the table the keys are read with, so every
// shortcut in the sheet is bound and every bound key is in the sheet; the
// G-chords and their timeout; nothing fires while the person types.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHORD_MS, SCREEN_KEYS, SHORTCUTS, keyLabel, resolveKey, sheetRows,
  type Action, type Chord, type Focus, type KeyContext, type KeyInput, type Shortcut,
} from '../../web/shell/keys.ts';
import type { ScreenName } from '../../web/lib/routes.ts';
import { loadCatalog } from '../../src/catalog.ts';

const SCREENS: readonly ScreenName[] = ['tower', 'inbox', 'session', 'lead', 'ask'];

function press(token: string, mac: boolean): KeyInput {
  const mod = token.startsWith('Mod+');
  const key = mod ? token.slice(4) : token;
  const named: Record<string, string> = { Enter: 'Enter', Esc: 'Escape' };
  const value = named[key] ?? (key.length === 1 ? key.toLowerCase() : key);
  return { key: value === '?' ? '?' : value, meta: mod && mac, ctrl: mod && !mac, alt: false, shift: value === '?' };
}

// Plays a shortcut's keys in order, as typed, and returns the last action.
function play(shortcut: Shortcut, context: Omit<KeyContext, 'now'>): Action | null {
  let chord: Chord = null;
  let action: Action | null = null;
  shortcut.keys.forEach((token, index) => {
    const read = resolveKey(press(token, context.mac), { ...context, now: 1000 + index * 100 }, chord);
    chord = read.chord;
    action = read.action;
  });
  return action;
}

const where = (shortcut: Shortcut): { screen: ScreenName; focus: Focus } => ({
  screen: shortcut.screens?.[0] ?? 'tower',
  focus: shortcut.scope === 'field' ? 'field' : 'none',
});

test('every shortcut the sheet lists is bound, on a Mac and elsewhere', () => {
  for (const mac of [true, false]) {
    for (const shortcut of SHORTCUTS) {
      assert.deepEqual(play(shortcut, { ...where(shortcut), overlay: false, mac }), shortcut.action, `${shortcut.id} (${mac ? 'mac' : 'other'})`);
    }
  }
});

test('every key that does something is in the sheet of the screen it does it on', () => {
  const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789[]?/.,;', 'Enter', 'Escape', 'ArrowDown', 'Tab', ' '];
  const listed = (screen: ScreenName) => sheetRows(screen).map((row) => JSON.stringify(row.action));
  for (const mac of [true, false]) {
    for (const screen of SCREENS) {
      for (const focus of ['none', 'field', 'control', 'terminal'] as const) {
        for (const key of keys) {
          for (const mod of [false, true]) {
            const input: KeyInput = { key, meta: mod && mac, ctrl: mod && !mac, alt: false, shift: key === '?' };
            // After a G, too: the chord's second key.
            for (const chord of [null, { key: 'g', at: 1000 }] as const) {
              const { action } = resolveKey(input, { screen, focus, overlay: false, mac, now: 1100 }, chord);
              if (action) assert.ok(listed(screen).includes(JSON.stringify(action)), `${screen} ${focus} ${mod ? 'Mod+' : ''}${key} gives ${JSON.stringify(action)}, not in the sheet`);
            }
          }
        }
      }
    }
  }
});

test('G then T, I, S or P goes to a screen; a G left alone times out', () => {
  const context = { screen: 'session' as const, focus: 'none' as const, overlay: false, mac: true };
  const g = resolveKey({ key: 'g', meta: false, ctrl: false, alt: false, shift: false }, { ...context, now: 10_000 }, null);
  assert.equal(g.action, null);
  assert.ok(g.chord);
  for (const [key, to] of [['t', 'tower'], ['i', 'inbox'], ['s', 'sessions'], ['p', 'lead']] as const) {
    assert.deepEqual(resolveKey({ key, meta: false, ctrl: false, alt: false, shift: false }, { ...context, now: 10_500 }, g.chord).action, { kind: 'go', to }, key);
  }
  const late = resolveKey({ key: 'i', meta: false, ctrl: false, alt: false, shift: false }, { ...context, now: 10_000 + CHORD_MS + 1 }, g.chord);
  assert.equal(late.action, null, 'too late: the I is a plain I, which does nothing');
  assert.equal(late.chord, null);
  // Another key after G drops the chord and is read as itself.
  const other = resolveKey({ key: 'j', meta: false, ctrl: false, alt: false, shift: false }, { ...context, screen: 'tower', now: 10_200 }, g.chord);
  assert.deepEqual(other.action, { kind: 'next' });
  assert.equal(other.chord, null);
});

test('nothing but the palette and the send fire while the person types, and nothing reaches past the terminal', () => {
  const base = { screen: 'tower' as const, overlay: false, mac: false, now: 1 };
  for (const key of ['g', 'j', 'k', '?', '[', '1', 'Escape', 'Enter']) {
    assert.equal(resolveKey({ key, meta: false, ctrl: false, alt: false, shift: key === '?' }, { ...base, focus: 'field' }, null).action, null, key);
  }
  assert.deepEqual(resolveKey({ key: 'k', meta: false, ctrl: true, alt: false, shift: false }, { ...base, focus: 'field' }, null).action, { kind: 'palette' });
  assert.deepEqual(resolveKey({ key: 'Enter', meta: false, ctrl: true, alt: false, shift: false }, { ...base, focus: 'field' }, null).action, { kind: 'send' });
  // In the terminal, Ctrl-K is the shell's own (kill the line): the app takes nothing.
  for (const key of ['k', 'Enter', 'g', '?']) {
    assert.equal(resolveKey({ key, meta: false, ctrl: key !== 'g' && key !== '?', alt: false, shift: false }, { ...base, focus: 'terminal' }, null).action, null, key);
  }
  // With the palette or the sheet open, they read the keys themselves.
  assert.equal(resolveKey({ key: 'j', meta: false, ctrl: false, alt: false, shift: false }, { ...base, focus: 'none', overlay: true }, null).action, null);
  // A modifier other than the palette's makes a plain key nobody's: the browser keeps Ctrl-J, Alt-G.
  assert.equal(resolveKey({ key: 'j', meta: false, ctrl: true, alt: false, shift: false }, { ...base, focus: 'none' }, null).action, null);
  assert.equal(resolveKey({ key: 'g', meta: false, ctrl: false, alt: true, shift: false }, { ...base, focus: 'none' }, null).chord, null);
  // On a Mac the palette is Cmd-K, not Ctrl-K (which a text field uses).
  assert.equal(resolveKey({ key: 'k', meta: false, ctrl: true, alt: false, shift: false }, { ...base, mac: true, focus: 'none' }, null).action, null);
});

test('1 to 4 pick a session\'s tab on the session screen only; Enter on a link or a button stays the browser\'s', () => {
  const press1 = (screen: ScreenName) => resolveKey({ key: '3', meta: false, ctrl: false, alt: false, shift: false }, { screen, focus: 'none', overlay: false, mac: true, now: 1 }, null).action;
  assert.deepEqual(press1('session'), { kind: 'tab', n: 3 });
  assert.equal(press1('tower'), null);
  assert.equal(resolveKey({ key: 'Enter', meta: false, ctrl: false, alt: false, shift: false }, { screen: 'tower', focus: 'control', overlay: false, mac: true, now: 1 }, null).action, null);
  assert.deepEqual(resolveKey({ key: 'Enter', meta: false, ctrl: false, alt: false, shift: false }, { screen: 'tower', focus: 'none', overlay: false, mac: true, now: 1 }, null).action, { kind: 'open' });
});

test('a screen\'s own keys join the sheet of that screen only, and every label is in both catalogs', () => {
  for (const screen of SCREENS) {
    const rows = sheetRows(screen);
    for (const own of SCREEN_KEYS[screen] ?? []) assert.ok(rows.includes(own), `${screen}: ${own.id}`);
    for (const other of SCREENS.filter((s) => s !== screen)) for (const own of SCREEN_KEYS[other] ?? []) assert.ok(!rows.includes(own), `${screen} lists ${other}'s ${own.id}`);
    assert.ok(rows.every((row) => !row.screens || row.screens.includes(screen)), `${screen} lists a key of another screen`);
  }
  const ids = SHORTCUTS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'one id per shortcut');
  for (const language of ['en', 'fr'] as const) {
    const catalog = loadCatalog('shell', language);
    for (const shortcut of SHORTCUTS) assert.ok(catalog[shortcut.label], `${language}: ${shortcut.label}`);
    for (const group of new Set(SHORTCUTS.map((s) => `keys_group_${s.scope}`))) assert.ok(catalog[group], `${language}: ${group}`);
  }
  assert.equal(keyLabel('Mod', true), '⌘');
  assert.equal(keyLabel('Mod', false), 'Ctrl');
  assert.equal(keyLabel('Esc', true), 'Esc');
  assert.equal(keyLabel('g', true), 'G');
});
