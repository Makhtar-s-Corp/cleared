// The host side of the Claude Code adapter, on a fake docker CLI and a fake
// runner process: the test reads what the adapter writes to the runner's
// stdin and writes the runner's lines to its stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker, LABEL, SESSION_LABEL } from '../../../src/container/docker.ts';
import { parseServices } from '../../../src/container/services.ts';
import { DEFAULT_LIMITS, LOGIN_FILE_MOUNT, SESSION_IMAGE, WORKDIR_MOUNT, sessionNames } from '../../../src/container/session-runtime.ts';
import { RUNNER_COMMAND, claudeCodeRuntime, createClaudeCodeAdapter } from '../../../src/session/adapters/claude-code.ts';
import { CONFIG_PROGRAM, INTERACTIVE_LAUNCH, LOGIN_TOKEN_PROGRAM } from '../../../src/session/adapters/claude-code/interactive.ts';
import { adapterFactories } from '../../../src/session/adapters/index.ts';
import { createCleaner } from '../../../src/session/clean.ts';
import { CONTAINER_LOST, HandoverRefused, HostToolRefused, type HostCallContext, type HostTool, type SessionHandle, type StartInput } from '../../../src/session/contract.ts';
import type { AgUiEvent, EventLog, SessionEvent } from '../../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../../src/session/policy.ts';
import { FakeDocker } from '../../container/fake-docker.ts';
import { FakeRunner } from './fake-runner.ts';

const SESSION = '0b7e6f2c-3d4a-4e5f-8a9b-1c2d3e4f5a6b';

function memoryLog(): EventLog & { readonly all: SessionEvent[] } {
  const all: SessionEvent[] = [];
  return {
    all,
    append(entry) {
      const event = { ...entry, seq: all.filter((e) => e.sessionId === entry.sessionId).length + 1 };
      all.push(event);
      return event;
    },
    after(sessionId, seq = 0) {
      return all.filter((e) => e.sessionId === sessionId && e.seq > seq);
    },
  };
}

const input = (workdir: string): StartInput => ({
  project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-haiku-5-5', workdir,
  briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null },
  policy: { role: 'author', base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: LOGIN_FILE_MOUNT, safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: ['registry.npmjs.org'], forbiddenHosts: ['prod.example.invalid'], ticketFiles: [], learned: [] },
  prompt: 'Show the newest entry first.',
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-cc-'));
  const workdir = join(dir, 'work');
  mkdirSync(workdir);
  writeFileSync(join(workdir, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  const fake = new FakeDocker();
  const runners: FakeRunner[] = [];
  // A killed session container ends its attached runner with 137 and no exit line.
  fake.onKill = () => { runners.at(-1)?.exit(137); };
  const docker = new Docker(fake.runner, (args) => {
    fake.calls.push({ args: [...args], options: {}, result: { code: 0, stdout: '', stderr: '' } });
    // `docker start --attach` runs the container it names.
    const attached = fake.containers.find((c) => c.id === args.at(-1));
    if (attached) attached.state = 'running';
    const runner = new FakeRunner();
    runners.push(runner);
    return runner.process;
  });
  const log = memoryLog();
  let n = 0;
  const adapter = createClaudeCodeAdapter({
    log, cleaner: () => createCleaner({ secrets: [['sk', 'ant', 'oat01', 'TOKENVALUEFORTESTS'].join('-')] }), docker,
    runtime: { stateDir: join(dir, 'state'), loginFile: join(dir, 'claude.token'), hostAddresses: ['192.0.2.10'], user: '1000:1000', maxBudgetUsd: 1, stopTimeoutMs: 200, releaseTimeoutMs: 200 },
    newId: () => (n++ === 0 ? SESSION : `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`),
    now: () => new Date('2026-10-21T20:00:00.000Z'),
  });
  return { dir, workdir, fake, docker, runners, log, adapter, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const types = (events: readonly SessionEvent[]) => events.map((e) => (e.event.type === 'CUSTOM' ? e.event.name : e.event.type));
const events = (log: { all: SessionEvent[] }) => log.all.map((e) => e.event);
const custom = (log: { all: SessionEvent[] }, name: string) => events(log).filter((e): e is Extract<AgUiEvent, { type: 'CUSTOM' }> => e.type === 'CUSTOM' && e.name === name).map((e) => e.value);
const settle = () => new Promise((r) => setTimeout(r, 20));

// The environment's version (issue #452): its image and its limits, over
// the runtime's; none named, the session is created as before.
test('the session\'s environment names its image and its limits; without them, Cleared\'s own', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start({ ...input(t.workdir), image: 'cleared-v2-session:custom', limits: { cpus: '1', memory: '2g' } });
    const create = t.fake.calls.find((c) => c.args[0] === 'create' && c.args.includes('cleared.role=session'));
    assert.ok(create);
    const args = create.args;
    assert.deepEqual(args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 8), ['--memory', '2g', '--memory-swap', '2g', '--cpus', '1', '--pids-limit', String(DEFAULT_LIMITS.pids)]);
    assert.equal(args[args.indexOf('--') + 1], 'cleared-v2-session:custom');
    await handle.stop();
  } finally { t.cleanup(); }
  const u = await setup();
  try {
    const handle = await u.adapter.start(input(u.workdir));
    const args = u.fake.calls.find((c) => c.args[0] === 'create' && c.args.includes('cleared.role=session'))?.args ?? [];
    assert.deepEqual(args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 8), ['--memory', DEFAULT_LIMITS.memory, '--memory-swap', DEFAULT_LIMITS.memory, '--cpus', DEFAULT_LIMITS.cpus, '--pids-limit', String(DEFAULT_LIMITS.pids)]);
    assert.equal(args[args.indexOf('--') + 1], SESSION_IMAGE);
    await handle.stop();
  } finally { u.cleanup(); }
});

