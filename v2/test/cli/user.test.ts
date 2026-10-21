import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const cli = new URL('../../src/cli/user.ts', import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), 'cleared-v2-user-cli-'));
after(() => rmSync(state, { recursive: true, force: true }));

function run(args: string[], input: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: state };
  delete env.ORCH_LEDGER;
  return spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8' });
}

const rows = () => {
  const db = new DatabaseSync(join(state, 'ledger.db'));
  try { return db.prepare('SELECT name, password FROM users ORDER BY name').all() as { name: string; password: string }[]; }
  finally { db.close(); }
};

test('user add asks for the password twice and stores only its Argon2id hash', () => {
  const result = run(['add', 'alex'], 'a long passphrase\na long passphrase\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^cleared-v2: user alex added\n$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /a long passphrase/);
  const [row] = rows();
  assert.equal(row?.name, 'alex');
  assert.match(row?.password ?? '', /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
});

test('user add refuses two passwords that differ, an empty one, and a name already taken', () => {
  const differ = run(['add', 'sam'], 'one passphrase\nanother passphrase\n');
  assert.equal(differ.status, 1);
  assert.match(differ.stderr, /the two passwords differ/);
  const empty = run(['add', 'sam'], '\n\n');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /the password is empty/);
  const taken = run(['add', 'alex'], 'another long passphrase\nanother long passphrase\n');
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /a user named alex already exists/);
  const short = run(['add', 'sam'], 'too short\ntoo short\n');
  assert.equal(short.status, 1);
  assert.match(short.stderr, /at least 15 characters/);
  assert.deepEqual(rows().map((row) => row.name), ['alex']);
});

test('user with anything else prints its usage and exits 64', () => {
  for (const args of [[], ['add'], ['remove', 'alex'], ['add', 'a', 'b']]) {
    const result = run(args, '');
    assert.equal(result.status, 64, JSON.stringify(args));
    assert.match(result.stderr, /usage: cleared-v2 user add <name>/);
  }
});
