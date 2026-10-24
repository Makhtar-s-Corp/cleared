// The lead engine on the fake adapter (docs/v2/milestone-2-plan.md, section
// 4 and lane 5): the thread, the question, the commitments, the handover at
// the handover point, the interrupt at the threshold, the machine handover,
// the restart, timed commitments, the event batch and the idle rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_TICKET } from '../../src/lead/contract.ts';
import { LeadEngine, LeadError } from '../../src/lead/engine.ts';
import { exampleLeadScript } from '../../src/session/adapters/fake.ts';
import type { SessionEvent } from '../../src/session/events.ts';
import {
  call, context, flowEvent, handsOver, leadSetup, opening, question, say, sentTo, turn, until, type LeadSetup,
} from './support.ts';

const customs = (t: LeadSetup, id: string, name: string): SessionEvent[] =>
  t.store.events.after(id).filter(({ event }) => event.type === 'CUSTOM' && event.name === name);
const cancelledRuns = (t: LeadSetup, id: string) =>
  t.store.events.after(id).filter(({ event }) => event.type === 'RUN_FINISHED' && event.outcome.type === 'cancelled');
const threadTexts = (t: LeadSetup) => t.lead.messages().map((m) => `${m.by}:${m.kind}:${m.text}`);
const replied = (t: LeadSetup, text: string) => until(() => t.lead.messages().some((m) => m.by === 'lead' && m.text === text), `the reply "${text}"`);

test('a generation starts at once: a lead session in its own row, the briefing written, the opening turn sent from cleared', async () => {
  const t = await leadSetup();
  await t.lead.settled();
  assert.equal(t.generations.length, 1);
  const [gen] = t.generations;
  assert.ok(gen);
  assert.equal(gen.input.role, 'lead');
  assert.equal(gen.input.ticket, LEAD_TICKET);
  assert.equal(gen.input.model, 'claude-opus-5-5');
  assert.equal(gen.input.workdir, '/work/lead');
  assert.equal(gen.input.policy.role, 'lead');
  assert.deepEqual(gen.input.services ?? [], []);
  assert.deepEqual((gen.input.tools ?? []).map((tool) => tool.name),
    ['state', 'ticket', 'session', 'search_memory', 'stop_session', 'message_session', 'answer_question', 'commit', 'fulfil', 'tell_owner', 'handover']);
  assert.match(gen.input.prompt, /generation 1/);
  assert.equal(t.briefings.length, 1);
  assert.match(t.briefings[0] ?? '', /The guestbook: one page/);
  const row = t.store.sessions.get(gen.id);
  assert.equal(row?.role, 'lead');
  assert.equal(row?.ticket, LEAD_TICKET);
  const state = t.lead.state();
  assert.equal(state.generation, 1);
  assert.equal(state.sessionId, gen.id);
  assert.equal(state.phase, 'idle');
  assert.equal(state.refreshCount, 0);
  assert.equal(state.refreshedAt, null);
  assert.deepEqual(state.context, { percent: 8, totalTokens: 16000, maxTokens: 200_000 });
  assert.equal(state.highestPercent, 8);
  assert.equal(t.lead.messages().length, 0, 'the opening turn writes nothing in the thread');
});

