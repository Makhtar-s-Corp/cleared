// The page's shared cache (web/lib/cache.ts, lane 34): one entry per
// resource, a second read answered without a request, an event refetching
// the one resource it names, the polling fallback while the stream is down,
// one refetch of everything on a reconnect, readers that ask nothing of
// their own, and the optimistic gestures of the inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cache, POLL_MS, hashOf, keysOf, optimistic, resourceOf, touchedBy, type Key } from '../../web/lib/cache.ts';

type Item = { id: string; kind: string; state: string; sessionId?: string; requestId?: string; planId?: string };

function service(data: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const values: Record<string, unknown> = { '/inbox': [], '/lead': { phase: 'idle' }, '/sessions': [], '/tickets': [], ...data };
  const read = async (path: string) => {
    asked.push(path);
    if (!(path in values)) throw new Error(`404 ${path}`);
    return structuredClone(values[path]);
  };
  return { asked, values, read };
}

const t_caches: Cache[] = [];
test.afterEach(() => { for (const c of t_caches.splice(0)) c.dispose(); });
const settle = () => new Promise((done) => setTimeout(done, 0));
const subscriber = (keys: Key[], notify: () => void = () => {}) => ({ keys: new Set(keys.map(hashOf)), notify });

test('a resource is a path of the API without a query; anything else goes to the network', () => {
  assert.deepEqual(resourceOf('/sessions'), ['sessions']);
  assert.deepEqual(resourceOf('/sessions/s%201'), ['session', 's 1']);
  assert.deepEqual(resourceOf('/tickets/LOCAL-1/steps'), ['steps', 'LOCAL-1']);
  assert.deepEqual(resourceOf('/inbox'), ['inbox']);
  assert.deepEqual(resourceOf('/lead/messages'), ['lead-messages']);
  for (const path of ['/lead/messages?after=4', '/sessions/s1/files', '/sessions/s1/files/a.ts', '/asks/a1', '/lead/stream']) assert.equal(resourceOf(path), undefined, path);
});

test('a second read answers the held value at once, without a request', async () => {
  const s = service({ '/inbox': [{ id: 'a', kind: 'permission', state: 'waiting' }] });
  const cache = new Cache(s.read);
  t_caches.push(cache);
  cache.setLive(true);
  await cache.read('/inbox');
  assert.deepEqual(await cache.read('/inbox'), [{ id: 'a', kind: 'permission', state: 'waiting' }]);
  assert.deepEqual(cache.peek('/inbox'), [{ id: 'a', kind: 'permission', state: 'waiting' }]);
  assert.deepEqual(s.asked, ['/inbox']);
  await Promise.all([cache.read('/sessions'), cache.read('/sessions')]);
  assert.deepEqual(s.asked, ['/inbox', '/sessions'], 'two readers at once, one request');
  await cache.read('/lead/messages?after=4').catch(() => {});
  await cache.read('/lead/messages?after=4').catch(() => {});
  assert.equal(s.asked.filter((p) => p.startsWith('/lead/messages')).length, 2, 'a cursor read is never held');
});

test('an event refetches the one resource it names and the cache holds, nothing else', async () => {
  const s = service({ '/sessions/s1': { id: 's1' }, '/plans': [] });
  const cache = new Cache(s.read);
  t_caches.push(cache);
  cache.setLive(true);
  for (const path of ['/inbox', '/sessions', '/tickets', '/lead', '/sessions/s1']) await cache.read(path);
  s.asked.length = 0;
  cache.changed({ kind: 'inbox', id: null });
  await settle();
  assert.deepEqual(s.asked, ['/inbox']);
  s.asked.length = 0;
  cache.changed({ kind: 'session', id: 's1' });
  await settle();
  assert.deepEqual(s.asked.sort(), ['/sessions', '/sessions/s1']);
  s.asked.length = 0;
  cache.changed({ kind: 'session', id: 's2' });
  await settle();
  assert.deepEqual(s.asked, ['/sessions'], 'a session not held is not read');
  assert.deepEqual(keysOf({ kind: 'ticket', id: 'T-1' }), [['ticket', 'T-1'], ['tickets'], ['steps', 'T-1'], ['plans']]);
});

