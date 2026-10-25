// The week's figures on the Consumption screen (C17, issue #396): the tickets
// merged, the tokens and the agents' time, the dollars only as the agents
// reported them (else a line that says the week is counted in tokens and
// time), each merged ticket's estimate against what it took, in minutes, and
// the same per service; every word from the catalog, in English and French,
// every duration through lib/time.ts. The figures are the service's own
// weekFigures() over the fixtures' ledger (fixtures/consumption.ts, `week`).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { WeekFigures } from '../../../src/api/types.ts';
import { consumptionFixture } from '../../fixtures/consumption.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { ConsumptionView } from '../screens/consumption/Consumption.tsx';
import { weekView } from '../screens/consumption/model.ts';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('consumption', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('consumption', 'fr') });
const fixture = consumptionFixture('guestbook', () => FIXTURE_NOW, { week: true });
const data = () => fixture.read('Europe/Paris');
const week = (): Promise<WeekFigures> => fixture.week('Europe/Paris');
const render = (t: Translate, language: 'en' | 'fr', figures: WeekFigures | undefined, weekFailed = false) =>
  html(<ConsumptionView data={data()} t={t} language={language} now={FIXTURE_NOW} {...(figures ? { week: figures } : {})} weekFailed={weekFailed} />);
// The catalogs keep a number and its unit together with non-breaking spaces; the words are compared with plain ones.
const shown = (markup: string) => visibleText(markup).join('\n').replace(/[\u00a0\u202f]/g, ' ');

test('the fixtures\' week, read by the service\'s own weekFigures(): three merged, the mirror\'s close left out, the same tokens as the agents\' cards', async () => {
  const figures = await week();
  assert.deepEqual(figures.merged.map((m) => m.id), ['LOCAL-2', 'LOCAL-3', 'LOCAL-4']);
  assert.equal(figures.spend.tokens, data().harnesses.reduce((sum, h) => sum + h.tokens, 0));
  assert.equal(figures.spend.costUsd, null, 'Codex reports no dollars');
});

test('the panel: what the week merged, its tokens and its agents\' time, and why it says no dollars', async () => {
  const markup = render(en, 'en', await week());
  assert.match(markup, /<section class="panel week"[^>]*data-week="shown"/);
  const text = shown(markup);
  for (const expected of ['This week', '3 tickets merged', 'tokens used', 'of agent work',
    'No dollar figure: an agent reported none this week, so the week is counted in tokens and time.',
    'LOCAL-2', 'Show the newest entries first', 'estimated 30 min, took 42 min',
    'LOCAL-3', 'estimated 20 min, took 16 min', 'LOCAL-4', 'no plan estimate',
    'Estimates: 50 min planned, 58 min taken, over 2 of 3 merged tickets.'])
    assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('Closed on the tracker'), 'an issue closed on a tracker is not a merge');
  assert.doesNotMatch(text, /€|EUR/);
});

test('per service: each configured service, then the workspace\'s own row; dollars where every session of the row reported them', async () => {
  const view = weekView(await week(), 'en', en);
  assert.deepEqual(view.rows.map((r) => [r.key, r.name, r.merged, r.dollars]), [
    ['guestbook', 'guestbook', '2', 'not reported'],
    ['filter-api', 'filter-api', '2', '$1.80'],
    ['workspace', 'Workspace (lead, questions)', '0', '$0.35'],
  ]);
  const text = shown(render(en, 'en', await week()));
  for (const expected of ['Per service', 'Service', 'Merged', 'Tokens', 'Agent time', 'Dollars']) assert.ok(text.includes(expected), expected);
});

test('a week whose sessions all reported says its dollars, as the agents reported them; one merged ticket, none, a quiet week', async () => {
  const base = await week();
  const paid: WeekFigures = { ...base, spend: { ...base.spend, costUsd: 12.34 } };
  const text = shown(render(en, 'en', paid));
  assert.ok(text.includes('$12.34 API-equivalent, as the agents reported it'));
  assert.ok(!text.includes('No dollar figure'));
  assert.ok(shown(render(en, 'en', { ...base, merged: base.merged.slice(0, 1) })).includes('1 ticket merged'));
  const quiet: WeekFigures = { ...base, merged: [], spend: { sessions: 0, turns: 0, tokens: null, workMs: 0, costUsd: null }, estimates: { tickets: 0, estimatedMinutes: 0, actualMinutes: 0 }, services: [] };
  const still = shown(render(en, 'en', quiet));
  assert.ok(still.includes('No ticket merged'));
  assert.ok(still.includes('No agent worked this week.'));
  assert.ok(!still.includes('No dollar figure'), 'nothing to count, nothing to explain');
  assert.ok(!still.includes('Estimates:'));
  const unplanned = shown(render(en, 'en', { ...base, merged: base.merged.map((m) => ({ ...m, estimateMinutes: null })), estimates: { tickets: 0, estimatedMinutes: 0, actualMinutes: 0 } }));
  assert.ok(unplanned.includes('No merged ticket had a plan estimate.'));
});

test('before its read the panel is not drawn, and a failed read says so in the panel while the rest of the screen stays', async () => {
  assert.doesNotMatch(render(en, 'en', undefined), /data-week=/);
  const failed = render(en, 'en', undefined, true);
  assert.match(failed, /data-week="failed"/);
  assert.ok(shown(failed).includes('The week\'s figures did not load. This page tries again by itself.'));
  assert.ok(shown(failed).includes('What your agents consume'));
});

test('in French, every word of the panel is the catalog\'s, the durations and the amounts French', async () => {
  const text = shown(render(fr, 'fr', await week()));
  for (const expected of ['Cette semaine', '3 tickets fusionnés', 'jetons utilisés', 'de travail des agents',
    'Pas de montant en dollars : un agent n\'en a déclaré aucun cette semaine, la semaine se compte en jetons et en temps.',
    'estimé à 30 min, réalisé en 42 min', 'sans estimation de plan',
    'Estimations : 50 min prévues, 58 min réalisées, sur 2 des 3 tickets fusionnés.',
    'Par service', 'Fusionnés', 'Jetons', 'Temps des agents', 'Dollars', 'Espace de travail (Lead, questions)', 'non déclaré', '1,80 $US'])
    assert.ok(text.includes(expected), expected);
  for (const key of Object.keys(loadCatalog('consumption', 'en')).filter((k) => k.startsWith('consumption_week')))
    assert.ok(key in loadCatalog('consumption', 'fr'), key);
});
