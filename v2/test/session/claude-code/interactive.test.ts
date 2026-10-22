// Claude Code for a human at the web terminal of a session taken over
// (owner request of 2026-10-22 17:26): the launcher, run here by this
// machine's sh and node, with a stand-in `claude` on the PATH and a
// stand-in login file of the test (never a real login). The launcher reads
// the login as the runner does, gives it to the harness's environment
// only, prints nothing of it, and resumes the same session on its model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_PROGRAM, INTERACTIVE_LAUNCH, LOGIN_TOKEN_PROGRAM, interactiveCommand } from '../../../src/session/adapters/claude-code/interactive.ts';
import { LOGIN_FILE_MOUNT } from '../../../src/container/session-runtime.ts';

const SESSION = '0b7e6f2c-3d4a-4e5f-8a9b-1c2d3e4f5a6b';
const token = ['sk', 'ant', 'oat01', 'L4unch3rT0k3nF0rT3st5Only0'].join('-');
const refresh = ['sk', 'ant', 'ort01', 'R3fr3shT0k3nN3v3rG1v3n0'].join('-');

function launch(login: string | undefined, expected: string, config?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-launch-'));
  try {
    const configDir = join(dir, 'config');
    mkdirSync(configDir);
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // The stand-in harness says what it was given: its words, and whether its environment holds the expected login.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "args:"; printf "%s|" "$@"\nif [ "$CLAUDE_CODE_OAUTH_TOKEN" = "$EXPECTED" ]; then echo token:ok; else echo token:bad; fi\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const file = join(dir, 'claude.token');
    if (login !== undefined) writeFileSync(file, login);
    const [shell, ...args] = interactiveCommand(SESSION, 'claude-opus-5-5').map((word) => (word === LOGIN_FILE_MOUNT ? file : word));
    const run = spawnSync(shell as string, args, { cwd: workspace, encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, EXPECTED: expected, CLAUDE_CONFIG_DIR: configDir } });
    config?.(join(configDir, '.claude.json'));
    return { ...run, workspace };
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

test('the harness opens on the session as it is, not on its first-run screens: the session\'s own config marks them done and its checkout trusted, every other key kept', () => {
  let config: Record<string, unknown> = {};
  let mode = 0;
  const run = launch(`${token}\n`, token, (file) => {
    config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    mode = statSync(file).mode & 0o777;
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(config.hasCompletedOnboarding, true);
  assert.deepEqual((config.projects as Record<string, { hasTrustDialogAccepted?: boolean }>)[run.workspace]?.hasTrustDialogAccepted, true);
  assert.equal(mode, 0o600, 'the config stays the session user\'s alone');
  // An existing config keeps what the session's harness wrote there.
  const kept = launch(`${token}\n`, token, (file) => { config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; });
  assert.equal(kept.status, 0);
  const dir = mkdtempSync(join(tmpdir(), 'cleared-config-'));
  try {
    const file = join(dir, '.claude.json');
    writeFileSync(file, JSON.stringify({ userID: 'u-1', projects: { '/workspace': { allowedTools: ['Bash'] } } }));
    const result = spawnSync(process.execPath, ['-e', CONFIG_PROGRAM, '--', file, '/workspace'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { userID: 'u-1', hasCompletedOnboarding: true, projects: { '/workspace': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } });
    // A config that is not JSON is left as it is: the harness then shows its first-run screens, nothing worse.
    writeFileSync(file, '{not json');
    assert.equal(spawnSync(process.execPath, ['-e', CONFIG_PROGRAM, '--', file, '/workspace']).status, 0);
    assert.equal(readFileSync(file, 'utf8'), '{not json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command is fixed words, the session, its model, the programs and the login file\'s mount: nothing else varies', () => {
  assert.deepEqual(interactiveCommand(SESSION, 'claude-haiku-5-5'), ['sh', '-c', INTERACTIVE_LAUNCH, 'claude-code', SESSION, 'claude-haiku-5-5', LOGIN_TOKEN_PROGRAM, LOGIN_FILE_MOUNT, CONFIG_PROGRAM]);
  assert.throws(() => interactiveCommand('not an id; rm -rf /', 'claude-haiku-5-5'), /session/);
  assert.throws(() => interactiveCommand(SESSION, '--dangerously-skip-permissions'), /model/);
});
