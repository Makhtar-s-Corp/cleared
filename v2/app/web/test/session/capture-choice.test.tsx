// The human forces the proof receipt's captures on or off from the ticket
// (issue #368, matrix P226): a small switch on the session screen's ticket
// card, Auto, On and Off, the one chosen pressed, and a line that says what
// it does; in English and in French. It is not drawn before the choice is
// read, nor on a ticket that shipped or is approved, whose captures are
// taken. The choice is posted to the service, which keeps it on the ticket.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { CaptureChoice, SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { chooseCaptures } from '../../screens/session/ticket.ts';
import { LeftCards } from '../../screens/session/Session.tsx';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

const AUTO: CaptureChoice = { choice: 'auto', by: null, at: null };

function viewOf(overrides: Partial<SessionView> = {}, status = 'In Progress'): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const ticket = fixture.ticket && { ...fixture.ticket, status };
  return { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...overrides };
}
const block = (markup: string): string | undefined => markup.match(/<div class="ticket-captures"[^>]*>[\s\S]*?<\/p><\/div>/)?.[0];
const pressed = (markup: string): string[] => [...markup.matchAll(/<button type="button" data-captures="([a-z]+)" aria-pressed="true"/g)].map((m) => m[1] as string);

test('the switch: Auto, On and Off, Auto pressed by default, and what it does', () => {
  const markup = block(html(<LeftCards view={viewOf({ captures: AUTO })} t={en} />));
  assert.ok(markup, 'drawn on the ticket card');
  assert.deepEqual(visibleText(markup), ['Before and after captures', 'Auto', 'On', 'Off', 'Taken when the change touches a screen']);
  assert.deepEqual(pressed(markup), ['auto']);
  assert.match(markup, /role="group" aria-labelledby="captures-label"/);
});

test('forced on, forced off: the choice pressed and its line, in English and in French', () => {
  const on = block(html(<LeftCards view={viewOf({ captures: { choice: 'on', by: USER, at: '2026-10-25T10:00:00.000Z' } })} t={en} />)) ?? '';
  assert.deepEqual(pressed(on), ['on']);
  assert.ok(visibleText(on).includes('Taken whatever the change'));
  const off = block(html(<LeftCards view={viewOf({ captures: { choice: 'off', by: USER, at: '2026-10-25T10:00:00.000Z' } })} t={en} />)) ?? '';
  assert.deepEqual(pressed(off), ['off']);
  assert.ok(visibleText(off).includes('Never taken for this ticket'));
  const french = block(html(<LeftCards view={viewOf({ captures: AUTO, language: 'fr' })} t={fr} />)) ?? '';
  assert.deepEqual(visibleText(french), ['Captures avant et après', 'Auto', 'Oui', 'Non', 'Prises quand le changement touche un écran']);
  const frOff = block(html(<LeftCards view={viewOf({ captures: { choice: 'off', by: USER, at: '2026-10-25T10:00:00.000Z' }, language: 'fr' })} t={fr} />)) ?? '';
  assert.ok(visibleText(frOff).includes('Jamais prises pour ce ticket'));
});

test('not drawn before the choice is read, nor on a ticket that shipped or is approved', () => {
  assert.equal(block(html(<LeftCards view={viewOf()} t={en} />)), undefined);
  assert.equal(block(html(<LeftCards view={viewOf({ captures: null })} t={en} />)), undefined);
  assert.equal(block(html(<LeftCards view={viewOf({ captures: AUTO }, 'Done')} t={en} />)), undefined);
  assert.equal(block(html(<LeftCards view={viewOf({ captures: AUTO }, 'Ready to Ship')} t={en} />)), undefined);
});

test('the choice is posted to the service\'s route of the ticket', async () => {
  const calls: { path: string; init: unknown }[] = [];
  const api = async <T,>(path: string, init?: unknown): Promise<T> => {
    calls.push({ path, init });
    return { choice: 'off', by: USER, at: '2026-10-25T10:00:00.000Z' } as T;
  };
  const answer = await chooseCaptures(api, 'LOCAL-7', 'off');
  assert.deepEqual(calls, [{ path: '/tickets/LOCAL-7/captures', init: { method: 'POST', body: { choice: 'off' } } }]);
  assert.equal(answer.choice, 'off');
});
