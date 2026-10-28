// The mapping of the runner's lines to the event subset (milestone 1 plan,
// section 4), on a session recorded with the real CLI. fixtures/two-turns.jsonl
// is the runner's stdout, as `node /opt/cleared/runner/main.ts` printed it in
// a labelled session container on 2026-10-21 (Claude Code 2.1.306, SDK
// 0.3.306, claude-haiku-5-5), with its ids replaced by placeholders: UUIDs by
// 00000000-0000-4000-8000-<n>, toolu_, msg_ and req_ ids by <prefix>_<n>.
// Turn 1 asked for a Read, an Edit, `ls .` and `touch made.txt`; every
// request was allowed. Turn 2 asked which word replaced "old".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMapper, toolInput, toolRequest } from '../../../src/session/adapters/claude-code/map.ts';
import type { RunnerOutput } from '../../../images/session/runner/main.ts';
import { createCleaner } from '../../../src/session/clean.ts';
import type { Answer } from '../../../src/session/contract.ts';
import type { AgUiEvent } from '../../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS, evaluate, type Policy } from '../../../src/session/policy.ts';

const fixture = (name: string): RunnerOutput[] =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunnerOutput);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION = id(3);

const policy: Policy = {
  role: 'author', base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: '/run/cleared/claude.token',
  safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
};

// What the adapter does with each line, the inbox played by `human`.
function replay(lines: readonly RunnerOutput[], human: (requestId: string) => Answer, sends: ReadonlyMap<number, [string, string]>): AgUiEvent[] {
  const mapper = createMapper({ sessionId: SESSION });
  const cleaner = createCleaner();
  const raw: AgUiEvent[] = [...mapper.start('claude-haiku-5-5')];
  lines.forEach((line, index) => {
    const send = sends.get(index);
    if (send) raw.push(...mapper.userMessage(send[0], send[1], 'user-1'));
    if (line.type === 'permission_request') {
      const verdict = evaluate(toolRequest(line), policy);
      raw.push(...mapper.permissionRequest(line, verdict));
      const answer: Answer = verdict.decision === 'allow' ? { decision: { kind: 'allow_once' }, by: 'policy', rule: verdict.rule }
        : verdict.decision === 'deny' ? { decision: { kind: 'reject_once', message: verdict.message }, by: 'policy', rule: verdict.rule }
        : human(line.requestId);
      raw.push(...mapper.answered(line.requestId, answer));
    } else raw.push(...mapper.line(line));
  });
  return raw.flatMap((event) => cleaner.clean(event));
}

