// A team's question no longer waits forever (issue #290, lane j3-autonomy),
// on a simulated clock: each question has its own delay from when it was
// asked (CLEARED_V2_QUESTION_TIMEOUT_MINUTES, 30 by default). Past it the
// lead is asked to decide, with QUESTION_LEAD_MINUTES to do so; then the
// answer the session declared (its "(Recommended)" option) is applied and
// logged, or, with none, the ticket is parked so the plan goes on. The
// delay and the default are the project's own when its agents.conf sets
// them (issue #269).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowConfigError, QUESTION_LEAD_MINUTES, QUESTION_TIMEOUT_MINUTES, loadFlowConfig } from '../../src/flow/config.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import type { ProjectSettings } from '../../src/flow/config.ts';
import { declaredAnswers, defaultAnswers } from '../../src/flow/questions.ts';
import type { QuestionItem } from '../../src/api/types.ts';
import { LEAD_TICKET } from '../../src/lead/contract.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { CustomValue, Question } from '../../src/session/events.ts';
import { fakeEffects, finished, setup, started, text, until, type SetupOptions } from './support.ts';

const MIN = 60_000;
const RECOMMENDED: CustomValue['cleared.question'] = {
  requestId: 'q1', questions: [{ question: 'Which order?', options: [{ label: 'Oldest first' }, { label: 'Newest first (Recommended)' }] }],
};
const FREE: CustomValue['cleared.question'] = { requestId: 'q1', questions: [{ question: 'What should the empty page say?' }] };
// The author asks, waits for the answer, then ends its turn: the review and the release follow.
const asks = (value: CustomValue['cleared.question']): readonly FakeStep[] => [started, ...text('a1', 'One thing to settle.'), { question: value }, ...text('a2', 'Done.'), finished(0.3)];

async function asking(value: CustomValue['cleared.question'], options: SetupOptions = {}) {
  const t = await setup({ ...options, scripts: { author: asks(value), ...options.scripts } });
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1, 'the question in the inbox');
  await t.engine.settled();
  const asked = t.clock.now;
  const at = async (minutes: number) => {
    t.clock.now = asked + minutes * MIN;
    await t.engine.tick();
    await t.engine.settled();
  };
  const question = () => t.inbox.items().find((i): i is QuestionItem => i.kind === 'question')!;
  const timedOut = () => t.flowEvents.filter((e): e is Extract<FlowEvent, { type: 'question_timed_out' }> => e.type === 'question_timed_out');
  const ledger = (kind: string) => t.store.db.prepare('SELECT ticket, detail, source FROM events WHERE kind = ?').all(kind) as { ticket: string; detail: string; source: string }[];
  return { ...t, id, asked, at, question, timedOut, ledger };
}

test('the delay is the question\'s own: the item says when the lead decides and what then applies; 29:59 waits, 30:00 asks the lead, still waiting, and the ledger says so', async () => {
  const t = await asking(RECOMMENDED);
  const item = t.question();
  assert.deepEqual(item.timeout, {
    at: new Date(t.asked + QUESTION_TIMEOUT_MINUTES * MIN).toISOString(),
    leadUntil: new Date(t.asked + (QUESTION_TIMEOUT_MINUTES + QUESTION_LEAD_MINUTES) * MIN).toISOString(),
    answers: { 'Which order?': 'Newest first (Recommended)' },
  });
  await t.at(29 + 59 / 60);
  assert.equal(t.timedOut().length, 0);
  await t.at(30);
  assert.deepEqual(t.timedOut().map((e) => ({ stage: e.stage, session: e.session, requestId: e.requestId, minutes: e.minutes })), [{ stage: 'lead', session: t.id, requestId: 'q1', minutes: 30 }]);
  assert.equal(t.question().state, 'waiting', 'the lead decides now; the owner may still answer');
  assert.equal(t.question().timeout?.leadAt, new Date(t.asked + 30 * MIN).toISOString());
  assert.equal(t.ledger('question_to_lead').length, 1);
  assert.equal(t.ledger('question_to_lead')[0]!.ticket, t.ticket.id);
  await t.at(31);
  assert.equal(t.timedOut().length, 1, 'the lead is asked once');
});

test('the lead decides in its window: its answer reaches the session, nothing is applied at the end of the window, the ticket goes on', async () => {
  const t = await asking(RECOMMENDED);
  await t.at(30);
  await t.engine.answer(t.id, 'q1', { kind: 'answer', answers: { 'Which order?': 'Oldest first' } }, 'lead');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release');
  assert.equal(t.question().state, 'handled');
  await t.at(41);
  assert.deepEqual(t.timedOut().map((e) => e.stage), ['lead']);
  assert.equal(t.ledger('question_default').length, 0);
});

