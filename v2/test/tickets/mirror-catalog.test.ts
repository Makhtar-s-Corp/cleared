// The mirror's words (P231): one English and one French catalog, kept as the
// chat's are (test/flow/chat-catalog.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { MIRROR_MESSAGES_DIR } from '../../src/tickets/mirror.ts';

const read = (name: string) => JSON.parse(readFileSync(`${MIRROR_MESSAGES_DIR}${name}`, 'utf8')) as Record<string, unknown>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the French catalog has every key of the English one, with the same placeholders, and no other key', () => {
  assert.deepEqual(readdirSync(MIRROR_MESSAGES_DIR).filter((name) => name.startsWith('mirror.')).sort(), ['mirror.en.json', 'mirror.fr.json']);
  const en = read('mirror.en.json');
  const fr = read('mirror.fr.json');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', key);
    assert.equal(typeof fr[key], 'string', `fr ${key}`);
    assert.ok((value as string).trim() && (fr[key] as string).trim(), `${key} is empty`);
    assert.notEqual(fr[key], value, `${key}: the French is the English`);
    assert.deepEqual(placeholders(fr[key] as string), placeholders(value as string), `${key}: placeholders differ`);
  }
});

test('the French catalog keeps French typography: no plain space before ? ! ; : % » or after «', () => {
  for (const [key, value] of Object.entries(read('mirror.fr.json') as Record<string, string>)) {
    assert.doesNotMatch(value, / [?!;:%»]/, key);
    assert.doesNotMatch(value, /« /, key);
  }
});

test('every key the mirror names is in its catalog, and every key of the catalog is named', () => {
  const en = read('mirror.en.json');
  const source = readFileSync(new URL('../../src/tickets/mirror.ts', import.meta.url), 'utf8');
  const named = new Set([...source.matchAll(/\bt\('([a-z0-9_]+)'/g)].map(([, key]) => key as string));
  for (const key of named) assert.ok(Object.hasOwn(en, key), `mirror.ts names ${key}`);
  for (const key of Object.keys(en)) assert.ok(named.has(key), `${key} is never said`);
});
