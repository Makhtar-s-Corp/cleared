// The records of the assistant's steps (docs/v2/milestone-5-plan.md, section
// 1 and section 5.2, lane v2-j5-assistant): when each step was shown, done or
// skipped, and its time split into the person's and the machine's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyTables } from '../../src/store/db.ts';
import { SETUP_STEPS_TABLE, SetupRecords } from '../../src/setup/records.ts';

function records(start = '2026-10-25T10:00:00.000Z') {
  let now = new Date(start);
  const db = new DatabaseSync(':memory:');
  applyTables(db, [SETUP_STEPS_TABLE]);
  return { db, records: new SetupRecords(db, { now: () => now }), at: (iso: string) => { now = new Date(iso); } };
}

test('a step shown, then done: the person\'s time is the time on the step less the machine\'s', () => {
  const { records: r, at } = records();
  r.shown('forge');
  at('2026-10-25T10:03:00.000Z');
  r.machine('forge', 4_000);
  r.done('forge');
  assert.deepEqual(r.get('forge'), {
    step: 'forge', shownAt: '2026-10-25T10:00:00.000Z', doneAt: '2026-10-25T10:03:00.000Z', skippedAt: null,
    personMs: 176_000, machineMs: 4_000,
  });
});

test('shown again keeps the first time; the machine\'s time adds up; the person\'s is never below zero', () => {
  const { records: r, at } = records();
  r.shown('model');
  at('2026-10-25T10:01:00.000Z');
  r.shown('model');
  r.machine('model', 30_000);
  r.machine('model', 45_000);
  r.done('model');
  const row = r.get('model');
  assert.equal(row?.shownAt, '2026-10-25T10:00:00.000Z');
  assert.equal(row?.machineMs, 75_000);
  assert.equal(row?.personMs, 0, 'the machine took the whole minute and more: no negative time');
});

test('done without being shown counts from now; skipped keeps the time spent before the skip', () => {
  const { records: r, at } = records();
  r.done('owner');
  assert.equal(r.get('owner')?.personMs, 0);
  r.shown('secrets');
  at('2026-10-25T10:00:40.000Z');
  r.skipped('secrets');
  assert.deepEqual(r.get('secrets'), { step: 'secrets', shownAt: '2026-10-25T10:00:00.000Z', doneAt: null, skippedAt: '2026-10-25T10:00:40.000Z', personMs: 40_000, machineMs: 0 });
});

test('a step done after a skip is done, its time counted from when it was first shown', () => {
  const { records: r, at } = records();
  r.shown('forge');
  at('2026-10-25T10:01:00.000Z');
  r.skipped('forge');
  at('2026-10-25T10:02:00.000Z');
  r.done('forge');
  assert.equal(r.get('forge')?.skippedAt, null);
  assert.equal(r.get('forge')?.doneAt, '2026-10-25T10:02:00.000Z');
  assert.equal(r.get('forge')?.personMs, 120_000);
});

test('an unknown step is refused; a step never seen has no record', () => {
  const { records: r } = records();
  assert.throws(() => r.shown('nothing' as never), /unknown step/);
  assert.equal(r.get('checks'), undefined);
  assert.deepEqual(r.all(), []);
});
