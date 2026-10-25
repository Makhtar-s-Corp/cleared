// The one `cleared` command (docs/v2/milestone-5-plan.md, decision 8, issue
// #406): `cleared <command>` runs src/cli/<command>.ts when that file exists,
// with its arguments, its exit code and its output; a lane adds a command by
// adding a file. Anything else is the list of commands, in French or English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { CLI_DIR, commandFile, commands } from '../../src/cli/cleared.ts';

const cli = new URL('../../src/cli/cleared.ts', import.meta.url).pathname;
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, CLEARED_V2_APP_LANGUAGE: 'en', ...env } });

const scratch = mkdtempSync(join(tmpdir(), 'cleared-v2-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('the commands are the files of src/cli, the dispatcher itself left out', () => {
  const known = commands();
  for (const name of ['install', 'status', 'user', 'setup']) assert.ok(known.includes(name), name);
  assert.ok(!known.includes('cleared'));
  assert.deepEqual(known, [...known].sort());
  assert.equal(commandFile('status'), join(CLI_DIR, 'status.ts'));
});

test('a name that is not a command file is refused, a path above all', () => {
  for (const name of ['', 'cleared', 'nope', '../main', 'cli/status', 'status.ts', '.hidden', 'Status', '-h']) assert.equal(commandFile(name), undefined, name);
});

test('a lane adds a command by adding a file', () => {
  writeFileSync(join(scratch, 'hello.ts'), "process.stdout.write(`hello ${process.argv.slice(2).join(' ')}\\n`); process.exitCode = 3;\n");
  assert.deepEqual(commands(scratch), ['hello']);
  assert.equal(commandFile('hello', scratch), join(scratch, 'hello.ts'));
  const result = run(['hello', 'a', '--b'], { CLEARED_V2_CLI_DIR: scratch });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, 'hello a --b\n');
});

test('no command, help, or an unknown one: the list, in the language asked, with exit 64 for the unknown', () => {
  const bare = run([]);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /Usage: cleared <command>/);
  assert.match(bare.stdout, /\binstall\b/);
  assert.equal(run(['help']).stdout, bare.stdout);
  const unknown = run(['nope']);
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /"nope" is not a command of cleared/);
  const french = run(['nope'], { CLEARED_V2_APP_LANGUAGE: 'fr' });
  assert.match(french.stderr, /«\snope\s» n’est pas une commande de cleared/);
});
