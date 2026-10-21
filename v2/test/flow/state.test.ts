import test from 'node:test';
import assert from 'node:assert/strict';
import { foldState } from '../../src/flow/state.ts';
import { toolArgs, toolResult, type AgUiEvent, type SessionEvent } from '../../src/session/events.ts';

function log(...events: AgUiEvent[]): SessionEvent[] {
  return events.map((event, i) => ({ seq: i + 1, at: new Date(Date.UTC(2026, 9, 21, 10, i)).toISOString(), sessionId: 's', ticket: 'LOCAL-1', project: 'guestbook', event }));
}

test('steps come from STEP events, a repeated step is a new entry, an open one has no end', () => {
  const state = foldState(log(
    { type: 'STEP_STARTED', stepName: 'workspace' }, { type: 'STEP_FINISHED', stepName: 'workspace' },
    { type: 'STEP_STARTED', stepName: 'author' },
    { type: 'STEP_STARTED', stepName: 'waiting_human' }, { type: 'STEP_FINISHED', stepName: 'waiting_human' },
    { type: 'STEP_STARTED', stepName: 'waiting_human' },
  ), 'waiting_human');
  assert.deepEqual(state.steps.map((s) => [s.name, s.finishedAt === null]), [['workspace', false], ['author', true], ['waiting_human', false], ['waiting_human', true]]);
  assert.equal(state.steps[0]?.startedAt, '2026-10-21T10:00:00.000Z');
  assert.equal(state.steps[0]?.finishedAt, '2026-10-21T10:01:00.000Z');
});

test('files add up the edits of one path, checks follow the test commands', () => {
  const state = foldState(log(
    { type: 'TOOL_CALL_START', toolCallId: 'e1', toolCallName: 'Edit' }, toolArgs('e1', { kind: 'edit', path: 'src/a.ts', added: 3, removed: 1 }),
    { type: 'TOOL_CALL_START', toolCallId: 'e2', toolCallName: 'Edit' }, toolArgs('e2', { kind: 'edit', path: 'src/a.ts', added: 2, removed: 0 }),
    { type: 'TOOL_CALL_START', toolCallId: 'e3', toolCallName: 'Write' }, toolArgs('e3', { kind: 'edit', path: 'src/b.ts', added: 5, removed: 0 }),
    { type: 'TOOL_CALL_START', toolCallId: 'r1', toolCallName: 'Bash' }, toolArgs('r1', { kind: 'execute', command: 'npm test' }),
    toolResult('m1', 'r1', { kind: 'execute', output: 'ok', cut: 0, isError: false }),
    { type: 'TOOL_CALL_START', toolCallId: 'r2', toolCallName: 'Bash' }, toolArgs('r2', { kind: 'execute', command: 'npm run typecheck' }),
    { type: 'TOOL_CALL_START', toolCallId: 'r3', toolCallName: 'Bash' }, toolArgs('r3', { kind: 'execute', command: 'ls' }),
  ), 'working');
  assert.deepEqual(state.files, [{ path: 'src/a.ts', added: 5, removed: 1 }, { path: 'src/b.ts', added: 5, removed: 0 }]);
  assert.deepEqual(state.checks, [{ name: 'npm test', state: 'passed' }, { name: 'npm run typecheck', state: 'pending' }]);
});

test('a failed test command is a failed check', () => {
  const state = foldState(log(
    { type: 'TOOL_CALL_START', toolCallId: 'r1', toolCallName: 'Bash' }, toolArgs('r1', { kind: 'execute', command: 'node --test' }),
    toolResult('m1', 'r1', { kind: 'execute', output: 'not ok', cut: 0, isError: true }),
  ), 'working');
  assert.deepEqual(state.checks, [{ name: 'node --test', state: 'failed' }]);
});

test('usage adds up every finished run', () => {
  const run = (cost: number): AgUiEvent => ({ type: 'RUN_FINISHED', threadId: 's', runId: 'r', outcome: { type: 'success' }, usage: [{ model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 10, cachedInputTokens: 50 }], result: { stopReason: 'end_turn', total_cost_usd: cost } });
  const state = foldState(log(run(0.1), run(0.2)), 'done');
  assert.deepEqual(state.usage, { model: 'claude-opus-5-5', inputTokens: 200, outputTokens: 20, cachedInputTokens: 100 });
});

test('the status phrase follows the phase, and the last tool call while working', () => {
  assert.equal(foldState([], 'waiting_human').status, 'Paused, waiting for you');
  assert.equal(foldState([], 'starting').status, 'Starting');
  assert.equal(foldState(log({ type: 'TOOL_CALL_START', toolCallId: 'r1', toolCallName: 'Bash' }, ), 'working').status, 'Working');
  const running = foldState(log({ type: 'TOOL_CALL_START', toolCallId: 'r1', toolCallName: 'Bash' }, toolArgs('r1', { kind: 'execute', command: 'npm test', description: 'Run the tests' })), 'working');
  assert.equal(running.status, 'Run the tests');
  assert.equal(foldState(log({ type: 'TOOL_CALL_START', toolCallId: 'x', toolCallName: 'Read' }, toolArgs('x', { kind: 'read', path: 'src/a.ts' })), 'working').status, 'Reading src/a.ts');
});
