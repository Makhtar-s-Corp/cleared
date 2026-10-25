// The Codex mapper on exec --json lines (fixtures.ts says which are recorded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexCalls, createCodexMapper, rateLimits, unwrapCommand, usageOf } from '../../../src/session/adapters/codex/map.ts';
import type { AgUiEvent } from '../../../src/session/events.ts';
import { commandDone, commandStarted, fileChange, says, threadStarted, tokenCount, turnCompleted, turnFailed, turnStarted, webSearch } from './fixtures.ts';

const kinds = (events: AgUiEvent[]) => events.map((event) => (event.type === 'CUSTOM' ? event.name : event.type));

test('a recorded turn: the answer as a message, then the end of the run with its usage and no cost', () => {
  const mapper = createCodexMapper({ sessionId: 's1' });
  mapper.start('gpt-6-luna');
  const events = [...mapper.beginTurn(), ...mapper.line(threadStarted()), ...mapper.line(turnStarted()), ...mapper.line(says('item_0', 'OK')), ...mapper.line(turnCompleted())];
  assert.deepEqual(kinds(events), ['RUN_STARTED', 'STATE_DELTA', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED', 'STATE_DELTA']);
  const finished = events.find((event) => event.type === 'RUN_FINISHED');
  assert.ok(finished?.type === 'RUN_FINISHED');
  assert.equal(finished.result.total_cost_usd, null, 'Codex reports no cost: nothing is estimated');
  assert.equal(finished.result.stopReason, 'end_turn');
  assert.deepEqual(finished.usage, [{ model: 'gpt-6-luna', inputTokens: 2490, outputTokens: 25, cachedInputTokens: 11520, cacheWriteInputTokens: 0 }]);
  assert.equal(mapper.state().phase, 'waiting_human');
  assert.equal(mapper.turn(), undefined);
});

test('the usage adds up to Codex\'s own total: the cached input is inside input_tokens, the reasoning inside output_tokens', () => {
  // A rollout's token_count line has total_tokens = input_tokens + output_tokens (invented numbers).
  const usage = usageOf({ input_tokens: 500000, cached_input_tokens: 400000, cache_write_input_tokens: 0, output_tokens: 3000, reasoning_output_tokens: 800 }, 'm');
  const sum = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0);
  assert.equal(sum, 503000, 'what consumption/usage.ts adds is total_tokens, the reasoning not counted twice');
  assert.deepEqual(usageOf(undefined, ''), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
  assert.equal(usageOf({ input_tokens: 5, cached_input_tokens: 9 }, 'm').inputTokens, 0, 'never below zero');
});

test('the session\'s usage is the sum of its turns: Codex reports each turn alone', () => {
  const mapper = createCodexMapper({ sessionId: 's1' });
  mapper.start('m');
  for (const input of [100, 300]) {
    mapper.beginTurn();
    mapper.line(turnCompleted({ input_tokens: input, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2 }));
  }
  assert.deepEqual(mapper.state().usage, { model: 'm', inputTokens: 320, outputTokens: 20, cachedInputTokens: 80, cacheWriteInputTokens: 0 });
});

test('a command: shown when it starts, its output and exit code when it ends; a failed one is an error', () => {
  const mapper = createCodexMapper({ sessionId: 's1' });
  mapper.start('m');
  mapper.beginTurn();
  const started = mapper.line(commandStarted('item_1', "bash -lc 'npm test'"));
  assert.deepEqual(kinds(started), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'STATE_DELTA']);
  assert.equal(mapper.state().status, 'Running npm test');
  const done = mapper.line(commandDone('item_1', "bash -lc 'npm test'", 'fail 1', 1));
  assert.deepEqual(kinds(done), ['TOOL_CALL_RESULT'], 'the call is not shown twice');
  const result = done[0];
  assert.ok(result?.type === 'TOOL_CALL_RESULT');
  assert.deepEqual(JSON.parse(result.content), { kind: 'execute', output: 'fail 1', cut: 0, isError: true });
});

test('the same item id in two turns is two calls, each shown with its own id and input (review r2 of pull request 300)', () => {
  const mapper = createCodexMapper({ sessionId: 's1' });
  mapper.start('m');
  mapper.beginTurn();
  const first = mapper.line(commandStarted('item_1', "bash -lc 'git log -1'"));
  mapper.line(turnCompleted());
  mapper.beginTurn();
  const second = mapper.line(commandStarted('item_1', "bash -lc 'npm test'"));
  assert.deepEqual(kinds(second), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'STATE_DELTA'], 'shown again: a new process, a new item');
  const id = (events: AgUiEvent[]) => events.find((event) => event.type === 'TOOL_CALL_START')?.type === 'TOOL_CALL_START' ? (events[0] as { toolCallId: string }).toolCallId : '';
  assert.notEqual(id(first), id(second));
  assert.equal(mapper.state().status, 'Running npm test');
  const done = mapper.line(commandDone('item_1', "bash -lc 'npm test'", 'ok'));
  const result = done.find((event) => event.type === 'TOOL_CALL_RESULT');
  assert.ok(result?.type === 'TOOL_CALL_RESULT' && result.toolCallId === id(second), 'the result belongs to the second turn\'s call');
  assert.equal(JSON.parse(result.content).kind, 'execute');
});

