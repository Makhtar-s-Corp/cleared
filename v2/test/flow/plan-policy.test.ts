// The policy of an author whose session plan waits for its Go (P29, milestone 2
// decision 22): the engine's policyFor sets `planning` from the gate, so the
// rule `plan.before_go` (session/policy.ts) reaches the real harness's
// evaluations, and ends with the Go.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionPlanItem } from '../../src/api/types.ts';
import { evaluate } from '../../src/session/policy.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { fakeEffects, finished, setup, started, text, until, type Setup } from './support.ts';

const proposal: FakeStep = {
  hostCall: { toolCallId: 'plan-1', name: 'propose_session_plan', input: { steps: ['Sort the entries'], files: ['src/entries.ts'], confidence: 'medium', reason: 'One function.' } },
};
const script = [started, ...text('p1', 'Here is my plan.'), proposal, finished(0.1), { awaitMessage: true }, started, ...text('a1', 'Done.'), finished(0.3)] as const;

const bash = (command: string) => ({ tool: 'Bash', input: { command } });
const edit = { tool: 'Edit', input: { file_path: '/workspace/src/entries.ts', old_string: 'a', new_string: 'b' } };
const handover = { tool: 'Write', input: { file_path: '/workspace/HANDOVER.md', content: 'x' } };

async function gated(): Promise<Setup> {
  return setup({ scripts: { author: script }, config: { authorTools: true }, effects: { settings: async () => fakeEffects([]).settings() } });
}
const waiting = (t: Setup) => t.inbox.items().find((i): i is SessionPlanItem => i.kind === 'session_plan' && i.state === 'waiting');

test('an author whose plan waits for its Go changes nothing but its HANDOVER.md, through policyFor', async () => {
  const t = await gated();
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => waiting(t) !== undefined, 'the session plan in the inbox');
  await t.engine.settled();
  const author = t.startedSessions[0]!;
  const policy = () => t.engine.policyFor(author.input);
  assert.equal(policy().planning, true);
  assert.equal(t.engine.policyFor({ ...author.input }).planning, true, 'an adapter\'s copy of the input is held too');
  for (const request of [edit, bash('git commit -m wip'), bash('git add .'), bash('git push origin x'), bash('git checkout main'), bash('rm src/entries.ts')]) {
    const verdict = evaluate(request, policy());
    assert.deepEqual([verdict.decision, 'rule' in verdict ? verdict.rule : undefined], ['deny', 'plan.before_go'], JSON.stringify(request));
  }
  assert.deepEqual(evaluate(handover, policy()), { decision: 'allow', rule: 'edit.workdir' });
  assert.notEqual(evaluate(bash('git status'), policy()).decision, 'deny');
  await t.engine.close();
});

test('the Go lifts the rule: the author edits once its plan has its Go', async () => {
  const t = await gated();
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => waiting(t) !== undefined, 'the session plan in the inbox');
  await t.engine.settled();
  const author = t.startedSessions[0]!;
  await t.engine.planGo(author.id, 'u1');
  await t.engine.settled();
  assert.notEqual(t.engine.policyFor(author.input).planning, true);
  const verdict = evaluate(edit, t.engine.policyFor(author.input));
  assert.notEqual('rule' in verdict ? verdict.rule : undefined, 'plan.before_go');
  assert.equal(verdict.decision, 'allow');
  await t.engine.close();
});

test('a session of a configuration without a plan is never held', async () => {
  const t = await setup({ scripts: { author: [started, ...text('a1', 'Done.'), finished(0.3)] } });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  assert.notEqual(t.engine.policyFor(author.input).planning, true);
  await t.engine.close();
});
