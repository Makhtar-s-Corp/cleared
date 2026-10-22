// The session plan validated before the code (docs/v2/milestone-2-plan.md,
// decision 22, lane 17), on the fake adapter: the author's first turn ends
// with propose_session_plan, the flow holds it until a Go (the owner's, the
// delay's for a high confidence, or the lead's for a high confidence of an
// approved plan's ticket), and `plan_gate` is measured apart from the
// author's working time.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionPlan, SessionPlanItem } from '../../src/api/types.ts';
import { FlowError } from '../../src/flow/engine.ts';
import type { ProjectSettings } from '../../src/flow/config.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { toolArgs, toolResult, type SessionEvent } from '../../src/session/events.ts';
import {
  REPORT_FIX, REPORT_PASS, fakeEffects, finished, reviewerScript, setup, started, stepLines, text, until, type Scripts, type Setup,
} from './support.ts';

const MINUTE = 60_000;

const proposal = (confidence: SessionPlan['confidence'], id = 'plan-1', steps: string[] = ['Sort the entries newest first']): FakeStep => ({
  hostCall: { toolCallId: id, name: 'propose_session_plan', input: { steps, files: ['src/entries.ts'], confidence, reason: `One function changes (${confidence}).` } },
});
const edit = (id: string, path: string): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Edit' } },
  { emit: toolArgs(id, { kind: 'edit', path, added: 3, removed: 1 }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: id } },
  { emit: toolResult(`${id}-result`, id, { kind: 'edit', ok: true }) },
];
const report = (id: string, groups: { intent: string; files: string[] }[]): FakeStep => ({ hostCall: { toolCallId: id, name: 'report_changes', input: { groups } } });

// The first turn proposes, then waits for the Go; the second does the work and reports it.
const planned = (confidence: SessionPlan['confidence']): readonly FakeStep[] => [
  started, ...text('p1', 'I read the code. Here is my plan.'), proposal(confidence), finished(0.1),
  { awaitMessage: true },
  started, ...edit('e1', '/workspace/src/entries.ts'), ...edit('e2', '/workspace/test/entries.test.ts'),
  report('report-1', [{ intent: 'Sort the entries newest first', files: ['src/entries.ts'] }]), ...text('a1', 'Done.'), finished(0.3),
];

async function settingsOf(minutes?: number): Promise<ProjectSettings> {
  const base = await fakeEffects([]).settings();
  return minutes === undefined ? base : { ...base, planGoMinutes: minutes };
}

async function gated(scripts: Scripts, minutes?: number): Promise<Setup> {
  const settings = await settingsOf(minutes);
  return setup({ scripts, config: { authorTools: true }, effects: { settings: async () => settings } });
}

const waitingPlan = (t: Setup): SessionPlanItem | undefined =>
  t.inbox.items().find((item): item is SessionPlanItem => item.kind === 'session_plan' && item.state === 'waiting');
const planItems = (t: Setup) => t.inbox.items().filter((item): item is SessionPlanItem => item.kind === 'session_plan');
const events = (t: Setup): SessionEvent[] => t.startedSessions.flatMap((s) => t.store.events.after(s.id));
const customs = (t: Setup, name: string) => events(t).flatMap(({ event }) => (event.type === 'CUSTOM' && event.name === name ? [event.value as unknown] : []));
const userTexts = (t: Setup, session: string) => {
  const ids = new Set(t.store.events.after(session).flatMap(({ event }) => (event.type === 'TEXT_MESSAGE_START' && event.role === 'user' ? [event.messageId] : [])));
  return t.store.events.after(session).flatMap(({ event }) => (event.type === 'TEXT_MESSAGE_CONTENT' && ids.has(event.messageId) ? [event.delta] : []));
};
const planOf = (t: Setup, session: string) => t.engine.sessionDetail(session)?.state.plan ?? null;

async function heldAt(t: Setup): Promise<SessionPlanItem> {
  await until(() => waitingPlan(t) !== undefined, 'the session plan in the inbox');
  await t.engine.settled();
  return waitingPlan(t) as SessionPlanItem;
}

async function tickAfter(t: Setup, ms: number): Promise<void> {
  t.clock.now += ms;
  await t.engine.tick();
  await t.engine.settled();
}

test('the author is given its two host tools, and its first turn is asked for the plan, the end of its work for the report', async () => {
  const t = await gated({ author: planned('high') });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  assert.deepEqual(author.input.tools?.map((tool) => tool.name), ['propose_session_plan', 'report_changes']);
  assert.match(author.input.prompt, /propose_session_plan/);
  assert.match(author.input.prompt, /before you change any file/i);
  assert.match(author.input.prompt, /report_changes/);
  // The real harness asks the policy before each tool call: the author's own host tools are allowed.
  const learned = t.engine.policyFor(author.input).learned;
  assert.ok(learned.some((rule) => rule.tool === 'mcp__cleared__propose_session_plan'));
  assert.ok(learned.some((rule) => rule.tool === 'mcp__cleared__report_changes'));
  await heldAt(t);
  await t.engine.close();
});

