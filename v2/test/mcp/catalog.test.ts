// The server's words: one English and one French catalog, kept as the app's
// are (app/test/catalog.test.ts and french-typography.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { MESSAGES_DIR } from '../../src/mcp/server.ts';

const read = (name: string) => JSON.parse(readFileSync(`${MESSAGES_DIR}${name}`, 'utf8')) as Record<string, unknown>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the French catalog has every key of the English one, with the same placeholders, and no other key', () => {
  assert.deepEqual(readdirSync(MESSAGES_DIR).sort(), ['ledger.en.json', 'ledger.fr.json']);
  const en = read('ledger.en.json');
  const fr = read('ledger.fr.json');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', key);
    assert.equal(typeof fr[key], 'string', `fr ${key}`);
    assert.ok((value as string).trim() && (fr[key] as string).trim(), `${key} is empty`);
    assert.deepEqual(placeholders(fr[key] as string), placeholders(value as string), `${key}: placeholders differ`);
  }
});

test('the French catalog keeps French typography: no plain space before ? ! ; : » or after «', () => {
  for (const [key, value] of Object.entries(read('ledger.fr.json') as Record<string, string>)) {
    assert.doesNotMatch(value, / [?!;:»]/, key);
    assert.doesNotMatch(value, /« /, key);
  }
});

test('every key the server names is in its catalog', () => {
  const en = read('ledger.en.json');
  const dir = new URL('../../src/mcp/', import.meta.url).pathname;
  let named = 0;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    for (const [, key] of readFileSync(`${dir}${file}`, 'utf8').matchAll(/\bt\('([a-z0-9_]+)'/g)) {
      named++;
      assert.ok(Object.hasOwn(en, key as string), `${file} names ${key}`);
    }
  }
  assert.ok(named > 10);
});