test('start creates the labelled session, attaches the runner and sends start, then the prompt', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    assert.equal(handle.id, SESSION);
    const create = t.fake.calls.find((c) => c.args[0] === 'create' && c.args.includes(`cleared.role=session`));
    assert.ok(create, 'a session container was created');
    const args = create.args;
    assert.ok(args.includes(LABEL) && args.includes(`${SESSION_LABEL}=${SESSION}`));
    assert.ok(args.includes('--interactive'));
    assert.deepEqual(args.slice(args.indexOf('--') + 2), [...RUNNER_COMMAND]);
    assert.ok(args.includes(`type=bind,source=${join(t.dir, 'claude.token')},target=${LOGIN_FILE_MOUNT},readonly`));
    assert.ok(args.includes(`type=bind,source=${t.workdir},target=${WORKDIR_MOUNT}`));
    assert.ok(t.fake.calls.some((c) => c.args.join(' ').startsWith('start --attach --interactive --')));
    // Nothing secret on a docker command line: the token is read inside the container.
    assert.ok(!t.fake.calls.some((c) => c.args.some((arg) => arg.includes('CLAUDE_CODE_OAUTH_TOKEN'))));

    const runner = t.runners[0] as FakeRunner;
    const start = await runner.waitFor((line) => line.type === 'start');
    assert.deepEqual(start, { type: 'start', sessionId: SESSION, model: 'claude-haiku-5-5', resume: false, role: 'author', maxBudgetUsd: 1 });
    const first = await runner.waitFor((line) => line.type === 'user');
    assert.equal(first.text, 'Show the newest entry first.');
    assert.equal(runner.received.indexOf(start), 0);
    assert.deepEqual(types(t.log.all), ['STATE_SNAPSHOT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
    assert.deepEqual(t.log.all.map((e) => e.seq), [1, 2, 3, 4]);
    assert.ok(t.log.all.every((e) => e.ticket === 'LOCAL-1' && e.project === 'guestbook' && e.sessionId === SESSION));
    await handle.stop();
  } finally { t.cleanup(); }
});

test('the test services of the start input run beside the session, which gets their address', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start({ ...input(t.workdir), services: parseServices('postgres:16') });
    const service = t.fake.calls.find((c) => c.args[0] === 'create' && c.args.includes('cleared.role=service'));
    assert.ok(service, 'a service container was created');
    assert.equal(service.args[service.args.indexOf('--') + 1], 'postgres:16');
    const session = t.fake.calls.find((c) => c.args[0] === 'create' && c.args.includes('cleared.role=session'));
    assert.ok(session?.args.includes('DATABASE_URL=postgres://postgres@postgres:5432/postgres'));
    await handle.stop();
  } finally { t.cleanup(); }
});

test('the policy answers what it can, and an ask waits for the inbox', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    runner.sdk({ type: 'command_lifecycle', state: 'started', command_uuid: 'turn-1' });
    runner.say({ type: 'permission_request', requestId: 'r-edit', toolName: 'Edit', toolUseId: 'toolu_1', input: { file_path: '/workspace/a.txt', old_string: 'a', new_string: 'b' } });
    runner.say({ type: 'permission_request', requestId: 'r-push', toolName: 'Bash', toolUseId: 'toolu_2', input: { command: 'git push origin main' } });
    runner.say({ type: 'permission_request', requestId: 'r-touch', toolName: 'Bash', toolUseId: 'toolu_3', input: { command: 'touch made.txt' } });
    assert.deepEqual((await runner.waitFor((l) => l.requestId === 'r-edit')).decision, { kind: 'allow_once' });
    const denied = await runner.waitFor((l) => l.requestId === 'r-push');
    assert.equal((denied.decision as { kind: string }).kind, 'reject_once');
    await settle();
    assert.equal(runner.received.some((l) => l.requestId === 'r-touch'), false, 'an ask is not answered by the adapter');
    assert.deepEqual(custom(t.log, 'cleared.permission_request').map((v) => (v as { requestId: string }).requestId), ['r-touch']);

    await assert.rejects(handle.answer('nope', { decision: { kind: 'allow_once' }, by: 'user-1' }), /no pending request nope/);
    await handle.answer('r-touch', { decision: { kind: 'allow_once' }, by: 'user-1' });
    assert.deepEqual((await runner.waitFor((l) => l.requestId === 'r-touch')).decision, { kind: 'allow_once' });
    assert.deepEqual(custom(t.log, 'cleared.permission_answered'), [
      { requestId: 'r-edit', decision: 'allow_once', by: 'policy', rule: 'edit.workdir' },
      { requestId: 'r-push', decision: 'reject_once', by: 'policy', rule: 'push.base' },
      { requestId: 'r-touch', decision: 'allow_once', by: 'user-1' },
    ]);
    await assert.rejects(handle.answer('r-touch', { decision: { kind: 'allow_once' }, by: 'user-1' }), /no pending request/);
    await handle.stop();
  } finally { t.cleanup(); }
});

