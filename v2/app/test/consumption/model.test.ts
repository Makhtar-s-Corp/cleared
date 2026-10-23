// The Consumption screen's rules (O15): the curve, the words of the
// projection before and after the reset, the dollars only where an agent
// reported them, the levers' choices and the calls they make, the dates and
// the numbers through Intl in both languages.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Consumption, HarnessConsumption } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { consumptionFixture } from '../../fixtures/consumption.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../web/lib/screen.ts';
import {
  averagePerDay, chartOf, consumptionPath, costView, dayInitial, dollars, headline, leverFailure, leverViews, measuredAt, modelName, moment, periodText, projectionLines,
  quotaOf, readConsumption, readFailure, resetIn, setLevers, tokensText, verdictOf,
} from '../../web/screens/consumption/model.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('consumption', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('consumption', 'fr') });
const ZONE = 'Europe/Paris';
const NBSP = '\u00a0';
const flat = (text: string) => text.replace(/\s/g, ' ');

const fixture = () => consumptionFixture('guestbook', () => FIXTURE_NOW);
const read = (): Consumption => fixture().read(ZONE);
const harness = (data: Consumption, name: string): HarnessConsumption => data.harnesses.find((h) => h.harness === name) as HarnessConsumption;

type Call = { readonly path: string; readonly method: string; readonly body: unknown };
function stub(answer: unknown): { readonly api: ScreenContext['api']; readonly calls: Call[] } {
  const calls: Call[] = [];
  const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body });
    return answer;
  }) as ScreenContext['api'];
  return { api, calls };
}

test('the curve puts the tallest day at the top and a day with none on the floor, one point per day', () => {
  const chart = chartOf([{ day: 'a', tokens: 0 }, { day: 'b', tokens: 50 }, { day: 'c', tokens: 100 }], 100, 50, 5);
  assert.deepEqual(chart.points.map((p) => [p.x, p.y]), [[5, 45], [50, 25], [95, 5]]);
  assert.equal(chart.line, 'M5 45 L50 25 L95 5');
  assert.equal(chart.area, 'M5 45 L50 25 L95 5 L95 45 L5 45 Z');
  const flat = chartOf([{ day: 'a', tokens: 0 }, { day: 'b', tokens: 0 }]);
  assert.ok(flat.points.every((p) => p.y === 58), 'all zero: the floor, no division by zero');
  assert.equal(chartOf([]).area, '');
});

test('the average is over the days that had use', () => {
  assert.deepEqual(averagePerDay({ tokens: 300, perDay: [{ day: 'a', tokens: 100 }, { day: 'b', tokens: 0 }, { day: 'c', tokens: 200 }] }), { tokens: 150, days: 2 });
  assert.deepEqual(averagePerDay({ tokens: 0, perDay: [{ day: 'a', tokens: 0 }] }), { tokens: 0, days: 0 });
});

test('numbers, dollars, days and dates go through Intl in the page\'s language', () => {
  assert.equal(tokensText(2_790_000_000, 'en'), '2.8B');
  assert.equal(tokensText(2_790_000_000, 'fr'), `2,8${NBSP}Md`);
  assert.equal(tokensText(717_900_000, 'fr'), `717,9${NBSP}M`);
  assert.equal(dollars(1234.5, 'en'), '$1,234.50');
  assert.match(dollars(1234.5, 'fr'), /^1 234,50 \$US$/);
  assert.equal(dayInitial('2026-10-19', 'en'), 'M');
  assert.equal(dayInitial('2026-10-19', 'fr'), 'L');
  assert.equal(moment('2026-10-23T21:18:00.000Z', ZONE, 'en'), 'Fri, Oct 23, 11:18 PM');
  assert.match(moment('2026-10-23T21:18:00.000Z', ZONE, 'fr'), /^ven\.? 23 oct\.?,? 23:18$/);
  assert.equal(flat(periodText(['2026-10-15', '2026-10-21'], 'en')), 'Oct 15 – 21, 2026');
  assert.match(flat(periodText(['2026-10-15', '2026-10-21'], 'fr')), /^15 ?[–-] ?21 oct\.? 2026$/);
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(modelName('something-else'), 'something-else');
});