test('the thread, a question answered from the reply, a commitment, and the handover at the end of the turn that crosses 40 %', async () => {
  const commitment = 'When the first ticket of the plan lands, tell the owner how long it took from start to live.';
  const t = await leadSetup({
    lead: [
      [
        ...opening(8),
        ...turn('t1', say('r1', 'Hello, I am the lead of the guestbook.'), context(15)),
        ...turn('t2', question('q1', 'On desktop, pages of 20 or one long list?'), call('t2-commit', 'commit', { text: commitment }), say('r2', 'Understood: pages of 20.'), context(30)),
        ...turn('t3', say('r3', 'The plan comes next.'), context(42)),
        ...handsOver('t4', 'The owner wants pages of 20 and short answers. I was about to propose the plan.'),
      ],
      [...opening(10), ...turn('g2t1', say('g2r1', 'I remember the commitment.'))],
    ],
  });
  await t.lead.post('Hello', 'u1');
  await replied(t, 'Hello, I am the lead of the guestbook.');

  const goal = await t.lead.post('Make a long guestbook readable', 'u1', true);
  await until(() => t.lead.state().pendingQuestion !== null, 'the question');
  const gen1 = t.generations[0]?.id as string;
  assert.ok(sentTo(t.store.events, gen1).some((text) => text.includes(`goal-${goal.seq}`) && text.includes('Make a long guestbook readable')), 'the goal turn names its goal id');
  const asked = t.lead.messages().find((m) => m.kind === 'question');
  assert.equal(asked?.question?.state, 'waiting');
  assert.equal(asked?.question?.requestId, 'q1');
  const item = t.inbox.list().find((i) => i.kind === 'question');
  assert.equal(item?.ticket, LEAD_TICKET);
  assert.equal(item?.state, 'waiting');

  // The reply field answers the pending question (decision 8).
  await t.lead.post('Pages of 20', 'u1');
  await replied(t, 'Understood: pages of 20.');
  assert.equal(t.lead.state().pendingQuestion, null);
  assert.equal(t.lead.messages().find((m) => m.kind === 'question')?.question?.state, 'handled');
  assert.equal(t.inbox.list().find((i) => i.kind === 'question')?.state, 'handled');
  assert.equal(customs(t, gen1, 'cleared.answered').length, 1);
  assert.equal(t.lead.state().openCommitments, 1);

  await t.lead.post('Thanks', 'u1');
  await until(() => t.lead.state().generation === 2 && t.lead.state().phase === 'idle', 'the second generation');
  await t.lead.settled();

  // The handover was asked at the end of turn 3, not before.
  const sent = sentTo(t.store.events, gen1);
  assert.equal(sent.length, 4);
  assert.match(sent[3] ?? '', /handover/);
  assert.doesNotMatch(sent[2] ?? '', /handover/);
  assert.equal(cancelledRuns(t, gen1).length, 0);
  assert.ok(t.generations[0]?.stopped(), 'the old generation is stopped');
  assert.equal(t.store.sessions.get(gen1)?.status, 'stopped');

  const memory = t.lead.memory();
  assert.equal(memory.handover?.machine, false);
  assert.equal(memory.handover?.generation, 1);
  assert.match(memory.handover?.summary ?? '', /pages of 20 and short answers/);
  const refreshed = customs(t, gen1, 'cleared.lead_refreshed');
  assert.equal(refreshed.length, 1);
  const value = refreshed[0]?.event.type === 'CUSTOM' ? refreshed[0].event.value : undefined;
  assert.deepEqual(value, { generation: 2, reason: 'handover_point', handoverId: memory.handover?.id });

  // The next generation's briefing holds the commitment, the answer and the last ten messages.
  const briefing = t.briefings[1] ?? '';
  const open = memory.commitments.find((c) => c.state === 'open');
  assert.ok(open);
  assert.ok(briefing.includes(open.id) && briefing.includes(commitment), 'the open commitment');
  assert.ok(briefing.includes('Pages of 20'), 'the answer to the question');
  for (const message of t.lead.messages().filter((m) => m.kind !== 'refresh').slice(-10)) assert.ok(briefing.includes(message.text), message.text);

  // One thread, one grey line, no gap.
  const thread = t.lead.messages();
  assert.deepEqual(thread.map((m) => m.seq), thread.map((_m, i) => i + 1));
  assert.equal(thread.filter((m) => m.kind === 'refresh').length, 1);
  assert.equal(thread.at(-1)?.kind, 'refresh');
  assert.equal(thread.at(-1)?.generation, 2);
  assert.deepEqual(threadTexts(t).slice(0, 8), [
    'owner:message:Hello', 'lead:message:Hello, I am the lead of the guestbook.',
    'owner:message:Make a long guestbook readable', 'lead:question:On desktop, pages of 20 or one long list?',
    'owner:message:Pages of 20', 'lead:message:Understood: pages of 20.',
    'owner:message:Thanks', 'lead:message:The plan comes next.',
  ]);
  const state = t.lead.state();
  assert.equal(state.refreshCount, 1);
  assert.equal(state.highestPercent, 42);
  assert.equal(state.sessionId, t.generations[1]?.id);
  assert.ok(state.refreshedAt);
  assert.equal(state.openCommitments, 1);
});

