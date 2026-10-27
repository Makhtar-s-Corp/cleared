// The settings file the setup assistant writes (docs/v2/milestone-5-plan.md,
// decision 6, lane v2-j5-assistant): <state>/settings.conf, mode 600, in the
// format of agents.conf, read under the environment; a credential is a file
// of its own, never a line of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS_FILE, applySettings, readSettings, settingsPath, writeCredential, writeSettings } from '../../src/setup/settings.ts';

function scratch(): { dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-settings-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const mode = (path: string) => statSync(path).mode & 0o777;

test('the file is <state>/settings.conf, named from the state folder the service uses', () => {
  assert.equal(SETTINGS_FILE, 'settings.conf');
  assert.equal(settingsPath({ CLEARED_STATE_DIR: '/srv/cleared' }), '/srv/cleared/settings.conf');
  assert.equal(settingsPath({ ORCH_LEDGER: '/srv/state/ledger.db' }), '/srv/state/settings.conf');
  assert.equal(settingsPath({}), undefined, 'no state folder can be told: no settings file');
});

test('written in the format of agents.conf, mode 600, merged line by line, and read back', () => {
  const { dir, done } = scratch();
  try {
    const path = join(dir, SETTINGS_FILE);
    assert.deepEqual(readSettings(path), { env: {}, files: {} }, 'no file: nothing set');
    writeSettings(path, { env: { CLEARED_V2_OWNER_ID: 'alex' } });
    writeSettings(path, { env: { CLEARED_CLAUDE_CREDENTIALS: join(dir, 'claude.token') }, files: { GH_TOKEN: join(dir, 'forge-github.token') } });
    assert.equal(mode(path), 0o600);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^# /, 'it says what it is');
    assert.match(text, /\[env\]\nCLEARED_CLAUDE_CREDENTIALS = .*\nCLEARED_V2_OWNER_ID = alex\n/);
    assert.match(text, /\[env_files\]\nGH_TOKEN = .*forge-github\.token\n/);
    assert.deepEqual(readSettings(path), {
      env: { CLEARED_CLAUDE_CREDENTIALS: join(dir, 'claude.token'), CLEARED_V2_OWNER_ID: 'alex' },
      files: { GH_TOKEN: join(dir, 'forge-github.token') },
    });
    writeSettings(path, { env: { CLEARED_V2_OWNER_ID: null } });
    assert.equal(readSettings(path).env.CLEARED_V2_OWNER_ID, undefined, 'null removes a line');
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.part')), [], 'no half-written file left');
  } finally { done(); }
});

test('a line the file cannot hold is refused: a value on two lines, a name that is not a setting', () => {
  const { dir, done } = scratch();
  try {
    const path = join(dir, SETTINGS_FILE);
    assert.throws(() => writeSettings(path, { env: { CLEARED_V2_OWNER_ID: 'alex\n[env]\nPATH = /tmp' } }), /one line/);
    assert.throws(() => writeSettings(path, { env: { PATH: '/tmp' } }), /not a setting/);
    assert.throws(() => writeSettings(path, { files: { HOME: '/tmp/x' } }), /not a setting/);
  } finally { done(); }
});

test('applied under the environment: a variable already set wins, the others are filled, a file setting gives the file\'s content', () => {
  const { dir, done } = scratch();
  try {
    const path = join(dir, SETTINGS_FILE);
    const forge = join(dir, 'forge-github.token');
    writeCredential(forge, 'forge-credential-for-the-test');
    writeSettings(path, { env: { CLEARED_V2_OWNER_ID: 'alex', CLEARED_V2_APP_LANGUAGE: 'en' }, files: { GH_TOKEN: forge } });
    const env: NodeJS.ProcessEnv = { CLEARED_V2_APP_LANGUAGE: 'fr' };
    const result = applySettings(env, path);
    assert.equal(env.CLEARED_V2_OWNER_ID, 'alex');
    assert.equal(env.CLEARED_V2_APP_LANGUAGE, 'fr', 'the environment wins: an install made by hand keeps working');
    assert.equal(env.GH_TOKEN, 'forge-credential-for-the-test');
    assert.deepEqual(result.applied.sort(), ['CLEARED_V2_OWNER_ID', 'GH_TOKEN']);
    assert.ok(!JSON.stringify(result).includes('forge-credential-for-the-test'), 'the result names the variables, never a value');
  } finally { done(); }
});

test('applied again, a value the file set before is replaced; one the environment set at start never is', () => {
  const { dir, done } = scratch();
  try {
    const path = join(dir, SETTINGS_FILE);
    writeSettings(path, { env: { CLEARED_V2_OWNER_ID: 'alex' } });
    const env: NodeJS.ProcessEnv = { CLEARED_V2_APP_LANGUAGE: 'fr' };
    const fromEnvironment = new Set(['CLEARED_V2_APP_LANGUAGE']);
    applySettings(env, path, { fromEnvironment });
    writeSettings(path, { env: { CLEARED_V2_OWNER_ID: 'sam', CLEARED_V2_APP_LANGUAGE: 'en' } });
    applySettings(env, path, { fromEnvironment });
    assert.equal(env.CLEARED_V2_OWNER_ID, 'sam');
    assert.equal(env.CLEARED_V2_APP_LANGUAGE, 'fr');
  } finally { done(); }
});

test('a credential file that is a link, or that others can read, is not applied', () => {
  const { dir, done } = scratch();
  try {
    const path = join(dir, SETTINGS_FILE);
    const real = join(dir, 'real.token');
    writeFileSync(real, 'credential-read-by-others', { mode: 0o644 });
    const link = join(dir, 'link.token');
    symlinkSync(real, link);
    writeSettings(path, { files: { GH_TOKEN: link } });
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applySettings(env, path).refused, ['GH_TOKEN']);
    assert.equal(env.GH_TOKEN, undefined);
    writeSettings(path, { files: { GH_TOKEN: real } });
    assert.deepEqual(applySettings(env, path).refused, ['GH_TOKEN'], 'mode 644: refused');
    assert.equal(env.GH_TOKEN, undefined);
  } finally { done(); }
});

test('a credential is written once to its own file, mode 600, and replaced whole', () => {
  const { dir, done } = scratch();
  try {
    const file = join(dir, 'claude.token');
    writeCredential(file, 'first-value-of-the-test');
    assert.equal(mode(file), 0o600);
    assert.equal(readFileSync(file, 'utf8'), 'first-value-of-the-test\n');
    writeCredential(file, 'second-value-of-the-test');
    assert.equal(readFileSync(file, 'utf8'), 'second-value-of-the-test\n');
    assert.ok(lstatSync(file).isFile());
    assert.deepEqual(readdirSync(dir).sort(), ['claude.token'], 'no .part left beside it');
    assert.throws(() => writeCredential(file, 'two\nlines'), /one line/);
    assert.throws(() => writeCredential(file, ''), /empty/);
  } finally { done(); }
});
