// The author's host tools (docs/v2/milestone-2-plan.md, decisions 22 and
// 23, lane 17): declared as data like the lead's, and the checks their
// handlers run before anything is journaled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_TOOLS, OTHER_CHANGES, bindAuthorTools, readChangesReport, readPlanStep, readSessionPlan } from '../../src/flow/author-tools.ts';
import { HostToolRefused } from '../../src/session/contract.ts';

const refused = (pattern: RegExp) => (error: unknown) => error instanceof HostToolRefused && pattern.test(error.message);

test('the author has three host tools, declared as data, each an object schema the runner can give the model', () => {
  assert.deepEqual(AUTHOR_TOOLS.map((tool) => tool.name), ['propose_session_plan', 'report_plan_step', 'report_changes']);
  for (const tool of AUTHOR_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20, `${tool.name} says what it is for`);
    assert.ok(!/terminal|\/files/.test(JSON.stringify(tool)), 'no host tool names a terminal or a file write route');
  }
  const plan = AUTHOR_TOOLS[0]!.inputSchema;
  assert.deepEqual([...plan.required ?? []].sort(), ['confidence', 'files', 'reason', 'steps']);
  assert.deepEqual((plan.properties.confidence as { enum?: readonly string[] }).enum, ['low', 'medium', 'high']);
});

test('report_plan_step takes the number of a step, not its words, and its schema says so (issue #501)', () => {
  const tool = AUTHOR_TOOLS.find((one) => one.name === 'report_plan_step')!;
  assert.deepEqual(tool.inputSchema.required, ['step']);
  assert.equal((tool.inputSchema.properties.step as { type?: string }).type, 'integer');
  assert.match(tool.description, /each time you start/i);
});

test('a reported step is a whole number of the plan, from one; anything else is refused with what the plan holds (issue #501)', () => {
  assert.equal(readPlanStep({ step: 1 }, 5), 1);
  assert.equal(readPlanStep({ step: 5 }, 5), 5);
  for (const step of [0, 6, -1, 2.5, '2', null, undefined, Number.NaN]) {
    assert.throws(() => readPlanStep({ step }, 5), refused(/5 steps/), String(step));
  }
  assert.throws(() => readPlanStep(null, 1), refused(/1 step\b/));
});

test('the plan\'s steps are asked for a person: no command, file name or path, in the schema the model reads (issue #501)', () => {
  const steps = AUTHOR_TOOLS[0]!.inputSchema.properties.steps as { description?: string };
  assert.match(steps.description ?? '', /person/);
  assert.match(steps.description ?? '', /no command/i);
  assert.match(steps.description ?? '', /file name/i);
  assert.match(steps.description ?? '', /path/i);
  assert.match(steps.description ?? '', /language your first message names/);
});

