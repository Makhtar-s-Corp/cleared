// The change stream in the page (web/lib/events.ts, lane 34): an open
// stream makes the cache trust it, an event refetches what it names, a drop
// falls back to polling, the EventSource's own reconnect refetches what the
// cache holds once, and a stream closed for good is opened again later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../../web/lib/cache.ts';
import { CLOSED, ChangeStream, EVENTS_URL, RETRY_MS, type SourceLike } from '../../web/lib/events.ts';

type Listener = (event: { data?: string }) => void;
class FakeSource implements SourceLike {
  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(name: string, listener: Listener): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  close(): void { this.closed = true; this.readyState = CLOSED; }
  fire(name: string, data?: string): void { for (const listener of this.listeners.get(name) ?? []) listener({ data }); }
}

test('open, an event, a drop and the reconnect: live, one key refetched, polling, everything held refetched once', async () => {
  const asked: string[] = [];
  const cache = new Cache(async (path) => { asked.push(path); return []; });
  const sources: FakeSource[] = [];
  const later: { run: () => void; ms: number }[] = [];
  const stream = new ChangeStream(cache, {
    open: (url) => { assert.equal(url, EVENTS_URL); const s = new FakeSource(); sources.push(s); return s; },
    later: (run, ms) => { later.push({ run, ms }); return () => {}; },
  });
  try {
    await cache.read('/inbox');
    await cache.read('/sessions');
    stream.start();
    const source = sources[0]!;
    source.readyState = 1;
    source.fire('open');
    assert.equal(cache.live, true);
    asked.length = 0;
    source.fire('change', JSON.stringify({ kind: 'inbox', id: null, at: '2026-10-22T22:00:00Z' }));
    source.fire('change', 'not json');
    await new Promise((done) => setTimeout(done, 0));
    assert.deepEqual(asked, ['/inbox']);

    source.readyState = 0;                                 // the EventSource reconnects by itself
    source.fire('error');
    assert.equal(cache.live, false, 'down: the cache polls again');
    assert.equal(later.length, 0, 'the EventSource retries on its own');
    asked.length = 0;
    source.readyState = 1;
    source.fire('open');
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(cache.live, true);
    assert.deepEqual(asked.sort(), ['/inbox', '/sessions'], 'everything held, once');

    source.readyState = CLOSED;                            // refused for good (a 404, a sign out)
    source.fire('error');
    assert.equal(later.length, 1);
    assert.equal(later[0]?.ms, RETRY_MS);
    later[0]?.run();
    assert.equal(sources.length, 2, 'opened again after RETRY_MS');
    sources[1]!.readyState = CLOSED;
    sources[1]!.fire('error');
    assert.equal(later[1]?.ms, RETRY_MS * 2, 'then twice as long');
  } finally {
    stream.stop();
    cache.dispose();
  }
  assert.equal(cache.live, false);
});
