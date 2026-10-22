import test from 'node:test';
import assert from 'node:assert/strict';
import { hooks } from '../../../images/session/runner/hooks.ts';
import { CLAUDE_BIN, LOGIN_FILE, run, type QueryFn, type RunnerDeps, type RunnerOutput } from '../../../images/session/runner/main.ts';

const token = ['sk', 'ant', 'oat01', 'R4u9Kd0Qm2Zx7Lp1Vb8Nc3Ws6Ty5Hj0'].join('-');

// Lines the runner reads, pushed by the test one at a time.
function lineSource() {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const lines: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const line = queue.shift();
        if (line !== undefined) { yield line; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
  return {
    lines,
    // A string is sent as it is, anything else as its JSON.
    send(value: unknown) { queue.push(typeof value === 'string' ? value : JSON.stringify(value)); wake?.(); },
    end() { ended = true; wake?.(); },
  };
}

// getContextUsage()'s answer as the SDK 0.3.306 types it, with the parts
// the runner must not forward (categories, the grid).
const contextAnswer = (n: number) => ({
  categories: [{ name: 'Messages', tokens: 1000 * n, color: 'x', kind: 'used' }], gridRows: [[{ color: 'x', isFilled: true, categoryName: 'Messages', tokens: 1, percentage: 1, squareFullness: 1 }]],
  totalTokens: 20_000 * n, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 10 * n, model: 'claude-haiku-5-5', memoryFiles: [], mcpTools: [], agents: [],
  autoCompactThreshold: 167_000, isAutoCompactEnabled: true,
});

type Options = Record<string, unknown> & {
  canUseTool?: (tool: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }) => Promise<Record<string, unknown>>;
};

// A query() stand-in: it hands each user message to `turn`, yields what
// `turn` yields, and records the calls the runner makes on it.
function fakeQuery(turn: (message: Record<string, unknown>, options: Options) => AsyncGenerator<Record<string, unknown>>) {
  const seen = { options: undefined as Options | undefined, prompts: [] as Record<string, unknown>[], interrupts: 0, closes: 0, context: [] as (string | undefined)[], usage: 0 };
  let closed = false;
  let stopWaiting: () => void = () => {};
  const query: QueryFn = ({ prompt, options }) => {
    seen.options = options as Options;
    async function* messages() {
      const iterator = prompt[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), new Promise<IteratorResult<unknown>>((resolve) => { stopWaiting = () => resolve({ done: true, value: undefined }); })]);
        if (next.done || closed) return;
        const message = next.value as Record<string, unknown>;
        seen.prompts.push(message);
        for await (const out of turn(message, options as Options)) {
          if (closed) return;
          yield out;
        }
      }
    }
    const generator = messages();
    return Object.assign(generator, {
      async interrupt() { seen.interrupts++; return undefined; },
      close() { seen.closes++; closed = true; stopWaiting(); },
      async getContextUsage(opts?: { detail?: string }) { seen.context.push(opts?.detail); return contextAnswer(seen.context.length); },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        seen.usage++;
        return { session: { total_cost_usd: 0.01 }, subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: '2026-10-22T20:00:00Z' }, seven_day: { utilization: 31, resets_at: '2026-10-27T08:00:00Z' } }, behaviors: null };
      },
    });
  };
  return { query, seen };
}

function deps(query: QueryFn, lines: AsyncIterable<string>, out: RunnerOutput[], extra: Partial<RunnerDeps> = {}): RunnerDeps {
  let n = 0;
  return {
    query, lines,
    write: (line) => out.push(JSON.parse(line) as RunnerOutput),
    readFile: (path) => (path === LOGIN_FILE ? `${token}\n` : undefined),
    env: { PATH: '/usr/bin', HOME: '/tmp', ANTHROPIC_API_KEY: ['not', 'passed', 'on'].join('-'), CLAUDE_CODE_OAUTH_TOKEN: 'stale' },
    newId: () => `request-${++n}`,
    ...extra,
  };
}

