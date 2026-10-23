// The Cursor adapter on a fake launcher: no Docker, no Cursor. The fake turn
// reads what the adapter wrote to the process (the prompt on the standard
// input, the command's words) and plays lines written from the documented
// stream-json format (fixtures.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOGIN_FILE_MOUNT } from '../../../src/container/session-runtime.ts';
import { createCursorAdapter, type CursorLauncher, type CursorRuntime } from '../../../src/session/adapters/cursor.ts';
import { createCleaner } from '../../../src/session/clean.ts';
import { NotImplemented, interactiveResume, type SessionHandle, type StartInput } from '../../../src/session/contract.ts';
import type { AgUiEvent, EventLog, SessionEvent } from '../../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../../src/session/policy.ts';
import { CHAT, init, readDone, readStarted, resultLine, says, shellStarted, writeDone, writeStarted } from './fixtures.ts';

function memoryLog(): EventLog & { readonly all: SessionEvent[] } {
  const all: SessionEvent[] = [];
  return {
    all,
    append(entry) {
      const event = { ...entry, seq: all.filter((e) => e.sessionId === entry.sessionId).length + 1 };
      all.push(event);
      return event;
    },
    after: (sessionId, seq = 0) => all.filter((e) => e.sessionId === sessionId && e.seq > seq),
  };
}

class FakeTurn {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  prompt = '';
  killed = false;
  readonly process: ChildProcessWithoutNullStreams;
  private readonly emitter = new EventEmitter();
  readonly command: readonly string[];
  constructor(command: readonly string[]) {
    this.command = command;
    this.stdin.on('data', (chunk: Buffer) => { this.prompt += chunk.toString('utf8'); });
    this.process = Object.assign(this.emitter, { stdin: this.stdin, stdout: this.stdout, stderr: this.stderr, kill: () => { this.killed = true; this.exit(143); return true; } }) as unknown as ChildProcessWithoutNullStreams;
  }
  say(...lines: unknown[]) { for (const line of lines) this.stdout.write(JSON.stringify(line) + '\n'); }
  exit(code: number) { this.stdout.end(); setImmediate(() => this.emitter.emit('close', code, null)); }
  async ready() { for (let i = 0; i < 400 && !this.stdin.writableFinished; i++) await new Promise((r) => setTimeout(r, 2)); }
}

class FakeLauncher implements CursorLauncher {
  readonly turns: FakeTurn[] = [];
  readonly calls: string[] = [];
  private waiting: ((turn: FakeTurn) => void)[] = [];
  async start(session: string) { this.calls.push(`start ${session}`); }
  async turn(_session: string, command: readonly string[]) {
    const turn = new FakeTurn(command);
    this.turns.push(turn);
    for (const wake of this.waiting.splice(0)) wake(turn);
    return turn.process;
  }
  async endTurn() { this.calls.push('endTurn'); }
  async stop(session: string) { this.calls.push(`stop ${session}`); }
  async nextTurn(index: number): Promise<FakeTurn> {
    for (let i = 0; i < 500; i++) {
      const turn = this.turns[index];
      if (turn) { await turn.ready(); return turn; }
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`no turn ${index}`);
  }
}

