// The person's choice of language in the page (web/lib/language.ts): kept
// in this browser and in the cookie the server reads (src/catalog.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_COOKIE as SERVER_COOKIE } from '../src/catalog.ts';
import { LANGUAGE_COOKIE, LANGUAGE_KEY, rememberLanguage, startLanguage, storedLanguage } from '../web/lib/language.ts';

test('the stored choice first, then the page\'s language, then French', () => {
  assert.equal(startLanguage('en', null), 'en');
  assert.equal(startLanguage('en', 'fr'), 'fr');
  assert.equal(startLanguage('fr', 'en'), 'en');
  assert.equal(startLanguage('de', 'xx'), 'fr');
  assert.equal(startLanguage(undefined, null), 'fr');
});

test('a choice is stored, written in the cookie the server reads, and set on the page', () => {
  assert.equal(LANGUAGE_COOKIE, SERVER_COOKIE);
  const items = new Map<string, string>();
  const store = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
  const doc = { cookie: '', documentElement: { lang: 'fr' } };
  rememberLanguage('en', store, doc, true);
  assert.equal(items.get(LANGUAGE_KEY), 'en');
  assert.equal(storedLanguage(store), 'en');
  assert.equal(doc.cookie, 'cleared_lang=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  assert.equal(doc.documentElement.lang, 'en');
  rememberLanguage('fr', store, doc, false);
  assert.equal(doc.cookie, 'cleared_lang=fr; Path=/; Max-Age=31536000; SameSite=Lax', 'no Secure on plain http (loopback)');
});

test('a storage that refuses (a private window) still lets the choice through the cookie', () => {
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const doc = { cookie: '', documentElement: { lang: 'fr' } };
  assert.equal(storedLanguage(refusing), null);
  assert.doesNotThrow(() => rememberLanguage('en', refusing, doc, false));
  assert.match(doc.cookie, /^cleared_lang=en;/);
  assert.equal(storedLanguage(undefined), null);
});