const start = { type: 'start', sessionId: '0b7e6f2c-3d4a-4e5f-8a9b-1c2d3e4f5a6b', model: 'claude-haiku-5-5', resume: false, maxBudgetUsd: 0.5 };
const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, is_error: false });
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check(), 'condition not met in time'); };

test('the runner starts query() with the plan options, the token in the child env only, and the hook set', async () => {
  const { query, seen } = fakeQuery(async function* () { yield result('OK'); });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Reply OK.' });
  await until(() => out.some((line) => line.type === 'sdk'));
  source.end();
  assert.equal(await done, 0);

  const options = seen.options as Options;
  assert.equal(options.cwd, '/workspace');
  assert.equal(options.model, 'claude-haiku-5-5');
  assert.equal(options.sessionId, start.sessionId);
  assert.equal(options.resume, undefined);
  assert.deepEqual(options.settingSources, []);
  // No co-author trailer: its address would make the guard refuse the publish.
  assert.deepEqual(options.settings, { attribution: { commit: '', pr: '' } });
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.persistSession, true);
  assert.equal(options.includePartialMessages, false);
  assert.equal(options.maxBudgetUsd, 0.5);
  assert.equal(options.pathToClaudeCodeExecutable, CLAUDE_BIN);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  // The runner's own policy check runs first, then lane 5's hooks; its
  // context measure runs after every tool call.
  const set = options.hooks as Record<string, { hooks: unknown[] }[]>;
  assert.deepEqual(Object.keys(set).sort(), [...new Set(['PreToolUse', 'PostToolUse', ...Object.keys(hooks)])].sort());
  assert.equal(set.PreToolUse?.length, 1 + (hooks.PreToolUse?.length ?? 0));
  for (const [event, matchers] of Object.entries(hooks)) assert.deepEqual(set[event]?.slice(event === 'PreToolUse' ? 1 : 0), matchers);
  assert.equal(set.PostToolUse?.length, 1);
  assert.equal(typeof options.canUseTool, 'function');
  // No host tools: no MCP server.
  assert.equal(options.mcpServers, undefined);
  const env = options.env as Record<string, string | undefined>;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, '/usr/bin');
  // The commit identity: a name, and no address (git 2.39 accepts an empty one).
  assert.deepEqual([env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL, env.GIT_COMMITTER_NAME, env.GIT_COMMITTER_EMAIL], ['Cleared', '', 'Cleared', '']);

  assert.deepEqual(seen.prompts, [{ type: 'user', message: { role: 'user', content: 'Reply OK.' }, parent_tool_use_id: null, uuid: 'u-1', origin: { kind: 'human' } }]);
  assert.deepEqual(out, [
    { type: 'sdk', message: result('OK') },
    { type: 'context', after: 'turn', detail: 'summary', ms: (out[1] as { ms: number }).ms, totalTokens: 20_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 10, autoCompactThreshold: 167_000, isAutoCompactEnabled: true },
    { type: 'exit', code: 0 },
  ]);
  assert.equal(typeof (out[1] as { ms: unknown }).ms, 'number');
  assert.ok(!JSON.stringify(out).includes(token), 'the token never reaches stdout');
});

test('resume passes the session id as resume, and CLAUDE.md is appended to the system prompt', async () => {
  const { query, seen } = fakeQuery(async function* () {});
  const source = lineSource();
  const done = run(deps(query, source.lines, [], {
    readFile: (path) => (path === LOGIN_FILE ? token : path === '/workspace/CLAUDE.md' ? '# Briefing\nThe word is MAPLE.\n' : undefined),
  }));
  source.send({ ...start, resume: true });
  source.end();
  assert.equal(await done, 0);
  const options = seen.options as Options;
  assert.equal(options.resume, start.sessionId);
  assert.equal(options.sessionId, undefined);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: '# Briefing\nThe word is MAPLE.\n' });
});

