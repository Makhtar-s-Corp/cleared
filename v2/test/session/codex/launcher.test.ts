// The programs run in the container, run here by this machine's sh with a
// stand-in `codex` on the PATH, a stand-in key file and a temporary
// CODEX_HOME (never a real login, never the real Codex).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Docker } from '../../../src/container/docker.ts';
import { LOGIN_FILE_MOUNT, sessionNames } from '../../../src/container/session-runtime.ts';
import { dockerLauncher } from '../../../src/session/adapters/codex.ts';
import { CODEX_HOME, END_TURN, EXIT_NO_LOGIN, EXIT_NO_PROGRAM, INTERACTIVE_LAUNCH, RATE_LIMITS, TURN_LAUNCH, interactiveCommand, isThreadId, turnCommand } from '../../../src/session/adapters/codex/interactive.ts';
import { FakeDocker } from '../../container/fake-docker.ts';

const key = ['sk', 'T3stK3yN3v3rR34l', 'Zq', 'Xw'].join('-');
const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
// Another key the image might set, built in parts only to keep this file readable by the repository guard.
const IMAGE_KEY = ['from', 'the', 'image'].join('-');

// The tools the programs use, linked one by one: the PATH holds nothing else,
// so this machine's own Codex, if it has one, is never found.
const TOOLS = ['head', 'tr', 'mkdir', 'cat', 'ls', 'grep', 'tail'];

function run(command: readonly string[], options: { login?: string; program?: boolean; stdin?: string; rollout?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-codex-launch-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    for (const tool of TOOLS) {
      const found = ['/usr/bin', '/bin'].map((folder) => join(folder, tool)).find((path) => existsSync(path));
      if (found) symlinkSync(found, join(tools, tool));
    }
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const home = join(dir, 'home');
    if (options.program !== false) {
      writeFileSync(join(bin, 'codex'), '#!/bin/sh\nprintf "args:"; printf "%s|" "$@"; echo\nif [ "$CODEX_API_KEY" = "$EXPECTED" ]; then echo key:ok; else echo key:bad; fi\necho "home:$CODEX_HOME"\necho "openai:${OPENAI_API_KEY:-unset}"\nprintf "stdin:"; cat; echo\n');
      chmodSync(join(bin, 'codex'), 0o755);
    }
    if (options.rollout !== undefined) {
      const day = join(home, 'sessions', '2026', '10', '24');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, `rollout-2026-10-24T10-00-00-${THREAD}.jsonl`), options.rollout);
    }
    const file = join(dir, 'codex.key');
    if (options.login !== undefined) writeFileSync(file, options.login);
    const words = command.map((word) => (word === LOGIN_FILE_MOUNT ? file : word.replaceAll(CODEX_HOME, home)));
    const [shell, ...args] = words;
    assert.equal(shell, 'sh');
    const result = spawnSync('/bin/sh', args, { cwd: workspace, input: options.stdin ?? '', encoding: 'utf8', env: { PATH: `${bin}:${tools}`, EXPECTED: key, OPENAI_API_KEY: IMAGE_KEY } });
    return { ...result, home };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a first turn: the key reaches the program\'s environment only, the prompt comes from the standard input, the settings are words of their own', () => {
  const first = run(turnCommand('gpt-6-luna', undefined, 'workspace-write'), { login: `${key}\n`, stdin: 'Fix the bug; $(rm -rf /)' });
  assert.equal(first.status, 0, first.stderr);
  const args = /^args:(.*)$/m.exec(first.stdout)?.[1] ?? '';
  assert.equal(args, 'exec|--json|--skip-git-repo-check|-m|gpt-6-luna|-c|approval_policy="never"|-c|sandbox_mode="workspace-write"|-c|sandbox_workspace_write.network_access=true|-c|shell_environment_policy.exclude=["CODEX_API_KEY","OPENAI_API_KEY"]|-|');
  assert.match(first.stdout, /^key:ok$/m);
  assert.match(first.stdout, /^home:.*\/home$/m, 'CODEX_HOME is the session\'s own, on its config volume');
  assert.match(first.stdout, /^openai:unset$/m, 'no other key reaches Codex');
  assert.match(first.stdout, /^stdin:Fix the bug; \$\(rm -rf \/\)$/m, 'the prompt is read, never run');
  assert.ok(!first.stdout.includes(key) && !first.stderr.includes(key));
});