test('a lead that does not hand over within one turn of the request gets the machine handover', async () => {
  const t = await leadSetup({
    lead: [
      [...opening(), ...turn('t1', say('r1', 'Noted.'), context(45)), ...turn('t2', say('r2', 'I will not write it.'))],
      [...opening()],
    ],
  });
  await t.lead.post('Hello', 'u1');
  await until(() => t.lead.state().generation === 2, 'the second generation');
  await t.lead.settled();
  const handover = t.lead.memory().handover;
  assert.equal(handover?.machine, true);
  assert.match(handover?.summary ?? '', /the lead did not write its account/);
  assert.equal(t.lead.messages().filter((m) => m.kind === 'refresh').length, 1);
  assert.ok(!t.lead.messages().some((m) => m.text === 'I will not write it.'), 'the handover turn is not the owner\'s');
});

test('a share that crosses 50 % during a turn interrupts it, then asks for the handover; the owner\'s message goes to the next generation', async () => {
  const t = await leadSetup({
    lead: [
      [...opening(), ...turn('t1', context(55), say('r1', 'This is never said.')), ...handsOver('t2', 'Cut short at the threshold.')],
      [...opening(), ...turn('g2', say('g2r', 'Hello again, from memory.'))],
    ],
  });
  await t.lead.post('Hello', 'u1');
  await replied(t, 'Hello again, from memory.');
  await t.lead.settled();
  const gen1 = t.generations[0]?.id as string;
  assert.equal(cancelledRuns(t, gen1).length, 1, 'the turn was interrupted');
  assert.match(sentTo(t.store.events, gen1).at(-1) ?? '', /handover/);
  const value = customs(t, gen1, 'cleared.lead_refreshed')[0]?.event;
  assert.equal(value?.type === 'CUSTOM' && value.name === 'cleared.lead_refreshed' ? value.value.reason : undefined, 'threshold');
  assert.ok(!t.lead.messages().some((m) => m.text === 'This is never said.'));
  assert.ok(sentTo(t.store.events, t.generations[1]?.id as string).some((text) => text.includes('Hello')), 'the unanswered message is sent again');
  assert.equal(t.lead.state().highestPercent, 55);
  const thread = t.lead.messages();
  assert.deepEqual(thread.map((m) => `${m.by}:${m.kind}`), ['owner:message', 'system:refresh', 'lead:message']);
});

test('the largest answer allowed, at a share just under the handover point, lands under the threshold and asks for the handover (section 4.1)', async () => {
  const ids = { ticket: '' };
  // The share after the call: the measure before it, plus the answer's
  // tokens counted at the worst ratio of one token per two bytes.
  const before = 39.9;
  const worst = before + (8192 / 2) / 200_000 * 100;
  const t = await leadSetup({
    lead: [
      [...opening(), ...turn('t1', context(before), call('big', 'ticket', { get id() { return ids.ticket; } }), context(worst), say('r1', 'I read the ticket.')), ...handsOver('t2', 'Read a long ticket.')],
      [...opening()],
    ],
    start: false,
  });
  const big = await t.tickets.create({ title: 'A long ticket', body: 'x'.repeat(20_000), project: 'guestbook' }, { kind: 'human', id: 'u1' });
  ids.ticket = big.id;
  await t.lead.start();
  const tool = t.generations[0]?.input.tools?.find((x) => x.name === 'ticket');
  const answer = await tool?.handle({ id: big.id }, { sessionId: t.generations[0]?.id as string, turn: 't0' });
  assert.equal(typeof answer, 'string');
  assert.ok(Buffer.byteLength(answer as string) <= 8192, 'the answer is cut at 8 KB');
  assert.match(answer as string, /\[cleared: \d+ bytes cut\]$/);
  assert.ok(worst < 50, 'the margin holds');

  await t.lead.post('Read the long ticket', 'u1');
  await until(() => t.lead.state().generation === 2, 'the refresh');
  const gen1 = t.generations[0]?.id as string;
  assert.equal(cancelledRuns(t, gen1).length, 0, 'no interrupt: the threshold was not reached');
  assert.match(sentTo(t.store.events, gen1).at(-1) ?? '', /handover/);
  assert.ok(t.lead.messages().some((m) => m.text === 'I read the ticket.'));
});

