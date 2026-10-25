// What the ledger says of the service's health (docs/v2/milestone-4-plan.md,
// section 8.3), read on the real tables, read-only, and on a ledger whose
// modules' tables do not exist yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { HeartbeatSettings } from '../../src/heartbeat/settings.ts';
import { collectSnapshot } from '../../src/heartbeat/snapshot.ts';
import { openStore } from '../../src/store/db.ts';
import { tempDir } from '../workspace/git.ts';
import { NOW, beatRow, inboxItem, ledger, minutesBefore, quotaReading, session, trackerRead, train } from './support.ts';

const settings: HeartbeatSettings = { everyMs: 60_000, sessionMinutes: 120, trackerMinutes: 10, trackers: ['github'] };

test('the last beat and the monitor, as the service wrote them', () => {
  const store = ledger();
  assert.equal(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }).lastBeat, null);
  assert.equal(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }).monitor, null);
  beatRow(store.db, { at: minutesBefore(2), ok: false, everyMs: 30_000, monitor: 'invalid' });
  store.db.prepare("INSERT INTO v2_heartbeat_state (key, value) VALUES ('monitor_refused', 'CLEARED_V2_HEARTBEAT_FAIL_URL_FILE')").run();
  const snapshot = collectSnapshot(store.db, { settings, project: 'shop', now: NOW });
  assert.deepEqual(snapshot.lastBeat, { at: minutesBefore(2), ok: false, everyMs: 30_000 });
  assert.deepEqual(snapshot.monitor, { state: 'invalid', refused: ['CLEARED_V2_HEARTBEAT_FAIL_URL_FILE'] });
  store.close();
});

test('the live sessions of an author, a reviewer or a reader, each moved at its last event or its row\'s change', () => {
  const store = ledger();
  session(store.db, { id: 's1', ticket: 'LOCAL-1', updatedAt: minutesBefore(300), lastEventAt: minutesBefore(20) });
  session(store.db, { id: 's2', ticket: 'LOCAL-2', role: 'reviewer', status: 'reviewing', updatedAt: minutesBefore(200) });
  session(store.db, { id: 's3', ticket: 'LOCAL-3', status: 'stopped', updatedAt: minutesBefore(900) });
  session(store.db, { id: 's4', ticket: 'lead', role: 'lead', status: 'working', updatedAt: minutesBefore(900) });
  session(store.db, { id: 's5', ticket: 'LOCAL-5', role: 'reader', status: 'waiting_human', updatedAt: minutesBefore(5), lastEventAt: minutesBefore(50) });
  assert.deepEqual(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }).sessions, [
    { id: 's1', ticket: 'LOCAL-1', role: 'author', status: 'working', movedAt: minutesBefore(20) },
    { id: 's2', ticket: 'LOCAL-2', role: 'reviewer', status: 'reviewing', movedAt: minutesBefore(200) },
    { id: 's5', ticket: 'LOCAL-5', role: 'reader', status: 'waiting_human', movedAt: minutesBefore(5) },
  ]);
  store.close();
});

test('what waits for the owner: the count and the oldest item, the handled ones left out', () => {
  const store = ledger();
  inboxItem(store.db, { id: 'i1', ticket: 'LOCAL-1', kind: 'permission', since: minutesBefore(30) });
  inboxItem(store.db, { id: 'i2', ticket: 'LOCAL-2', kind: 'question', since: minutesBefore(90) });
  inboxItem(store.db, { id: 'i3', ticket: 'LOCAL-3', kind: 'question', since: minutesBefore(900), state: 'handled' });
  assert.deepEqual(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }).waiting,
    { count: 2, oldest: { ticket: 'LOCAL-2', kind: 'question', since: minutesBefore(90) } });
  store.close();
});

test('the mirrors the settings turn on, with their last full pass', () => {
  const store = ledger();
  trackerRead(store.db, 'github:example-org/shop', minutesBefore(3));
  trackerRead(store.db, 'linear:ENG', minutesBefore(4));
  assert.deepEqual(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }).trackers, [{ name: 'github:example-org/shop', readAt: minutesBefore(3) }]);
  assert.deepEqual(collectSnapshot(store.db, { settings: { ...settings, trackers: ['github', 'linear'] }, project: 'shop', now: NOW }).trackers.map((t) => t.name),
    ['github:example-org/shop', 'linear:ENG']);
  assert.deepEqual(collectSnapshot(store.db, { settings: { ...settings, trackers: [] }, project: 'shop', now: NOW }).trackers, []);
  store.close();
});

test('the trains not landed yet, the oldest first', () => {
  const store = ledger();
  train(store.db, { item: 't1', ticket: 'LOCAL-1', state: 'landing', updatedAt: minutesBefore(10) });
  train(store.db, { item: 't2', ticket: 'LOCAL-2', state: 'landed', updatedAt: minutesBefore(20) });
  train(store.db, { item: 't3', ticket: 'LOCAL-3', state: 'halted', updatedAt: minutesBefore(40) });
  train(store.db, { item: 't4', ticket: 'LOCAL-4', state: 'rolled_back', updatedAt: minutesBefore(50) });
  assert.deepEqual(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }).releases, [
    { ticket: 'LOCAL-3', state: 'halted', since: minutesBefore(40) },
    { ticket: 'LOCAL-1', state: 'landing', since: minutesBefore(10) },
  ]);
  store.close();
});

test('the subscription\'s windows, newest figure each, in percent; unknown without a project', () => {
  const store = ledger();
  quotaReading(store.db, { window: 'seven_day', usedPercent: 40, at: minutesBefore(120), resetsAt: minutesBefore(-3000) });
  quotaReading(store.db, { window: 'seven_day', usedPercent: 42.5, at: minutesBefore(10), resetsAt: minutesBefore(-3000) });
  quotaReading(store.db, { window: 'five_hour', usedPercent: 10, at: minutesBefore(10), resetsAt: minutesBefore(-100) });
  assert.deepEqual(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }).quota, [
    { window: 'five_hour', usedPercent: 10, resetsAt: minutesBefore(-100) },
    { window: 'seven_day', usedPercent: 42.5, resetsAt: minutesBefore(-3000) },
  ]);
  assert.equal(collectSnapshot(store.db, { settings, project: null, now: NOW }).quota, null);
  store.close();
});

test('a ledger whose modules\' tables do not exist yet reads as empty, not as an error', () => {
  const store = openStore(':memory:');
  assert.deepEqual(collectSnapshot(store.db, { settings, project: 'shop', now: NOW }), {
    lastBeat: null, monitor: null, sessions: [], waiting: { count: 0, oldest: null }, quota: [], trackers: [], releases: [],
  });
  store.close();
});

test('a ledger opened read-only is read the same', () => {
  const path = join(tempDir('beat-snapshot'), 'ledger.db');
  const store = ledger(path);
  beatRow(store.db, { at: minutesBefore(1) });
  inboxItem(store.db, { id: 'i1', ticket: 'LOCAL-1', kind: 'question', since: minutesBefore(30) });
  store.close();
  const db = new DatabaseSync(path, { readOnly: true });
  const snapshot = collectSnapshot(db, { settings, project: 'shop', now: NOW });
  assert.equal(snapshot.lastBeat?.at, minutesBefore(1));
  assert.equal(snapshot.waiting.count, 1);
  db.close();
});
