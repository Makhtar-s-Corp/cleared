// The terminal's and the editor's packages (lane 30, lane v2-j2-deps-xterm)
// are loaded by the session screen only, by a dynamic import (lane 32): the
// build manifest of npm run build is read, and no screen's chunk, the
// entry's or the session's included, holds either package among what it
// loads at once; both appear only behind the session screen's dynamic
// imports. The markers are strings each package's own code holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST_DIR } from '../../src/server.ts';

type Chunk = { readonly file: string; readonly src?: string; readonly isEntry?: boolean; readonly imports?: readonly string[]; readonly dynamicImports?: readonly string[]; readonly css?: readonly string[] };

const manifest = JSON.parse(readFileSync(join(DIST_DIR, '.vite', 'manifest.json'), 'utf8')) as Record<string, Chunk>;
const read = (file: string) => readFileSync(join(DIST_DIR, file), 'utf8');

const PACKAGES: Readonly<Record<string, RegExp>> = {
  xterm: /xterm-helper-textarea/,
  codemirror: /cm-scroller/,
};

// A chunk and every chunk it imports statically: what loads with it.
function closure(key: string, seen: Set<string> = new Set()): Set<string> {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const next of manifest[key]?.imports ?? []) closure(next, seen);
  return seen;
}

const entry = Object.keys(manifest).find((key) => manifest[key]?.isEntry) as string;
const screens = Object.keys(manifest).filter((key) => /^screens\/[a-z]+\/[A-Z]/.test(manifest[key]?.src ?? key));

test('the build has the entry and the five screens\' chunks', () => {
  assert.ok(entry);
  for (const screen of ['tower', 'inbox', 'session', 'lead', 'ask']) assert.ok(screens.some((key) => key.startsWith(`screens/${screen}/`)), screen);
});

for (const [name, marker] of Object.entries(PACKAGES)) {
  test(`${name} is in no chunk the entry or a screen loads at once`, () => {
    for (const start of [entry, ...screens]) {
      for (const key of closure(start)) {
        const chunk = manifest[key] as Chunk;
        assert.doesNotMatch(read(chunk.file), marker, `${start} loads ${chunk.file} at once, which holds ${name}`);
      }
    }
  });

  test(`${name} is behind a dynamic import of the session screen, and of no other screen`, () => {
    const behind = (start: string) => [...closure(start)].flatMap((key) => manifest[key]?.dynamicImports ?? [])
      .flatMap((key) => [...closure(key)]).some((key) => marker.test(read((manifest[key] as Chunk).file)));
    const session = screens.find((key) => key.startsWith('screens/session/')) as string;
    assert.ok(behind(session), `the session screen reaches ${name} by a dynamic import`);
    for (const other of screens.filter((key) => key !== session)) assert.ok(!behind(other), `${other} does not reach ${name}`);
  });
}

test('the terminal\'s stylesheet is a file of the app\'s origin, not a style element', () => {
  const sheets = Object.values(manifest).flatMap((chunk) => chunk.css ?? []);
  assert.ok(sheets.some((file) => /\.xterm-viewport/.test(read(file))), 'xterm.css is bundled as a sheet');
  for (const screen of screens.filter((key) => !key.startsWith('screens/session/'))) {
    for (const key of closure(screen)) for (const file of manifest[key]?.css ?? []) assert.doesNotMatch(read(file), /\.xterm-viewport/, `${screen} loads ${file}`);
  }
});
