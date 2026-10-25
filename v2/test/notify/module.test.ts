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
import { defaultRegistry } from '../../src/modules/registry.ts';

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

// The heartbeat (docs/v2/milestone-4-plan.md, section 7): its tables are the
// module's, and its beat starts with the service, a project set or not, and
// stops with it.
test('the module owns the heartbeat\'s tables', () => {
  for (const table of ['v2_heartbeat_state', 'v2_heartbeat_incidents']) {
    assert.ok(notify.tables.some((t) => t.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`)), table);
  }
});

test('the beat starts with the service, without a project too, and stops with it', async () => {
  const module = createNotifyModule({ env: {}, sender: () => fakeSender(), heartbeatMs: 10_000 });
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...RUNS_TABLES, ...module.tables]);
  module.provide({ store });
  assert.equal(module.heartbeat(), undefined);
  module.start?.(defaultRegistry());
  try {
    assert.ok(module.heartbeat());
    await until(() => store.db.prepare("SELECT value FROM v2_heartbeat_state WHERE key = 'last_beat_at'").get() !== undefined);
    assert.equal((store.db.prepare("SELECT value FROM v2_heartbeat_state WHERE key = 'monitor'").get() as { value: string }).value, 'off');
  } finally {
    await module.stop?.();
    store.close();
  }
  assert.equal(module.heartbeat(), undefined);
});

test('a bad heartbeat setting is said in one line and the beat stays off', () => {
  const lines: string[] = [];
  const module = createNotifyModule({ env: { CLEARED_V2_HEARTBEAT_SECONDS: '2' }, sender: () => fakeSender(), log: (line) => lines.push(line) });
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...RUNS_TABLES, ...module.tables]);
  module.provide({ store });
  module.start?.(defaultRegistry());
  assert.equal(module.heartbeat(), undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^cleared-v2: the heartbeat is off: CLEARED_V2_HEARTBEAT_SECONDS /);
  store.close();
});
