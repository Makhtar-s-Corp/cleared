// The copy of the empty states (docs/v2/ui-overhaul-plan.md, 2.2.7 and
// section 5's copy rules; lane 38): what is not there, in one sentence, never
// a sentence about where things will show. A note or an action says the
// rest. The inbox's catalog is lane 37's, which runs beside lane 38.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MESSAGES = new URL('../../messages/', import.meta.url).pathname;
const PENDING = new Set(['inbox.en.json', 'inbox.fr.json']);

test('an empty state, or a place it cannot open, says one sentence', () => {
  for (const name of readdirSync(MESSAGES).filter((n) => n.endsWith('.json') && !PENDING.has(n))) {
    const catalog = JSON.parse(readFileSync(`${MESSAGES}${name}`, 'utf8')) as Record<string, string>;
    for (const [key, text] of Object.entries(catalog)) {
      if (!/(_empty|_none|_here_only)$/.test(key)) continue;
      assert.doesNotMatch(text.trim(), /[.:;] \S/, `${name} ${key}: ${text}`);
      assert.doesNotMatch(text, /\b(shows? here|s'affiche ici)\b/i, `${name} ${key}: says where, not what`);
    }
  }
});
