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

type Options = Record<string, unknown> & {
  canUseTool?: (tool: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }) => Promise<Record<string, unknown>>;
};

// A query() stand-in: it hands each user message to `turn`, yields what
// `turn` yields, and records the calls the runner makes on it.
function fakeQuery(turn: (message: Record<string, unknown>, options: Options) => AsyncGenerator<Record<string, unknown>>) {
  const seen = { options: undefined as Options | undefined, prompts: [] as Record<string, unknown>[], interrupts: 0, closes: 0 };
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
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.persistSession, true);
  assert.equal(options.includePartialMessages, false);
  assert.equal(options.maxBudgetUsd, 0.5);
  assert.equal(options.pathToClaudeCodeExecutable, CLAUDE_BIN);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(options.hooks, { ...hooks });
  assert.equal(typeof options.canUseTool, 'function');
  const env = options.env as Record<string, string | undefined>;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, '/usr/bin');

  assert.deepEqual(seen.prompts, [{ type: 'user', message: { role: 'user', content: 'Reply OK.' }, parent_tool_use_id: null, uuid: 'u-1', origin: { kind: 'human' } }]);
  assert.deepEqual(out, [{ type: 'sdk', message: result('OK') }, { type: 'exit', code: 0 }]);
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
  await until(() => out.length === 3);
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
  await until(() => out.length === 2);
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
