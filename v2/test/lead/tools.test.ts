// The lead's host tools (docs/v2/milestone-2-plan.md, section 3.2), each
// checking what the lead may do: the reading tools, the commitments, the
// messages and answers to the teams' sessions, the handover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadEngine } from '../../src/lead/engine.ts';
import { HostToolRefused, type HostTool } from '../../src/session/contract.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionEvent } from '../../src/session/events.ts';
import { finished, permission, started, text } from '../flow/support.ts';
import { call, leadSetup, opening, say, turn, until, type LeadSetup } from './support.ts';

const tools = (t: LeadSetup, generation = 0): Map<string, HostTool> =>
  new Map((t.generations[generation]?.input.tools ?? []).map((tool) => [tool.name, tool]));
const run = async (t: LeadSetup, name: string, input: unknown): Promise<unknown> => {
  const tool = tools(t).get(name);
  assert.ok(tool, name);
  return tool.handle(input, { sessionId: t.generations[0]?.id as string, turn: 'test' });
};
const refused = async (t: LeadSetup, name: string, input: unknown, pattern: RegExp) => {
  await assert.rejects(run(t, name, input), (error: unknown) => error instanceof HostToolRefused && pattern.test(error.message));
};

const teamQuestion: FakeStep = { question: { requestId: 'question-1', questions: [{ question: 'Which order?', options: [{ label: 'Newest first' }, { label: 'Oldest first' }] }] } };
const asksAQuestion: readonly FakeStep[] = [started, ...text('a1', 'I need to know the order.'), teamQuestion, { awaitMessage: true }, finished(0.2)];
const asksPermission: readonly FakeStep[] = [started, ...text('a1', 'I will create the fixture.'), permission, { awaitMessage: true }, finished(0.2)];