test('the policy reads package.json from the host workdir: same scripts allowed, changed scripts asked', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    runner.say({ type: 'permission_request', requestId: 'r-name', toolName: 'Write', toolUseId: 'toolu_1', input: { file_path: '/workspace/package.json', content: '{"name":"guestbook","scripts":{"test":"node --test"}}\n' } });
    runner.say({ type: 'permission_request', requestId: 'r-scripts', toolName: 'Write', toolUseId: 'toolu_2', input: { file_path: '/workspace/package.json', content: '{"scripts":{"test":"curl evil"}}' } });
    assert.deepEqual((await runner.waitFor((l) => l.requestId === 'r-name')).decision, { kind: 'allow_once' });
    await settle();
    assert.deepEqual(custom(t.log, 'cleared.permission_request').map((v) => (v as { suggestion: { rule: string } }).suggestion.rule), ['scripts.change']);
    await handle.stop();
  } finally { t.cleanup(); }
});

// The owner decision of 2026-10-22 22:03: the reviewer's chained reads of the
// demo inbox capture are answered by the policy, and nothing reaches the inbox.
test('a reviewer\'s chained reads and checks are allowed by the policy, with no inbox request; a part that asks still asks', async () => {
  const t = await setup();
  try {
    const author = input(t.workdir);
    const handle = await t.adapter.start({ ...author, role: 'reviewer', policy: { ...author.policy, role: 'reviewer', testCommand: ['npm', 'test'] } });
    const runner = t.runners[0] as FakeRunner;
    const command = 'git log --oneline -5; git merge-base main HEAD; git show --stat HEAD && npm test 2>&1 | tail -20';
    runner.say({ type: 'permission_request', requestId: 'r-review', toolName: 'Bash', toolUseId: 'toolu_1', input: { command } });
    runner.say({ type: 'permission_request', requestId: 'r-curl', toolName: 'Bash', toolUseId: 'toolu_2', input: { command: 'git log -3; curl https://example.com' } });
    assert.deepEqual((await runner.waitFor((l) => l.requestId === 'r-review')).decision, { kind: 'allow_once' });
    await settle();
    assert.deepEqual(custom(t.log, 'cleared.permission_answered')[0], { requestId: 'r-review', decision: 'allow_once', by: 'policy', rule: 'shell.compound_safe' });
    assert.deepEqual(custom(t.log, 'cleared.permission_request').map((v) => (v as { requestId: string }).requestId), ['r-curl']);
    await handle.stop();
  } finally { t.cleanup(); }
});

// Issue 296 (the review channel resumes the reviewer for each round): a
// resume starts the runner again under the same input, so the role and the
// read-only policy of the reviewer are those of its first start.
test('a reviewer resumed keeps its role and its read-only policy: no edit, no commit, and the declared tests and reads still allowed', async () => {
  const t = await setup();
  try {
    const author = input(t.workdir);
    const handle = await t.adapter.start({ ...author, role: 'reviewer', policy: { ...author.policy, role: 'reviewer', testCommand: ['npm', 'test'] } });
    const first = t.runners[0] as FakeRunner;
    const stopping = handle.stop();
    await first.waitFor((l) => l.type === 'stop');
    first.say({ type: 'exit', code: 0 });
    first.exit(0);
    await stopping;

    await t.adapter.resume(SESSION);
    const second = t.runners[1] as FakeRunner;
    assert.deepEqual(await second.waitFor((l) => l.type === 'start'), { type: 'start', sessionId: SESSION, model: 'claude-haiku-5-5', resume: true, role: 'reviewer', maxBudgetUsd: 1 });
    const ask = (requestId: string, toolName: string, input: Record<string, unknown>) => second.say({ type: 'permission_request', requestId, toolName, toolUseId: `toolu_${requestId}`, input });
    ask('r-write', 'Write', { file_path: '/workspace/src/entries.ts', content: 'x' });
    ask('r-commit', 'Bash', { command: 'git commit -am fix' });
    ask('r-tests', 'Bash', { command: 'npm test' });
    ask('r-read', 'Read', { file_path: '/workspace/src/entries.ts' });
    const decision = async (requestId: string) => (await second.waitFor((l) => l.requestId === requestId)).decision;
    assert.equal(((await decision('r-write')) as { kind: string }).kind, 'reject_once');
    assert.equal(((await decision('r-commit')) as { kind: string }).kind, 'reject_once');
    assert.deepEqual(await decision('r-tests'), { kind: 'allow_once' });
    assert.deepEqual(await decision('r-read'), { kind: 'allow_once' });
    await settle();
    const answered = custom(t.log, 'cleared.permission_answered') as { requestId: string; rule: string }[];
    assert.deepEqual(answered.map((a) => `${a.requestId}:${a.rule}`), ['r-write:reviewer.edit', 'r-commit:reviewer.edit', 'r-tests:reviewer.tests', 'r-read:read.workdir']);
    assert.equal(custom(t.log, 'cleared.permission_request').length, 0, 'nothing reaches the inbox');
    const stoppingAgain = (await t.adapter.resume(SESSION)).stop();
    await second.waitFor((l) => l.type === 'stop');
    second.exit(0);
    await stoppingAgain;
  } finally { t.cleanup(); }
});

