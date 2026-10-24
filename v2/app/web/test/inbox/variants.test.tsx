// The variants of one ticket in the inbox (issue #271, P75) as HTML: a
// column each, side by side, with its state, files, lines, cost, time and
// diff; Review on each variant that is done, none on a failed one; what the
// owner chose once handled; the list's line; the choice's call and its
// refusals; every text from the catalog, in English and in French.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { VariantsItem } from '../../../../src/api/types.ts';
import { VARIANTS_TICKET, inboxFixture, variantsItem } from '../../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { ApiError } from '../../lib/screen.ts';
import { chooseVariant, failure, itemLine, ordered, type InboxView, type Local } from '../../screens/inbox/model.ts';
import { renderDetail, renderInbox, visibleText } from '../render.tsx';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });

function viewOf(item: VariantsItem, overrides: Partial<InboxView> = {}): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW);
  return {
    items: [item], tickets: fixture.tickets, sessions: fixture.sessions, selected: item.id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', language: 'en', ...overrides,
  };
}

const acts = (html: string) => [...html.matchAll(/data-act="([a-z_0-9]+)"/g)].map((m) => m[1]);
const shown = (html: string) => visibleText(html).join('\n');
const columns = (html: string) => [...html.matchAll(/<section class="variant" data-state="([a-z]+)"/g)].map((m) => m[1]);

test('the variants side by side: a column each with its state, facts and diff, Review on each that is done', () => {
  const html = renderDetail(viewOf(variantsItem()), en);
  assert.match(html, /data-kind="variants"/);
  assert.match(html, /class="variants" data-count="3"/);
  assert.deepEqual(columns(html), ['done', 'done', 'failed']);
  assert.deepEqual(acts(html), ['variant_choose_1', 'variant_choose_2'], 'no Review on the failed one');
  const text = shown(html);
  for (const expected of ['Variants to compare', '3 variants of the same ticket, side by side', 'Choose the variant to review. The others stop, and their containers are released.',
    'Variant 1', 'Variant 2', 'Variant 3', 'Done', 'Failed',     '+  ORDER BY created_at DESC', '+  return [...rows].reverse();', 'Variant 3 of 3 failed: The session failed: the runner died', 'Review variant 1', 'Review variant 2'])
    assert.ok(text.includes(expected), expected);
  // The durations as the shell's catalog says them (Intl numbers, its own spaces).
  const facts = text.split('\n').filter((line) => line.includes(' · +')).map((line) => line.replace(/\s/g, ' '));
  assert.deepEqual(facts, ['1 file · +1 −1 · $0.42 · 12 min', '2 files · +2 −1 · $0.57 · 1h 15m']);
  assert.match(html, /<pre class="diff" aria-label="The change of variant 1" tabindex="0">/);
  assert.match(html, /href="\/sessions\/fixture-175-v2"/);
  assert.doesNotMatch(html, /\sstyle=/);
});

test('once chosen: the chosen column marked, no Review left, and the line says who chose which', () => {
  const base = variantsItem();
  const item: VariantsItem = {
    ...base, state: 'handled', outcome: { chosen: 2, by: 'user-demo', at: '2026-10-21T10:00:00.000Z' },
    variants: base.variants.map((v) => ({ ...v, state: v.position === 2 ? 'chosen' : v.state === 'failed' ? 'failed' : 'dropped' })),
  };
  const html = renderDetail(viewOf(item), en);
  assert.deepEqual(columns(html), ['dropped', 'chosen', 'failed']);
  assert.deepEqual(acts(html), []);
  assert.match(shown(html), /Variant 2 chosen by you at \d\d:\d\d\. The others were stopped\./);
  assert.match(shown(renderDetail(viewOf(item), fr)), /Variante 2 choisie par vous à \d\d:\d\d\. Les autres ont été arrêtées\./);
  // Settled without a choice: the ticket left the flow.
  assert.ok(shown(renderDetail(viewOf({ ...item, outcome: null }), en)).includes('No variant was chosen: the ticket left the flow.'));
  // Chosen from this page, before the list says it.
  const local = new Map<string, Local>([[base.id, { kind: 'chosen', position: 1, at: '2026-10-21T10:00:00.000Z' }]]);
  const page = renderDetail(viewOf(base, { local }), en);
  assert.deepEqual(acts(page), []);
  assert.match(shown(page), /Variant 1 chosen at \d\d:\d\d\. Its review starts\./);
});

test('the list: its line counts the variants that ended, and it comes after the questions', () => {
  const item = variantsItem();
  assert.equal(itemLine(item, viewOf(item), en), `${VARIANTS_TICKET} · 3 of 3 variants ended`);
  const running: VariantsItem = { ...item, variants: item.variants.map((v) => (v.position === 3 ? { ...v, state: 'running', note: null } : v)) };
  assert.equal(itemLine(running, viewOf(running), fr), `${VARIANTS_TICKET} · 2 variantes terminées sur 3`);
  const fixture = inboxFixture(FIXTURE_NOW, { reading: true });
  const kinds = ordered([...fixture.items, item]).waiting.map((i) => i.kind);
  assert.ok(kinds.indexOf('variants') > kinds.indexOf('question') && kinds.indexOf('variants') < kinds.indexOf('contract'));
  assert.ok(shown(renderInbox(viewOf(item, { selected: undefined, open: false }), en)).includes('Variants'));
});

test('Review posts the position to the variants item; a choice already made or a ticket gone is settled', async () => {
  const item = variantsItem();
  const calls: { path: string; body: unknown }[] = [];
  const api = (async (path: string, init?: { body?: unknown }) => { calls.push({ path, body: init?.body }); return { accepted: true, released: 4 }; }) as Parameters<typeof chooseVariant>[0];
  const local = await chooseVariant(api, item, 2, FIXTURE_NOW);
  assert.deepEqual(calls, [{ path: `/variants/${encodeURIComponent(item.id)}/choose`, body: { variant: 2 } }]);
  assert.deepEqual(local, { kind: 'chosen', position: 2, at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(failure(new ApiError(409, 'x'), 'variant_choose'), { key: 'decided_settled', settled: true });
  assert.deepEqual(failure(new ApiError(404, 'x'), 'variant_choose'), { key: 'decided_settled', settled: true });
  assert.deepEqual(failure(new ApiError(403, 'x'), 'variant_choose'), { key: 'decided_user', settled: false });
  assert.deepEqual(failure(new ApiError(500, 'x'), 'variant_choose'), { key: 'variant_choose_failed', settled: false });
});

test('every text of the variants comes from the catalog, in both languages', () => {
  const item = variantsItem();
  // The failed variant's note is the service's sentence, as every note.
  const text = shown(renderInbox(viewOf(item), sentinel)).split('\n').filter((line) => !line.startsWith('Variant 3 of 3 failed')).join('\n');
  for (const word of ['Variant', 'Done', 'Failed', 'Review', 'side by side', 'At work']) assert.ok(!text.includes(word), `"${word}" is not from the catalog`);
  const french = shown(renderDetail(viewOf(item, { language: 'fr' }), fr));
  for (const expected of ['Variantes à comparer', 'Variante 1', 'Terminée', 'En échec', 'Relire la variante 1'])
    assert.ok(french.includes(expected), expected);
  assert.ok(french.split('\n').some((line) => line.replace(/\s/g, ' ') === '2 fichiers · +2 −1 · 0,57 $ · 1 h 15'), 'the French facts');
});
