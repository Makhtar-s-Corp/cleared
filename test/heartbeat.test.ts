import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, chmodSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Conf } from '../lib/conf.ts';
import { openLedger } from '../lib/ledger.ts';
import { collectStatus, diagnose, initHeartbeat, recordIncidents, sendHeartbeat, heartbeatSettings, matchesClearedCommand, statusJson,
  canReap, localReapActor, reapOrphans } from '../lib/heartbeat.ts';
import { sandbox, scratch } from './support.ts';

// The lib's own types, which it does not export.
type Snapshot = Parameters<typeof statusJson>[0]['snapshot'];
type Problem = Parameters<typeof recordIncidents>[1][number];
type Proc = Parameters<typeof reapOrphans>[0][number];
// A snapshot as these tests write it: only the fields a check reads.
type Loose = Record<string, unknown>;

const conf = { sections: { heartbeat: {} } } as unknown as Conf;
const now = Date.parse('2026-10-12T12:00:00Z');
const base = (): Loose => ({ lastWake: new Date(now - 60_000).toISOString(), wakeIntervalMinutes: 1,
  pendingSince: null, lastAction: null, services: {}, lanes: [], processes: [], watches: [] });

test('one successful wake pings once; a failed wake calls the failure URL', async () => {
  const db = openLedger(':memory:');
  const urls: [string, string][] = [];
  const settings = heartbeatSettings({ sections: { heartbeat: { ping_url: 'https://example.invalid/ping', fail_url: 'https://example.invalid/fail' } } } as unknown as Conf);
  const fetcher = async (url: string, options: RequestInit) => { urls.push([url, options.body as string]); return { ok: true }; };
  await sendHeartbeat(db, settings, [], true, { fetcher, now });
  await sendHeartbeat(db, settings, [], false, { fetcher, now });
  assert.deepEqual(urls.map(([url]) => url), [settings.pingUrl, settings.failUrl]);
  db.close();
});