test('a permission request goes out as a line and the answer line decides it', async () => {
  const answers: Record<string, unknown>[] = [];
  const { query } = fakeQuery(async function* (_message, options) {
    const signal = new AbortController().signal;
    answers.push(await (options.canUseTool?.('Bash', { command: 'touch a' }, { signal, toolUseID: 'tool-1' }) ?? Promise.reject(new Error('no canUseTool'))));
    answers.push(await (options.canUseTool?.('Bash', { command: 'rm -r b' }, { signal, toolUseID: 'tool-2' }) ?? Promise.reject(new Error('no canUseTool'))));
    yield result('done');
  });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Go.' });
  await until(() => out.length === 1);
  assert.deepEqual(out[0], { type: 'permission_request', requestId: 'request-1', toolName: 'Bash', toolUseId: 'tool-1', input: { command: 'touch a' } });
  source.send({ type: 'answer', requestId: 'request-1', decision: { kind: 'allow_once' } });
  await until(() => out.length === 2);
  assert.deepEqual(out[1], { type: 'permission_request', requestId: 'request-2', toolName: 'Bash', toolUseId: 'tool-2', input: { command: 'rm -r b' } });
  source.send({ type: 'answer', requestId: 'request-2', decision: { kind: 'reject_once', message: 'Not this one.' } });
  await until(() => out.some((line) => line.type === 'sdk'));
  source.end();
  assert.equal(await done, 0);
  assert.deepEqual(answers, [
    { behavior: 'allow', updatedInput: { command: 'touch a' } },
    { behavior: 'deny', message: 'Not this one.' },
  ]);
});

