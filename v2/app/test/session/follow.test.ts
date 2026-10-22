// The live stream: a reconnect resumes from the last seq, and a server that
// replays more than it was asked to adds nothing twice. Then the screen
// against the app: the page, its catalog and its stylesheet are served, and
// the writes reach the service routes with the signed-in user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_ID, REQUEST_ID, sessionFixture, sessionSource } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { follow, type StreamLike } from '../../web/screens/session/model.ts';
import type { SessionEvent } from '../../../src/session/events.ts';
import { pageFiles, signedIn, startApp } from '../support.ts';
import { message, stored } from './support.ts';

class FakeStream implements StreamLike {
  readonly listeners = new Map<string, (event: { data: string }) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(name: string, listener: (event: { data: string }) => void): void { this.listeners.set(name, listener); }
  close(): void { this.closed = true; }
  deliver(event: SessionEvent): void { this.listeners.get(event.event.type)?.({ data: JSON.stringify(event) }); }
}

test('a stream that drops is reopened from the last seq, and a replay adds nothing twice', () => {
  const events = stored(message('m1', 'assistant', 'one'), 1);
  const more = stored(message('m2', 'assistant', 'two'), 4);
  const streams: FakeStream[] = [];
  const retries: (() => void)[] = [];
  const seen: number[] = [];
  const handle = follow({
    url: (after) => `/api/service/sessions/s1/events?after=${after}`, after: 0,
    open: (url) => { const stream = new FakeStream(url); streams.push(stream); return stream; },
    later: (run) => { retries.push(run); },
    onEvent: (event) => seen.push(event.seq),
  });
  const first = streams[0] as FakeStream;
  assert.equal(first.url, '/api/service/sessions/s1/events?after=0');
  for (const event of events) first.deliver(event);
  first.onerror?.();
  assert.ok(first.closed, 'the broken stream is closed, not left to retry by itself with its old ?after=');
  assert.equal(retries.length, 1);
  retries.shift()?.();
  const second = streams[1] as FakeStream;
  assert.equal(second.url, '/api/service/sessions/s1/events?after=3');
  for (const event of [...events, ...more]) second.deliver(event);   // a server that replays everything
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.equal(handle.lastSeq(), 6);
  handle.stop();
  assert.ok(second.closed);
  second.onerror?.();
  assert.equal(retries.length, 0, 'a stopped stream does not come back');
});

test('the follower keeps listening for every AG-UI type of the subset', () => {
  const streams: FakeStream[] = [];
  follow({ url: (after) => `/e?after=${after}`, after: 0, open: (url) => { const s = new FakeStream(url); streams.push(s); return s; }, later: () => {}, onEvent: () => {} });
  assert.equal((streams[0] as FakeStream).listeners.size, 17);
});

test('the app serves the screen\'s page, catalog, stylesheet and script, and forwards the screen\'s writes with the signed-in user', async () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const source = sessionSource(fixture);
  const app = await startApp({ source });
  try {
    const { cookie, csrf, id } = await signedIn(app);
    const get = (path: string) => fetch(`${app.base}${path}`, { headers: { cookie } });
    const page = await get(`/sessions/${AUTHOR_ID}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-screen="app"/, 'the one shell page (lane 34)');
    assert.equal((await get('/sessions')).status, 200);
    const catalog = await (await get('/messages/session.json')).json() as Record<string, string>;
    assert.equal(catalog.allow_once, 'Allow once');
    const files = await pageFiles(app, `/sessions/${AUTHOR_ID}`, cookie);
    assert.doesNotMatch(files.css, /gradient|prefers-color-scheme/i);
    assert.match(files.css, /\.timeline/);
    assert.ok(/\/events\?after=/.test(files.js), 'the session screen\'s chunk, preloaded with the page');

    const detail = await (await get(`/api/service/sessions/${AUTHOR_ID}`)).json() as { state: { phase: string } };
    assert.equal(detail.state.phase, 'waiting_human');
    const write = (path: string, body: unknown) => fetch(`${app.base}/api/service${path}`, {
      method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', origin: app.origin, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body),
    });
    assert.equal((await write(`/sessions/${AUTHOR_ID}/messages`, { text: 'Use the first month.' })).status, 202);
    assert.equal((await write(`/sessions/${AUTHOR_ID}/requests/${REQUEST_ID}/answer`, { decision: { kind: 'allow_once' } })).status, 202);
    assert.equal((await write(`/sessions/${AUTHOR_ID}/interrupt`, null)).status, 202);
    assert.deepEqual(source.calls.map((c) => [c.path, c.user]), [
      [`/api/sessions/${AUTHOR_ID}/messages`, id], [`/api/sessions/${AUTHOR_ID}/requests/${REQUEST_ID}/answer`, id], [`/api/sessions/${AUTHOR_ID}/interrupt`, id],
    ]);
    const stream = await fetch(`${app.base}/api/service/sessions/${AUTHOR_ID}/events?after=${fixture.sessions[0]?.lastSeq ?? 0}`, { headers: { cookie } });
    const frames = (await stream.text()).split('\n\n').filter(Boolean);
    assert.ok(frames.length >= 3, 'the three writes are stored and the stream resumes after the last seq the page had');
    assert.ok(frames.every((frame) => frame.startsWith('id: ') && frame.includes('\nevent: ')));
  } finally {
    await app.close();
  }
});