test('real wake exits call the success and failure URLs once each', async (t) => {
  const box = sandbox();
  const calls: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    request.resume(); response.writeHead(200); response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  appendFileSync(join(box.home, 'agents.conf'), `\n[heartbeat]\nping_url = http://127.0.0.1:${port}/ping\nfail_url = http://127.0.0.1:${port}/fail\n`);
  const wake = (env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(join(box.home, 'wake.ts'), [], { env: { ...box.env, ...env } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const healthy = await wake();
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.deepEqual(calls, ['/ping'], 'accepted shared-UID mode is a standing notice: the monitor stays green');
  const snapshot = JSON.parse(readFileSync(join(box.state, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.schema, 1);
  assert.ok(Array.isArray(snapshot.tickets) && snapshot.details);
  const db = openLedger(join(box.state, 'ledger.db'));
  db.prepare("UPDATE heartbeat_state SET value = ? WHERE key = 'last_wake_at'")
    .run(new Date(Date.now() - 5 * 60_000).toISOString());
  db.close();
  const late = await wake();
  assert.equal(late.code, 0, late.stderr);
  assert.deepEqual(calls, ['/ping', '/fail'], 'a live but delayed wake reports the stall');
  const failed = await wake({ FAKE_GH_LIST_DOWN: '1' });
  assert.notEqual(failed.code, 0);
  assert.deepEqual(calls, ['/ping', '/fail', '/fail']);
  appendFileSync(join(box.home, 'agents.conf'), '\n[heartbeat]\ntimeout_secs = 0\n');
  const misconfigured = await wake();
  assert.equal(misconfigured.code, 0);
  assert.deepEqual(calls, ['/ping', '/fail', '/fail', '/fail'], 'a bad timeout still calls the valid failure URL');
});

test('status JSON uses exit 2 and a stable error object when configuration is unreadable', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'agents.conf'), 'broken configuration\n');
  const result = spawnSync(process.execPath, [join(box.home, 'lib', 'heartbeat.ts'), 'status', '--json'],
    { env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema, 1);
  assert.equal(body.ok, false);
  assert.equal(body.problems[0].code, 'status_error');
});

test('an invalid heartbeat setting is visible in the ledger and service log', () => {
  const box = sandbox();
  appendFileSync(join(box.home, 'agents.conf'), '\n[heartbeat]\ntimeout_secs = 0\n');
  const result = spawnSync(join(box.home, 'wake.ts'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /timeout_secs/);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind = 'heartbeat_diagnostic_failed'").get()!.n, 1);
  db.close();
});

test('the status reaper refuses a process without a verified sudo human', () => {
  const box = sandbox();
  assert.equal(spawnSync(join(box.home, 'wake.ts'), [], { env: box.env, encoding: 'utf8' }).status, 0);
  const result = spawnSync(process.execPath, [join(box.home, 'lib', 'heartbeat.ts'), 'status', '--reap', '--json'],
    { env: { ...box.env, SUDO_UID: '1001', SUDO_USER: 'alice' }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).problems[0].code, 'status_error');
});

test('the reaper refuses a state directory from another project', () => {
  const box = sandbox();
  assert.equal(spawnSync(join(box.home, 'wake.ts'), [], { env: box.env, encoding: 'utf8' }).status, 0);
  const result = spawnSync(process.execPath, [join(box.home, 'lib', 'heartbeat.ts'), 'status', '--reap'],
    { env: { ...box.env, CLEARED_REPO: scratch('cleared-heartbeat-other-project-') }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /shared state does not belong/);
});

test('the reaper refuses a service UID altered in writable state', () => {
  const box = sandbox();
  assert.equal(spawnSync(join(box.home, 'wake.ts'), [], { env: box.env, encoding: 'utf8' }).status, 0);
  const db = openLedger(join(box.state, 'ledger.db'));
  db.prepare("UPDATE heartbeat_state SET value = '999999' WHERE key = 'wake_uid'").run();
  db.close();
  const result = spawnSync(process.execPath, [join(box.home, 'lib', 'heartbeat.ts'), 'status', '--reap'],
    { env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /service account ownership could not be verified/);
});

test('failed heartbeat does not throw and is logged at most once per hour', async () => {
  const db = openLedger(':memory:');
  const settings = heartbeatSettings({ sections: { heartbeat: { ping_url: 'https://example.invalid/ping' } } } as unknown as Conf);
  const fetcher = async () => { throw new Error('offline'); };
  await sendHeartbeat(db, settings, [], true, { fetcher, now });
  await sendHeartbeat(db, settings, [], true, { fetcher, now: now + 30_000 });
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind = 'heartbeat_delivery_failed'").get()!.n, 1);
  await sendHeartbeat(db, settings, [], true, { fetcher, now: now + 3_600_001 });
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind = 'heartbeat_delivery_failed'").get()!.n, 2);
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
  const problems = diagnose(snapshot as Partial<Snapshot>, heartbeatSettings(conf), now);
  assert.deepEqual([...new Set(problems.map((p) => p.code))].sort(),
    ['lane_idle', 'orphan_process', 'pending_stalled', 'service_unreachable', 'wake_late']);
  recordIncidents(db, problems, now);
  recordIncidents(db, problems, now + 60_000);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind = 'heartbeat_problem'").get()!.n, problems.length);
  const urls: [string, string][] = [];
  await sendHeartbeat(db, heartbeatSettings({ sections: { heartbeat: { ping_url: 'https://example.invalid/ping', fail_url: 'https://example.invalid/fail' } } } as unknown as Conf), problems, true,
    { fetcher: async (url: string, options: RequestInit) => { urls.push([url, options.body as string]); return { ok: true }; }, now });
  assert.equal(urls[0]![0], 'https://example.invalid/fail');
  assert.ok(urls[0]![1].includes('orphan_process'));
  assert.ok(!urls[0]![1].includes('dev/one'), 'external body does not expose lane or ticket text');
  const stable = statusJson({ project: 'example', problems, snapshot } as Parameters<typeof statusJson>[0], now);
  assert.deepEqual(Object.keys(stable), ['schema', 'project', 'checkedAt', 'ok', 'lastWake', 'lastLead',
    'services', 'lanes', 'waiting', 'quota', 'watching', 'problems', 'notices']);
  db.close();
});

test('heartbeat body contains neither configured URL secrets nor ticket content', async () => {
  const db = openLedger(':memory:');
  const bodies: unknown[] = [];
  const settings = heartbeatSettings({ sections: { heartbeat: {
    ping_url: 'https://example.invalid/success/secret-token', fail_url: 'https://example.invalid/failure/secret-token' } } } as unknown as Conf);
  await sendHeartbeat(db, settings, [{ code: 'pending_stalled', id: 'TICKET-17',
    message: 'Private ticket title and its content' }] as Problem[], true,
  { now, fetcher: async (_url: string, options: RequestInit) => { bodies.push(options.body); return { ok: true }; } });
  assert.deepEqual(bodies, ['Cleared health: blocked\npending_stalled']);
  db.close();
});

test('monitoring URLs can be stored outside the tracked project configuration', () => {
  const dir = scratch('cleared-heartbeat-secret-');
  const file = join(dir, 'ping-url');
  writeFileSync(file, 'https://example.invalid/ping/secret-token\n', { mode: 0o600 });
  const settings = heartbeatSettings({ sections: { heartbeat: { ping_url_file: file } } } as unknown as Conf);
  assert.equal(settings.pingUrl, 'https://example.invalid/ping/secret-token');
  assert.equal(heartbeatSettings({ sections: { heartbeat: { quota_url_file: file } } } as unknown as Conf).quotaUrl,
    'https://example.invalid/ping/secret-token');
  assert.throws(() => heartbeatSettings({ sections: { heartbeat: { ping_url_file: file,
    ping_url: 'https://example.invalid/other' } } } as unknown as Conf), /either ping_url or ping_url_file/);
  chmodSync(file, 0o644);
  assert.throws(() => heartbeatSettings({ sections: { heartbeat: { ping_url_file: file } } } as unknown as Conf), /private regular file/);
  chmodSync(file, 0o600);
  symlinkSync(file, join(dir, 'linked'));
  assert.throws(() => heartbeatSettings({ sections: { heartbeat: { ping_url_file: join(dir, 'linked') } } } as unknown as Conf), /private regular file/);
  assert.throws(() => heartbeatSettings({ sections: { heartbeat: { ping_url: 'http://example.invalid/ping' } } } as unknown as Conf), /HTTPS, or HTTP on loopback/);
});

test('a newly opened lane is not called idle because its base commit is old', () => {
  const snapshot = base();
  snapshot.lanes = [{ name: 'dev/one', openedAt: new Date(now - 60_000).toISOString(),
    branchMovedAt: new Date(now - 4 * 3600_000).toISOString(), ledgerMovedAt: null }];
  assert.equal(diagnose(snapshot as Partial<Snapshot>, heartbeatSettings(conf), now).some((p) => p.code === 'lane_idle'), false);
});

test('a lane waiting for approval is not called idle after its session ended', () => {
  const snapshot = base();
  snapshot.lanes = [{ name: 'dev/one', active: false,
    branchMovedAt: new Date(now - 4 * 3600_000).toISOString(), ledgerMovedAt: new Date(now - 4 * 3600_000).toISOString() }];
  assert.equal(diagnose(snapshot as Partial<Snapshot>, heartbeatSettings(conf), now).some((p) => p.code === 'lane_idle'), false);
});

test('a lead session past its time limit is reported despite successful wakes', () => {
  const snapshot = base();
  snapshot.leadBusySince = new Date(now - 21 * 60_000).toISOString();
  snapshot.leadMaxMinutes = 20;
  assert.equal(diagnose(snapshot as Partial<Snapshot>, heartbeatSettings(conf), now).some((p) => p.code === 'lead_stuck'), true);
});

test('reap is restricted to a verified local human and acts only on stale unattached Cleared processes', () => {
  const local = { sections: { tracker: { adapter: 'local', owner_id: 'alice', agents_uid: '1002' } } } as unknown as Conf;
  const remote = { sections: { tracker: { adapter: 'github' }, heartbeat: { reap_owner_uid: '1001' } } } as unknown as Conf;
  const sudo = { effectiveUid: 0, sudoUid: '1001', sudoUser: 'alice', serviceUid: '1002' };
  assert.equal(localReapActor(local, sudo).kind, 'human');
  assert.equal(localReapActor(local, { ...sudo, sudoUid: undefined }).kind, 'other');
  assert.equal(localReapActor(local, { ...sudo, effectiveUid: 1001 }).kind, 'other');
  assert.equal(localReapActor(local, { ...sudo, sudoUid: '1002' }).kind, 'other');
  assert.equal(localReapActor(local, { ...sudo, serviceUid: '1001' }).kind, 'other');
  assert.equal(localReapActor(remote, sudo).kind, 'human');
  assert.equal(localReapActor(remote, { ...sudo, sudoUid: '1002' }).kind, 'other');
  assert.equal(canReap({ kind: 'agents', id: 'bot' }, 'human'), false);
  assert.equal(canReap({ kind: 'human', id: 'human' }, 'human'), true);
  const killed: number[] = [];
  assert.throws(() => reapOrphans([{ pid: 10, orphan: true }] as Proc[], { actor: { kind: 'agents', id: 'bot' }, owner: 'human', kill: (pid) => killed.push(pid) }), /human/);
  reapOrphans([{ pid: 10, orphan: true }, { pid: 11, orphan: false }] as Proc[],
    { actor: { kind: 'human', id: 'human' }, owner: 'human', kill: (pid) => killed.push(pid) });
  assert.deepEqual(killed, [10]);
});

test('status fails closed if lane inventory cannot be inspected', async () => {
  const db = openLedger(':memory:');
  const directory = scratch('cleared-heartbeat-no-git-');
  await assert.rejects(collectStatus(db, { roles: { dev: 'a' }, sections: { lanes: { root: directory } } } as unknown as Conf,
    { repo: directory, state: directory, probe: false }), /Cannot inspect project worktrees/);
  db.close();
});

test('an editor viewing a Cleared script is not identified as an orphan process', () => {
  const script = new URL('../when-free.sh', import.meta.url).pathname;
  assert.equal(matchesClearedCommand(['/usr/bin/vim', script], 'wait'), false);
  assert.equal(matchesClearedCommand(['/usr/bin/bash', script], 'wait'), true);
});

const sharedUidMessage = 'release lock is not a security boundary: agents run as the service account';

test('accepted shared-UID mode is a standing notice: status stays ok, exit 0, the line is kept', () => {
  const box = sandbox(); // agents.conf sets [security] allow_shared_uid = true
  const db = openLedger(join(box.state, 'ledger.db'));
  initHeartbeat(db);
  db.prepare("INSERT OR REPLACE INTO heartbeat_state(key,value) VALUES ('last_wake_at', ?), ('last_wake_ok', 'true')")
    .run(new Date().toISOString());
  db.close();
  const result = spawnSync(process.execPath, [join(box.home, 'lib/heartbeat.ts'), 'status', '--json'],
    { env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.ok, true);
  const notice = status.notices.find((p: Problem) => p.message === sharedUidMessage);
  assert.equal(notice?.level, 'notice');
  assert.ok(status.problems.some((p: Problem) => p.code === 'release_lock_unseparated' && p.level === 'notice'));
  const text = spawnSync(process.execPath, [join(box.home, 'lib/heartbeat.ts'), 'status'], { env: box.env, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`Notice {11}${sharedUidMessage}`));
});

test('shared-UID mode without the explicit opt-in still fails the status', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[security]\nallow_shared_uid = true\n', '[security]\n'));
  const result = spawnSync(process.execPath, [join(box.home, 'lib/heartbeat.ts'), 'status', '--json'],
    { env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.ok, false);
  assert.equal(status.problems.find((p: Problem) => p.code === 'release_lock_unseparated')?.level, 'problem');
  assert.deepEqual(status.notices, []);
});

test('a notice keeps the monitor green; a failing problem still fails it, even in shared mode', async () => {
  const db = openLedger(':memory:');
  const urls: string[] = [];
  const settings = heartbeatSettings({ sections: { heartbeat: { ping_url: 'https://example.invalid/ping', fail_url: 'https://example.invalid/fail' } } } as unknown as Conf);
  const fetcher = async (url: string) => { urls.push(url); return { ok: true }; };
  const notice = { code: 'release_lock_unseparated', id: 'release', message: sharedUidMessage, level: 'notice' };
  const stall = { code: 'lane_idle', id: 'dev/one', message: 'idle', level: 'problem' };
  await sendHeartbeat(db, settings, [notice], true, { fetcher, now });
  await sendHeartbeat(db, settings, [notice, stall], true, { fetcher, now });
  assert.deepEqual(urls, [settings.pingUrl, settings.failUrl]);
  db.close();
});