test('a question goes to the inbox and its answer goes back with the answers', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    runner.say({ type: 'question', requestId: 'q-1', toolUseId: 'toolu_q', questions: [{ question: 'Which order?', header: 'Order', options: [{ label: 'Newest', description: 'n' }, { label: 'Oldest', description: 'o' }], multiSelect: false }] });
    await settle();
    assert.equal(custom(t.log, 'cleared.question').length, 1);
    await handle.answer('q-1', { decision: { kind: 'answer', answers: { 'Which order?': 'Newest' } }, by: 'user-1' });
    assert.deepEqual((await runner.waitFor((l) => l.requestId === 'q-1')).decision, { kind: 'answer', answers: { 'Which order?': 'Newest' } });
    assert.deepEqual(custom(t.log, 'cleared.answered'), [{ requestId: 'q-1', by: 'user-1' }]);
    await handle.stop();
  } finally { t.cleanup(); }
});

test('send writes a user line with its uuid; interrupt cancels a waiting request and the turn ends cancelled', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    runner.sdk({ type: 'command_lifecycle', state: 'started', command_uuid: 'turn-1' });
    runner.say({ type: 'permission_request', requestId: 'r-touch', toolName: 'Bash', toolUseId: 'toolu_3', input: { command: 'touch made.txt' } });
    await settle();
    await handle.send({ text: 'Also sort by date.', by: 'user-2' });
    const sent = await runner.waitFor((l) => l.type === 'user' && l.text === 'Also sort by date.');
    assert.equal(typeof sent.uuid, 'string');
    const message = events(t.log).find((e) => e.type === 'TEXT_MESSAGE_START' && e.name === 'user-2');
    assert.ok(message && message.type === 'TEXT_MESSAGE_START' && message.messageId === sent.uuid);

    await handle.interrupt();
    await runner.waitFor((l) => l.type === 'interrupt');
    assert.deepEqual((await runner.waitFor((l) => l.requestId === 'r-touch')).decision, { kind: 'cancelled' });
    runner.say({ type: 'request_cancelled', requestId: 'r-touch' });
    runner.sdk({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], usage: {}, modelUsage: {}, total_cost_usd: 0.01 });
    await settle();
    assert.deepEqual(custom(t.log, 'cleared.permission_answered'), [{ requestId: 'r-touch', decision: 'cancelled', by: 'policy', rule: 'interrupt' }]);
    const finished = events(t.log).filter((e) => e.type === 'RUN_FINISHED');
    assert.deepEqual(finished.map((e) => e.type === 'RUN_FINISHED' && [e.outcome.type, e.result.stopReason]), [['cancelled', 'cancelled']]);
    await handle.stop();
  } finally { t.cleanup(); }
});

test('stop removes the containers and networks, keeps the volume, ends the stream; resume starts a new container', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    const seen: SessionEvent[] = [];
    const reading = (async () => { for await (const event of handle.events()) seen.push(event); })();
    const stopping = handle.stop();
    await runner.waitFor((l) => l.type === 'stop');
    runner.say({ type: 'exit', code: 0 });
    runner.exit(0);
    await stopping;
    await reading;
    assert.equal(t.fake.containers.filter((c) => c.labels[SESSION_LABEL] === SESSION).length, 0);
    assert.equal(t.fake.networks.filter((n) => n.labels[SESSION_LABEL] === SESSION).length, 0);
    assert.equal(t.fake.volumes.filter((v) => v.labels[SESSION_LABEL] === SESSION).length, 1);
    assert.deepEqual(types(seen).slice(-1), ['STATE_DELTA']);
    await assert.rejects(handle.send({ text: 'late', by: 'user-1' }), /stopped/);

    const resumed = await t.adapter.resume(SESSION);
    assert.equal(resumed.id, SESSION);
    const second = t.runners[1] as FakeRunner;
    assert.deepEqual(await second.waitFor((l) => l.type === 'start'), { type: 'start', sessionId: SESSION, model: 'claude-haiku-5-5', resume: true, role: 'author', maxBudgetUsd: 1 });
    assert.equal(second.received.some((l) => l.type === 'user'), false, 'a resume sends no prompt');
    // The stream goes on with the same seq numbering.
    const before = t.log.all.length;
    await resumed.send({ text: 'Which word?', by: 'user-1' });
    assert.ok(t.log.all.length > before);
    assert.deepEqual(t.log.all.map((e) => e.seq), t.log.all.map((_, i) => i + 1));
    await assert.rejects(t.adapter.resume('11111111-2222-4333-8444-555555555555'), /unknown session/);
    // A running session is not started twice.
    assert.equal(await t.adapter.resume(SESSION), resumed);
    const stoppingAgain = resumed.stop();
    await second.waitFor((l) => l.type === 'stop');
    second.exit(0);
    await stoppingAgain;
  } finally { t.cleanup(); }
});

