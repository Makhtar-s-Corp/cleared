// The lead screen's thread lines for a release train and a block (lane 22):
// a service line with the train's state, each service with its pull request
// and state, the block's reason and proposal, and the way to the card.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FIXTURE_NOW, trainItems } from '../../../fixtures/tower.ts';
import { leadFixture } from '../../../fixtures/lead.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { trainLines, type LeadView } from '../../screens/lead/model.ts';
import { renderLead, renderThread, strings, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });
const items = trainItems(FIXTURE_NOW);

async function view(over: Partial<LeadView> = {}): Promise<LeadView> {
  const fixture = await leadFixture(FIXTURE_NOW);
  return { state: fixture.state, messages: fixture.messages, plans: fixture.plans, planId: null, now: FIXTURE_NOW, language: 'en', memory: null, trains: trainLines(items), ...over };
}

test('each train is a line of the thread with its state, its services and the way to its card', async () => {
  const markup = renderThread(await view(), en);
  assert.equal(markup.match(/<li class="train-line/g)?.length, 3);
  assert.match(markup, /<li class="train-line" data-train="landing" data-ticket="LOCAL-169">/);
  assert.match(markup, /LOCAL-169 is landing, one service at a time\./);
  assert.match(markup, /<li class="train-stop" data-stop="healthy">filter-api #8 healthy<\/li>/);
  assert.match(markup, /<li class="train-stop" data-stop="merged">guestbook #51 merged, health being read<\/li>/);
  assert.match(markup, /<li class="train-line danger" data-train="rolled_back" data-ticket="LOCAL-168">/);
  assert.match(markup, /<a class="train-link" href="\/inbox#release-169">Open the release card<\/a>/);
  assert.doesNotMatch(markup, /\sstyle=/);
});

test('a block says why, what the lead proposes, and waits for the owner in amber', async () => {
  const markup = renderThread(await view(), en);
  assert.match(markup, /<li class="train-line awaiting" data-train="blocked" data-ticket="LOCAL-171">/);
  assert.match(markup, /LOCAL-171 is blocked before your approval\./);
  assert.match(markup, /<p class="train-reason">The ticket changes contract\/openapi\.yaml of the filter API, and the guestbook, which consumes it, has no step\.<\/p>/);
  assert.match(markup, /<p class="train-proposal">Proposal: Add a step on the guestbook, or keep the change backward compatible/);
});

test('without trains the thread is as before', async () => {
  const fixture = await view();
  assert.equal(renderThread({ ...fixture, trains: [] }, en), renderThread({ ...fixture, trains: undefined }, en));
  assert.doesNotMatch(renderThread({ ...fixture, trains: undefined }, en), /train-line/);
});

test('in French, and every word from the catalog or the data', async () => {
  const markup = renderLead(await view({ language: 'fr' }), fr);
  assert.match(markup, /LOCAL-168 a été annulé, le dernier atterrissage d&#39;abord\./);
  assert.match(markup, /Ouvrir la carte de livraison/);
  const sentinel: Translate = (key) => `«${key}»`;
  const v = await view();
  const allowed = strings([items, v.messages]);
  for (const text of visibleText(renderThread(v, sentinel))) {
    const rest = text.replace(/«[a-z0-9_]+»/g, '').trim();
    if (!/\p{L}/u.test(rest)) continue;
    assert.ok(allowed.has(rest), `not from the catalog nor the data: ${JSON.stringify(rest)}`);
  }
});