test('without the owner or the lead, the declared default is applied at 40 min and logged in the session, on the ticket, in the ledger and on the bus; the ticket goes on to its release', async () => {
  const t = await asking(RECOMMENDED);
  await t.at(30);
  await t.at(39 + 59 / 60);
  assert.equal(t.question().state, 'waiting');
  await t.at(40);
  assert.equal(t.question().state, 'handled');
  const answered = t.store.events.after(t.id).map((e) => e.event).find((e) => e.type === 'CUSTOM' && e.name === 'cleared.permission_answered');
  assert.ok(answered && answered.type === 'CUSTOM' && answered.name === 'cleared.permission_answered');
  assert.deepEqual(answered.value, { requestId: 'q1', decision: 'answer', by: 'policy', rule: 'question_default' });
  const comment = (await t.tickets.comments(t.ticket.id)).find((c) => /the answer the session declared applies/.test(c.body))?.body ?? '';
  assert.match(comment, /Which order\?/);
  assert.match(comment, /Newest first \(Recommended\)/);
  assert.match(comment, /40 min/);
  const row = t.ledger('question_default')[0]!;
  assert.equal(row.source, 'flow');
  assert.deepEqual(JSON.parse(row.detail), { session: t.id, requestId: 'q1', item: t.question().id, minutes: 40, answers: { 'Which order?': 'Newest first (Recommended)' } });
  assert.deepEqual(t.timedOut().map((e) => e.stage), ['lead', 'default']);
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release');
});

test('a question with no declared default parks its ticket at 40 min: the session stops, the ticket is in Todo, put back as parked, said in the ledger', async () => {
  const t = await asking(FREE);
  assert.equal(t.question().timeout?.answers, null);
  await t.at(30);
  await t.at(40);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.equal(t.store.sessions.get(t.id)?.status, 'stopped');
  const back = t.flowEvents.find((e): e is Extract<FlowEvent, { type: 'ticket_put_back' }> => e.type === 'ticket_put_back');
  assert.equal(back?.reason, 'parked');
  assert.match(back?.note ?? '', /What should the empty page say\?/);
  assert.match(back?.note ?? '', /40 min/);
  const last = t.store.events.after(t.id).map((e) => e.event).filter((e) => e.type === 'RUN_ERROR').at(-1);
  assert.equal(last?.type === 'RUN_ERROR' ? last.code : undefined, 'parked');
  assert.equal(t.question().state, 'handled', 'nothing of the session waits any more');
  assert.equal(t.ledger('question_parked').length, 1);
  assert.deepEqual(t.timedOut().map((e) => e.stage), ['lead', 'parked']);
});

test('the delay is set by CLEARED_V2_QUESTION_TIMEOUT_MINUTES, 30 by default, and a wrong one is an error', async () => {
  const env = {
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/g.git',
    CLEARED_V2_REPO: 'example-org/g', CLEARED_V2_STATE_DIR: '/state',
  };
  assert.equal(loadFlowConfig(env)?.questionTimeoutMs, 30 * MIN);
  assert.equal(loadFlowConfig({ ...env, CLEARED_V2_QUESTION_TIMEOUT_MINUTES: '5' })?.questionTimeoutMs, 5 * MIN);
  assert.equal(loadFlowConfig(env)?.questionLeadMs, QUESTION_LEAD_MINUTES * MIN);
  for (const wrong of ['0', '-1', 'half an hour']) assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_QUESTION_TIMEOUT_MINUTES: wrong }), FlowConfigError);

  const t = await asking(RECOMMENDED, { config: { questionTimeoutMs: 5 * MIN } });
  await t.at(5);
  assert.deepEqual(t.timedOut().map((e) => e.stage), ['lead']);
});

test('the lead\'s own question to the owner never times out here: the lead engine keeps it', async () => {
  const t = await setup();
  t.inbox.addQuestion({ ticket: LEAD_TICKET, project: 'guestbook', sessionId: 'lead-1', requestId: 'lq', questions: [{ question: 'Which goal first?', options: [{ label: 'A (Recommended)' }] }] });
  t.clock.now += 3 * 3600_000;
  await t.engine.tick();
  assert.equal(t.inbox.list().find((i) => i.kind === 'question')?.state, 'waiting');
  assert.equal(t.flowEvents.filter((e) => e.type === 'question_timed_out').length, 0);
});

