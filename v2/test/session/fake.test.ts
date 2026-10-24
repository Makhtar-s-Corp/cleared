import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter, exampleScript, type FakeStep } from '../../src/session/adapters/fake.ts';
import { adapterFactories } from '../../src/session/adapters/index.ts';
import { HostToolRefused, NotImplemented, type HostTool, type SessionHandle, type StartInput } from '../../src/session/contract.ts';
import { toolArgs, toolResult, type AgUiEvent, type CustomValue, type SessionEvent } from '../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../src/session/policy.ts';
import { openStore, type Store } from '../../src/store/db.ts';

const apiKey = ['sk', 'ant', 'api03', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4'].join('-');

const input: StartInput = {
  project: 'guestbook',
  ticket: 'LOCAL-1',
  role: 'author',
  harness: 'claude-code',
  model: 'claude-opus-5-5',
  workdir: '/srv/tickets/LOCAL-1',
  briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null },
  policy: { role: 'author', base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: '/run/cleared/claude', safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
  prompt: 'Show the newest entry first.',
};

const script: readonly FakeStep[] = [
  { emit: { type: 'RUN_STARTED', threadId: 'thread', runId: 'run-1' } },
  { emit: { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Bash' } },
  { emit: toolArgs('t1', { kind: 'execute', command: 'npm test' }) },
  { emit: toolResult('m1', 't1', { kind: 'execute', output: `leaked ${apiKey}`, cut: 0, isError: false }) },
  { permission: { requestId: 'q1', toolCallId: 't2', tool: 'Bash', input: { kind: 'execute', command: 'touch x' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule matched' } } },
  { awaitMessage: true },
  { emit: { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run-1', outcome: { type: 'success' }, usage: [{ inputTokens: 10, outputTokens: 5 }], result: { stopReason: 'end_turn', total_cost_usd: 0.01 } } },
];

function withStore(run: (store: Store) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-fake-'));
    const store = openStore(join(dir, 'ledger.db'));
    try { await run(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

async function collect(handle: SessionHandle, after?: number): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of handle.events(after)) out.push(event);
  return out;
}

test('a scripted fake session stores its events cleaned, with increasing seq, and replays from after', withStore(async (store) => {
  const adapter = createFakeAdapter({ log: store.events, script, newId: () => 'session-1' });
  const handle = await adapter.start(input);
  assert.equal(handle.id, 'session-1');

  // start runs the script up to the permission request, then waits.
  const first = store.events.after('session-1');
  assert.deepEqual(first.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(first.at(-1)?.event.type, 'CUSTOM');
  assert.ok(!JSON.stringify(first).includes(apiKey), 'events are cleaned before storage');
  for (const e of first) {
    assert.equal(e.sessionId, 'session-1');
    assert.equal(e.ticket, 'LOCAL-1');
    assert.equal(e.project, 'guestbook');
    assert.ok(!Number.isNaN(Date.parse(e.at)));
  }

  await assert.rejects(handle.answer('unknown', { decision: { kind: 'allow_once' }, by: 'u1' }), /no pending request unknown/);
  await handle.answer('q1', { decision: { kind: 'allow_once' }, by: 'u1' });
  await handle.send({ text: 'Also sort by date.', by: 'u1' });

  const all = await collect(handle);
  assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i + 1), 'seq increases by one');
  assert.deepEqual(all.slice(5).map((e) => e.event.type), ['CUSTOM', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  const answered = all[5]?.event;
  assert.ok(answered?.type === 'CUSTOM' && answered.name === 'cleared.permission_answered');
  assert.deepEqual(answered.value, { requestId: 'q1', decision: 'allow_once', by: 'u1' });
  const start = all[6]?.event;
  assert.ok(start?.type === 'TEXT_MESSAGE_START');
  assert.deepEqual([start.role, start.name], ['user', 'u1']);

  const replay = await collect(handle, 4);
  assert.deepEqual(replay.map((e) => e.seq), all.slice(4).map((e) => e.seq), 'replay starts after the given seq');
  assert.deepEqual(replay, all.slice(4));
  assert.deepEqual(await collect(handle, all.length), []);

  // Another session in the same store counts from 1 again.
  const other = await createFakeAdapter({ log: store.events, script: script.slice(0, 2), newId: () => 'session-2' }).start(input);
  assert.deepEqual((await collect(other)).map((e) => e.seq), [1, 2]);
}));

test('a reader that waits receives events as they are stored, and stop ends the stream', withStore(async (store) => {
  const handle = await createFakeAdapter({ log: store.events, script: [{ awaitMessage: true }, { emit: { type: 'STEP_STARTED', stepName: 'author' } }, { awaitMessage: true }], newId: () => 's' }).start(input);
  const reader = collect(handle);
  await handle.send({ text: 'go', by: 'u1' });
  await handle.stop();
  const events = await reader;
  assert.deepEqual(events.map((e) => e.event.type), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'STEP_STARTED']);
  await assert.rejects(handle.send({ text: 'late', by: 'u1' }), /stopped/);
}));

test('interrupt ends the turn as cancelled and skips to the next message', withStore(async (store) => {
  const handle = await createFakeAdapter({
    log: store.events,
    script: [
      { emit: { type: 'RUN_STARTED', threadId: 's', runId: 'r1' } },
      { permission: { requestId: 'q1', toolCallId: 't1', tool: 'Bash', input: { kind: 'execute', command: 'touch x' }, suggestion: { decision: 'ask', rule: 'default', reason: 'r' } } },
      { emit: { type: 'STEP_FINISHED', stepName: 'author' } },
      { awaitMessage: true },
      { emit: { type: 'RUN_STARTED', threadId: 's', runId: 'r2' } },
    ],
    newId: () => 's',
  }).start(input);
  await handle.interrupt();
  const events = store.events.after('s');
  const last = events.at(-1)?.event;
  assert.ok(last?.type === 'RUN_FINISHED');
  assert.deepEqual(last.outcome, { type: 'cancelled' });
  assert.equal(last.result.stopReason, 'cancelled');
  assert.ok(!events.some((e) => e.event.type === 'STEP_FINISHED'), 'the rest of the turn is skipped');
  await handle.send({ text: 'next', by: 'u1' });
  assert.equal(store.events.after('s').at(-1)?.event.type, 'RUN_STARTED');
}));

test('handover is not implemented in milestone 1; resume replays a known session', withStore(async (store) => {
  const adapter = createFakeAdapter({ log: store.events, script: exampleScript, newId: () => 'demo' });
  const handle = await adapter.start(input);
  await assert.rejects(handle.handover({ harness: 'codex', model: 'gpt' }), NotImplemented);
  const resumed = await adapter.resume('demo');
  assert.equal(resumed.id, 'demo');
  await assert.rejects(adapter.resume('nobody'), /unknown session nobody/);
}));

test('the example script plays a whole author turn the app can render', withStore(async (store) => {
  const adapter = createFakeAdapter({ log: store.events, script: exampleScript, newId: () => 'demo' });
  const handle = await adapter.start(input);
  for (const step of exampleScript) {
    if ('permission' in step) await handle.answer(step.permission.requestId, { decision: { kind: 'allow_once' }, by: 'u1' });
    if ('awaitMessage' in step) await handle.send({ text: 'Looks right.', by: 'u1' });
  }
  const types = new Set(store.events.after('demo').map((e) => e.event.type));
  for (const type of ['RUN_STARTED', 'STEP_STARTED', 'TEXT_MESSAGE_CONTENT', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_RESULT', 'CUSTOM', 'STATE_SNAPSHOT', 'RUN_FINISHED']) {
    assert.ok(types.has(type as never), type);
  }
}));

test('the fake adapter is never registered: claude-code, cursor and codex are (lane 4, milestone 3)', () => {
  assert.deepEqual(Object.keys(adapterFactories), ['claude-code', 'cursor', 'codex']);
});

test('an interrupt with no message left in the script ends the session and its readers (review round 2, finding 5)', withStore(async (store) => {
  const handle = await createFakeAdapter({
    log: store.events,
    script: [
      { emit: { type: 'RUN_STARTED', threadId: 's', runId: 'r1' } },
      { permission: { requestId: 'q1', toolCallId: 't1', tool: 'Bash', input: { kind: 'execute', command: 'touch x' }, suggestion: { decision: 'ask', rule: 'default', reason: 'r' } } },
      { emit: { type: 'STEP_FINISHED', stepName: 'author' } },
    ],
    newId: () => 's',
  }).start(input);
  const reader = collect(handle);
  await handle.interrupt();
  const timeout = new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 2_000).unref());
  const events = await Promise.race([reader, timeout]);
  assert.notEqual(events, 'stuck', 'the reader ends');
  if (events !== 'stuck') assert.equal(events.at(-1)?.event.type, 'RUN_FINISHED');
  await assert.rejects(handle.send({ text: 'late', by: 'u1' }), /stopped/);
}));

// Milestone 2: the fake plays a scripted lead (host tool calls with scripted
// inputs, a scripted context share, a question through AskUserQuestion).
const customs = <N extends keyof CustomValue>(events: readonly SessionEvent[], name: N): CustomValue[N][] =>
  events.flatMap(({ event }) => (event.type === 'CUSTOM' && event.name === name ? [event.value as CustomValue[N]] : []));

test('a scripted lead calls its host tools, which the host answers, refuses or fails', withStore(async (store) => {
  const calls: unknown[] = [];
  const tool = (name: string, handle: HostTool['handle']): HostTool => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object', properties: {} }, handle });
  const tools = [
    tool('state', async (input, context) => { calls.push({ input, context }); return 'one plan, two sessions'; }),
    tool('fulfil', async () => { throw new HostToolRefused('the commitment c9 is not open'); }),
    tool('broken', async () => { throw new Error(`a detail with ${apiKey}`); }),
  ];
  const adapter = createFakeAdapter({
    log: store.events, newId: () => 'lead-1',
    script: [
      { emit: { type: 'RUN_STARTED', threadId: 'lead-1', runId: 'turn-1' } },
      { hostCall: { toolCallId: 'h1', name: 'state', input: {} } },
      { hostCall: { toolCallId: 'h2', name: 'fulfil', input: { id: 'c9', note: 'done' } } },
      { hostCall: { toolCallId: 'h3', name: 'broken', input: {} } },
      { hostCall: { toolCallId: 'h4', name: 'missing', input: {} } },
      { emit: { type: 'RUN_FINISHED', threadId: 'lead-1', runId: 'turn-1', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.02 } } },
    ],
  });
  await adapter.start({ ...input, role: 'lead', ticket: 'lead', tools });
  const events = store.events.after('lead-1');
  assert.deepEqual(calls, [{ input: {}, context: { sessionId: 'lead-1', turn: 'turn-1' } }]);
  assert.deepEqual(customs(events, 'cleared.host_call').map((c) => [c.toolCallId, c.name, c.outcome, c.message]), [
    ['h1', 'state', 'ok', undefined],
    ['h2', 'fulfil', 'refused', 'the commitment c9 is not open'],
    ['h3', 'broken', 'failed', 'the host could not run this tool'],
    ['h4', 'missing', 'failed', 'no host tool is named missing'],
  ]);
  assert.ok(!JSON.stringify(events).includes(apiKey), 'a failure says nothing of its error');
  const starts = events.flatMap(({ event }) => (event.type === 'TOOL_CALL_START' ? [event.toolCallName] : []));
  assert.deepEqual(starts, ['mcp__cleared__state', 'mcp__cleared__fulfil', 'mcp__cleared__broken', 'mcp__cleared__missing']);
  const results = events.flatMap(({ event }) => (event.type === 'TOOL_CALL_RESULT' ? [JSON.parse(event.content).ok] : []));
  assert.deepEqual(results, [true, false, false, false]);
  assert.equal(events.at(-1)?.event.type, 'RUN_FINISHED', 'start returns once every call is answered');
}));

test('a scripted lead reports its context share and asks a question that an answer settles', withStore(async (store) => {
  const usage = (percent: number): CustomValue['cleared.context_usage'] => ({ totalTokens: percent * 2000, maxTokens: 200_000, percent, isAutoCompactEnabled: true });
  const adapter = createFakeAdapter({
    log: store.events, newId: () => 'lead-2',
    script: [
      { emit: { type: 'RUN_STARTED', threadId: 'lead-2', runId: 'turn-1' } },
      { context: usage(12) },
      { question: { requestId: 'q1', questions: [{ question: 'Pages or one long list?', options: [{ label: 'Pages of 20' }, { label: 'One long list' }] }] } },
      { context: usage(45) },
      { emit: { type: 'RUN_FINISHED', threadId: 'lead-2', runId: 'turn-1', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.03 } } },
    ],
  });
  const handle = await adapter.start({ ...input, role: 'lead', ticket: 'lead' });
  let events = store.events.after('lead-2');
  assert.deepEqual(customs(events, 'cleared.context_usage').map((c) => c.percent), [12]);
  const delta = events.find(({ event }) => event.type === 'STATE_DELTA')?.event as Extract<AgUiEvent, { type: 'STATE_DELTA' }>;
  assert.deepEqual(delta.delta, [{ op: 'add', path: '/context', value: { percent: 12, totalTokens: 24_000, maxTokens: 200_000 } }]);
  assert.deepEqual(customs(events, 'cleared.question').map((q) => q.requestId), ['q1']);
  assert.notEqual(events.at(-1)?.event.type, 'RUN_FINISHED', 'the turn waits for the answer');

  await assert.rejects(handle.answer('q2', { decision: { kind: 'answer', answers: {} }, by: 'u1' }), /no pending request q2/);
  await handle.answer('q1', { decision: { kind: 'answer', answers: { 'Pages or one long list?': 'Pages of 20' } }, by: 'u1' });
  events = store.events.after('lead-2');
  assert.deepEqual(customs(events, 'cleared.answered'), [{ requestId: 'q1', by: 'u1' }]);
  assert.deepEqual(customs(events, 'cleared.permission_answered'), [], 'a question is answered, not allowed');
  assert.deepEqual(customs(events, 'cleared.context_usage').map((c) => c.percent), [12, 45]);
  assert.equal(events.at(-1)?.event.type, 'RUN_FINISHED');
}));

test('a message from the lead or from cleared is attributed to it', withStore(async (store) => {
  const handle = await createFakeAdapter({ log: store.events, script: [{ awaitMessage: true }, { awaitMessage: true }], newId: () => 's' }).start(input);
  await handle.send({ text: 'Integrate the base branch first.', by: 'lead' });
  await handle.send({ text: 'The review asks for a change.', by: 'cleared' });
  const names = store.events.after('s').flatMap(({ event }) => (event.type === 'TEXT_MESSAGE_START' ? [event.name] : []));
  assert.deepEqual(names, ['lead', 'cleared']);
}));

// Lane 5 interrupts the lead mid turn when its share crosses the threshold,
// and may stop it while a host call is still being answered.
test('an interrupt while a host call is answered ends the turn there: the call writes nothing after it', withStore(async (store) => {
  let release = () => {};
  let called = () => {};
  const calling = new Promise<void>((resolve) => { called = resolve; });
  const slow: HostTool = {
    name: 'state', description: 'the state', inputSchema: { type: 'object', properties: {} },
    handle: () => { called(); return new Promise((resolve) => { release = () => resolve('late'); }); },
  };
  const handle = await createFakeAdapter({
    log: store.events, newId: () => 's',
    script: [
      { awaitMessage: true },
      { emit: { type: 'RUN_STARTED', threadId: 's', runId: 'r1' } },
      { hostCall: { toolCallId: 'h1', name: 'state', input: {} } },
      { emit: { type: 'STEP_FINISHED', stepName: 'author' } },
      { awaitMessage: true },
      { emit: { type: 'RUN_STARTED', threadId: 's', runId: 'r2' } },
      { awaitMessage: true },
    ],
  }).start({ ...input, role: 'lead', ticket: 'lead', tools: [slow] });
  const sending = handle.send({ text: 'go', by: 'u1' });
  await calling;
  await handle.interrupt();
  release();
  await sending;
  let events = store.events.after('s');
  const last = events.at(-1)?.event;
  assert.ok(last?.type === 'RUN_FINISHED' && last.outcome.type === 'cancelled', JSON.stringify(last));
  assert.ok(!events.some(({ event }) => event.type === 'TOOL_CALL_RESULT' || event.type === 'STEP_FINISHED' || (event.type === 'CUSTOM' && event.name === 'cleared.host_call')));
  await handle.send({ text: 'next', by: 'u1' });
  events = store.events.after('s');
  assert.ok(events.at(-1)?.event.type === 'RUN_STARTED');
  assert.equal((events.at(-1)?.event as { runId: string }).runId, 'r2', 'the next message starts the next turn');
}));

test('a stop while a host call is answered writes nothing after the stop', withStore(async (store) => {
  let release = () => {};
  const slow: HostTool = {
    name: 'state', description: 'the state', inputSchema: { type: 'object', properties: {} },
    handle: () => new Promise((resolve) => { release = () => resolve('late'); }),
  };
  const handle = await createFakeAdapter({
    log: store.events, newId: () => 's',
    script: [{ awaitMessage: true }, { hostCall: { toolCallId: 'h1', name: 'state', input: {} } }, { emit: { type: 'STEP_FINISHED', stepName: 'author' } }],
  }).start({ ...input, role: 'lead', ticket: 'lead', tools: [slow] });
  const sending = handle.send({ text: 'go', by: 'u1' });
  await new Promise((resolve) => setImmediate(resolve));
  await handle.stop();
  const count = store.events.after('s').length;
  release();
  await sending;
  assert.equal(store.events.after('s').length, count);
}));

test('a reader sees a context share before the turn goes on, and can interrupt the turn there', withStore(async (store) => {
  const handle = await createFakeAdapter({
    log: store.events, newId: () => 's',
    script: [
      { awaitMessage: true },
      { emit: { type: 'RUN_STARTED', threadId: 's', runId: 'r1' } },
      { context: { totalTokens: 110_000, maxTokens: 200_000, percent: 55, isAutoCompactEnabled: true } },
      { emit: { type: 'STEP_FINISHED', stepName: 'author' } },
      { awaitMessage: true },
    ],
  }).start({ ...input, role: 'lead', ticket: 'lead' });
  const watching = (async () => {
    for await (const { event } of handle.events()) {
      if (event.type === 'CUSTOM' && event.name === 'cleared.context_usage' && event.value.percent >= 50) {
        await handle.interrupt();
        return;
      }
    }
  })();
  await handle.send({ text: 'go', by: 'u1' });
  await watching;
  const events = store.events.after('s');
  assert.ok(!events.some(({ event }) => event.type === 'STEP_FINISHED'), 'the turn stopped at the measure');
  assert.equal(events.at(-1)?.event.type, 'RUN_FINISHED');
}));
