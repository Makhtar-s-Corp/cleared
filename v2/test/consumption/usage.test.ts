// What the Consumption screen reads (O15): tokens per day and per harness
// from the finished turns, the quota windows a harness reported, the
// projection at the cycle's pace, and the dollars only where a turn
// reported them.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW_MS, consumption, dayOf, lastDays, leverChoices, projectQuota, zoneOf } from '../../src/consumption/usage.ts';
import { NO_LEVERS } from '../../src/consumption/levers.ts';
import type { Harness } from '../../src/session/contract.ts';
import { openStore, type Store } from '../../src/store/db.ts';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const HOUR = 3_600_000;
const CONFIG = { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' };

function session(store: Store, id: string, harness: Harness) {
  store.sessions.put({ id, project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness, model: 'claude-opus-5-5', status: 'running', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
let n = 0;
function turn(store: Store, id: string, at: string, usage: Record<string, number>, cost: number | null) {
  n += 1;
  store.events.append({ at, sessionId: id, ticket: 'LOCAL-1', project: 'guestbook',
    event: { type: 'RUN_FINISHED', threadId: id, runId: `r${n}`, outcome: { type: 'success' }, usage: [usage], result: { stopReason: 'end_turn', total_cost_usd: cost } } as never });
}
function limit(store: Store, id: string, at: string, window: 'five_hour' | 'seven_day', usedPercent: number, resetsAt: string | null) {
  store.events.append({ at, sessionId: id, ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window, usedPercent, resetsAt } } as never });
}
const read = (store: Store, extra: { timeZone?: string } = {}) => consumption(store.db, { project: 'guestbook', now: NOW, levers: NO_LEVERS, config: CONFIG, ...extra });

test('the days are the last seven calendar days of the zone, today last', () => {
  assert.deepEqual(lastDays(NOW, 'UTC'), ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  // 23:30 UTC is already the 24th in Paris (UTC+2 in October).
  assert.equal(dayOf('2026-10-23T23:30:00Z', 'Europe/Paris'), '2026-10-24');
  assert.equal(lastDays(new Date('2026-10-23T23:30:00Z'), 'Europe/Paris').at(-1), '2026-10-24');
  // Across the end of summer time, the calendar is counted in days, not hours.
  assert.deepEqual(lastDays(new Date('2026-10-26T12:00:00Z'), 'Europe/Paris'), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
  assert.equal(zoneOf('Not/AZone'), 'UTC');
  assert.equal(zoneOf(undefined), 'UTC');
});

test('tokens are the four counts of each finished turn, by day and by harness of the session', () => {
  const store = openStore(':memory:');
  session(store, 's1', 'claude-code');
  session(store, 's2', 'codex');
  turn(store, 's1', '2026-10-23T08:00:00.000Z', { inputTokens: 100, outputTokens: 50, cachedInputTokens: 1000, cacheWriteInputTokens: 10 }, 0.4);
  turn(store, 's1', '2026-10-22T08:00:00.000Z', { inputTokens: 5, outputTokens: 5 }, 0.1);
  turn(store, 's2', '2026-10-23T09:00:00.000Z', { inputTokens: 7, outputTokens: 3 }, null);
  turn(store, 's1', '2026-10-01T09:00:00.000Z', { inputTokens: 9999 }, 9);                 // out of the seven days
  const { harnesses } = read(store);
  const claude = harnesses.find((h) => h.harness === 'claude-code')!;
  assert.equal(claude.tokens, 1170);
  assert.deepEqual(claude.perDay.slice(-2), [{ day: '2026-10-22', tokens: 10 }, { day: '2026-10-23', tokens: 1160 }]);
  assert.equal(claude.sessions, 1);
  const codex = harnesses.find((h) => h.harness === 'codex')!;
  assert.equal(codex.tokens, 10);
  store.close();
});

test('a turn counts in the day of the person\'s zone', () => {
  const store = openStore(':memory:');
  session(store, 's1', 'claude-code');
  turn(store, 's1', '2026-10-22T23:30:00.000Z', { inputTokens: 40 }, null);          // 01:30 on the 23rd in Paris
  const paris = read(store, { timeZone: 'Europe/Paris' }).harnesses[0]!;
  assert.deepEqual(paris.perDay.filter((d) => d.tokens > 0), [{ day: '2026-10-23', tokens: 40 }]);
  const utc = read(store).harnesses[0]!;
  assert.deepEqual(utc.perDay.filter((d) => d.tokens > 0), [{ day: '2026-10-22', tokens: 40 }]);
  store.close();
});

test('the cost is the sum of what the turns reported, null when none did, and says how many reported', () => {
  const store = openStore(':memory:');
  session(store, 's1', 'claude-code');
  session(store, 's2', 'codex');
  turn(store, 's1', '2026-10-23T08:00:00.000Z', { inputTokens: 1 }, 0.4);
  turn(store, 's1', '2026-10-23T09:00:00.000Z', { inputTokens: 1 }, 0.125);
  turn(store, 's1', '2026-10-23T10:00:00.000Z', { inputTokens: 1 }, null);
  turn(store, 's2', '2026-10-23T10:00:00.000Z', { inputTokens: 1 }, null);
  const { harnesses } = read(store);
  const claude = harnesses.find((h) => h.harness === 'claude-code')!;
  assert.equal(claude.costUsd, 0.53);
  assert.deepEqual(claude.costTurns, { reported: 2, turns: 3 });
  const codex = harnesses.find((h) => h.harness === 'codex')!;
  assert.equal(codex.costUsd, null, 'no turn reported a cost: nothing is shown, no estimate');
  assert.deepEqual(codex.costTurns, { reported: 0, turns: 1 });
  store.close();
});

test('a harness with no session reads as empty, not as zero spent', () => {
  const store = openStore(':memory:');
  const codex = read(store).harnesses.find((h) => h.harness === 'codex')!;
  assert.deepEqual({ sessions: codex.sessions, tokens: codex.tokens, quotas: codex.quotas, costUsd: codex.costUsd }, { sessions: 0, tokens: 0, quotas: [], costUsd: null });
  store.close();
});

test('the quota is the newest measure of the harness\'s own window, and none once its reset passed', () => {
  const store = openStore(':memory:');
  session(store, 's1', 'claude-code');
  session(store, 's2', 'codex');
  limit(store, 's1', '2026-10-23T06:00:00.000Z', 'seven_day', 20, '2026-10-27T12:00:00.000Z');
  limit(store, 's1', '2026-10-23T11:00:00.000Z', 'seven_day', 41, '2026-10-27T12:00:00.000Z');
  limit(store, 's1', '2026-10-23T11:00:00.000Z', 'five_hour', 10, '2026-10-23T11:30:00.000Z');       // reset has passed
  limit(store, 's2', '2026-10-23T11:00:00.000Z', 'seven_day', 90, '2026-10-27T12:00:00.000Z');
  const { harnesses } = read(store);
  const claude = harnesses.find((h) => h.harness === 'claude-code')!;
  assert.deepEqual(claude.quotas.map((q) => [q.window, q.usedPercent, q.observedAt]), [['seven_day', 41, '2026-10-23T11:00:00.000Z']]);
  assert.equal(harnesses.find((h) => h.harness === 'codex')!.quotas[0]?.usedPercent, 90);
  store.close();
});

const seven = (usedPercent: number, observedAt: string, resetsAt: string) => projectQuota({ window: 'seven_day', usedPercent, observedAt, resetsAt });

test('the projection: 100 % before the reset when the pace is too high, and again in the next window', () => {
  // The window opened 2026-10-20T12:00 (reset - 7 days); 3 days in, 60 % used: 20 % a day, 100 % after 2 more days.
  // The next window opens at the reset and, at 20 % a day, is full after 5 days.
  assert.deepEqual(seven(60, '2026-10-23T12:00:00.000Z', '2026-10-27T12:00:00.000Z'), { kind: 'before_reset', hitsAt: '2026-10-25T12:00:00.000Z', nextHitsAt: '2026-11-01T12:00:00.000Z' });
  // 5 days in, 80 %: 16 % a day, 100 % in 1.25 days, before the reset in 2.
  assert.equal(seven(80, '2026-10-25T12:00:00.000Z', '2026-10-27T12:00:00.000Z').kind, 'before_reset');
});

test('the projection: it holds until the reset, with the share it reaches there', () => {
  // 3 days in, 30 % used: 10 % a day, so 70 % at the reset 4 days later.
  assert.deepEqual(seven(30, '2026-10-23T12:00:00.000Z', '2026-10-27T12:00:00.000Z'), { kind: 'holds', percentAtReset: 70 });
  // 6 days in, 70 %: 11.67 % a day, 81.7 % one day later.
  assert.deepEqual(seven(70, '2026-10-26T12:00:00.000Z', '2026-10-27T12:00:00.000Z'), { kind: 'holds', percentAtReset: 81.7 });
});

test('the projection says nothing before it can: idle, just opened, already reached', () => {
  assert.deepEqual(seven(0, '2026-10-23T12:00:00.000Z', '2026-10-27T12:00:00.000Z'), { kind: 'idle' });
  assert.deepEqual(seven(3, '2026-10-20T12:30:00.000Z', '2026-10-27T12:00:00.000Z'), { kind: 'too_early' });
  assert.deepEqual(seven(100, '2026-10-23T12:00:00.000Z', '2026-10-27T12:00:00.000Z'), { kind: 'reached' });
  // The five-hour window is read with its own length.
  const p = projectQuota({ window: 'five_hour', usedPercent: 50, observedAt: '2026-10-23T11:00:00.000Z', resetsAt: '2026-10-23T14:00:00.000Z' });
  assert.deepEqual(p, { kind: 'before_reset', hitsAt: '2026-10-23T13:00:00.000Z', nextHitsAt: '2026-10-23T18:00:00.000Z' });
  assert.equal(WINDOW_MS.five_hour, 5 * HOUR);
});

test('the levers are returned with the model the owner may choose: never the reviewers\' model', () => {
  const store = openStore(':memory:');
  const { levers } = read(store);
  assert.deepEqual(levers.model, { current: 'claude-opus-5-5', choice: null, reviewer: 'claude-sonnet-5-5', options: ['claude-opus-5-5', 'claude-haiku-5-5'] });
  assert.deepEqual(levers.maxLanes, { choice: null, options: [1, 2, 3] });
  assert.equal(levers.paused, false);
  store.close();
});

test('the model options keep the configured author and a model stored earlier', () => {
  const config = { authorModel: 'claude-future-9', reviewerModel: 'claude-sonnet-5-5' };
  const configured = leverChoices({ model: null, maxLanes: null, paused: false }, config).model;
  assert.equal(configured.current, 'claude-future-9');
  assert.ok(configured.options.includes('claude-future-9'), 'the default has a toggle to show pressed');
  assert.ok(!configured.options.includes('claude-sonnet-5-5'), "the reviewer's model is never an option");
  const stored = leverChoices({ model: 'claude-old-1', maxLanes: null, paused: false }, config).model;
  assert.ok(stored.options.includes('claude-old-1'));
});