test('AskUserQuestion goes out as a question line; an answer returns the questions with the answers', async () => {
  const questions = [{ question: 'Which order?', header: 'Order', options: [{ label: 'Newest', description: 'Newest first' }, { label: 'Oldest', description: 'Oldest first' }], multiSelect: false }];
  let answer: Record<string, unknown> | undefined;
  const { query } = fakeQuery(async function* (_message, options) {
    answer = await options.canUseTool?.('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'tool-q' });
    yield result('ok');
  });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Ask me.' });
  await until(() => out.length === 1);
  assert.deepEqual(out[0], { type: 'question', requestId: 'request-1', toolUseId: 'tool-q', questions });
  source.send({ type: 'answer', requestId: 'request-1', decision: { kind: 'answer', answers: { 'Which order?': 'Newest' } } });
  await until(() => out.some((line) => line.type === 'sdk'));
  source.end();
  await done;
  assert.deepEqual(answer, { behavior: 'allow', updatedInput: { questions, answers: { 'Which order?': 'Newest' } } });
});

test('a request the SDK aborts is reported cancelled; interrupt and stop reach the query', async () => {
  const abort = new AbortController();
  let answer: Record<string, unknown> | undefined;
  const { query, seen } = fakeQuery(async function* (_message, options) {
    const pending = options.canUseTool?.('Bash', { command: 'touch a' }, { signal: abort.signal, toolUseID: 'tool-1' });
    yield { type: 'assistant', marker: 'asked' };
    answer = await pending;
    yield result('interrupted');
    await new Promise(() => {});                   // a turn that never ends, until close()
  });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Go.' });
  await until(() => out.some((line) => line.type === 'permission_request'));
  source.send({ type: 'interrupt' });
  await until(() => seen.interrupts === 1);
  abort.abort();
  await until(() => out.some((line) => line.type === 'request_cancelled'));
  assert.deepEqual(out.find((line) => line.type === 'request_cancelled'), { type: 'request_cancelled', requestId: 'request-1' });
  await until(() => answer !== undefined);
  assert.deepEqual(answer, { behavior: 'deny', message: 'The request was cancelled.', interrupt: true });
  source.send({ type: 'stop' });
  assert.equal(await done, 0);
  assert.equal(seen.closes, 1);
  assert.deepEqual(out.at(-1), { type: 'exit', code: 0 });
});

test('the runner refuses a first line that is not start, and a missing token, before any query', async () => {
  for (const [first, file, code, message] of [
    [{ type: 'user', uuid: 'u', text: 'hi' }, token, 2, /first line must be start/],
    [start, undefined, 3, /no token/],
    [start, '  \n', 3, /no token/],
  ] as const) {
    let called = false;
    const query: QueryFn = () => { called = true; throw new Error('not expected'); };
    const source = lineSource();
    const out: RunnerOutput[] = [];
    const done = run(deps(query, source.lines, out, { readFile: (path) => (path === LOGIN_FILE ? file : undefined) }));
    source.send(first);
    source.end();
    assert.equal(await done, code);
    assert.equal(called, false);
    const error = out.find((line) => line.type === 'error');
    assert.ok(error && error.type === 'error' && message.test(error.message), JSON.stringify(out));
    assert.deepEqual(out.at(-1), { type: 'exit', code });
  }
});

test('a query that fails is reported as an error line and exit 1; unreadable lines are reported and skipped', async () => {
  const { query } = fakeQuery(async function* () { throw new Error('the CLI exited with code 1'); });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send('not json at all');
  source.send({ type: 'user', uuid: 'u-1', text: 'Go.' });
  assert.equal(await done, 1);
  assert.deepEqual(out.filter((line) => line.type === 'error').map((line) => line.type === 'error' && line.message), [
    'unreadable input line',
    'the CLI exited with code 1',
  ]);
  assert.deepEqual(out.at(-1), { type: 'exit', code: 1 });
});

test('every tool call is checked with the host before it runs: a deny stops it, anything else goes on', async () => {
  type Hook = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
  const outcomes: Record<string, unknown>[] = [];
  const abort = new AbortController();
  const { query } = fakeQuery(async function* (_message, options) {
    const hook = (options.hooks as Record<string, { hooks: Hook[] }[]>).PreToolUse?.[0]?.hooks[0] as Hook;
    const call = (tool: string, input: unknown, signal = new AbortController().signal) =>
      hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `id-${tool}`, session_id: 's', transcript_path: '/t', cwd: '/workspace' }, `id-${tool}`, { signal });
    outcomes.push(await call('Read', { file_path: '/workspace/.env' }));
    outcomes.push(await call('Read', { file_path: '/workspace/notes.txt' }));
    const pending = call('Bash', { command: 'sleep 9' }, abort.signal);
    yield { type: 'assistant', marker: 'checking' };
    outcomes.push(await pending);
    yield result('done');
  });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Go.' });
  await until(() => out.length === 1);
  assert.deepEqual(out[0], { type: 'tool_check', requestId: 'request-1', toolName: 'Read', toolUseId: 'id-Read', input: { file_path: '/workspace/.env' } });
  source.send({ type: 'tool_verdict', requestId: 'request-1', deny: 'a secret file' });
  await until(() => out.length === 2);
  source.send({ type: 'tool_verdict', requestId: 'request-2' });
  await until(() => out.some((line) => line.type === 'sdk'));
  abort.abort();
  await until(() => outcomes.length === 3);
  source.end();
  assert.equal(await done, 0);
  assert.deepEqual(outcomes, [
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'a secret file' } },
    {},
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'The policy check was cancelled.' } },
  ]);
});

test('the login file may be a Claude Code credentials file: only its access token reaches the CLI', async () => {
  const refresh = ['sk', 'ant', 'ort01', 'Zq8Wm3Xk1Lp7Vb2Nc6Hj9Td4Ry0Gs5'].join('-');
  const credentials = JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt: 1, scopes: ['user:inference'] } });
  const { query, seen } = fakeQuery(async function* () {});
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out, { readFile: (path) => (path === LOGIN_FILE ? credentials : undefined) }));
  source.send(start);
  source.end();
  assert.equal(await done, 0);
  const env = (seen.options as Options).env as Record<string, string | undefined>;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.ok(!JSON.stringify(seen.options).includes(refresh), 'the refresh token never reaches the CLI');
  assert.ok(!JSON.stringify(out).includes(refresh) && !JSON.stringify(out).includes(token));

  for (const broken of ['{"claudeAiOauth":{}}', '{not json', '{"other":1}']) {
    const source2 = lineSource();
    const out2: RunnerOutput[] = [];
    const done2 = run(deps(query, source2.lines, out2, { readFile: (path) => (path === LOGIN_FILE ? broken : undefined) }));
    source2.send(start);
    source2.end();
    assert.equal(await done2, 3, broken);
    assert.ok(!JSON.stringify(out2).includes(broken), 'the login file content is never printed');
  }
});