test('a file change made: the call and the changed files; a delete is not a changed file', () => {
  const mapper = createCodexMapper({ sessionId: 's1' });
  mapper.start('m');
  mapper.beginTurn();
  const events = mapper.line(fileChange('item_2', [{ path: 'src/a.ts', kind: 'update' }, { path: '/workspace/src/b.ts', kind: 'add' }, { path: 'old.ts', kind: 'delete' }]));
  assert.deepEqual(kinds(events), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'STATE_DELTA', 'TOOL_CALL_RESULT', 'STATE_DELTA']);
  assert.deepEqual(mapper.state().files.map((file) => file.path), ['/workspace/src/a.ts', '/workspace/src/b.ts']);
});

test('the requests the policy evaluates: a wrapped command is read inside its shell, each changed file is one request', () => {
  assert.equal(unwrapCommand("bash -lc 'npm test'"), 'npm test');
  assert.equal(unwrapCommand("/bin/bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(unwrapCommand('sh -c "echo \\"x\\""'), 'echo "x"');
  assert.equal(unwrapCommand('git status'), 'git status');
  assert.equal(unwrapCommand("bash -lc 'a' extra"), "bash -lc 'a' extra", 'anything after the quoted command is read as it is');
  assert.deepEqual(codexCalls({ id: 'i', type: 'command_execution', command: ['bash', '-lc', 'git log -1'] })[0]?.request, { tool: 'Bash', input: { command: 'git log -1' } });
  assert.deepEqual(codexCalls(fileChange('i', [{ path: 'a', kind: 'update' }, { path: 'b', kind: 'delete' }]).item).map((call) => call.request.tool), ['Edit', 'Delete']);
  assert.deepEqual(codexCalls(webSearch('i', 'x').item)[0]?.request, { tool: 'WebSearch', input: { query: 'x' } });
  assert.deepEqual(codexCalls({ id: 'i', type: 'mcp_tool_call', server: 'srv', tool: 't', arguments: { a: 1 } })[0]?.request, { tool: 'mcp__srv__t', input: { a: 1 } });
  assert.deepEqual(codexCalls({ id: 'i', type: 'reasoning', text: 'x' }), []);
  assert.deepEqual(codexCalls({ type: 'command_execution', command: 'ls' }), [], 'no id, no call');
});

test('a failed turn ends with an error code, never Codex\'s own words', () => {
  const mapper = createCodexMapper({ sessionId: 's1' });
  mapper.start('m');
  mapper.beginTurn();
  const events = mapper.line(turnFailed('The model gpt-x is not supported, prompt: secret plans'));
  const error = events.find((event) => event.type === 'RUN_ERROR');
  assert.ok(error?.type === 'RUN_ERROR');
  assert.equal(error.code, 'codex_error');
  assert.ok(!error.message.includes('secret plans'));
  assert.equal(mapper.turn(), undefined);
});

test('rate limits: the week and the five hours from a rollout\'s token_count line, a percent already, said once per change', () => {
  const resets = Date.parse('2026-10-30T00:00:00Z') / 1000;
  assert.deepEqual(rateLimits(tokenCount({ used: 6, resets }, { used: 41.25, resets: resets - 3600 })), [
    { window: 'seven_day', usedPercent: 6, resetsAt: '2026-10-30T00:00:00.000Z' },
    { window: 'five_hour', usedPercent: 41.3, resetsAt: '2026-10-29T23:00:00.000Z' },
  ]);
  assert.deepEqual(rateLimits(tokenCount({ used: 6, resets }, null)).map((value) => value.window), ['seven_day'], 'a window Codex leaves out is not said');
  assert.deepEqual(rateLimits({ type: 'turn.completed', usage: {} }), [], 'the recorded exec stream carries none');
  assert.deepEqual(rateLimits({ rate_limits: { primary: { used_percent: 3, window_minutes: 60, resets_at: 1 } } }), [], 'an unknown window length is not guessed');
  const mapper = createCodexMapper({ sessionId: 's1' });
  assert.deepEqual(kinds(mapper.rateLimits(tokenCount({ used: 6, resets }, null))), ['cleared.rate_limit']);
  assert.deepEqual(mapper.rateLimits(tokenCount({ used: 6, resets }, null)), [], 'unchanged: nothing new');
  assert.deepEqual(kinds(mapper.rateLimits(tokenCount({ used: 7, resets }, null))), ['cleared.rate_limit']);
});

test('lines outside a turn are not mapped; a cancelled turn finishes as cancelled', () => {
  const mapper = createCodexMapper({ sessionId: 's1' });
  mapper.start('m');
  assert.deepEqual(mapper.line(says('item_0', 'late')), []);
  mapper.beginTurn();
  const cancelled = mapper.cancelled('waiting_human', 'Waiting for a message');
  const finished = cancelled.find((event) => event.type === 'RUN_FINISHED');
  assert.ok(finished?.type === 'RUN_FINISHED' && finished.outcome.type === 'cancelled' && finished.result.stopReason === 'cancelled');
  assert.deepEqual(kinds(mapper.cancelled('stopped', 'Stopped')), ['STATE_DELTA']);
});