test('a runner that dies is a RUN_ERROR and the session is closed; stop still cleans up after a timeout', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    runner.stderr.write('a crash trace\n');
    runner.exit(1);
    await settle();
    // With no exit line, the container's command ended: the container stopped (issue #453).
    const errors = events(t.log).filter((e) => e.type === 'RUN_ERROR');
    assert.deepEqual(errors.map((e) => e.type === 'RUN_ERROR' && e.code), [CONTAINER_LOST]);
    await assert.rejects(handle.send({ text: 'hello?', by: 'user-1' }), /stopped/);
    await handle.stop();
    assert.equal(t.fake.containers.filter((c) => c.labels[SESSION_LABEL] === SESSION).length, 0);

    // A runner that never answers stop is removed with its container.
    const other = await t.adapter.start({ ...input(t.workdir), ticket: 'LOCAL-2' });
    const silent = t.runners[1] as FakeRunner;
    await other.stop();
    await silent.waitFor((l) => l.type === 'stop');
    assert.equal(t.fake.containers.filter((c) => c.labels[SESSION_LABEL] === other.id).length, 0);
  } finally { t.cleanup(); }
});

test('handover gives up a note to codex and refuses Cursor; another harness is refused at start; the adapter is registered', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.adapter.start({ ...input(t.workdir), harness: 'codex' }), /claude-code/);
    const handle: SessionHandle = await t.adapter.start(input(t.workdir));
    const out = await handle.handover({ harness: 'codex', model: 'gpt' });
    assert.deepEqual({ session: out.session, from: out.from, to: out.to }, { session: handle.id, from: 'claude-code', to: { harness: 'codex', model: 'gpt' } });
    assert.equal(typeof out.note, 'string');
    await assert.rejects(handle.handover({ harness: 'cursor', model: 'm' }), HandoverRefused);
    await assert.rejects(handle.handover({ harness: 'claude-code', model: 'm' }), HandoverRefused);
    await handle.stop();
    assert.equal(typeof adapterFactories['claude-code'], 'function');
    assert.equal(adapterFactories['claude-code']?.({ log: memoryLog(), cleaner: () => createCleaner() }).harness, 'claude-code');
    const runtime = claudeCodeRuntime({ HOME: '/home/svc' });
    assert.equal(runtime.stateDir, '/home/svc/.local/state/cleared-v2');
    assert.equal(runtime.loginFile, '/home/svc/.local/state/cleared-v2/claude.token');
    assert.equal(claudeCodeRuntime({ HOME: '/h', CLEARED_V2_STATE_DIR: '/srv/state' }).loginFile, '/srv/state/claude.token');
    // The service account's existing Claude Code login, named by the environment only.
    assert.equal(claudeCodeRuntime({ HOME: '/h', CLEARED_CLAUDE_CREDENTIALS: '/srv/login/credentials.json' }).loginFile, '/srv/login/credentials.json');
  } finally { t.cleanup(); }
});

test('a tool check is denied by the policy before the tool runs, and only a deny is reported', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    runner.say({ type: 'tool_check', requestId: 'c-env', toolName: 'Read', toolUseId: 'toolu_1', input: { file_path: '/workspace/.env' } });
    runner.say({ type: 'tool_check', requestId: 'c-notes', toolName: 'Read', toolUseId: 'toolu_2', input: { file_path: '/workspace/notes.txt' } });
    runner.say({ type: 'tool_check', requestId: 'c-touch', toolName: 'Bash', toolUseId: 'toolu_3', input: { command: 'touch x' } });
    // The claude process's environment holds the login (review round 1 of PR 143).
    runner.say({ type: 'tool_check', requestId: 'c-environ', toolName: 'Bash', toolUseId: 'toolu_4', input: { command: 'cat /proc/1/environ' } });
    runner.say({ type: 'tool_check', requestId: 'c-printenv', toolName: 'Bash', toolUseId: 'toolu_5', input: { command: 'printenv' } });
    const env = await runner.waitFor((l) => l.requestId === 'c-env');
    assert.equal(env.type, 'tool_verdict');
    assert.match(String(env.deny), /\S/);
    assert.deepEqual(await runner.waitFor((l) => l.requestId === 'c-notes'), { type: 'tool_verdict', requestId: 'c-notes' });
    // An ask is for canUseTool to raise; the check lets it through to it.
    assert.deepEqual(await runner.waitFor((l) => l.requestId === 'c-touch'), { type: 'tool_verdict', requestId: 'c-touch' });
    for (const requestId of ['c-environ', 'c-printenv']) assert.match(String((await runner.waitFor((l) => l.requestId === requestId)).deny), /\S/);
    assert.deepEqual(custom(t.log, 'cleared.permission_answered'), ['c-env', 'c-environ', 'c-printenv'].map((requestId) => ({ requestId, decision: 'reject_once', by: 'policy', rule: 'secret.read' })));
    assert.deepEqual(custom(t.log, 'cleared.permission_request'), []);
    await handle.stop();
  } finally { t.cleanup(); }
});

