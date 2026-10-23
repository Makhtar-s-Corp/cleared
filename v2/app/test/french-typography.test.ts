// French typography in every French catalog (lane 37, its art director's item
// 6): a narrow no-break space before ? ! and ;, a no-break space before : and
// inside « », never a plain space, so a mark never wraps alone onto a line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { MESSAGES_DIR } from '../src/catalog.ts';

test('no French catalog puts a plain space before ? ! ; : » or after «', () => {
  const files = readdirSync(MESSAGES_DIR).filter((file) => file.endsWith('.fr.json'));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const catalog = JSON.parse(readFileSync(`${MESSAGES_DIR}${file}`, 'utf8')) as Record<string, string>;
    for (const [key, value] of Object.entries(catalog)) {
      assert.doesNotMatch(value, / [?!;:»]/, `${file} ${key}: a plain space before a mark`);
      assert.doesNotMatch(value, /« /, `${file} ${key}: a plain space after «`);
    }
  }
});
