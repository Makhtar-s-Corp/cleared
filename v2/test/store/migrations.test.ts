// The versioned migrations of the store (milestone 2, lane 14, decision 19),
// run on a ledger made by the milestone 2 schema (fixtures/ledger-m2.sql).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import approval from '../../src/modules/approval.ts';
import flow from '../../src/modules/flow.ts';
import inbox from '../../src/modules/inbox.ts';
import lead from '../../src/modules/lead.ts';
import notify from '../../src/modules/notify.ts';
import sessions from '../../src/modules/sessions.ts';
import tickets, { recordWorkspaceOf } from '../../src/modules/tickets.ts';
import users from '../../src/modules/users.ts';
import { StoreError, applyTables, openStore } from '../../src/store/db.ts';
import { MIGRATIONS, MigrationError, migrate, type Migration } from '../../src/store/migrations.ts';

const FIXTURE = readFileSync(new URL('./fixtures/ledger-m2.sql', import.meta.url), 'utf8');
const ALL_TABLES = [sessions, users, tickets, flow, approval, inbox, lead, notify].flatMap((module) => module.tables);
const ENV = {
  CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git',
  CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state',
};
const LATEST = MIGRATIONS.at(-1)!.version;

function withDir(run: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-migrate-'));
    try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

// A ledger file made by the milestone 2 schema, with its rows.
function fixtureLedger(dir: string): string {
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(FIXTURE);
  db.close();
  return path;
}

type Rows = Record<string, Record<string, unknown>[]>;

// Every table's rows, in rowid order, each row as a plain object.
function rows(db: DatabaseSync, only?: Record<string, string[]>): Rows {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const out: Rows = {};
  for (const table of tables) {
    if (only && !only[table]) continue;
    const columns = only ? only[table]!.map((c) => `"${c}"`).join(', ') : '*';
    out[table] = (db.prepare(`SELECT ${columns} FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[]).map((row) => ({ ...row }));
  }
  return out;
}

const columnsOf = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
const schemaOf = (db: DatabaseSync) => (db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() as Record<string, unknown>[]).map((r) => ({ ...r }));

function readFile(path: string, run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try { run(db); } finally { db.close(); }
}

// What the service does at its start, without listening: main.ts opens the
// store and creates the modules' tables, then assembles the modules, whose
// tickets module writes the workspace's rows.
function start(path: string, env: NodeJS.ProcessEnv = ENV): void {
  const store = openStore(path);
  try {
    applyTables(store.db, ALL_TABLES);
    recordWorkspaceOf(store.db, env, () => '2026-10-23T08:00:00.000Z');
  } finally {
    store.close();
  }
}

const backups = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('ledger.db.before-'));

test('a milestone 2 ledger is migrated: versions recorded, a backup with the same rows, old rows intact, new columns empty, the workspace row written, and a second start changes nothing', withDir((dir) => {
  const path = fixtureLedger(dir);
  let before: Rows = {};
  let oldColumns: Record<string, string[]> = {};
  readFile(path, (db) => {
    before = rows(db);
    oldColumns = Object.fromEntries(Object.keys(before).map((table) => [table, columnsOf(db, table)]));
  });
  assert.ok(before.sessions!.length >= 3 && before.session_events!.length >= 4 && before.tracker_tickets!.length >= 2 && before.plans!.length >= 1 && before.flow_inbox!.length >= 2, 'the fixture has rows to keep');

  start(path);

  // The backup: one copy, named by the first version and the time, 0600, holding the rows as they were.
  const copies = backups(dir);
  assert.equal(copies.length, 1);
  assert.match(copies[0]!, /^ledger\.db\.before-1-\d{8}T\d{6}\d{3}Z$/);
  assert.equal(statSync(join(dir, copies[0]!)).mode & 0o777, 0o600);
  readFile(join(dir, copies[0]!), (db) => {
    assert.deepEqual(rows(db), before);
    assert.equal(columnsOf(db, 'sessions').includes('service'), false, 'the copy is the ledger before the migration');
  });

  readFile(path, (db) => {
    assert.deepEqual((db.prepare('SELECT version FROM v2_schema ORDER BY version').all() as { version: number }[]).map((r) => r.version), MIGRATIONS.map((m) => m.version));
    // Every old row, read with the old columns, is the same.
    assert.deepEqual(rows(db, oldColumns), before);
    // The new columns exist and are empty on the old rows.
    for (const [table, added] of [['sessions', ['service', 'preview_key']], ['session_events', ['service']], ['flow_inbox', ['service', 'step']]] as const) {
      for (const column of added) {
        assert.ok(columnsOf(db, table).includes(column), `${table}.${column}`);
        assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL`).get() as { n: number }).n, 0, `${table}.${column} is null on old rows`);
      }
    }
    // The one-service workspace names the project; the old rows' project is its id.
    assert.deepEqual({ ...db.prepare('SELECT id, name FROM workspaces').get() as object }, { id: 'guestbook', name: 'guestbook' });
    assert.deepEqual(db.prepare('SELECT workspace, name, kind, repo, base FROM services').all().map((r) => ({ ...r })), [{ workspace: 'guestbook', name: 'guestbook', kind: 'repository', repo: 'example-org/cleared-example-guestbook', base: 'main' }]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tracker_tickets WHERE project IS NOT ? ').get('guestbook') as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ticket_services').get() as { n: number }).n, 0);
  });

  // A second start: nothing changes, and no second copy is written.
  let first: unknown;
  readFile(path, (db) => { first = [schemaOf(db), rows(db)]; });
  start(path);
  readFile(path, (db) => { assert.deepEqual([schemaOf(db), rows(db)], first); });
  assert.equal(backups(dir).length, 1);
}));

