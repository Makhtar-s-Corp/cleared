// The cost of a resolved ticket on the session screen's ticket card (P211,
// issue #327): the tokens, the agents' own time over the ticket's time, and
// the dollars only when every session reported them, labelled as the
// harness's API-equivalent figure; in English and in French; nothing on a
// ticket that is not Done, nor before the cost is read.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../../src/api/types.ts';
import type { TicketCost } from '../../../../src/consumption/ticket-cost.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { LeftCards } from '../../screens/session/Session.tsx';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

const COST: TicketCost = { ticket: 'LOCAL-142', sessions: 3, turns: 5, tokens: 1_234_567, workMs: 37 * 60_000, elapsedMs: 64 * 60_000, costUsd: 2 };

function viewOf(overrides: Partial<SessionView> = {}, status = 'Done'): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const ticket = fixture.ticket && { ...fixture.ticket, status };
  return { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...overrides };
}
// The card's cost facts, each on its line, their spaces (no-break, narrow) said as plain spaces.
const costText = (markup: string): string | undefined => {
  const line = markup.match(/<p class="ticket-cost[^"]*" data-ticket-cost="">([\s\S]*?)<\/p>/)?.[1];
  if (line === undefined) return undefined;
  assert.equal([...line.matchAll(/<span class="fact">/g)].length, visibleText(`<p>${line}</p>`).length, 'every fact in its own span');
  return visibleText(`<p>${line}</p>`).map((fact) => fact.replace(/\s+/g, ' ')).join(' | ');
};

test('a resolved ticket\'s card says its tokens, the agents\' time over the ticket\'s, and the dollars the agents reported', () => {
  const markup = html(<LeftCards view={viewOf({ cost: COST })} t={en} />);
  assert.equal(costText(markup), 'Cost: 1,234,567 tokens | 37 min of agent work over 1h 4m | $2.00 API-equivalent, as the agents reported it');
  assert.doesNotMatch(markup, /€|EUR/);
});

test('in French, with French numbers and durations', () => {
  const markup = html(<LeftCards view={viewOf({ cost: COST, language: 'fr' })} t={fr} />);
  assert.equal(costText(markup), 'Coût : 1 234 567 jetons | 37 min de travail des agents sur 1 h 04 | 2,00 $US en équivalent API, déclarés par les agents');
});

test('no dollar amount when one session reported none: the tokens and the time only', () => {
  const markup = html(<LeftCards view={viewOf({ cost: { ...COST, costUsd: null } })} t={en} />);
  assert.equal(costText(markup), 'Cost: 1,234,567 tokens | 37 min of agent work over 1h 4m');
  assert.doesNotMatch(markup, /\$/);
});

test('an amount under a dollar keeps its cents and more', () => {
  const markup = html(<LeftCards view={viewOf({ cost: { ...COST, costUsd: 0.0123 } })} t={en} />);
  assert.match(costText(markup) ?? '', /\| \$0\.0123 API-equivalent/);
});

test('a short ticket says seconds; a ticket of days says days', () => {
  assert.match(costText(html(<LeftCards view={viewOf({ cost: { ...COST, workMs: 42_000, elapsedMs: 50_000 } })} t={en} />)) ?? '', /42s of agent work over 50s/);
  assert.match(costText(html(<LeftCards view={viewOf({ cost: { ...COST, workMs: 26 * 3_600_000, elapsedMs: 50 * 3_600_000 } })} t={en} />)) ?? '', /1d 2h of agent work over 2d 2h/);
});

test('nothing on a ticket that is not Done, before the cost is read, or when no turn finished', () => {
  assert.equal(costText(html(<LeftCards view={viewOf({ cost: COST }, 'In Review')} t={en} />)), undefined);
  assert.equal(costText(html(<LeftCards view={viewOf({ cost: null })} t={en} />)), undefined);
  assert.equal(costText(html(<LeftCards view={viewOf()} t={en} />)), undefined);
  assert.equal(costText(html(<LeftCards view={viewOf({ cost: { ...COST, tokens: null, costUsd: null, turns: 0, sessions: 0 } })} t={en} />)), undefined);
});
