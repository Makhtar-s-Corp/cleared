// One document for the whole app (docs/v2/ui-overhaul-plan.md, 2.1.1 and
// U1, lane 34): every screen's address answers the same shell page, an
// address that is no screen's still answers 404, the page names every
// screen's chunk and sheet (each screen's sheets in its own order, off
// until the page turns them on), the router names the same screens as the
// server, and the change stream reaches the page through the app with the
// session cookie only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { readBundle, screenSheets } from '../../src/server.ts';
import { placeOf, pushStack, stackOrder, takenOver } from '../../web/lib/routes.ts';
import { signedIn, startApp } from '../support.ts';

const ADDRESSES = ['/', '/inbox', '/sessions', '/sessions/fixture-author', '/lead', '/plans/plan-1', '/ask/ask-1'];
const sameNonce = (html: string) => html.replace(/nonce="[^"]+"/g, 'nonce=""');

test('every screen\'s address answers the same shell page; any other address answers 404', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const pages = await Promise.all(ADDRESSES.map(async (path) => {
      const response = await fetch(`${app.base}${path}`, { headers: { cookie } });
      assert.equal(response.status, 200, path);
      return sameNonce(await response.text());
    }));
    for (const [i, page] of pages.entries()) assert.equal(page, pages[0], `${ADDRESSES[i]} answers the page / answers`);
    assert.match(pages[0] as string, /<body data-screen="app"/);
    for (const path of ['/nowhere', '/sessions/a/b', '/plans', '/plans/', '/lead/x', '/ask', '/inbox/x', '/sessions/a.b']) {
      assert.equal((await fetch(`${app.base}${path}`, { headers: { cookie }, redirect: 'manual' })).status, 404, path);
    }
    for (const path of ADDRESSES) assert.ok(placeOf(path), `the router names ${path}`);
    for (const path of ['/nowhere', '/sessions/a/b', '/plans', '/lead/x', '/ask']) assert.equal(placeOf(path), undefined, path);
  } finally {
    await app.close();
  }
});

test('the page names every screen\'s chunk, and every screen\'s sheets once, off, in each screen\'s own order', async () => {
  const bundle = readBundle();
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const html = await (await fetch(`${app.base}/inbox`, { headers: { cookie } })).text();
    for (const own of Object.values(bundle.screens)) assert.ok(html.includes(`<link rel="modulepreload" href="${own.script}">`), own.script);
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"( media="not all" data-screens="([a-z ]+)")?>/g)];
    assert.deepEqual(sheets.filter((m) => !m[2]).map((m) => m[1]), bundle.styles, 'the shell\'s sheet, always on');
    const listed = sheets.filter((m) => m[2]).map((m) => ({ href: m[1] as string, screens: (m[3] as string).split(' ') }));
    assert.deepEqual(listed, screenSheets(bundle));
    assert.equal(new Set(listed.map((s) => s.href)).size, listed.length, 'each sheet once');
    for (const [screen, own] of Object.entries(bundle.screens)) {
      const mine = listed.filter((s) => s.screens.includes(screen)).map((s) => s.href);
      assert.deepEqual(mine, own.styles.filter((href) => !bundle.styles.includes(href)), `${screen}: its sheets, in its order`);
    }
  } finally {
    await app.close();
  }
});

test('the router answers a plain click on a link of the app, and leaves the rest to the browser', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const origin = 'http://127.0.0.1:4000';
  assert.equal(takenOver({ href: `${origin}/inbox` }, click, origin), '/inbox');
  assert.equal(takenOver({ href: `${origin}/sessions/s1#editor` }, click, origin), '/sessions/s1#editor');
  assert.equal(takenOver({ href: `${origin}/lead?lead=hello` }, click, origin), '/lead?lead=hello');
  assert.equal(takenOver({ href: `${origin}/inbox` }, { ...click, metaKey: true }, origin), undefined, 'a new tab');
  assert.equal(takenOver({ href: `${origin}/inbox` }, { ...click, button: 1 }, origin), undefined);
  assert.equal(takenOver({ href: `${origin}/inbox`, target: '_blank' }, click, origin), undefined);
  assert.equal(takenOver({ href: `${origin}/inbox`, hasDownload: true }, click, origin), undefined);
  assert.equal(takenOver({ href: 'http://127.0.0.1:4001/inbox' }, click, origin), undefined, 'another origin (a preview)');
  assert.equal(takenOver({ href: `${origin}/manifest.webmanifest` }, click, origin), undefined, 'a file');
  assert.equal(takenOver({ href: `${origin}/login` }, click, origin), undefined);
  assert.equal(takenOver({ href: `${origin}/inbox` }, { ...click, defaultPrevented: true }, origin), undefined);
});

test('the sessions kept mounted: the last one first, each once, five at most', () => {
  let stack: string[] = [];
  for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) stack = pushStack(stack, id);
  assert.deepEqual(stack, ['f', 'e', 'd', 'a', 'c']);
});

test('the kept sessions are drawn in the order they were first opened: a visit moves none (review of 248, B1)', () => {
  let stack: string[] = [];
  let drawn: string[] = [];
  const visit = (id: string) => { stack = pushStack(stack, id); drawn = stackOrder(drawn, stack); return drawn; };
  assert.deepEqual(visit('a'), ['a']);
  assert.deepEqual(visit('b'), ['a', 'b']);
  assert.deepEqual(visit('a'), ['a', 'b'], 'back to a: nothing moves');
  assert.deepEqual(visit('b'), ['a', 'b']);
  for (const id of ['c', 'd', 'e']) visit(id);
  assert.deepEqual(visit('f'), ['b', 'c', 'd', 'e', 'f'], 'the least recent (a) falls off; the others keep their places');
  assert.deepEqual(visit('a'), ['c', 'd', 'e', 'f', 'a'], 'a comes back at the end; b, now the least recent, falls off');
});

test('the change stream reaches the page through the app, with the session cookie only', async () => {
  const source = await fixtureSource({ now: () => FIXTURE_NOW });
  const app = await startApp({ source });
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${app.base}/api/service/events`)).status, 401, 'no cookie, no stream');
    const { cookie } = await signedIn(app);
    const response = await fetch(`${app.base}/api/service/events`, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': stream open')) text += decoder.decode((await reader.read()).value, { stream: true });
    source.changed('inbox', null);
    while (!text.includes('event: change')) text += decoder.decode((await reader.read()).value, { stream: true });
    assert.match(text, /id: 1\nevent: change\ndata: \{"kind":"inbox","id":null,"at":"[^"]+"\}\n\n/);
  } finally {
    controller.abort();
    await app.close();
  }
});
