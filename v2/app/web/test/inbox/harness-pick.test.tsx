// A harness pick in the inbox (issue #329, P213) as HTML: each variant's
// column names its agent, its tests and its tokens; a pick that kept one says
// so, by which measure; one that kept none asks the owner, as plain variants
// do; every text from the catalog, in English and in French.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { VariantsItem } from '../../../../src/api/types.ts';
import { inboxFixture, variantsItem } from '../../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import type { InboxView } from '../../screens/inbox/model.ts';
import { renderDetail, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });

function viewOf(item: VariantsItem, language: 'en' | 'fr' = 'en'): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW);
  return {
    items: [item], tickets: fixture.tickets, sessions: fixture.sessions, selected: item.id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', language,
  };
}
const shown = (html: string) => visibleText(html).join('\n');

// The fixture's three variants on three agents, the second passing its tests with the fewest tokens.
function pick(outcome: VariantsItem['outcome']): VariantsItem {
  const base = variantsItem();
  const [one, two, three] = base.variants as [VariantsItem['variants'][number], VariantsItem['variants'][number], VariantsItem['variants'][number]];
  return {
    ...base, pick: true, outcome, state: outcome ? 'handled' : 'waiting',
    variants: [
      { ...one, harness: 'claude-code', tests: 'passed', tokens: 31_200, state: outcome ? 'dropped' : 'done' },
      { ...two, harness: 'codex', tests: 'passed', tokens: 12_400, state: outcome ? 'chosen' : 'done' },
      { ...three, harness: 'cursor', tests: 'failed', tokens: null },
    ],
  };
}

test('each column names its agent, its tests and its tokens; plain variants name none of them', () => {
  const text = shown(renderDetail(viewOf(pick(null)), en));
  for (const expected of ['Claude Code', 'Codex', 'Cursor', 'Tests passed', 'Tests failed', '31,200 tokens', '12,400 tokens'])
    assert.ok(text.includes(expected), expected);
  const plain = shown(renderDetail(viewOf(variantsItem()), en));
  for (const absent of ['Claude Code', 'Tests passed', 'tokens']) assert.ok(!plain.includes(absent), absent);
});

test('kept by the pick: the line says which variant, on which agent, by tokens or by time', () => {
  const tokens = shown(renderDetail(viewOf(pick({ chosen: 2, by: 'cleared-v2', at: FIXTURE_NOW.toISOString(), measure: 'tokens' })), en));
  assert.match(tokens, /Variant 2 \(Codex\) kept by the agent pick at \d\d:\d\d: its tests passed with the fewest tokens\. The others were stopped\./);
  const time = shown(renderDetail(viewOf(pick({ chosen: 2, by: 'cleared-v2', at: FIXTURE_NOW.toISOString(), measure: 'time' })), en));
  assert.match(time, /its tests passed in the shortest time\./);
  const french = shown(renderDetail(viewOf(pick({ chosen: 2, by: 'cleared-v2', at: FIXTURE_NOW.toISOString(), measure: 'tokens' }), 'fr'), fr));
  assert.match(french, /Variante 2 \(Codex\) gardée par le choix d'agent à \d\d:\d\d\u00a0: ses tests sont passés avec le moins de jetons\. Les autres ont été arrêtées\./);
  for (const expected of ['Tests réussis', 'Tests échoués', '31 200 jetons']) assert.ok(french.replace(/\s/g, ' ').includes(expected), expected);
});

test('a pick still open says how the variant is kept, and the owner can still choose', () => {
  const html = renderDetail(viewOf(pick(null)), en);
  assert.ok(shown(html).includes('Once all have ended, the variant kept is the one whose tests passed with the fewest tokens. You can choose one before.'));
  assert.match(html, /data-act="variant_choose_1"/);
});