test('the headline names the first agent to reach 100 % before its reset, else says none does, else that nothing is measured', () => {
  const data = read();
  const hit = headline(data, 'en', en);
  assert.equal(hit.kind, 'hit');
  assert.equal(hit.harness, 'codex');
  // FIXTURE_NOW is a local time: the hours come from the data, not from a constant.
  const codexQuota = quotaOf(harness(data, 'codex'))!;
  const hitsAt = (codexQuota.projection as { hitsAt: string }).hitsAt;
  assert.equal(flat(hit.text), flat(`At the average pace of this cycle, Codex would reach 100% on ${moment(hitsAt, ZONE, 'en')}, before its reset on ${moment(codexQuota.resetsAt, ZONE, 'en')}.`));
  assert.match(headline(data, 'fr', fr).text, new RegExp(`^Au rythme moyen de ce cycle, Codex atteindrait 100${NBSP}% le `));
  const calm = { ...data, harnesses: data.harnesses.map((h) => (h.harness === 'codex' ? { ...h, quotas: [] } : h)) };
  assert.deepEqual(headline(calm, 'en', en), { kind: 'ok', text: 'At the average pace of this cycle, no agent reaches 100% before its reset.' });
  const none = { ...data, harnesses: data.harnesses.map((h) => ({ ...h, quotas: [] })) };
  assert.equal(headline(none, 'en', en).kind, 'none');
});

test('each projection is said before and after the reset', () => {
  const data = read();
  const claude = harness(data, 'claude-code');
  const codex = harness(data, 'codex');
  const holds = projectionLines(quotaOf(claude)!, claude, ZONE, 'en', en);
  assert.equal(flat(holds.before), flat(`Claude Code holds until the reset on ${moment(quotaOf(claude)!.resetsAt, ZONE, 'en')}, at about 82.3% used.`));
  assert.equal(holds.after, 'After the reset, the same pace would end the next cycle at about 82.3%.');
  const hits = projectionLines(quotaOf(codex)!, codex, ZONE, 'fr', fr);
  assert.match(hits.before, new RegExp(`^Codex atteint 100${NBSP}% le .*, avant le reset du `));
  assert.match(hits.after ?? '', new RegExp(`^Après le reset, le même rythme atteindrait de nouveau 100${NBSP}% le `));
  assert.equal(verdictOf(quotaOf(codex)!.projection), 'hit');
  assert.equal(verdictOf(quotaOf(claude)!.projection), 'ok');
  assert.equal(verdictOf({ kind: 'too_early' }), 'unknown');
  const reset = { ...quotaOf(claude)!, projection: { kind: 'reached' as const } };
  assert.match(projectionLines(reset, claude, ZONE, 'en', en).before, /^Claude Code is at 100%\. It resets on /);
  assert.equal(projectionLines({ ...reset, projection: { kind: 'idle' } }, claude, ZONE, 'en', en).before, 'Claude Code has used nothing in this window.');
  assert.match(projectionLines({ ...reset, projection: { kind: 'too_early' } }, claude, ZONE, 'en', en).before, /only just opened/);
});

test('the reset is said as a human duration, never in milliseconds or as an ISO time', () => {
  const claude = harness(read(), 'claude-code');
  const quota = quotaOf(claude)!;
  assert.equal(flat(resetIn(quota, FIXTURE_NOW, en)), 'Resets in 3d 12h');
  assert.equal(flat(resetIn(quota, FIXTURE_NOW, fr)), 'Reset dans 3 j 12 h');
  assert.equal(flat(resetIn({ resetsAt: new Date(FIXTURE_NOW.getTime() + 42 * 60_000).toISOString() }, FIXTURE_NOW, fr)), 'Reset dans 42 min');
  assert.equal(flat(resetIn({ resetsAt: new Date(FIXTURE_NOW.getTime() - 5_000).toISOString() }, FIXTURE_NOW, en)), 'Resets in 0 min', 'a reset that has passed is never negative');
  assert.equal(flat(measuredAt(read(), 'en', en)), flat(`Measured ${moment(FIXTURE_NOW.toISOString(), ZONE, 'en')}`));
});

test('the cost is shown only for an agent that reported one, and says when it is partial', () => {
  const data = read();
  const view = costView(data, 'en', en)!;
  assert.deepEqual(view.rows.map((r) => r.harness), ['claude-code'], 'Codex reported none: no row, no zero');
  assert.match(view.total, /^\$\d/);
  assert.equal(view.rows[0]?.partial, null);
  const partial = { ...data, harnesses: data.harnesses.map((h) => (h.harness === 'claude-code' ? { ...h, costTurns: { reported: 9, turns: 14 } } : h)) };
  assert.equal(costView(partial, 'en', en)?.rows[0]?.partial, 'partial: 9 of 14 turns reported');
  assert.equal(costView(partial, 'fr', fr)?.rows[0]?.partial, `partiel${NBSP}: 9 tours sur 14 l'indiquent`);
  const none = { ...data, harnesses: data.harnesses.map((h) => ({ ...h, costUsd: null })) };
  assert.equal(costView(none, 'en', en), null, 'no cost reported anywhere: nothing at all, no estimate');
});

