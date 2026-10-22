// The ticket's steps on the session screen as HTML (decision 26, lane 27):
// the Plan tab's card of the steps, this session's marked, and the ticket
// card's service line naming the step; a ticket of one step draws as before.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW, ticketSteps } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { LeftCards } from '../../screens/session/Session.tsx';
import { PlanTab } from '../../screens/session/Tabs.tsx';
import { html, visibleText } from '../render.tsx';

const en = translator(loadCatalog('session', 'en'));
const fr = translator(loadCatalog('session', 'fr'));
const sentinel: Translate = (key) => `«${key}»`;

function viewOf(overrides: Partial<SessionView> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const summary = { ...(fixture.sessions[0] as SessionSummary), service: 'filter-api' };
  return { summary, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...overrides };
}
const steps = (session: string) => ticketSteps([{ ...(sessionFixture(FIXTURE_NOW).sessions[0] as SessionSummary), id: session, ticket: 'LOCAL-163' }]);

test('the Plan tab lists the ticket\'s steps, this session\'s marked, each with its state and cost', () => {
  const markup = html(<PlanTab view={viewOf({ steps: steps(AUTHOR_ID) })} plan={null} t={en} />);
  assert.match(markup, /<section class="card steps-card" aria-labelledby="steps-title">/);
  const rows = [...markup.matchAll(/<li class="([^"]+)" data-step="(\d)" data-state="([a-z]+)"/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(rows, [['ticket-step', '1', 'done'], ['ticket-step current', '2', 'running'], ['ticket-step', '3', 'waiting'], ['ticket-step', '4', 'waiting']]);
  const text = visibleText(markup).join('\n');
  for (const words of ['Steps of the ticket', 'Contract · filter-api', 'Integration · guestbook · after 2 and 3', 'This session', 'Done', 'Running', '$0.21']) assert.ok(text.includes(words), words);
  assert.doesNotMatch(markup, /\sstyle=/);
});

test('a ticket of one step shows no steps card', () => {
  const one = html(<PlanTab view={viewOf({ steps: steps(AUTHOR_ID).slice(0, 1) })} plan={null} t={en} />);
  assert.doesNotMatch(one, /steps-card/);
  assert.equal(one, html(<PlanTab view={viewOf()} plan={null} t={en} />));
});

test('the ticket card says which step this session is', () => {
  assert.match(html(<LeftCards view={viewOf({ steps: steps(AUTHOR_ID) })} t={en} />), /on filter-api · step 2 of 4/);
  assert.match(html(<LeftCards view={viewOf({ steps: steps(AUTHOR_ID) })} t={fr} />), /sur filter-api · étape 2 sur 4/);
  assert.doesNotMatch(html(<LeftCards view={viewOf()} t={en} />), /step \d of/);
});

test('every word of the steps card is from the catalog, in both languages', () => {
  const text = visibleText(html(<PlanTab view={viewOf({ steps: steps(AUTHOR_ID) })} plan={null} t={sentinel} />)).join('\n');
  for (const word of ['Steps of the ticket', 'Contract', 'Integration', 'This session', 'Running', 'after']) assert.ok(!text.includes(word), word);
  assert.match(html(<PlanTab view={viewOf({ steps: steps(AUTHOR_ID) })} plan={null} t={fr} />), /Étapes du ticket/);
});
