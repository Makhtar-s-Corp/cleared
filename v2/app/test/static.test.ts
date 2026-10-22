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

test('no gradient in any stylesheet, and no theme imposed by the system: the sources and the built sheets', () => {
  const sheets = [...walk(join(app, 'web')), ...walk(join(app, 'dist', 'assets'))].filter((path) => path.endsWith('.css'));
  assert.ok(sheets.filter((path) => path.includes('/dist/')).length >= 4, 'the shell\'s sheet and the screens\' (npm run build)');
  for (const sheet of sheets) {
    const text = readFileSync(sheet, 'utf8');
    assert.doesNotMatch(text, /gradient/i, relative(app, sheet));
    assert.doesNotMatch(text, /prefers-color-scheme/i, `${relative(app, sheet)}: the theme is chosen with the button, never by the system`);
  }
});

test('no em dash in the app\'s files', () => {
  // The app's own files; dist/ is Vite's build, with third-party code.
  for (const path of walk(app).filter((p) => !p.endsWith('.woff2') && !p.endsWith('.png') && !p.startsWith(join(app, 'dist')))) assert.ok(!readFileSync(path, 'utf8').includes(String.fromCharCode(0x2014)), relative(app, path));
});

test('the pages load nothing inline and nothing from another site', async () => {
  const running = await startApp();
  try {
    const login = await fetch(`${running.base}/login`);
    assert.equal(login.status, 200);
    // The page's own style nonce is the one addition (lane 32, style-nonce.test.ts).
    assert.match(login.headers.get('content-security-policy') ?? '', /^default-src 'self'; style-src 'self' 'nonce-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/);
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

test('the bundle is served as JavaScript, its hashed files kept a year; nothing outside dist/ is served', async () => {
  const running = await startApp();
  try {
    const login = await (await fetch(`${running.base}/login`)).text();
    const entry = /<script type="module" src="(\/assets\/main-[A-Za-z0-9_-]+\.js)">/.exec(login)?.[1];
    assert.ok(entry, 'the page names the entry Vite built');
    const code = await fetch(`${running.base}${entry}`);
    assert.equal(code.status, 200);
    assert.equal(code.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(code.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const theme = await fetch(`${running.base}/theme.js`);
    assert.equal(theme.status, 200);
    assert.equal(theme.headers.get('cache-control'), 'no-cache');
    assert.match(await theme.text(), /cleared-v2-theme/);
    const font = await fetch(`${running.base}/fonts/Geist-Variable.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/screens/../../main.ts', '/.hidden', '/index.html.bak', '/.vite/manifest.json', '/screens/tower.ts', '/app.ts', '/assets/../../main.ts'])
      assert.equal((await fetch(`${running.base}${path}`)).status, 404, path);
  } finally {
    await running.close();
  }
});

test('a server started before the build says so, on every page', async () => {
  const running = await startApp({ extra: { distDir: join(v2, 'no-such-build') } });
  try {
    const page = await fetch(`${running.base}/login`);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /npm run build/);
  } finally {
    await running.close();
  }
});

test('the app\'s TypeScript type checks: the server (tsc -p app) and the front end (tsc -p app/web)', () => {
  const tsc = join(v2, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const config of [join(app, 'tsconfig.json'), join(app, 'web', 'tsconfig.json')]) {
    const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', config], { encoding: 'utf8', cwd: v2 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