test('a new engine over a store with a live generation ends it, writes the machine handover and starts the next one', async () => {
  const t = await leadSetup({ lead: [[...opening(12)], [...opening(9)]] });
  await t.lead.settled();
  const old = t.generations[0]?.id as string;
  await t.lead.close();
  const second = t.make();
  await second.start();
  await second.settled();
  assert.equal(t.generations.length, 2);
  const state = second.state();
  assert.equal(state.generation, 2);
  assert.equal(state.sessionId, t.generations[1]?.id);
  assert.equal(state.highestPercent, 12);
  const memory = second.memory();
  assert.equal(memory.handover?.machine, true);
  assert.equal(memory.handover?.generation, 1);
  assert.equal(t.store.sessions.get(old)?.status, 'stopped');
  const refreshed = customs(t, old, 'cleared.lead_refreshed')[0]?.event;
  assert.equal(refreshed?.type === 'CUSTOM' && refreshed.name === 'cleared.lead_refreshed' ? refreshed.value.reason : undefined, 'restart');
  assert.deepEqual(second.messages().map((m) => `${m.kind}:${m.generation}`), ['refresh:2']);
  await second.close();
});

test('a restart releases the stopped leads\' containers and networks: the generation it ends, the ones before, never the new one (issue 265)', async () => {
  const t = await leadSetup({ lead: [[...opening(12)], [...opening(9)], [...opening(7)]] });
  await t.lead.settled();
  await t.lead.close();
  const asked: string[][] = [];
  const second = new LeadEngine({ ...t.deps, release: async (sessions) => { asked.push([...sessions]); return { containers: [`cleared-v2-${sessions[0]}-egress`], networks: [] }; } });
  await second.start();
  await second.settled();
  // Generation 1 was live when the process stopped (its ledger said working): ended, then released.
  assert.deepEqual(asked, [[t.generations[0]?.id]]);
  await second.close();
  // A release that fails is said, and the lead starts all the same.
  const third = new LeadEngine({ ...t.deps, release: async () => { throw new Error('docker is not there'); } });
  await third.start();
  await third.settled();
  assert.equal(third.state().generation, 3);
  assert.equal(third.state().sessionId, t.generations[2]?.id);
  await third.close();
});

test('a commitment due in the past wakes the lead with an event turn', async () => {
  const t = await leadSetup({
    lead: [[
      ...opening(),
      ...turn('t1', call('c1', 'commit', { text: 'Remind the owner to check the texts of the page.', due: '2026-10-21T09:00:00.000Z' }), say('r1', 'I will remind you.')),
      ...turn('t2', say('r2', 'Time to remind.')),
    ]],
  });
  await t.lead.post('Remind me to check the texts', 'u1');
  await replied(t, 'I will remind you.');
  const gen1 = t.generations[0]?.id as string;
  assert.equal(sentTo(t.store.events, gen1).length, 1);
  await t.lead.tick();
  await until(() => sentTo(t.store.events, gen1).length === 2, 'the event turn');
  const wake = sentTo(t.store.events, gen1)[1] ?? '';
  const id = t.lead.memory().commitments[0]?.id as string;
  assert.ok(wake.includes(id) && wake.includes('Remind the owner to check the texts of the page.'));
  assert.match(wake, /due/);
  await t.lead.settled();
  assert.ok(!t.lead.messages().some((m) => m.text === 'Time to remind.'), 'an event turn\'s text stays on the session');
  await t.lead.tick();
  await t.lead.settled();
  assert.equal(sentTo(t.store.events, gen1).length, 2, 'a commitment wakes the lead once');
});

