// The copy of the empty states (docs/v2/ui-overhaul-plan.md, 2.2.7 and
// section 5's copy rules; lane 38): what is not there, in one sentence, never
// a sentence about where things will show. A note or an action says the
// rest. Every catalog, the inbox's included since lane 37's merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MESSAGES = new URL('../../messages/', import.meta.url).pathname;
const PENDING = new Set<string>();

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

test('the tower bar\'s placeholder says its three uses in a line a phone shows whole (lane 38\'s art director, item 9)', () => {
  for (const language of ['en', 'fr']) {
    const tower = JSON.parse(readFileSync(`${MESSAGES}tower.${language}.json`, 'utf8')) as Record<string, string>;
    assert.ok((tower.bar_placeholder ?? '').length <= 40, `${language}: ${tower.bar_placeholder}`);
  }
});
