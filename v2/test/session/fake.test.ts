import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter, exampleScript, type FakeStep } from '../../src/session/adapters/fake.ts';
import { adapterFactories } from '../../src/session/adapters/index.ts';
import { NotImplemented, type SessionHandle, type StartInput } from '../../src/session/contract.ts';
import { toolArgs, toolResult, type SessionEvent } from '../../src/session/events.ts';
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

test('the fake adapter is never registered: only claude-code is (lane 4)', () => {
  assert.deepEqual(Object.keys(adapterFactories), ['claude-code']);
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