// Milestone 2 (lane 4): the host tools.
const secret = ['sk', 'ant', 'oat01', 'TOKENVALUEFORTESTS'].join('-');
function leadInput(workdir: string, calls: { name: string; input: unknown; context: HostCallContext }[]): StartInput {
  const schema = { type: 'object', properties: { word: { type: 'string', description: 'A word.' } }, required: ['word'] } as const;
  const tool = (name: string, handle: (input: unknown) => Promise<unknown>): HostTool => ({
    name, description: `The ${name} tool.`, inputSchema: schema,
    async handle(value, context) { calls.push({ name, input: value, context }); return handle(value); },
  });
  return {
    ...input(workdir), ticket: 'lead', role: 'lead',
    policy: { ...input(workdir).policy, role: 'lead' },
    tools: [
      tool('ping', async (value) => `pong ${(value as { word: string }).word}`),
      tool('state', async () => ({ plans: 0, live: ['s-1'] })),
      tool('fulfil', async () => { throw new HostToolRefused('This commitment is not open.'); }),
      tool('commit', async () => { throw new Error(`the database at /var/lib/x is locked ${secret}`); }),
    ],
  };
}

test('a lead starts with its role and its tools (without the handlers); each host call runs the handler and answers the runner', async () => {
  const t = await setup();
  try {
    const calls: { name: string; input: unknown; context: HostCallContext }[] = [];
    const handle = await t.adapter.start(leadInput(t.workdir, calls));
    const runner = t.runners[0] as FakeRunner;
    const start = await runner.waitFor((line) => line.type === 'start');
    assert.equal(start.role, 'lead');
    assert.deepEqual((start.tools as { name: string }[]).map((tool) => tool.name), ['ping', 'state', 'fulfil', 'commit']);
    assert.deepEqual(Object.keys((start.tools as Record<string, unknown>[])[0] ?? {}).sort(), ['description', 'inputSchema', 'name']);

    runner.sdk({ type: 'command_lifecycle', state: 'started', command_uuid: 'turn-1' });
    runner.say({ type: 'host_call', callId: 'c-1', toolUseId: 'toolu_1', name: 'ping', input: { word: 'plum' } });
    runner.say({ type: 'host_call', callId: 'c-2', toolUseId: 'toolu_2', name: 'state', input: {} });
    runner.say({ type: 'host_call', callId: 'c-3', toolUseId: '', name: 'fulfil', input: { word: 'x' } });
    runner.say({ type: 'host_call', callId: 'c-4', toolUseId: 'toolu_4', name: 'commit', input: { word: secret } });
    runner.say({ type: 'host_call', callId: 'c-5', toolUseId: 'toolu_5', name: 'search_memory', input: { query: 'x' } });
    const results = await Promise.all(['c-1', 'c-2', 'c-3', 'c-4', 'c-5'].map((callId) => runner.waitFor((line) => line.type === 'host_result' && line.callId === callId)));
    assert.deepEqual(results, [
      { type: 'host_result', callId: 'c-1', ok: true, text: 'pong plum' },
      { type: 'host_result', callId: 'c-2', ok: true, text: '{"plans":0,"live":["s-1"]}' },
      { type: 'host_result', callId: 'c-3', ok: false, text: 'This commitment is not open.' },
      { type: 'host_result', callId: 'c-4', ok: false, text: 'The host could not run this tool.' },
      // A name the start input did not give is not answered by any handler (issue 163).
      { type: 'host_result', callId: 'c-5', ok: false, text: 'No host tool is named search_memory.' },
    ]);
    assert.deepEqual(calls.map((call) => [call.name, call.context]), [
      ['ping', { sessionId: SESSION, turn: 'turn-1' }], ['state', { sessionId: SESSION, turn: 'turn-1' }],
      ['fulfil', { sessionId: SESSION, turn: 'turn-1' }], ['commit', { sessionId: SESSION, turn: 'turn-1' }],
    ]);
    await settle();
    // Each call is recorded when it is answered: an unknown name at once.
    const recorded = custom(t.log, 'cleared.host_call') as { toolCallId: string }[];
    assert.deepEqual([...recorded].sort((a, b) => a.toolCallId.replace('c-3', 'toolu_3').localeCompare(b.toolCallId.replace('c-3', 'toolu_3'))), [
      { toolCallId: 'toolu_1', name: 'ping', input: { word: 'plum' }, outcome: 'ok' },
      { toolCallId: 'toolu_2', name: 'state', input: {}, outcome: 'ok' },
      // Without a tool use id, the call's own id.
      { toolCallId: 'c-3', name: 'fulfil', input: { word: 'x' }, outcome: 'refused', message: 'This commitment is not open.' },
      { toolCallId: 'toolu_4', name: 'commit', input: { word: '[removed: secret]' }, outcome: 'failed', message: 'The host could not run this tool.' },
      { toolCallId: 'toolu_5', name: 'search_memory', input: { query: 'x' }, outcome: 'failed', message: 'No host tool is named search_memory.' },
    ]);
    // The failure's own message and the secret stay on the host.
    assert.ok(!JSON.stringify(t.log.all).includes('/var/lib/x') && !JSON.stringify(t.log.all).includes(secret));
    await handle.stop();
  } finally { t.cleanup(); }
});

