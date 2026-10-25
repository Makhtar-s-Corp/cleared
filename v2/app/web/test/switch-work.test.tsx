// A switch between screens makes the next screen's translator from its
// catalog over the shell's (lane j3-tab-perf, P223): both are made once for
// each screen and language, not spread again at each switch. A screen drawn
// again starts from what it kept, and its first read, the same values in a
// new object, does not draw it once more (lib/query.tsx, sameFields).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { catalogOf, screenCatalog } from '../lib/catalogs.ts';
import { sameFields } from '../lib/query.tsx';
import { known } from '../screens/inbox/model.ts';
import shellFr from '../../messages/shell.fr.json';
import inboxFr from '../../messages/inbox.fr.json';

test('a screen\'s catalog over the shell\'s is made once for each language', () => {
  for (const language of ['en', 'fr'] as const) {
    for (const screen of ['shell', 'tower', 'inbox', 'session', 'lead', 'ask', 'consumption'] as const) {
      assert.equal(screenCatalog(screen, language), screenCatalog(screen, language), `${screen} ${language}`);
      assert.equal(catalogOf(screen, language), catalogOf(screen, language), `${screen} ${language}`);
    }
  }
  assert.notEqual(screenCatalog('inbox', 'en'), screenCatalog('inbox', 'fr'));
  // The same words as before: the screen's over the shell's, French over English.
  const inbox = screenCatalog('inbox', 'fr');
  for (const [key, value] of Object.entries(shellFr)) if (!(key in inboxFr)) assert.equal(inbox[key], value, key);
  for (const [key, value] of Object.entries(inboxFr)) assert.equal(inbox[key], value, key);
});

test('a kept value read again, the same values in a new object, is the same; anything else is not', () => {
  const sessions = [{ id: 's1' }];
  const tickets = [{ id: 'LOCAL-1' }];
  assert.equal(sameFields({ sessions, tickets }, { sessions, tickets }), true);
  assert.equal(sameFields({ sessions, tickets }, { tickets, sessions }), true, 'whatever the order of the fields');
  assert.equal(sameFields(null, null), true);
  assert.equal(sameFields('failed', 'failed'), true);
  assert.equal(sameFields({ sessions, tickets }, { sessions: [...sessions], tickets }), false, 'a list read anew');
  assert.equal(sameFields({ sessions }, { sessions, tickets }), false, 'a field more');
  assert.equal(sameFields({ sessions, tickets: undefined }, { sessions, other: undefined }), false, 'another field');
  assert.equal(sameFields(sessions, [...sessions]), false, 'two lists');
  assert.equal(sameFields(new Map(), new Map()), false, 'two maps');
  assert.equal(sameFields({ sessions }, null), false);
});

test('the inbox\'s list read again from the cache is the same list when every item is known', () => {
  const items = [{ id: 'a', kind: 'permission', state: 'waiting' }, { id: 'b', kind: 'question', state: 'handled' }];
  assert.equal(known(items), items);
  const later = [...items, { id: 'c', kind: 'a later kind', state: 'waiting' }];
  assert.deepEqual(known(later).map((item) => item.id), ['a', 'b']);
});
