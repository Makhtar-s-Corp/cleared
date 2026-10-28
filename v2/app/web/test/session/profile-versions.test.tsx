// The versions a session started on, on the session screen's ticket card
// (issue #452): its agent profile's and its environment's, and the harness
// the pick ran it on when its profile said auto; in English and in French;
// nothing for a session with no profile (the lead, a reader).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { LeftCards } from '../../screens/session/Session.tsx';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

function viewOf(summary: Partial<SessionSummary>): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return { summary: { ...(fixture.sessions[0] as SessionSummary), ...summary }, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW };
}
const line = (markup: string): string | undefined => {
  const inner = markup.match(/<p class="session-versions[^"]*" data-session-versions="">([\s\S]*?)<\/p>/)?.[1];
  return inner === undefined ? undefined : visibleText(`<p>${inner}</p>`).join(' ').replace(/\s+/g, ' ');
};

test('the ticket card names the profile and environment versions the session started on', () => {
  const versions = { profile: 3, environment: 2, auto: false };
  assert.equal(line(html(<LeftCards view={viewOf({ versions })} t={en} />)), 'Agent profile: version 3. Environment: version 2.');
  assert.equal(line(html(<LeftCards view={viewOf({ versions })} t={fr} />)), 'Profil d\'agent : version 3. Environnement : version 2.');
});

test('a profile on auto says the harness the pick ran the session on', () => {
  const versions = { profile: 4, environment: 1, auto: true };
  assert.equal(line(html(<LeftCards view={viewOf({ versions, harness: 'codex' })} t={en} />)), 'Agent profile: version 4, harness picked automatically: Codex. Environment: version 1.');
  assert.equal(line(html(<LeftCards view={viewOf({ versions, harness: 'codex' })} t={fr} />)), 'Profil d\'agent : version 4, harnais choisi automatiquement : Codex. Environnement : version 1.');
});

test('a session with no profile says nothing of one', () => {
  const markup = html(<LeftCards view={viewOf({ role: 'lead' })} t={en} />);
  assert.equal(line(markup), undefined);
  assert.doesNotMatch(markup, /⟦/);
});
