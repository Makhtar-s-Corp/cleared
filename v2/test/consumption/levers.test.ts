// The levers (O15): stored by project, validated whole, put back to off by null,
// and read as off before anything is set or where the table does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVERS_TABLE, LeverError, LeverStore, NO_LEVERS } from '../../src/consumption/levers.ts';
import { applyTables, openStore } from '../../src/store/db.ts';

const AT = '2026-10-23T12:00:00.000Z';
const REVIEWER = 'claude-sonnet-5-5';

function levers() {
  const store = openStore(':memory:');
  applyTables(store.db, [LEVERS_TABLE]);
  return { store, levers: new LeverStore(store.db, 'guestbook') };
}

test('nothing set reads as off, with or without the table', () => {
  const t = levers();
  assert.deepEqual(t.levers.read(), NO_LEVERS);
  const bare = openStore(':memory:');
  assert.deepEqual(new LeverStore(bare.db, 'guestbook').read(), NO_LEVERS);
});

test('each lever is set and put back alone', () => {
  const t = levers();
  assert.deepEqual(t.levers.set({ model: 'claude-haiku-5-5' }, 'u1', AT, REVIEWER), { model: 'claude-haiku-5-5', maxLanes: null, paused: false });
  assert.deepEqual(t.levers.set({ maxLanes: 1 }, 'u1', AT, REVIEWER), { model: 'claude-haiku-5-5', maxLanes: 1, paused: false });
  assert.deepEqual(t.levers.set({ paused: true }, 'u1', AT, REVIEWER), { model: 'claude-haiku-5-5', maxLanes: 1, paused: true });
  assert.deepEqual(t.levers.set({ model: null, maxLanes: null, paused: false }, 'u1', AT, REVIEWER), NO_LEVERS);
  assert.equal(t.store.db.prepare('SELECT count(*) AS n FROM consumption_levers').get()?.n, 0, 'off is no row');
});

test('a lever is kept per project and says who set it and when', () => {
  const t = levers();
  t.levers.set({ paused: true }, 'u1', AT, REVIEWER);
  assert.equal(new LeverStore(t.store.db, 'other').read().paused, false);
  assert.deepEqual(t.store.db.prepare('SELECT lever, by_user, at FROM consumption_levers').all().map((r) => ({ ...r })), [{ lever: 'paused', by_user: 'u1', at: AT }]);
});

test('a change with one bad part is refused whole', () => {
  const t = levers();
  const refuse = (change: Parameters<LeverStore['set']>[0], pattern: RegExp) => assert.throws(() => t.levers.set(change, 'u1', AT, REVIEWER), (e) => e instanceof LeverError && pattern.test(e.message));
  refuse({ model: 'gpt-9' }, /model must be one of/);
  refuse({ model: REVIEWER }, /cannot be the reviewers/);
  refuse({ maxLanes: 0 }, /whole number from 1 to 8/);
  refuse({ maxLanes: 1.5 }, /whole number/);
  refuse({ maxLanes: 99 }, /whole number/);
  refuse({ paused: 'yes' as unknown as boolean }, /true or false/);
  refuse({}, /name a lever/);
  refuse({ speed: 3 } as never, /unknown lever: speed/);
  refuse({ paused: true, maxLanes: 0 }, /whole number/);
  assert.deepEqual(t.levers.read(), NO_LEVERS, 'the good part of a refused change was not applied');
});