test('the flow\'s events are batched over 60 seconds into one turn, and nothing is sent when nothing happened', async () => {
  const t = await leadSetup({ lead: [[...opening(), ...turn('e1', say('x', 'Noted.')), ...turn('e2', say('y', 'Noted again.'))]] });
  await t.lead.settled();
  const gen1 = t.generations[0]?.id as string;
  await t.lead.tick();
  assert.equal(sentTo(t.store.events, gen1).length, 0, 'a quiet tick sends nothing');
  t.emitFlow(flowEvent({ type: 'ticket_started', ticket: 'LOCAL-7' }));
  t.clock.now += 20_000;
  t.emitFlow(flowEvent({ type: 'review_verdict', ticket: 'LOCAL-7', verdict: 'pass', round: 1 }));
  t.emitFlow(flowEvent({ type: 'permission_raised', ticket: 'LOCAL-7', requestId: 'r', item: 'permission:x:r', tool: 'Bash' }));
  t.emitFlow(flowEvent({ type: 'ticket_started', ticket: LEAD_TICKET }));
  await t.lead.tick();
  assert.equal(sentTo(t.store.events, gen1).length, 0, 'the batch waits 60 seconds from its first event');
  t.clock.now += 41_000;
  await t.lead.tick();
  await until(() => sentTo(t.store.events, gen1).length === 1, 'the event turn');
  const batch = sentTo(t.store.events, gen1)[0] ?? '';
  assert.match(batch, /LOCAL-7/);
  assert.match(batch, /started/);
  assert.match(batch, /review/);
  assert.doesNotMatch(batch, /Bash|permission:x/, 'a permission waits for the owner: it is not the lead\'s event');
  assert.match(batch, /Live sessions/, 'the compact state comes with it');
  await t.lead.settled();
  t.clock.now += 120_000;
  await t.lead.tick();
  await t.lead.settled();
  assert.equal(sentTo(t.store.events, gen1).length, 1, 'each event is sent once');
});

test('tell_owner is refused in a turn the owner started, and writes in the thread from an event turn', async () => {
  const t = await leadSetup({
    lead: [[
      ...opening(),
      ...turn('t1', call('x', 'tell_owner', { text: 'Not from here.' }), say('r1', 'Hi.')),
      ...turn('t2', call('y', 'tell_owner', { text: 'LOCAL-7 is ready for your approval.' }), say('r2', 'Told the owner.')),
    ]],
  });
  await t.lead.post('Hi', 'u1');
  await replied(t, 'Hi.');
  const gen1 = t.generations[0]?.id as string;
  const first = customs(t, gen1, 'cleared.host_call')[0]?.event;
  assert.equal(first?.type === 'CUSTOM' && first.name === 'cleared.host_call' ? first.value.outcome : undefined, 'refused');
  t.emitFlow(flowEvent({ type: 'release_requested', ticket: 'LOCAL-7', item: 'release:LOCAL-7', pr: 7, url: 'https://example.invalid/pull/7' }));
  t.clock.now += 61_000;
  await t.lead.tick();
  await until(() => t.lead.messages().some((m) => m.text === 'LOCAL-7 is ready for your approval.'), 'the message');
  await t.lead.settled();
  assert.deepEqual(threadTexts(t), ['owner:message:Hi', 'lead:message:Hi.', 'lead:message:LOCAL-7 is ready for your approval.']);
});

test('the flow\'s idle rule never stops the lead\'s session (section 4.3)', async () => {
  const t = await leadSetup();
  await t.lead.settled();
  t.clock.now += 60 * 60_000;
  await t.engine.tick();
  await t.engine.settled();
  await t.lead.tick();
  assert.equal(t.generations[0]?.stopped(), false);
  assert.equal(t.lead.state().phase, 'idle');
  assert.equal(t.lead.state().generation, 1);
});

test('the opening turn\'s own share never refreshes a generation: the handover point counts once it has served a turn', async () => {
  const t = await leadSetup({ lead: [[...opening(45), ...turn('t1', say('r1', 'Hello.'), context(46))], [...opening(45)]] });
  await t.lead.settled();
  assert.equal(t.lead.state().generation, 1);
  assert.equal(sentTo(t.store.events, t.generations[0]?.id as string).length, 0, 'no handover asked of a generation that has done nothing');
  await t.lead.post('Hello', 'u1');
  await until(() => t.lead.state().generation === 2, 'the refresh after a real turn');
});

