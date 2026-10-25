// The setup code of the first start (docs/v2/milestone-5-plan.md, decision
// 5, lane v2-j5-assistant): on a ledger with no user the service makes a
// one-time code and prints it; the code creates the owner's account once,
// within 24 hours, and dies with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import users from '../../src/modules/users.ts';
import { applyTables } from '../../src/store/db.ts';
import { SETUP_CODE_HOURS, SETUP_CODE_LINE, SETUP_CODE_TABLE, createOwner, issueSetupCode, noUser, normalizeCode, setupCodeLine } from '../../src/setup/code.ts';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const HASH = '$argon2id$v=19$m=64,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA';

function ledger(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyTables(db, [...users.tables, SETUP_CODE_TABLE]);
  return db;
}

test('a code is eight letters and digits a person cannot misread, in two groups; only its hash is kept', () => {
  const db = ledger();
  const { code, expiresAt } = issueSetupCode(db, NOW);
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'no 0, O, 1 or I');
  assert.equal(expiresAt, later(SETUP_CODE_HOURS).toISOString());
  assert.equal(SETUP_CODE_HOURS, 24);
  const rows = db.prepare('SELECT * FROM v2_setup_code').all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(code.replace('-', '')), 'the code itself is not in the ledger');
  assert.equal(rows[0]?.hash, createHash('sha256').update(code.replace('-', '')).digest('hex'));
});

test('the log line says the code and until when, and the one command reads the code out of it', () => {
  const line = setupCodeLine('ABCD-EFGH', '2026-10-26T10:00:00.000Z');
  assert.match(line, /^cleared-v2: /);
  assert.match(line, /\/setup/, 'it says where to type it');
  assert.equal(SETUP_CODE_LINE.exec(line)?.[1], 'ABCD-EFGH');
  assert.equal(SETUP_CODE_LINE.exec('cleared-v2: listening on http://127.0.0.1:8789 (health: /health)'), null);
});

test('a code is typed as a person types it: lower case, spaces, without its dash', () => {
  assert.equal(normalizeCode(' abcd efgh '), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCD-EFGH'), 'ABCDEFGH');
  assert.equal(normalizeCode('abcdefgh'), 'ABCDEFGH');
});

test('the right code creates the owner once, and the code is gone with it', () => {
  const db = ledger();
  const { code } = issueSetupCode(db, NOW);
  assert.equal(noUser(db), true);
  const made = createOwner(db, { code: code.toLowerCase(), name: 'alex', passwordHash: HASH, now: later(1) });
  assert.ok(made.ok);
  assert.equal(noUser(db), false);
  assert.deepEqual((db.prepare('SELECT name, password FROM users').all() as Record<string, unknown>[]).map((r) => [r.name, r.password]), [['alex', HASH]]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM v2_setup_code').get() as { n: number }).n, 0, 'the code is spent');
  assert.deepEqual(createOwner(db, { code, name: 'sam', passwordHash: HASH, now: later(1) }), { ok: false, reason: 'taken' }, 'a second owner is never made');
});

test('a wrong code, an expired one, an older one and none are refused, and nothing is written', () => {
  const db = ledger();
  assert.deepEqual(createOwner(db, { code: 'ABCD-EFGH', name: 'alex', passwordHash: HASH, now: NOW }), { ok: false, reason: 'wrong' }, 'no code issued yet');
  const first = issueSetupCode(db, NOW).code;
  const { code } = issueSetupCode(db, NOW);
  if (first !== code) assert.deepEqual(createOwner(db, { code: first, name: 'alex', passwordHash: HASH, now: NOW }), { ok: false, reason: 'wrong' }, 'a restart makes a new code; the old one stops');
  assert.deepEqual(createOwner(db, { code: 'ZZZZ-ZZZZ', name: 'alex', passwordHash: HASH, now: NOW }), { ok: false, reason: 'wrong' });
  assert.deepEqual(createOwner(db, { code, name: 'alex', passwordHash: HASH, now: later(SETUP_CODE_HOURS + 0.01) }), { ok: false, reason: 'expired' });
  assert.equal(noUser(db), true);
});

test('a code is dead once any user exists, even one added by the command line', () => {
  const db = ledger();
  const { code } = issueSetupCode(db, NOW);
  db.prepare('INSERT INTO users (id, name, password, created_at) VALUES (?, ?, ?, ?)').run('u1', 'sam', HASH, NOW.toISOString());
  assert.deepEqual(createOwner(db, { code, name: 'alex', passwordHash: HASH, now: NOW }), { ok: false, reason: 'taken' });
});
