// The last clauses of O23 that no other file pins (lane j2-i18n-audit): the
// page is French when nothing chose a language, and the owner's two words of
// 2026-10-23 (08:30 and 08:40) are kept in every catalog that says a role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAppConfig } from '../src/config.ts';
import { LANGUAGES, SCREENS, languageOf, loadCatalog } from '../src/catalog.ts';

test('with no choice, no browser language and no setting, the page is French', () => {
  assert.equal(readAppConfig({} as NodeJS.ProcessEnv).language, 'fr');
  assert.equal(languageOf({}, readAppConfig({} as NodeJS.ProcessEnv).language), 'fr');
  assert.equal(languageOf({ 'accept-language': 'de-DE,es;q=0.8' }, 'fr'), 'fr', 'a browser that asks for no language the app has gets the setting');
  assert.deepEqual([...LANGUAGES].sort(), ['en', 'fr']);
});

test('"Lead" stays capitalised and "Relecteur" is kept, in every screen that names a role', () => {
  let roles = 0;
  for (const screen of SCREENS) {
    const fr = loadCatalog(screen, 'fr');
    if (fr.role_lead !== undefined) { roles += 1; assert.equal(fr.role_lead, 'Lead', `${screen}.fr.json role_lead`); }
    if (fr.role_reviewer !== undefined) assert.equal(fr.role_reviewer, 'Relecteur', `${screen}.fr.json role_reviewer`);
    for (const language of LANGUAGES) {
      const catalog = loadCatalog(screen, language);
      for (const [key, value] of Object.entries(catalog)) {
        if (/^(?:lead_label|lead_title|lead_heading)$/.test(key)) assert.equal(value, 'Lead', `${screen}.${language}.json ${key}`);
      }
    }
  }
  assert.ok(roles >= 2, 'the tower and the session screens name the Lead');
});
