import test from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../lib/ledger.mjs';
import { diagnose, recordIncidents, sendHeartbeat, heartbeatSettings, statusJson,
  canReap, localReapActor, reapOrphans } from '../lib/heartbeat.mjs';

const conf = { sections: { heartbeat: {} } };
const now = Date.parse('2026-10-12T12:00:00Z');
const base = () => ({ lastWake: new Date(now - 60_000).toISOString(), wakeIntervalMinutes: 1,
  pendingSince: null, lastAction: null, services: {}, lanes: [], processes: [], watches: [] });

test('one successful wake pings once; a failed wake calls the failure URL', async () => {
  const db = openLedger(':memory:');
  const urls = [];
  const settings = heartbeatSettings({ sections: { heartbeat: { ping_url: 'https://example.invalid/ping', fail_url: 'https://example.invalid/fail' } } });
  const fetcher = async (url, options) => { urls.push([url, options.body]); return { ok: true }; };
  await sendHeartbeat(db, settings, [], true, { fetcher, now });
  await sendHeartbeat(db, settings, [], false, { fetcher, now });
  assert.deepEqual(urls.map(([url]) => url), [settings.pingUrl, settings.failUrl]);
  db.close();
});

test('failed heartbeat does not throw and is logged at most once per hour', async () => {
  const db = openLedger(':memory:');
  const settings = heartbeatSettings({ sections: { heartbeat: { ping_url: 'https://example.invalid/ping' } } });
  const fetcher = async () => { throw new Error('offline'); };
  await sendHeartbeat(db, settings, [], true, { fetcher, now });
  await sendHeartbeat(db, settings, [], true, { fetcher, now: now + 30_000 });
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind = 'heartbeat_delivery_failed'").get().n, 1);
  await sendHeartbeat(db, settings, [], true, { fetcher, now: now + 3_600_001 });
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind = 'heartbeat_delivery_failed'").get().n, 2);
  db.close();
});

test('all five silent stalls appear in status, trigger fail URL and log once per incident', async () => {
  const db = openLedger(':memory:');
  const snapshot = base();
  snapshot.lastWake = new Date(now - 4 * 60_000).toISOString();
  snapshot.pendingSince = new Date(now - 31 * 60_000).toISOString();
  snapshot.lastAction = new Date(now - 32 * 60_000).toISOString();
  snapshot.services = { tracker: { failedSince: new Date(now - 11 * 60_000).toISOString() },
    forge: { failedSince: new Date(now - 11 * 60_000).toISOString() },
    quota: { failedSince: new Date(now - 11 * 60_000).toISOString() } };
  snapshot.lanes = [{ name: 'dev/one', branchMovedAt: new Date(now - 121 * 60_000).toISOString(),
    ledgerMovedAt: new Date(now - 121 * 60_000).toISOString() }];
  snapshot.processes = [{ pid: 222, kind: 'session', startedAt: new Date(now - 7 * 3600_000).toISOString(), attached: false }];
  const problems = diagnose(snapshot, heartbeatSettings(conf), now);
  assert.deepEqual([...new Set(problems.map((p) => p.code))].sort(),
    ['lane_idle', 'orphan_process', 'pending_stalled', 'service_unreachable', 'wake_late']);
  recordIncidents(db, problems, now);
  recordIncidents(db, problems, now + 60_000);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind = 'heartbeat_problem'").get().n, problems.length);
  const urls = [];
  await sendHeartbeat(db, heartbeatSettings({ sections: { heartbeat: { ping_url: 'https://example.invalid/ping', fail_url: 'https://example.invalid/fail' } } }), problems, true,
    { fetcher: async (url, options) => { urls.push([url, options.body]); return { ok: true }; }, now });
  assert.equal(urls[0][0], 'https://example.invalid/fail');
  assert.ok(urls[0][1].includes('orphan_process'));
  assert.ok(!urls[0][1].includes('dev/one'), 'external body does not expose lane or ticket text');
  const stable = statusJson({ project: 'example', problems, snapshot }, now);
  assert.deepEqual(Object.keys(stable), ['schema', 'project', 'checkedAt', 'ok', 'lastWake', 'lastLead',
    'services', 'lanes', 'waiting', 'quota', 'watching', 'problems']);
  db.close();
});

test('heartbeat body contains neither configured URL secrets nor ticket content', async () => {
  const db = openLedger(':memory:');
  const bodies = [];
  const settings = heartbeatSettings({ sections: { heartbeat: {
    ping_url: 'https://example.invalid/success/secret-token', fail_url: 'https://example.invalid/failure/secret-token' } } });
  await sendHeartbeat(db, settings, [{ code: 'pending_stalled', id: 'TICKET-17',
    message: 'Private ticket title and its content' }], true,
  { now, fetcher: async (_url, options) => { bodies.push(options.body); return { ok: true }; } });
  assert.deepEqual(bodies, ['Cleared health: blocked\npending_stalled']);
  db.close();
});

test('a newly opened lane is not called idle because its base commit is old', () => {
  const snapshot = base();
  snapshot.lanes = [{ name: 'dev/one', openedAt: new Date(now - 60_000).toISOString(),
    branchMovedAt: new Date(now - 4 * 3600_000).toISOString(), ledgerMovedAt: null }];
  assert.equal(diagnose(snapshot, heartbeatSettings(conf), now).some((p) => p.code === 'lane_idle'), false);
});

test('reap is restricted to a verified local human and acts only on stale unattached Cleared processes', () => {
  assert.equal(localReapActor({ sections: { tracker: { adapter: 'local', owner_id: 'alice', agents_uid: '1002' } } }, 1001, 'alice').kind, 'human');
  assert.equal(localReapActor({ sections: { tracker: { adapter: 'local', owner_id: 'alice', agents_uid: '1002' } } }, 1002, 'alice').kind, 'other');
  assert.equal(localReapActor({ sections: { tracker: { adapter: 'github', owner_id: 'alice', agents_uid: '1002' } } }, 1001, 'alice').kind, 'other');
  assert.equal(canReap({ kind: 'agents', id: 'bot' }, 'human'), false);
  assert.equal(canReap({ kind: 'human', id: 'human' }, 'human'), true);
  const killed = [];
  assert.throws(() => reapOrphans([{ pid: 10, orphan: true }], { actor: { kind: 'agents', id: 'bot' }, owner: 'human', kill: (pid) => killed.push(pid) }), /human/);
  reapOrphans([{ pid: 10, orphan: true }, { pid: 11, orphan: false }],
    { actor: { kind: 'human', id: 'human' }, owner: 'human', kill: (pid) => killed.push(pid) });
  assert.deepEqual(killed, [10]);
});