test('the inbox count and the lead\'s pill read the cache: with the stream open, only the lead is polled, once for every reader', async () => {
  let now = 0;
  const s = service();
  const cache = new Cache(s.read, { now: () => now });
  t_caches.push(cache);
  cache.setLive(true);
  const shell = subscriber([['inbox'], ['lead']]);
  const tower = subscriber([['inbox'], ['lead'], ['sessions']]);
  const leave = [cache.subscribe(shell), cache.subscribe(tower)];
  for (const path of ['/inbox', '/lead', '/sessions', '/inbox', '/lead']) await cache.read(path);
  assert.deepEqual(s.asked.sort(), ['/inbox', '/lead', '/sessions']);
  s.asked.length = 0;
  for (let second = 1; second <= 60; second += 1) {
    now = second * 1000;
    cache.poll();
    await settle();
  }
  assert.deepEqual([...new Set(s.asked)], ['/lead'], 'the stream speaks for the inbox and the sessions');
  assert.equal(s.asked.length, 60_000 / POLL_MS, 'the lead every POLL_MS, whoever reads it');
  for (const stop of leave) stop();
  s.asked.length = 0;
  now += 10 * POLL_MS;
  cache.poll();
  await settle();
  assert.deepEqual(s.asked, [], 'nothing mounted reads it: nothing polled');
});

test('a dropped stream falls back to polling every resource read; the reconnect refetches everything held, once', async () => {
  let now = 0;
  const s = service();
  const cache = new Cache(s.read, { now: () => now });
  t_caches.push(cache);
  cache.setLive(true);
  const leave = cache.subscribe(subscriber([['inbox'], ['sessions']]));
  await cache.read('/inbox');
  await cache.read('/sessions');
  await cache.read('/tickets');
  s.asked.length = 0;
  cache.setLive(false);
  now = POLL_MS - 1;
  cache.poll();
  await settle();
  assert.deepEqual(s.asked, [], 'fresh until the interval');
  now = POLL_MS;
  cache.poll();
  await settle();
  assert.deepEqual(s.asked.sort(), ['/inbox', '/sessions'], 'what is read, at the interval of before');
  s.asked.length = 0;
  cache.setLive(true);
  cache.refetchAll();
  await settle();
  assert.deepEqual(s.asked.sort(), ['/inbox', '/sessions', '/tickets']);
  leave();
});

test('a stale value is answered at once and refetched behind it; a reader is told of the new value', async () => {
  let now = 0;
  const s = service({ '/workspace': { services: ['a'] } });
  const cache = new Cache(s.read, { now: () => now });
  t_caches.push(cache);
  cache.setLive(true);
  let told = 0;
  const leave = cache.subscribe(subscriber([['workspace']], () => { told += 1; }));
  await cache.read('/workspace');
  told = 0;
  s.values['/workspace'] = { services: ['a', 'b'] };
  now = POLL_MS;
  assert.deepEqual(await cache.read('/workspace'), { services: ['a'] }, 'the held value first');
  await settle();
  assert.equal(told, 1);
  assert.deepEqual(await cache.read('/workspace'), { services: ['a', 'b'] });
  leave();
});

test('an answer, a Go and a plan\'s approval move the inbox at once, and back when the service refuses', async () => {
  const items: Item[] = [
    { id: 'permission:s1:r1', kind: 'permission', state: 'waiting', sessionId: 's1', requestId: 'r1' },
    { id: 'session_plan:s2:1', kind: 'session_plan', state: 'waiting', sessionId: 's2' },
    { id: 'plan:p1', kind: 'plan', state: 'waiting', planId: 'p1' },
  ];
  const s = service({ '/inbox': items });
  const cache = new Cache(s.read);
  t_caches.push(cache);
  cache.setLive(true);
  await cache.read('/inbox');
  let told = 0;
  const leave = cache.subscribe(subscriber([['inbox']], () => { told += 1; }));
  const states = () => (cache.peek<Item[]>('/inbox') ?? []).map((i) => i.state);

  let release!: () => void;
  const answered = cache.write('/sessions/s1/requests/r1/answer', { decision: { kind: 'allow_once' } }, () => new Promise((done) => { release = () => done({ accepted: true }); }));
  assert.deepEqual(states(), ['handled', 'waiting', 'waiting'], 'the row moves before the route answers');
  assert.equal(told, 1, 'the readers are told at once');
  release();
  await answered;

  await assert.rejects(cache.write('/sessions/s2/plan/go', null, async () => { throw new Error('409'); }));
  assert.equal(states()[1], 'waiting', 'a refused Go comes back');

  const approving = cache.write('/plans/p1/approve', null, async () => ({ id: 'p1' }));
  assert.equal(states()[2], 'handled');
  await approving;
  assert.equal(optimistic('/sessions/s1/messages'), undefined, 'a message is not an inbox gesture');
  assert.deepEqual(touchedBy('/sessions/s1/messages'), [['session', 's1'], ['sessions'], ['inbox']]);
  leave();
});
