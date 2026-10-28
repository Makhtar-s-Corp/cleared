// The tower's composer (the owner's request of 2026-10-28, lane j6-ui-pro):
// the title, the description on several lines, a row of real controls, each
// one a thing the service does (the authors or the services, the next
// authors' model from Consumption's lever, Template, Batch), the other
// gestures behind one button, Start with its keys; the ready-made tickets as
// suggestions while the bar is empty. Nothing the service cannot do is drawn:
// no harness, no agent profile, no attachment. French and English.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TICKET_TEMPLATES } from '../../../src/tickets/templates.ts';
import { RECIPES } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../lib/i18n.ts';
import { Bar } from '../screens/tower/Tower.tsx';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('tower', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('tower', 'fr') });
const LEVER = { current: 'claude-opus-5-5', choice: null, options: ['claude-opus-5-5', 'claude-haiku-5-5'] };
const order = (markup: string, ...needles: string[]) => needles.map((needle) => markup.indexOf(needle));

test('the composer: the title, the description on three lines, the controls, then the menu, the keys and Start', () => {
  const markup = html(<Bar t={en} title="" body="" model={LEVER} />);
  const at = order(markup, 'id="ask-input"', 'id="ask-body"', 'class="ask-actions"', 'data-variants="1"', 'id="ask-model"', 'data-bar="template"', 'data-bar="batch"', 'id="ask-more-button"', 'class="keys ask-keys"', 'type="submit"');
  assert.ok(at.every((index) => index > 0), `every part is drawn: ${at.join(', ')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  assert.match(markup, /<textarea id="ask-body"[^>]*rows="3"/);
  assert.match(markup, /<button type="submit" class="chip-button primary" aria-keyshortcuts="Control\+Enter Meta\+Enter">Start<\/button>/);
  assert.match(html(<Bar t={fr} title="" body="" />), /<button type="submit"[^>]*>Lancer<\/button>/);
  assert.match(markup, /<span class="keys ask-keys" aria-hidden="true"><kbd>Ctrl<\/kbd><kbd>Enter<\/kbd><\/span>/);
});

test('only what the service does: no harness, no agent profile, no attachment; the model only once the lever is read', () => {
  const markup = html(<Bar t={en} title="" body="" model={LEVER} recipes={[]} />);
  assert.doesNotMatch(markup, /harness|profile|attach|type="file"/i);
  assert.doesNotMatch(html(<Bar t={en} title="" body="" />), /id="ask-model"/, 'no lever read: no model control');
  // The model: the lever's default, named, then its options, the choice picked.
  assert.deepEqual([...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]), [['', 'Default (Opus 5.5)'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']]);
  assert.match(markup, /<select id="ask-model" aria-label="The next authors(?:&#x27;|&#39;|') model">/);
  assert.match(html(<Bar t={en} title="" body="" model={{ ...LEVER, choice: 'claude-haiku-5-5' }} />), /<option value="claude-haiku-5-5" selected="">Haiku 5.5<\/option>/);
  assert.match(html(<Bar t={fr} title="" body="" model={LEVER} />), /title="Le modèle sur lequel démarrent les prochains auteurs, comme dans Consommation/);
});

test('the other gestures are in the menu behind one button, closed until it is pressed; Run a recipe only once there are recipes', () => {
  const markup = html(<Bar t={en} title="" body="" />);
  assert.match(markup, /<button[^>]*id="ask-more-button"[^>]*aria-label="More actions"[^>]*aria-expanded="false"[^>]*aria-controls="ask-more-menu"/);
  const menu = /<div class="menu ask-more-menu" id="ask-more-menu" hidden="">([\s\S]*?)<\/div><\/div>/.exec(markup)?.[1] ?? '';
  assert.deepEqual([...menu.matchAll(/data-(?:lead|bar)="([a-z]+)"/g)].map((m) => m[1]), ['goal', 'lead', 'ask']);
  const recipes = html(<Bar t={en} title="" body="" recipes={RECIPES} />);
  assert.match(/id="ask-more-menu"[\s\S]*$/.exec(recipes)?.[0] ?? '', /data-bar="recipe"/);
});

test('while the bar is empty, the ready-made tickets are suggestions: each its kind and what to write; gone once a word is written or a template is picked', () => {
  for (const [t, language] of [[en, 'en'], [fr, 'fr']] as const) {
    const markup = html(<Bar t={t} title="" body="" />);
    const row = /<div class="ask-suggest"[^>]*>[\s\S]*?<\/div>/.exec(markup)?.[0] ?? '';
    assert.deepEqual([...row.matchAll(/data-suggest="([a-z]+)"/g)].map((m) => m[1]), [...TICKET_TEMPLATES], language);
    for (const id of TICKET_TEMPLATES) assert.ok(visibleText(row).join(' ').includes(t(`template_${id}_title`)), `${language}: ${id} says what to write`);
  }
  assert.doesNotMatch(html(<Bar t={en} title="A title" body="" />), /ask-suggest/);
  assert.doesNotMatch(html(<Bar t={en} title="" body="Words" />), /ask-suggest/);
  assert.doesNotMatch(html(<Bar t={en} title="" body="" template="bug" />), /ask-suggest/);
  assert.doesNotMatch(html(<Bar t={en} title="" body="" templatesOpen />), /ask-suggest/);
});
