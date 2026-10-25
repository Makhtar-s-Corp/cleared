// The problems, case by case (docs/v2/milestone-4-plan.md, section 7.3):
// a pure function of what the ledger says, the settings and the time. The
// status sees the beat from outside (missing, late, the service silent);
// the service's own beat does not judge itself by its last row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, type Problem } from '../../src/heartbeat/beat.ts';
import type { HeartbeatSettings } from '../../src/heartbeat/settings.ts';
import type { Snapshot } from '../../src/heartbeat/snapshot.ts';
import { NOW, minutesBefore } from './support.ts';

const settings: HeartbeatSettings = { everyMs: 60_000, sessionMinutes: 120, trackerMinutes: 10, trackers: ['github'] };

const healthy: Snapshot = {
  lastBeat: { at: minutesBefore(1), ok: true, everyMs: 60_000 },
  monitor: { state: 'on', refused: [] },
  sessions: [{ id: 's1', ticket: 'LOCAL-3', role: 'author', status: 'working', movedAt: minutesBefore(5) }],
  waiting: { count: 0, oldest: null },
  quota: [],
  trackers: [{ name: 'github:example-org/shop', readAt: minutesBefore(2) }],
  releases: [],
};

const status = (snapshot: Partial<Snapshot>, reachable = true): Problem[] =>
  diagnose({ side: 'status', snapshot: { ...healthy, ...snapshot }, settings, now: NOW, health: { address: '127.0.0.1:8791', reachable } });
const codes = (problems: readonly Problem[]) => problems.map((p) => p.code);

test('a healthy service has no problem', () => {
  assert.deepEqual(status({}), []);
  assert.deepEqual(diagnose({ side: 'service', snapshot: healthy, settings, now: NOW }), []);
});

test('no beat recorded: beat_missing, from the status only', () => {
  assert.deepEqual(status({ lastBeat: null }), [{ code: 'beat_missing', id: 'beat', level: 'problem', values: {} }]);
  assert.deepEqual(diagnose({ side: 'service', snapshot: { ...healthy, lastBeat: null }, settings, now: NOW }), []);
});

test('a beat older than three of its intervals is late, the interval being the one the service beat at', () => {
  assert.deepEqual(status({ lastBeat: { at: minutesBefore(3), ok: true, everyMs: 60_000 } }), []);
  assert.deepEqual(status({ lastBeat: { at: minutesBefore(4), ok: true, everyMs: 60_000 } }), [{ code: 'beat_late', id: 'beat', level: 'problem', values: { minutes: 4 } }]);
  assert.deepEqual(status({ lastBeat: { at: minutesBefore(14), ok: true, everyMs: 300_000 } }), []);
  assert.deepEqual(codes(status({ lastBeat: { at: minutesBefore(16), ok: true, everyMs: 300_000 } })), ['beat_late']);
});

test('a beat that could not read the ledger: beat_failed', () => {
  assert.deepEqual(status({ lastBeat: { at: minutesBefore(1), ok: false, everyMs: 60_000 } }), [{ code: 'beat_failed', id: 'beat', level: 'problem', values: {} }]);
});

test('the service silent on its address: service_unreachable, from the status only', () => {
  assert.deepEqual(status({}, false), [{ code: 'service_unreachable', id: 'service', level: 'problem', values: { address: '127.0.0.1:8791' } }]);
});

test('a live session unmoved past the threshold: session_stalled, by its id', () => {
  const sessions = [
    { id: 's1', ticket: 'LOCAL-3', role: 'author', status: 'working', movedAt: minutesBefore(119) },
    { id: 's2', ticket: 'LOCAL-4', role: 'reviewer', status: 'reviewing', movedAt: minutesBefore(185) },
  ];
  const expected = [{ code: 'session_stalled', id: 's2', level: 'problem', values: { session: 's2', ticket: 'LOCAL-4', role: 'reviewer', minutes: 185 } }];
  assert.deepEqual(status({ sessions }), expected);
  assert.deepEqual(diagnose({ side: 'service', snapshot: { ...healthy, sessions }, settings, now: NOW }), expected);
});

test('a mirror with no full pass past the threshold: tracker_stale, by its tracker', () => {
  assert.deepEqual(status({ trackers: [{ name: 'github:example-org/shop', readAt: minutesBefore(9) }] }), []);
  assert.deepEqual(status({ trackers: [{ name: 'github:example-org/shop', readAt: minutesBefore(11) }] }),
    [{ code: 'tracker_stale', id: 'github:example-org/shop', level: 'problem', values: { tracker: 'github:example-org/shop', minutes: 11 } }]);
});

test('the monitor: refused is a problem, off a notice, unknown nothing', () => {
  assert.deepEqual(status({ monitor: { state: 'invalid', refused: ['CLEARED_V2_HEARTBEAT_FAIL_URL_FILE'] } }),
    [{ code: 'monitor_invalid', id: 'monitor', level: 'problem', values: { variables: 'CLEARED_V2_HEARTBEAT_FAIL_URL_FILE' } }]);
  assert.deepEqual(status({ monitor: { state: 'off', refused: [] } }), [{ code: 'monitor_off', id: 'monitor', level: 'notice', values: {} }]);
  assert.deepEqual(status({ monitor: null, lastBeat: null }), [{ code: 'beat_missing', id: 'beat', level: 'problem', values: {} }]);
});

test('what waits for the owner, the quota and the trains are said, never a problem', () => {
  assert.deepEqual(status({
    waiting: { count: 4, oldest: { ticket: 'LOCAL-1', kind: 'question', since: minutesBefore(600) } },
    quota: [{ window: 'seven_day', usedPercent: 97, resetsAt: minutesBefore(-600) }],
    releases: [{ ticket: 'LOCAL-2', state: 'halted', since: minutesBefore(300) }],
  }), []);
});

test('several problems come in a fixed order: the beat, the service, the monitor, the sessions, the trackers', () => {
  assert.deepEqual(codes(status({
    lastBeat: { at: minutesBefore(30), ok: false, everyMs: 60_000 },
    monitor: { state: 'invalid', refused: ['CLEARED_V2_HEARTBEAT_PING_URL_FILE'] },
    sessions: [{ id: 's9', ticket: 'LOCAL-9', role: 'reader', status: 'working', movedAt: minutesBefore(500) }],
    trackers: [{ name: 'linear:ENG', readAt: minutesBefore(60) }],
  }, false)), ['beat_late', 'beat_failed', 'service_unreachable', 'monitor_invalid', 'session_stalled', 'tracker_stale']);
});