const input = (workdir: string, extra: Partial<StartInput['policy']> = {}): StartInput => ({
  project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'cursor', model: 'sonnet-4.5', workdir,
  briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null },
  policy: { role: 'author', base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: LOGIN_FILE_MOUNT, safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: ['registry.npmjs.org'], forbiddenHosts: ['prod.example.invalid'], ticketFiles: [], learned: [], ...extra },
  prompt: 'Show the newest entry first.',
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-cursor-'));
  const workdir = join(dir, 'checkout');
  mkdirSync(workdir);
  const log = memoryLog();
  const launcher = new FakeLauncher();
  const runtime: CursorRuntime = { stateDir: join(dir, 'state'), loginFile: join(dir, 'cursor.key'), hostAddresses: [], user: '1000:1000', stopTimeoutMs: 200, interruptTimeoutMs: 200 };
  const adapter = createCursorAdapter({ log, cleaner: () => createCleaner(), launcher, runtime, newId: (() => { let n = 0; return () => (n++ === 0 ? '0b7e6f2c-3d4a-4e5f-8a9b-1c2d3e4f5a6b' : `msg-${n}`); })() });
  return { dir, workdir, log, launcher, runtime, adapter, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const kinds = (log: SessionEvent[]): string[] => log.map((entry) => (entry.event.type === 'CUSTOM' ? entry.event.name : entry.event.type));
const events = (log: SessionEvent[]): AgUiEvent[] => log.map((entry) => entry.event);
async function until(check: () => boolean) { for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(check(), 'condition never held'); }

test('a session: the prompt goes on the standard input, never in a word of the command, and the turn ends waiting for a message', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const turn = await t.launcher.nextTurn(0);
    assert.equal(turn.prompt, 'Show the newest entry first.');
    assert.ok(!turn.command.some((word) => word.includes('newest entry')), 'the prompt is no docker argument');
    assert.ok(!turn.command.some((word) => word.includes('--api-key')));
    assert.equal(turn.command.at(-1), '', 'the first turn has no chat to resume');
    turn.say(init(), says('Looking.'), readStarted('c1', 'src/a.ts'), readDone('c1', 'src/a.ts', 'x'), resultLine('Looking.'));
    turn.exit(0);
    await until(() => t.log.all.some((e) => e.event.type === 'RUN_FINISHED'));
    assert.equal(t.log.all.filter((e) => e.event.type === 'RUN_ERROR').length, 0);
    assert.equal(handle.id, '0b7e6f2c-3d4a-4e5f-8a9b-1c2d3e4f5a6b');
    assert.equal(readFileSync(join(t.runtime.stateDir, 'cursor-chats', `${handle.id}.chat`), 'utf8'), CHAT);
    // The next message resumes the chat Cursor named.
    await handle.send({ text: 'And the oldest.', by: 'user-1' });
    const second = await t.launcher.nextTurn(1);
    assert.equal(second.command.at(-1), CHAT);
    assert.equal(second.prompt, 'And the oldest.');
    second.say(init(), resultLine('ok'));
    second.exit(0);
    await until(() => t.log.all.filter((e) => e.event.type === 'RUN_FINISHED').length === 2);
  } finally { t.done(); }
});

test('the guard fails closed: a denied read stops the turn, and so does a call that would need an approval', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const turn = await t.launcher.nextTurn(0);
    turn.say(init(), readStarted('c1', '.env'));
    await until(() => turn.killed);
    const answered = t.log.all.find((e) => e.event.type === 'CUSTOM' && e.event.name === 'cleared.permission_answered');
    assert.ok(answered, 'the thread says the policy refused');
    const error = t.log.all.find((e) => e.event.type === 'RUN_ERROR');
    assert.ok(error && error.event.type === 'RUN_ERROR' && error.event.code === 'policy_stop');
    assert.ok(t.launcher.calls.includes('endTurn'), 'the program itself is ended in the container');
    assert.equal(t.log.all.filter((e) => e.event.type === 'RUN_ERROR').length, 1, 'the exit of the killed process adds no second error');
    // The session goes on: a new message gets a new turn.
    await handle.send({ text: 'Try again.', by: 'user-1' });
    const second = await t.launcher.nextTurn(1);
    second.say(init(), shellStarted('c2', 'npm install left-pad'));
    await until(() => second.killed);
    const asks = t.log.all.filter((e) => e.event.type === 'RUN_ERROR');
    assert.equal(asks.length, 2);
    assert.match((asks[1]?.event.type === 'RUN_ERROR' ? asks[1].event.message : ''), /approval/);
    assert.ok(!kinds(t.log.all).includes('cleared.permission_request'), 'nothing is left waiting in the inbox: nobody could resume the turn');
  } finally { t.done(); }
});

test('allowed calls go on: a safe command and an edit inside the checkout', async () => {
  const t = await setup();
  try {
    await t.adapter.start(input(t.workdir));
    const turn = await t.launcher.nextTurn(0);
    turn.say(init(), shellStarted('c1', 'npm test'), writeStarted('c2', 'src/b.ts', 'x\n'), writeDone('c2', 'src/b.ts', 'x\n'), resultLine('done'));
    turn.exit(0);
    await until(() => t.log.all.some((e) => e.event.type === 'RUN_FINISHED'));
    assert.equal(turn.killed, false);
  } finally { t.done(); }
});

test('a process that ends without a result: the reason is a code, never the program\'s words', async () => {
  const t = await setup();
  try {
    await t.adapter.start(input(t.workdir));
    const turn = await t.launcher.nextTurn(0);
    turn.stderr.write('Error: not logged in, run agent login (sk_live_should_not_appear)\n');
    await new Promise((r) => setTimeout(r, 10));
    turn.exit(1);
    await until(() => t.log.all.some((e) => e.event.type === 'RUN_ERROR'));
    const error = t.log.all.find((e) => e.event.type === 'RUN_ERROR')?.event;
    assert.ok(error && error.type === 'RUN_ERROR');
    assert.equal(error.code, 'cursor_login');
    assert.ok(!JSON.stringify(t.log.all).includes('sk_live'));
  } finally { t.done(); }
});