test('a configuration without the author\'s tools runs the milestone 1 flow: no tool, no plan asked, no gate', async () => {
  const t = await setup({ scripts: { author: [started, ...text('a1', 'Done.'), finished(0.3)] } });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  assert.equal(author.input.tools, undefined);
  assert.doesNotMatch(author.input.prompt, /propose_session_plan/);
  await until(() => t.startedSessions.length === 2, 'the review');
  assert.ok(!stepLines(events(t)).includes('+plan_gate'));
  await t.engine.close();
});

test('a high confidence with no Go for 10 minutes of fake time starts by itself, the step closed "by the delay"', async () => {
  const t = await gated({ author: planned('high') });
  await t.engine.start(t.ticket.id, 'u1');
  const item = await heldAt(t);
  const author = t.startedSessions[0]!.id;
  assert.equal(item.sessionId, author);
  assert.equal(item.ticket, t.ticket.id);
  assert.equal(item.plan.confidence, 'high');
  assert.equal(item.plan.reason, 'One function changes (high).');
  assert.deepEqual(item.plan.steps, ['Sort the entries newest first']);
  assert.equal(item.plan.go, null);
  assert.deepEqual(planOf(t, author), item.plan, 'the session JSON carries the plan');
  // The gate is measured apart: the author's step closes when it starts.
  assert.deepEqual(stepLines(events(t)), ['+workspace', '-workspace', '+author', '-author', '+plan_gate']);
  assert.equal(t.engine.sessionSummary(author)?.phase, 'waiting_human');

  await tickAfter(t, 10 * MINUTE - 1000);
  assert.equal(waitingPlan(t)?.id, item.id, 'still waiting at 9:59');
  assert.equal(t.startedSessions.length, 1);

  await tickAfter(t, 1000);
  await until(() => t.startedSessions.length === 2, 'the review after the work');
  await t.engine.settled();
  const plan = planOf(t, author);
  assert.deepEqual(plan?.go, { by: 'delay', at: new Date(t.clock.now).toISOString() });
  assert.equal(t.inbox.items().find((i) => i.id === item.id)?.state, 'handled');
  assert.deepEqual(stepLines(t.store.events.after(author)), ['+workspace', '-workspace', '+author', '-author', '+plan_gate', '-plan_gate', '+author', '-author']);
  // The Go is journaled as the plan again, with who and when.
  const journaled = customs(t, 'cleared.session_plan') as SessionPlan[];
  assert.deepEqual(journaled.map((p) => p.go?.by ?? null), [null, 'delay']);
  // The author was told to carry its plan out.
  assert.match(userTexts(t, author).at(-1) ?? '', /Go/);
  // Its report: the group it named, and the file it changed but named in no group.
  assert.deepEqual(customs(t, 'cleared.changes'), [{ groups: [
    { intent: 'Sort the entries newest first', files: ['src/entries.ts'] },
    { intent: 'Other changes', files: ['test/entries.test.ts'] },
  ] }]);
  await t.engine.close();
});

test('a medium confidence still waits at 11 minutes and two hours later, never idle; a Go from the owner closes it "by the owner"', async () => {
  const t = await gated({ author: planned('medium') });
  await t.engine.start(t.ticket.id, 'u1');
  const item = await heldAt(t);
  const author = t.startedSessions[0]!.id;
  await tickAfter(t, 11 * MINUTE);
  assert.equal(waitingPlan(t)?.id, item.id);
  await tickAfter(t, 2 * 3600_000);
  assert.equal(waitingPlan(t)?.id, item.id, 'the night waits for the owner');
  assert.equal(t.engine.sessionSummary(author)?.phase, 'waiting_human', 'the idle rule leaves a session whose plan waits');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'In Progress');
  assert.ok(!t.flowEvents.some((e) => e.type === 'ticket_put_back'));

  await t.engine.planGo(author, 'u1');
  await until(() => t.startedSessions.length === 2, 'the review after the work');
  assert.deepEqual(planOf(t, author)?.go, { by: 'u1', at: new Date(t.clock.now).toISOString() });
  assert.equal(t.inbox.items().find((i) => i.id === item.id)?.state, 'handled');
  await assert.rejects(t.engine.planGo(author, 'u1'), (error: unknown) => error instanceof FlowError && error.kind === 'conflict', 'a second Go');
  await t.engine.close();
});

