// The language of a page (the owner's request of 2026-10-23, 08:40, lane
// i18n): the person's choice, remembered in the cleared_lang cookie the
// account menu writes; else the browser's languages, by their weights; else
// the app's setting (CLEARED_V2_APP_LANGUAGE), French by default. It
// replaces the setting as the one language of every page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_COOKIE, languageOf } from '../src/catalog.ts';
import { signedIn, startApp } from './support.ts';

test('the choice first, then the browser\'s languages by weight, then the setting', () => {
  assert.equal(LANGUAGE_COOKIE, 'cleared_lang');
  const of = (headers: { cookie?: string; 'accept-language'?: string }, fallback: 'en' | 'fr' = 'fr') => languageOf(headers, fallback);
  assert.equal(of({ 'accept-language': 'en-US,en;q=0.9,fr;q=0.8' }), 'en');
  assert.equal(of({ 'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8' }, 'en'), 'fr');
  assert.equal(of({ 'accept-language': 'de-DE,de;q=0.9,en;q=0.5,fr;q=0.7' }), 'fr', 'the weights, not the order');
  assert.equal(of({ 'accept-language': 'de-DE,ja' }), 'fr', 'neither: the setting');
  assert.equal(of({ 'accept-language': 'de-DE,ja' }, 'en'), 'en');
  assert.equal(of({ 'accept-language': '*' }), 'fr');
  assert.equal(of({}), 'fr');
  assert.equal(of({ 'accept-language': 'en;q=0, fr;q=0' }, 'en'), 'en', 'a weight of 0 refuses the language');
  assert.equal(of({ cookie: 'cleared_lang=en', 'accept-language': 'fr-FR' }), 'en', 'the choice wins');
  assert.equal(of({ cookie: 'other=1; cleared_lang=fr', 'accept-language': 'en-US' }, 'en'), 'fr');
  assert.equal(of({ cookie: 'cleared_lang=de', 'accept-language': 'en-US' }), 'en', 'a choice the app does not have is ignored');
});

test('the sign-in page, the shell page, the catalogs and /api/me answer in the request\'s language', async () => {
  const app = await startApp({ extra: { language: 'fr' } });
  try {
    const login = (headers: Record<string, string>) => fetch(`${app.base}/login`, { headers }).then((response) => response.text());
    assert.match(await login({ 'accept-language': 'en-GB,en;q=0.9' }), /<html lang="en">/);
    assert.match(await login({ 'accept-language': 'en-GB', cookie: 'cleared_lang=fr' }), /<html lang="fr">/);
    assert.match(await login({ 'accept-language': 'de' }), /<html lang="fr">/, 'the setting');
    const { cookie } = await signedIn(app);
    const page = await fetch(`${app.base}/`, { headers: { cookie, 'accept-language': 'en-US' } }).then((response) => response.text());
    assert.match(page, /<html lang="en">/);
    const me = await fetch(`${app.base}/api/me`, { headers: { cookie, 'accept-language': 'en-US' } }).then((response) => response.json()) as { language: string };
    assert.equal(me.language, 'en');
    const chosen = await fetch(`${app.base}/api/me`, { headers: { cookie: `${cookie}; cleared_lang=fr`, 'accept-language': 'en-US' } }).then((response) => response.json()) as { language: string };
    assert.equal(chosen.language, 'fr');
    const shell = await fetch(`${app.base}/messages/shell.json`, { headers: { 'accept-language': 'en' } }).then((response) => response.json()) as Record<string, string>;
    assert.equal(shell.locale, 'en');
    const french = await fetch(`${app.base}/messages/shell.json`, { headers: { 'accept-language': 'fr' } }).then((response) => response.json()) as Record<string, string>;
    assert.equal(french.locale, 'fr');
  } finally {
    await app.close();
  }
});
