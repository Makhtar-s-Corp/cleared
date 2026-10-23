// The command palette's items (docs/v2/ui-overhaul-plan.md, 2.2.2, lane
// 35): what the cache holds, in the palette's order (what waits for you,
// the screen's gestures, the screens, the sessions, the rest); the gestures
// of the screen the person is on and of no other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_NOW, towerFixture } from '../../fixtures/tower.ts';
import { towerModel } from '../../web/screens/tower/model.ts';
import { GESTURES, paletteItems, type PaletteItem } from '../../web/shell/palette.ts';
import { sessionRows } from '../../web/shell/model.ts';
import { translator } from '../../web/lib/i18n.ts';
import { loadCatalog } from '../../src/catalog.ts';
import type { ScreenName } from '../../web/lib/routes.ts';

const catalog = (language: 'en' | 'fr') => ({ ...loadCatalog('shell', language), ...loadCatalog('tower', language) });
const en = translator(catalog('en'));

async function items(screen: ScreenName, gestures: readonly string[] = [], theme: 'light' | 'dark' = 'light'): Promise<PaletteItem[]> {
  const data = await towerFixture(FIXTURE_NOW);
  return paletteItems({ screen, needs: towerModel(data, FIXTURE_NOW).needs, sessions: sessionRows(data.sessions, data.tickets), gestures, theme, t: en });
}

const groups = (list: readonly PaletteItem[]) => [...new Set(list.map((item) => item.group))];

test('what waits for you first, then the screen\'s gestures, the screens, the sessions, the rest', async () => {
  const list = await items('tower', ['new_ticket']);
  assert.deepEqual(groups(list), ['waiting', 'actions', 'goto', 'sessions', 'general']);
  const waiting = list.filter((item) => item.group === 'waiting');
  assert.deepEqual(waiting.map((item) => item.detail), ['Release · 12 min · LOCAL-158', 'Permission · 3 min · LOCAL-161', 'Plan · 25 min · Goal'], 'what the tower shows, in its order');
  assert.equal(waiting[0]!.label, '“Comings and goings” replaces “Departures and arrivals”');
  assert.match((waiting[1]!.run as { href: string }).href, /^\/inbox#/);
  assert.match((waiting[2]!.run as { href: string }).href, /^\/plans\//);
  const empty = paletteItems({ screen: 'tower', needs: [], sessions: [], gestures: [], theme: 'light', t: en });
  assert.deepEqual(groups(empty), ['goto', 'general'], 'no empty group');
});

test('the screens with their chords, and the sessions by ticket and title', async () => {
  const list = await items('inbox');
  const goto = list.filter((item) => item.group === 'goto');
  assert.deepEqual(goto.map((item) => [item.label, item.shortcut?.join(' '), item.run]), [
    ['Tower', 'G T', { kind: 'navigate', href: '/' }],
    ['Inbox', 'G I', { kind: 'navigate', href: '/inbox' }],
    ['Sessions', 'G S', { kind: 'navigate', href: '/sessions' }],
    ['Plans', 'G P', { kind: 'navigate', href: '/lead' }],
  ]);
  const sessions = list.filter((item) => item.group === 'sessions');
  const week = sessions.find((item) => item.label === 'Upcoming: group entries by week');
  assert.ok(week);
  assert.equal(week.detail, 'LOCAL-161 · Author');
  assert.ok(week.keywords.includes('LOCAL-161'), 'found by its ticket\'s number');
  assert.match((week.run as { href: string }).href, /^\/sessions\/[A-Za-z0-9_-]+$/);
});

test('a screen\'s gestures on that screen only: nothing of another screen but its navigation', async () => {
  const everything = GESTURES.map((g) => g.id);
  for (const screen of ['tower', 'inbox', 'session', 'lead', 'ask'] as const) {
    const actions = (await items(screen, everything)).filter((item) => item.group === 'actions');
    const own = GESTURES.filter((g) => g.screen === screen).map((g) => g.id);
    assert.deepEqual(actions.map((item) => (item.run as { id: string }).id), own, screen);
  }
  const session = (await items('session', ['takeover'])).filter((item) => item.group === 'actions');
  assert.deepEqual(session.map((item) => item.label), ['Take over'], 'only the gestures the screen shows now');
  assert.deepEqual((await items('session', [])).filter((item) => item.group === 'actions'), []);
});

test('the theme item names the other theme; the sheet and the sidebar have their keys', async () => {
  const general = (theme: 'light' | 'dark') => items('tower', [], theme).then((list) => list.filter((item) => item.group === 'general'));
  assert.deepEqual((await general('light')).map((item) => [item.label, item.shortcut?.join(' ') ?? '']), [
    ['Switch to the dark theme', ''], ['Keyboard shortcuts', '?'], ['Collapse or expand the sidebar', '['],
  ]);
  assert.equal((await general('dark'))[0]!.label, 'Switch to the light theme');
});

test('every label the palette draws is in both catalogs', () => {
  for (const language of ['en', 'fr'] as const) {
    const all = catalog(language);
    for (const gesture of GESTURES) assert.ok(all[gesture.label], `${language}: ${gesture.label}`);
    for (const key of ['palette_placeholder', 'palette_label', 'palette_empty', 'palette_waiting', 'palette_actions', 'palette_goto', 'palette_sessions', 'palette_general', 'palette_open', 'cmd_sheet', 'cmd_sidebar']) assert.ok(all[key], `${language}: ${key}`);
  }
});
