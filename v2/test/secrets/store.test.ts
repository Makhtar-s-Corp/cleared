// The test secrets' store (docs/v2/milestone-5-plan.md, section 12, decision
// 12, C16): each value encrypted with AES-256-GCM under <state>/secrets.key,
// made at first use, mode 600; the ledger alone, copied without its key,
// reads nothing; each change kept with its name, who and when, never its
// value; the values a session may be given, and every value the cleaner
// removes, from memory. Fake values only, made at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KEY_FILE, KeyError, keyFileOf, readKey } from '../../src/secrets/key.ts';
import { TEST_VALUE_TABLES, TestValueError, TestValues } from '../../src/secrets/store.ts';
import { TEST_VALUE_MAX, TEST_VALUES_PER_SERVICE } from '../../src/secrets/types.ts';
import { tempDir } from '../workspace/git.ts';

// A fake sandbox value, never a real one: built here so no literal of it is in the repository.
const fake = (n: number | string = 1): string => ['sandbox', 'fake', 'value', String(n)].join('-');

function made(prefix = 'secrets') {
  const state = tempDir(prefix);
  const path = join(state, 'ledger.db');
  const db = new DatabaseSync(path);
  const keyFile = keyFileOf(state);
  let clock = Date.parse('2026-10-27T09:00:00.000Z');
  const now = () => new Date(clock += 60_000);
  return { state, path, db, keyFile, now, store: new TestValues(db, keyFile, now) };
}

// Every byte of the ledger as SQLite keeps it on disk: its file and its write-ahead log.
function ledgerBytes(path: string): Buffer {
  return Buffer.concat([path, `${path}-wal`].filter(existsSync).map((file) => readFileSync(file)));
}

test('the key is made at the first value, 32 bytes of mode 600 in the state folder, not before', () => {
  const { store, keyFile, state } = made();
  assert.equal(keyFile, join(state, KEY_FILE));
  assert.equal(store.state(), 'none');
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(keyFile), false, 'reading nothing makes no key');
  store.set('api', 'PAYMENT_SANDBOX_KEY', fake(), 'u1');
  const stat = statSync(keyFile);
  assert.equal(stat.size, 32);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(store.state(), 'ready');
});

test('a value is encrypted at rest: neither the ledger nor its log holds it, and two equal values are sealed apart', () => {
  const { store, db, path } = made();
  const value = fake();
  store.set('api', 'PAYMENT_SANDBOX_KEY', value, 'u1');
  store.set('web', 'PAYMENT_SANDBOX_KEY', value, 'u1');
  const rows = db.prepare('SELECT * FROM test_secrets').all() as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  for (const row of rows) for (const cell of Object.values(row)) assert.ok(!Buffer.from(cell as never).includes(value), 'no column holds the value');
  const [a, b] = rows as [{ iv: Uint8Array; sealed: Uint8Array }, { iv: Uint8Array; sealed: Uint8Array }];
  assert.notDeepEqual(Buffer.from(a.iv), Buffer.from(b.iv), 'a fresh nonce for every write');
  assert.notDeepEqual(Buffer.from(a.sealed), Buffer.from(b.sealed));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(!ledgerBytes(path).includes(value), 'the ledger file holds no value in clear');
  assert.deepEqual(store.variables('api'), { PAYMENT_SANDBOX_KEY: value });
});

test('the ledger copied without its key reads nothing: the names stay, unreadable, and no session gets a value', () => {
  const { store, db, path } = made('secrets-from');
  store.set('api', 'PAYMENT_SANDBOX_KEY', fake(), 'u1');
  store.set('api', 'MAIL_TEST_PASSWORD', fake(2), 'u1');
  db.close();
  const elsewhere = tempDir('secrets-copy');
  copyFileSync(path, join(elsewhere, 'ledger.db'));
  const copy = new TestValues(new DatabaseSync(join(elsewhere, 'ledger.db')), keyFileOf(elsewhere));
  assert.equal(copy.state(), 'none');
  assert.deepEqual(copy.list().map((value) => [value.name, value.readable]), [['MAIL_TEST_PASSWORD', false], ['PAYMENT_SANDBOX_KEY', false]]);
  assert.deepEqual(copy.variables('api'), {});
  assert.deepEqual(copy.known(), []);
  // A new key there opens nothing of the old values; a value set again is readable.
  copy.set('api', 'MAIL_TEST_PASSWORD', fake(3), 'u2');
  assert.deepEqual(copy.variables('api'), { MAIL_TEST_PASSWORD: fake(3) });
  assert.equal(copy.list().find((value) => value.name === 'PAYMENT_SANDBOX_KEY')?.readable, false);
});

