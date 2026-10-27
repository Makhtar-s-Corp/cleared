// The visual redesign (lane j3-visual-redesign, matrix P227, issue #375): the
// type rules every sheet keeps. Sentence case everywhere, never letters
// spaced out: no sheet sets text in capitals or tracks it wider (DESIGN.md,
// section 3, and Impeccable's craft floor: no eyebrow over a heading).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new URL('../../web/', import.meta.url).pathname;

function sheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sheets(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

test('no sheet sets text in capitals or spaces its letters wider', () => {
  for (const file of sheets(WEB)) {
    const rules = readFileSync(file, 'utf8').replace(/\/\*[^]*?\*\//g, '');
    for (const [, value] of rules.matchAll(/text-transform:\s*([^;}]+)/g)) assert.equal(value!.trim(), 'none', `${file.slice(WEB.length)}: text-transform: ${value}`);
    for (const [, value] of rules.matchAll(/letter-spacing:\s*([^;}]+)/g)) {
      assert.ok(value!.trim() === '0' || value!.trim().startsWith('-'), `${file.slice(WEB.length)}: letter-spacing: ${value}`);
    }
  }
});