test('a generation whose session fails is replaced, with the machine handover and the reason "failed"', async () => {
  const t = await leadSetup({
    lead: [
      [...opening(), { awaitMessage: true }, { emit: { type: 'RUN_ERROR', message: 'The runner died.', code: 'exit' } }],
      [...opening()],
    ],
  });
  await t.lead.post('Hello', 'u1');
  await until(() => t.lead.state().phase === 'down' && t.lead.memory().handover !== null, 'the failed generation');
  // It served no turn: the next one waits the retry delay, so a session that fails at once does not loop.
  await t.lead.tick();
  assert.equal(t.generations.length, 1);
  t.clock.now += 61_000;
  await t.lead.tick();
  await until(() => t.lead.state().generation === 2, 'the next generation');
  const old = t.generations[0]?.id as string;
  const value = customs(t, old, 'cleared.lead_refreshed')[0]?.event;
  assert.equal(value?.type === 'CUSTOM' && value.name === 'cleared.lead_refreshed' ? value.value.reason : undefined, 'failed');
  assert.equal(t.lead.memory().handover?.machine, true);
});

test('a generation that cannot start leaves the lead down, and a later tick starts it', async () => {
  let fail = true;
  const t = await leadSetup({ prepareWorkdir: async () => { if (fail) throw new Error('the clone failed'); return '/work/lead'; } });
  assert.equal(t.lead.state().phase, 'down');
  assert.equal(t.generations.length, 0);
  fail = false;
  await t.lead.tick();
  assert.equal(t.generations.length, 0, 'not before the retry delay');
  t.clock.now += 61_000;
  await t.lead.tick();
  await t.lead.settled();
  assert.equal(t.generations.length, 1);
  assert.equal(t.lead.state().phase, 'idle');
  assert.equal(t.lead.state().generation, 1);
});

test('the stream says each thread message and each state change', async () => {
  const t = await leadSetup({ lead: [[...opening(), ...turn('t1', say('r1', 'Hello.'))]] });
  await t.lead.settled();
  const frames: string[] = [];
  const stop = t.lead.watch((frame) => { frames.push(frame.kind === 'message' ? `message:${frame.message.seq}` : frame.kind); });
  await t.lead.post('Hello', 'u1');
  await replied(t, 'Hello.');
  stop();
  assert.ok(frames.includes('message:1') && frames.includes('message:2'));
  assert.ok(frames.includes('state'));
});

test('LeadEngine.answer answers the pending question as the session route would, and refuses another', async () => {
  const t = await leadSetup({ lead: [[...opening(), ...turn('t1', question('q1', 'Pages of 20?'), say('r1', 'Pages of 20 then.'))]] });
  await t.lead.post('Plan the list', 'u1');
  await until(() => t.lead.state().pendingQuestion !== null, 'the question');
  const gen1 = t.generations[0]?.id as string;
  await assert.rejects(t.lead.answer(gen1, 'q2', { 'Pages of 20?': 'Yes' }, 'u1'), (error: unknown) => error instanceof LeadError && error.kind === 'not_found');
  await t.lead.answer(gen1, 'q1', { 'Pages of 20?': 'Yes' }, 'u1');
  await replied(t, 'Pages of 20 then.');
  assert.equal(t.lead.state().pendingQuestion, null);
  assert.deepEqual(threadTexts(t), ['owner:message:Plan the list', 'lead:question:Pages of 20?', 'owner:message:Yes', 'lead:message:Pages of 20 then.']);
});

