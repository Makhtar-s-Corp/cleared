// A permission request on the screen, in French (docs/v2/ui-overhaul-plan.md,
// 2.5.1 to 2.5.5, lane 37): the row's title and its three answers from
// 1280 px, the detail's question with its answers before anything else, the
// reason by its code, the command folded one part per line, the policy's
// English sentence in the fold when it has no code, and a handled or
// expired request with its intent title and no answer.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { PermissionItem } from '../../../../src/api/types.ts';
import { inboxFixture, requestItems } from '../../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import type { InboxView, Item, Local } from '../../screens/inbox/model.ts';
import { renderInbox, visibleText } from '../render.tsx';

const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });
const fixture = inboxFixture(FIXTURE_NOW);
const requests = requestItems(FIXTURE_NOW, { reviewer: { id: 'fixture-158-review', ticket: 'LOCAL-158' }, author: { id: 'fixture-160', ticket: 'LOCAL-160' } });
const compound = requests[0] as PermissionItem;
const expired = requests.find((item) => item.id.endsWith(':request-expired')) as PermissionItem;
const items: Item[] = [...fixture.items, ...requests];

const viewOf = (overrides: Partial<InboxView> = {}): InboxView => ({
  items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false,
  me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', wide: true, language: 'fr', ...overrides,
});
const rowActs = (html: string, id: string) => {
  const start = html.indexOf(`data-item="${id}"`);
  const end = html.indexOf('</li>', start);
  return [...html.slice(start, end).matchAll(/data-row-act="([a-z_]+)">([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`);
};

test('from 1280 px a waiting request\'s row carries its three answers, in French, and no other row does', () => {
  const html = renderInbox(viewOf(), fr, { handledOpen: true });
  assert.deepEqual(rowActs(html, compound.id), ['allow_once:Autoriser une fois', 'allow_always:Toujours pour ce projet', 'reject_once:Refuser']);
  assert.deepEqual(rowActs(html, fixture.items[1]?.id ?? ''), ['allow_once:Autoriser une fois', 'allow_always:Toujours pour ce projet', 'reject_once:Refuser']);
  assert.deepEqual(rowActs(html, expired.id), [], 'an expired request has no answer');
  assert.deepEqual(rowActs(html, fixture.items[0]?.id ?? ''), [], 'a release is answered in its detail');
  assert.equal([...html.matchAll(/data-row-act=/g)].length, 6);
  assert.doesNotMatch(renderInbox(viewOf({ wide: false }), fr), /data-row-act=/, 'under 1280 px, the detail holds them');
  // The buttons sit beside the row's link, never inside it.
  assert.doesNotMatch(html, /<a [^>]*class="item[^"]*"[^>]*>(?:(?!<\/a>)[\s\S])*<button/);
});

test('the row says the request\'s intent in French, and the group of what no longer waits is "Traité" with its count', () => {
  const shown = visibleText(renderInbox(viewOf(), fr));
  for (const expected of ['En attente · 5', 'Lire l\'historique et le diff du dépôt et lancer les tests du projet', 'LOCAL-158 · relecteur en pause', 'Installer date-fns', 'Traité · 3'])
    assert.ok(shown.includes(expected), `missing: ${expected}`);
  const open = visibleText(renderInbox(viewOf(), fr, { handledOpen: true }));
  for (const expected of ['Lancer le script db:migrate', 'LOCAL-160 · ne vous attend plus']) assert.ok(open.includes(expected), `missing: ${expected}`);
});

test('the compound request\'s detail: the question, the ticket, the three answers, why in French, who asks, and the command folded part by part', () => {
  const html = renderInbox(viewOf({ selected: compound.id, open: true }), fr);
  const shown = visibleText(html);
  for (const expected of [
    'Autorisation', 'LOCAL-158', 'Ouvrir la session',
    'Autoriser le relecteur à lire l\'historique et le diff du dépôt et lancer les tests du projet ?',
    '“Comings and goings” replaces “Departures and arrivals”',
    'Autoriser une fois', 'Toujours pour ce projet', 'Refuser', 'Raison d\'un refus, facultative',
    'Pourquoi la question', '« git merge-base » n\'est pas une commande que la politique autorise seule.',
    'Session', 'Commande',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  const lines = [...html.matchAll(/<span class="fold-line">(?:<span class="op">([^<]*)<\/span>)?([^<\n]*)/g)].map((m) => `${m[1] ?? ''} ${m[2]}`.trim());
  assert.deepEqual(lines, ['git log -5 --oneline', '; git merge-base main HEAD', '; git show 3f9c2a1 --stat', '; npm test 2&gt;&amp;1', '| tail -8']);
  assert.ok(!shown.some((text) => text.includes('is not a command the policy allows')), 'the code is said in French; the English sentence is not shown');
  assert.ok(html.indexOf('data-act="allow_once"') < html.indexOf('Pourquoi la question'), 'the answers come first');
});

test('with no code, the policy\'s English sentence is in the fold under a French label, as written', () => {
  const plain: PermissionItem = { ...compound, reasonCode: undefined };
  const html = renderInbox(viewOf({ items: [plain], selected: plain.id, open: true }), fr);
  const shown = visibleText(html);
  assert.ok(shown.includes('Les mots de la politique'));
  assert.ok(shown.includes('Git merge-base main HEAD is not a command the policy allows on its own'));
  assert.ok(!shown.includes('Pourquoi la question'));
});

test('an expired request keeps its intent title, says it no longer waits, and offers nothing; an answered one says what was answered', () => {
  const html = renderInbox(viewOf({ selected: expired.id, open: true }), fr);
  const shown = visibleText(html);
  assert.ok(shown.includes('Lancer le script db:migrate'));
  assert.ok(shown.includes('Ceci ne vous attend plus.'));
  assert.doesNotMatch(html, /data-act=/);
  const local = new Map<string, Local>([[compound.id, { kind: 'answered', decision: 'allow_once' }]]);
  const answered = renderInbox(viewOf({ selected: compound.id, open: true, local }), fr);
  assert.ok(visibleText(answered).includes('Autorisé une fois. La session continue.'));
  assert.doesNotMatch(answered, /data-act=|data-row-act=/);
});
