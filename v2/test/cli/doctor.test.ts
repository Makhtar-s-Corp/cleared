// `cleared doctor` (docs/v2/milestone-5-plan.md, section 7, issue #415): with
// no argument, the ready section, each line marked in words, what to do under
// a failure, exit 0 when nothing failed and 1 otherwise; --full runs
// scripts/doctor.ts with the rest of the arguments and ends with its exit
// code; anything else is the usage, exit 64. The sections come from a
// scratch folder here (CLEARED_V2_DOCTOR_SECTIONS), so no test reaches Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../src/cli/cleared.ts', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'cleared-v2-doctor-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A ready section of the test's own: it fails when FAIL_HERE is set, and
// says which settings it was given, to show the settings file applies first.
writeFileSync(join(scratch, 'ready.ts'), `export default {
  name: 'ready',
  byDefault: false,
  title: (language) => (language === 'en' ? 'ready: the test\\'s' : 'ready : celle du test'),
  run: async (env, language) => [
    { id: 'one', level: 'ok', text: language === 'en' ? 'Docker answers.' : 'Docker répond.' },
    { id: 'two', level: 'notice', text: 'GH_TOKEN ' + (env.GH_TOKEN ? 'set' : 'unset') },
    { id: 'three', level: env.FAIL_HERE ? 'fail' : 'ok', text: 'the third line', todo: 'Run the third thing.' },
  ],
};
`);
writeFileSync(join(scratch, 'hello.ts'), "export default { name: 'hello', byDefault: false, title: () => 'hello', run: async (env) => [{ id: 'h', level: env.FAIL_HERE ? 'fail' : 'ok', text: 'hello line', todo: 'say hello' }] };\n");

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [cli, 'doctor', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: scratch, CLEARED_STATE_DIR: join(scratch, 'state'), CLEARED_V2_DOCTOR_SECTIONS: scratch, CLEARED_V2_APP_LANGUAGE: 'en', ...env },
  });

test('with no argument, the ready section: its title, each line marked in words, exit 0 when nothing failed', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready: the test's/);
  assert.match(result.stdout, /^ok\s+Docker answers\.$/m);
  assert.match(result.stdout, /^note\s+GH_TOKEN unset$/m);
  assert.match(result.stdout, /no check failed/i);
});

test('a failure: marked, what to do under it, the count, exit 1', () => {
  const result = run([], { FAIL_HERE: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^failed\s+the third line$/m);
  assert.match(result.stdout, /^\s+Run the third thing\.$/m);
  assert.match(result.stdout, /1 check failed/);
});

test('in French by default, as the app', () => {
  const result = run([], { FAIL_HERE: '1', CLEARED_V2_APP_LANGUAGE: '' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ready : celle du test/);
  assert.match(result.stdout, /^ok\s+Docker répond\.$/m);
  assert.match(result.stdout, /^échec\s+the third line$/m);
  assert.match(result.stdout, /1 vérification en échec/);
});

test('the settings file the assistant wrote applies before the checks', () => {
  const state = join(scratch, 'state');
  rmSync(state, { recursive: true, force: true });
  spawnSync('mkdir', ['-m', '700', state]);
  const file = join(state, 'forge-github.token');
  writeFileSync(file, 'not-a-real-one\n', { mode: 0o600 });
  writeFileSync(join(state, 'settings.conf'), `[env_files]\nGH_TOKEN = ${file}\n`, { mode: 0o600 });
  const result = run([]);
  assert.match(result.stdout, /GH_TOKEN set/);
  assert.ok(!result.stdout.includes('not-a-real-one'));
});

test('--full runs scripts/doctor.ts with the rest of the arguments and ends with its exit code', () => {
  const well = run(['--full', 'hello']);
  assert.equal(well.status, 0, well.stderr);
  assert.match(well.stdout, /^PASS hello line$/m);
  const failed = run(['--full', 'hello'], { FAIL_HERE: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^FAIL hello line$/m);
  const unknown = run(['--full', 'nope']);
  assert.equal(unknown.status, 64);
});

test('anything else is the usage, on stderr, exit 64', () => {
  for (const args of [['nope'], ['--fast'], ['ready', 'more']]) {
    const result = run(args);
    assert.equal(result.status, 64, args.join(' '));
    assert.match(result.stderr, /cleared doctor/);
    assert.match(result.stderr, /--full/);
  }
  const help = run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--full/);
});
