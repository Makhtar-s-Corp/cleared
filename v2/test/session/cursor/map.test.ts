// The Cursor mapper, on lines written from the documented format (fixtures.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorCall, createCursorMapper } from '../../../src/session/adapters/cursor/map.ts';
import { readToolInput, readToolOutput, type AgUiEvent, type ToolArgsEvent, type ToolResultEvent } from '../../../src/session/events.ts';
import { init, readDone, readStarted, resultLine, says, shellStarted, userLine, writeDone, writeStarted } from './fixtures.ts';

const SESSION = '0b7e6f2c-3d4a-4e5f-8a9b-1c2d3e4f5a6b';
const types = (events: AgUiEvent[]) => events.map((event) => (event.type === 'CUSTOM' ? event.name : event.type));

test('a turn: the text, a read, a write, the result; no token count, no cost, and the model alone as usage', () => {
  const mapper = createCursorMapper({ sessionId: SESSION });
  mapper.start('sonnet-4.5');
  const events = [
    ...mapper.beginTurn(),
    ...[init(), userLine(), says('I will look.'), readStarted('c1', 'src/a.ts'), readDone('c1', 'src/a.ts', 'hello'), writeStarted('c2', 'src/a.ts', 'a\nb\n'), writeDone('c2', 'src/a.ts', 'a\nb\n'), says('Done.'), resultLine('Done.')].flatMap((line) => mapper.line(line)),
  ];
  assert.deepEqual(types(events).filter((type) => !type.startsWith('STATE')), [
    'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
    'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
    'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
    'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
  ]);
  const args = events.filter((event): event is ToolArgsEvent => event.type === 'TOOL_CALL_ARGS');
  assert.deepEqual(readToolInput(args[0] as ToolArgsEvent), { kind: 'read', path: 'src/a.ts' });
  assert.equal(readToolInput(args[1] as ToolArgsEvent)?.kind, 'edit');
  const results = events.filter((event): event is ToolResultEvent => event.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(readToolOutput(results[0] as ToolResultEvent), { kind: 'read', path: 'src/a.ts', bytes: 5 });
  const done = events.at(-3) ?? events[0];
  const finished = events.find((event) => event.type === 'RUN_FINISHED');
  assert.ok(finished && finished.type === 'RUN_FINISHED');
  assert.deepEqual(finished.usage, [{ model: 'sonnet-4.5' }]);
  assert.equal(finished.result.total_cost_usd, null);
  assert.equal(finished.result.stopReason, 'end_turn');
  assert.equal(mapper.state().files[0]?.path, 'src/a.ts');
  assert.equal(mapper.state().phase, 'waiting_human');
  assert.ok(done);
});

test('a result that is an error ends the turn with an error; a turn that died is reported without the program\'s words', () => {
  const mapper = createCursorMapper({ sessionId: SESSION });
  mapper.start('m');
  mapper.beginTurn();
  assert.deepEqual(types(mapper.line({ ...resultLine('x'), is_error: true, subtype: 'error' })).slice(0, 1), ['RUN_ERROR']);
  mapper.beginTurn();
  const failed = mapper.turnFailed('The Cursor program ended without an answer.', 'cursor_exit');
  assert.equal(failed[0]?.type, 'RUN_ERROR');
  assert.deepEqual(mapper.turnFailed('again', 'x'), [], 'nothing runs, nothing to fail');
});

test('lines outside a turn are ignored', () => {
  const mapper = createCursorMapper({ sessionId: SESSION });
  assert.deepEqual(mapper.line(says('late')), []);
});

test('Cursor\'s calls become the requests the policy reads, in the checkout', () => {
  assert.deepEqual(cursorCall(readStarted('c', 'src/a.ts'))?.request, { tool: 'Read', input: { file_path: '/workspace/src/a.ts' } });
  assert.deepEqual(cursorCall(readStarted('c', '/etc/passwd'))?.request, { tool: 'Read', input: { file_path: '/etc/passwd' } });
  assert.deepEqual(cursorCall(readStarted('c', '../x'))?.request, { tool: 'Read', input: { file_path: '/x' } });
  assert.deepEqual(cursorCall(writeStarted('c', '.env', 'K=v'))?.request, { tool: 'Write', input: { file_path: '/workspace/.env', content: 'K=v' } });
  assert.deepEqual(cursorCall(shellStarted('c', 'npm test'))?.request, { tool: 'Bash', input: { command: 'npm test' } });
  const unknown = cursorCall({ type: 'tool_call', subtype: 'started', call_id: 'c', tool_call: { deleteToolCall: { args: { path: 'a' } } } });
  assert.equal(unknown?.request.tool, 'delete');
  assert.equal(cursorCall({ type: 'tool_call', subtype: 'started', tool_call: {} }), undefined);
});