test('the levers offer the models the owner may choose, never the reviewers\', and each choice is the change to send', () => {
  const [model, lanes, pause] = leverViews(read().levers, en);
  assert.deepEqual(model!.choices.map((c) => [c.label, c.pressed, c.change]), [
    ['Opus 5.5', false, { model: 'claude-opus-5-5' }], ['Haiku 5.5', false, { model: 'claude-haiku-5-5' }], ['Default', true, { model: null }],
  ]);
  assert.equal(model!.state, 'Configured model: Opus 5.5');
  assert.match(model!.detail, /Reviewers stay on Sonnet 5\.5\./);
  assert.deepEqual(lanes!.choices.map((c) => [c.label, c.change]), [['1', { maxLanes: 1 }], ['2', { maxLanes: 2 }], ['3', { maxLanes: 3 }], ['No limit', { maxLanes: null }]]);
  assert.equal(lanes!.state, 'As each plan says');
  assert.deepEqual(pause!.choices.map((c) => [c.label, c.change]), [['Pause', { paused: true }]]);
  const on = leverViews({ model: { ...read().levers.model, choice: 'claude-haiku-5-5', current: 'claude-haiku-5-5' }, maxLanes: { choice: 1, options: [1, 2, 3] }, paused: true }, fr);
  assert.equal(on[0]!.state, 'Les nouveaux départs utilisent Haiku 5.5');
  assert.equal(on[0]!.choices.find((c) => c.id === 'claude-haiku-5-5')?.pressed, true);
  assert.equal(on[1]!.state, 'Une session à la fois');
  assert.equal(on[2]!.state, 'Les programmations sont en pause');
  assert.deepEqual(on[2]!.choices.map((c) => [c.label, c.change]), [['Reprendre', { paused: false }]]);
});

test('the screen reads /consumption with the person\'s zone and writes the levers through the service', async () => {
  const levers = read().levers;
  const reading = stub(read());
  await readConsumption(reading.api, 'Europe/Paris');
  assert.deepEqual(reading.calls, [{ path: '/consumption?tz=Europe%2FParis', method: 'GET', body: undefined }]);
  assert.equal(consumptionPath('America/Sao_Paulo'), '/consumption?tz=America%2FSao_Paulo');
  const writing = stub(levers);
  await setLevers(writing.api, { maxLanes: 1 });
  assert.deepEqual(writing.calls, [{ path: '/consumption/levers', method: 'POST', body: { maxLanes: 1 } }]);
});

test('a refusal is said in the catalog, not in the service\'s words', () => {
  assert.equal(leverFailure(new ApiError(403, 'unknown user')), 'consumption_lever_forbidden');
  assert.equal(leverFailure(new ApiError(400, 'the author\'s model cannot be the reviewers')), 'consumption_lever_refused');
  assert.equal(leverFailure(new ApiError(503, 'the consumption is not available')), 'consumption_down');
  assert.equal(leverFailure(new Error('network')), 'consumption_lever_failed');
  assert.equal(readFailure(new ApiError(503, 'x')), 'consumption_down');
  assert.equal(readFailure(new ApiError(500, 'x')), 'consumption_read_failed');
  for (const key of ['consumption_lever_forbidden', 'consumption_lever_refused', 'consumption_down', 'consumption_lever_failed', 'consumption_read_failed']) {
    assert.ok(en(key) && !en(key).includes('⟦') && !fr(key).includes('⟦'), key);
  }
});

test('the fixtures answer through the service\'s own levers: a reviewer\'s model is refused, a good change is kept', () => {
  const source = fixture();
  assert.deepEqual(source.write({ model: 'claude-sonnet-5-5' }, 'u1').status, 400);
  const done = source.write({ model: 'claude-haiku-5-5', maxLanes: 2, paused: true }, 'u1');
  assert.equal(done.status, 200);
  assert.deepEqual(source.read(ZONE).levers, 'body' in done ? done.body : undefined);
  assert.equal(source.read(ZONE).levers.paused, true);
});