test('the declared answers: each question\'s "(Recommended)" option, else none for the whole request', () => {
  assert.deepEqual(declaredAnswers(RECOMMENDED.questions), { 'Which order?': 'Newest first (Recommended)' });
  assert.equal(declaredAnswers(FREE.questions), null);
  assert.equal(declaredAnswers([...RECOMMENDED.questions, { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]), null, 'one question without a default leaves the request to a person');
  assert.deepEqual(declaredAnswers([{ question: 'Which?', options: [{ label: 'a (recommended) ' }, { label: 'b (Recommended)' }] }]), { 'Which?': 'a (recommended) ' }, 'the first recommended option');
  assert.equal(declaredAnswers([]), null);
});

// ---- the project's own delay and default (issue #269) -------------------------

const CHOICE: CustomValue['cleared.question'] = {
  requestId: 'q1', questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
};
const project = async (settings: Partial<ProjectSettings>): Promise<SetupOptions> => {
  const base = await fakeEffects([]).settings();
  return { effects: { settings: async () => ({ ...base, ...settings }) } };
};

test('the project\'s [session] question_timeout_minutes is its questions\' delay, over the service\'s', async () => {
  const t = await asking(RECOMMENDED, { ...(await project({ questionTimeoutMinutes: 5 })), config: { questionTimeoutMs: 30 * MIN } });
  assert.equal(t.question().timeout?.at, new Date(t.asked + 5 * MIN).toISOString());
  assert.equal(t.question().timeout?.rule, undefined, 'the default rule is not written');
  await t.at(4 + 59 / 60);
  assert.equal(t.timedOut().length, 0);
  await t.at(5);
  assert.deepEqual(t.timedOut().map((e) => e.stage), ['lead']);
  await t.at(5 + QUESTION_LEAD_MINUTES);
  assert.deepEqual(t.timedOut().map((e) => e.stage), ['lead', 'default']);
  assert.equal(t.question().state, 'handled');
});

test('question_default = first: a choice with no recommended option takes its first, applied and said as the project\'s default', async () => {
  const t = await asking(CHOICE, await project({ questionDefault: 'first' }));
  assert.deepEqual(t.question().timeout?.answers, { 'Which database?': 'Postgres' });
  assert.equal(t.question().timeout?.rule, 'first');
  await t.at(30);
  await t.at(40);
  assert.equal(t.question().state, 'handled');
  assert.deepEqual(JSON.parse(t.ledger('question_default')[0]!.detail).answers, { 'Which database?': 'Postgres' });
  const comment = (await t.tickets.comments(t.ticket.id)).find((c) => /default answer applies/.test(c.body))?.body ?? '';
  assert.match(comment, /the project's default answer applies/);
  assert.match(comment, /Which database\?: Postgres/);
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release');
});

test('question_default = park: even a recommended option is not applied, the ticket is parked and says why', async () => {
  const t = await asking(RECOMMENDED, await project({ questionDefault: 'park' }));
  assert.equal(t.question().timeout?.answers, null);
  assert.equal(t.question().timeout?.rule, 'park');
  await t.at(30);
  await t.at(40);
  const back = t.flowEvents.find((e): e is Extract<FlowEvent, { type: 'ticket_put_back' }> => e.type === 'ticket_put_back');
  assert.equal(back?.reason, 'parked');
  assert.match(back?.note ?? '', /the project's default is to park/);
  assert.equal(t.ledger('question_default').length, 0);
});

test('the default answers by rule: recommended is the declared answer, first falls back to each first option (one for a multiple choice), park and a free question give none', () => {
  const multi: Question = { question: 'Which checks?', multiSelect: true, options: [{ label: 'test' }, { label: 'lint' }] };
  assert.deepEqual(defaultAnswers(CHOICE.questions), null);
  assert.deepEqual(defaultAnswers(RECOMMENDED.questions, 'recommended'), declaredAnswers(RECOMMENDED.questions));
  assert.deepEqual(defaultAnswers([...RECOMMENDED.questions, ...CHOICE.questions, multi], 'first'), {
    'Which order?': 'Newest first (Recommended)', 'Which database?': 'Postgres', 'Which checks?': 'test',
  });
  assert.equal(defaultAnswers([...CHOICE.questions, ...FREE.questions], 'first'), null);
  assert.equal(defaultAnswers(RECOMMENDED.questions, 'park'), null);
  assert.equal(defaultAnswers([], 'first'), null);
});
