// The fast lane kept from v1 (matrix B2.2, the first plan of milestone 2,
// decision 15): a Quick ticket is judged by v1's rules (lib/fast-lane.mjs)
// on its real diff, after each author session and again at the head it
// publishes. A rule it breaks sends it back to the full circuit for good:
// the card says why, the lead is told, and every later author session runs
// on the full author model, never a resumed Haiku. The approval is asked
// while the checks run, and the lock's merge waits for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CustomValue } from '../../src/session/events.ts';
import type { ReleaseItem } from '../../src/api/types.ts';
import { FlowEngine, type FastVerdict, type FlowEffects, type MergeOutcome } from '../../src/flow/engine.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import { describeFlowEvent } from '../../src/lead/prompts.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { REPORT_FIX, REPORT_PASS, finished, quickAuthor, reviewerScript, setup, started, text, until, type Scripts, type Setup } from './support.ts';

const FAST: FastVerdict = { state: 'fast', reasons: [], keep: true, head: 'abc123', lines: 3, files: 1 };
const OUTSIDE: FastVerdict = { state: 'full', reasons: ['outside_safe', 'file_type'], keep: true, head: 'abc123', lines: 12, files: 1, first: 'outside_safe: src/entries.ts; file_type: src/entries.ts' };
const OFF: FastVerdict = { state: 'full', reasons: ['disabled'], keep: false };

type Judged = Parameters<NonNullable<FlowEffects['fastLane']>>[0];

// The rules played by a list of verdicts, then FAST; every call kept.
function rules(verdicts: (FastVerdict | Error)[]) {
  const calls: Judged[] = [];
  const effect: FlowEffects['fastLane'] = async (input) => {
    calls.push(input);
    const next = verdicts.shift() ?? FAST;
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, effect };
}

async function quick(options: { verdicts?: (FastVerdict | Error)[]; scripts?: Scripts; effects?: Partial<FlowEffects>; labels?: string[] } = {}) {
  const judged = rules(options.verdicts ?? []);
  const t = await setup({ scripts: options.scripts ?? { author: quickAuthor }, effects: { fastLane: judged.effect, ...options.effects } });
  const ticket = await t.tickets.create({ title: 'A troubleshooting section', body: 'Say what to do when the database does not answer.', project: 'guestbook', labels: options.labels ?? ['Quick'] }, { kind: 'human', id: 'u1' });
  return { t, ticket, judged };
}

const release = (t: Setup) => t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release' && i.state === 'waiting');
const of = <K extends FlowEvent['type']>(t: Setup, type: K) => t.flowEvents.filter((e): e is Extract<FlowEvent, { type: K }> => e.type === type);
const models = (t: Setup) => t.startedSessions.map((s) => `${s.input.role}:${s.input.model}`);

async function toRelease(t: Setup, id: string): Promise<ReleaseItem> {
  await t.engine.start(id, 'u1');
  await until(() => release(t) !== undefined, 'the release item', 5000);
  await t.engine.settled();
  return release(t) as ReleaseItem;
}

test('a Quick ticket the rules keep fast is judged after its author and at the head it publishes, and its card says so', async () => {
  const { t, ticket, judged } = await quick();
  const card = await toRelease(t, ticket.id);
  assert.deepEqual(judged.calls.map((c) => ({ ticket: c.ticket, ...(c.workdir ? { workdir: c.workdir } : {}), ...(c.head ? { head: c.head } : {}) })), [
    { ticket: ticket.id, workdir: `/work/${ticket.id}` },
    { ticket: ticket.id, head: 'abc123' },
  ], 'the session\'s branch, then the published head');
  assert.deepEqual(card.fastLane, { state: 'fast', reasons: [] });
  assert.deepEqual(models(t), ['author:claude-haiku-5-5', 'reviewer:claude-sonnet-5-5'], 'the review stays the full circuit\'s');
  assert.deepEqual(of(t, 'fast_lane_fallback'), []);
  await t.engine.close();
});

test('the approval is asked while the checks run: the owner\'s Go is taken then, and the lock\'s merge waits for the checks', async () => {
  let checks: ReleaseItem['pr']['checks'] = 'pending';
  const merges: MergeOutcome['outcome'][] = [];
  const { t, ticket } = await quick({
    effects: {
      async prChecks() { return checks; },
      // As merge-pr.sh: a pull request whose checks still run is kept in the queue.
      async mergeRelease() { const outcome = checks === 'passed' ? 'merged' : 'queued'; merges.push(outcome); return { outcome, message: outcome === 'queued' ? 'a check still runs' : '' }; },
    },
  });
  const card = await toRelease(t, ticket.id);
  assert.equal(card.pr.checks, 'pending', 'the card is in the inbox before the checks end');
  t.clock.now += 61_000;
  await t.engine.tick();
  assert.equal(release(t)?.pr.checks, 'pending');
  await t.tickets.recordApproval(ticket.id, { kind: 'human', id: 'u1' });
  await t.engine.tick();
  await t.engine.settled();
  assert.equal(of(t, 'release_approved').length, 1, 'the Go is the owner\'s, given while the checks run');
  // The approval route asks the lock first; the flow asks again an interval later.
  t.clock.now += 60_000;
  await t.engine.tick();
  await t.engine.settled();
  assert.deepEqual(merges, ['queued'], 'the lock keeps it until they are green');
  assert.deepEqual(of(t, 'release_merged'), []);
  checks = 'passed';
  t.clock.now += 60_000;
  await t.engine.tick();
  await t.engine.settled();
  assert.deepEqual(merges, ['queued', 'merged']);
  assert.equal(of(t, 'release_merged').length, 1);
  await t.engine.close();
});