const text = (messageId: string, role: 'assistant' | 'user', delta: string, name?: string): AgUiEvent[] => [
  { type: 'TEXT_MESSAGE_START', messageId, role, ...(name ? { name } : {}) },
  { type: 'TEXT_MESSAGE_CONTENT', messageId, delta },
  { type: 'TEXT_MESSAGE_END', messageId },
];
const tool = (toolCallId: string, toolCallName: string, args: object, status: string): AgUiEvent[] => [
  { type: 'TOOL_CALL_START', toolCallId, toolCallName },
  { type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(args) },
  { type: 'TOOL_CALL_END', toolCallId },
  { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/status', value: status }] },
];
const result = (messageId: string, toolCallId: string, output: object): AgUiEvent =>
  ({ type: 'TOOL_CALL_RESULT', messageId, toolCallId, content: JSON.stringify(output), role: 'tool' });
const delta = (values: Record<string, unknown>): AgUiEvent =>
  ({ type: 'STATE_DELTA', delta: Object.entries(values).map(([key, value]) => ({ op: 'replace', path: `/${key}`, value })) });

test('a recorded two-turn session maps to the exact event list of section 4, cleaned', () => {
  const turn1 = 'Use the Read tool on notes.txt. Then use the Edit tool to replace the word old with new in notes.txt. Then use the Bash tool to run exactly: ls . Then use the Bash tool to run exactly: touch made.txt . Then reply DONE.';
  const turn2 = 'Which word replaced old? Reply with that one word.';
  const events = replay(fixture('two-turns.jsonl'), () => ({ decision: { kind: 'allow_once' }, by: 'user-1' }), new Map([[0, [id(1), turn1]], [17, [id(20), turn2]]]));

  const expected: AgUiEvent[] = [
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'Starting', phase: 'starting', steps: [], files: [], checks: [], usage: { model: 'claude-haiku-5-5' } } },
    ...text(id(1), 'user', turn1, 'user-1'),
    { type: 'RUN_STARTED', threadId: SESSION, runId: id(1) },
    delta({ phase: 'working', status: 'Working' }),
    ...tool('toolu_01', 'Read', { kind: 'read', path: 'notes.txt' }, 'Reading notes.txt'),
    // The rate_limit_event of the recording: its two unified windows.
    { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'five_hour', usedPercent: 26, resetsAt: '2026-10-21T20:30:00.000Z' } },
    { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent: 8, resetsAt: '2026-10-27T09:00:00.000Z' } },
    result(`${id(8)}-0`, 'toolu_01', { kind: 'read', path: 'notes.txt', bytes: 14 }),
    ...tool('toolu_02', 'Edit', { kind: 'edit', path: 'notes.txt', added: 1, removed: 1 }, 'Editing notes.txt'),
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: id(10), decision: 'allow_once', by: 'policy', rule: 'edit.workdir' } },
    result(`${id(11)}-0`, 'toolu_02', { kind: 'edit', ok: true }),
    delta({ files: [{ path: 'notes.txt', added: 1, removed: 1 }] }),
    ...tool('toolu_03', 'Bash', { kind: 'execute', command: 'ls .', description: 'List files in current directory' }, 'Running ls .'),
    result(`${id(13)}-0`, 'toolu_03', { kind: 'execute', output: 'notes.txt', cut: 0, isError: false }),
    ...tool('toolu_04', 'Bash', { kind: 'execute', command: 'touch made.txt', description: 'Create empty file made.txt' }, 'Running touch made.txt'),
    {
      type: 'CUSTOM', name: 'cleared.permission_request', value: {
        requestId: id(15), toolCallId: 'toolu_04', tool: 'Bash', input: { kind: 'execute', command: 'touch made.txt', description: 'Create empty file made.txt' },
        suggestion: { decision: 'ask', rule: 'default', reason: 'no rule allows this request' },
      },
    },
    delta({ phase: 'waiting_human', status: 'Waiting for you' }),
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: id(15), decision: 'allow_once', by: 'user-1' } },
    delta({ phase: 'working', status: 'Working' }),
    result(`${id(16)}-0`, 'toolu_04', { kind: 'execute', output: '', cut: 0, isError: false }),
    ...text(`${id(17)}-0`, 'assistant', 'DONE'),
    {
      type: 'RUN_FINISHED', threadId: SESSION, runId: id(1), outcome: { type: 'success' },
      usage: [{ model: 'claude-haiku-5-5', inputTokens: 8, outputTokens: 319, cachedInputTokens: 66525, cacheWriteInputTokens: 6588 }],
      result: { stopReason: 'end_turn', total_cost_usd: 0.0021431500000000003 },
    },
    delta({ phase: 'waiting_human', status: 'Waiting for a message', usage: { model: 'claude-haiku-5-5', inputTokens: 8, outputTokens: 319, cachedInputTokens: 66525, cacheWriteInputTokens: 6588 } }),
    ...text(id(20), 'user', turn2, 'user-1'),
    { type: 'RUN_STARTED', threadId: SESSION, runId: id(20) },
    delta({ phase: 'working', status: 'Working' }),
    ...text(`${id(24)}-0`, 'assistant', 'new'),
    {
      type: 'RUN_FINISHED', threadId: SESSION, runId: id(20), outcome: { type: 'success' },
      usage: [{ model: 'claude-haiku-5-5', inputTokens: 2, outputTokens: 3, cachedInputTokens: 18633, cacheWriteInputTokens: 80 }],
      result: { stopReason: 'end_turn', total_cost_usd: 0.0023471800000000004 },
    },
    delta({ phase: 'waiting_human', status: 'Waiting for a message', usage: { model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 322, cachedInputTokens: 85158, cacheWriteInputTokens: 6668 } }),
    delta({ phase: 'stopped', status: 'Stopped' }),
  ];
  assert.deepEqual(events, expected);
  // The read file's content is in the recording, never in the events.
  assert.ok(JSON.stringify(fixture('two-turns.jsonl')).includes('The old word.'));
  assert.ok(!JSON.stringify(events).includes('The old word'));
});

