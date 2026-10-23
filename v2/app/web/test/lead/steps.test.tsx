// A plan item's steps in the plan panel as HTML (decision 26, lane 27): the
// steps in order with their kind, service, what they wait for and their
// estimate; a plan without steps draws as before.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { servicePlan, stepsPlan } from '../../../fixtures/lead.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { renderPlanPanel, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });

test('an item in steps lists them under its title, in order', () => {
  const markup = renderPlanPanel(stepsPlan(FIXTURE_NOW), en, { services: true });
  assert.equal(markup.match(/<ol class="plan-item-steps" aria-label="Steps across services">/g)?.length, 1, 'only the item in steps');
  assert.deepEqual([...markup.matchAll(/<li class="plan-item-step" data-step="(\d)" data-kind="([a-z]+)">/g)].map((m) => `${m[1]}:${m[2]}`), ['1:contract', '2:service', '3:service', '4:integration']);
  const text = visibleText(markup).join('\n');
  assert.ok(text.includes('Integration · guestbook · waits for 2 and 3 · 10 min · $0.20'));
  assert.doesNotMatch(markup, /\sstyle=/);
  assert.match(renderPlanPanel(stepsPlan(FIXTURE_NOW), fr, { services: true, language: 'fr' }), /Intégration · guestbook · attend 2 et 3 · 10 min · 0,20\u00a0\$/);
});

test('a plan without steps draws as before', () => {
  assert.doesNotMatch(renderPlanPanel(servicePlan(FIXTURE_NOW), en, { services: true }), /plan-item-step/);
});
