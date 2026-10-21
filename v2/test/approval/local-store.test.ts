import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { LocalTicketStore, TICKET_TABLES } from '../../src/tickets/local-store.ts';
import { DEFAULT_STATES, TicketError } from '../../src/tickets/contract.ts';
import { applyTables } from '../../src/store/db.ts';
import { OWNER, lockBox, scratch } from './harness.ts';

const service = { kind: 'agents' as const, id: 'makhtar' };
const oracle = new URL('./oracle.mjs', import.meta.url).pathname;

function open(options: { signed?: boolean } = {}) {
  const box = lockBox();
  const path = join(box.state, 'ledger.db');
  const db = new DatabaseSync(path);
  applyTables(db, TICKET_TABLES);
  const signer = options.signed === false ? undefined : ApprovalSigner.load(box.keyFile);
  const store = new LocalTicketStore(db, { stateDir: box.state, ownerId: OWNER, ...(signer ? { signer } : {}), publicKey: box.keys.publicKey });
  const v1 = (command: string, ticket: string) => JSON.parse(execFileSync(process.execPath, [oracle, path, box.confFile, command, ticket], { encoding: 'utf8', env: { ...process.env, ORCH_STATE_DIR: box.state } }));
  return { box, db, store, v1 };
}

test('the table statements are the local tracker\'s, one per statement, all IF NOT EXISTS', () => {
  const source = readFileSync(new URL('../../../lib/tracker/adapters/local.mjs', import.meta.url), 'utf8');
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

test('without a signing key a human write is refused, nothing is written', async () => {
  const { store, db } = open({ signed: false });
  await assert.rejects(store.create({ title: 'x', project: 'guestbook' }, { kind: 'human', id: 'u1' }), /signing key/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tracker_tickets').get() as { n: number }).n, 0);
});

test('the store works with no owner set up for agents writes, and refuses humans', async () => {
  const db = new DatabaseSync(':memory:');
  applyTables(db, TICKET_TABLES);
  const store = new LocalTicketStore(db, { stateDir: scratch('cleared-v2-nostate-') });
  assert.equal((await store.create({ title: 'x', project: 'p' }, service)).id, 'LOCAL-1');
  await assert.rejects(store.create({ title: 'y', project: 'p' }, { kind: 'human', id: 'u' }), /signing key/);
});
