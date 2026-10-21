import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGUAGES, MESSAGES_DIR, SCREENS, loadCatalog } from '../src/catalog.ts';
import { format, translator } from '../public/i18n.ts';

const files = readdirSync(MESSAGES_DIR).filter((name) => name.endsWith('.json')).sort();
const read = (name: string) => JSON.parse(readFileSync(join(MESSAGES_DIR, name), 'utf8')) as Record<string, unknown>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('every message file is <screen>.<language>.json, for the known screens and languages', () => {
  assert.ok(files.length > 0);
  for (const name of files) {
    const match = /^([a-z]+)\.([a-z]{2})\.json$/.exec(name);
    assert.ok(match, name);
    assert.ok(SCREENS.includes(match[1] as never), `${name}: unknown screen`);
    assert.ok(LANGUAGES.includes(match[2] as never), `${name}: unknown language`);
  }
  for (const screen of SCREENS) for (const language of LANGUAGES) assert.ok(files.includes(`${screen}.${language}.json`), `${screen}.${language}.json is missing`);
});

test('the French file of every screen has every key of the English one, with the same placeholders, and no other key', () => {
  for (const name of files.filter((n) => n.endsWith('.en.json'))) {
    const en = read(name);
    const fr = read(name.replace('.en.json', '.fr.json'));
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort(), name);
    for (const [key, value] of Object.entries(en)) {
      assert.equal(typeof value, 'string', `${name} ${key}`);
      assert.equal(typeof fr[key], 'string', `fr ${key}`);
      assert.ok((value as string).trim() && (fr[key] as string).trim(), `${name} ${key} is empty`);
      assert.deepEqual(placeholders(fr[key] as string), placeholders(value as string), `${name} ${key}: placeholders differ`);
    }
  }
});

test('a catalog falls back to English for a missing key, and a translator refuses an unknown key', () => {
  const catalog = loadCatalog('shell', 'fr');
  assert.equal(typeof catalog.app_name, 'string');
  const t = translator({ hello: 'Hello {name}' });
  assert.equal(t('hello', { name: '<b>' }), 'Hello <b>', 'the translator does not escape: the renderer does');
  assert.throws(() => t('unknown'), /unknown message key: unknown/);
  assert.equal(format('{n} min, {n} again, {missing}', { n: 3 }), '3 min, 3 again, ');
});

test('every message key a screen names in its code is in its catalog or the shell\'s', () => {
  const shell = read('shell.en.json');
  for (const screen of SCREENS.filter((s) => s !== 'shell')) {
    const own = read(`${screen}.en.json`);
    const code = readFileSync(join(MESSAGES_DIR, '..', 'public', 'screens', `${screen}.ts`), 'utf8');
    for (const [, key] of code.matchAll(/\bt\('([a-z0-9_]+)'/g)) {
      assert.ok(Object.hasOwn(own, key as string) || Object.hasOwn(shell, key as string), `${screen}.ts names ${key}, which no catalog has`);
    }
  }
});