// Milestone 2 (lane 4): the host tools, the context measure, the hooks by
// role, the login resilience.

type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; handler: (args: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>; extras?: Record<string, unknown> };
type McpServer = { type: 'sdk'; name: string; options: Record<string, unknown>; tools: McpTool[] };
// Stand-ins for the SDK's createSdkMcpServer() and tool() and for zod: they
// keep what the runner gives them, so a test can call a tool's handler as
// the CLI would.
function mcpStandIn() {
  const kind = (k: string) => {
    const t: Record<string, unknown> = { kind: k };
    t.describe = (d: string) => ({ ...t, description: d });
    t.optional = () => ({ ...t, optional: true });
    return t as never;
  };
  return {
    createSdkMcpServer: (options: Record<string, unknown>): McpServer => ({ type: 'sdk', name: String(options.name), options, tools: options.tools as McpTool[] }),
    tool: (name: string, description: string, inputSchema: Record<string, unknown>, handler: McpTool['handler'], extras?: Record<string, unknown>): McpTool => ({ name, description, inputSchema, handler, ...(extras ? { extras } : {}) }),
    z: { string: () => kind('string'), number: () => kind('number'), boolean: () => kind('boolean'), enum: () => kind('enum'), array: () => kind('array'), object: () => kind('object') },
  };
}
const ping = { name: 'ping', description: 'Answers pong and the word.', inputSchema: { type: 'object', properties: { word: { type: 'string', description: 'A word.' } }, required: ['word'] } };
const leadStart = { ...start, role: 'lead', tools: [ping] };
type Hook = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
const hookOf = (options: Options, event: string, index = 0) => (options.hooks as Record<string, { hooks: Hook[] }[]>)[event]?.[index]?.hooks[0] as Hook;
const preToolUse = (options: Options, tool: string, input: unknown, id: string) =>
  hookOf(options, 'PreToolUse')({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, session_id: 's', transcript_path: '/t', cwd: '/workspace' }, id, { signal: new AbortController().signal });

test('a lead session gets the host tools as the in-process MCP server cleared, each call relayed to the host and answered', async () => {
  const mcp = mcpStandIn();
  const answers: unknown[] = [];
  const { query, seen } = fakeQuery(async function* (_message, options) {
    const server = (options.mcpServers as Record<string, McpServer>).cleared as McpServer;
    const tool = server.tools[0] as McpTool;
    // The CLI checks the call first (PreToolUse), then calls the tool.
    const checked = preToolUse(options, 'mcp__cleared__ping', { word: 'plum' }, 'toolu-1');
    yield { type: 'assistant', marker: 'calling' };
    await checked;
    answers.push(await tool.handler({ word: 'plum' }, { signal: new AbortController().signal }));
    answers.push(await tool.handler({ word: 'pear' }, { signal: new AbortController().signal }));
    yield result('done');
  });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out, { mcp }));
  source.send(leadStart);
  source.send({ type: 'user', uuid: 'u-1', text: 'Ping.' });
  await until(() => out.some((line) => line.type === 'tool_check'));
  source.send({ type: 'tool_verdict', requestId: 'request-1' });
  await until(() => out.some((line) => line.type === 'host_call'));
  const first = out.find((line) => line.type === 'host_call');
  assert.deepEqual(first, { type: 'host_call', callId: 'request-2', toolUseId: 'toolu-1', name: 'ping', input: { word: 'plum' } });
  source.send({ type: 'host_result', callId: 'request-2', ok: true, text: 'pong plum' });
  await until(() => out.filter((line) => line.type === 'host_call').length === 2);
  // A call the PreToolUse hook did not announce has no tool use id; a refusal is an error result.
  assert.deepEqual(out.filter((line) => line.type === 'host_call')[1], { type: 'host_call', callId: 'request-3', toolUseId: '', name: 'ping', input: { word: 'pear' } });
  source.send({ type: 'host_result', callId: 'request-3', ok: false, text: 'Refused: not this word.' });
  source.send({ type: 'host_result', callId: 'request-99', ok: true, text: 'nobody waits for this' });
  await until(() => answers.length === 2);
  source.end();
  assert.equal(await done, 0);
  assert.deepEqual(answers, [
    { content: [{ type: 'text', text: 'pong plum' }] },
    { content: [{ type: 'text', text: 'Refused: not this word.' }], isError: true },
  ]);
  const server = (seen.options?.mcpServers as Record<string, McpServer>).cleared as McpServer;
  assert.equal(server.name, 'cleared');
  // Always in the prompt, never deferred; a hung host cannot hold a turn forever.
  assert.equal(server.options.alwaysLoad, true);
  assert.equal(typeof server.options.timeout, 'number');
  assert.deepEqual(server.tools.map((t) => [t.name, t.description, Object.keys(t.inputSchema)]), [['ping', ping.description, ['word']]]);
});