test('the v1 reader of the tracker tables (lib/tracker/adapters/local.mjs) still lists the tickets of a migrated ledger', withDir((dir) => {
  const path = fixtureLedger(dir);
  start(path);
  const listed = JSON.parse(execFileSync(process.execPath, [new URL('./v1-list.mjs', import.meta.url).pathname, path], { encoding: 'utf8' })) as { id: string; title: string; status: string; project: string }[];
  // v1 names a local ticket by its number.
  assert.deepEqual(listed.map((t) => [t.id, t.title, t.status, t.project]), [
    ['1', 'Newest entry first', 'In Review', 'guestbook'],
    ['2', 'Pages of 20 entries', 'Todo', 'guestbook'],
  ]);
}));

test('a migration that throws leaves the ledger as it was, and is reported as a StoreError naming it', withDir((dir) => {
  const path = fixtureLedger(dir);
  const db = new DatabaseSync(path);
  try {
    const before = [schemaOf(db), rows(db)];
    const failing: Migration[] = [{
      version: 1, name: 'adds a column, then fails', tables: ['sessions'],
      up(target) {
        target.exec('ALTER TABLE sessions ADD COLUMN half_done TEXT');
        target.exec("UPDATE sessions SET status = 'changed'");
        throw new Error('planted failure');
      },
    }];
    assert.throws(() => migrate(db, failing), (error: unknown) =>
      error instanceof MigrationError && error instanceof StoreError && /migration 1 \(adds a column, then fails\) failed: planted failure/.test(error.message) && /left as it was/.test(error.message));
    // Nothing is left, v2_schema included: it is created in the migration's transaction (review round 1, followup 1).
    assert.deepEqual([schemaOf(db), rows(db)], before);
    assert.equal(columnsOf(db, 'sessions').includes('half_done'), false);
  } finally {
    db.close();
  }
}));

test('a migration that throws at the start stops the process with exit 64 and the message, and the ledger stays as it was', withDir((dir) => {
  const path = fixtureLedger(dir);
  let before: unknown;
  readFile(path, (db) => { before = [schemaOf(db), rows(db)]; });
  const result = spawnSync(process.execPath, [new URL('./failing-start.ts', import.meta.url).pathname, path], { encoding: 'utf8' });
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, new RegExp(`^cleared-v2: migration ${LATEST + 1} \\(planted\\) failed: planted failure; the ledger is left as it was`, 'm'));
  // The real migrations ran before the planted one, each in its own
  // transaction; the planted one left nothing.
  readFile(path, (db) => {
    assert.deepEqual((db.prepare('SELECT version FROM v2_schema ORDER BY version').all() as { version: number }[]).map((r) => r.version), MIGRATIONS.map((m) => m.version));
    assert.equal(columnsOf(db, 'sessions').includes('planted'), false);
    const old = before as [unknown, Rows];
    assert.deepEqual(rows(db, Object.fromEntries(Object.keys(old[1]).map((t) => [t, columnsOf(db, t).filter((c) => !['service', 'preview_key', 'step'].includes(c))]))), old[1]);
  });
}));

