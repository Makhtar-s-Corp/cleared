// The quota reading (issue #270): the source's answer read from outputs kept
// in fixtures/, every attempt stored in the ledger, a failure said once per
// run without blocking, the alerts at 75 and 85 percent once per window
// cycle, and the newest figure the plans, the schedules and the screen read.
//
// The fixtures are /api/oauth/usage answers written to the shape the Claude
// Code CLI 2.1.310 reads (its schema: per window `utilization` in percent,
// nullable, and `resets_at`, an ISO text, nullable), with invented figures:
// no account was read to write them.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NO_LEVERS } from '../../src/consumption/levers.ts';
import {
  QuotaReadError, QuotaReader, USAGE_URL, claudeCodeQuotaSource, latestQuota, lastReading, loginToken, parseUsage,
  type QuotaSource, type UsageFetch, type WindowReading,
} from '../../src/consumption/quota.ts';
import { consumption } from '../../src/consumption/usage.ts';
import { quotaMinutes } from '../../src/modules/lead.ts';
import { NOTIFY_TABLES, type Occurrence } from '../../src/notify/queue.ts';
import { weekShare } from '../../src/schedules/scheduler.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const LOGIN = ['test', 'login', 'FAKE-LOGIN', '0001'].join('-');
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test('the answer of /api/oauth/usage: the two windows in percent with their resets; a changed shape is a failure, never a figure', () => {
  assert.deepEqual(parseUsage(fixture('usage-ok.json')), [
    { window: 'seven_day', usedPercent: 68.4, resetsAt: '2026-10-28T09:00:00.000Z' },
    { window: 'five_hour', usedPercent: 21, resetsAt: '2026-10-24T15:00:00.000Z' },
  ]);
  assert.deepEqual(parseUsage(fixture('usage-week-only.json')), [{ window: 'seven_day', usedPercent: 86, resetsAt: '2026-10-28T09:00:00.000Z' }]);
  // Seconds since the epoch, as the CLI's headers give them, read too.
  assert.deepEqual(parseUsage({ seven_day: { utilization: 5, resets_at: 1_793_178_000 } }), [{ window: 'seven_day', usedPercent: 5, resetsAt: '2026-10-28T09:00:00.000Z' }]);
  assert.throws(() => parseUsage(fixture('usage-changed.json')), /seven_day window is not read as a utilization/);
  assert.throws(() => parseUsage(fixture('usage-none.json')), /neither a five-hour nor a seven-day window/);
  assert.throws(() => parseUsage(fixture('usage-error.json')), /neither a five-hour nor a seven-day window/);
  assert.throws(() => parseUsage([]), QuotaReadError);
  assert.throws(() => parseUsage({ seven_day: { utilization: 10, resets_at: 'Tuesday' } }), /reset time is not a date/);
});

test('the login file: a token, or a credentials file\'s access token', () => {
  assert.equal(loginToken(`${LOGIN}\n`), LOGIN);
  assert.equal(loginToken(JSON.stringify({ claudeAiOauth: { accessToken: LOGIN, refreshToken: 'r' } })), LOGIN);
  assert.equal(loginToken('{"claudeAiOauth":{}}'), undefined);
  assert.equal(loginToken(''), undefined);
  assert.equal(loginToken(undefined), undefined);
});

type Call = { url: string; headers: Record<string, string> };
const answering = (status: number, body: unknown, calls: Call[] = []): UsageFetch => async (url, init) => {
  calls.push({ url, headers: init.headers });
  return { status, json: async () => body };
};
const signal = () => AbortSignal.timeout(1000);

test('the Claude Code source asks the endpoint with the login, and says each failure in words that never carry the token', async () => {
  const calls: Call[] = [];
  const source = claudeCodeQuotaSource({ loginFile: '/state/claude.token', readFile: () => LOGIN, fetch: answering(200, fixture('usage-ok.json'), calls) });
  assert.equal(source.harness, 'claude-code');
  assert.equal((await source.read(signal())).length, 2);
  assert.equal(calls[0]?.url, USAGE_URL);
  assert.equal(calls[0]?.headers.authorization, `Bearer ${LOGIN}`);
  assert.equal(calls[0]?.headers['anthropic-beta'], 'oauth-2025-04-20');

  const failures: [UsageFetch | undefined, string | undefined, RegExp][] = [
    [answering(403, fixture('usage-error.json')), LOGIN, /refused the login \(HTTP 403\)/],
    [answering(500, {}), LOGIN, /answered HTTP 500/],
    [async () => { throw new TypeError(`fetch failed for ${LOGIN}`); }, LOGIN, /could not be reached \(TypeError\)/],
    [async () => ({ status: 200, json: async () => { throw new SyntaxError(LOGIN); } }), LOGIN, /not JSON/],
    [answering(200, fixture('usage-changed.json')), LOGIN, /not read as a utilization/],
    [undefined, undefined, /no token in the login file/],
  ];
  for (const [get, token, expected] of failures) {
    let used = false;
    const failing = claudeCodeQuotaSource({ loginFile: '/state/claude.token', readFile: () => token, fetch: get ?? (async (...args) => { used = true; return answering(200, {})(...args); }) });
    await assert.rejects(failing.read(signal()), (error: Error) => {
      assert.ok(error instanceof QuotaReadError, error.name);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /FAKE-LOGIN/);
      return true;
    });
    assert.equal(used, false, 'no login, no request');
  }
});

