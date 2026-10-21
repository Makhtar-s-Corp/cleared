import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signedIn, startApp } from './support.ts';

const app = new URL('..', import.meta.url).pathname;
const v2 = new URL('../..', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('no gradient in any stylesheet, and no theme imposed by the system', () => {
  const sheets = walk(join(app, 'public')).filter((path) => path.endsWith('.css'));
  assert.ok(sheets.length > 0);
  for (const sheet of sheets) {
    const text = readFileSync(sheet, 'utf8');
    assert.doesNotMatch(text, /gradient/i, relative(app, sheet));
    assert.doesNotMatch(text, /prefers-color-scheme/i, `${relative(app, sheet)}: the theme is chosen with the button, never by the system`);
  }
});

test('no em dash in the app\'s files', () => {
  for (const path of walk(app).filter((p) => !p.endsWith('.woff2'))) assert.ok(!readFileSync(path, 'utf8').includes(String.fromCharCode(0x2014)), relative(app, path));
});

test('the pages load nothing inline and nothing from another site', async () => {
  const running = await startApp();
  try {
    const login = await fetch(`${running.base}/login`);
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('content-security-policy'), "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    assert.equal(login.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(login.headers.get('referrer-policy'), 'same-origin');
    const html = await login.text();
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline script');
    assert.doesNotMatch(html, /\sstyle=|<style/, 'no inline style');
    assert.doesNotMatch(html, /https?:\/\//, 'nothing from another site');
    const { cookie } = await signedIn(running);
    const shell = await fetch(`${running.base}/`, { headers: { cookie } });
    assert.equal(shell.status, 200);
    const page = await shell.text();
    assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)[^>]*>/);
    assert.doesNotMatch(page, /\sstyle=|<style|https?:\/\//);
  } finally {
    await running.close();
  }
});

test('a TypeScript file of the page is served as JavaScript, types stripped; a path out of public/ is not served', async () => {
  const running = await startApp();
  try {
    const screen = await fetch(`${running.base}/screens/tower.ts`);
    assert.equal(screen.status, 200);
    assert.equal(screen.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const code = await screen.text();
    assert.doesNotMatch(code, /^\s*import type /m);
    assert.doesNotMatch(code, /^export type /m);
    assert.match(code, /export function renderTower\(/);
    const font = await fetch(`${running.base}/fonts/Geist-Variable.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/screens/../../main.ts', '/.hidden', '/index.html.bak'])
      assert.equal((await fetch(`${running.base}${path}`)).status, 404, path);
  } finally {
    await running.close();
  }
});

test('the app\'s TypeScript type checks, browser code included (tsc -p app)', () => {
  const tsc = join(v2, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', join(app, 'tsconfig.json')], { encoding: 'utf8', cwd: v2 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
