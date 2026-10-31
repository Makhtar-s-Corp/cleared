import test from 'node:test';
import assert from 'node:assert/strict';
import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import { createCleaner } from '../../src/session/clean.ts';
import { CUSTOM_NAMES, EVENT_TYPES, STEP_NAMES, isSubsetType, readToolInput, readToolOutput, toolArgs, toolResult, type AgUiEvent, type SessionState } from '../../src/session/events.ts';

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
  // plan_gate: the session plan waiting for its Go, measured apart from the author's work (lane 17).
  assert.deepEqual([...STEP_NAMES], ['workspace', 'author', 'waiting_human', 'review', 'approval', 'release', 'watch', 'plan_gate']);
  assert.deepEqual([...CUSTOM_NAMES], [
    'cleared.permission_request', 'cleared.permission_answered', 'cleared.question', 'cleared.answered', 'cleared.review_verdict', 'cleared.handover_captured',
    // Milestone 2, section 3.1.
    'cleared.host_call', 'cleared.context_usage', 'cleared.compacted', 'cleared.rate_limit', 'cleared.lead_refreshed',
    // The replanned milestone 2 (lane 17): the session plan and the author's report of its changes
    // (decisions 22 and 23), and the four names lane 31 emits (decisions 32 and 33).
    'cleared.session_plan', 'cleared.changes',
    'cleared.terminal_opened', 'cleared.terminal_input', 'cleared.terminal_closed', 'cleared.human_edit',
    // Milestone 3: the author-reviewer channel (issue 291).
    'cleared.review_channel',
    // Milestone 3: the author's branch at each step, and a resume from a step (issue #272).
    'cleared.checkpoint', 'cleared.replay',
    // Milestone 3: the notes between the sessions of a ticket's steps (M4).
    'cleared.step_note', 'cleared.step_notes_read',
    // Milestone 3: an author handed over to the other harness (B6.3).
    'cleared.handed_over',
    // Milestone 3: the proof receipt's captures (P210, issue #326).
    'cleared.proof_captured',
    // Milestone 3: the production page checked after a release landed (P218, issue #334).
    'cleared.production_checked',
    // Milestone 5: a session waits for its service's prepared image (C15, issue #422).
    'cleared.prepared_image',
    // Issue #501: the step of its plan the author says it has reached.
    'cleared.plan_step',
    'cleared.publish_failed',
    // Milestone 6: the session's container recreated after it stopped (issue #453).
    'cleared.container_recreated',
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

// The cleaner keeps a CUSTOM value whose name it knows, cleaned: the new
// names reach the store with their numbers and their cleaned input.
test('the milestone 2 custom events go through the cleaner with their values', () => {
  const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
  const cleaner = createCleaner({ secrets: [token] });
  const events: AgUiEvent[] = [
    { type: 'CUSTOM', name: 'cleared.context_usage', value: { totalTokens: 90_000, maxTokens: 200_000, rawMaxTokens: 200_000, percent: 45, autoCompactThreshold: 92, isAutoCompactEnabled: true } },
    { type: 'CUSTOM', name: 'cleared.host_call', value: { toolCallId: 'toolu_01AbCdEfGhIjKlMn', name: 'commit', input: { text: `remind with ${token}`, due: '2026-10-23T08:00:00.000Z' }, outcome: 'ok' } },
    { type: 'CUSTOM', name: 'cleared.host_call', value: { toolCallId: 'toolu_01AbCdEfGhIjKlMo', name: 'fulfil', input: { id: 'c9', note: 'done' }, outcome: 'refused', message: 'the commitment c9 is not open' } },
    { type: 'CUSTOM', name: 'cleared.compacted', value: { trigger: 'auto', preTokens: 150_000, postTokens: 30_000 } },
    { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent: 41.5, resetsAt: '2026-10-27T00:00:00.000Z' } },
    { type: 'CUSTOM', name: 'cleared.lead_refreshed', value: { generation: 3, reason: 'handover_point', handoverId: 'h2' } },
  ];
  const out = events.flatMap((event) => cleaner.clean(event));
  assert.equal(out.length, events.length);
  const [usage, call, refused, compacted, rate, refreshed] = out as Extract<AgUiEvent, { type: 'CUSTOM' }>[];
  assert.deepEqual(usage?.value, events[0]?.type === 'CUSTOM' ? events[0].value : undefined);
  assert.ok(call?.name === 'cleared.host_call');
  assert.ok(!JSON.stringify(call.value).includes(token), 'the input is cleaned');
  assert.deepEqual([call.value.name, call.value.outcome, (call.value.input as { due: string }).due], ['commit', 'ok', '2026-10-23T08:00:00.000Z']);
  assert.ok(refused?.name === 'cleared.host_call');
  assert.equal(refused.value.message, 'the commitment c9 is not open');
  assert.deepEqual([compacted?.name, rate?.name, refreshed?.name], ['cleared.compacted', 'cleared.rate_limit', 'cleared.lead_refreshed']);
  const state: SessionState = { status: 'Waiting', phase: 'working', steps: [], files: [], checks: [], usage: {}, context: { percent: 45, totalTokens: 90_000, maxTokens: 200_000 } };
  assert.equal(state.context?.percent, 45);
});

test('the events of lane 17 and lane 31 carry what their readers need, and never a file\'s content', () => {
  const at = '2026-10-23T08:00:00.000Z';
  const events: AgUiEvent[] = [
    { type: 'CUSTOM', name: 'cleared.session_plan', value: { steps: ['Sort'], files: ['src/entries.ts'], confidence: 'high', reason: 'One function.', proposedAt: at, go: { by: 'delay', at } } },
    { type: 'CUSTOM', name: 'cleared.changes', value: { groups: [{ intent: 'Sort', files: ['src/entries.ts'] }, { intent: 'Other changes', files: ['README.md'] }] } },
    { type: 'CUSTOM', name: 'cleared.terminal_opened', value: { by: 'u1', cols: 120, rows: 32 } },
    { type: 'CUSTOM', name: 'cleared.terminal_input', value: { by: 'u1', line: 'git status' } },
    { type: 'CUSTOM', name: 'cleared.terminal_closed', value: { by: 'u1', reason: 'give_back', outputBytes: 2048 } },
    { type: 'CUSTOM', name: 'cleared.human_edit', value: { by: 'u1', path: 'src/page.ts', added: 1, removed: 1, before: 'a'.repeat(64), after: 'b'.repeat(64), via: 'editor' } },
    { type: 'CUSTOM', name: 'cleared.plan_step', value: { step: 2, total: 5 } },
  ];
  assert.equal(events.length, 7);
  const edit = events[5] as Extract<AgUiEvent, { name: 'cleared.human_edit' }>;
  assert.deepEqual(Object.keys(edit.value).sort(), ['added', 'after', 'before', 'by', 'path', 'removed', 'via'], 'a human edit is journaled without its content');
  const closed = events[4] as Extract<AgUiEvent, { name: 'cleared.terminal_closed' }>;
  assert.ok(!('output' in closed.value), 'the terminal\'s output is never stored, only its byte count');
});
