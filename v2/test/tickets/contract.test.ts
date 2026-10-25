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

test('histories reads several tickets\' history in one call, each as history reads it; an unknown id is left out', async () => {
  const store = new MemoryTicketStore();
  await store.create({ title: 'One', project: 'guestbook' }, owner);
  await store.create({ title: 'Two', project: 'guestbook' }, owner);
  await store.move('LOCAL-2', 'In Progress', service);
  const read = await store.histories(['LOCAL-1', 'LOCAL-2', 'LOCAL-9']);
  assert.deepEqual([...read.keys()], ['LOCAL-1', 'LOCAL-2']);
  assert.deepEqual(read.get('LOCAL-1'), await store.history('LOCAL-1'));
  assert.deepEqual(read.get('LOCAL-2'), await store.history('LOCAL-2'));
  assert.deepEqual((await store.histories([])).size, 0);
});

test('an edit writes the title or the body, keeps the history of states, and refuses an empty title or an unknown ticket', async () => {
  let clock = 0;
  const store = new MemoryTicketStore({ now: () => new Date(Date.UTC(2026, 9, 25, 10, clock++)).toISOString() });
  await store.create({ title: 'Newest entry first', body: 'Sort the entries.', project: 'guestbook' }, owner);
  const retitled = await store.edit('LOCAL-1', { title: 'Newest entries first' }, service);
  assert.deepEqual([retitled.title, retitled.body, retitled.updatedAt], ['Newest entries first', 'Sort the entries.', '2026-10-25T10:01:00.000Z']);
  const rewritten = await store.edit('LOCAL-1', { body: 'By date, newest first.' }, service);
  assert.deepEqual([rewritten.title, rewritten.body], ['Newest entries first', 'By date, newest first.']);
  assert.deepEqual((await store.history('LOCAL-1')).map((h) => h.status), ['Todo']);
  await assert.rejects(store.edit('LOCAL-1', { title: '  ' }, service), /a ticket needs a title/);
  await assert.rejects(store.edit('LOCAL-9', { body: 'x' }, service), TicketError);
});

test('on the local store, an edit is written in tracker_tickets, and the owner\'s creation row no longer reads as theirs', async () => {
  const { Clock, HUMAN, openStore } = await import('./mirror-support.ts');
  const { store } = openStore(new Clock());
  const ticket = await store.create({ title: 'Newest entry first', body: 'Sort the entries.', project: 'guestbook' }, HUMAN);
  assert.equal((await store.history(ticket.id))[0]?.by.kind, 'human');
  const edited = await store.edit(ticket.id, { title: 'Newest entries first', body: 'By date.' }, { kind: 'agents', id: 'cleared-mirror' });
  assert.deepEqual([edited.title, edited.body], ['Newest entries first', 'By date.']);
  assert.deepEqual([(await store.get(ticket.id))?.title, (await store.get(ticket.id))?.body], ['Newest entries first', 'By date.']);
  assert.deepEqual((await store.history(ticket.id)).map((h) => [h.status, h.by.kind]), [['Todo', 'other']], 'the text is not the one the owner signed');
  await assert.rejects(store.edit(ticket.id, { title: '' }, { kind: 'agents', id: 'cleared-mirror' }), /a ticket needs a title/);
});
