import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { LocalTicketStore, TICKET_TABLES } from '../../src/tickets/local-store.ts';
import { DEFAULT_STATES, TicketError } from '../../src/tickets/contract.ts';
import { MemoryUsers } from '../../src/modules/registry.ts';
import { applyTables } from '../../src/store/db.ts';
import { OWNER, lockBox, scratch } from './harness.ts';

const service = { kind: 'agents' as const, id: 'cleared-v2' };
const oracle = new URL('./oracle.ts', import.meta.url).pathname;

function open(options: { signed?: boolean } = {}) {
  const box = lockBox();
  const path = join(box.state, 'ledger.db');
  const db = new DatabaseSync(path);
  applyTables(db, TICKET_TABLES);
  const signer = options.signed === false ? undefined : ApprovalSigner.load(box.keyFile);
  const users = new MemoryUsers();
  users.users.set('user-uuid-1', { id: 'user-uuid-1', name: OWNER });
  users.users.set('user-uuid-2', { id: 'user-uuid-2', name: 'guest' });
  const store = new LocalTicketStore(db, { stateDir: box.state, ownerId: OWNER, users, ...(signer ? { signer } : {}), publicKey: box.keys.publicKey });
  const v1 = (command: string, ticket: string) => JSON.parse(execFileSync(process.execPath, [oracle, path, box.confFile, command, ticket], { encoding: 'utf8', env: { ...process.env, ORCH_STATE_DIR: box.state } }));
  return { box, db, store, v1 };
}

test('the table statements are the local tracker\'s, one per statement, all IF NOT EXISTS', () => {
  const source = readFileSync(new URL('../../../lib/tracker/adapters/local.ts', import.meta.url), 'utf8');
  const schema = /const SCHEMA = `([\s\S]*?)`;/.exec(source)?.[1] ?? '';
  const norm = (text: string) => text.replace(/\s+/g, ' ').replace(/ ?, ?/g, ',').replace(/ ?\( ?/g, '(').replace(/ ?\) ?/g, ')').trim();
  const v1 = schema.split(';').map(norm).filter(Boolean);
  assert.deepEqual(TICKET_TABLES.map(norm).sort(), v1.sort());
  for (const statement of TICKET_TABLES) assert.match(statement, /^\s*CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/i);
});

test('an agents ticket is created in Todo with LOCAL ids, moved, commented, and v1 reads it the same', async () => {
  const { store, v1 } = open();
  const ticket = await store.create({ title: 'Newest entry first', body: 'The guestbook shows the newest entry first.', project: 'guestbook' }, service);
  assert.equal(ticket.id, 'LOCAL-1');
  assert.equal(ticket.status, 'Todo');
  assert.equal((await store.create({ title: 'Second', project: 'guestbook' }, service)).id, 'LOCAL-2');
  assert.equal((await store.move('LOCAL-1', 'In Progress', service)).status, 'In Progress');
  assert.deepEqual((await store.list({ status: 'Todo' })).map((t) => t.id), ['LOCAL-2']);
  assert.equal(await store.get('LOCAL-9'), undefined);
  await assert.rejects(store.move('LOCAL-9', 'Done', service), TicketError);
  await assert.rejects(store.move('LOCAL-1', 'Somewhere', service), /unknown state Somewhere/);
  await assert.rejects(store.move('nonsense', 'Done', service), TicketError);
  const comment = await store.comment('LOCAL-1', 'Started.', service);
  assert.deepEqual(await store.comments('LOCAL-1'), [comment]);

  const seen = v1('ticket', 'LOCAL-1');
  assert.deepEqual([seen.identifier, seen.title, seen.status, seen.project], ['LOCAL-1', 'Newest entry first', 'In Progress', 'guestbook']);
  assert.deepEqual(v1('history', 'LOCAL-1').map((h: { status: string; by: { kind: string } }) => [h.status, h.by.kind]), [['Todo', 'agents'], ['In Progress', 'agents']]);
  assert.deepEqual((await store.history('LOCAL-1')).map((h) => [h.status, h.by.kind]), [['Todo', 'agents'], ['In Progress', 'agents']]);
  assert.deepEqual(v1('comments', 'LOCAL-1').map((c: { body: string; agent: boolean }) => [c.body, c.agent]), [['Started.', true]]);
});

test('the move to the go state is never written through move, whoever asks', async () => {
  const { store } = open();
  await store.create({ title: 'x', project: 'guestbook' }, service);
  await assert.rejects(store.move('LOCAL-1', DEFAULT_STATES.go, service), /approval/);
  await assert.rejects(store.move('LOCAL-1', DEFAULT_STATES.go, { kind: 'human', id: 'u1' }), /approval/);
});

test('a human write is signed, and v1 verifies it as the human; an altered row is "other"', async () => {
  const { store, db, v1 } = open();
  await store.create({ title: 'By the owner', body: 'b', project: 'guestbook' }, { kind: 'human', id: 'user-uuid-1' });
  await store.move('LOCAL-1', 'In Progress', { kind: 'human', id: 'user-uuid-1' });
  const seen = v1('history', 'LOCAL-1');
  assert.deepEqual(seen.map((h: { by: { kind: string; id: string } }) => [h.by.kind, h.by.id]), [['human', OWNER], ['human', OWNER]]);
  assert.deepEqual((await store.history('LOCAL-1')).map((h) => [h.by.kind, h.by.id]), [['human', OWNER], ['human', OWNER]]);

  db.prepare("UPDATE tracker_history SET status = 'Done' WHERE ticket = 1 AND status = 'In Progress'").run();
  assert.deepEqual(v1('history', 'LOCAL-1').map((h: { by: { kind: string } }) => h.by.kind), ['human', 'other'], 'a row changed after it was signed is not the human\'s');
  assert.deepEqual((await store.history('LOCAL-1')).map((h) => h.by.kind), ['human', 'other']);
  db.prepare("UPDATE tracker_tickets SET title = 'Changed' WHERE id = 1").run();
  assert.equal(v1('history', 'LOCAL-1')[0].by.kind, 'other', 'the creation binds the ticket\'s content');
});