// A source that answers what a test gives it, one answer per reading.
function scripted(answers: (readonly WindowReading[] | Error)[], harness: QuotaSource['harness'] = 'claude-code'): QuotaSource {
  return {
    harness, source: `${harness} test source`,
    async read() {
      const next = answers.shift();
      if (!next || next instanceof Error) throw next ?? new QuotaReadError('no answer left');
      return next;
    },
  };
}

function ledger(): Store {
  const store = openStore(':memory:');
  applyTables(store.db, NOTIFY_TABLES);
  return store;
}

const week = (usedPercent: number, resetsAt: string | null = iso(NOW + 4 * 24 * HOUR)): WindowReading => ({ window: 'seven_day', usedPercent, resetsAt });
const rows = (store: Store) => store.db.prepare('SELECT harness, source, at, ok, "window", used_percent AS used, resets_at AS resets, error FROM quota_readings ORDER BY id').all().map((row) => ({ ...row }));
const health = (store: Store) => (store.db.prepare("SELECT json_extract(facts, '$.code') AS code FROM v2_notify_queue WHERE kind = 'health' ORDER BY first_at, key").all() as { code: string }[]).map((r) => r.code);

test('each reading is a row with its time, its source and its resets; a failure is a row with its reason, and the next source is still read', async () => {
  const store = ledger();
  let clock = NOW;
  const codex = scripted([[{ window: 'five_hour', usedPercent: 3, resetsAt: iso(NOW + 2 * HOUR) }]], 'codex');
  const reader = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(clock), sources: [scripted([new QuotaReadError('the endpoint answered HTTP 500')]), codex] });
  const events = await reader.tick();
  assert.deepEqual(events.map((e) => `${e.type}:${e.harness}`), ['quota_read_failed:claude-code', 'quota_read:codex']);
  assert.deepEqual(rows(store), [
    { harness: 'claude-code', source: 'claude-code test source', at: iso(NOW), ok: 0, window: null, used: null, resets: null, error: 'the endpoint answered HTTP 500' },
    { harness: 'codex', source: 'codex test source', at: iso(NOW), ok: 1, window: 'five_hour', used: 3, resets: iso(NOW + 2 * HOUR), error: null },
  ]);
  assert.deepEqual(lastReading(store.db, 'guestbook', 'claude-code'), { at: iso(NOW), source: 'claude-code test source', ok: false, error: 'the endpoint answered HTTP 500' });
  clock += HOUR;
  assert.deepEqual(await reader.tick().then((e) => e.map((x) => x.type)), ['quota_read_failed', 'quota_read_failed'], 'a thrown error never stops the tick');
});

test('a run of failures is notified once, at its first; a reading that works ends the run', async () => {
  const store = ledger();
  let clock = NOW;
  const fail = () => new QuotaReadError('the endpoint answered HTTP 500');
  const reader = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(clock), sources: [scripted([fail(), fail(), [week(10)], fail()])] });
  const notified: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    for (const event of await reader.tick()) if (event.type === 'quota_read_failed') notified.push(event.notified);
    clock += HOUR;
  }
  assert.deepEqual(notified, [true, false, true]);
  assert.deepEqual(health(store), ['quota_read_failed', 'quota_read_failed']);
});

test('the alerts: 75 then 85 percent, each once per window cycle, kept across a restart, again in the next cycle', async () => {
  const store = ledger();
  let clock = NOW;
  const cycle = iso(NOW + 4 * 24 * HOUR);
  const next = iso(NOW + 11 * 24 * HOUR);
  const answers = [[week(70, cycle)], [week(76, cycle)], [week(80, cycle)], [week(90, cycle)], [week(91, cycle)]];
  const alerts: string[] = [];
  const read = async (reader: QuotaReader) => {
    for (const event of await reader.tick()) if (event.type === 'quota_alert') alerts.push(`${event.percent}@${event.usedPercent}`);
    clock += HOUR;
  };
  const source = scripted(answers);
  const first = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(clock), sources: [source] });
  for (let i = 0; i < 4; i++) await read(first);
  assert.deepEqual(alerts, ['75@76', '85@90']);
  // A restart: a new reader over the same ledger does not alert again for the same cycle.
  const again = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(clock), sources: [source] });
  await read(again);
  assert.deepEqual(alerts, ['75@76', '85@90']);
  // The next cycle starts at 88 percent: both alerts again, at once.
  const later = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(clock), sources: [scripted([[week(88, next)]])] });
  await read(later);
  assert.deepEqual(alerts, ['75@76', '85@90', '75@88', '85@88']);
  assert.deepEqual(health(store), ['quota_75', 'quota_85', 'quota_75', 'quota_85']);
});

