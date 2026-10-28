// The sidebar is for the development (the product owner's decision of
// 2026-10-25, 11:14, P227): its screens are the tower, the inbox, the
// sessions and the plans; Consumption leaves them for a quota gauge at the
// sidebar's foot, and stays reachable by its address, the palette and its
// chord. The gauge says the week's quota that matters most: the first to
// reach 100 % before its reset, else the most used; its colour is the
// Consumption screen's verdict; its reset is a weekday and a clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Consumption, Projection, Quota } from '../../../src/api/types.ts';
import { consumptionFixture } from '../../fixtures/consumption.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { weekdayClock } from '../../web/lib/time.ts';
import { verdictOf } from '../../web/screens/consumption/model.ts';
import { quotaLevel } from '../../web/shell/quota.ts';
import { paletteItems } from '../../web/shell/palette.ts';
import { NAV, SCREENS, hrefOf } from '../../web/shell/model.ts';
import { weeklyQuota } from '../../web/shell/quota.ts';

const catalog = (language: 'en' | 'fr') => ({ ...loadCatalog('shell', language), ...loadCatalog('tower', language) });
const fr = translator(catalog('fr'));
const en = translator(catalog('en'));

const quota = (usedPercent: number, projection: Projection, window: Quota['window'] = 'seven_day'): Quota =>
  ({ window, usedPercent, resetsAt: '2026-10-27T08:59:00Z', observedAt: '2026-10-21T07:00:00Z', source: 'session', projection });
const data = (...quotas: Quota[][]): Consumption =>
  ({ harnesses: quotas.map((q, i) => ({ harness: `h${i}`, tokens: 0, perDay: [], quotas: q, lastReading: null })) } as unknown as Consumption);

test('the sidebar\'s screens are the development\'s: Consumption is not among them, and stays reachable', () => {
  assert.deepEqual(NAV.map((item) => item.screen), ['tower', 'inbox', 'session', 'lead']);
  assert.ok(SCREENS.some((item) => item.screen === 'consumption'), 'every screen keeps its entry');
  assert.equal(hrefOf('consumption'), '/consumption');
  const goto = paletteItems({ screen: 'tower', needs: [], sessions: [], gestures: [], t: en }).filter((item) => item.group === 'goto');
  assert.ok(goto.some((item) => item.run.kind === 'navigate' && item.run.href === '/consumption'), 'the palette goes to Consumption');
});

test('the gauge says the week\'s quota that will be reached first, in the Consumption screen\'s verdict', () => {
  const fixture = consumptionFixture('guestbook', () => FIXTURE_NOW).read('Europe/Paris');
  const shown = weeklyQuota(fixture);
  assert.equal(shown.kind, 'measured');
  if (shown.kind !== 'measured') return;
  assert.equal(shown.percent, 62);
  assert.equal(shown.verdict, 'hit');
  // Reached comes before a reach to come; a reach to come before a quota that holds, however used.
  const hits = weeklyQuota(data([quota(90, { kind: 'holds', percentAtReset: 95 })], [quota(40, { kind: 'before_reset', hitsAt: '2026-10-26T10:00:00Z', nextHitsAt: '2026-11-01T10:00:00Z' })], [quota(100, { kind: 'reached' })]));
  assert.deepEqual(hits.kind === 'measured' ? [hits.percent, hits.verdict] : null, [100, 'hit']);
  const sooner = weeklyQuota(data([quota(50, { kind: 'before_reset', hitsAt: '2026-10-26T10:00:00Z', nextHitsAt: '2026-11-01T10:00:00Z' })], [quota(70, { kind: 'before_reset', hitsAt: '2026-10-27T10:00:00Z', nextHitsAt: '2026-11-02T10:00:00Z' })]));
  assert.equal(sooner.kind === 'measured' ? sooner.percent : null, 50, 'the first to reach 100 %');
  // None reached: the most used, its colour the screen's own.
  const most = weeklyQuota(data([quota(30, { kind: 'holds', percentAtReset: 60 })], [quota(55, { kind: 'too_early' })], [quota(99, { kind: 'holds', percentAtReset: 99 }, 'five_hour')]));
  assert.deepEqual(most.kind === 'measured' ? [most.percent, most.verdict] : null, [55, 'unknown'], 'a five-hour window is not the week\'s');
  for (const projection of [{ kind: 'idle' }, { kind: 'too_early' }, { kind: 'reached' }, { kind: 'holds', percentAtReset: 80 }, { kind: 'before_reset', hitsAt: 'x', nextHitsAt: 'y' }] as Projection[]) {
    const one = weeklyQuota(data([quota(10, projection)]));
    assert.equal(one.kind === 'measured' ? one.verdict : null, verdictOf(projection), `the same verdict as the screen for ${projection.kind}`);
  }
  assert.deepEqual(weeklyQuota(data([quota(20, { kind: 'idle' }, 'five_hour')])), { kind: 'none' });
  assert.deepEqual(weeklyQuota(null), { kind: 'none' });
});

test('the reset is a weekday and a clock, through lib/time.ts, in the page\'s language and the person\'s zone', () => {
  assert.equal(weekdayClock('2026-10-27T08:59:00Z', 'Europe/Paris', fr), 'mar. 9\u00a0h\u00a059');
  assert.equal(weekdayClock('2026-10-27T08:59:00Z', 'Europe/Paris', en), 'Tue 9:59');
  assert.equal(weekdayClock('2026-10-24T19:41:00Z', 'Europe/Paris', fr), 'sam. 21\u00a0h\u00a041');
  assert.equal(weekdayClock('2026-10-27T08:59:00Z', 'Not/AZone', en), 'Tue 8:59', 'an unknown zone reads as UTC');
});

test('the gauge\'s colour by how much is used (the project lead\'s review of #462): the accent to 80 %, amber past 80 %, red past 90 %', () => {
  assert.deepEqual([0, 62, 80, 80.5, 90, 90.1, 100, 120].map(quotaLevel), ['ok', 'ok', 'ok', 'high', 'high', 'over', 'over', 'over']);
});
