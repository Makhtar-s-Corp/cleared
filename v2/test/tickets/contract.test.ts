import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STATES, MemoryTicketStore, TicketError } from '../../src/tickets/contract.ts';

const service = { kind: 'agents' as const, id: 'cleared-v2' };
const owner = { kind: 'human' as const, id: 'u1' };

test('the six states are the local tracker\'s defaults', () => {
  assert.deepEqual(DEFAULT_STATES, { todo: 'Todo', progress: 'In Progress', review: 'In Review', validate: 'Needs Approval', go: 'Ready to Ship', done: 'Done' });
});

test('a ticket is created in Todo with LOCAL ids, moved with its history, and commented', async () => {
  let clock = 0;
  const store = new MemoryTicketStore({ now: () => new Date(Date.UTC(2026, 9, 21, 10, clock++)).toISOString() });
  const ticket = await store.create({ title: 'Newest entry first', body: 'The guestbook shows the newest entry first.', project: 'guestbook' }, owner);
  assert.deepEqual(ticket, { id: 'LOCAL-1', title: 'Newest entry first', body: 'The guestbook shows the newest entry first.', labels: [], project: 'guestbook', status: 'Todo', createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' });
  assert.equal((await store.create({ title: 'Second', project: 'guestbook' }, owner)).id, 'LOCAL-2');

  const moved = await store.move('LOCAL-1', 'In Progress', service);
  assert.equal(moved.status, 'In Progress');
  assert.deepEqual((await store.history('LOCAL-1')).map((h) => [h.status, h.by.kind, h.by.id]), [['Todo', 'human', 'u1'], ['In Progress', 'agents', 'cleared-v2']]);
  assert.deepEqual((await store.list({ status: 'Todo' })).map((t) => t.id), ['LOCAL-2']);
  assert.deepEqual((await store.list({ project: 'other' })), []);
  assert.equal((await store.list()).length, 2);

  const comment = await store.comment('LOCAL-1', 'Started.', service);
  assert.deepEqual(await store.comments('LOCAL-1'), [comment]);
  assert.equal(await store.get('LOCAL-9'), undefined);
  await assert.rejects(store.move('LOCAL-9', 'Done', service), TicketError);
  await assert.rejects(store.move('LOCAL-1', 'Somewhere', service), /unknown state Somewhere/);
});

test('the go state is never written through move: only the approval writer records it', async () => {
  const store = new MemoryTicketStore();
  await store.create({ title: 'x', project: 'guestbook' }, owner);
  await assert.rejects(store.move('LOCAL-1', DEFAULT_STATES.go, owner), /approval/);
  await assert.rejects(store.move('LOCAL-1', DEFAULT_STATES.go, service), /approval/);
  const approved = await store.recordApproval('LOCAL-1', owner);
  assert.equal(approved.status, 'Ready to Ship');
  await assert.rejects(store.recordApproval('LOCAL-1', service as never), /human/);
});
