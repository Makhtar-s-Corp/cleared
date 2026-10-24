// Close (POST /api/tickets/:id/close, issue #249): the owner closes a ticket
// that should never ship, with a reason. It is set aside (P61's service
// side) and also says why: the release card is handled with an outcome that
// keeps the reason, who and when, and nothing is merged or deployed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowError } from '../../src/flow/engine.ts';
import { setup } from './support.ts';

const agents = { kind: 'agents', id: 'cleared-v2' } as const;
const release = (ticket: string, requestedAt: string) => ({
  ticket, project: 'guestbook', title: 'Newest entry first', announcement: 'The list shows the newest entry first.', requestedAt,
  pr: { number: 101, url: 'https://example.invalid/pull/101', checks: 'passed' as const }, heads: [{ pr: 101, head: 'a'.repeat(40) }],
  captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
});
const refused = async (promise: Promise<unknown>, kind: FlowError['kind']) =>
  assert.rejects(promise, (error: unknown) => error instanceof FlowError && error.kind === kind);

test('a ticket waiting for its approval closed: the card is handled with the reason, who and when; Todo; nothing merged', async () => {
  const t = await setup();
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  const card = t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  const result = await t.engine.closeTicket(t.ticket.id, '  A rehearsal ticket of a proof run.  ', 'u1');
  assert.deepEqual(result, { sessions: 0, items: 1 });
  const settled = t.inbox.item(card.id);
  assert.equal(settled?.state, 'handled');
  assert.deepEqual(settled?.kind === 'release' ? settled.outcome : undefined, { decision: 'close', reason: 'A rehearsal ticket of a proof run.', by: 'u1', at: new Date(t.clock.now).toISOString() });
  assert.equal(t.inbox.waitingRelease(t.ticket.id), undefined);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /closed this ticket.*A rehearsal ticket of a proof run\./);
  assert.deepEqual(t.flowEvents.filter((e) => e.type === 'ticket_put_back').map((e) => e.type === 'ticket_put_back' && e.reason), ['closed']);
  assert.equal(t.calls.some((c) => c.startsWith('mergeRelease')), false, 'a close never merges');
  assert.equal(t.startedSessions.length, 0);
});

test('a running ticket closed: its session stopped under its own code, no session started again', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const session = t.startedSessions[0]?.id as string;
  const result = await t.engine.closeTicket(t.ticket.id, 'Not needed any more.', 'u1');
  assert.deepEqual(result, { sessions: 1, items: 0 });
  assert.equal(t.store.sessions.get(session)?.status, 'stopped');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  const last = t.store.events.after(session).filter((e) => e.event.type === 'RUN_ERROR').at(-1)?.event;
  assert.equal(last?.type === 'RUN_ERROR' ? last.code : undefined, 'closed');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(t.startedSessions.length, 1);
});

test('a reason is mandatory: empty, blank and too long ones are refused, and nothing is changed', async () => {
  const t = await setup();
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  const card = t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  await refused(t.engine.closeTicket(t.ticket.id, '', 'u1'), 'invalid');
  await refused(t.engine.closeTicket(t.ticket.id, '   \n ', 'u1'), 'invalid');
  await refused(t.engine.closeTicket(t.ticket.id, 'x'.repeat(2001), 'u1'), 'invalid');
  assert.equal(t.inbox.item(card.id)?.state, 'waiting');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Needs Approval');
});

test('an approved ticket, a done one, another project\'s and an unknown one are refused', async () => {
  const t = await setup();
  const done = await t.tickets.create({ title: 'Done', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await t.tickets.move(done.id, 'Done', agents);
  const elsewhere = await t.tickets.create({ title: 'Elsewhere', project: 'elsewhere' }, { kind: 'human', id: 'u1' });
  const approved = await t.tickets.create({ title: 'Approved', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await t.tickets.move(approved.id, 'Needs Approval', agents);
  await t.tickets.recordApproval(approved.id, { kind: 'human', id: 'u1' });
  await refused(t.engine.closeTicket(elsewhere.id, 'why', 'u1'), 'not_found');
  await refused(t.engine.closeTicket('LOCAL-999', 'why', 'u1'), 'not_found');
  await refused(t.engine.closeTicket(approved.id, 'why', 'u1'), 'conflict');
  await refused(t.engine.closeTicket(done.id, 'why', 'u1'), 'conflict');
  assert.equal((await t.tickets.get(approved.id))?.status, 'Ready to Ship');
  assert.equal((await t.tickets.get(done.id))?.status, 'Done');
});

test('set aside is as it was: the card is handled without an outcome, the reason stays set_aside', async () => {
  const t = await setup();
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  const card = t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  await t.engine.setAside(t.ticket.id, 'u1');
  const settled = t.inbox.item(card.id);
  assert.equal(settled?.state, 'handled');
  assert.equal(settled?.kind === 'release' ? settled.outcome : 'x', undefined);
  assert.deepEqual(t.flowEvents.filter((e) => e.type === 'ticket_put_back').map((e) => e.type === 'ticket_put_back' && e.reason), ['set_aside']);
});
