// The heartbeat's settings (docs/v2/milestone-4-plan.md, section 8.4): the
// intervals from the environment, and the monitor's addresses from files
// the service's account alone can read, outside the project's checkout,
// HTTPS or HTTP on loopback. A refused file is named by its variable,
// never by what it holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HeartbeatConfigError, monitorState, readHeartbeatSettings, readMonitor } from '../../src/heartbeat/settings.ts';
import { tempDir } from '../workspace/git.ts';

const PING = 'CLEARED_V2_HEARTBEAT_PING_URL_FILE';
const FAIL = 'CLEARED_V2_HEARTBEAT_FAIL_URL_FILE';

function privateFile(dir: string, name: string, text: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

test('the defaults: a beat a minute, a session stalled past 2 hours, a mirror past 10 minutes, no tracker', () => {
  assert.deepEqual(readHeartbeatSettings({}), { everyMs: 60_000, sessionMinutes: 120, trackerMinutes: 10, trackers: [] });
});

test('the intervals are read from the environment, within their bounds', () => {
  const settings = readHeartbeatSettings({
    CLEARED_V2_HEARTBEAT_SECONDS: '15', CLEARED_V2_HEARTBEAT_SESSION_MINUTES: '30', CLEARED_V2_HEARTBEAT_TRACKER_MINUTES: '5',
  });
  assert.equal(settings.everyMs, 15_000);
  assert.equal(settings.sessionMinutes, 30);
  assert.equal(settings.trackerMinutes, 5);
  assert.equal(readHeartbeatSettings({ CLEARED_V2_HEARTBEAT_SECONDS: '3600' }).everyMs, 3_600_000);
  for (const [variable, value] of [
    ['CLEARED_V2_HEARTBEAT_SECONDS', '14'], ['CLEARED_V2_HEARTBEAT_SECONDS', '3601'], ['CLEARED_V2_HEARTBEAT_SECONDS', 'often'],
    ['CLEARED_V2_HEARTBEAT_SECONDS', '1.5'], ['CLEARED_V2_HEARTBEAT_SESSION_MINUTES', '0'], ['CLEARED_V2_HEARTBEAT_TRACKER_MINUTES', '-3'],
  ] as const) {
    assert.throws(() => readHeartbeatSettings({ [variable]: value }), (error: unknown) => error instanceof HeartbeatConfigError && error.message.includes(variable), `${variable}=${value}`);
  }
});

test('the trackers watched are the mirrors the settings turn on', () => {
  assert.deepEqual(readHeartbeatSettings({ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: '/x' }).trackers, ['github']);
  assert.deepEqual(readHeartbeatSettings({ CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE: '/y', CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: '/x' }).trackers, ['github', 'linear']);
  assert.deepEqual(readHeartbeatSettings({ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: '  ' }).trackers, []);
});

test('no file named: the monitor is off, nothing refused', () => {
  const monitor = readMonitor({});
  assert.deepEqual(monitor, { ping: null, fail: null, refused: [] });
  assert.equal(monitorState(monitor), 'off');
});

test('private files outside the checkout give the two addresses, trimmed', () => {
  const dir = tempDir('beat-files');
  const checkout = join(dir, 'checkout');
  mkdirSync(checkout);
  const env = {
    [PING]: privateFile(dir, 'ping', 'https://monitor.example.invalid/ping/abc\n'),
    [FAIL]: privateFile(dir, 'fail', '  https://monitor.example.invalid/ping/abc/fail  '),
  };
  const monitor = readMonitor(env, { checkout });
  assert.deepEqual(monitor, { ping: 'https://monitor.example.invalid/ping/abc', fail: 'https://monitor.example.invalid/ping/abc/fail', refused: [] });
  assert.equal(monitorState(monitor), 'on');
});

test('HTTP is taken on loopback only', () => {
  const dir = tempDir('beat-loopback');
  for (const address of ['http://127.0.0.1:9/ping', 'http://localhost:9/ping', 'http://[::1]:9/ping']) {
    assert.equal(readMonitor({ [PING]: privateFile(dir, 'ping', address) }).ping, address);
  }
});

test('each unsafe file or address is refused by its variable, and the other address is kept', () => {
  const dir = tempDir('beat-refused');
  const checkout = join(dir, 'checkout');
  mkdirSync(checkout);
  const good = privateFile(dir, 'good', 'https://monitor.example.invalid/ok');
  const target = privateFile(dir, 'target', 'https://monitor.example.invalid/linked');
  const link = join(dir, 'link');
  symlinkSync(target, link);
  // Built, not written out: the guard refuses an address with a password in the repository.
  const withPassword = new URL('https://monitor.example.invalid/e');
  withPassword.username = 'someone';
  withPassword.password = 'pw';
  const cases: Record<string, string> = {
    'readable by the group': privateFile(dir, 'group', 'https://monitor.example.invalid/a', 0o640),
    'readable by others': privateFile(dir, 'others', 'https://monitor.example.invalid/b', 0o604),
    'a link': link,
    'a folder': dir,
    'missing': join(dir, 'missing'),
    'inside the checkout': privateFile(checkout, 'inside', 'https://monitor.example.invalid/c'),
    'plain HTTP to another host': privateFile(dir, 'http', 'http://monitor.example.invalid/d'),
    'a user': privateFile(dir, 'user', 'https://someone@monitor.example.invalid/e'),
    'a user and a password': privateFile(dir, 'userinfo', withPassword.href),
    'not an address': privateFile(dir, 'words', 'the monitor'),
    'another scheme': privateFile(dir, 'ftp', 'ftp://monitor.example.invalid/f'),
    'empty': privateFile(dir, 'empty', '\n'),
  };
  for (const [why, path] of Object.entries(cases)) {
    const monitor = readMonitor({ [PING]: good, [FAIL]: path }, { checkout });
    assert.deepEqual(monitor, { ping: 'https://monitor.example.invalid/ok', fail: null, refused: [FAIL] }, why);
    assert.equal(monitorState(monitor), 'invalid', why);
  }
});

test('a file owned by another account is refused', () => {
  const dir = tempDir('beat-owner');
  const path = privateFile(dir, 'ping', 'https://monitor.example.invalid/ping');
  const monitor = readMonitor({ [PING]: path }, { uid: (process.getuid?.() ?? 0) + 1 });
  assert.deepEqual(monitor, { ping: null, fail: null, refused: [PING] });
});

test('only a failure address: the monitor hears no success, so it is off', () => {
  const dir = tempDir('beat-fail-only');
  const monitor = readMonitor({ [FAIL]: privateFile(dir, 'fail', 'https://monitor.example.invalid/fail') });
  assert.equal(monitor.fail, 'https://monitor.example.invalid/fail');
  assert.equal(monitorState(monitor), 'off');
});
