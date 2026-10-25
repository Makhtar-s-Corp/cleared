// The status's words (src/heartbeat/messages/heartbeat.<language>.json): the
// French catalog has every key of the English one with the same
// placeholders, keeps French typography, and every problem code has its
// sentence (test/import/catalog.test.ts does the same for the import).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PROBLEM_CODES } from '../../src/heartbeat/beat.ts';
import { HEARTBEAT_MESSAGES_DIR } from '../../src/heartbeat/status.ts';

const read = (name: string) => JSON.parse(readFileSync(`${HEARTBEAT_MESSAGES_DIR}${name}`, 'utf8')) as Record<string, string>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the French catalog has every key of the English one, with the same placeholders, and no other key', () => {
  assert.deepEqual(readdirSync(HEARTBEAT_MESSAGES_DIR).sort(), ['heartbeat.en.json', 'heartbeat.fr.json']);
  const en = read('heartbeat.en.json');
  const fr = read('heartbeat.fr.json');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim() && fr[key]?.trim(), `${key} is empty`);
    assert.deepEqual(placeholders(fr[key] as string), placeholders(value), `${key}: placeholders differ`);
  }
});

test('the French catalog keeps French typography: no plain space before ? ! ; : » or after «', () => {
  for (const [key, value] of Object.entries(read('heartbeat.fr.json'))) {
    assert.doesNotMatch(value, / [?!;:»%]/, key);
    assert.doesNotMatch(value, /« /, key);
  }
});

test('every problem code, the status\'s own error included, has its sentence', () => {
  const en = read('heartbeat.en.json');
  for (const code of [...PROBLEM_CODES, 'status_error']) assert.ok(en[`problem_${code}`], code);
});
