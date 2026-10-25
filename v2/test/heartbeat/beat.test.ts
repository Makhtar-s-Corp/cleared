// The service's beat (docs/v2/milestone-4-plan.md, section 7.4), against a
// fake monitor on loopback: a GET to the success address with no problem,
// a POST of the problems' codes to the failure address with one, each
// continuous problem recorded once, a failed delivery said once an hour,
// and never an address, a ticket, a session or a path in what leaves the
// host, in the ledger or in the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Heartbeat } from '../../src/heartbeat/beat.ts';
import type { HeartbeatSettings, MonitorAddresses } from '../../src/heartbeat/settings.ts';
import { openStore } from '../../src/store/db.ts';
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { applyTables } from '../../src/store/db.ts';
import { HEARTBEAT_TABLES } from '../../src/heartbeat/beat.ts';
import { NOW, events, fakeMonitor, ledger, minutesBefore, session } from './support.ts';

const settings: HeartbeatSettings = { everyMs: 60_000, sessionMinutes: 120, trackerMinutes: 10, trackers: [] };

function clock(start = NOW) {
  let at = start.getTime();
  return { now: () => new Date(at), advance: (minutes: number) => { at += minutes * 60_000; } };
}

const state = (db: import('node:sqlite').DatabaseSync, key: string) =>
  (db.prepare('SELECT value FROM v2_heartbeat_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;

test('no problem: one GET to the success address, with no body, and the beat written', async () => {
  const monitor = await fakeMonitor();
  const store = ledger();
  const addresses: MonitorAddresses = { ping: `${monitor.base}/ping`, fail: `${monitor.base}/fail`, refused: [] };
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: addresses, project: 'shop', now: () => NOW });
    const result = await beat.beat();
    assert.deepEqual(result, { problems: [], sent: 'ping' });
    assert.deepEqual(monitor.received, [{ method: 'GET', path: '/ping', body: '' }]);
    assert.equal(state(store.db, 'last_beat_at'), NOW.toISOString());
    assert.equal(state(store.db, 'last_beat_ok'), 'true');
    assert.equal(state(store.db, 'beat_every_ms'), '60000');
    assert.equal(state(store.db, 'monitor'), 'on');
    assert.deepEqual(events(store.db), []);
  } finally {
    store.close();
    await monitor.close();
  }
});

test('a problem: a POST of its code alone to the failure address, recorded once while it lasts', async () => {
  const monitor = await fakeMonitor();
  const store = ledger();
  const time = clock();
  const log: string[] = [];
  session(store.db, { id: 'session-secret-name', ticket: 'LOCAL-77', updatedAt: minutesBefore(200) });
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: { ping: `${monitor.base}/ping`, fail: `${monitor.base}/fail`, refused: [] }, project: 'shop', now: time.now, log: (line) => log.push(line) });
    const first = await beat.beat();
    assert.equal(first.sent, 'fail');
    assert.deepEqual(first.problems.map((p) => p.code), ['session_stalled']);
    assert.deepEqual(monitor.received, [{ method: 'POST', path: '/fail', body: 'Cleared health: blocked\nsession_stalled' }]);
    time.advance(1);
    await beat.beat();
    assert.equal(monitor.received.length, 2);
    assert.deepEqual(events(store.db, 'heartbeat_problem').map((e) => JSON.parse(e.detail ?? '{}')), [{ code: 'session_stalled', id: 'session-secret-name' }]);
    // It moves: the incident ends, and a new stall is a new incident.
    store.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(time.now().toISOString(), 'session-secret-name');
    time.advance(1);
    assert.equal((await beat.beat()).sent, 'ping');
    time.advance(121);
    await beat.beat();
    assert.equal(events(store.db, 'heartbeat_problem').length, 2);
    const left = monitor.received.map((r) => `${r.path} ${r.body}`).join('\n');
    for (const word of ['LOCAL-77', 'session-secret-name', 'shop']) assert.ok(!left.includes(word), `${word} left the host`);
    assert.deepEqual(log, []);
  } finally {
    store.close();
    await monitor.close();
  }
});

test('a problem and no failure address: nothing is sent, the monitor sees the success missing', async () => {
  const monitor = await fakeMonitor();
  const store = ledger();
  session(store.db, { id: 's1', ticket: 'LOCAL-1', updatedAt: minutesBefore(200) });
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: { ping: `${monitor.base}/ping`, fail: null, refused: [] }, project: 'shop', now: () => NOW });
    assert.equal((await beat.beat()).sent, null);
    assert.deepEqual(monitor.received, []);
    assert.equal(events(store.db, 'heartbeat_problem').length, 1);
  } finally {
    store.close();
    await monitor.close();
  }
});

test('no monitor: the beat is written, nothing is sent, and the state says off', async () => {
  const store = ledger();
  let calls = 0;
  const beat = new Heartbeat({ db: store.db, settings, monitor: { ping: null, fail: null, refused: [] }, project: null, now: () => NOW, fetch: async () => { calls += 1; return new Response('OK'); } });
  const result = await beat.beat();
  assert.equal(result.sent, null);
  assert.deepEqual(result.problems.map((p) => [p.code, p.level]), [['monitor_off', 'notice']]);
  assert.equal(calls, 0);
  assert.equal(state(store.db, 'monitor'), 'off');
  assert.deepEqual(events(store.db), [], 'a notice is not an incident');
  store.close();
});

