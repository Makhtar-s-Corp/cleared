import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOGS, LANGUAGES, MESSAGES_DIR, loadCatalog } from '../src/catalog.ts';
import { format, hasMark, translator } from '../web/lib/i18n.ts';

const files = readdirSync(MESSAGES_DIR).filter((name) => name.endsWith('.json')).sort();
const read = (name: string) => JSON.parse(readFileSync(join(MESSAGES_DIR, name), 'utf8')) as Record<string, unknown>;
const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

// A catalog is a screen's, or one of the setup assistant's: setup and
// setup-<step> (milestone-5-plan.md, decision 9, lane v2-j5-assistant).
test('every message file is <catalog>.<language>.json, for the known catalogs and languages', () => {
  assert.ok(files.length > 0);
  for (const name of files) {
    const match = /^([a-z]+(?:-[a-z]+)*)\.([a-z]{2})\.json$/.exec(name);
    assert.ok(match, name);
    assert.ok(CATALOGS.includes(match[1] as never), `${name}: unknown catalog`);
    assert.ok(LANGUAGES.includes(match[2] as never), `${name}: unknown language`);
  }
  for (const catalog of CATALOGS) for (const language of LANGUAGES) assert.ok(files.includes(`${catalog}.${language}.json`), `${catalog}.${language}.json is missing`);
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

test('a catalog falls back to English for a missing key, and a translator marks an unknown key instead of throwing', () => {
  const catalog = loadCatalog('shell', 'fr');
  assert.equal(typeof catalog.app_name, 'string');
  const t = translator({ hello: 'Hello {name}' });
  assert.equal(t('hello', { name: '<b>' }), 'Hello <b>', 'the translator does not escape: the renderer does');
  const missing: string[] = [];
  const told = translator({ hello: 'Hello' }, (key) => missing.push(key));
  assert.equal(told('unknown'), '\u27e6unknown\u27e7', 'drawn marked: a missing word no longer blanks the page (U10)');
  assert.ok(hasMark(told('unknown')) && !hasMark(told('hello')));
  assert.deepEqual(missing, ['unknown', 'unknown']);
  assert.equal(t('unknown'), '\u27e6unknown\u27e7');
  assert.equal(format('{n} min, {n} again, {missing}', { n: 3 }), '3 min, 3 again, ');
});

test('every message key a screen names in its code is in its catalog or the shell\'s', () => {
  const shell = read('shell.en.json');
  for (const screen of SCREENS.filter((s) => s !== 'shell')) {
    const own = read(`${screen}.en.json`);
    const dir = join(MESSAGES_DIR, '..', 'web', 'screens', screen);
    const files = readdirSync(dir).filter((name) => /\.tsx?$/.test(name));
    assert.ok(files.length > 1, `${screen}: its model and its component`);
    for (const file of files) {
      const code = readFileSync(join(dir, file), 'utf8');
      for (const [, key] of code.matchAll(/\bt\('([a-z0-9_]+)'/g)) {
        assert.ok(Object.hasOwn(own, key as string) || Object.hasOwn(shell, key as string), `${screen}/${file} names ${key}, which no catalog has`);
      }
    }
  }
  const dir = join(MESSAGES_DIR, '..', 'web', 'shell');
  for (const file of readdirSync(dir).filter((name) => /\.tsx?$/.test(name))) {
    for (const [, key] of readFileSync(join(dir, file), 'utf8').matchAll(/\bt\('([a-z0-9_]+)'/g)) assert.ok(Object.hasOwn(shell, key as string), `shell/${file} names ${key}, which the shell's catalog has not`);
  }
});

// The keys a component builds from a value (t(`role_${role}`)): every value
// of the type has its key, in both languages. The sessions index blanked
// on a workspace with a lead session (docs/v2/ui-overhaul-plan.md, 1.4):
// the session screen's catalog had no role_lead.
test("every role a session can have is named by the session screen's catalog and, but the reader, by the tower's", () => {
  const roles = ['author', 'reviewer', 'lead', 'reader'] as const;   // Role, src/session/contract.ts
  for (const language of LANGUAGES) {
    const session = read(`session.${language}.json`);
    for (const role of roles) assert.equal(typeof session[`role_${role}`], 'string', `session.${language}.json: role_${role}`);
    const tower = read(`tower.${language}.json`);
    for (const role of roles.filter((r) => r !== 'reader')) assert.equal(typeof tower[`role_${role}`], 'string', `tower.${language}.json: role_${role}`);
  }
});

test("every message key the page's shared code names (lib, components, plan panel) is in a catalog, the shell's for lib", () => {
  const shell = read('shell.en.json');
  const all = SCREENS.reduce<Record<string, unknown>>((sum, screen) => ({ ...sum, ...read(`${screen}.en.json`) }), {});
  const web = join(MESSAGES_DIR, '..', 'web');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []));
  for (const file of walk(join(web, 'lib'))) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(/\bt\('([a-z0-9_]+)'/g)) assert.ok(Object.hasOwn(shell, key as string), `${file} names ${key}, which the shell catalog has not`);
  }
  for (const file of [...walk(join(web, 'components')), ...walk(join(web, 'plan-panel'))]) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(/\bt\('([a-z0-9_]+)'/g)) assert.ok(Object.hasOwn(all, key as string), `${file} names ${key}, which no catalog has`);
  }
});