test('a fresh ledger: the migrations wait for their tables, run after applyTables creates them, and the workspace row is written; no copy of an empty ledger is kept', withDir((dir) => {
  const path = join(dir, 'ledger.db');
  const store = openStore(path);
  try {
    // openStore makes its own tables and migrates them; flow_inbox does not exist yet.
    assert.deepEqual((store.db.prepare('SELECT version FROM v2_schema').all() as { version: number }[]).map((r) => r.version), [1]);
    assert.ok(columnsOf(store.db, 'sessions').includes('preview_key'));
    // A caller that creates only some tables (the app, the user command) does not record what it could not do.
    applyTables(store.db, users.tables);
    assert.deepEqual((store.db.prepare('SELECT version FROM v2_schema').all() as { version: number }[]).map((r) => r.version), [1]);
    applyTables(store.db, ALL_TABLES);
    assert.deepEqual((store.db.prepare('SELECT version FROM v2_schema').all() as { version: number }[]).map((r) => r.version), [1, 2, 3]);
    assert.ok(columnsOf(store.db, 'flow_inbox').includes('service') && columnsOf(store.db, 'flow_inbox').includes('step'));
    recordWorkspaceOf(store.db, ENV, () => '2026-10-23T08:00:00.000Z');
    assert.deepEqual({ ...store.db.prepare('SELECT id, name, created_at FROM workspaces').get() as object }, { id: 'guestbook', name: 'guestbook', created_at: '2026-10-23T08:00:00.000Z' });
    // A start with no project configured writes no workspace.
    recordWorkspaceOf(store.db, {}, () => '2026-10-23T09:00:00.000Z');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n, 1);
  } finally {
    store.close();
  }
  assert.deepEqual(backups(dir), []);
}));

test('a ledger migrated by a newer Cleared is refused, not used', withDir((dir) => {
  const path = fixtureLedger(dir);
  start(path);
  readFile(path, (db) => { db.prepare('INSERT INTO v2_schema (version, applied_at) VALUES (?, ?)').run(LATEST + 1, '2026-10-30T00:00:00.000Z'); });
  assert.throws(() => openStore(path), (error: unknown) => error instanceof StoreError && new RegExp(`version ${LATEST + 1}.*newer`).test(error.message));
}));

test('the migration list is ordered, numbered from 1 without a gap, and each names the tables it needs', () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.version), MIGRATIONS.map((_, i) => i + 1));
  for (const migration of MIGRATIONS) assert.ok(migration.tables.length > 0 && migration.name.length > 0, String(migration.version));
});

test('a session keeps its service and its preview key, and its events carry the service', withDir((dir) => {
  const store = openStore(join(dir, 'ledger.db'));
  try {
    const at = '2026-10-23T08:00:00.000Z';
    store.sessions.put({ id: 's1', project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'working', createdAt: at, updatedAt: at, service: 'filter-api', previewKey: 'k'.repeat(32) });
    // A later put without them (the engine's status updates) keeps them.
    store.sessions.put({ id: 's1', project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'stopped', createdAt: at, updatedAt: at });
    const row = store.sessions.get('s1');
    assert.equal(row?.status, 'stopped');
    assert.equal(row?.service, 'filter-api');
    assert.equal(row?.previewKey, 'k'.repeat(32));
    store.sessions.put({ id: 's2', project: 'guestbook', ticket: 'LOCAL-1', role: 'reviewer', harness: 'claude-code', model: 'claude-sonnet-5-5', status: 'working', createdAt: at, updatedAt: at });
    assert.equal(store.sessions.get('s2')?.service, null);
    assert.equal(store.sessions.get('s2')?.previewKey, null);
    store.events.append({ at, sessionId: 's1', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'STEP_STARTED', stepName: 'author' } });
    store.events.append({ at, sessionId: 's2', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'STEP_STARTED', stepName: 'review' } });
    assert.deepEqual(store.db.prepare('SELECT session_id, service FROM session_events ORDER BY session_id').all().map((r) => ({ ...r })), [{ session_id: 's1', service: 'filter-api' }, { session_id: 's2', service: null }]);
  } finally {
    store.close();
  }
}));

test('the copy is a new file the store creates private: a file already at its name is refused, and nothing is migrated (review round 1, followups 4 and 5)', withDir((dir) => {
  chmodSync(dir, 0o755);
  const path = fixtureLedger(dir);
  const at = new Date('2026-10-23T08:00:00.123Z');
  // Someone else's file, made before the copy, empty and readable by all.
  const target = `${path}.before-1-20261023T080000123Z`;
  writeFileSync(target, '', { mode: 0o644 });
  chmodSync(target, 0o644);
  const db = new DatabaseSync(path);
  try {
    const before = [schemaOf(db), rows(db)];
    assert.throws(() => migrate(db, MIGRATIONS, () => at), (error: unknown) => error instanceof MigrationError && /cannot copy the ledger before migration 1/.test(error.message) && /nothing was migrated/.test(error.message));
    assert.deepEqual([schemaOf(db), rows(db)], before, 'nothing was migrated, v2_schema not even made');
    assert.equal(statSync(target).size, 0, 'the ledger was not written into a file the store did not make');
    // Once that name is free, the copy is made, 0600 from its creation.
    rmSync(target);
    const previous = process.umask(0);
    try { migrate(db, MIGRATIONS, () => at); } finally { process.umask(previous); }
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.ok(statSync(target).size > 0);
  } finally {
    db.close();
  }
}));
