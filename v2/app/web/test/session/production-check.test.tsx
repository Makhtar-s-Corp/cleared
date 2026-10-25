// The production page checked after a release landed (P218, issue #334),
// on the session screen's ticket card of a Done ticket: when it was
// captured and a link to the capture, through the app; or why it was not
// (no health check, no browser, a failure); in English and in French;
// nothing on a ticket that is not Done, nor before the checks are read.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ProductionCheck, SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { clock } from '../../lib/time.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { LeftCards } from '../../screens/session/Session.tsx';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

const AT = '2026-10-25T14:02:00.000Z';
const CHECK: ProductionCheck = { service: 'guestbook', pr: 7, url: 'https://guestbook.example.invalid/', at: AT, file: 'production.png', missing: null };

function viewOf(overrides: Partial<SessionView> = {}, status = 'Done'): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const ticket = fixture.ticket && { ...fixture.ticket, status };
  return { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...overrides };
}
const line = (markup: string): string | undefined => markup.match(/<p class="ticket-production[^"]*" data-ticket-production="">([\s\S]*?)<\/p>/)?.[1];
const textOf = (markup: string): string | undefined => {
  const inner = line(markup);
  return inner === undefined ? undefined : visibleText(`<p>${inner}</p>`).map((fact) => fact.replace(/\s+/g, ' ')).join(' | ');
};

test('a captured production page: when, and a link to the capture through the app, opened in a new tab', () => {
  const view = viewOf({ production: [CHECK] });
  const markup = html(<LeftCards view={view} t={en} />);
  assert.equal(textOf(markup), `Production page captured at ${clock(AT)}, after the release landed healthy | See the capture`);
  const ticket = view.summary.ticket;
  assert.ok(markup.includes(`href="/api/service/tickets/${ticket}/proof/guestbook/production.png"`));
  assert.match(line(markup) ?? '', /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(markup, /guestbook\.example\.invalid/, 'the card links to the capture, not to production');
});

test('in French', () => {
  const markup = html(<LeftCards view={viewOf({ production: [CHECK], language: 'fr' })} t={fr} />);
  assert.equal(textOf(markup), `Page de production capturée à ${clock(AT)}, après une mise en ligne saine | Voir la capture`);
});

test('a train names each service; what was not captured says why, without a link', () => {
  const checks: ProductionCheck[] = [
    CHECK,
    { ...CHECK, service: 'filter-api', file: null, missing: 'failed' },
  ];
  const markup = html(<LeftCards view={viewOf({ production: checks })} t={en} />);
  assert.equal(textOf(markup), `Production page of guestbook captured at ${clock(AT)}, after the release landed healthy | See the capture | filter-api: the production page could not be captured`);
  assert.equal([...markup.matchAll(/production\.png/g)].length, 1);
});

test('no health check, no browser: each its reason, in English and in French', () => {
  const unwatched = html(<LeftCards view={viewOf({ production: [{ ...CHECK, file: null, missing: 'unwatched' }] })} t={en} />);
  assert.equal(textOf(unwatched), 'Production page not opened: the project has no health check, so Cleared cannot tell when the deploy is done');
  const french = html(<LeftCards view={viewOf({ production: [{ ...CHECK, file: null, missing: 'unwatched' }], language: 'fr' })} t={fr} />);
  assert.equal(textOf(french), "Page de production non ouverte : le projet n'a pas de contrôle de santé, Cleared ne peut donc pas savoir quand le déploiement est fait");
  const browserless = html(<LeftCards view={viewOf({ production: [{ ...CHECK, file: null, missing: 'no_browser' }] })} t={en} />);
  assert.equal(textOf(browserless), 'No browser on the server: the production page was not captured');
});

test('nothing on a ticket that is not Done, before the checks are read, or when there is none', () => {
  assert.equal(line(html(<LeftCards view={viewOf({ production: [CHECK] }, 'Ready to Ship')} t={en} />)), undefined);
  assert.equal(line(html(<LeftCards view={viewOf({ production: null })} t={en} />)), undefined);
  assert.equal(line(html(<LeftCards view={viewOf()} t={en} />)), undefined);
  assert.equal(line(html(<LeftCards view={viewOf({ production: [] })} t={en} />)), undefined);
});