test('a refused address file: the state names the variable, the beat goes on with the other address', async () => {
  const monitor = await fakeMonitor();
  const store = ledger();
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: { ping: null, fail: `${monitor.base}/fail`, refused: ['CLEARED_V2_HEARTBEAT_PING_URL_FILE'] }, project: 'shop', now: () => NOW });
    const result = await beat.beat();
    assert.deepEqual(result.problems.map((p) => p.code), ['monitor_invalid']);
    assert.equal(result.sent, 'fail');
    assert.deepEqual(monitor.received, [{ method: 'POST', path: '/fail', body: 'Cleared health: blocked\nmonitor_invalid' }]);
    assert.equal(state(store.db, 'monitor'), 'invalid');
    assert.equal(state(store.db, 'monitor_refused'), 'CLEARED_V2_HEARTBEAT_PING_URL_FILE');
  } finally {
    store.close();
    await monitor.close();
  }
});

test('the beat before this one came late: beat_late goes to the monitor', async () => {
  const monitor = await fakeMonitor();
  const store = ledger();
  const time = clock();
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: { ping: `${monitor.base}/ping`, fail: `${monitor.base}/fail`, refused: [] }, project: 'shop', now: time.now });
    await beat.beat();
    time.advance(5);
    const late = await beat.beat();
    assert.deepEqual(late.problems, [{ code: 'beat_late', id: 'beat', level: 'problem', values: { minutes: 5 } }]);
    assert.deepEqual(monitor.received.at(-1), { method: 'POST', path: '/fail', body: 'Cleared health: blocked\nbeat_late' });
    time.advance(1);
    assert.equal((await beat.beat()).sent, 'ping');
  } finally {
    store.close();
    await monitor.close();
  }
});

test('a ledger the beat cannot read: beat_failed, said to the monitor and kept in the state', async () => {
  const monitor = await fakeMonitor();
  const store = openStore(':memory:');
  applyTables(store.db, [...RUNS_TABLES, ...HEARTBEAT_TABLES]);
  store.db.exec('DROP TABLE sessions');
  const log: string[] = [];
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: { ping: `${monitor.base}/ping`, fail: `${monitor.base}/fail`, refused: [] }, project: 'shop', now: () => NOW, log: (line) => log.push(line) });
    const result = await beat.beat();
    assert.deepEqual(result.problems.map((p) => p.code), ['beat_failed']);
    assert.deepEqual(monitor.received, [{ method: 'POST', path: '/fail', body: 'Cleared health: blocked\nbeat_failed' }]);
    assert.equal(state(store.db, 'last_beat_ok'), 'false');
    assert.equal(log.length, 1);
    assert.match(log[0] ?? '', /^cleared-v2: the heartbeat could not read the ledger \(\w+\)$/);
  } finally {
    store.close();
    await monitor.close();
  }
});

test('a delivery that fails is one event an hour, with no address, and the beat goes on', async () => {
  const monitor = await fakeMonitor(500);
  const store = ledger();
  const time = clock();
  const log: string[] = [];
  const ping = `${monitor.base}/ping/check-7f3a`;
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: { ping, fail: null, refused: [] }, project: 'shop', now: time.now, log: (line) => log.push(line) });
    await beat.beat();
    time.advance(1);
    await beat.beat();
    assert.equal(events(store.db, 'heartbeat_delivery_failed').length, 1);
    time.advance(60);
    await beat.beat();
    assert.equal(events(store.db, 'heartbeat_delivery_failed').length, 2);
    await monitor.close();
    time.advance(61);
    await beat.beat();
    assert.equal(events(store.db, 'heartbeat_delivery_failed').length, 3, 'a monitor that does not answer is a failed delivery too');
    const written = JSON.stringify(store.db.prepare('SELECT * FROM events').all()) + JSON.stringify(store.db.prepare('SELECT * FROM v2_heartbeat_state').all()) + log.join('\n');
    assert.ok(!written.includes('check-7f3a') && !written.includes(monitor.base), 'the address is never written');
    assert.equal(state(store.db, 'last_beat_ok'), 'true', 'a failed delivery is not a failed beat');
  } finally {
    store.close();
    await monitor.close().catch(() => undefined);
  }
});

test('started, it beats at once and on its timer, and close awaits the beat that runs', async () => {
  const monitor = await fakeMonitor();
  const store = ledger();
  try {
    const beat = new Heartbeat({ db: store.db, settings, monitor: { ping: `${monitor.base}/ping`, fail: null, refused: [] }, project: 'shop' });
    beat.start(20);
    const end = Date.now() + 5000;
    while (monitor.received.length < 3) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await beat.close();
    const count = monitor.received.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(monitor.received.length, count, 'no beat after close');
  } finally {
    store.close();
    await monitor.close();
  }
});