test('a rule the author\'s change breaks sends the ticket back to the full circuit: said once, the lead told, the next author on the full model', async () => {
  const { t, ticket, judged } = await quick({ verdicts: [OUTSIDE], scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] } });
  const card = await toRelease(t, ticket.id);
  assert.deepEqual(models(t), ['author:claude-haiku-5-5', 'reviewer:claude-sonnet-5-5', 'author:claude-opus-5-5'],
    'the light author is not resumed: a new author on the full model answers the review');
  assert.equal(judged.calls.length, 1, 'a ticket never comes back to the fast lane: it is not judged again');
  const fallback = of(t, 'fast_lane_fallback');
  assert.equal(fallback.length, 1);
  assert.deepEqual({ reasons: fallback[0]!.reasons, head: fallback[0]!.head, lines: fallback[0]!.lines, files: fallback[0]!.files }, { reasons: ['outside_safe', 'file_type'], head: 'abc123', lines: 12, files: 1 });
  const comments = (await t.tickets.comments(ticket.id)).map((c) => c.body);
  assert.ok(comments.some((c) => /^Back to the full circuit: a file outside the safe list; a file of a type the fast lane does not take/.test(c)), comments.join('\n---\n'));
  assert.deepEqual(card.fastLane, { state: 'full', reasons: ['outside_safe', 'file_type'] });
  assert.equal(describeFlowEvent(fallback[0]!), `${fallback[0]!.at.slice(11, 16)} ${ticket.id}: back to the full circuit (outside_safe, file_type: outside_safe: src/entries.ts; file_type: src/entries.ts): its next authors run on the full author model.`,
    'the lead\'s line names the reasons and the first path, which the card never shows');
  await t.engine.close();
});

test('the published head is judged too: a rule broken there sends the ticket back, and its card says why', async () => {
  const { t, ticket } = await quick({ verdicts: [FAST, { ...OUTSIDE, reasons: ['too_many_lines'] }] });
  const card = await toRelease(t, ticket.id);
  assert.deepEqual(card.fastLane, { state: 'full', reasons: ['too_many_lines'] });
  assert.deepEqual(of(t, 'fast_lane_fallback').map((e) => e.reasons), [['too_many_lines']]);
  await t.engine.close();
});

test('the fast lane off, or a diff git cannot read, is the full circuit at that head only: no fallback, the light author resumed', async () => {
  const { t, ticket, judged } = await quick({
    verdicts: [OFF, new Error('the merge conflicts'), OFF],
    scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] },
  });
  const card = await toRelease(t, ticket.id);
  assert.deepEqual(models(t), ['author:claude-haiku-5-5', 'reviewer:claude-sonnet-5-5'], 'the author was resumed');
  assert.equal(judged.calls.length, 3, 'judged after each author turn and at the published head');
  assert.deepEqual(of(t, 'fast_lane_fallback'), []);
  assert.deepEqual(card.fastLane, { state: 'off', reasons: ['disabled'] }, 'what the published head was judged');
  await t.engine.close();
});

test('a ticket without the Quick label is never judged, and its card says nothing of a lane', async () => {
  const { t, ticket, judged } = await quick({ labels: [] });
  const card = await toRelease(t, ticket.id);
  assert.equal(judged.calls.length, 0);
  assert.equal(card.fastLane, undefined);
  assert.deepEqual(models(t), ['author:claude-opus-5-5', 'reviewer:claude-sonnet-5-5']);
  await t.engine.close();
});

const QUESTION: CustomValue['cleared.question'] = {
  requestId: 'q-1',
  questions: [{ question: 'Which section title?', header: 'Title', options: [{ label: 'Troubleshooting (Recommended)' }, { label: 'Help' }] }],
};

test('a team that asks the owner a question sends its Quick ticket back to the full circuit', async () => {
  const { t, ticket, judged } = await quick({ scripts: { author: [started, ...text('a1', 'One thing to settle.'), { question: QUESTION }, ...text('a2', 'Done.'), finished(0.3)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => of(t, 'question_raised').length === 1, 'the question');
  await until(() => of(t, 'fast_lane_fallback').length === 1, 'the fallback');
  assert.deepEqual(of(t, 'fast_lane_fallback')[0]!.reasons, ['asked']);
  assert.equal(judged.calls.length, 0);
  await t.engine.close();
});

test('a ticket sent back stays on the full circuit after a restart: a new engine starts its next author on the full model', async () => {
  const { t, ticket } = await quick({ verdicts: [OUTSIDE] });
  await toRelease(t, ticket.id);
  await t.engine.close();
  await t.tickets.move(ticket.id, t.tickets.states.todo, { kind: 'human', id: 'u1' });
  const again = new FlowEngine(t.deps);
  const before = t.startedSessions.length;
  await again.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length > before, 'the new author');
  assert.equal(t.startedSessions[before]!.input.model, 'claude-opus-5-5');
  await again.settled();
  await again.close();
});

const service = (name: string): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null,
});

test('a Quick ticket of several services is never fast: it goes back to the full circuit without a reading', async () => {
  const judged = rules([]);
  const workspace: WorkspaceConfig = { id: 'guestbook', name: 'Guestbook', file: null, services: [service('guestbook'), service('filter-api')] };
  const t = await setup({ scripts: { author: quickAuthor }, config: { workspace }, effects: { fastLane: judged.effect } });
  const ticket = await t.tickets.create({ title: 'Two services', project: 'guestbook', labels: ['Quick'], services: ['guestbook', 'filter-api'] }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 2, 'the review');
  await t.engine.settled();
  assert.deepEqual(of(t, 'fast_lane_fallback').map((e) => e.reasons), [['several_services']]);
  assert.equal(judged.calls.length, 0);
  await t.engine.close();
});
