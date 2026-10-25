// The harness pick's wins on the Consumption screen (issue #329, P213): per
// ticket type, each agent's runs, how many passed their tests and how many
// were kept; an empty table says no pick has ended; every word from the
// catalog, in English and in French.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Consumption } from '../../../src/api/types.ts';
import { consumptionFixture } from '../../fixtures/consumption.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { ConsumptionView } from '../screens/consumption/Consumption.tsx';
import { winRows } from '../screens/consumption/model.ts';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('consumption', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('consumption', 'fr') });
const data = (): Consumption => consumptionFixture('guestbook', () => FIXTURE_NOW).read('Europe/Paris');
const WINS: Consumption['wins'] = [
  { type: 'bug', harness: 'claude-code', runs: 4, green: 3, wins: 1 },
  { type: 'bug', harness: 'codex', runs: 4, green: 4, wins: 3 },
  { type: 'other', harness: 'cursor', runs: 1, green: 0, wins: 0 },
];
const render = (t: Translate, language: 'en' | 'fr', value: Consumption) => html(<ConsumptionView data={value} t={t} language={language} now={FIXTURE_NOW} />);
const shown = (markup: string) => visibleText(markup).join('\n');

test('the fixtures\' ledger has picks, read by the service\'s own consumption()', () => {
  assert.ok(data().wins.length > 0);
});

test('the wins: a row per ticket type and agent, its runs, its passed tests and its wins, the best of each type first', () => {
  const markup = render(en, 'en', { ...data(), wins: WINS });
  assert.match(markup, /<section class="panel wins"[^>]*data-wins="shown"/);
  assert.match(markup, /<table class="wins-table">/);
  assert.equal(markup.match(/<tr data-win=/g)?.length, 3);
  const text = shown(markup);
  for (const expected of ['Which agent wins', 'When several agents work the same ticket, the variant kept is the cheapest whose own tests passed.',
    'Ticket type', 'Agent', 'Ran', 'Tests passed', 'Kept', 'Bug', 'Codex', 'Claude Code', 'Other', 'Cursor'])
    assert.ok(text.includes(expected), expected);
  assert.deepEqual(winRows(WINS, en).map((r) => [r.type, r.harness, r.runs, r.green, r.wins]), [
    ['Bug', 'Codex', '4', '4', '3'], ['Bug', 'Claude Code', '4', '3', '1'], ['Other', 'Cursor', '1', '0', '0'],
  ]);
  assert.match(markup, /data-win="bug:codex"/);
});

test('no pick ended yet: the panel says so, and draws no table', () => {
  const markup = render(en, 'en', { ...data(), wins: [] });
  assert.match(markup, /data-wins="empty"/);
  assert.doesNotMatch(markup, /<table class="wins-table">/);
  assert.ok(shown(markup).includes('No harness pick has ended yet. Start one with several agents on a ticket.'));
});

test('in French, every word of the panel is the catalog\'s', () => {
  const text = shown(render(fr, 'fr', { ...data(), wins: WINS }));
  for (const expected of ['Quel agent l’emporte', 'Type de ticket', 'Agent', 'Lancés', 'Tests réussis', 'Gardés', 'Bug', 'Autre', 'Codex', 'Cursor'])
    assert.ok(text.includes(expected), expected);
  assert.ok(shown(render(fr, 'fr', { ...data(), wins: [] })).includes('Aucun choix d’agent n’est encore terminé.'));
  for (const key of Object.keys(loadCatalog('consumption', 'en')).filter((k) => k.startsWith('consumption_win') || k.startsWith('consumption_type_')))
    assert.ok(key in loadCatalog('consumption', 'fr'), key);
});
