// The release card's Close (issue #249), as HTML in English and in French:
// Close beside Send back and Approve, its reason's field once asked, and a
// closed card in the history with who, when and why.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ReleaseItem } from '../../../../src/api/types.ts';
import { inboxFixture } from '../../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import type { InboxView, Local } from '../../screens/inbox/model.ts';
import { renderDetail, visibleText } from '../render.tsx';

const catalogs = { en: translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') }), fr: translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') }) };
const fixture = inboxFixture(FIXTURE_NOW);
const release = fixture.items.find((i): i is ReleaseItem => i.kind === 'release' && i.state === 'waiting') as ReleaseItem;

function shown(item: ReleaseItem, language: 'en' | 'fr', local?: Local): string {
  const view: InboxView = {
    items: [item], tickets: fixture.tickets, sessions: fixture.sessions, selected: item.id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(local ? [[item.id, local]] : []), frame: 'desktop', language,
  };
  return visibleText(renderDetail(view, catalogs[language])).join('\n');
}

test('a waiting release card offers Close beside Send back and Approve', () => {
  assert.match(shown(release, 'en'), /Close\nSend back\n/);
  assert.match(shown(release, 'fr'), /Fermer\nRenvoyer\n/);
});

test('Close asked once opens the reason\'s field with the rule, and nothing to approve', () => {
  const en = shown(release, 'en', { kind: 'close' });
  assert.match(en, /Why is it closed\?/);
  assert.match(en, /Close the ticket/);
  assert.doesNotMatch(en, /Approve/);
  assert.match(shown(release, 'fr', { kind: 'close' }), /Fermer le ticket/);
});

test('a closed card in the history says who closed it, when and why', () => {
  const at = new Date(2026, 9, 21, 9, 12).toISOString();
  const closed: ReleaseItem = { ...release, state: 'handled', outcome: { decision: 'close', reason: 'A rehearsal ticket.', by: 'user-demo', at } };
  assert.match(shown(closed, 'en'), /Closed by you at 09:12: “A rehearsal ticket\.”/);
  assert.match(shown(closed, 'fr'), /Fermé par vous à 09:12 : « A rehearsal ticket\. »/);
  assert.doesNotMatch(shown(closed, 'en'), /Approve/);
});