test('a notification that cannot be queued does not stop the reading', async () => {
  const store = openStore(':memory:');           // no notify table
  const reader = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(NOW), sources: [scripted([[week(95)]])] });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    assert.deepEqual((await reader.tick()).map((e) => e.type), ['quota_read', 'quota_alert', 'quota_alert']);
  } finally { console.error = original; }
  assert.equal(rows(store).length, 1);
  assert.equal(errors.length, 2);
});

test('the notifications go where they are told, with the screen as their link', async () => {
  const store = openStore(':memory:');
  const sent: Occurrence[] = [];
  const reader = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(NOW), notify: (o) => { sent.push(o); }, sources: [scripted([[week(80)]])] });
  await reader.tick();
  assert.deepEqual(sent.map((o) => [o.kind, o.code, o.link, o.group]), [['health', 'quota_75', '/consumption', 'health:quota_75']]);
});

function session(store: Store, id: string, harness: 'claude-code' | 'codex') {
  store.sessions.put({ id, project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness, model: 'claude-opus-5-5', status: 'running', createdAt: iso(NOW), updatedAt: iso(NOW) });
}
function reported(store: Store, id: string, at: number, usedPercent: number, resetsAt: string | null) {
  store.events.append({ at: iso(at), sessionId: id, ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent, resetsAt } } });
}

test('the newest figure is a reading\'s or a session\'s, whichever is newer; none once its reset passed', async () => {
  const store = ledger();
  session(store, 's1', 'claude-code');
  const resets = iso(NOW + 4 * 24 * HOUR);
  reported(store, 's1', NOW - 2 * HOUR, 40, resets);
  const latest = (now = NOW) => latestQuota(store.db, { project: 'guestbook', window: 'seven_day', now: new Date(now), harness: 'claude-code' });
  assert.deepEqual(latest(), { window: 'seven_day', usedPercent: 40, resetsAt: resets, observedAt: iso(NOW - 2 * HOUR), source: 'session' });
  const reader = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(NOW - HOUR), sources: [scripted([[week(55, resets)]])] });
  await reader.tick();
  assert.deepEqual(latest(), { window: 'seven_day', usedPercent: 55, resetsAt: resets, observedAt: iso(NOW - HOUR), source: 'claude-code test source' });
  reported(store, 's1', NOW, 57, resets);
  assert.equal(latest()?.source, 'session');
  assert.equal(weekShare(store.db, 'guestbook', new Date(NOW)), 57);
  // Past the reset, nothing: the plans do not stop on an old cycle.
  assert.equal(latest(Date.parse(resets) + 1), undefined);
  assert.equal(weekShare(store.db, 'guestbook', new Date(Date.parse(resets) + 1)), undefined);
  // A failed reading is no figure.
  await new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(NOW + HOUR), sources: [scripted([new QuotaReadError('x')])] }).tick();
  assert.equal(latest()?.usedPercent, 57);
});

test('the Consumption screen: each window\'s source, and the harness\'s last reading, a failure with its reason', async () => {
  const store = ledger();
  const resets = iso(NOW + 4 * 24 * HOUR);
  let clock = NOW - 2 * HOUR;
  const reader = new QuotaReader({ db: store.db, project: 'guestbook', now: () => new Date(clock), sources: [scripted([[week(62, resets)], new QuotaReadError('the endpoint answered HTTP 500')])] });
  await reader.tick();
  clock = NOW - HOUR;
  await reader.tick();
  const view = consumption(store.db, { project: 'guestbook', now: new Date(NOW), levers: NO_LEVERS, config: { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' } });
  const claude = view.harnesses.find((h) => h.harness === 'claude-code');
  assert.deepEqual(claude?.quotas.map((q) => [q.window, q.usedPercent, q.source, q.observedAt]), [['seven_day', 62, 'claude-code test source', iso(NOW - 2 * HOUR)]]);
  assert.deepEqual(claude?.lastReading, { at: iso(NOW - HOUR), source: 'claude-code test source', ok: false, error: 'the endpoint answered HTTP 500' });
  assert.equal(view.harnesses.find((h) => h.harness === 'codex')?.lastReading, null);
});

test('CLEARED_V2_QUOTA_MINUTES: 60 by default, 0 turns the reading off, a wrong value is the default', () => {
  assert.equal(quotaMinutes(undefined), 60);
  assert.equal(quotaMinutes(''), 60);
  assert.equal(quotaMinutes('0'), 0);
  assert.equal(quotaMinutes('15'), 15);
  const original = console.error;
  console.error = () => undefined;
  try { assert.equal(quotaMinutes('soon'), 60); } finally { console.error = original; }
});
