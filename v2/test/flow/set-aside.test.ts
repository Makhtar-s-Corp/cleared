// Set aside (POST /api/tickets/:id/set-aside): the owner takes a ticket out
// of the flow without starting it again. The multi-service proof sets its
// earlier runs' tickets aside so that each run starts with nothing of
// theirs open (scripts/proof-base.ts).
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

test('a running ticket set aside: its session stopped, everything of it that waited settled, Todo, and no session started again', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const session = t.startedSessions[0]?.id as string;
  assert.equal(t.store.sessions.get(session)?.status, 'working');
  t.inbox.addPermission({ ticket: t.ticket.id, project: 'guestbook', sessionId: session, requestId: 'r1', tool: 'Bash', input: { kind: 'execute', command: 'npm test' }, suggestion: { decision: 'ask', rule: 'default', reason: 'x' } });
  t.inbox.addKnowledge({ ticket: t.ticket.id, project: 'guestbook', sessionId: session, text: 'Entries are read newest first.', level: 'service', service: 'guestbook' });
  const other = await t.tickets.create({ title: 'Another', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  t.inbox.addKnowledge({ ticket: other.id, project: 'guestbook', sessionId: 's-other', text: 'Not this ticket\'s.', level: 'service', service: 'guestbook' });

  const result = await t.engine.setAside(t.ticket.id, 'u1');

  // The permission goes with its session's stop; the knowledge item is settled after.
  assert.deepEqual(result, { sessions: 1, items: 1 });
  assert.equal(t.inbox.waitingFor(session), 0);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.equal(t.store.sessions.get(session)?.status, 'stopped');
  assert.equal(t.engine.isActive(t.ticket.id), false);
  assert.deepEqual(t.inbox.items().filter((i) => i.state === 'waiting').map((i) => i.ticket), [other.id], 'only the other ticket\'s item still waits');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /set this ticket aside/);
  const putBack = t.flowEvents.filter((e) => e.type === 'ticket_put_back');
  assert.deepEqual(putBack.map((e) => e.type === 'ticket_put_back' && e.reason), ['set_aside']);
  const last = t.store.events.after(session).filter((e) => e.event.type === 'RUN_ERROR').at(-1)?.event;
  assert.equal(last?.type === 'RUN_ERROR' ? last.code : undefined, 'set_aside');
  // Nothing starts it again: a move to Todo would have.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(t.startedSessions.length, 1);
});

test('a ticket waiting for its approval set aside: its release card settled, Todo', async () => {
  const t = await setup();
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  const card = t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  assert.equal(t.inbox.waitingRelease(t.ticket.id)?.id, card.id);
  const result = await t.engine.setAside(t.ticket.id, 'u1');
  assert.deepEqual(result, { sessions: 0, items: 1 });
  assert.equal(t.inbox.waitingRelease(t.ticket.id), undefined);
  assert.equal(t.inbox.item(card.id)?.state, 'handled');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
});

test('a ticket already in Todo with something left waiting: settled, still in Todo, not started', async () => {
  const t = await setup();
  t.inbox.addKnowledge({ ticket: t.ticket.id, project: 'guestbook', sessionId: 's-old', text: 'A lesson of an earlier run.', level: 'service', service: 'guestbook' });
  assert.deepEqual(await t.engine.setAside(t.ticket.id, 'u1'), { sessions: 0, items: 1 });
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.equal(t.startedSessions.length, 0);
  assert.equal(t.flowEvents.filter((e) => e.type === 'ticket_put_back').length, 0, 'no move: it was in Todo');
});

test('an approved ticket, another project\'s and an unknown one are refused, and nothing is changed', async () => {
  const t = await setup();
  const done = await t.tickets.create({ title: 'Done', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await t.tickets.move(done.id, 'Done', agents);
  const elsewhere = await t.tickets.create({ title: 'Elsewhere', project: 'elsewhere' }, { kind: 'human', id: 'u1' });
  const approved = await t.tickets.create({ title: 'Approved', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await t.tickets.move(approved.id, 'Needs Approval', agents);
  await t.tickets.recordApproval(approved.id, { kind: 'human', id: 'u1' });
  const refused = async (id: string, kind: FlowError['kind']) => {
    await assert.rejects(t.engine.setAside(id, 'u1'), (error: unknown) => error instanceof FlowError && error.kind === kind);
  };
  await refused(elsewhere.id, 'not_found');
  await refused('LOCAL-999', 'not_found');
  await refused(approved.id, 'conflict');
  assert.equal((await t.tickets.get(approved.id))?.status, 'Ready to Ship');
});

test('a done ticket with a knowledge item still waiting: the item settled, the ticket left Done and not moved', async () => {
  const t = await setup();
  await t.tickets.move(t.ticket.id, 'Done', agents);
  t.inbox.addKnowledge({ ticket: t.ticket.id, project: 'guestbook', sessionId: 's-author', text: 'A lesson the handover proposed.', level: 'service', service: 'guestbook' });
  assert.deepEqual(await t.engine.setAside(t.ticket.id, 'u1'), { sessions: 0, items: 1 });
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Done');
  assert.equal(t.inbox.items().filter((i) => i.state === 'waiting').length, 0);
  assert.equal(t.flowEvents.filter((e) => e.type === 'ticket_put_back').length, 0);
  assert.equal(t.startedSessions.length, 0);
});

test('set aside with words of its own (a person\'s move on a tracker, P231): the ticket\'s note and the session\'s message are those words', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const session = t.startedSessions[0]?.id as string;
  const words = { note: 'Jane a déplacé ce ticket sur Linear.', message: 'Jane a déplacé le ticket sur Linear : cette session est arrêtée.' };
  assert.deepEqual(await t.engine.setAside(t.ticket.id, 'cleared-mirror', words), { sessions: 1, items: 0 });
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.equal((await t.tickets.comments(t.ticket.id)).at(-1)?.body, words.note);
  const last = t.store.events.after(session).filter((e) => e.event.type === 'RUN_ERROR').at(-1)?.event;
  assert.equal(last?.type === 'RUN_ERROR' ? last.message : undefined, words.message);
});
