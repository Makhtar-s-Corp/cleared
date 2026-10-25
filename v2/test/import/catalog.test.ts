// The import's words (src/import/messages/import.<language>.json): the
// French catalog has every key of the English one with the same
// placeholders, keeps French typography, and every key the code names is
// there (test/mcp/catalog.test.ts does the same for the servers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { IMPORT_MESSAGES_DIR } from '../../src/import/report.ts';

const read = (name: string) => JSON.parse(readFileSync(`${IMPORT_MESSAGES_DIR}${name}`, 'utf8')) as Record<string, string>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the French catalog has every key of the English one, with the same placeholders, and no other key', () => {
  assert.deepEqual(readdirSync(IMPORT_MESSAGES_DIR).sort(), ['import.en.json', 'import.fr.json']);
  const en = read('import.en.json');
  const fr = read('import.fr.json');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim() && fr[key]?.trim(), `${key} is empty`);
    assert.deepEqual(placeholders(fr[key] as string), placeholders(value), `${key}: placeholders differ`);
  }
});

test('the French catalog keeps French typography: no plain space before ? ! ; : » or after «', () => {
  for (const [key, value] of Object.entries(read('import.fr.json'))) {
    assert.doesNotMatch(value, / [?!;:»]/, key);
    assert.doesNotMatch(value, /« /, key);
  }
});

test('every key the import names is in its catalog', () => {
  const en = read('import.en.json');
  const files = [new URL('../../src/import/report.ts', import.meta.url), new URL('../../src/cli/import-v1.ts', import.meta.url)];
  let named = 0;
  for (const file of files) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(/\bt\('([a-z0-9_]+)'/g)) {
      named++;
      assert.ok(Object.hasOwn(en, key as string), `${key} is not in the catalog`);
    }
  }
  assert.ok(named > 5);
});
