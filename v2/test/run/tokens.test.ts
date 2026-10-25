// API tokens (docs/v2/milestone-5-plan.md, decision 11, C18): made by a
// signed-in person, shown once, kept as a SHA-256 hash in the ledger,
// listed by their name and dates, revocable. A value is drawn at each run
// of the tests, never written here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACCESS_NAME_MAX, ACCESS_PER_PERSON, ApiTokens, AccessError, accessHash } from '../../src/run/tokens.ts';
import { openStore } from '../../src/store/db.ts';

const clock = { now: Date.parse('2026-10-25T10:00:00.000Z') };
const fresh = () => {
  const store = openStore(':memory:');
  return { store, tokens: new ApiTokens(store.db, () => new Date(clock.now)) };
};

test('a token is made for a person with a name, its value shown once and only its SHA-256 kept', () => {
  const { store, tokens } = fresh();
  const made = tokens.make('u1', '  Nightly script  ');
  assert.match(made.value, /^clr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(made.token, { id: made.token.id, name: 'Nightly script', createdAt: '2026-10-25T10:00:00.000Z', lastUsedAt: null });
  assert.match(made.token.id, /^[a-f0-9]{12}$/);
  assert.equal(accessHash(made.value), createHash('sha256').update(made.value).digest('hex'));
  const rows = store.db.prepare('SELECT * FROM api_tokens').all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hash, accessHash(made.value));
  for (const value of Object.values(rows[0]!)) assert.ok(typeof value !== 'string' || !value.includes(made.value.slice(4)), 'the value is in no column');
  assert.ok(!JSON.stringify(tokens.list('u1')).includes(made.value), 'the list never holds it');
  assert.ok(!JSON.stringify(tokens.list('u1')).includes(accessHash(made.value)), 'nor its hash');
});

test('two tokens never share a value', () => {
  const { tokens } = fresh();
  const values = new Set(Array.from({ length: 10 }, (_, i) => tokens.make(`u${i % 2}`, `n${i}`).value));
  assert.equal(values.size, 10);
});

test('a name is 1 to 60 characters, trimmed; a person holds 20 tokens at most', () => {
  const { tokens } = fresh();
  assert.equal(ACCESS_NAME_MAX, 60);
  assert.equal(ACCESS_PER_PERSON, 20);
  for (const name of ['', '   ', 'x'.repeat(61), 'two\nlines']) assert.throws(() => tokens.make('u1', name), AccessError, JSON.stringify(name));
  assert.equal(tokens.make('u1', 'x'.repeat(60)).token.name.length, 60);
  for (let i = 1; i < 20; i++) tokens.make('u1', `n${i}`);
  assert.throws(() => tokens.make('u1', 'one more'), (error: unknown) => error instanceof AccessError && /20/.test(error.message));
  assert.doesNotThrow(() => tokens.make('u2', 'another person'));
});

test('the value finds its person, and says when it was last used; a wrong one finds no one', () => {
  const { tokens } = fresh();
  const made = tokens.make('u1', 'CI');
  clock.now += 60_000;
  assert.deepEqual(tokens.verify(made.value), { user: 'u1', id: made.token.id });
  assert.equal(tokens.list('u1')[0]!.lastUsedAt, '2026-10-25T10:01:00.000Z');
  const other = `clr_${'A'.repeat(43)}`;
  for (const wrong of ['', 'clr_', other, made.value.slice(0, -1), `${made.value} `, made.value.toUpperCase()]) assert.equal(tokens.verify(wrong), undefined, wrong);
});

test('a person lists their own tokens, newest first, and revokes their own only; a revoked one finds no one', () => {
  const { tokens } = fresh();
  const first = tokens.make('u1', 'first');
  clock.now += 1000;
  const second = tokens.make('u1', 'second');
  const theirs = tokens.make('u2', 'theirs');
  assert.deepEqual(tokens.list('u1').map((token) => token.name), ['second', 'first']);
  assert.deepEqual(tokens.list('u2').map((token) => token.name), ['theirs']);
  assert.equal(tokens.revoke('u1', theirs.token.id), false, 'not another person\'s');
  assert.ok(tokens.verify(theirs.value));
  assert.equal(tokens.revoke('u1', first.token.id), true);
  assert.equal(tokens.revoke('u1', first.token.id), false, 'once');
  assert.equal(tokens.verify(first.value), undefined);
  assert.deepEqual(tokens.list('u1').map((token) => token.name), ['second']);
  assert.ok(tokens.verify(second.value));
});

test('the tables survive a second instance over the same ledger', () => {
  const store = openStore(':memory:');
  const made = new ApiTokens(store.db).make('u1', 'kept');
  assert.equal(new ApiTokens(store.db).verify(made.value)?.user, 'u1');
});