test('every Claude Code tool maps to its ACP kind (section 3), with the input the screen shows', () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ['Read', { file_path: '/workspace/src/a.ts', offset: 3 }, { kind: 'read', path: 'src/a.ts' }],
    ['Edit', { file_path: '/workspace/a.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nB2\nc' }, { kind: 'edit', path: 'a.ts', added: 2, removed: 1 }],
    ['Write', { file_path: '/workspace/new.ts', content: 'one\ntwo\n' }, { kind: 'edit', path: 'new.ts', added: 2, removed: 0 }],
    ['MultiEdit', { file_path: '/workspace/a.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p\nq', new_string: '' }] }, { kind: 'edit', path: 'a.ts', added: 1, removed: 3 }],
    ['NotebookEdit', { notebook_path: '/workspace/n.ipynb', new_source: 'print(1)' }, { kind: 'edit', path: 'n.ipynb', added: 1, removed: 0 }],
    ['Bash', { command: 'npm test', description: 'Run the tests' }, { kind: 'execute', command: 'npm test', description: 'Run the tests' }],
    ['Bash', { command: 'pwd' }, { kind: 'execute', command: 'pwd' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace/src' }, { kind: 'search', pattern: '**/*.ts', path: 'src' }],
    ['Grep', { pattern: 'TODO' }, { kind: 'search', pattern: 'TODO' }],
    ['WebFetch', { url: 'https://example.invalid/a', prompt: 'p' }, { kind: 'fetch', target: 'https://example.invalid/a' }],
    ['WebSearch', { query: 'node test runner' }, { kind: 'fetch', target: 'node test runner' }],
    ['Task', { prompt: 'p', description: 'd' }, { kind: 'other' }],
    ['Agent', { prompt: 'p', description: 'd' }, { kind: 'other' }],
    ['TodoWrite', { todos: [] }, { kind: 'think' }],
    ['SomethingNew', { a: 1 }, { kind: 'other' }],
  ];
  for (const [name, input, expected] of cases) assert.deepEqual(toolInput(name, input), expected, name);
});

test('the result of a turn: interrupted, out of turns, over budget, failed, refused', () => {
  const base = { type: 'result', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: {} };
  const finish = (message: Record<string, unknown>, interrupting = false): AgUiEvent[] => {
    const mapper = createMapper({ sessionId: SESSION });
    mapper.start('claude-haiku-5-5');
    mapper.line({ type: 'sdk', message: { type: 'command_lifecycle', command_uuid: id(1), state: 'started' } });
    if (interrupting) mapper.interrupting();
    return mapper.line({ type: 'sdk', message: { ...base, ...message } }).filter((event) => event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR');
  };
  const stop = (events: AgUiEvent[]) => events.map((event) => event.type === 'RUN_FINISHED' ? `${event.outcome.type}/${event.result.stopReason}` : event.type === 'RUN_ERROR' ? `error/${event.code}/${event.message}` : '');
  assert.deepEqual(stop(finish({ subtype: 'error_during_execution', is_error: true, errors: [] }, true)), ['cancelled/cancelled']);
  assert.deepEqual(stop(finish({ subtype: 'success', stop_reason: 'end_turn' }, true)), ['cancelled/cancelled']);
  assert.deepEqual(stop(finish({ subtype: 'success', stop_reason: 'max_tokens' })), ['success/max_tokens']);
  assert.deepEqual(stop(finish({ subtype: 'success', stop_reason: 'refusal' })), ['success/refusal']);
  assert.deepEqual(stop(finish({ subtype: 'error_max_turns', is_error: true, errors: [] })), ['success/max_turn_requests']);
  assert.deepEqual(stop(finish({ subtype: 'error_max_budget_usd', is_error: true, errors: [] })), ['error/max_budget_usd/the session reached its budget']);
  assert.deepEqual(stop(finish({ subtype: 'error_during_execution', is_error: true, errors: ['boom', 'bang'] })), ['error/error_during_execution/boom; bang']);
  assert.deepEqual(stop(finish({ subtype: 'success', is_error: true, result: 'API Error: 500' })), ['error/api_error/API Error: 500']);
});

// The live Take over run of 2026-10-28 (issue #463): the take over asked the
// interrupt 0.4 s before the runner opened the author's first turn. The SDK
// then ended that turn at once with error_during_execution, and the session
// failed instead of pausing.
test('an interrupt asked before the turn opens ends that turn as cancelled, not failed; a turn that succeeds still succeeds', () => {
  const base = { type: 'result', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} };
  const EDE = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';
  const turn = (result: Record<string, unknown>): AgUiEvent[] => {
    const mapper = createMapper({ sessionId: SESSION });
    mapper.start('claude-haiku-5-5');
    mapper.interrupting();
    mapper.line({ type: 'sdk', message: { type: 'command_lifecycle', command_uuid: id(1), state: 'started' } });
    return mapper.line({ type: 'sdk', message: { ...base, ...result } });
  };
  const aborted = turn({ subtype: 'error_during_execution', is_error: true, errors: [EDE] });
  assert.ok(!aborted.some((event) => event.type === 'RUN_ERROR'), 'no RUN_ERROR');
  const finished = aborted.find((event) => event.type === 'RUN_FINISHED');
  assert.equal(finished?.type === 'RUN_FINISHED' ? `${finished.outcome.type}/${finished.result.stopReason}` : undefined, 'cancelled/cancelled');
  const done = turn({ subtype: 'success', is_error: false, stop_reason: 'end_turn' }).find((event) => event.type === 'RUN_FINISHED');
  assert.equal(done?.type === 'RUN_FINISHED' ? done.outcome.type : undefined, 'success', 'an interrupt that found no turn does not cancel the next one that ends well');
});

test('a question, a cancelled request, a runner error and a runner that dies', () => {
  const mapper = createMapper({ sessionId: SESSION });
  mapper.start('claude-haiku-5-5');
  const questions = [{ question: 'Which order?', header: 'Order', options: [{ label: 'Newest', description: 'Newest first' }, { label: 'Oldest', description: 'Oldest first' }], multiSelect: false }];
  assert.deepEqual(mapper.question({ type: 'question', requestId: 'q1', toolUseId: 'toolu_09', questions }), [
    { type: 'CUSTOM', name: 'cleared.question', value: { requestId: 'q1', questions } },
    delta({ phase: 'waiting_human', status: 'Waiting for you' }),
  ]);
  assert.deepEqual(mapper.answered('q1', { decision: { kind: 'answer', answers: { 'Which order?': 'Newest' } }, by: 'user-1' }), [
    { type: 'CUSTOM', name: 'cleared.answered', value: { requestId: 'q1', by: 'user-1' } },
    delta({ phase: 'working', status: 'Working' }),
  ]);
  mapper.permissionRequest({ type: 'permission_request', requestId: 'p1', toolName: 'Bash', toolUseId: 'toolu_10', input: { command: 'touch x' } }, { decision: 'ask', rule: 'default', reason: 'r' });
  assert.deepEqual(mapper.line({ type: 'request_cancelled', requestId: 'p1' }), [
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'p1', decision: 'cancelled', by: 'policy', rule: 'interrupt' } },
    delta({ phase: 'working', status: 'Working' }),
  ]);
  // A malformed question list keeps the questions it can read.
  assert.deepEqual(mapper.question({ type: 'question', requestId: 'q2', toolUseId: 'toolu_11', questions: [{ question: 'Why?' }, 7, { nope: true }] })[0],
    { type: 'CUSTOM', name: 'cleared.question', value: { requestId: 'q2', questions: [{ question: 'Why?' }] } });
  assert.deepEqual(mapper.line({ type: 'error', message: 'unreadable input line' }), [{ type: 'RUN_ERROR', message: 'unreadable input line', code: 'runner' }]);
  assert.deepEqual(mapper.line({ type: 'exit', code: 1 }), [
    { type: 'RUN_ERROR', message: 'the runner exited with code 1', code: 'runner_exit' },
    delta({ phase: 'failed', status: 'Stopped on an error' }),
  ]);
});

test('frames outside the subset map to nothing; a subagent frame keeps its tool calls', () => {
  const mapper = createMapper({ sessionId: SESSION });
  mapper.start('claude-haiku-5-5');
  for (const message of [{ type: 'rate_limit_event' }, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'overage', utilization: 0.5 } }, { type: 'system', subtype: 'compact_boundary' }, { type: 'system', subtype: 'hook_started' }, { type: 'stream_event' }, { type: 'command_lifecycle', state: 'queued' }, 'not an object'])
    assert.deepEqual(mapper.line({ type: 'sdk', message }), [], JSON.stringify(message));
  const frame = { type: 'assistant', uuid: id(30), parent_tool_use_id: 'toolu_20', message: { id: 'msg_09', content: [{ type: 'thinking', thinking: 'secret plan', signature: 's' }, { type: 'tool_use', id: 'toolu_21', name: 'Bash', input: { command: 'ls' } }] } };
  const events = mapper.line({ type: 'sdk', message: frame });
  assert.deepEqual(events.map((event) => event.type), ['RUN_STARTED', 'STATE_DELTA', 'REASONING_START', 'REASONING_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'STATE_DELTA']);
  assert.ok(!JSON.stringify(events).includes('secret plan'), 'reasoning content is never emitted');
});

// Issue #335 (P219): with the preset's per-session sections excluded, the SDK
// gives them to the model in a user message of its own. Should a frame of it
// reach the runner's stdout, it is no event: the thread shows only what a
// person or Cleared sent, and a user frame counts only its tool results.
test('a user frame of text alone, such as the context the SDK moves out of the system prompt, maps to nothing in a turn', () => {
  const mapper = createMapper({ sessionId: SESSION });
  mapper.start('claude-haiku-5-5');
  const turn = mapper.line({ type: 'sdk', message: { type: 'system', subtype: 'init', user_message_uuids: [id(40)] } });
  assert.deepEqual(turn.map((event) => event.type), ['RUN_STARTED', 'STATE_DELTA']);
  const context = { type: 'user', uuid: id(41), message: { role: 'user', content: [{ type: 'text', text: 'Working directory: /workspace\nGit status: on branch cleared/LOCAL-12' }] } };
  assert.deepEqual(mapper.line({ type: 'sdk', message: context }), []);
  assert.deepEqual(mapper.line({ type: 'sdk', message: { ...context, uuid: id(42), message: { role: 'user', content: 'Working directory: /workspace' } } }), []);
});

test('a token in a command output and an edit outside the workdir are cleaned', () => {
  const token = ['sk', 'ant', 'oat01', 'R4u9Kd0Qm2Zx7Lp1Vb8Nc3Ws6Ty5Hj0'].join('-');
  const mapper = createMapper({ sessionId: SESSION });
  const cleaner = createCleaner({ secrets: [token] });
  const raw = [
    ...mapper.start('claude-haiku-5-5'),
    ...mapper.line({ type: 'sdk', message: { type: 'assistant', uuid: id(40), parent_tool_use_id: null, message: { id: 'msg_10', content: [{ type: 'tool_use', id: 'toolu_30', name: 'Bash', input: { command: 'cat /run/cleared/claude.token' } }] } } }),
    ...mapper.line({ type: 'sdk', message: { type: 'user', uuid: id(41), parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_30', content: token, is_error: false }] }, tool_use_result: { stdout: token, stderr: '' } } }),
  ];
  const events = raw.flatMap((event) => cleaner.clean(event));
  assert.ok(!JSON.stringify(events).includes(token));
  assert.ok(JSON.stringify(events).includes('[removed: secret]'));
  assert.deepEqual(toolInput('Write', { file_path: '/etc/passwd', content: 'x' }), { kind: 'edit', path: '/etc/passwd', added: 1, removed: 0 });
});

test('a resumed session: the empty result the CLI prints before the first turn is no turn, and the state starts again', () => {
  const mapper = createMapper({ sessionId: SESSION });
  mapper.start('claude-haiku-5-5');
  mapper.line({ type: 'exit', code: 0 });
  // As Claude Code 2.1.306 printed them after a resume in a new container
  // (doctor run of 2026-10-21): an init without user message uuids, then a
  // result of no turn, before the message sent after the resume.
  assert.deepEqual(mapper.start('claude-haiku-5-5'), [
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'Starting', phase: 'starting', steps: [], files: [], checks: [], usage: { model: 'claude-haiku-5-5' } } },
  ]);
  assert.deepEqual(mapper.line({ type: 'sdk', message: { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' } }), []);
  assert.deepEqual(mapper.line({ type: 'sdk', message: { type: 'result', subtype: 'success', is_error: false, stop_reason: null, result: '', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, total_cost_usd: 0.0054 } }), []);
  assert.deepEqual(mapper.line({ type: 'sdk', message: { type: 'command_lifecycle', state: 'started', command_uuid: id(50) } }).map((e) => e.type), ['RUN_STARTED', 'STATE_DELTA']);
});

// Milestone 2 (lane 4).
const ctx = (after: 'turn' | 'tool', percentage: number, extra: Record<string, unknown> = {}): RunnerOutput =>
  ({ type: 'context', after, detail: 'summary', ms: 3, totalTokens: percentage * 2000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage, isAutoCompactEnabled: true, autoCompactThreshold: 167_000, ...extra }) as RunnerOutput;

test('a context line is a cleared.context_usage event and the session state\'s context, also in a later snapshot', () => {
  const mapper = createMapper({ sessionId: SESSION });
  mapper.start('claude-haiku-5-5');
  assert.deepEqual(mapper.line(ctx('tool', 12)), [
    { type: 'CUSTOM', name: 'cleared.context_usage', value: { percent: 12, totalTokens: 24_000, maxTokens: 200_000, rawMaxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true } },
    { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/context', value: { percent: 12, totalTokens: 24_000, maxTokens: 200_000 } }] },
  ]);
  const [usage] = mapper.line({ ...ctx('turn', 31), rawMaxTokens: undefined, autoCompactThreshold: undefined, isAutoCompactEnabled: false } as unknown as RunnerOutput);
  assert.deepEqual(usage, { type: 'CUSTOM', name: 'cleared.context_usage', value: { percent: 31, totalTokens: 62_000, maxTokens: 200_000, isAutoCompactEnabled: false } });
  assert.deepEqual(mapper.state().context, { percent: 31, totalTokens: 62_000, maxTokens: 200_000 });
  // An unreadable measure maps to nothing.
  assert.deepEqual(mapper.line({ type: 'context', after: 'turn' } as unknown as RunnerOutput), []);
});

test('Claude Code compacting on its own is recorded as cleared.compacted', () => {
  const mapper = createMapper({ sessionId: SESSION });
  const frame = (metadata: Record<string, unknown>): RunnerOutput => ({ type: 'sdk', message: { type: 'system', subtype: 'compact_boundary', compact_metadata: metadata, uuid: id(9), session_id: SESSION } });
  assert.deepEqual(mapper.line(frame({ trigger: 'auto', pre_tokens: 167_500, post_tokens: 21_000, duration_ms: 9000 })), [
    { type: 'CUSTOM', name: 'cleared.compacted', value: { trigger: 'auto', preTokens: 167_500, postTokens: 21_000 } },
  ]);
  assert.deepEqual(mapper.line(frame({ trigger: 'manual', pre_tokens: 50_000 })), [{ type: 'CUSTOM', name: 'cleared.compacted', value: { trigger: 'manual', preTokens: 50_000 } }]);
  assert.deepEqual(mapper.line(frame({ trigger: 'other', pre_tokens: 1 })), []);
});

test('a rate limit window is said when it changes, from the unified windows or the frame\'s own window', () => {
  const mapper = createMapper({ sessionId: SESSION });
  const frame = (info: Record<string, unknown>): RunnerOutput => ({ type: 'sdk', message: { type: 'rate_limit_event', rate_limit_info: info, uuid: id(9), session_id: SESSION } });
  const windows = { five_hour: { utilization: 0.26, resetsAt: 1792614600 }, seven_day: { utilization: 0.08, resetsAt: 1793091600 } };
  assert.equal(mapper.line(frame({ status: 'allowed', unifiedWindows: windows })).length, 2);
  // The same measure again says nothing; a changed one says that window only.
  assert.deepEqual(mapper.line(frame({ status: 'allowed', unifiedWindows: windows })), []);
  assert.deepEqual(mapper.line(frame({ status: 'allowed', unifiedWindows: { ...windows, seven_day: { utilization: 0.091, resetsAt: 1793091600 } } })), [
    { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent: 9.1, resetsAt: '2026-10-27T09:00:00.000Z' } },
  ]);
  // Without unified windows: the frame's own documented window, if it has a utilization.
  assert.deepEqual(mapper.line(frame({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8, resetsAt: 1792614600 })), [
    { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'five_hour', usedPercent: 80, resetsAt: '2026-10-21T20:30:00.000Z' } },
  ]);
  assert.deepEqual(mapper.line(frame({ status: 'allowed', rateLimitType: 'seven_day' })), []);
});

test('a login error ends the turn as cancelled, not failed, and the session waits for a new login', () => {
  const mapper = createMapper({ sessionId: SESSION });
  mapper.start('claude-haiku-5-5');
  mapper.line({ type: 'sdk', message: { type: 'command_lifecycle', state: 'started', command_uuid: id(1) } });
  assert.equal(mapper.turn(), id(1));
  assert.deepEqual(mapper.line({ type: 'login', state: 'failed' }), [{ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/phase', value: 'waiting_human' }, { op: 'replace', path: '/status', value: 'Waiting for a new login' }] }]);
  const events = mapper.line({ type: 'sdk', message: { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate.', total_cost_usd: 0 } });
  assert.deepEqual(events.map((event) => event.type), ['RUN_FINISHED', 'STATE_DELTA']);
  assert.ok(events[0]?.type === 'RUN_FINISHED' && events[0].outcome.type === 'cancelled' && events[0].result.stopReason === 'cancelled');
  assert.equal(mapper.state().status, 'Waiting for a new login');
  assert.equal(mapper.turn(), undefined);
  assert.deepEqual(mapper.line({ type: 'login', state: 'renewed' }), []);
  // The next failure of a turn is an error again.
  mapper.line({ type: 'sdk', message: { type: 'command_lifecycle', state: 'started', command_uuid: id(2) } });
  assert.deepEqual(mapper.line({ type: 'sdk', message: { type: 'result', subtype: 'success', is_error: true, result: 'overloaded' } }).map((event) => event.type), ['RUN_ERROR', 'STATE_DELTA']);
});

test('a host call line and a measure line are the adapter\'s, not events', () => {
  const mapper = createMapper({ sessionId: SESSION });
  assert.deepEqual(mapper.line({ type: 'host_call', callId: 'c', toolUseId: 't', name: 'state', input: {} }), []);
  assert.deepEqual(mapper.line({ type: 'measure', summaryMs: [], fullMs: [] }), []);
});
