// The command palette's items (docs/v2/ui-overhaul-plan.md, 2.2.2, lane
// 35): what the cache holds, in the palette's order (what waits for you,
// the screen's gestures, the screens, the sessions, the rest); the gestures
// of the screen the person is on and of no other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_NOW, towerFixture } from '../../fixtures/tower.ts';
import { towerModel } from '../../web/screens/tower/model.ts';
import { GESTURES, GROUPS, groupOrder, paletteItems, rank, shownItems, type PaletteItem } from '../../web/shell/palette.ts';
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
  assert.deepEqual(waiting.map((item) => item.detail), ['Permission · 3\u00a0min · LOCAL-161', 'Release · 12\u00a0min · LOCAL-158', 'Plan · 25\u00a0min · Goal'], 'what blocks a session first (lane 37)');
  assert.equal(waiting[1]!.label, '“Comings and goings” replaces “Departures and arrivals”');
  assert.equal(waiting[0]!.label, 'Install date-fns', 'a request by its intent, as the inbox says it');
  assert.match((waiting[0]!.run as { href: string }).href, /^\/inbox#/);
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
    ['Consumption', 'G C', { kind: 'navigate', href: '/consumption' }],
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

test('a ticket\'s number typed alone puts its sessions first, above what waits on the same ticket', () => {
  // base: what cmdk's own filter gave each item for the query.
  assert.equal(rank('session-fixture-161', '161', ['LOCAL-161', '161'], 0.6), 1);
  assert.equal(rank('session-fixture-161', 'local-161', ['LOCAL-161', '161'], 0.6), 1);
  assert.ok(rank('waiting-request-161', '161', ['LOCAL-161', 'permission'], 0.95) < 1, 'what waits on that ticket comes after its session');
  assert.equal(rank('session-fixture-160', '161', ['LOCAL-160', '160'], 0), 0, 'another ticket stays out');
  assert.equal(rank('goto-inbox', 'inbox', ['Inbox'], 0.9), 0.99, 'a word that holds the query ranks high');
  assert.equal(rank('waiting-x', 'date', ['LOCAL-161'], 0.7), 0.5, 'a scatter of letters ranks low');
});

test('the groups keep their order, but a ticket\'s number puts the sessions first', () => {
  assert.deepEqual(groupOrder(''), GROUPS);
  assert.deepEqual(groupOrder('inbox'), GROUPS);
  assert.deepEqual(groupOrder('161'), ['sessions', 'waiting', 'actions', 'goto', 'general']);
  assert.deepEqual(groupOrder(' LOCAL-161 '), ['sessions', 'waiting', 'actions', 'goto', 'general']);
});

test('a word the person typed outranks a scatter of its letters, and the groups follow their best match (art director, item 2)', async () => {
  // "upcoming": the session's title holds it; the long Knowledge title only scatters its letters.
  const session = rank('session-fixture-1', 'upcoming', ['Upcoming: group entries by week', 'LOCAL-161 · Author', 'LOCAL-161', '161'], 0.4);
  const scatter = rank('waiting-knowledge', 'upcoming', ['The archive page reuses the list\'s heading: a heading changes in both templates.', 'Knowledge · 50\u00a0min · LOCAL-158', 'LOCAL-158'], 0.6);
  assert.ok(session > scatter, `${session} > ${scatter}`);
  assert.deepEqual(groupOrder('upcoming', { waiting: scatter, sessions: session, goto: 0 }), ['sessions', 'waiting', 'actions', 'goto', 'general']);
  assert.deepEqual(groupOrder('', { sessions: 1 }), GROUPS, 'no query: the fixed order');
});

test('with no query, what needs the person shows three rows, so the screens are on the first screen of the palette (item 4)', async () => {
  const list = await items('tower');
  const many = [...list, ...list.filter((i) => i.group === 'waiting').map((i) => ({ ...i, id: `${i.id}-again` }))];
  assert.equal(shownItems(many, '').filter((i) => i.group === 'waiting').length, 3);
  assert.equal(shownItems(many, 'a').filter((i) => i.group === 'waiting').length, many.filter((i) => i.group === 'waiting').length, 'a query searches them all');
});

test('the three rows kept with no query are what blocks a session first: requests and questions, then releases, then the rest (art director of lane 37)', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const needs = towerModel(data, FIXTURE_NOW).needs;
  const permission = needs.find((n) => n.kind === 'permission')!;
  const release = needs.find((n) => n.kind === 'release')!;
  const plan = needs.find((n) => n.kind === 'plan')!;
  // The fixtures source's order on the tower: oldest first, the requests last.
  const aged = [{ ...plan, kind: 'knowledge' as const, id: 'k' }, { ...plan, kind: 'contract' as const, id: 'c' }, release, plan, permission, { ...permission, id: 'p2' }];
  const list = paletteItems({ screen: 'inbox', needs: aged, sessions: [], gestures: [], theme: 'light', t: en });
  const shown = shownItems(list, '').filter((i) => i.group === 'waiting').map((i) => i.id);
  assert.deepEqual(shown, [`waiting-${permission.id}`, 'waiting-p2', `waiting-${release.id}`]);
});

test('a session offers its permission\'s three answers while it shows them (item 3)', async () => {
  const actions = (await items('session', ['session_allow_once', 'session_allow_always', 'session_reject_once', 'takeover'])).filter((i) => i.group === 'actions');
  assert.deepEqual(actions.map((i) => i.label), ['Allow once', 'Always in this project', 'Deny', 'Take over']);
  assert.ok(GESTURES.some((g) => g.id === 'ask_code' && g.screen === 'tower'), 'the tower\'s Ask about the code too');
});