test('a sealed value moved to another name or service in the ledger does not open', () => {
  const { store, db, keyFile, now } = made();
  store.set('api', 'PAYMENT_SANDBOX_KEY', fake(), 'u1');
  store.set('api', 'OTHER_KEY', fake(2), 'u1');
  db.prepare('UPDATE test_secrets SET iv = (SELECT iv FROM test_secrets WHERE name = ?), tag = (SELECT tag FROM test_secrets WHERE name = ?), sealed = (SELECT sealed FROM test_secrets WHERE name = ?) WHERE name = ?')
    .run('PAYMENT_SANDBOX_KEY', 'PAYMENT_SANDBOX_KEY', 'PAYMENT_SANDBOX_KEY', 'OTHER_KEY');
  const again = new TestValues(db, keyFile, now);
  assert.deepEqual(again.variables('api'), { PAYMENT_SANDBOX_KEY: fake() });
  assert.equal(again.list().find((value) => value.name === 'OTHER_KEY')?.readable, false);
});

test('set, replace and remove: each change in the ledger with its name, who and when, never its value', () => {
  const { store, db, path } = made();
  const first = store.set('api', 'PAYMENT_SANDBOX_KEY', fake(1), 'u1');
  assert.equal(first.replaced, false);
  assert.deepEqual(first.value, { service: 'api', name: 'PAYMENT_SANDBOX_KEY', setAt: '2026-10-27T09:01:00.000Z', setBy: 'u1', readable: true });
  const second = store.set('api', 'PAYMENT_SANDBOX_KEY', fake(2), 'u2');
  assert.equal(second.replaced, true);
  assert.equal(second.value.setBy, 'u2');
  assert.deepEqual(store.variables('api'), { PAYMENT_SANDBOX_KEY: fake(2) });
  assert.equal(store.remove('api', 'PAYMENT_SANDBOX_KEY', 'u1'), true);
  assert.equal(store.remove('api', 'PAYMENT_SANDBOX_KEY', 'u1'), false, 'nothing left to remove');
  assert.deepEqual(store.variables('api'), {});
  assert.deepEqual(store.changes(), [
    { service: 'api', name: 'PAYMENT_SANDBOX_KEY', change: 'set', by: 'u1', at: '2026-10-27T09:01:00.000Z' },
    { service: 'api', name: 'PAYMENT_SANDBOX_KEY', change: 'replaced', by: 'u2', at: '2026-10-27T09:02:00.000Z' },
    { service: 'api', name: 'PAYMENT_SANDBOX_KEY', change: 'removed', by: 'u1', at: '2026-10-27T09:03:00.000Z' },
  ]);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = ledgerBytes(path);
  for (const value of [fake(1), fake(2)]) assert.ok(!bytes.includes(value), 'no value, current or old, anywhere in the ledger');
});

test('the cleaner\'s list keeps a replaced or removed value while the service runs: a running session may still hold it', () => {
  const { store } = made();
  store.set('api', 'PAYMENT_SANDBOX_KEY', fake(1), 'u1');
  store.set('api', 'PAYMENT_SANDBOX_KEY', fake(2), 'u1');
  store.set('web', 'MAIL_TEST_PASSWORD', fake(3), 'u1');
  store.remove('web', 'MAIL_TEST_PASSWORD', 'u1');
  assert.deepEqual([...store.known()].sort(), [fake(1), fake(2), fake(3)]);
  const list = store.known();
  assert.equal(store.known(), list, 'the same array until a change: the cleaner reads it at every text');
});

test('a value read at start is known at once, without a write', () => {
  const { store, db, keyFile } = made();
  store.set('api', 'PAYMENT_SANDBOX_KEY', fake(), 'u1');
  const again = new TestValues(db, keyFile);
  assert.deepEqual(again.known(), [fake()]);
  assert.deepEqual(again.variables('api'), { PAYMENT_SANDBOX_KEY: fake() });
  assert.deepEqual(again.variables('web'), {});
});