test('a host call the CLI aborts answers the model at once; the host\'s late answer is dropped', async () => {
  const mcp = mcpStandIn();
  const abort = new AbortController();
  let answer: unknown;
  const { query } = fakeQuery(async function* (_message, options) {
    const tool = ((options.mcpServers as Record<string, McpServer>).cleared as McpServer).tools[0] as McpTool;
    const pending = tool.handler({ word: 'plum' }, { signal: abort.signal });
    yield { type: 'assistant', marker: 'calling' };
    answer = await pending;
    yield result('done');
  });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out, { mcp }));
  source.send(leadStart);
  source.send({ type: 'user', uuid: 'u-1', text: 'Ping.' });
  await until(() => out.some((line) => line.type === 'host_call'));
  abort.abort();
  await until(() => answer !== undefined);
  source.send({ type: 'host_result', callId: 'request-1', ok: true, text: 'too late' });
  source.end();
  assert.equal(await done, 0);
  assert.deepEqual(answer, { content: [{ type: 'text', text: 'The call was cancelled.' }], isError: true });
});

test('host tools outside the schema subset, or without the SDK\'s MCP functions, refuse the start (exit 4)', async () => {
  for (const [tools, mcp, message] of [
    [[{ ...ping, inputSchema: { type: 'object', properties: { n: { type: 'integer' } } } }], mcpStandIn(), /ping: n: unsupported type integer/],
    [[ping], undefined, /the SDK's MCP server is not available/],
  ] as const) {
    let called = false;
    const query: QueryFn = () => { called = true; throw new Error('not expected'); };
    const source = lineSource();
    const out: RunnerOutput[] = [];
    const done = run(deps(query, source.lines, out, mcp ? { mcp } : {}));
    source.send({ ...leadStart, tools });
    source.end();
    assert.equal(await done, 4);
    assert.equal(called, false);
    const error = out.find((line) => line.type === 'error');
    assert.ok(error?.type === 'error' && message.test(error.message), JSON.stringify(out));
  }
});

test('the context is measured after every turn and, without holding the call, after every tool call', async () => {
  const outcomes: unknown[] = [];
  const { query, seen } = fakeQuery(async function* (_message, options) {
    const post = hookOf(options, 'PostToolUse');
    outcomes.push(await post({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't-1' }, 't-1', { signal: new AbortController().signal }));
    yield { type: 'assistant', marker: 'read' };
    yield result('done');
  });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Read.' });
  await until(() => out.filter((line) => line.type === 'context').length === 2);
  source.end();
  assert.equal(await done, 0);
  assert.deepEqual(outcomes, [{}]);
  assert.deepEqual(seen.context, ['summary', 'summary']);
  const lines = out.filter((line) => line.type === 'context');
  assert.deepEqual(lines.map((line) => line.type === 'context' && [line.after, line.percentage]), [['tool', 10], ['turn', 20]]);
  // Nothing of the categories or the grid is forwarded.
  assert.ok(!JSON.stringify(out).includes('gridRows') && !JSON.stringify(out).includes('categories'));
});

test('a slow measure (over 200 ms) runs after every third tool call only; a failed one prints nothing', async () => {
  let clock = 0;
  let calls = 0;
  const { query } = fakeQuery(async function* (_message, options) {
    const post = hookOf(options, 'PostToolUse');
    for (let i = 0; i < 7; i++) {
      await post({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: `t-${i}` }, `t-${i}`, { signal: new AbortController().signal });
      await new Promise((r) => setTimeout(r, 5));
    }
    yield result('done');
  });
  const slow: QueryFn = (args) => {
    const q = query(args) as ReturnType<QueryFn> & { getContextUsage(o?: unknown): Promise<unknown> };
    const inner = q.getContextUsage.bind(q);
    q.getContextUsage = async (o) => { calls++; clock += 250; if (calls === 2) throw new Error('control request failed'); return inner(o); };
    return q;
  };
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const logs: string[] = [];
  const done = run(deps(slow, source.lines, out, { clock: () => clock, log: (text) => logs.push(text) }));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Read.' });
  await until(() => out.some((line) => line.type === 'sdk'));
  await until(() => out.some((line) => line.type === 'context' && line.after === 'turn'));
  source.end();
  assert.equal(await done, 0);
  // Tool call 1 (slow), then every third: 4 (failed, still slow), 7; then the turn.
  assert.deepEqual(out.filter((line) => line.type === 'context').map((line) => line.type === 'context' && line.after), ['tool', 'tool', 'turn']);
  assert.equal(calls, 4);
  assert.ok(logs.some((text) => /context measure failed: control request failed/.test(text)), logs.join('\n'));
});

test('the role reaches the hooks: no Stop hook for a lead or a reviewer, the HANDOVER.md request for an author', async () => {
  for (const [role, stop] of [['author', true], [undefined, true], ['reviewer', false], ['lead', false]] as const) {
    const { query, seen } = fakeQuery(async function* () {});
    const source = lineSource();
    const done = run(deps(query, source.lines, []));
    source.send(role === undefined ? start : { ...start, role });
    source.end();
    assert.equal(await done, 0);
    const set = seen.options?.hooks as Record<string, unknown[]>;
    assert.equal('Stop' in set, stop, String(role));
    // The push and pull request rules stay for every role.
    assert.equal(set.PreToolUse?.length, 2, String(role));
  }
});

test('a verdict sent right after an interrupt is not held behind it', async () => {
  let release: () => void = () => {};
  const outcomes: unknown[] = [];
  const { query, seen } = fakeQuery(async function* (_message, options) {
    const checked = preToolUse(options, 'Read', { file_path: '/workspace/a' }, 't-1');
    yield { type: 'assistant', marker: 'checking' };
    outcomes.push(await checked);
    yield result('done');
  });
  const held: QueryFn = (args) => Object.assign(query(args), { interrupt: () => { seen.interrupts++; return new Promise<undefined>((resolve) => { release = () => resolve(undefined); }); } });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(held, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Go.' });
  await until(() => out.some((line) => line.type === 'tool_check'));
  source.send({ type: 'interrupt' });
  source.send({ type: 'tool_verdict', requestId: 'request-1' });
  await until(() => outcomes.length === 1);
  assert.equal(seen.interrupts, 1);
  release();
  source.end();
  assert.equal(await done, 0);
});

test('a login error: the failed turn ends, the runner waits for a new token in the file, then resumes the same session and goes on', async () => {
  const renewed = ['sk', 'ant', 'oat01', 'N3w7Kd0Qm2Zx7Lp1Vb8Nc3Ws6Ty5Hj9'].join('-');
  let file = token;
  const options: Options[] = [];
  const prompts: Record<string, unknown>[] = [];
  let queries = 0;
  const query: QueryFn = (args) => {
    queries++;
    const own = queries;
    options.push(args.options as Options);
    return fakeQuery(async function* (message) {
      prompts.push(message);
      if (own === 1) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth token revoked' }] }, error: 'authentication_failed' };
        yield { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate.' };
        await new Promise(() => {});              // until close()
      }
      yield result('back');
    }).query(args);
  };
  const sleeps: number[] = [];
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out, {
    readFile: (path) => (path === LOGIN_FILE ? file : undefined),
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 3) file = `${renewed}\n`; await new Promise((r) => setImmediate(r)); },
  }));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Work.' });
  await until(() => out.some((line) => line.type === 'login' && line.state === 'renewed'));
  await until(() => out.some((line) => line.type === 'sdk' && (line.message as { result?: string }).result === 'back'));
  source.end();
  assert.equal(await done, 0);
  const kinds = out.map((line) => (line.type === 'sdk' ? `sdk:${(line.message as { type: string }).type}` : line.type === 'login' ? `login:${line.state}` : line.type));
  assert.deepEqual(kinds.filter((k) => k !== 'context'), ['login:failed', 'sdk:assistant', 'sdk:result', 'login:renewed', 'sdk:result', 'exit']);
  // The same file is read again until its token changes; the same session is resumed with it.
  assert.ok(sleeps.length >= 3 && sleeps.every((ms) => ms > 0));
  assert.equal(queries, 2);
  assert.equal(options[1]?.resume, start.sessionId);
  assert.equal(options[1]?.sessionId, undefined);
  assert.equal((options[1]?.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, renewed);
  assert.equal(options[1]?.canUseTool, options[0]?.canUseTool);
  // The turn that failed is not sent again: a message says to go on.
  assert.equal(prompts.length, 2);
  assert.match(String((prompts[1]?.message as { content: string }).content), /login was renewed/);
  assert.ok(!JSON.stringify(out).includes(renewed) && !JSON.stringify(out).includes(token), 'no token reaches stdout');
});

