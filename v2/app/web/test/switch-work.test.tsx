// A switch between screens makes the next screen's translator from its
// catalog over the shell's (lane j3-tab-perf, P223): both are made once for
// each screen and language, not spread again at each switch.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { catalogOf, screenCatalog } from '../lib/catalogs.ts';
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
