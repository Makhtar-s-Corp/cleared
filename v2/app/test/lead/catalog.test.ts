// The plan panel is shared with the inbox (lane 10), and a page loads only
// the shell's catalog and its own, so the panel names its keys in one
// exported list that each screen's catalog must hold. The repository's
// catalog test reads screens/<screen>.ts only, so this one reads the panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../../src/catalog.ts';
import { PLAN_PANEL_KEYS } from '../../public/plan-panel.ts';

const code = readFileSync(new URL('../../public/plan-panel.ts', import.meta.url), 'utf8');

test('every key the plan panel names is in its exported list, and the list names no other', () => {
  const named = new Set([...code.matchAll(/'(plan_[a-z0-9_]+)'/g)].map((m) => m[1] as string));
  for (const key of PLAN_PANEL_KEYS) named.delete(key);
  assert.deepEqual([...named], [], 'keys the panel uses but does not list');
  for (const key of PLAN_PANEL_KEYS) assert.ok(code.includes(`'${key}'`), `${key} is listed but never used`);
  assert.equal(new Set(PLAN_PANEL_KEYS).size, PLAN_PANEL_KEYS.length);
  assert.doesNotMatch(code, /t\(`/, 'no key built from a template string: the list could not see it');
});

test('the lead\'s catalog holds every key of the panel, in English and in French', () => {
  for (const language of ['en', 'fr'] as const) {
    const catalog = loadCatalog('lead', language);
    for (const key of PLAN_PANEL_KEYS) assert.ok(Object.hasOwn(catalog, key), `lead.${language}.json lacks ${key}`);
  }
});

test('every key the lead screen names, in a call or in one of its maps, is in its catalog', () => {
  const screen = readFileSync(new URL('../../public/screens/lead.ts', import.meta.url), 'utf8');
  const catalog = loadCatalog('lead', 'en');
  const named = [...new Set([...screen.matchAll(/'(lead_[a-z0-9_]+)'/g)].map((m) => m[1] as string))];
  assert.ok(named.length > 40);
  for (const key of named) assert.ok(Object.hasOwn(catalog, key), `lead.ts names ${key}, which lead.en.json lacks`);
});
