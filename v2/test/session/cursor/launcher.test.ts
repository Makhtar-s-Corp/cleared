// The programs run in the container, run here by this machine's sh with a
// stand-in `agent` on the PATH and a stand-in key file (never a real login).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Docker, LABEL } from '../../../src/container/docker.ts';
import { LOGIN_FILE_MOUNT, sessionNames } from '../../../src/container/session-runtime.ts';
import { dockerLauncher } from '../../../src/session/adapters/cursor.ts';
import { CURSOR_CONFIG_DIR, END_TURN, EXIT_NO_LOGIN, EXIT_NO_PROGRAM, INTERACTIVE_LAUNCH, TURN_LAUNCH, interactiveCommand, isChatId, turnCommand } from '../../../src/session/adapters/cursor/interactive.ts';
import { FakeDocker } from '../../container/fake-docker.ts';

const key = ['crsr', 'T3stK3yN3v3rR34l', 'Zq', 'Xw'].join('_');
const PERMISSIONS = '{"permissions":{"allow":["Read(/workspace/**)"],"deny":["Read(**/.env)"]}}';
const CHAT = 'b1c2d3e4-1111-4222-8333-444455556666';

function run(command: readonly string[], options: { login?: string; program?: 'agent' | 'cursor-agent' | 'none'; stdin?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-cursor-launch-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const config = join(dir, 'config');
    const program = options.program ?? 'agent';
    if (program !== 'none') {
      writeFileSync(join(bin, program), '#!/bin/sh\nprintf "args:"; printf "%s|" "$@"; echo\nif [ "$CURSOR_API_KEY" = "$EXPECTED" ]; then echo key:ok; else echo key:bad; fi\necho "config:$CURSOR_CONFIG_DIR"\n');
      chmodSync(join(bin, program), 0o755);
    }
    const file = join(dir, 'cursor.key');
    if (options.login !== undefined) writeFileSync(file, options.login);
    const words = command.map((word) => (word === LOGIN_FILE_MOUNT ? file : word.replace(CURSOR_CONFIG_DIR, config)));
    const [shell, ...args] = words;
    const script = (args[1] as string).replaceAll(CURSOR_CONFIG_DIR, config);
    const result = spawnSync(shell as string, ['-c', script, ...args.slice(2)], { cwd: workspace, input: options.stdin ?? '', encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, EXPECTED: key } });
    return { ...result, written: existsSync(join(workspace, '.cursor', 'cli.json')) ? readFileSync(join(workspace, '.cursor', 'cli.json'), 'utf8') : undefined };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a turn: the key reaches the program\'s environment only, the permissions file is written, the prompt comes from the standard input, a first turn starts a chat and the next resumes it', () => {
  const first = run(turnCommand(PERMISSIONS, 'sonnet-4.5', undefined), { login: `${key}\n`, stdin: 'Fix the bug; $(rm -rf /)' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'args:-p|--output-format|stream-json|--model|sonnet-4.5|Fix the bug; $(rm -rf /)|\nkey:ok\nconfig:' + first.stdout.split('config:')[1]);
  assert.equal(first.written, PERMISSIONS);
  assert.ok(!first.stdout.includes(key) && !first.stderr.includes(key));
  const next = run(turnCommand(PERMISSIONS, 'sonnet-4.5', CHAT), { login: key, stdin: 'More.' });
  assert.match(next.stdout, /args:-p\|--output-format\|stream-json\|--model\|sonnet-4\.5\|--resume\|b1c2d3e4-1111-4222-8333-444455556666\|More\.\|/);
  assert.ok(!next.stdout.includes('--api-key'));
});

test('the former program name is found; no program exits 127 and no key exits 3, each saying so', () => {
  assert.equal(run(turnCommand(PERMISSIONS, 'm1', undefined), { login: key, program: 'cursor-agent' }).status, 0);
  const none = run(turnCommand(PERMISSIONS, 'm1', undefined), { login: key, program: 'none' });
  assert.equal(none.status, EXIT_NO_PROGRAM);
  assert.match(none.stderr, /not installed/);
  for (const login of [undefined, '', '\n']) {
    const missing = run(turnCommand(PERMISSIONS, 'm1', undefined), { login });
    assert.equal(missing.status, EXIT_NO_LOGIN, JSON.stringify(login));
    assert.match(missing.stderr, /no Cursor login/);
  }
});

test('Take over\'s terminal program resumes the same chat on the same model with the key in its environment only', () => {
  const taken = run(interactiveCommand(PERMISSIONS, 'sonnet-4.5', CHAT), { login: key });
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(taken.stdout, /^args:--resume\|b1c2d3e4-1111-4222-8333-444455556666\|--model\|sonnet-4\.5\|\nkey:ok\n/);
  assert.ok(!taken.stdout.includes(key));
});

test('what reaches a command line is checked: chat ids and model names', () => {
  assert.ok(isChatId(CHAT) && isChatId('chat_abcdef12'));
  for (const bad of ['', 'short', 'a b c d e f g h', '$(id)aaaaaaaa', 'x;y;zzzzzzzz', 7, undefined]) assert.equal(isChatId(bad), false, String(bad));
  assert.throws(() => turnCommand(PERMISSIONS, 'm; rm -rf /', undefined), /model/);
  assert.throws(() => turnCommand(PERMISSIONS, 'm1', '$(id)'), /chat/);
  assert.throws(() => interactiveCommand(PERMISSIONS, 'm1', 'bad id'), /chat/);
  assert.ok(!TURN_LAUNCH.includes('--api-key') && !INTERACTIVE_LAUNCH.includes('--api-key'));
  assert.match(END_TURN.join(' '), /kill -TERM/);
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
  const launcher = dockerLauncher(dockerWith, { stateDir: '/tmp/x', loginFile: '/tmp/x/cursor.key', hostAddresses: [], user: '1000:1000' });
  await launcher.turn(session, turnCommand(PERMISSIONS, 'm1', undefined));
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]?.slice(0, 5), ['exec', '--interactive', '--user', '1000:1000', '--workdir']);
  assert.ok(!spawned[0]?.join(' ').includes('Fix the bug'));
  assert.ok(LABEL.length > 0);
  await assert.rejects(dockerWith.execStream(session, name, { user: '1000; id', workdir: '/workspace', command: ['x'] }), /invalid user/);
  await assert.rejects(dockerWith.execStream('9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d', name, { user: '1000:1000', workdir: '/workspace', command: ['x'] }), /no container named/);
});
