// The notify module: its table, and a dispatcher that starts with the
// service when a project is set, before any request reaches the API (the
// flow's engine is built on the first request; the notifications do not
// wait for it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifyModule } from '../../src/modules/notify.ts';
import notify from '../../src/modules/notify.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { fakeSender } from './support.ts';

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('the module owns v2_notify_queue and declares no route', () => {
  assert.equal(notify.routes.length, 0);
  assert.ok(notify.tables.some((t) => /^CREATE TABLE IF NOT EXISTS v2_notify_queue \(/.test(t)));
  const store = openStore(':memory:');
  applyTables(store.db, notify.tables);
  store.close();
});

test('without a project the dispatcher does not start', () => {
  const sender = fakeSender();
  const module = createNotifyModule({ env: {}, sender: () => sender, intervalMs: 5 });
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...module.tables]);
  assert.deepEqual(module.provide({ store }), {});
  assert.equal(module.dispatcher(), undefined);
  store.close();
});

test('with a project the dispatcher ticks from the start of the service, with no request to the API', async () => {
  const sender = fakeSender();
  const module = createNotifyModule({ env: { CLEARED_V2_PROJECT: 'guestbook' }, sender: () => sender, intervalMs: 5 });
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...RUNS_TABLES, ...module.tables]);
  assert.deepEqual(module.provide({ store }), {});
  const dispatcher = module.dispatcher();
  assert.ok(dispatcher);
  try {
    // The first tick runs at once and takes note of what exists.
    await until(() => (store.db.prepare("SELECT COUNT(*) AS n FROM v2_notify_queue WHERE kind = 'cursor'").get() as { n: number }).n === 1);
    new InboxStore(store.db).addPermission({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 's1', requestId: 'r1', tool: 'Bash', input: { kind: 'execute', command: 'npm install' },
      suggestion: { decision: 'ask', rule: 'install.package', reason: 'installs a package' } });
    await until(() => sender.sent.length === 1);
    assert.equal(sender.sent[0]?.kind, 'permission');
  } finally {
    await dispatcher.close();
    store.close();
  }
});
