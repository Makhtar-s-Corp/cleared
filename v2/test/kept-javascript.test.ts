// B5.11b: the v2 core is TypeScript. The only JavaScript left under v2/ is
// what a browser loads by its own address, before or without the bundle.
// lib/notify/contract.ts is outside v2/: v1 imports it until milestone 4
// removes v1 (docs/v2/decisions-log.md, 2026-10-22 and 2026-10-25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const v2 = new URL('..', import.meta.url).pathname;

test('no JavaScript is kept in v2/ but the two files the browser loads as they are', () => {
  const files = execFileSync('git', ['-C', v2, 'ls-files'], { encoding: 'utf8' }).split('\n');
  assert.deepEqual(files.filter((file) => /\.(m?js|cjs|jsx)$/.test(file)), [
    // The service worker: a browser registers a worker by its address.
    'app/public/sw.js',
    // The theme, applied in <head> before the page paints.
    'app/public/theme.js',
  ]);
});