test('a Change reopens the author with the message, and the next proposal replaces the first', async () => {
  const t = await gated({
    author: [
      started, proposal('medium', 'plan-1'), finished(0.1),
      { awaitMessage: true },
      started, proposal('high', 'plan-2', ['Sort the entries newest first', 'Test the empty list']), finished(0.1),
      { awaitMessage: true },
      started, ...text('a1', 'Done.'), finished(0.3),
    ],
  });
  await t.engine.start(t.ticket.id, 'u1');
  const first = await heldAt(t);
  const author = t.startedSessions[0]!.id;
  await assert.rejects(t.engine.planChange(author, ' ', 'u1'), (error: unknown) => error instanceof FlowError && error.kind === 'invalid');
  await t.engine.planChange(author, 'Test the empty list too.', 'u1');
  await until(() => waitingPlan(t) !== undefined && waitingPlan(t)?.id !== first.id, 'the second proposal');
  await t.engine.settled();
  assert.equal(t.inbox.items().find((i) => i.id === first.id)?.state, 'handled');
  assert.match(userTexts(t, author).at(-1) ?? '', /Test the empty list too\./);
  const second = waitingPlan(t) as SessionPlanItem;
  assert.deepEqual(second.plan.steps, ['Sort the entries newest first', 'Test the empty list']);
  assert.deepEqual(planOf(t, author)?.steps, second.plan.steps, 'the session shows the new plan');
  assert.equal(planItems(t).filter((i) => i.state === 'waiting').length, 1);
  // One gate, from the first proposal to the Go.
  assert.deepEqual(stepLines(events(t)), ['+workspace', '-workspace', '+author', '-author', '+plan_gate']);
  await t.engine.planGo(author, 'u1');
  await until(() => t.startedSessions.length === 2, 'the review');
  assert.deepEqual(stepLines(t.store.events.after(author)), ['+workspace', '-workspace', '+author', '-author', '+plan_gate', '-plan_gate', '+author', '-author']);
  await t.engine.close();
});

test('a ticket the lead started for an approved plan, with a high confidence, starts at once "by the plan"; a medium one waits', async () => {
  const t = await gated({ author: planned('high') });
  await t.engine.start(t.ticket.id, 'u1', { plan: 'p1', item: 1 });
  await until(() => t.startedSessions.length === 2, 'the review, with no tick and no Go');
  const author = t.startedSessions[0]!.id;
  assert.equal(planOf(t, author)?.go?.by, 'lead');
  assert.equal(waitingPlan(t), undefined, 'nothing waited');
  assert.deepEqual(stepLines(t.store.events.after(author)), ['+workspace', '-workspace', '+author', '-author', '+plan_gate', '-plan_gate', '+author', '-author']);
  await t.engine.close();

  const m = await gated({ author: planned('medium') });
  await m.engine.start(m.ticket.id, 'u1', { plan: 'p1', item: 1 });
  const item = await heldAt(m);
  assert.equal(item.plan.go, null);
  await tickAfter(m, 30 * MINUTE);
  assert.equal(waitingPlan(m)?.id, item.id, 'a medium plan of the lead waits for the owner');
  await m.engine.close();
});

test('an author reopened after a review proposes nothing: the call is refused, and the review goes on', async () => {
  const t = await gated({
    author: planned('high'),
    reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)],
    reopen: [{ awaitMessage: true }, started, proposal('high', 'plan-again'), ...text('a2', 'Fixed.'), finished(0.2)],
  });
  await t.engine.start(t.ticket.id, 'u1', { plan: 'p1', item: 1 });
  await until(() => t.inbox.items().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release after two rounds', 5000);
  const calls = customs(t, 'cleared.host_call') as { name: string; outcome: string; toolCallId: string }[];
  assert.equal(calls.find((c) => c.toolCallId === 'plan-again')?.outcome, 'refused');
  assert.equal(customs(t, 'cleared.session_plan').length, 2, 'the proposal and its Go, nothing after the review');
  assert.equal(planItems(t).length, 0);
  await t.engine.close();
});

test('a new author started after a review because the old one could not resume is not asked for a plan either', async () => {
  const t = await gated({
    authors: [planned('high'), [started, proposal('high', 'plan-new'), ...text('a2', 'Fixed.'), finished(0.2)]],
    reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)],
    reopen: 'throw',
  });
  await t.engine.start(t.ticket.id, 'u1', { plan: 'p1', item: 1 });
  await until(() => t.inbox.items().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release', 5000);
  const second = t.startedSessions.filter((s) => s.input.role === 'author')[1]!;
  assert.doesNotMatch(second.input.prompt, /propose_session_plan/);
  assert.match(second.input.prompt, /report_changes/);
  const calls = customs(t, 'cleared.host_call') as { outcome: string; toolCallId: string }[];
  assert.equal(calls.find((c) => c.toolCallId === 'plan-new')?.outcome, 'refused');
  assert.equal(planItems(t).length, 0);
  await t.engine.close();
});

