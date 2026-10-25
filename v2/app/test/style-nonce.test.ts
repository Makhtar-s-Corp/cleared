// The page's style nonce (decisions 32 and 33, lane 32): every page the
// server writes draws a fresh random value, adds style-src 'self'
// 'nonce-<value>' to that response's Content-Security-Policy and writes the
// value in the page as <meta property="csp-nonce" nonce="<value>">, which
// the terminal's shim and the editor's cspNonce read. Never 'unsafe-inline';
// every other directive is the one the server had before; a file, a catalog
// and an API answer carry the policy with no nonce.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentPolicy } from '../src/server.ts';
import { signedIn, startApp } from './support.ts';

const PREVIEW = 'http://127.0.0.1:18794';

// The policy's directives by name, and the nonce of its style-src.
function directives(policy: string): Map<string, string> {
  return new Map(policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const space = part.indexOf(' ');
    return space < 0 ? [part, ''] : [part.slice(0, space), part.slice(space + 1)];
  }));
}
const withoutStyle = (policy: string) => [...directives(policy)].filter(([name]) => name !== 'style-src').map(([name, value]) => `${name} ${value}`).join('; ');
const NONCE = /^'self' 'nonce-([A-Za-z0-9+/_-]{22,}={0,2})'$/;
const metaNonce = (html: string) => /<meta property="csp-nonce" nonce="([^"]+)">/.exec(html)?.[1];

for (const previewOrigin of [undefined, PREVIEW]) {
  test(`two pages carry two different nonces, each the one written in its page${previewOrigin ? ', beside the preview\'s frame-src' : ''}`, async () => {
    const app = await startApp(previewOrigin ? { extra: { previewOrigin } } : {});
    try {
      const { cookie } = await signedIn(app);
      const seen: string[] = [];
      for (const path of ['/sessions/s1', '/sessions/s1', '/', '/login']) {
        const page = await fetch(`${app.base}${path}`, { headers: path === '/login' ? {} : { cookie }, redirect: 'manual' });
        assert.equal(page.status, 200, path);
        const policy = page.headers.get('content-security-policy') ?? '';
        assert.ok(!policy.includes('unsafe-inline'), `${path}: never unsafe-inline`);
        assert.ok(!policy.includes('unsafe-eval'), path);
        const style = directives(policy).get('style-src') ?? '';
        const nonce = NONCE.exec(style)?.[1];
        assert.ok(nonce, `${path}: style-src 'self' and a nonce, nothing else (${style})`);
        assert.equal(withoutStyle(policy), contentPolicy(previewOrigin), `${path}: every other directive as before`);
        assert.equal(directives(policy).get('script-src'), undefined, 'script-src unchanged: it falls back to default-src \'self\'');
        const html = await page.text();
        assert.equal(metaNonce(html), nonce, `${path}: the page holds its response's nonce`);
        assert.equal((html.match(/csp-nonce/g) ?? []).length, 1);
        assert.doesNotMatch(html, /<style|\sstyle=|<script(?![^>]*\ssrc=)[^>]*>/, `${path}: still nothing inline`);
        seen.push(nonce);
      }
      assert.equal(new Set(seen).size, seen.length, 'a fresh value for each page');
    } finally {
      await app.close();
    }
  });
}

test('a file, a catalog and an API answer carry the policy with no nonce', async () => {
  const app = await startApp({ extra: { previewOrigin: PREVIEW } });
  try {
    const { cookie } = await signedIn(app);
    for (const path of ['/theme.js', '/messages/session.json', '/api/me', '/api/service/sessions', '/nothing-here']) {
      const answer = await fetch(`${app.base}${path}`, { headers: { cookie } });
      const policy = answer.headers.get('content-security-policy') ?? '';
      assert.equal(policy, contentPolicy(PREVIEW), path);
      assert.ok(!policy.includes('nonce'), path);
      assert.ok(!(await answer.text()).includes('csp-nonce'), path);
    }
  } finally {
    await app.close();
  }
});

test('the policy without a nonce is the one the server had before this lane', () => {
  assert.equal(contentPolicy(), "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  assert.equal(contentPolicy(PREVIEW), `default-src 'self'; frame-src ${PREVIEW}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
});
