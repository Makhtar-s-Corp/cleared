// The servers' words: one English and one French catalog per server (the
// ledger's, and the lanes' of P216), kept as the app's are
// (app/test/catalog.test.ts and french-typography.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { MESSAGES_DIR } from '../../src/mcp/server.ts';

const read = (name: string) => JSON.parse(readFileSync(`${MESSAGES_DIR}${name}`, 'utf8')) as Record<string, unknown>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

const SERVERS = ['lanes', 'ledger'] as const;

test('each French catalog has every key of its English one, with the same placeholders, and no other key', () => {
  assert.deepEqual(readdirSync(MESSAGES_DIR).sort(), ['lanes.en.json', 'lanes.fr.json', 'ledger.en.json', 'ledger.fr.json']);
  for (const server of SERVERS) {
    const en = read(`${server}.en.json`);
    const fr = read(`${server}.fr.json`);
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort(), server);
    for (const [key, value] of Object.entries(en)) {
      assert.equal(typeof value, 'string', key);
      assert.equal(typeof fr[key], 'string', `fr ${key}`);
      assert.ok((value as string).trim() && (fr[key] as string).trim(), `${key} is empty`);
      assert.deepEqual(placeholders(fr[key] as string), placeholders(value as string), `${server} ${key}: placeholders differ`);
    }
  }
});

test('the French catalogs keep French typography: no plain space before ? ! ; : » or after «', () => {
  for (const server of SERVERS) {
    for (const [key, value] of Object.entries(read(`${server}.fr.json`) as Record<string, string>)) {
      assert.doesNotMatch(value, / [?!;:»]/, `${server} ${key}`);
      assert.doesNotMatch(value, /« /, `${server} ${key}`);
    }
  }
});

// The JSON-RPC core (rpc.ts) speaks for both servers, so its keys are in
// both catalogs; the lanes' tools (lanes.ts, http.ts) in theirs; the rest in the ledger's.
const catalogsOf = (file: string): readonly string[] => (file === 'rpc.ts' ? SERVERS : file === 'lanes.ts' || file === 'http.ts' ? ['lanes'] : ['ledger']);

test('every key a server names is in its catalog', () => {
  const dir = new URL('../../src/mcp/', import.meta.url).pathname;
  let named = 0;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    for (const [, key] of readFileSync(`${dir}${file}`, 'utf8').matchAll(/\bt\('([a-z0-9_]+)'/g)) {
      named++;
      for (const server of catalogsOf(file)) assert.ok(Object.hasOwn(read(`${server}.en.json`), key as string), `${file} names ${key}, not in ${server}`);
    }
  }
  assert.ok(named > 10);
});