test('the runner\'s context line is stored as cleared.context_usage and the context of the state', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    await runner.waitFor((line) => line.type === 'start');
    runner.say({ type: 'context', after: 'turn', detail: 'summary', ms: 4, totalTokens: 62_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 31, isAutoCompactEnabled: true, autoCompactThreshold: 167_000 });
    await settle();
    assert.deepEqual(custom(t.log, 'cleared.context_usage'), [{ percent: 31, totalTokens: 62_000, maxTokens: 200_000, rawMaxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true }]);
    assert.deepEqual(events(t.log).at(-1), { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/context', value: { percent: 31, totalTokens: 62_000, maxTokens: 200_000 } }] });
    await handle.stop();
  } finally { t.cleanup(); }
});

test('a host call answered after the session stopped writes nothing to a runner that is gone', async () => {
  const t = await setup();
  try {
    let release: (value: string) => void = () => {};
    const slow: HostTool = { name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: {} }, handle: () => new Promise<string>((resolve) => { release = resolve; }) };
    const handle = await t.adapter.start({ ...input(t.workdir), role: 'lead', tools: [slow] });
    const runner = t.runners[0] as FakeRunner;
    runner.say({ type: 'host_call', callId: 'c-1', toolUseId: 't-1', name: 'ping', input: {} });
    await settle();
    const stopping = handle.stop();
    runner.exit(0);
    await stopping;
    release('late');
    await settle();
    assert.ok(!runner.received.some((line) => line.type === 'host_result'));
    assert.deepEqual(custom(t.log, 'cleared.host_call'), []);
  } finally { t.cleanup(); }
});

// Take over with the harness attached (owner request of 2026-10-22 17:26):
// the runner hands Claude Code over, the human runs it resumed on the same
// session in the container, and Give back takes it back from the transcript.
test('interactive hands the runner\'s harness over and gives Claude Code resumed on the session, with no login on any word; Give back reloads it', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    await runner.waitFor((line) => line.type === 'user');
    const asking = t.adapter.interactive?.(SESSION);
    assert.ok(asking, 'the Claude Code adapter has an interactive resume');
    await runner.waitFor((line) => line.type === 'release');
    runner.say({ type: 'released' });
    const resume = await asking;
    assert.deepEqual(resume, {
      supported: true, name: 'Claude Code',
      command: ['sh', '-c', INTERACTIVE_LAUNCH, 'claude-code', SESSION, 'claude-haiku-5-5', LOGIN_TOKEN_PROGRAM, LOGIN_FILE_MOUNT, CONFIG_PROGRAM],
    });
    // The launcher resumes the same session (no fork), on the session's model.
    assert.match(INTERACTIVE_LAUNCH, /exec claude --resume "\$1" --model "\$2"/);
    assert.doesNotMatch(INTERACTIVE_LAUNCH, /fork-session/);
    // The login is read inside the container, into the harness's environment only: no word carries it.
    assert.ok(resume.supported && !resume.command.some((word) => /CLAUDE_CODE_OAUTH_TOKEN=[^$\s]/.test(word) || word.includes('sk-ant')));
    assert.ok(!JSON.stringify(t.log.all).includes('release'), 'the hand-over is no event of the session');

    // Asked again (Shell, then the harness again): nothing more to release.
    assert.equal((await t.adapter.interactive?.(SESSION))?.supported, true);
    assert.equal(runner.received.filter((line) => line.type === 'release').length, 1);

    // Give back: the same runner reloads the session from its transcript before the next turn.
    const resumed = await t.adapter.resume(SESSION);
    assert.equal(resumed, handle, 'the same container and runner');
    await resumed.send({ text: 'Carry on.', by: 'cleared' });
    const reload = await runner.waitFor((line) => line.type === 'reload');
    const next = await runner.waitFor((line) => line.type === 'user' && line.text === 'Carry on.');
    assert.ok(runner.received.indexOf(reload) < runner.received.indexOf(next));
    assert.equal(t.runners.length, 1);
    // A resume with nothing handed over reloads nothing.
    await t.adapter.resume(SESSION);
    assert.equal(runner.received.filter((line) => line.type === 'reload').length, 1);
    const stopping = handle.stop();
    await runner.waitFor((line) => line.type === 'stop');
    runner.exit(0);
    await stopping;
  } finally { t.cleanup(); }
});

test('a runner that does not hand its harness over (an image before this change) makes it unsupported, with the reason; so does a stopped or unknown session', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    const silent = await t.adapter.interactive?.(SESSION);
    assert.equal(silent?.supported, false);
    assert.match(silent?.supported === false ? silent.reason : '', /did not hand its harness over.*session image/);
    await runner.waitFor((line) => line.type === 'release');
    // A release was sent: Give back reloads, in case the runner parks late (an older runner ignores the line).
    await t.adapter.resume(SESSION);
    await runner.waitFor((line) => line.type === 'reload');
    const unknown = await t.adapter.interactive?.('11111111-2222-4333-8444-555555555555');
    assert.match(unknown?.supported === false ? unknown.reason : '', /no running session/);
    const stopping = handle.stop();
    await runner.waitFor((line) => line.type === 'stop');
    runner.exit(0);
    await stopping;
    const stopped = await t.adapter.interactive?.(SESSION);
    assert.match(stopped?.supported === false ? stopped.reason : '', /no running session/);
  } finally { t.cleanup(); }
});

