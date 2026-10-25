// The chat's words (P212): one English and one French catalog, kept as the
// app's are (app/test/catalog.test.ts and french-typography.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CHAT_MESSAGES_DIR } from '../../src/flow/chat.ts';

const read = (name: string) => JSON.parse(readFileSync(`${CHAT_MESSAGES_DIR}${name}`, 'utf8')) as Record<string, unknown>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the French catalog has every key of the English one, with the same placeholders, and no other key', () => {
  assert.deepEqual(readdirSync(CHAT_MESSAGES_DIR).sort(), ['chat.en.json', 'chat.fr.json']);
  const en = read('chat.en.json');
  const fr = read('chat.fr.json');
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
  for (const [key, value] of Object.entries(read('chat.fr.json') as Record<string, string>)) {
    assert.doesNotMatch(value, / [?!;:%»]/, key);
    assert.doesNotMatch(value, /« /, key);
  }
});

test('every key the chat names is in its catalog, and every key of the catalog is named', () => {
  const en = read('chat.en.json');
  const source = readFileSync(new URL('../../src/flow/chat.ts', import.meta.url), 'utf8');
  const named = new Set([...source.matchAll(/\bt\('([a-z0-9_]+)'/g)].map(([, key]) => key as string));
  for (const key of named) assert.ok(Object.hasOwn(en, key), `chat.ts names ${key}`);
  for (const key of Object.keys(en)) assert.ok(named.has(key), `${key} is never said`);
});
