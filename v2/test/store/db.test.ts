import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerPathError, StoreError, applyTables, ledgerPath, openStore } from '../../src/store/db.ts';

function withDir(run: (dir: string) => void): () => void {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-store-'));
    try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test('the ledger is the one v1 uses: ORCH_LEDGER, then the state directory, then the project name', withDir((dir) => {
  assert.equal(ledgerPath({ ORCH_LEDGER: '/x/ledger.db', CLEARED_STATE_DIR: '/s' }), '/x/ledger.db');
  assert.equal(ledgerPath({ CLEARED_STATE_DIR: '/s', ORCH_STATE_DIR: '/o' }), '/s/ledger.db');
  assert.equal(ledgerPath({ ORCH_STATE_DIR: '/o' }), '/o/ledger.db');
  assert.equal(ledgerPath({ XDG_STATE_HOME: '/state', CLEARED_REPO: '/srv/guestbook' }), '/state/cleared/guestbook/ledger.db');
  assert.equal(ledgerPath({ HOME: '/home/u', ORCH_REPO: '/srv/guestbook/' }), '/home/u/.local/state/cleared/guestbook/ledger.db');
  // The project named for the machine, as v1 reads it.
  const config = join(dir, 'config');
  mkdirSync(join(config, 'cleared'), { recursive: true });
  writeFileSync(join(config, 'cleared', 'project'), '/srv/named\nignored\n');
  assert.equal(ledgerPath({ XDG_STATE_HOME: '/state', XDG_CONFIG_HOME: config }), '/state/cleared/named/ledger.db');
  assert.throws(() => ledgerPath({ XDG_STATE_HOME: '/state', XDG_CONFIG_HOME: join(dir, 'none') }), LedgerPathError);
}));

test('the ledger is opened as lib/ledger.ts opens it: WAL journal, 5 second busy timeout (review round 1, finding 7)', withDir((dir) => {
  const store = openStore(join(dir, 'ledger.db'));
  try {
    assert.deepEqual({ ...(store.db.prepare('PRAGMA journal_mode').get() as object) }, { journal_mode: 'wal' });
    assert.deepEqual({ ...(store.db.prepare('PRAGMA busy_timeout').get() as object) }, { timeout: 5000 });
  } finally {
    store.close();
  }
  const ledger = readFileSync(new URL('../../../lib/ledger.ts', import.meta.url), 'utf8');
  assert.match(ledger, /PRAGMA journal_mode = WAL/);
  assert.match(ledger, /PRAGMA busy_timeout = 5000/);
}));

test('a ledger that cannot be opened is a StoreError naming its path', withDir((dir) => {
  const file = join(dir, 'a-file');
  writeFileSync(file, 'not a directory');
  assert.throws(() => openStore(join(file, 'ledger.db')), (error: unknown) => error instanceof StoreError && error.message.startsWith(`cannot open the ledger at ${join(file, 'ledger.db')}: `));
}));

test('session events get a per-session seq from 1, and are read back after a seq', withDir((dir) => {
  const store = openStore(join(dir, 'ledger.db'));
  try {
    const add = (sessionId: string, stepName: 'author' | 'review') =>
      store.events.append({ at: '2026-10-21T10:00:00.000Z', sessionId, ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'STEP_STARTED', stepName } });
    assert.equal(add('a', 'author').seq, 1);
    assert.equal(add('a', 'review').seq, 2);
    assert.equal(add('b', 'author').seq, 1);
    assert.equal(add('a', 'author').seq, 3);
    assert.deepEqual(store.events.after('a').map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(store.events.after('a', 1).map((e) => e.seq), [2, 3]);
    assert.deepEqual(store.events.after('a', 3), []);
    assert.deepEqual(store.events.after('b')[0], { seq: 1, at: '2026-10-21T10:00:00.000Z', sessionId: 'b', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'STEP_STARTED', stepName: 'author' } });
  } finally {
    store.close();
  }
  // Stored for good: a new process reads the same events and continues the count.
  const again = openStore(join(dir, 'ledger.db'));
  try {
    assert.equal(again.events.after('a').length, 3);
    assert.equal(again.events.append({ at: '2026-10-21T10:01:00.000Z', sessionId: 'a', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'STEP_FINISHED', stepName: 'author' } }).seq, 4);
  } finally {
    again.close();
  }
}));

test('sessions and learned policy rules are kept per project', withDir((dir) => {
  const store = openStore(join(dir, 'ledger.db'));
  try {
    const record = { id: 's1', project: 'guestbook', ticket: 'LOCAL-1', role: 'author' as const, harness: 'claude-code' as const, model: 'claude-opus-5-5', status: 'running', createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' };
    store.sessions.put(record);
    assert.deepEqual(store.sessions.get('s1'), { ...record, service: null, previewKey: null });
    store.sessions.put({ ...record, status: 'stopped', updatedAt: '2026-10-21T11:00:00.000Z' });
    assert.equal(store.sessions.get('s1')?.status, 'stopped');
    assert.deepEqual(store.sessions.list({ ticket: 'LOCAL-1' }).map((s) => s.id), ['s1']);
    assert.deepEqual(store.sessions.list({ ticket: 'LOCAL-2' }), []);
    assert.equal(store.sessions.get('none'), undefined);

    store.policyRules.learn({ project: 'guestbook', tool: 'Bash', pattern: 'make build', by: 'u1', at: '2026-10-21T10:00:00.000Z' });
    store.policyRules.learn({ project: 'guestbook', tool: 'Bash', pattern: 'make build', by: 'u2', at: '2026-10-21T10:05:00.000Z' });
    store.policyRules.learn({ project: 'other', tool: 'Bash', pattern: 'make *', by: 'u1', at: '2026-10-21T10:00:00.000Z' });
    assert.deepEqual(store.policyRules.learned('guestbook'), [{ tool: 'Bash', pattern: 'make build' }]);
  } finally {
    store.close();
  }
}));

test('opening the store keeps the tables already in the ledger, and module tables are created once', withDir((dir) => {
  const path = join(dir, 'ledger.db');
  const v1 = new DatabaseSync(path);
  v1.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('r1');");
  v1.close();
  const store = openStore(path);
  try {
    const table = 'CREATE TABLE IF NOT EXISTS demo_rows (id INTEGER PRIMARY KEY)';
    applyTables(store.db, [table]);
    applyTables(store.db, [table]);
    const names = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const name of ['runs', 'session_events', 'sessions', 'policy_rules', 'demo_rows']) assert.ok(names.includes(name), name);
    assert.deepEqual(store.db.prepare('SELECT run_id FROM runs').all().map((r) => ({ ...r })), [{ run_id: 'r1' }]);
    assert.throws(() => applyTables(store.db, ['CREATE TABLE runs (x)']), /IF NOT EXISTS/);
  } finally {
    store.close();
  }
}));