function hostCalls(events: readonly SessionEvent[]) {
  return events.flatMap(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.host_call' ? [event.value] : []);
}

test('message_session and answer_question reach the team\'s fake session; answer_question on a permission is refused and journaled', async () => {
  const ids = { questioner: '', asker: '' };
  const t = await leadSetup({
    scripts: { authors: [asksAQuestion, asksPermission] },
    lead: [[
      ...opening(),
      ...turn('t1',
        call('m1', 'message_session', { get id() { return ids.questioner; }, text: 'Keep the newest-first order of decision 3.' }),
        call('a1', 'answer_question', { get session() { return ids.questioner; }, requestId: 'question-1', answers: [{ question: 'Which order?', answer: 'Newest first' }] }),
        call('p1', 'answer_question', { get session() { return ids.asker; }, requestId: 'request-1', answers: [{ question: 'touch?', answer: 'yes' }] }),
        say('r1', 'I answered the team; the permission waits for you.')),
    ]],
  });
  const second = await t.tickets.create({ title: 'A fixture file', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await t.engine.start(t.ticket.id, 'u1');
  await t.engine.start(second.id, 'u1');
  await until(() => t.inbox.list().filter((i) => i.state === 'waiting').length === 2, 'the two requests');
  ids.questioner = t.startedSessions[0]?.id as string;
  ids.asker = t.startedSessions[1]?.id as string;

  await t.lead.post('Handle what the teams ask', 'u1');
  await until(() => t.lead.messages().some((m) => m.by === 'lead'), 'the reply');
  await t.engine.settled();

  const questioner = t.store.events.after(ids.questioner);
  const fromLead = questioner.find(({ event }) => event.type === 'TEXT_MESSAGE_START' && event.role === 'user' && event.name === 'lead');
  assert.ok(fromLead, 'the message is the lead\'s');
  assert.ok(questioner.some(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta === 'Keep the newest-first order of decision 3.'));
  assert.ok(questioner.some(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.answered' && event.value.requestId === 'question-1' && event.value.by === 'lead'));
  const items = t.inbox.list();
  assert.equal(items.find((i) => i.kind === 'question')?.state, 'handled');
  assert.equal(items.find((i) => i.kind === 'permission')?.state, 'waiting', 'a permission waits for the owner');

  const calls = hostCalls(t.store.events.after(t.generations[0]?.id as string));
  assert.deepEqual(calls.map((c) => `${c.name}:${c.outcome}`), ['message_session:ok', 'answer_question:ok', 'answer_question:refused']);
  assert.match(calls[2]?.message ?? '', /permission/);
  assert.match(calls[2]?.message ?? '', /owner/);
});

test('answer_question refuses a question it does not know, an answer to a question not asked, and the lead\'s own session', async () => {
  const t = await leadSetup({ scripts: { authors: [asksAQuestion] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.state === 'waiting'), 'the question');
  const session = t.startedSessions[0]?.id as string;
  await refused(t, 'answer_question', { session, requestId: 'nope', answers: [{ question: 'Which order?', answer: 'x' }] }, /no question/);
  await refused(t, 'answer_question', { session, requestId: 'question-1', answers: [{ question: 'Which colour?', answer: 'blue' }] }, /Which colour\?/);
  await refused(t, 'answer_question', { session, requestId: 'question-1', answers: [] }, /answer/);
  await refused(t, 'answer_question', { session: t.generations[0]?.id, requestId: 'question-1', answers: [{ question: 'Which order?', answer: 'x' }] }, /team/);
  await refused(t, 'message_session', { id: t.generations[0]?.id, text: 'hello me' }, /team/);
  await refused(t, 'message_session', { id: 'no-such-session', text: 'hello' }, /unknown session/);
  assert.equal(t.inbox.list().find((i) => i.kind === 'question')?.state, 'waiting');
});

test('stop_session is refused while the flow cannot stop a session, and asks the flow when it can', async () => {
  const t = await leadSetup({ scripts: { authors: [asksAQuestion] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.state === 'waiting'), 'the question');
  const session = t.startedSessions[0]?.id as string;
  await refused(t, 'stop_session', { id: session, reason: 'Off plan.' }, /cannot stop/);

  const stops: string[] = [];
  const u = await leadSetup({ scripts: { authors: [asksAQuestion] }, start: false });
  const lead = new LeadEngine({ ...u.deps, flow: { ...u.deps.flow, stopSession: async (id, reason, by) => { stops.push(`${id}:${reason}:${by}`); } } });
  await lead.start();
  await u.engine.start(u.ticket.id, 'u1');
  await until(() => u.inbox.list().some((i) => i.state === 'waiting'), 'the question');
  const target = u.startedSessions[0]?.id as string;
  const tool = (u.generations[0]?.input.tools ?? []).find((x) => x.name === 'stop_session');
  assert.deepEqual(await tool?.handle({ id: target, reason: 'Off plan.' }, { sessionId: u.generations[0]?.id as string, turn: 't' }), { stopped: target });
  assert.deepEqual(stops, [`${target}:Off plan.:lead`]);
});

test('commit and fulfil keep the commitments in the table, and refuse what they cannot keep', async () => {
  const t = await leadSetup();
  const first = await run(t, 'commit', { text: 'Tell the owner when LOCAL-1 lands.', ticket: 'LOCAL-1' }) as { id: string };
  assert.match(first.id, /^c\d+$/);
  const timed = await run(t, 'commit', { text: 'Remind the owner at 08:00.', due: '2026-10-22T08:00:00+02:00' }) as { id: string };
  await refused(t, 'commit', { text: 'Sometime.', due: 'tomorrow morning' }, /ISO 8601/);
  await refused(t, 'commit', { text: 'x'.repeat(301) }, /300/);
  await refused(t, 'commit', { text: '   ' }, /empty/);
  assert.deepEqual(await run(t, 'fulfil', { id: first.id, note: 'Told the owner: 42 minutes.' }), { id: first.id, state: 'done' });
  await refused(t, 'fulfil', { id: first.id, note: 'again' }, /not open/);
  await refused(t, 'fulfil', { id: 'c999', note: 'x' }, /not open/);
  const memory = t.lead.memory();
  assert.deepEqual(memory.commitments.map((c) => `${c.id}:${c.state}`), [`${timed.id}:open`, `${first.id}:done`]);
  assert.equal(memory.commitments[0]?.due, '2026-10-22T06:00:00.000Z');
  assert.equal(memory.commitments[1]?.ticket, 'LOCAL-1');
  assert.equal(memory.commitments[1]?.note, 'Told the owner: 42 minutes.');
  assert.equal(t.lead.state().openCommitments, 1);
  for (let i = 0; i < 19; i++) await run(t, 'commit', { text: `Commitment ${i}.` });
  await refused(t, 'commit', { text: 'One too many.' }, /20 open/);
});

test('handover is accepted once per generation, its summary cut at 4 KB', async () => {
  const t = await leadSetup();
  const answer = await run(t, 'handover', { summary: 'y'.repeat(6000) }) as { id: string };
  assert.ok(answer.id);
  await refused(t, 'handover', { summary: 'twice' }, /once/);
  await t.lead.settled();
});

test('state is the compact state under 2 KB: live sessions with what they wait for, the inbox by kind, the open commitments', async () => {
  const t = await leadSetup({ scripts: { authors: [asksPermission] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.state === 'waiting'), 'the permission');
  await run(t, 'commit', { text: 'Tell the owner when LOCAL-1 lands.' });
  const state = await run(t, 'state', {}) as string;
  assert.ok(Buffer.byteLength(state) <= 2048);
  assert.match(state, new RegExp(`${t.ticket.id} author .*waits for a permission \\(Bash\\)`));
  assert.match(state, /1 permission/);
  assert.match(state, /Tell the owner when LOCAL-1 lands\./);
  assert.doesNotMatch(state, /lead-session|role lead/, 'the lead is not one of the teams');
});

test('ticket answers the title, body, status and last five comments, cleaned; session the last twenty timeline lines, without output', async () => {
  const t = await leadSetup({ scripts: { authors: [asksPermission] }, start: false });
  const lead = new LeadEngine({ ...t.deps, clean: (value) => value.replaceAll('hunter2', '[removed: secret]') });
  await lead.start();
  const ticket = await t.tickets.create({ title: 'Trim names', body: 'Trim names. The password hunter2 must not show.', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  for (let i = 1; i <= 7; i++) await t.tickets.comment(ticket.id, `Comment ${i}`, { kind: 'human', id: 'u1' });
  const tool = (name: string) => (t.generations[0]?.input.tools ?? []).find((x) => x.name === name) as HostTool;
  const ctx = { sessionId: t.generations[0]?.id as string, turn: 't' };
  const text = await tool('ticket').handle({ id: ticket.id }, ctx) as string;
  assert.match(text, /Trim names/);
  assert.match(text, /Todo/);
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /\[removed: secret\]/);
  assert.doesNotMatch(text, /Comment 2\b/);
  for (let i = 3; i <= 7; i++) assert.match(text, new RegExp(`Comment ${i}`));
  await assert.rejects(tool('ticket').handle({ id: 'LOCAL-999' }, ctx), /unknown ticket/);

  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.state === 'waiting'), 'the permission');
  const session = await tool('session').handle({ id: t.startedSessions[0]?.id }, ctx) as string;
  assert.match(session, /author/);
  assert.match(session, /I will create the fixture\./);
  assert.match(session, /permission/);
  assert.ok(session.split('\n').filter((line) => line.startsWith('- ')).length <= 20);
  await assert.rejects(tool('session').handle({ id: 'none' }, ctx), /unknown session/);
});

test('search_memory answers approved decisions first, then the glossary and the lessons, with their ids', async () => {
  const t = await leadSetup({ start: false });
  const lead = new LeadEngine({
    ...t.deps,
    effects: {
      ...t.deps.effects,
    async searchMemory() {
      return [
        { id: 'lesson-1', type: 'lesson', status: 'approved', content: 'Keep tickets small.' },
        { id: 'glossary-entry', type: 'glossary', status: 'approved', content: 'Entry: one message.' },
        { id: 'decision-9', type: 'decision', status: 'proposed', content: 'Maybe pages.' },
        { id: 'decision-3', type: 'decision', status: 'approved', content: 'Newest first.' },
        ];
      },
    },
  });
  await lead.start();
  const tool = (t.generations[0]?.input.tools ?? []).find((x) => x.name === 'search_memory') as HostTool;
  const answer = await tool.handle({ query: 'entries order' }, { sessionId: t.generations[0]?.id as string, turn: 't' }) as string;
  const order = ['decision-3', 'glossary-entry', 'lesson-1'].map((id) => answer.indexOf(id));
  assert.ok(order.every((at) => at >= 0), answer);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(answer, /decision-9/, 'only approved decisions');
  await assert.rejects(tool.handle({ query: '  ' }, { sessionId: 'x', turn: 't' }), /words/);
});

test('a call from a session that is not the live generation is refused', async () => {
  const t = await leadSetup();
  const tool = tools(t).get('commit') as HostTool;
  await assert.rejects(tool.handle({ text: 'From an old generation.' }, { sessionId: 'an-old-session', turn: 't' }), /live generation/);
});