test('a name is an environment variable\'s, never one Cleared or a test service sets', () => {
  const { store } = made();
  for (const name of ['', 'lower_case', '1STARTS_WITH_DIGIT', 'HAS-DASH', 'HAS SPACE', 'A'.repeat(65)]) {
    assert.throws(() => store.set('api', name, fake(), 'u1'), (error: unknown) => error instanceof TestValueError && error.code === 'name', name);
  }
  for (const name of ['HOME', 'PATH', 'HTTPS_PROXY', 'NO_PROXY', 'DATABASE_URL', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLEARED_V2_STATE_DIR', 'LD_PRELOAD', 'GIT_SSH_COMMAND', 'SSL_CERT_FILE']) {
    assert.throws(() => store.set('api', name, fake(), 'u1'), (error: unknown) => error instanceof TestValueError && error.code === 'reserved', name);
  }
  assert.deepEqual(store.list(), []);
});

test('a value is one line of 8 characters at least, so the cleaner can find it, and of a bounded size', () => {
  const { store } = made();
  const code = (value: string) => {
    try { store.set('api', 'PAYMENT_SANDBOX_KEY', value, 'u1'); return 'saved'; } catch (error) { return error instanceof TestValueError ? error.code : 'other'; }
  };
  assert.equal(code('short'), 'short');
  assert.equal(code('x'.repeat(TEST_VALUE_MAX + 1)), 'long');
  assert.equal(code(`${fake()}\n${fake(2)}`), 'line');
  assert.equal(code(`${fake()}\u0007`), 'line');
  assert.equal(code(` ${fake()} `), 'space', 'a value with spaces around it is a paste mistake');
  assert.equal(code(fake()), 'saved');
});

test('a service holds a bounded number of values', () => {
  const { store } = made();
  for (let i = 0; i < TEST_VALUES_PER_SERVICE; i += 1) store.set('api', `VALUE_${i}`, fake(i), 'u1');
  assert.throws(() => store.set('api', 'ONE_MORE', fake(), 'u1'), (error: unknown) => error instanceof TestValueError && error.code === 'count');
  store.set('api', 'VALUE_0', fake('again'), 'u1');
  store.set('web', 'ONE_MORE', fake(), 'u1');
});

test('a key that is a link, readable by others, or not 32 bytes is refused: nothing is sealed or opened with it', () => {
  for (const spoil of ['link', 'mode', 'size'] as const) {
    const { store, keyFile, state, db, now } = made(`secrets-${spoil}`);
    store.set('api', 'PAYMENT_SANDBOX_KEY', fake(), 'u1');
    if (spoil === 'link') {
      const real = join(state, 'elsewhere.key');
      copyFileSync(keyFile, real);
      chmodSync(real, 0o600);
      // Replaced by a link to a copy of itself.
      rmSync(keyFile);
      symlinkSync(real, keyFile);
      assert.ok(lstatSync(keyFile).isSymbolicLink());
    }
    if (spoil === 'mode') chmodSync(keyFile, 0o644);
    if (spoil === 'size') writeFileSync(keyFile, Buffer.alloc(16), { mode: 0o600 });
    assert.throws(() => readKey(keyFile), KeyError, spoil);
    const again = new TestValues(db, keyFile, now);
    assert.equal(again.state(), 'unusable', spoil);
    assert.deepEqual(again.variables('api'), {}, spoil);
    assert.equal(again.list()[0]?.readable, false, spoil);
    assert.throws(() => again.set('api', 'PAYMENT_SANDBOX_KEY', fake(2), 'u1'), (error: unknown) => error instanceof TestValueError && error.code === 'key', spoil);
  }
});

test('the store declares its tables, and an error never carries a value', () => {
  assert.ok(TEST_VALUE_TABLES.some((table) => table.includes('test_secrets')));
  assert.ok(TEST_VALUE_TABLES.some((table) => table.includes('test_secret_changes')));
  const { store } = made();
  const value = `${fake()}\n`;
  try { store.set('api', 'PAYMENT_SANDBOX_KEY', value, 'u1'); assert.fail('refused'); } catch (error) {
    assert.ok(!(error as Error).message.includes(fake()), 'the refusal names no value');
  }
});
