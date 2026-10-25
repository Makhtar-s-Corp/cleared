// When a schedule runs (decision 29): `at` a time, once, or `every` day,
// weekday, chosen day of the week or hour, in the server's time zone. The
// zone is fixed here, so the summer time's end is tested where it happens.
process.env.TZ = 'Europe/Paris';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleError, nextRun, parseAt, parseEvery } from '../../src/schedules/when.ts';

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = (date: Date) => date.toISOString();

test('every day at a time: the next one strictly after the given moment', () => {
  assert.equal(iso(nextRun('day 03:00', local(2026, 10, 22, 2, 59))), iso(local(2026, 10, 22, 3, 0)));
  assert.equal(iso(nextRun('day 03:00', local(2026, 10, 22, 3, 0))), iso(local(2026, 10, 23, 3, 0)));
  assert.equal(iso(nextRun('day 03:00', local(2026, 10, 22, 14, 0))), iso(local(2026, 10, 23, 3, 0)));
});

test('across the end of summer time, a day at 03:00 is 25 hours after the one before', () => {
  // In Paris, 2026-10-25 03:00 summer time is 02:00 winter time: the day has 25 hours.
  const saturday = nextRun('day 03:00', local(2026, 10, 24, 1, 0));
  const sunday = nextRun('day 03:00', saturday);
  assert.equal(iso(saturday), '2026-10-24T01:00:00.000Z');
  assert.equal(iso(sunday), '2026-10-25T02:00:00.000Z');
  assert.equal(sunday.getHours(), 3);
});

test('weekdays, one day of the week, and every hour', () => {
  // 2026-10-23 is a Friday.
  assert.equal(iso(nextRun('weekdays 07:30', local(2026, 10, 23, 8, 0))), iso(local(2026, 10, 26, 7, 30)));
  assert.equal(iso(nextRun('monday 06:00', local(2026, 10, 22, 12, 0))), iso(local(2026, 10, 26, 6, 0)));
  assert.equal(iso(nextRun('sunday 23:15', local(2026, 10, 25, 23, 15))), iso(local(2026, 11, 1, 23, 15)));
  assert.equal(iso(nextRun('hour :15', local(2026, 10, 22, 9, 15))), iso(local(2026, 10, 22, 10, 15)));
  assert.equal(iso(nextRun('hour :15', local(2026, 10, 22, 9, 14))), iso(local(2026, 10, 22, 9, 15)));
});

test('what is not a period is refused with the forms it may take', () => {
  for (const bad of ['', 'day', 'day 3:00', 'day 24:00', 'day 03:60', 'daily 03:00', 'hour 15', 'hour :75', 'fortnight 03:00', 'day 03:00 extra'])
    assert.throws(() => parseEvery(bad), (error: unknown) => error instanceof ScheduleError && /day HH:MM/.test(error.message), bad);
  assert.deepEqual(parseEvery('  Day 03:00 '), { days: [0, 1, 2, 3, 4, 5, 6], hour: 3, minute: 0, text: 'day 03:00' });
});

test('a time to run once is read in the server\'s time zone, or with its own offset, and must be to come', () => {
  const now = local(2026, 10, 22, 12, 0);
  assert.equal(iso(parseAt('2026-10-23T03:00', now)), iso(local(2026, 10, 23, 3, 0)));
  assert.equal(iso(parseAt('2026-10-23T03:00:00Z', now)), '2026-10-23T03:00:00.000Z');
  assert.throws(() => parseAt('2026-10-22T11:00', now), /to come/);
  assert.throws(() => parseAt('tomorrow', now), /2026-10-24T03:00/);
  assert.throws(() => parseAt('2026-02-30T03:00', now), ScheduleError);
});
