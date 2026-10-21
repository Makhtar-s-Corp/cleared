import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.ts';
import { testDatabase, type TestDatabase } from './helpers/db.ts';

let db: TestDatabase;

before(async () => {
  db = await testDatabase();
});

after(async () => {
  await db.drop();
});

test('init can run again on an existing table', async () => {
  await db.store.init();
  await db.store.init();
});

test('add returns the stored entry with its id and time', async () => {
  const entry = await db.store.add('Ada', 'Hello from the test');
  assert.equal(typeof entry.id, 'number');
  assert.equal(entry.name, 'Ada');
  assert.equal(entry.message, 'Hello from the test');
  assert.ok(entry.createdAt instanceof Date);
});

test('list gives the entries oldest first', async () => {
  const fresh = await testDatabase();
  try {
    for (const name of ['first', 'second', 'third']) await fresh.store.add(name, `entry ${name}`);
    const names = (await fresh.store.list()).map((entry) => entry.name);
    assert.deepEqual(names, ['first', 'second', 'third']);
  } finally {
    await fresh.drop();
  }
});

test('ping is true while the database answers', async () => {
  assert.equal(await db.store.ping(), true);
});

test('ping is false, quickly, when nothing listens at the address', async () => {
  // Port 1 on loopback: nothing listens there, the connection is refused.
  const down = createStore('postgres://postgres@127.0.0.1:1/postgres', { timeoutMs: 1000 });
  const started = Date.now();
  try {
    assert.equal(await down.ping(), false);
    assert.ok(Date.now() - started < 3000, 'ping must not hang');
  } finally {
    await down.close();
  }
});
