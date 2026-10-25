// The sidebar's rules (docs/v2/ui-overhaul-plan.md, 2.2.1 and U8, lane 35):
// its four screens and their chords, the inbox's count, the lead's dot,
// the live sessions grouped by state, and how wide it is at each width
// with the choice `[` stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_NOW, towerFixture } from '../../fixtures/tower.ts';
import { NAV, SCREENS, inboxBadge, leadDot, sessionGroups, sessionRows, sidebarMode, toggledSidebar } from '../../web/shell/model.ts';
import { SHORTCUTS } from '../../web/shell/keys.ts';
import type { LeadState, SessionSummary } from '../../../src/api/types.ts';

const lead = (phase: LeadState['phase']): LeadState => ({ phase } as LeadState);

// The sidebar draws the development's screens; Consumption keeps its address and its chord, and the palette's
// Go to lists every screen (the product owner's decision of 2026-10-25, 11:14, P227).
test('the screens in order, each with its address and the chord that reaches it', () => {
  assert.deepEqual(SCREENS.map((item) => [item.screen, item.href]), [['tower', '/'], ['inbox', '/inbox'], ['session', '/sessions'], ['lead', '/lead'], ['consumption', '/consumption'], ['services', '/services']]);
  // The service map is reached from the tower's line of services, the palette and G M, not the sidebar (milestone 4, section 11).
  assert.deepEqual(NAV.map((item) => item.screen), ['tower', 'inbox', 'session', 'lead']);
  for (const item of SCREENS) {
    const chord = SHORTCUTS.find((s) => s.action.kind === 'go' && s.action.to === item.go);
    assert.ok(chord, item.screen);
    assert.deepEqual(item.chord, chord.keys, `${item.screen}: the sidebar shows the chord the keys bind`);
  }
});

test('the inbox count says what waits, and nothing when nothing waits or the count is not known', () => {
  assert.equal(inboxBadge(null), null);
  assert.equal(inboxBadge(0), null);
  assert.equal(inboxBadge(5), '5');
  assert.equal(inboxBadge(99), '99');
  assert.equal(inboxBadge(140), '99+');
});

test('the lead\'s dot: on while a generation is live or refreshing, starting, down, and unknown before the first read', () => {
  for (const phase of ['idle', 'working', 'refreshing'] as const) assert.equal(leadDot(lead(phase)), 'on', phase);
  assert.equal(leadDot(lead('starting')), 'starting');
  assert.equal(leadDot(lead('down')), 'down');
  assert.equal(leadDot(null), 'down', 'the service answered with no lead');
  assert.equal(leadDot(undefined), 'unknown');
});

test('the live sessions of the teams, grouped: what waits for you, what works, what reviews', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const extra: SessionSummary[] = [
    { ...data.sessions[0]!, id: 'lead-1', role: 'lead', ticket: 'lead', phase: 'working' },
    { ...data.sessions[0]!, id: 'reader-1', role: 'reader', ticket: 'LOCAL-160', phase: 'working' },
    { ...data.sessions[0]!, id: 'ended-1', ticket: 'LOCAL-158', phase: 'done' },
    { ...data.sessions[0]!, id: 'taken-1', ticket: 'LOCAL-152', role: 'author', phase: 'paused' as SessionSummary['phase'], takenOver: { by: 'someone', at: FIXTURE_NOW.toISOString() } },
  ];
  const rows = sessionRows([...data.sessions, ...extra], data.tickets);
  assert.ok(!rows.some((row) => row.id === 'lead-1' || row.id === 'reader-1'), 'the lead\'s and a reader\'s sessions are not a team\'s');
  assert.equal(rows.find((row) => row.id === 'ended-1')?.state, 'ended');
  assert.deepEqual(rows.slice(-1).map((row) => row.id), ['ended-1'], 'the ended ones last');
  const groups = sessionGroups(rows);
  assert.deepEqual(groups.map((group) => group.key), ['waiting', 'working', 'reviewing']);
  assert.deepEqual(groups[0]!.rows.map((row) => row.ticket), ['LOCAL-161']);
  assert.deepEqual(groups[1]!.rows.map((row) => row.ticket).sort(), ['LOCAL-152', 'LOCAL-160', 'LOCAL-163'], 'a session taken over is worked on, by a person');
  assert.deepEqual(groups[2]!.rows.map((row) => row.ticket), ['LOCAL-152']);
  assert.equal(groups[0]!.rows[0]!.title, 'Upcoming: group entries by week', 'the ticket\'s title');
  assert.deepEqual(sessionGroups(rows.filter((row) => row.state === 'ended')), [], 'no group without a row');
});

test('open from 1400 px, a rail from 768, a bottom bar below; `[` stores the other of open and rail', () => {
  assert.equal(sidebarMode(null, 1440), 'open');
  assert.equal(sidebarMode(null, 1400), 'open');
  assert.equal(sidebarMode(null, 1399), 'rail');
  assert.equal(sidebarMode(null, 1280), 'rail', 'a laptop leaves its width to the screen');
  assert.equal(sidebarMode(null, 768), 'rail');
  assert.equal(sidebarMode(null, 767), 'bar');
  assert.equal(sidebarMode('rail', 1440), 'rail');
  assert.equal(sidebarMode('open', 900), 'open');
  assert.equal(sidebarMode('open', 390), 'bar', 'a phone always has the bottom bar');
  assert.equal(sidebarMode('anything', 1440), 'open', 'an unknown value is no choice');
  assert.equal(toggledSidebar('open'), 'rail');
  assert.equal(toggledSidebar('rail'), 'open');
  assert.equal(toggledSidebar('bar'), 'open');
});
