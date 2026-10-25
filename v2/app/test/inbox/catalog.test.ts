// The plan panel is lane 8's (plan-panel.ts) and a page loads only the
// shell's catalog and its own, so the inbox's catalog holds a copy of every
// key the panel names, word for word the lead's, in English and in French.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.ts';
import { PLAN_PANEL_KEYS } from '../../web/plan-panel/model.ts';

test('the inbox\'s catalog holds every key of the plan panel, as the lead\'s catalog says it', () => {
  for (const language of ['en', 'fr'] as const) {
    const inbox = loadCatalog('inbox', language);
    const lead = loadCatalog('lead', language);
    for (const key of PLAN_PANEL_KEYS) {
      assert.ok(Object.hasOwn(inbox, key), `inbox.${language}.json lacks ${key}`);
      assert.equal(inbox[key], lead[key], `inbox.${language}.json says ${key} otherwise than lead.${language}.json`);
    }
  }
});
