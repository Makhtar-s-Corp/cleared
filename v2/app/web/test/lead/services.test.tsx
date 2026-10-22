// The plan panel's service chips (decisions 18 and 24, lane 22): on the
// lead screen each item names its services and the sensitivity of each; the
// inbox's plan item, whose catalog is lane 21's, draws the panel as before
// until it asks for the chips.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { leadFixture, servicePlan } from '../../../fixtures/lead.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import type { LeadView } from '../../screens/lead/model.ts';
import { renderLead, renderPlanPanel, renderSide, strings, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });
const plan = servicePlan(FIXTURE_NOW);

async function view(over: Partial<LeadView> = {}): Promise<LeadView> {
  const fixture = await leadFixture(FIXTURE_NOW);
  return { state: fixture.state, messages: fixture.messages, plans: [plan], planId: null, now: FIXTURE_NOW, language: 'en', memory: null, ...over };
}

test('the lead\'s panel names each item\'s services, the sensitive one marked', async () => {
  const side = renderSide(await view(), en);
  assert.match(side, /<ul class="plan-services" aria-label="Services">/);
  assert.equal(side.match(/class="svc-chip"/g)?.length, 3, 'guestbook, plainly, on items 2, 3 and 4');
  assert.equal(side.match(/class="svc-chip sensitive" data-sensitivity="full"/g)?.length, 3);
  assert.match(side, /<li class="svc-chip sensitive" data-sensitivity="full"><svg[^>]*aria-hidden="true"[^]*?<\/svg>filter-api · full review<\/li>/);
  assert.doesNotMatch(side, /\sstyle=/);
});

test('the whole lead screen shows them, in French too', async () => {
  const markup = renderLead(await view({ language: 'fr' }), fr);
  assert.match(markup, /filter-api · revue complète/);
  assert.match(markup, /aria-label="Services"/);
});

test('the panel without the option draws no chip, so a catalog without the chips\' keys still draws it', () => {
  const inboxCatalog = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
  const markup = renderPlanPanel(plan, inboxCatalog);
  assert.doesNotMatch(markup, /plan-services|svc-chip/);
  assert.match(markup, /The filter answers a severity with each word/);
});

test('every word of a chip comes from the catalog or from the plan', () => {
  const sentinel: Translate = (key) => `«${key}»`;
  const markup = renderPlanPanel(plan, sentinel, { services: true });
  const allowed = strings(plan);
  for (const text of visibleText(markup)) {
    const rest = text.replace(/«[a-z0-9_]+»/g, '').trim();
    if (!/\p{L}/u.test(rest)) continue;
    assert.ok(allowed.has(rest), `not from the catalog nor the plan: ${JSON.stringify(rest)}`);
  }
});