test('exit codes of the launcher: no program installed, no login', async () => {
  for (const [code, expected] of [[127, 'cursor_not_installed'], [3, 'cursor_login'], [2, 'cursor_exit']] as const) {
    const t = await setup();
    try {
      await t.adapter.start(input(t.workdir));
      (await t.launcher.nextTurn(0)).exit(code);
      await until(() => t.log.all.some((e) => e.event.type === 'RUN_ERROR'));
      const error = t.log.all.find((e) => e.event.type === 'RUN_ERROR')?.event;
      assert.equal(error?.type === 'RUN_ERROR' ? error.code : '', expected);
    } finally { t.done(); }
  }
});

test('interrupt ends the turn as cancelled; stop removes the container and closes the stream', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const turn = await t.launcher.nextTurn(0);
    turn.say(init(), says('working'));
    await until(() => t.log.all.some((e) => e.event.type === 'TEXT_MESSAGE_START' && e.event.role === 'assistant'));
    await handle.interrupt();
    await until(() => t.log.all.some((e) => e.event.type === 'RUN_FINISHED'));
    const finished = events(t.log.all).find((event) => event.type === 'RUN_FINISHED');
    assert.ok(finished && finished.type === 'RUN_FINISHED' && finished.outcome.type === 'cancelled');
    const seen: string[] = [];
    const reading = (async () => { for await (const event of handle.events()) seen.push(event.event.type); })();
    await handle.stop();
    await reading;
    assert.ok(t.launcher.calls.some((call) => call.startsWith('stop ')));
    await assert.rejects(handle.send({ text: 'x', by: 'user-1' }), /stopped/);
    await assert.rejects(handle.answer('r', { decision: { kind: 'allow_once' }, by: 'user-1' }), /stopped/);
    await assert.rejects(handle.handover({ harness: 'claude-code', model: 'm' }), NotImplemented);
  } finally { t.done(); }
});

test('Take over: the running turn ends, the command resumes the chat, messages wait for Give back, and resume lets the next turn go', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const first = await t.launcher.nextTurn(0);
    // No chat yet: nothing to resume.
    const early = await interactiveResume(t.adapter, handle.id);
    assert.equal(early.supported, false);
    assert.equal(first.killed, false, 'a session with no chat yet keeps its turn');
    first.say(init(), says('hi'));
    await until(() => t.log.all.some((e) => e.event.type === 'TEXT_MESSAGE_START' && e.event.role === 'assistant'));
    const answer = await interactiveResume(t.adapter, handle.id);
    assert.ok(answer.supported);
    assert.equal(answer.name, 'Cursor');
    assert.equal(first.killed, true, 'only one writer: the running turn was ended');
    assert.equal(answer.command[0], 'sh');
    assert.ok(answer.command.includes(CHAT));
    assert.ok(answer.command.includes('sonnet-4.5'));
    assert.ok(answer.command.includes(LOGIN_FILE_MOUNT));
    assert.ok(!answer.command.some((word) => /sk_|--api-key/.test(word)));
    const permissions = answer.command.find((word) => word.startsWith('{"permissions"')) ?? '';
    assert.match(permissions, /"deny":\[/);
    await assert.rejects(handle.send({ text: 'x', by: 'user-1' }), /taken over/);
    const back = await t.adapter.resume(handle.id);
    assert.equal(back, handle);
    await back.send({ text: 'Carry on.', by: 'user-1' });
    const next = await t.launcher.nextTurn(1);
    assert.equal(next.command.at(-1), CHAT, 'the next turn resumes the chat the human left');
  } finally { t.done(); }
});

test('an adapter given the wrong harness, a resume of an unknown session, and a session no longer running', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.adapter.start({ ...input(t.workdir), harness: 'claude-code' }), /cursor sessions/);
    await assert.rejects(t.adapter.resume('nope'), /unknown session/);
    const answer = await interactiveResume(t.adapter, 'nope');
    assert.equal(answer.supported, false);
    assert.equal(t.adapter.harness, 'cursor');
  } finally { t.done(); }
});

test('a chat id is validated and kept across a service restart in the state folder only', async () => {
  const t = await setup();
  try {
    const handle = await t.adapter.start(input(t.workdir));
    const turn = await t.launcher.nextTurn(0);
    turn.say(init('bad id; rm -rf /'), resultLine('x', 'bad'));
    turn.exit(0);
    await until(() => t.log.all.some((e) => e.event.type === 'RUN_FINISHED'));
    assert.ok(!existsSync(join(t.runtime.stateDir, 'cursor-chats', `${handle.id}.chat`)), 'a malformed id is not kept');
    writeFileSync(join(t.dir, 'unused'), '');
  } finally { t.done(); }
});
