// The /ask/:id screen against the app (decision 28, lane 27): the page, its
// catalog, its sheet and its chunk are served, and the fixture source
// answers the three ask routes as lane 25's service does: an ask, its read,
// and a follow-up refused while a turn runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ask } from '../../../src/api/types.ts';
import { ASK_ID } from '../../fixtures/ask.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { pageFiles, signedIn, startApp } from '../support.ts';

test('the app serves the ask\'s page for an ask\'s address, and nothing for another', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const get = (path: string) => fetch(`${app.base}${path}`, { headers: { cookie }, redirect: 'manual' });
    const page = await get(`/ask/${ASK_ID}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-screen="app"/, 'the one shell page (lane 34)');
    assert.match(html, /<title>Cleared<\/title>/, 'the page names the screen in its title once drawn (shell/App.tsx)');
    for (const path of ['/ask', '/ask/', '/ask/a/b', `/ask/${'x'.repeat(65)}`]) assert.equal((await get(path)).status, 404, path);
    // Signed out, the page sends to the sign-in.
    assert.equal((await fetch(`${app.base}/ask/${ASK_ID}`, { redirect: 'manual' })).status, 303);
    const catalog = await (await get('/messages/ask.json')).json() as Record<string, string>;
    assert.equal(catalog.ask_title, 'Question to the code');
    const files = await pageFiles(app, `/ask/${ASK_ID}`, cookie);
    assert.ok(files.styles.length >= 2, 'the shell\'s sheet, then the ask\'s');
    assert.match(files.css, /\.ask-screen/);
    assert.doesNotMatch(files.css, /gradient/i);
    assert.ok(files.js.includes('follow-input'), 'the ask screen\'s chunk, preloaded with the page');
  } finally {
    await app.close();
  }
});

test('the fixture source asks, reads and follows up, and refuses a follow-up while a turn runs', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie, csrf } = await signedIn(app);
    const api = (path: string, body?: unknown) => fetch(`${app.base}/api/service${path}`, body === undefined ? { headers: { cookie } } : {
      method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const read = await api(`/asks/${ASK_ID}`);
    assert.equal(read.status, 200);
    assert.equal((await read.json() as Ask).state, 'answered');
    assert.equal((await api('/asks/ask-unknown')).status, 404);

    const asked = await api('/asks', { question: 'Where is an entry stored?', service: 'guestbook' });
    assert.equal(asked.status, 200);
    const ask = await asked.json() as Ask;
    assert.match(ask.id, /^ask-/);
    assert.equal(ask.state, 'starting');
    assert.equal(ask.question, 'Where is an entry stored?');
    assert.equal((await api('/asks', { question: ' ' })).status, 400);

    const followed = await api(`/asks/${ASK_ID}/follow`, { question: 'And the archive page?' });
    assert.equal(followed.status, 200);
    const after = await followed.json() as Ask;
    assert.equal(after.state, 'running');
    assert.equal(after.turns.at(-1)?.question, 'And the archive page?');
    assert.equal((await api(`/asks/${ASK_ID}/follow`, { question: 'And then?' })).status, 409, 'a turn runs');
  } finally {
    await app.close();
  }
});