test('histories reads several tickets\' history in one query, verified as history verifies it; an unknown id is left out', async () => {
  const { store, db, box } = open();
  await store.create({ title: 'By the owner', project: 'guestbook' }, { kind: 'human', id: 'user-uuid-1' });
  await store.create({ title: 'By the service', project: 'guestbook' }, service);
  await store.move('LOCAL-1', 'In Progress', { kind: 'human', id: 'user-uuid-1' });
  await store.move('LOCAL-2', 'In Progress', service);
  db.prepare("UPDATE tracker_history SET status = 'Done' WHERE ticket = 1 AND status = 'In Progress'").run();
  // A reader opened on the same file counts what it asks of tracker_history.
  let queries = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!/tracker_history/.test(sql)) return statement;
    for (const name of ['all', 'get', 'iterate'] as const) {
      const real = (statement[name] as (...args: unknown[]) => unknown).bind(statement);
      (statement as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { queries++; return real(...args); };
    }
    return statement;
  }) as typeof db.prepare;
  const reader = new LocalTicketStore(db, { stateDir: box.state, ownerId: OWNER, publicKey: box.keys.publicKey });
  const read = await reader.histories(['LOCAL-2', 'LOCAL-1', 'LOCAL-9', 'nonsense']);
  db.prepare = prepare;
  assert.equal(queries, 1, 'one query for every ticket');
  assert.deepEqual([...read.keys()].sort(), ['LOCAL-1', 'LOCAL-2']);
  assert.deepEqual(read.get('LOCAL-1'), await store.history('LOCAL-1'));
  assert.deepEqual(read.get('LOCAL-1')?.map((h) => h.by.kind), ['human', 'other'], 'a signed row is the human\'s, an altered one is not');
  assert.deepEqual(read.get('LOCAL-2'), await store.history('LOCAL-2'));
  assert.equal((await store.histories([])).size, 0);
});

test('only the owner\'s writes are signed as the owner: another user\'s ticket, move and comment never count as his', async () => {
  const { store, v1, db } = open();
  const guest = { kind: 'human' as const, id: 'user-uuid-2' };
  await store.create({ title: 'By a guest', project: 'guestbook' }, guest);
  await store.move('LOCAL-1', 'In Progress', guest);
  await store.comment('LOCAL-1', 'Team 1, please', guest);
  await store.comment('LOCAL-1', 'Team 2, please', { kind: 'human', id: 'user-uuid-1' });
  const history = v1('history', 'LOCAL-1') as { by: { kind: string; id: string } }[];
  assert.deepEqual(history.map((h) => h.by.kind), ['other', 'other'], 'v1 cannot verify a guest\'s row: it is not the human');
  assert.ok(history.every((h) => h.by.id !== OWNER));
  assert.deepEqual((await store.history('LOCAL-1')).map((h) => h.by.kind), ['other', 'other']);
  const comments = v1('comments', 'LOCAL-1') as { body: string; byOwner: boolean }[];
  assert.deepEqual(comments.map((c) => [c.body, c.byOwner]).sort(), [['Team 1, please', false], ['Team 2, please', true]], 'only the owner\'s line counts as his');
  assert.deepEqual((await store.comments('LOCAL-1')).map((c) => [c.body, c.by.kind]), [['Team 1, please', 'other'], ['Team 2, please', 'human']]);
  await assert.rejects(store.create({ title: 'x', project: 'p' }, { kind: 'human', id: 'nobody' }), /unknown user/);
  await assert.rejects(store.recordApproval('LOCAL-1', { by: 'user-uuid-2', requestedAt: 'x', heads: [] }), (error: Error & { code?: string }) => error.code === 'owner');
  await assert.rejects(store.recordApproval('LOCAL-1', { by: 'nobody', requestedAt: 'x', heads: [] }), (error: Error & { code?: string }) => error.code === 'user');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tracker_history WHERE status = ?').get('Ready to Ship') as { n: number }).n, 0);
});

test('without a signing key a human write is refused, nothing is written', async () => {
  const { store, db } = open({ signed: false });
  await assert.rejects(store.create({ title: 'x', project: 'guestbook' }, { kind: 'human', id: 'user-uuid-1' }), /signing key/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tracker_tickets').get() as { n: number }).n, 0);
});

test('the store works with no owner set up for agents writes, and refuses humans', async () => {
  const db = new DatabaseSync(':memory:');
  applyTables(db, TICKET_TABLES);
  const store = new LocalTicketStore(db, { stateDir: scratch('cleared-v2-nostate-') });
  assert.equal((await store.create({ title: 'x', project: 'p' }, service)).id, 'LOCAL-1');
  await assert.rejects(store.create({ title: 'y', project: 'p' }, { kind: 'human', id: 'u' }), /unknown user/);
});