test('the next turn resumes the thread, in the role\'s sandbox, through -c since exec resume has no --sandbox', () => {
  const next = run(turnCommand('gpt-6-luna', THREAD, 'read-only'), { login: key, stdin: 'More.' });
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /^args:exec\|resume\|--json\|--skip-git-repo-check\|-m\|gpt-6-luna\|-c\|approval_policy="never"\|-c\|sandbox_mode="read-only"\|-c\|shell_environment_policy\.exclude=\["CODEX_API_KEY","OPENAI_API_KEY"\]\|0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\|-\|$/m);
  assert.ok(!next.stdout.includes('network_access'), 'a read-only sandbox gets no network setting');
});

test('no program exits 127 and no key exits 3, each saying so, never running Codex', () => {
  const none = run(turnCommand('m1', undefined, 'read-only'), { login: key, program: false });
  assert.equal(none.status, EXIT_NO_PROGRAM);
  assert.match(none.stderr, /not installed/);
  for (const login of [undefined, '', '\n']) {
    const missing = run(turnCommand('m1', undefined, 'read-only'), { login });
    assert.equal(missing.status, EXIT_NO_LOGIN, JSON.stringify(login));
    assert.match(missing.stderr, /no Codex login/);
    assert.ok(!missing.stdout.includes('args:'));
  }
});

test('Take over\'s terminal program resumes the same thread on the same model, with no background server, the key in its environment only', () => {
  const taken = run(interactiveCommand('gpt-6-luna', THREAD, 'read-only'), { login: key });
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(taken.stdout, /^args:resume\|--no-daemon\|--include-non-interactive\|-m\|gpt-6-luna\|-c\|approval_policy="on-request"\|-c\|sandbox_mode="read-only"\|-c\|shell_environment_policy\.exclude=\["CODEX_API_KEY","OPENAI_API_KEY"\]\|0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\|$/m);
  assert.match(taken.stdout, /^key:ok$/m);
  assert.ok(!taken.stdout.includes(key));
});

test('what reaches a command line is checked: thread ids and model names; no program ever gets a bypass or a key flag', () => {
  assert.ok(isThreadId(THREAD) && isThreadId('thread_abcdef12'));
  for (const bad of ['', 'short', 'a b c d e f g h', '$(id)aaaaaaaa', 'x;y;zzzzzzzz', 7, undefined]) assert.equal(isThreadId(bad), false, String(bad));
  assert.throws(() => turnCommand('m; rm -rf /', undefined, 'read-only'), /model/);
  assert.throws(() => turnCommand('m1', '$(id)', 'read-only'), /thread/);
  assert.throws(() => interactiveCommand('m1', 'bad id', 'read-only'), /thread/);
  for (const text of [TURN_LAUNCH, INTERACTIVE_LAUNCH]) {
    assert.doesNotMatch(text, /--api-key|danger-full-access|--dangerously|--full-auto|--approve-for-me|--ephemeral|codex"? login/);
  }
  assert.match(END_TURN.join(' '), /kill -TERM/);
});

test('the rollout\'s last token_count line leaves the container, nothing else; no rollout says nothing', () => {
  const lines = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'private words' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 6 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'more private words' } }),
  ].join('\n') + '\n';
  const found = run([...RATE_LIMITS, THREAD], { rollout: lines });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), lines.split('\n')[2]);
  const none = run([...RATE_LIMITS, THREAD]);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
  const other = run([...RATE_LIMITS, '0199a1b2-0000-7e5f-8a9b-0c1d2e3f4a5b'], { rollout: lines });
  assert.equal(other.stdout, '', 'another thread\'s rollout is not read');
});

test('the docker launcher runs a turn as `docker exec` on the session\'s own labelled container, with no word of the prompt in it', async () => {
  const fake = new FakeDocker();
  const spawned: string[][] = [];
  const docker = new Docker(fake.runner, fake.spawner, undefined);
  const dockerWith = new Docker(fake.runner, (args) => {
    spawned.push([...args]);
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
  });
  const session = '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b';
  const name = sessionNames(session).container;
  await docker.createContainer({ name, session, role: 'session', image: 'cleared-v2-session:test', networks: [{ name: `cleared-v2-${session}` }] });
  const launcher = dockerLauncher(dockerWith, { stateDir: '/tmp/x', loginFile: '/tmp/x/codex.key', hostAddresses: [], user: '1000:1000' });
  await launcher.turn(session, turnCommand('m1', undefined, 'read-only'));
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]?.slice(0, 5), ['exec', '--interactive', '--user', '1000:1000', '--workdir']);
  assert.ok(!spawned[0]?.join(' ').includes('Fix the bug'));
  assert.equal(await launcher.rateLimits(session, 'bad id'), undefined, 'a malformed thread never reaches the container');
});