test('a session that never calls the tool is held at most plan_go_minutes, then put back with a note, not started', async () => {
  const t = await gated({ author: [started, ...text('a1', 'I changed the sort.'), finished(0.3), { awaitMessage: true }, started, finished(0.1)] });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!.id;
  await until(() => stepLines(t.store.events.after(author)).includes('-author'), 'the end of the first turn');
  await t.engine.settled();
  await tickAfter(t, 10 * MINUTE - 1000);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'In Progress', 'held, not put back yet');
  assert.equal(t.startedSessions.length, 1, 'not reviewed');
  await tickAfter(t, 1000);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.ok(back && back.type === 'ticket_put_back');
  assert.match(back.note, /did not propose a session plan within 10 minutes/);
  assert.equal(t.startedSessions.length, 1, 'never started on the code, never reviewed');
  const error = t.store.events.after(author).find(({ event }) => event.type === 'RUN_ERROR');
  assert.ok(error && error.event.type === 'RUN_ERROR' && error.event.code === 'no_plan');
  assert.equal((await t.tickets.comments(t.ticket.id)).filter((c) => /session plan/.test(c.body)).length, 1);
  await t.engine.close();
});

test('the delay is the service\'s [session] plan_go_minutes: at 25, a high plan waits past 10 minutes, and a silent author past the idle stop', async () => {
  const t = await gated({ author: planned('high') }, 25);
  await t.engine.start(t.ticket.id, 'u1');
  await heldAt(t);
  await tickAfter(t, 24 * MINUTE);
  assert.ok(waitingPlan(t), 'still waiting at 24 minutes');
  await tickAfter(t, MINUTE);
  await until(() => t.startedSessions.length === 2, 'the review');
  assert.equal(planOf(t, t.startedSessions[0]!.id)?.go?.by, 'delay');
  await t.engine.close();

  const s = await gated({ author: [started, finished(0.3), { awaitMessage: true }, started, finished(0.1)] }, 25);
  await s.engine.start(s.ticket.id, 'u1');
  await until(() => stepLines(s.store.events.after(s.startedSessions[0]!.id)).includes('-author'), 'the end of the first turn');
  await tickAfter(s, 20 * MINUTE);
  assert.equal((await s.tickets.get(s.ticket.id))?.status, 'In Progress', 'the 15-minute idle stop does not cut the 25 minutes');
  await tickAfter(s, 5 * MINUTE);
  assert.equal((await s.tickets.get(s.ticket.id))?.status, 'Todo');
  await s.engine.close();
});

test('report_changes refuses a file in two groups; the next report is kept', async () => {
  const t = await gated({
    author: [
      started, proposal('high'), finished(0.1), { awaitMessage: true },
      started, ...edit('e1', '/workspace/src/entries.ts'),
      report('report-bad', [{ intent: 'Sort', files: ['src/entries.ts'] }, { intent: 'Tidy', files: ['src/entries.ts'] }]),
      report('report-good', [{ intent: 'Sort', files: ['src/entries.ts'] }]),
      ...text('a1', 'Done.'), finished(0.3),
    ],
  });
  await t.engine.start(t.ticket.id, 'u1', { plan: 'p1', item: 1 });
  await until(() => t.startedSessions.length === 2, 'the review');
  const calls = customs(t, 'cleared.host_call') as { toolCallId: string; outcome: string; message?: string }[];
  const bad = calls.find((c) => c.toolCallId === 'report-bad');
  assert.equal(bad?.outcome, 'refused');
  assert.match(bad?.message ?? '', /src\/entries\.ts/);
  assert.equal(calls.find((c) => c.toolCallId === 'report-good')?.outcome, 'ok');
  assert.deepEqual(customs(t, 'cleared.changes'), [{ groups: [{ intent: 'Sort', files: ['src/entries.ts'] }] }]);
  await t.engine.close();
});

test('a session plan of a session that stops leaves the inbox with it', async () => {
  const t = await gated({ author: planned('medium') });
  await t.engine.start(t.ticket.id, 'u1');
  const item = await heldAt(t);
  await t.engine.close();
  // The ticket is stopped for its budget at its next end of turn in other tests; here the
  // restart is the end: a new engine closes what the last process left waiting.
  const { FlowEngine } = await import('../../src/flow/engine.ts');
  const again = new FlowEngine(t.deps);
  assert.equal(t.inbox.items().find((i) => i.id === item.id)?.state, 'handled');
  await again.recover();
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  await again.close();
});
