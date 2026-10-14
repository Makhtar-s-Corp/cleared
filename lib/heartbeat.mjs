#!/usr/bin/env node
// A local health snapshot and an optional push heartbeat. No model is used.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { expandHome, loadConf, ORCH_HOME, projectDir, runAsCommand, section, stateDir } from './conf.mjs';
import { addEvent, ledgerPath, openLedger } from './ledger.mjs';
import { AMBIENT, forgeGhEnv, forgeMode } from './forge.mjs';

const SCHEMA = `CREATE TABLE IF NOT EXISTS heartbeat_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heartbeat_incidents (
  id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL
);`;
const iso = (ms) => new Date(ms).toISOString();
const time = (value) => value ? Date.parse(value) : NaN;
const age = (value, now) => Number.isFinite(time(value)) ? Math.max(0, now - time(value)) : null;
const minutes = (value, key, fallback) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 10080) throw new Error(`[heartbeat] ${key} must be an integer from 1 to 10080`);
  return n;
};
export function heartbeatSettings(conf, { readUrls = true, urlKeys = ['ping_url', 'fail_url', 'quota_url'] } = {}) {
  const s = section(conf, 'heartbeat');
  const url = (key) => {
    if (!readUrls || !urlKeys.includes(key)) return '';
    if (s[key] && s[`${key}_file`]) throw new Error(`[heartbeat] use either ${key} or ${key}_file`);
    let value = s[key] || '';
    if (s[`${key}_file`]) {
      try {
        const path = expandHome(s[`${key}_file`]);
        const info = lstatSync(path);
        const target = realpathSync(path);
        const project = realpathSync(projectDir());
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
          || (info.mode & 0o077) !== 0 || target === project || target.startsWith(`${project}/`))
          throw new Error('unsafe file');
        value = readFileSync(path, 'utf8').trim();
      } catch { throw new Error(`[heartbeat] ${key}_file must be a private regular file outside the project, owned by this account`); }
    }
    if (value) {
      let parsed;
      try { parsed = new URL(value); } catch { throw new Error(`[heartbeat] ${key} must be an HTTP or HTTPS URL`); }
      if (parsed.username || parsed.password || (parsed.protocol !== 'https:'
        && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))))
        throw new Error(`[heartbeat] ${key} must use HTTPS, or HTTP on loopback`);
    }
    return value;
  };
  return {
    pingUrl: url('ping_url'), failUrl: url('fail_url'), quotaUrl: url('quota_url'),
    timeoutSecs: minutes(s.timeout_secs, 'timeout_secs', 10),
    wakeIntervalMinutes: minutes(s.wake_interval_minutes, 'wake_interval_minutes', 1),
    pendingMinutes: minutes(s.pending_minutes, 'pending_minutes', 30),
    serviceMinutes: minutes(s.service_minutes, 'service_minutes', 10),
    laneIdleMinutes: minutes(s.lane_idle_minutes, 'lane_idle_minutes', 120),
    orphanHours: minutes(s.orphan_hours, 'orphan_hours', 6),
  };
}
export function initHeartbeat(db) { db.exec(SCHEMA); }
function get(db, key) { initHeartbeat(db); return db.prepare('SELECT value FROM heartbeat_state WHERE key = ?').get(key)?.value ?? null; }
function put(db, key, value) {
  initHeartbeat(db);
  db.prepare('INSERT INTO heartbeat_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
const problem = (code, id, message) => ({ code, id, message });
export function diagnose(snapshot, settings, now = Date.now()) {
  const out = [];
  if (!snapshot.lastWake) out.push(problem('wake_missing', 'wake', 'No completed wake has been recorded.'));
  else if (age(snapshot.lastWake, now) > 3 * (snapshot.wakeIntervalMinutes || settings.wakeIntervalMinutes) * 60_000)
    out.push(problem('wake_late', 'wake', 'The last wake is overdue.'));
  if (snapshot.lastWake && snapshot.lastWakeOk === false)
    out.push(problem('wake_failed', 'wake', 'The last wake failed.'));
  if (snapshot.leadBusySince && age(snapshot.leadBusySince, now) > (snapshot.leadMaxMinutes || 20) * 60_000)
    out.push(problem('lead_stuck', 'lead', 'The project lead session has exceeded its configured time limit.'));
  if (snapshot.pendingSince && age(snapshot.pendingSince, now) > settings.pendingMinutes * 60_000
      && (!snapshot.lastAction || time(snapshot.lastAction) < time(snapshot.pendingSince)))
    out.push(problem('pending_stalled', 'pending', 'Tracker or forge changes have waited without an action.'));
  for (const [name, service] of Object.entries(snapshot.services || {})) {
    if (service.failedSince && age(service.failedSince, now) > settings.serviceMinutes * 60_000)
      out.push(problem('service_unreachable', name, `${name} has been unreachable for more than ${settings.serviceMinutes} minutes.`));
  }
  for (const lane of snapshot.lanes || []) {
    if (lane.active === false) continue;
    const newest = Math.max(time(lane.openedAt) || 0, time(lane.branchMovedAt) || 0, time(lane.ledgerMovedAt) || 0);
    if (newest && now - newest > settings.laneIdleMinutes * 60_000)
      out.push(problem('lane_idle', lane.name, `Lane ${lane.name} has not moved for more than ${settings.laneIdleMinutes} minutes.`));
  }
  for (const proc of snapshot.processes || []) {
    if (!proc.attached && age(proc.startedAt, now) > settings.orphanHours * 3_600_000)
      out.push(problem('orphan_process', `${proc.kind}:${proc.pid}`, `Cleared ${proc.kind} process ${proc.pid} is orphaned.`));
  }
  return out;
}
export function recordIncidents(db, problems, now = Date.now()) {
  initHeartbeat(db);
  const ids = new Set(problems.map((p) => `${p.code}:${p.id}`));
  for (const p of problems) {
    const id = `${p.code}:${p.id}`;
    const old = db.prepare('SELECT active FROM heartbeat_incidents WHERE id = ?').get(id);
    db.prepare(`INSERT INTO heartbeat_incidents(id,first_seen,last_seen,active) VALUES (?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, active = 1`).run(id, iso(now), iso(now));
    if (!old?.active) addEvent(db, { kind: 'heartbeat_problem', detail: id });
  }
  for (const row of db.prepare('SELECT id FROM heartbeat_incidents WHERE active = 1').all()) {
    if (!ids.has(row.id)) db.prepare('UPDATE heartbeat_incidents SET active = 0 WHERE id = ?').run(row.id);
  }
}
// Only stable problem codes leave the host. Names, paths, titles, response bodies,
// credentials and user content stay out of the heartbeat request.
export async function sendHeartbeat(db, settings, problems, wakeOk, { fetcher = fetch, now = Date.now() } = {}) {
  const failed = !wakeOk || problems.length > 0;
  const url = failed ? settings.failUrl : settings.pingUrl;
  if (!url) return;
  const body = failed ? `Cleared health: ${wakeOk ? 'blocked' : 'wake_failed'}\n${[...new Set(problems.map((p) => p.code))].join('\n')}` : undefined;
  try {
    const response = await fetcher(url, { method: body ? 'POST' : 'GET', body,
      signal: AbortSignal.timeout(settings.timeoutSecs * 1000) });
    if (!response.ok) throw new Error('heartbeat endpoint returned an error');
  } catch {
    const last = get(db, 'heartbeat_delivery_failed_at');
    if (!last || now - time(last) >= 3_600_000) {
      addEvent(db, { kind: 'heartbeat_delivery_failed', detail: 'Heartbeat endpoint could not be reached' });
      put(db, 'heartbeat_delivery_failed_at', iso(now));
    }
  }
}
const json = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const command = (file, args, cwd, timeout = 10_000, env = process.env) => {
  try { return execFileSync(file, args, { cwd, encoding: 'utf8', timeout, env, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
function processMatches(pid, kind) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return matchesClearedCommand(argv, kind);
  } catch { return false; }
}
export function matchesClearedCommand(argv, kind) {
  const interpreter = basename(argv[0] || '');
  if (kind === 'watch') return /^node(?:js)?$/.test(interpreter)
    && argv[1] === join(ORCH_HOME, 'lib', 'release.mjs') && argv[2] === 'watch';
  if (!['bash', 'sh'].includes(interpreter)) return false;
  return argv[1] === join(ORCH_HOME, kind === 'wait' ? 'when-free.sh' : 'lane-run.sh');
}
function processStartedAt(pid, now) {
  const output = command('ps', ['-o', 'etimes=', '-p', String(pid)], undefined, 2000);
  const seconds = Number(output);
  return output !== null && Number.isFinite(seconds) ? iso(now - seconds * 1000) : null;
}
function processOwned(pid, uid) { try { return statSync(`/proc/${pid}`).uid === uid; } catch { return false; } }
const dirEntries = (path) => { try { return readdirSync(path, { withFileTypes: true }); } catch { return []; } };
function runningProcesses(db, state, lanes, now) {
  const out = [];
  const serviceUid = Number(get(db, 'wake_uid') ?? process.getuid());
  for (const dir of dirEntries(join(state, 'runs'))) {
    if (!dir.isDirectory()) continue;
    const path = join(state, 'runs', dir.name, 'pid');
    const pid = Number(readFileSyncSafe(path));
    if (!Number.isInteger(pid) || !processOwned(pid, serviceUid) || !processMatches(pid, 'session')) continue;
    const run = db.prepare('SELECT lane, outcome FROM runs WHERE run_id LIKE ? ORDER BY started_at DESC LIMIT 1').get(`${dir.name}%`);
    let pidFileAt;
    try { pidFileAt = statSync(path).mtimeMs; } catch { continue; }
    const actualStart = processStartedAt(pid, now);
    if (!actualStart || Math.abs(time(actualStart) - pidFileAt) > 5000) continue;
    const startedAt = actualStart;
    out.push({ pid, kind: 'session', startedAt, attached: Boolean(run?.lane && lanes.some((l) => l.name === run.lane) && run.outcome === 'running'), verified: true });
  }
  try {
    for (const row of db.prepare("SELECT watch_pid, status FROM releases WHERE watch_pid IS NOT NULL").all()) {
      if (!processOwned(row.watch_pid, serviceUid) || !processMatches(row.watch_pid, 'watch')) continue;
      const path = `/proc/${row.watch_pid}`;
      out.push({ pid: row.watch_pid, kind: 'watch', startedAt: processStartedAt(row.watch_pid, now) || iso(statSync(path).ctimeMs),
        attached: ['watching', 'rolling_back', 'verifying_rollback'].includes(row.status), verified: true });
    }
  } catch { /* release tables are optional */ }
  const attachedSessions = new Set(out.filter((p) => p.kind === 'session' && p.attached).map((p) => p.pid));
  for (const proc of dirEntries('/proc')) {
    if (!proc.isDirectory() || !/^\d+$/.test(proc.name)) continue;
    const pid = Number(proc.name);
    if (!processMatches(pid, 'wait')) continue;
    if (!processOwned(pid, serviceUid)) continue;
    let ancestor = Number(command('ps', ['-o', 'ppid=', '-p', String(pid)], undefined, 2000));
    let attached = false;
    for (let depth = 0; ancestor > 1 && depth < 8; depth++) {
      if (attachedSessions.has(ancestor)) { attached = true; break; }
      ancestor = Number(command('ps', ['-o', 'ppid=', '-p', String(ancestor)], undefined, 2000));
    }
    out.push({ pid, kind: 'wait', startedAt: processStartedAt(pid, now), attached, verified: true });
  }
  return out;
}
function readFileSyncSafe(path) { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } }
function lanesOf(db, conf, repo) {
  const serviceHome = get(db, 'wake_home') || homedir();
  const configuredRoot = section(conf, 'lanes').root;
  const roles = new Set(Object.keys(conf.roles || {}));
  if (!configuredRoot || !roles.size) throw new Error('Cannot inspect lanes without [lanes] root and [roles]');
  const root = resolve(configuredRoot.replace(/^~\//, `${serviceHome}/`));
  // A human reaper runs through sudo. Trust this exact configured checkout for
  // read-only git inspection, then fail closed if it cannot be inspected.
  const git = (...args) => command('git', ['-c', `safe.directory=${resolve(repo)}`, ...args], repo);
  const output = git('worktree', 'list', '--porcelain');
  if (output === null) throw new Error('Cannot inspect project worktrees; no process can be reaped');
  const lanes = [];
  for (const record of output.split(/\n\n/)) {
    const path = record.match(/^worktree (.+)$/m)?.[1];
    const branch = record.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!path || !branch || branch.endsWith('/lead') || !path.startsWith(`${root}/`)
      || !roles.has(branch.split('/')[0])) continue;
    const branchMovedAt = git('log', '-1', '--format=%cI', branch);
    const recentRun = db.prepare('SELECT coalesce(ended_at, started_at) at, outcome FROM runs WHERE lane = ? ORDER BY started_at DESC LIMIT 1').get(branch);
    const ledgerMovedAt = recentRun?.at;
    let openedAt = null;
    try { openedAt = iso(statSync(path).birthtimeMs); } catch { /* removed between listing and inspection */ }
    lanes.push({ name: branch, path, openedAt, branchMovedAt, ledgerMovedAt, active: recentRun?.outcome === 'running' });
  }
  return lanes;
}
function pendingOf(state, now) {
  const recorded = readFileSyncSafe(join(state, 'wake', 'pending-action'));
  return Number.isFinite(time(recorded)) ? recorded : null;
}
export async function collectStatus(db, conf, { repo = projectDir(), state = stateDir(), now = Date.now(), probe = true,
  readUrls = true, urlKeys = ['ping_url', 'fail_url', 'quota_url'],
  fetcher = fetch, run = command } = {}) {
  initHeartbeat(db);
  const settings = heartbeatSettings(conf, { readUrls, urlKeys });
  const lastWake = get(db, 'last_wake_at');
  const lead = db.prepare("SELECT ended_at, started_at, outcome FROM runs WHERE role = ? ORDER BY started_at DESC LIMIT 1")
    .get(section(conf, 'lead').role || 'release');
  const currentLead = readFileSyncSafe(join(state, 'wake', 'current'));
  let leadBusySince = null;
  if (currentLead && !readFileSyncSafe(join(currentLead, 'exit-code'))) {
    try { leadBusySince = iso(statSync(join(state, 'wake', 'current')).mtimeMs); }
    catch { /* wake record disappeared */ }
  }
  const services = {};
  // Which identity the forge calls use (lib/forge.mjs): the app, by its login,
  // or the ambient credential. A configured app that cannot give a token is a
  // problem of its own: forge calls stop, they never take the ambient one.
  const forge = forgeMode(conf);
  let forgeFailure = forge.mode === 'error' ? `forge credential: ${forge.error}; forge calls stop, the ambient credential is not used` : null;
  const forgeIdentity = forge.mode === 'app' ? { kind: 'app', login: forge.login, commits: forge.identity ? 'app' : 'local git identity' }
    : forge.mode === 'ambient' ? { kind: 'ambient' } : { kind: 'error' };
  const probeNames = probe === true ? ['tracker', 'forge', 'quota'] : Array.isArray(probe) ? probe : [];
  if (probeNames.length) {
    const checks = { tracker: () => run(join(new URL('..', import.meta.url).pathname, 'tracker.sh'), ['waiting'], repo, settings.timeoutSecs * 1000) !== null,
      forge: () => {
        if (forge.mode === 'ambient') return run('gh', ['api', 'rate_limit', '--jq', '.resources.core.remaining'], repo, settings.timeoutSecs * 1000) !== null;
        if (forge.mode === 'error') return false;
        let env;
        try { env = forgeGhEnv(conf, { state }); }
        catch (error) { forgeFailure = error.message; return false; }
        // Only an installation token may list the installation's repositories: the calls are the app's.
        return run('gh', ['api', '/installation/repositories?per_page=1', '--jq', '.total_count'], repo, settings.timeoutSecs * 1000, env) !== null;
      } };
    if (settings.quotaUrl) checks.quota = async () => {
      try { return (await fetcher(settings.quotaUrl, { signal: AbortSignal.timeout(settings.timeoutSecs * 1000) })).ok; }
      catch { return false; }
    };
    for (const [name, check] of Object.entries(checks)) {
      if (!probeNames.includes(name)) continue;
      let ok = false;
      try { ok = Boolean(await check()); } catch { /* unreachable */ }
      const key = `service_${name}_failed_since`;
      if (ok) put(db, key, '');
      else if (!get(db, key)) put(db, key, iso(now));
      services[name] = { reachable: ok, failedSince: ok ? null : get(db, key) };
      if (name === 'tracker') services[name].adapter = section(conf, 'tracker').adapter || 'unconfigured';
    }
  }
  for (const name of ['tracker', 'forge', ...(settings.quotaUrl ? ['quota'] : [])]) {
    if (services[name]) continue;
    const failedSince = get(db, `service_${name}_failed_since`);
    services[name] = { reachable: !failedSince, failedSince };
    if (name === 'tracker') services[name].adapter = section(conf, 'tracker').adapter || 'unconfigured';
  }
  services.forge.identity = forgeIdentity;
  const lanes = lanesOf(db, conf, repo);
  const processes = runningProcesses(db, state, lanes, now);
  const lastAction = db.prepare("SELECT max(at) at FROM events WHERE kind IN ('wake_started','merged_by_script','rollback_pushed')").get()?.at;
  let watch = null;
  try { watch = db.prepare("SELECT ticket, title, merged_at, status FROM releases WHERE status IN ('watching','rolling_back','verifying_rollback') ORDER BY id DESC LIMIT 1").get(); }
  catch { /* release not enabled yet */ }
  if (watch) watch.minutesLeft = Math.max(0, Math.ceil((time(watch.merged_at) + Number(section(conf, 'release').watch_minutes || 15) * 60_000 - now) / 60_000));
  const snapshot = { lastWake, lastWakeOk: get(db, 'last_wake_ok') === 'true',
    trackerAdapter: section(conf, 'tracker').adapter || 'unconfigured',
    wakeIntervalMinutes: settings.wakeIntervalMinutes, lastLead: lead || null,
    leadBusySince, leadMaxMinutes: Number(section(conf, 'lead').max_minutes || 20),
    pendingSince: pendingOf(state, now), lastAction, services, lanes, processes, watches: watch ? [watch] : [] };
  const problems = diagnose(snapshot, settings, now);
  if (forgeFailure) problems.push(problem('forge_credential', 'forge', forgeFailure));
  if (!section(conf, 'security').agent_user) problems.push(problem('release_lock_unseparated', 'release', 'release lock is not a security boundary: agents run as the service account'));
  return { snapshot, problems, settings };
}
export function statusJson({ project, problems, snapshot }, now = Date.now()) {
  return { schema: 1, project, checkedAt: iso(now), ok: problems.length === 0,
    lastWake: snapshot.lastWake ? { at: snapshot.lastWake, ok: snapshot.lastWakeOk } : null,
    lastLead: snapshot.lastLead,
    services: snapshot.services, lanes: { open: snapshot.lanes.length, names: snapshot.lanes.map((l) => l.name) },
    waiting: Object.hasOwn(snapshot, 'waiting') ? snapshot.waiting : null,
    quota: Object.hasOwn(snapshot, 'quota') ? snapshot.quota : null, watching: snapshot.watches,
    problems };
}
function formatAge(value, now) {
  const ms = age(value, now);
  if (ms === null) return 'never';
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  return `${Math.floor(ms / 3_600_000)} h ago`;
}
export function renderStatus(result, now = Date.now()) {
  const { snapshot: s, problems, project, maxLanes = '?' } = result;
  const terminalText = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140);
  const lines = [`Cleared · project ${project}`,
    `Last wake        ${formatAge(s.lastWake, now)}        ${s.lastWake ? (s.lastWakeOk ? 'ok' : 'failed') : 'unknown'}`,
    `Last lead run    ${formatAge(s.lastLead?.ended_at || s.lastLead?.started_at, now)}        ${s.lastLead?.outcome || 'none'}`];
  const identity = (service) => !service.identity ? '' : service.identity.kind === 'app'
    ? ` · as ${terminalText(service.identity.login)}${service.identity.commits === 'app' ? '' : ' (commits keep the local git identity: set [forge] app_user_id)'}`
    : service.identity.kind === 'ambient' ? ` · ${AMBIENT}` : ' · credential not configured correctly';
  for (const [name, service] of Object.entries(s.services)) lines.push(`${(name === 'forge' ? 'Forge · GitHub' : name === 'tracker' ? `Tracker · ${terminalText(s.trackerAdapter)}` : 'Quota API').padEnd(16)} ${service.reachable ? 'reachable' : 'unreachable'}${name === 'forge' ? identity(service) : ''}`);
  lines.push(`Lanes open       ${s.lanes.length} / ${maxLanes}`);
  lines.push(`Waiting on you   ${s.waiting === null ? 'unknown' : `${s.waiting?.length || 0} ticket(s)${s.waiting?.[0] ? `        "${terminalText(s.waiting[0].title)}" (${terminalText(s.waiting[0].reason)})` : ''}`}`);
  lines.push(`Quota            ${s.quota === null ? 'unknown' : s.quota?.length ? s.quota.map((q) => `${q.adapter} ${q.used} % ${q.window}`).join(' · ') : 'no recent reading'}`);
  lines.push(`Watching         ${s.watches.length ? `release of ${terminalText(s.watches[0].ticket)}, ${s.watches[0].minutesLeft} min left` : 'none'}`);
  lines.push(`Problems         ${problems.length ? problems.map((p) => p.message).join('\n                 ') : 'none'}`);
  return lines.join('\n');
}
export const canReap = (actor, owner) => Boolean(owner && actor?.kind === 'human' && actor.id === owner);
export function localReapActor(conf, { effectiveUid = process.getuid?.(), sudoUid = process.env.SUDO_UID,
  sudoUser = process.env.SUDO_USER, serviceUid = null } = {}) {
  const tracker = section(conf, 'tracker');
  const explicitUid = section(conf, 'heartbeat').reap_owner_uid;
  if (explicitUid && !/^\d+$/.test(explicitUid)) throw new Error('[heartbeat] reap_owner_uid must be a numeric Unix UID');
  const separate = effectiveUid === 0 && sudoUid && sudoUser && serviceUid
    && String(sudoUid) !== serviceUid && String(sudoUid) !== tracker.agents_uid;
  if (explicitUid) return { kind: separate && String(sudoUid) === explicitUid ? 'human' : 'other', id: String(sudoUid || '') };
  return { kind: tracker.adapter === 'local' && tracker.owner_id === sudoUser && separate ? 'human' : 'other', id: sudoUser || '' };
}
export function reapOrphans(processes, { actor, owner, kill = (pid) => process.kill(pid, 'SIGTERM') }) {
  if (!canReap(actor, owner)) throw new Error('Only the verified human account can reap Cleared processes');
  const killed = [];
  for (const proc of processes) if (proc.orphan && proc.verified !== false) { kill(proc.pid); killed.push(proc.pid); }
  return killed;
}
async function main(args) {
  const [action, ...flags] = args;
  const reaping = action === 'status' && flags.includes('--reap');
  const db = reaping ? openLedger(ledgerPath(), { readOnly: true }) : openLedger();
  try {
    let conf;
    try { conf = loadConf(); }
    catch { if (!reaping) addEvent(db, { kind: 'heartbeat_diagnostic_failed', detail: 'Project configuration could not be read' }); throw new Error('Heartbeat project configuration could not be read'); }
    if (action === 'wake-end') {
      const ok = flags[0] === '0';
      const now = Date.now();
      const previousWake = get(db, 'last_wake_at');
      put(db, 'last_wake_at', iso(now)); put(db, 'last_wake_ok', String(ok));
      put(db, 'wake_uid', String(process.getuid?.() ?? ''));
      put(db, 'wake_home', homedir());
      put(db, 'wake_repo', resolve(projectDir()));
      let problems;
      try {
        if (ok) {
          put(db, 'service_tracker_failed_since', '');
          const down = readFileSyncSafe(join(stateDir(), 'wake', 'github-down')).split('\n')[0];
          if (down) { if (!get(db, 'service_forge_failed_since')) put(db, 'service_forge_failed_since', down); }
          else put(db, 'service_forge_failed_since', '');
        }
        const result = await collectStatus(db, conf, { now,
          probe: ok ? (heartbeatSettings(conf).quotaUrl ? ['quota'] : false) : true });
        problems = result.problems;
        if (previousWake && age(previousWake, now) > 3 * result.settings.wakeIntervalMinutes * 60_000)
          problems.push(problem('wake_late', 'wake', 'The previous wake was overdue.'));
        recordIncidents(db, problems, now);
      } catch (error) {
        console.error(`cleared: heartbeat diagnostic failed: ${error.message}`);
        problems = [problem('diagnostic_failed', 'status', 'The health diagnostic failed.')];
        addEvent(db, { kind: 'heartbeat_diagnostic_failed', detail: 'Health diagnostic failed' });
        recordIncidents(db, problems, now);
      }
      let deliverySettings;
      try { deliverySettings = heartbeatSettings(conf); }
      catch {
        const s = section(conf, 'heartbeat');
        deliverySettings = heartbeatSettings({ sections: { heartbeat: {
          fail_url: s.fail_url, fail_url_file: s.fail_url_file, timeout_secs: '10',
        } } }, { urlKeys: ['fail_url'] });
        problems = [problem('diagnostic_failed', 'status', 'The heartbeat configuration is invalid.')];
      }
      await sendHeartbeat(db, deliverySettings, problems, ok && !problems.some((p) => p.code === 'diagnostic_failed'), { now });
      return;
    }
    if (action !== 'status') throw new Error('usage: heartbeat.mjs wake-end <exit-code> | status [--json] [--reap]');
    if (reaping) {
      if (get(db, 'wake_repo') !== resolve(projectDir()))
        throw new Error('The shared state does not belong to this project; no process can be reaped');
      const serviceUid = get(db, 'wake_uid');
      const directoryOwner = String(statSync(stateDir()).uid);
      const ledgerOwner = String(statSync(ledgerPath()).uid);
      const passwdHome = command('getent', ['passwd', serviceUid], undefined, 2000)?.split(':')[5];
      if (!serviceUid || serviceUid !== directoryOwner || serviceUid !== ledgerOwner
        || !passwdHome || passwdHome !== get(db, 'wake_home'))
        throw new Error('The service account ownership could not be verified; no process can be reaped');
    }
    const now = Date.now();
    const result = await collectStatus(db, conf, { now, probe: !reaping, readUrls: !reaping,
      urlKeys: ['quota_url'] });
    const project = basename(projectDir());
    // Read-only tracker status: titles appear on the terminal only, never in the external heartbeat.
    const waiting = reaping ? null : command(join(new URL('..', import.meta.url).pathname, 'tracker.sh'), ['waiting'], projectDir());
    try { result.snapshot.waiting = waiting !== null ? JSON.parse(waiting).map((t) => ({ id: t.identifier || t.id, title: t.title, reason: 'approval' })) : null; }
    catch { result.snapshot.waiting = null; }
    const limits = reaping ? null : command(process.execPath, ['--no-warnings', new URL('./limits.mjs', import.meta.url).pathname, 'summary'], projectDir());
    try { result.snapshot.quota = limits !== null ? JSON.parse(limits).flatMap((q) => Object.entries(q.windows || {}).map(([window, v]) => ({ adapter: q.adapter, window, used: v.used }))) : null; }
    catch { result.snapshot.quota = null; }
    if (reaping) {
      // Root through sudo is required: only it can stop a different account's process.
      const owner = section(conf, 'heartbeat').reap_owner_uid
        || (section(conf, 'tracker').adapter === 'local' ? section(conf, 'tracker').owner_id : '');
      const actor = localReapActor(conf, { serviceUid: get(db, 'wake_uid') });
      if (!canReap(actor, owner) || process.env.CLEARED_AGENT_SESSION || process.env.ORCH_LANE) {
        throw new Error('Only the verified human account can use status --reap');
      }
      const orphans = result.snapshot.processes.filter((p) => !p.attached && age(p.startedAt, now) > result.settings.orphanHours * 3_600_000)
        .filter((p) => processOwned(p.pid, Number(get(db, 'wake_uid'))) && processMatches(p.pid, p.kind)
          && Math.abs(time(processStartedAt(p.pid, Date.now())) - time(p.startedAt)) < 5000)
        .map((p) => ({ ...p, orphan: true }));
      const killed = reapOrphans(orphans, { actor, owner });
      if (killed.length) console.error(`Cleared sent SIGTERM to ${killed.length} orphan process(es): ${killed.join(', ')}`);
      result.snapshot.processes = result.snapshot.processes.filter((p) => !killed.includes(p.pid));
      result.problems = diagnose(result.snapshot, result.settings, now);
    }
    const output = { project, snapshot: result.snapshot, problems: result.problems,
      maxLanes: section(conf, 'limits').max_lanes || '1' };
    console.log(flags.includes('--json') ? JSON.stringify(statusJson(output, now), null, 2) : renderStatus(output, now));
    if (result.problems.length) process.exitCode = 1;
  } finally { db.close(); }
}
if (runAsCommand(import.meta.url)) main(process.argv.slice(2)).catch((error) => {
  if (process.argv.includes('--json')) console.log(JSON.stringify({ schema: 1, project: basename(projectDir()),
    checkedAt: iso(Date.now()), ok: false, lastWake: null, lastLead: null, services: {},
    lanes: { open: 0, names: [] }, waiting: null, quota: null, watching: [],
    problems: [problem('status_error', 'status', 'Status could not be collected.')] }, null, 2));
  else console.error(`cleared: ${error.message}`);
  process.exitCode = 2;
});