test('bindAuthorTools gives the tools of the handlers given, in the contract\'s order', async () => {
  const calls: string[] = [];
  const tools = bindAuthorTools({
    report_changes: async (input) => { calls.push(`report:${input.groups.length}`); return 'kept'; },
    propose_session_plan: async (input) => { calls.push(`plan:${input.confidence}`); return 'recorded'; },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ['propose_session_plan', 'report_changes']);
  const context = { sessionId: 's1', turn: 'run' };
  assert.equal(await tools[0]!.handle({ steps: ['Sort'], files: ['src/entries.ts'], confidence: 'high', reason: 'One function.' }, context), 'recorded');
  assert.equal(await tools[1]!.handle({ groups: [{ intent: 'Sort', files: ['src/entries.ts'] }] }, context), 'kept');
  assert.deepEqual(calls, ['plan:high', 'report:1']);
  assert.deepEqual(bindAuthorTools({}).map((tool) => tool.name), []);
});

test('a session plan has steps, files, a confidence of low, medium or high, and its reason', () => {
  const plan = readSessionPlan({ steps: [' Sort the entries ', 'Test it'], files: ['src/entries.ts'], confidence: 'medium', reason: 'Two files, one of them a test.' });
  assert.deepEqual(plan, { steps: ['Sort the entries', 'Test it'], files: ['src/entries.ts'], confidence: 'medium', reason: 'Two files, one of them a test.' });
  assert.throws(() => readSessionPlan({ steps: ['Sort'], files: [], confidence: 'certain', reason: 'x' }), refused(/low, medium or high/));
  assert.throws(() => readSessionPlan({ steps: [], files: [], confidence: 'high', reason: 'x' }), refused(/at least one step/));
  assert.throws(() => readSessionPlan({ steps: ['Sort'], files: [], confidence: 'high', reason: '  ' }), refused(/reason/));
  assert.throws(() => readSessionPlan({ steps: 'Sort', files: [], confidence: 'high', reason: 'x' }), refused(/steps/));
  assert.throws(() => readSessionPlan({ steps: Array.from({ length: 31 }, (_, i) => `step ${i}`), files: [], confidence: 'high', reason: 'x' }), refused(/30 steps/));
  assert.throws(() => readSessionPlan({ steps: ['x'.repeat(501)], files: [], confidence: 'high', reason: 'x' }), refused(/500 characters/));
  // A path is the checkout's, relative: the container's mount point is taken off, and a path outside the checkout is refused.
  assert.deepEqual(readSessionPlan({ steps: ['Sort'], files: ['/workspace/src/entries.ts', './test/a.test.ts'], confidence: 'low', reason: 'x' }).files, ['src/entries.ts', 'test/a.test.ts']);
  assert.throws(() => readSessionPlan({ steps: ['Sort'], files: ['../other/secret.ts'], confidence: 'low', reason: 'x' }), refused(/inside the checkout/));
});

test('report_changes refuses a file in two groups, and the changed files no group names go to "Other changes"', () => {
  assert.equal(OTHER_CHANGES, 'Other changes');
  const changed = ['src/entries.ts', 'test/entries.test.ts', 'README.md'];
  const report = readChangesReport({ groups: [{ intent: 'Sort the entries newest first', files: ['src/entries.ts', '/workspace/test/entries.test.ts'] }] }, changed);
  assert.deepEqual(report, { groups: [
    { intent: 'Sort the entries newest first', files: ['src/entries.ts', 'test/entries.test.ts'] },
    { intent: 'Other changes', files: ['README.md'] },
  ] });
  // Every changed file named: no "Other changes" group.
  assert.deepEqual(readChangesReport({ groups: [{ intent: 'Sort', files: changed }] }, changed).groups.map((g) => g.intent), ['Sort']);
  // A file in two groups is refused, by name.
  assert.throws(() => readChangesReport({ groups: [{ intent: 'Sort', files: ['src/entries.ts'] }, { intent: 'Test', files: ['src/entries.ts', 'test/entries.test.ts'] }] }, changed), refused(/src\/entries\.ts.*two groups|two groups.*src\/entries\.ts/));
  // The same file twice in one group is one file.
  assert.deepEqual(readChangesReport({ groups: [{ intent: 'Sort', files: ['README.md', 'README.md'] }] }, ['README.md']).groups, [{ intent: 'Sort', files: ['README.md'] }]);
  // A file the journal does not know (written by a command) is kept where the author put it.
  assert.deepEqual(readChangesReport({ groups: [{ intent: 'Data', files: ['data/seed.json'] }] }, []).groups, [{ intent: 'Data', files: ['data/seed.json'] }]);
  assert.throws(() => readChangesReport({ groups: [{ intent: '', files: ['a'] }] }, []), refused(/intent/));
  assert.throws(() => readChangesReport({ groups: 'all' }, []), refused(/groups/));
  assert.throws(() => readChangesReport({ groups: [{ intent: 'Other changes', files: ['a'] }] }, []), refused(/Other changes/));
});