test('a question an earlier generation asked: the owner\'s answer goes to the next one, quoting it, and the item is handled as system (section 3.3)', async () => {
  const t = await leadSetup({ lead: [[...opening(), ...turn('t1', question('q1', 'Pages of 20?'))], [...opening(), ...turn('g2', say('g2r', 'Pages of 20, noted from the answer.'))]] });
  await t.lead.post('Plan the list', 'u1');
  await until(() => t.lead.state().pendingQuestion !== null, 'the question');
  await t.lead.close();
  const second = t.make();
  await second.start();
  await second.settled();
  assert.equal(second.state().generation, 2);
  assert.deepEqual(second.state().pendingQuestion, { sessionId: t.generations[0]?.id, requestId: 'q1' }, 'the question survives the generation');
  await second.post('Yes, pages of 20', 'u1');
  await until(() => second.messages().some((m) => m.text === 'Pages of 20, noted from the answer.'), 'the answer turn');
  const sent = sentTo(t.store.events, t.generations[1]?.id as string);
  assert.ok(sent.some((text) => text.includes('"Pages of 20?"') && text.includes('Yes, pages of 20')), 'the turn quotes the question and the answer');
  const item = t.store.db.prepare("SELECT state, handled_by FROM flow_inbox WHERE kind = 'question'").get() as { state: string; handled_by: string };
  assert.deepEqual({ ...item }, { state: 'handled', handled_by: 'system' });
  assert.equal(second.messages().find((m) => m.kind === 'question')?.question?.state, 'handled');
  assert.equal(second.state().pendingQuestion, null);
  await second.close();
});

test('lane 1\'s scripted lead plays its goal turn through the engine: the question answered from the reply, the commit stored, the reply in the thread, 45 % reached', async () => {
  const t = await leadSetup({ lead: [exampleLeadScript] });
  await t.lead.settled();
  assert.equal(t.lead.state().phase, 'idle', 'ready at its first measure, without an opening turn');
  await t.lead.post('Make a long guestbook readable', 'u1', true);
  await until(() => t.lead.state().pendingQuestion !== null, 'the question');
  await t.lead.post('Pages of 20 (Recommended)', 'u1');
  await until(() => t.lead.messages().some((m) => m.by === 'lead' && m.kind === 'message'), 'the reply');
  await t.lead.settled();
  assert.match(t.lead.messages().find((m) => m.by === 'lead' && m.kind === 'message')?.text ?? '', /Here is a plan in five tickets/);
  assert.equal(t.lead.state().openCommitments, 1);
  assert.equal(t.lead.state().highestPercent, 45);
  assert.match(sentTo(t.store.events, t.generations[0]?.id as string).at(-1) ?? '', /handover/, 'past the handover point, the next turn asks for it');
});

test('a team\'s question past its delay is said in the thread and given to the lead at once, with what applies at the end of its window (issue #290)', async () => {
  const t = await leadSetup({ lead: [[...opening(), ...turn('e1', say('x', 'I will decide it.'))]] });
  await t.lead.settled();
  const gen1 = t.generations[0]?.id as string;
  t.emitFlow(flowEvent({
    type: 'question_timed_out', ticket: 'LOCAL-42', session: 's-author', requestId: 'q1', item: 'question:s-author:q1', stage: 'lead',
    minutes: 30, leadMinutes: 10, questions: ['Which order?'], answers: { 'Which order?': 'Newest first (Recommended)' },
  }));
  const line = t.lead.messages().find((m) => m.by === 'system' && /LOCAL-42/.test(m.text));
  assert.ok(line, 'a line of the thread, which the owner reads too');
  assert.match(line.text, /"Which order\?" waited 30 min/);
  assert.match(line.text, /answer_question \(session s-author, request q1\)/);
  assert.match(line.text, /In 10 min without an answer, the answer the session declared applies: Newest first \(Recommended\)/);
  await until(() => sentTo(t.store.events, gen1).some((text) => /LOCAL-42/.test(text)), 'the lead\'s turn, without the 60 s batch');

  t.emitFlow(flowEvent({ type: 'question_timed_out', ticket: 'LOCAL-43', session: 's-b', requestId: 'q2', item: 'question:s-b:q2', stage: 'lead', minutes: 30, leadMinutes: 10, questions: ['What should it say?'], answers: null }));
  assert.match(t.lead.messages().find((m) => /LOCAL-43/.test(m.text))?.text ?? '', /no answer, so the ticket is parked and the rest of the plan goes on/);
  await t.lead.settled();
});