test('stop ends the wait for a new login', async () => {
  const query: QueryFn = (args) => fakeQuery(async function* () {
    yield { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1, error_status: 401, error: 'authentication_failed' };
    yield { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate.' };
  }).query(args);
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out, { sleep: () => new Promise((r) => setTimeout(r, 5)) }));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Work.' });
  await until(() => out.some((line) => line.type === 'login'));
  source.send({ type: 'stop' });
  assert.equal(await done, 0);
  assert.deepEqual(out.filter((line) => line.type === 'login'), [{ type: 'login', state: 'failed' }]);
  assert.deepEqual(out.at(-1), { type: 'exit', code: 0 });
});

test('a measure line times ten summary and ten full context measures and reads the usage once', async () => {
  const { query, seen } = fakeQuery(async function* () { yield result('ok'); });
  const source = lineSource();
  const out: RunnerOutput[] = [];
  const done = run(deps(query, source.lines, out));
  source.send(start);
  source.send({ type: 'user', uuid: 'u-1', text: 'Go.' });
  await until(() => out.some((line) => line.type === 'context'));
  source.send({ type: 'measure' });
  await until(() => out.some((line) => line.type === 'measure'));
  source.end();
  assert.equal(await done, 0);
  const measure = out.find((line) => line.type === 'measure');
  assert.ok(measure?.type === 'measure');
  assert.equal(measure.summaryMs.length, 10);
  assert.equal(measure.fullMs.length, 10);
  assert.equal(seen.context.filter((d) => d === 'full').length, 10);
  assert.equal(seen.usage, 1);
  assert.deepEqual(measure.usage, { subscriptionType: 'max', rateLimitsAvailable: true, windows: { five_hour: { utilization: 12, resetsAt: '2026-10-22T20:00:00Z' }, seven_day: { utilization: 31, resetsAt: '2026-10-27T08:00:00Z' } } });
});