test('a Give back while the runner is still handing its harness over reloads it, and no harness is started beside it', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    const asking = t.adapter.interactive?.(SESSION);
    await runner.waitFor((line) => line.type === 'release');
    // Give back lands before the runner said released.
    const resumed = await t.adapter.resume(SESSION);
    assert.equal(resumed, handle);
    runner.say({ type: 'released' });
    const answer = await asking;
    assert.equal(answer?.supported, false, 'the session was given back: no harness for the human');
    assert.match(answer?.supported === false ? answer.reason : '', /given back/);
    const release = runner.received.findIndex((line) => line.type === 'release');
    const reload = runner.received.findIndex((line) => line.type === 'reload');
    assert.ok(release >= 0 && reload > release, 'release, then reload: the runner takes the session back');
    const stopping = handle.stop();
    await runner.waitFor((line) => line.type === 'stop');
    runner.exit(0);
    await stopping;
  } finally { t.cleanup(); }
});

test('a runner that says why it exits is a runner_exit, not a lost container', async () => {
  const t = await setup();
  try {
    await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    runner.say({ type: 'exit', code: 1 });
    runner.exit(1);
    await settle();
    assert.deepEqual(events(t.log).filter((e) => e.type === 'RUN_ERROR').map((e) => e.type === 'RUN_ERROR' && e.code), ['runner_exit']);
  } finally { t.cleanup(); }
});

test('a session container killed mid turn (docker kill on the labelled container) is a lost container; stop removes what it left, and resume recreates it on the same checkout', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start({ ...input(t.workdir), services: parseServices('postgres:16') });
    const runner = t.runners[0] as FakeRunner;
    runner.sdk({ type: 'command_lifecycle', state: 'started', command_uuid: 'turn-1' });
    writeFileSync(join(t.workdir, 'draft.ts'), 'export const draft = 1;\n');
    await settle();
    await t.docker.kill(SESSION, sessionNames(SESSION).container);
    const kill = t.fake.calls.find((c) => c.args[0] === 'kill');
    assert.ok(kill, 'docker kill ran');
    // Its target came from a list filtered on the label, as every targeted command's does.
    const list = t.fake.calls[t.fake.calls.indexOf(kill) - 1];
    assert.ok(list?.args[0] === 'ps' && list.args.includes(`label=${LABEL}`) && list.args.includes(`label=${SESSION_LABEL}=${SESSION}`));
    await settle();
    const errors = events(t.log).filter((e) => e.type === 'RUN_ERROR');
    assert.deepEqual(errors.map((e) => e.type === 'RUN_ERROR' && [e.code, e.message]), [[CONTAINER_LOST, 'the session\'s container stopped (exit code 137)']]);
    await assert.rejects(handle.send({ text: 'still there?', by: 'user-1' }), /stopped/);
    // The kill leaves the egress and the test service behind: resume alone would collide with them.
    assert.ok(t.fake.containers.filter((c) => c.labels[SESSION_LABEL] === SESSION).length >= 2);
    await assert.rejects(t.adapter.resume(SESSION), /already has/);
    await handle.stop();
    assert.equal(t.fake.containers.filter((c) => c.labels[SESSION_LABEL] === SESSION).length, 0);
    assert.equal(t.fake.volumes.filter((v) => v.labels[SESSION_LABEL] === SESSION).length, 1, 'the config volume, which holds the transcript, stays');
    const resumed = await t.adapter.resume(SESSION);
    const second = t.runners.at(-1) as FakeRunner;
    assert.notEqual(second, runner);
    assert.equal((await second.waitFor((l) => l.type === 'start')).resume, true);
    const create = t.fake.calls.filter((c) => c.args[0] === 'create' && c.args.includes('cleared.role=session')).at(-1);
    assert.ok(create?.args.includes(`type=bind,source=${t.workdir},target=${WORKDIR_MOUNT}`), 'the same checkout is mounted');
    assert.equal(readFileSync(join(t.workdir, 'draft.ts'), 'utf8'), 'export const draft = 1;\n', 'the uncommitted file is kept');
    const stopping = resumed.stop();
    await second.waitFor((l) => l.type === 'stop');
    second.exit(0);
    await stopping;
  } finally { t.cleanup(); }
});

test('a container removed while the adapter stops it is not a lost container', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const runner = t.runners[0] as FakeRunner;
    // The runner never answers stop; the removal ends it with 137 and no exit line.
    t.fake.intercept = (args) => { if (args[0] === 'rm') runner.exit(137); return undefined; };
    await handle.stop();
    await settle();
    assert.equal(events(t.log).some((e) => e.type === 'RUN_ERROR' && e.code === CONTAINER_LOST), false);
  } finally { t.cleanup(); }
});
