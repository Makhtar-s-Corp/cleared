// The guestbook as the filter API's consumer: with FILTER_URL set, an entry
// is checked before it is stored; unset, the filter is never called. The
// filter is a fake (test/helpers/fake-filter.ts) answering as its contract says.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server.ts';
import { createFilter } from '../src/filter.ts';
import { testDatabase, type TestDatabase } from './helpers/db.ts';
import { fakeFilter, type FakeFilter } from './helpers/fake-filter.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual',
});

let db: TestDatabase;
let fake: FakeFilter;

before(async () => {
  db = await testDatabase();
  fake = await fakeFilter(['spam', 'scam']);
});

after(async () => {
  await fake.close();
  await db.drop();
});

async function withApp(options: Parameters<typeof createApp>[1], work: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(db.store, options);
  try {
    await work(await listen(server));
  } finally {
    await close(server);
  }
}

test('without a filter (FILTER_URL unset), an entry is stored and the filter is never called', async () => {
  fake.calls.length = 0;
  await withApp({}, async (base) => {
    const response = await fetch(`${base}/entries`, form({ name: 'Ada', message: 'spam, but no filter here' }));
    assert.equal(response.status, 303);
  });
  assert.equal((await db.store.list()).at(-1)?.message, 'spam, but no filter here');
  assert.deepEqual(fake.calls, []);
});

test('with a filter, an entry it accepts is stored, after one check of the name and the message', async () => {
  fake.calls.length = 0;
  fake.answer = 'contract';
  await withApp({ filter: createFilter(fake.url) }, async (base) => {
    const response = await fetch(`${base}/entries`, form({ name: 'Grace', message: 'Lovely guestbook' }));
    assert.equal(response.status, 303);
  });
  assert.deepEqual(fake.calls, ['Grace\nLovely guestbook']);
  assert.equal((await db.store.list()).at(-1)?.message, 'Lovely guestbook');
});

test('with a filter, an entry it refuses is 400 with the words, kept in the form, and not stored', async () => {
  fake.answer = 'contract';
  const before = (await db.store.list()).length;
  await withApp({ filter: createFilter(fake.url) }, async (base) => {
    const response = await fetch(`${base}/entries`, form({ name: 'Mallory', message: 'Cheap SPAM, no scam' }));
    assert.equal(response.status, 400);
    const page = await response.text();
    assert.match(page, /<p role="alert">The entry holds words the filter refuses: spam, scam\.<\/p>/);
    assert.match(page, /value="Mallory"/);
    assert.match(page, />Cheap SPAM, no scam<\/textarea>/);
  });
  assert.equal((await db.store.list()).length, before);
});

test('with a filter that fails or does not listen, the entry is 503 and not stored: nothing goes in unchecked', async () => {
  const before = (await db.store.list()).length;
  fake.answer = 500;
  await withApp({ filter: createFilter(fake.url) }, async (base) => {
    const response = await fetch(`${base}/entries`, form({ name: 'Ada', message: 'hello' }));
    assert.equal(response.status, 503);
    assert.match(await response.text(), /The filter did not answer\. Try again in a moment\./);
  });
  fake.answer = 'contract';
  await withApp({ filter: createFilter('http://127.0.0.1:1') }, async (base) => {
    assert.equal((await fetch(`${base}/entries`, form({ name: 'Ada', message: 'hello' }))).status, 503);
  });
  assert.equal((await db.store.list()).length, before);
});

test('an invalid form is refused before the filter is called', async () => {
  fake.calls.length = 0;
  await withApp({ filter: createFilter(fake.url) }, async (base) => {
    assert.equal((await fetch(`${base}/entries`, form({ name: '', message: 'spam' }))).status, 400);
  });
  assert.deepEqual(fake.calls, []);
});

test('/health checks the database only: a filter that is down leaves it 200', async () => {
  await withApp({ filter: createFilter('http://127.0.0.1:1') }, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

test('with PROOF_BREAK_HEALTH on, /health is 503 while the database answers, and the page still works', async () => {
  await withApp({ breakHealth: true }, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'broken', reason: 'PROOF_BREAK_HEALTH' });
    assert.equal((await fetch(`${base}/`)).status, 200);
  });
});
