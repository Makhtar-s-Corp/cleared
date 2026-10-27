import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import users, {
  PASSWORD_DEFAULTS, PASSWORD_LENGTH, PROOF_FILE, ProofError, SqliteUsers, UserError,
  hashPassword, proofPath, proofReader, readOrCreateProof, sameProof, verifyPassword, type PasswordParams,
} from '../../src/modules/users.ts';
import { applyTables, openStore } from '../../src/store/db.ts';

// Small parameters keep the tests fast; the defaults are checked on their own.
const FAST: PasswordParams = { algorithm: 'argon2id', memory: 64, passes: 1, parallelism: 1, saltLength: 16, tagLength: 32 };

const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-users-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function directory(): SqliteUsers {
  const db = new DatabaseSync(':memory:');
  applyTables(db, users.tables);
  return new SqliteUsers(db, { params: FAST });
}

test('the default password parameters are the second recommended Argon2id option of RFC 9106, section 4', () => {
  assert.deepEqual(PASSWORD_DEFAULTS, { algorithm: 'argon2id', memory: 65536, passes: 3, parallelism: 4, saltLength: 16, tagLength: 32 });
});

test('a password hash names its algorithm, parameters and salt, and only the same password verifies', async () => {
  const stored = await hashPassword('correct horse', FAST);
  assert.match(stored, /^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.notEqual(await hashPassword('correct horse', FAST), stored, 'each hash has its own salt');
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('correct horsf', stored), false);
  assert.equal(await verifyPassword('correct horse', 'not a hash'), false);
  assert.equal(await verifyPassword('correct horse', stored.replace('m=64', 'm=128')), false, 'the parameters are part of what is checked');
});

test('a user is added once by name, then verified by name and password', async () => {
  const directory_ = directory();
  const alex = await directory_.add('alex', 'a long passphrase');
  assert.match(alex.id, /^[0-9a-f-]{36}$/);
  assert.equal(alex.name, 'alex');
  await assert.rejects(directory_.add('alex', 'another long passphrase'), /a user named alex already exists/);
  assert.deepEqual(await directory_.verify('alex', 'a long passphrase'), alex);
  assert.equal(await directory_.verify('alex', 'wrong'), undefined);
  assert.equal(await directory_.verify('nobody', 'a long passphrase'), undefined);
  assert.deepEqual(await directory_.get(alex.id), alex);
  assert.deepEqual(await directory_.list(), [alex]);
});

test('a user name is short and plain, and a password is not empty', async () => {
  const directory_ = directory();
  for (const name of ['', ' alex', 'a b', 'x'.repeat(33), 'al\nex', '../alex']) await assert.rejects(directory_.add(name, 'a long passphrase'), UserError, JSON.stringify(name));
  await assert.rejects(directory_.add('alex', ''), UserError);
  assert.deepEqual(await directory_.list(), []);
});

test('a password is 15 to 1024 characters, as NIST SP 800-63B-4 asks of a single-factor password', async () => {
  assert.deepEqual(PASSWORD_LENGTH, { min: 15, max: 1024 });
  const directory_ = directory();
  await assert.rejects(directory_.add('short', 'x'.repeat(14)), /at least 15 characters/);
  await assert.rejects(directory_.add('long', 'x'.repeat(1025)), /at most 1024 characters/);
  await assert.rejects(directory_.add('accents', 'é'.repeat(14)), /at least 15 characters/, 'characters are counted, not bytes');
  await directory_.add('shortest', 'x'.repeat(15));
  await directory_.add('longest', 'x'.repeat(1024));
  assert.deepEqual((await directory_.list()).map((u) => u.name).sort(), ['longest', 'shortest']);
});

test('the module creates its table in the ledger and fills the users slot', async () => {
  const store = openStore(':memory:');
  try {
    applyTables(store.db, users.tables);
    const slots = users.provide({ store });
    assert.ok(slots.users instanceof SqliteUsers);
    assert.deepEqual(users.routes, []);
    const columns = (store.db.prepare("SELECT name FROM pragma_table_info('users') ORDER BY cid").all() as { name: string }[]).map((row) => row.name);
    assert.deepEqual(columns, ['id', 'name', 'password', 'created_at']);
  } finally {
    store.close();
  }
});

test('the proof file sits beside the ledger, is made once with mode 0600, and a looser one is refused', () => {
  const ledger = join(dir, 'state', 'ledger.db');
  const path = proofPath(ledger);
  assert.equal(path, join(dir, 'state', PROOF_FILE));
  const proof = readOrCreateProof(path);
  assert.match(proof, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readOrCreateProof(path), proof, 'a second reader gets the same proof');
  chmodSync(path, 0o640);
  assert.throws(() => readOrCreateProof(path), ProofError);
  chmodSync(path, 0o600);
  writeFileSync(path, 'short\n');
  assert.throws(() => readOrCreateProof(path), ProofError);
  assert.equal(readFileSync(path, 'utf8'), 'short\n', 'a refused proof is left as it is');
});

// Issue #429: at a first start the service and the app make or read the
// proof at once. The file appears whole or not at all, so no reader ever
// sees it empty or half written, and every process gets the same proof.
test('the proof appears whole or not at all: while it is written, its path holds nothing a reader could take', () => {
  const folder = mkdtempSync(join(dir, 'race-'));
  const path = join(folder, PROOF_FILE);
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const write = fs.writeSync;
  const seen: (string | null)[] = [];
  // A reader that looks at the path at the moment the proof is written: what another process would read then.
  fs.writeSync = ((...args: Parameters<typeof write>) => {
    try { seen.push(readFileSync(path, 'utf8')); } catch { seen.push(null); }
    return write(...args);
  }) as typeof write;
  syncBuiltinESMExports();
  let proof: string;
  try { proof = readOrCreateProof(path); }
  finally { fs.writeSync = write; syncBuiltinESMExports(); }
  assert.deepEqual(seen, [null], 'nothing at the path while the proof is written');
  assert.match(proof, /^[0-9a-f]{64}$/);
  assert.equal(readOrCreateProof(path), proof, 'a second process gets the same proof');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(folder), [PROOF_FILE], 'nothing but the proof is left in the folder');
});

test('the app\'s reader of the proof waits for a whole one, keeps it, and reads it again when told the service refused it', () => {
  const folder = mkdtempSync(join(dir, 'reader-'));
  const path = join(folder, PROOF_FILE);
  writeFileSync(path, '', { mode: 0o600 });
  const proof = proofReader(path);
  assert.throws(() => proof(), ProofError, 'an empty file is not a proof yet');
  writeFileSync(path, `${'a'.repeat(64)}\n`);
  assert.equal(proof(), 'a'.repeat(64), 'read again at the next call, with no restart');
  writeFileSync(path, `${'b'.repeat(64)}\n`);
  assert.equal(proof(), 'a'.repeat(64), 'a whole proof is kept');
  proof.forget();
  assert.equal(proof(), 'b'.repeat(64), 'forgotten, it is read again');
});

test('two proofs compare in constant time and only an exact match passes', () => {
  const proof = 'a'.repeat(64);
  assert.equal(sameProof(proof, proof), true);
  assert.equal(sameProof('b'.repeat(64), proof), false);
  assert.equal(sameProof(undefined, proof), false);
  assert.equal(sameProof(proof.slice(1), proof), false);
  assert.equal(sameProof(['x', proof], proof), false);
});
