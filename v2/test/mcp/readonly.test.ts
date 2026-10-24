import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerHistory, openLedgerReadOnly } from '../../src/mcp/history.ts';
import { StoreError } from '../../src/store/db.ts';
import { createRedactor } from '../../src/mcp/redact.ts';
import { createLedgerServer } from '../../src/mcp/server.ts';
import { ENV, SESSIONS, makeLedger } from './support.ts';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('the ledger is opened read only: no write of any kind goes through the connection', () => {
  const fixture = makeLedger();
  const db = openLedgerReadOnly(fixture.path);
  try {
    for (const statement of [
      "INSERT INTO sessions (id, project, ticket, role, harness, model, status, created_at, updated_at) VALUES ('x', 'p', 't', 'author', 'h', 'm', 's', 'a', 'b')",
      "UPDATE sessions SET status = 'failed'",
      'DELETE FROM session_events',
      'CREATE TABLE intruder (id INTEGER)',
      'DROP TABLE sessions',
      'PRAGMA journal_mode = DELETE',
    ]) assert.throws(() => db.exec(statement), Error, statement);
    assert.deepEqual({ ...(db.prepare('PRAGMA query_only').get() as object) }, { query_only: 1 });
    assert.deepEqual({ ...(db.prepare('PRAGMA journal_mode').get() as object) }, { journal_mode: 'wal' }, 'the journal is still the service\'s');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 3);
  } finally {
    db.close();
    fixture.close();
  }
});

test('a whole conversation of tool calls leaves the ledger byte for byte as it was, and copies nothing beside it', async () => {
  const fixture = makeLedger();
  const before = hash(fixture.path);
  const files = readdirSync(fixture.dir).filter((name) => !name.endsWith('-shm') && !name.endsWith('-wal')).sort();
  const db = openLedgerReadOnly(fixture.path);
  const server = createLedgerServer({ history: new LedgerHistory(db, createRedactor({ env: ENV, paths: [fixture.dir] })), language: 'en' });
  try {
    let id = 0;
    const call = (name: string, args: Record<string, unknown>) => server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    await server.handle({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await call('search_sessions', { text: 'shop' });
    await call('search_events', { text: "'); DROP TABLE sessions; --" });
    await call('search_events', { ticket: "LOCAL-7' OR 1=1 --" });
    await call('get_session_timeline', { session_id: SESSIONS.S1 });
    await call('get_session_timeline', { session_id: "x'; DELETE FROM sessions; --" });
  } finally {
    db.close();
  }
  assert.equal(hash(fixture.path), before);
  assert.deepEqual(readdirSync(fixture.dir).filter((name) => !name.endsWith('-shm') && !name.endsWith('-wal')).sort(), files, 'no copy made before a migration, no other file');
  const check = new DatabaseSync(fixture.path, { readOnly: true });
  assert.equal((check.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 3);
  check.close();
  fixture.close();
});

test('a ledger that does not exist is not created, and one without the tables answers empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-none-'));
  try {
    const missing = join(dir, 'state', 'ledger.db');
    assert.throws(() => openLedgerReadOnly(missing), StoreError);
    assert.equal(existsSync(join(dir, 'state')), false, 'no folder made');
    assert.equal(existsSync(missing), false);
    const empty = join(dir, 'empty.db');
    new DatabaseSync(empty).close();
    const db = openLedgerReadOnly(empty);
    const history = new LedgerHistory(db, createRedactor({ env: {}, paths: [] }));
    assert.deepEqual(history.searchSessions({}), { items: [], next: null, partial: false });
    assert.deepEqual(history.searchEvents({ text: 'x' }), { items: [], next: null, partial: false });
    assert.equal(history.timeline(SESSIONS.S1, {}), undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the server offers only reading tools, each marked read only', async () => {
  const fixture = makeLedger();
  const db = openLedgerReadOnly(fixture.path);
  const server = createLedgerServer({ history: new LedgerHistory(db, createRedactor({ env: {}, paths: [] })), language: 'en' });
  const answer = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: { name: string; annotations: Record<string, unknown> }[] } };
  assert.deepEqual(answer.result.tools.map((t) => t.name).sort(), ['get_session_timeline', 'search_events', 'search_sessions']);
  for (const tool of answer.result.tools) assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, tool.name);
  db.close();
  fixture.close();
});
