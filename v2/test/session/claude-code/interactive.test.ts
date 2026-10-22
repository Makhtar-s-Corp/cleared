// Claude Code for a human at the web terminal of a session taken over
// (owner request of 2026-10-22 17:26): the launcher, run here by this
// machine's sh and node, with a stand-in `claude` on the PATH and a
// stand-in login file of the test (never a real login). The launcher reads
// the login as the runner does, gives it to the harness's environment
// only, prints nothing of it, and resumes the same session on its model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { INTERACTIVE_LAUNCH, LOGIN_TOKEN_PROGRAM, interactiveCommand } from '../../../src/session/adapters/claude-code/interactive.ts';
import { LOGIN_FILE_MOUNT } from '../../../src/container/session-runtime.ts';

const SESSION = '0b7e6f2c-3d4a-4e5f-8a9b-1c2d3e4f5a6b';
const token = ['sk', 'ant', 'oat01', 'L4unch3rT0k3nF0rT3st5Only0'].join('-');
const refresh = ['sk', 'ant', 'ort01', 'R3fr3shT0k3nN3v3rG1v3n0'].join('-');

function launch(login: string | undefined, expected: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-launch-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // The stand-in harness says what it was given: its words, and whether its environment holds the expected login.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "args:"; printf "%s|" "$@"\nif [ "$CLAUDE_CODE_OAUTH_TOKEN" = "$EXPECTED" ]; then echo token:ok; else echo token:bad; fi\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const file = join(dir, 'claude.token');
    if (login !== undefined) writeFileSync(file, login);
    const [shell, ...args] = interactiveCommand(SESSION, 'claude-opus-5-5').map((word) => (word === LOGIN_FILE_MOUNT ? file : word));
    return spawnSync(shell as string, args, { encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, EXPECTED: expected } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the launcher gives a token file\'s login to the harness only, prints nothing of it, and resumes the same session on its model', () => {
  const run = launch(`${token}\n`, token);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `args:--resume|${SESSION}|--model|claude-opus-5-5|token:ok\n`);
  assert.ok(!run.stdout.includes(token) && !run.stderr.includes(token), 'the login is never printed');
});

test('of a Claude Code credentials file, only the access token reaches the harness, as the runner does', () => {
  const run = launch(JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt: 1 } }), token);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /token:ok$/m);
  assert.ok(![token, refresh].some((secret) => run.stdout.includes(secret) || run.stderr.includes(secret)));
});

test('without a login the harness does not start, and the terminal says why', () => {
  for (const login of [undefined, '', '{"claudeAiOauth":{}}', '{not json']) {
    const run = launch(login, token);
    assert.equal(run.status, 3, `login ${JSON.stringify(login)}`);
    assert.equal(run.stdout.includes('args:'), false, 'no harness was run');
    assert.match(run.stderr, /no login in the session's container/);
  }
});

test('the command is fixed words, the session, its model, the program and the login file\'s mount: nothing else varies', () => {
  assert.deepEqual(interactiveCommand(SESSION, 'claude-haiku-5-5'), ['sh', '-c', INTERACTIVE_LAUNCH, 'claude-code', SESSION, 'claude-haiku-5-5', LOGIN_TOKEN_PROGRAM, LOGIN_FILE_MOUNT]);
  assert.throws(() => interactiveCommand('not an id; rm -rf /', 'claude-haiku-5-5'), /session/);
  assert.throws(() => interactiveCommand(SESSION, '--dangerously-skip-permissions'), /model/);
});
