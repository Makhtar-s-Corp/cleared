import test from 'node:test';
import assert from 'node:assert/strict';
import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import { CUSTOM_NAMES, EVENT_TYPES, STEP_NAMES, isSubsetType, readToolInput, readToolOutput, toolArgs, toolResult } from '../../src/session/events.ts';

test('every event type of the subset is a member of AG-UI 1.0 EventType (@ag-ui/core 1.0.3)', () => {
  assert.equal(PROTOCOL_VERSION, '1.0');
  const known = new Set<string>(Object.values(EventType));
  for (const type of EVENT_TYPES) assert.ok(known.has(type), `${type} is not an AG-UI event type`);
});

test('the subset is the one of the plan, section 4, and leaves out what it says is not used', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [
    'CUSTOM', 'REASONING_END', 'REASONING_START', 'RUN_ERROR', 'RUN_FINISHED', 'RUN_STARTED',
    'STATE_DELTA', 'STATE_SNAPSHOT', 'STEP_FINISHED', 'STEP_STARTED',
    'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'TEXT_MESSAGE_START',
    'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'TOOL_CALL_START',
  ]);
  for (const type of ['TEXT_MESSAGE_CHUNK', 'TOOL_CALL_CHUNK', 'MESSAGES_SNAPSHOT', 'ACTIVITY_SNAPSHOT', 'ACTIVITY_DELTA', 'SUBAGENT_STARTED', 'SUBAGENT_FINISHED', 'SUBAGENT_ERROR', 'RAW']) {
    assert.ok(!isSubsetType(type), type);
  }
  assert.ok(isSubsetType('RUN_STARTED'));
});

test('the measured steps and the custom names are the plan\'s', () => {
  assert.deepEqual([...STEP_NAMES], ['workspace', 'author', 'waiting_human', 'review', 'approval', 'release', 'watch']);
  assert.deepEqual([...CUSTOM_NAMES], [
    'cleared.permission_request', 'cleared.permission_answered', 'cleared.question', 'cleared.answered', 'cleared.review_verdict', 'cleared.handover_captured',
  ]);
});

test('tool arguments and results travel as AG-UI strings and read back typed', () => {
  const args = toolArgs('t1', { kind: 'edit', path: 'src/app.ts', added: 2, removed: 1 });
  assert.equal(args.type, 'TOOL_CALL_ARGS');
  assert.equal(typeof args.delta, 'string');
  assert.deepEqual(readToolInput(args), { kind: 'edit', path: 'src/app.ts', added: 2, removed: 1 });
  const result = toolResult('m1', 't1', { kind: 'read', path: 'a', bytes: 3 });
  assert.equal(result.role, 'tool');
  assert.equal(typeof result.content, 'string');
  assert.deepEqual(readToolOutput(result), { kind: 'read', path: 'a', bytes: 3 });
  assert.equal(readToolInput({ type: 'TOOL_CALL_ARGS', toolCallId: 'x', delta: 'not json' }), undefined);
});
