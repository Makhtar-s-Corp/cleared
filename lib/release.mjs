#!/usr/bin/env node
// Release monitoring and exact-merge rollback. The project deployment system
// observes pushes to the configured base branch; Cleared never deploys it.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadConf, projectDir, runAsCommand, stateDir } from './conf.mjs';
import { openLedger, addEvent } from './ledger.mjs';
import { createTracker } from './tracker/contract.mjs';
import { message } from './i18n.mjs';

const here = new URL('.', import.meta.url).pathname;
const now = () => new Date().toISOString();
const productMessage = (conf, key, values) => message(key, conf.sections?.owner?.language || 'en', values);
const minutes = (value, key, min = 0) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > 10080) throw new Error(`[release] ${key} must be an integer from ${min} to 10080`);
  return n;
};
export function releaseSettings(conf) {
  const s = conf.sections?.release || {};
  const watchMinutes = minutes(s.watch_minutes ?? '15', 'watch_minutes', 1);
  const deployGraceMinutes = minutes(s.deploy_grace_minutes ?? '5', 'deploy_grace_minutes');
  if (deployGraceMinutes >= watchMinutes) throw new Error('[release] deploy_grace_minutes must be less than watch_minutes');
  const failuresToRollback = minutes(s.failures_to_rollback ?? '3', 'failures_to_rollback', 1);
  const autoRollback = s.auto_rollback === 'true';
  if (s.auto_rollback && !['true', 'false'].includes(s.auto_rollback)) throw new Error('[release] auto_rollback must be true or false');
  if (s.health_url && !/^https?:\/\//.test(s.health_url)) throw new Error('[release] health_url must be HTTP or HTTPS');
  if (s.health_url && s.health_command) throw new Error('[release] use either health_url or health_command');
  if (autoRollback && !s.health_url && !s.health_command) throw new Error('[release] auto_rollback requires health_url or health_command');
  if (autoRollback && !s.reopen_state) throw new Error('[release] auto_rollback requires reopen_state');
  if (s.reopen_state && [conf.sections?.tracker?.go_state, conf.sections?.tracker?.done_state].includes(s.reopen_state))
    throw new Error('[release] reopen_state must not be the approval or done state');
  const reopenCandidates = ['todo_state', 'progress_state', 'review_state', 'validate_state']
    .map((key) => conf.sections?.tracker?.[key]).filter(Boolean);
  if (s.reopen_state && reopenCandidates.length && !reopenCandidates.includes(s.reopen_state))
    throw new Error('[release] reopen_state must be one of the configured non-approval tracker states');
  const migrationPaths = (s.migration_paths || '').split(',').map((p) => p.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
  if (migrationPaths.some((p) => p.startsWith('/') || p === '..' || p.startsWith('../') || p.includes('/../')))
    throw new Error('[release] migration_paths must stay inside the project');
  return { healthUrl: s.health_url || '', healthCommand: s.health_command || '', watchMinutes,
    deployGraceMinutes, failuresToRollback, autoRollback, reopenState: s.reopen_state || '',
    migrationPaths };
}
export const shouldRollback = (settings, failures) => settings.autoRollback && failures >= settings.failuresToRollback;
export const canAutoRollback = (settings, row, at = Date.now()) => Boolean(
  row?.status === 'watching' && shouldRollback(settings, row.failures)
  && row.last_health && row.last_health !== 'HTTP 200' && row.last_health !== 'exit 0'
  && at >= Date.parse(row.merged_at) + settings.deployGraceMinutes * 60000
  && at < Date.parse(row.merged_at) + settings.watchMinutes * 60000,
);
export const touchesMigrations = (files, paths) => files.some((file) => paths.some((path) => {
  const normalized = path.replace(/^\.\//, '').replace(/\/+$/, '').toLocaleLowerCase('en');
  const candidate = file.toLocaleLowerCase('en');
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}));
export const rollbackPreview = (row, files) => `Ticket: ${row.ticket} — ${row.title}\nMerge to revert: ${row.merge_sha}\nFiles:\n${files.map((f) => `  ${f}`).join('\n')}`;
export const confirmedRollback = (input, yes = false) => yes || input.trim() === 'rollback';

const schema = `CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, pr INTEGER NOT NULL,
  merge_sha TEXT NOT NULL UNIQUE, title TEXT NOT NULL, merged_at TEXT NOT NULL,
  status TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_health TEXT,
  rollback_sha TEXT, planned_rollback_sha TEXT, rollback_pushed_at TEXT, ended_at TEXT, notified_at TEXT,
  watch_pid INTEGER
);
CREATE INDEX IF NOT EXISTS releases_ticket ON releases(ticket, id);`;
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function retryFetch(action, pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return action(); }
    catch (error) { failure = error; if (attempt < 2) pause((attempt + 1) * 1000); }
  }
  throw new Error(`Git fetch failed after three attempts: ${failure.message}`);
}
const gh = (repo, ...args) => JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8' }));
const record = (db, kind, row, detail = '') => addEvent(db, { kind, ticket: row?.ticket, detail, value: row?.pr });
const baseName = (conf) => {
  const base = conf.sections?.lanes?.base;
  if (!base || !/^(?:origin\/)?[A-Za-z0-9._/-]+$/.test(base)) throw new Error('Missing or invalid [lanes] base');
  return base.replace(/^origin\//, '');
};
const paths = (repo, sha) => execFileSync('git', ['-C', repo, 'diff', '-z', '--name-only', '--no-renames', `${sha}^1`, sha])
  .toString('utf8').split('\0').filter(Boolean);
function ensureMerge(repo, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid merge commit');
  const parents = git(repo, 'rev-list', '--parents', '-n', '1', sha).split(' ');
  if (parents.length !== 3 || parents[0] !== sha) throw new Error(`${sha} is not a two-parent merge commit`);
}
function load(db, id) {
  const row = db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
  if (!row) throw new Error(`Unknown release ${id}`);
  return row;
}
export function activeRelease(db) {
  db.exec(schema);
  return db.prepare("SELECT * FROM releases WHERE status IN ('watching', 'rolling_back', 'verifying_rollback') ORDER BY id DESC LIMIT 1").get();
}
function setStatus(db, id, status, extra = {}) {
  db.prepare('UPDATE releases SET status = ?, failures = COALESCE(?, failures), last_health = COALESCE(?, last_health), rollback_sha = COALESCE(?, rollback_sha), ended_at = ? WHERE id = ?')
    .run(status, extra.failures ?? null, extra.lastHealth ?? null, extra.rollbackSha ?? null,
      ['watching', 'rolling_back', 'verifying_rollback'].includes(status) ? null : now(), id);
}
function deliverRollback(conf, db, row, { trackerFactory = createTracker, announce = notify } = {}) {
  if (row.notified_at) return;
  const tracker = trackerFactory(conf);
  try {
    const state = releaseSettings(conf).reopenState;
    if (tracker.getTicket?.(row.ticket)?.status !== state) tracker.moveTicket(row.ticket, state);
  } finally { tracker.close?.(); }
  announce(conf, row.ticket, productMessage(conf, 'rollback_done', {
    title: row.title, at: row.ended_at || now(), merge: row.merge_sha, revert: row.rollback_sha,
    reason: row.last_health || 'human request',
  }));
  db.prepare('UPDATE releases SET notified_at = ? WHERE id = ?').run(now(), row.id);
}
export function reconcileNotifications(conf, db, options = {}) {
  for (const row of db.prepare("SELECT * FROM releases WHERE status IN ('rolled_back', 'verifying_rollback') AND notified_at IS NULL ORDER BY id").all()) {
    try { deliverRollback(conf, db, row, options); }
    catch (error) { record(db, 'rollback_notification_failed', row, error.message); }
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function probe(settings, repo) {
  if (settings.healthUrl) {
    try {
      const response = await fetch(settings.healthUrl, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      return { ok: response.status === 200, detail: `HTTP ${response.status}` };
    } catch (error) { return { ok: false, detail: `health URL: ${error.message}` }; }
  }
  try {
    const output = execFileSync('sh', ['-c', settings.healthCommand], { cwd: repo, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, detail: output.trim().slice(0, 300) || 'exit 0' };
  } catch (error) { return { ok: false, detail: `health command exit ${error.status ?? 'timeout'}: ${String(error.stderr || '').slice(0, 300)}` }; }
}
async function verifyRollback(conf, db, repo, id, { wait, check, currentTime, announce }) {
  const row = load(db, id);
  if (row.status !== 'verifying_rollback') return;
  const readyAt = Date.parse(row.rollback_pushed_at || now()) + releaseSettings(conf).deployGraceMinutes * 60000;
  if (currentTime() < readyAt) await wait(readyAt - currentTime());
  const after = await check(releaseSettings(conf), repo);
  record(db, after.ok ? 'rollback_health_ok' : 'rollback_health_still_failing', row, after.detail);
  setStatus(db, id, 'rolled_back', { lastHealth: after.detail });
  if (!after.ok) alertOwner(conf, db, row, productMessage(conf, 'rollback_health_still_failing', { title: row.title, reason: after.detail }), announce);
}
function notify(conf, ticket, body) {
  const file = join(mkdtempSync(join(tmpdir(), 'cleared-release-message-')), 'message.md');
  try {
    writeFileSync(file, body);
    execFileSync(join(here, '..', 'tracker.sh'), ['comment', ticket, file, 'Cleared'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { rmSync(dirname(file), { recursive: true, force: true }); }
}
function alertOwner(conf, db, row, body, announce = notify) {
  try { announce(conf, row.ticket, body); }
  catch (error) {
    record(db, 'rollback_notification_failed', row, error.message);
    const outbox = join(stateDir(), 'tracker-outbox');
    mkdirSync(outbox, { recursive: true });
    const filename = `${row.ticket.replace(/[^A-Za-z0-9-]/g, '_')}--release-alert-${row.id}-${randomUUID().slice(0, 8)}.md`;
    const path = join(outbox, filename);
    writeFileSync(`${path}.part`, body);
    renameSync(`${path}.part`, path);
  }
}
function plan(conf, repo, row) {
  const base = baseName(conf);
  const remote = git(repo, 'remote', 'get-url', 'origin');
  retryFetch(() => git(repo, 'fetch', '--quiet', 'origin', base));
  const remoteHead = git(repo, 'rev-parse', `refs/remotes/origin/${base}`);
  ensureMerge(repo, row.merge_sha);
  git(repo, 'merge-base', '--is-ancestor', row.merge_sha, remoteHead);
  const files = paths(repo, row.merge_sha);
  return { base, remote, remoteHead, files, migrations: touchesMigrations(files, releaseSettings(conf).migrationPaths) };
}
export function rollbackRelease(conf, db, repo, row, { automatic = false, forceWithMigrations = false,
  trackerFactory = createTracker, announce = notify } = {}) {
  if (row.rollback_sha || row.status === 'rolled_back') throw new Error('This release was already rolled back');
  const p = plan(conf, repo, row);
  if (automatic && p.remoteHead !== row.merge_sha)
    throw new Error('The base changed after this release; automatic rollback is unsafe. Inspect the intervening commits manually');
  if (p.migrations && (automatic || !forceWithMigrations)) throw new Error('The merge touches declared migrations; automatic rollback is disabled. Manual rollback requires --force-with-migrations');
  if (!releaseSettings(conf).reopenState) throw new Error('Set [release] reopen_state before rollback; nothing was pushed');
  const temp = mkdtempSync(join(tmpdir(), 'cleared-rollback-'));
  record(db, 'rollback_started', row, `${row.merge_sha} at ${now()}`);
  setStatus(db, row.id, 'rolling_back');
  let pushed = false;
  try {
    git(temp, 'init', '-q');
    git(temp, 'remote', 'add', 'origin', p.remote);
    git(temp, 'fetch', '-q', 'origin', p.base);
    if (git(temp, 'rev-parse', 'FETCH_HEAD') !== p.remoteHead) throw new Error('The base moved before rollback; retry after inspecting the new commits');
    git(temp, 'checkout', '-q', '-B', `cleared-rollback-${row.id}`, 'FETCH_HEAD');
    git(temp, 'config', 'user.name', 'Cleared rollback');
    git(temp, 'config', 'user.email', 'cleared-rollback@localhost');
    try { git(temp, 'revert', '-m', '1', '--no-edit', row.merge_sha); }
    catch { throw new Error('Revert conflicts with changes merged since this release; nothing was pushed'); }
    git(temp, 'commit', '--amend', '-qm', `Revert merge ${row.merge_sha}\n\nCleared-Rollback-Release: ${row.id}\nCleared-Reverted-Merge: ${row.merge_sha}`);
    const sha = git(temp, 'rev-parse', 'HEAD');
    db.prepare('UPDATE releases SET planned_rollback_sha = ? WHERE id = ?').run(sha, row.id);
    try { git(temp, 'push', 'origin', `HEAD:refs/heads/${p.base}`); }
    catch { throw new Error('Push was rejected because the base moved or branch protection refused it; nothing was forced'); }
    pushed = true;
    const needsVerification = Boolean(releaseSettings(conf).healthUrl || releaseSettings(conf).healthCommand);
    setStatus(db, row.id, needsVerification ? 'verifying_rollback' : 'rolled_back', { rollbackSha: sha });
    db.prepare('UPDATE releases SET rollback_pushed_at = ? WHERE id = ?').run(now(), row.id);
    record(db, 'rollback_pushed', row, `${row.merge_sha} reverted by ${sha}`);
    try {
      deliverRollback(conf, db, load(db, row.id), { trackerFactory, announce });
    } catch (error) { record(db, 'rollback_notification_failed', row, error.message); }
    return sha;
  } catch (error) {
    if (!pushed && !db.prepare('SELECT rollback_sha FROM releases WHERE id = ?').get(row.id)?.rollback_sha) setStatus(db, row.id, 'failed');
    throw error;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export async function watchRelease(conf, db, repo, id, { wait = sleep, check = probe,
  currentTime = Date.now, announce = notify, performRollback } = {}) {
  const settings = releaseSettings(conf);
  let row = load(db, id);
  if (row.status === 'verifying_rollback') return verifyRollback(conf, db, repo, id, { wait, check, currentTime, announce });
  if (row.status !== 'watching') return;
  const start = Date.parse(row.merged_at);
  const end = start + settings.watchMinutes * 60000;
  const first = start + settings.deployGraceMinutes * 60000;
  if (currentTime() < first) await wait(first - currentTime());
  let warned = false;
  while (currentTime() < end && load(db, id).status === 'watching') {
    const result = await check(settings, repo);
    row = load(db, id);
    const failures = result.ok ? 0 : row.failures + 1;
    db.prepare('UPDATE releases SET failures = ?, last_health = ? WHERE id = ?').run(failures, result.detail, id);
    if (shouldRollback(settings, failures)) {
      row = load(db, id);
      const p = plan(conf, repo, row);
      if (p.remoteHead !== row.merge_sha) {
        record(db, 'rollback_ambiguous_base', row, `Base moved to ${p.remoteHead}; ${result.detail}`);
        alertOwner(conf, db, row, productMessage(conf, 'rollback_ambiguous_base', { title: row.title, head: p.remoteHead, reason: result.detail }), announce);
        setStatus(db, id, 'failed');
        return;
      }
      if (p.migrations) {
        record(db, 'rollback_migrations_blocked', row, `Migration paths touched: ${p.files.join(', ')}; ${result.detail}`);
        alertOwner(conf, db, row, productMessage(conf, 'rollback_migrations_blocked', { title: row.title, reason: result.detail }), announce);
        setStatus(db, id, 'failed');
        return;
      }
      if (performRollback) await performRollback(row);
      else {
        mkdirSync(stateDir(), { recursive: true });
        try {
          execFileSync('flock', ['-x', '-w', '120', join(stateDir(), 'merge.lock'), process.execPath,
            new URL(import.meta.url).pathname, 'auto', String(id)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          if (load(db, id).status === 'watching' && load(db, id).failures === 0) continue;
          throw new Error(`Rollback attempt failed: ${String(error.stderr || error.message).trim()}`);
        }
      }
      await verifyRollback(conf, db, repo, id, { wait, check, currentTime, announce });
      return;
    }
    if (!settings.autoRollback && failures >= settings.failuresToRollback && !warned) {
      warned = true;
      record(db, 'release_health_failing', row, result.detail);
      alertOwner(conf, db, row, productMessage(conf, 'release_health_failing', { title: row.title, reason: result.detail }), announce);
    }
    await wait(Math.min(30000, Math.max(0, end - currentTime())));
  }
  if (load(db, id).status === 'watching') {
    setStatus(db, id, 'complete');
    record(db, 'release_watch_complete', row, row.last_health || 'watch window ended');
  } else if (load(db, id).status === 'verifying_rollback') {
    await verifyRollback(conf, db, repo, id, { wait, check, currentTime, announce });
  }
}

function scheduleWatch(repo, id) {
  const executable = new URL(import.meta.url).pathname;
  const env = { ...process.env, CLEARED_REPO: repo, CLEARED_STATE_DIR: stateDir() };
  try {
    const args = ['--user', `--unit=cleared-release-watch-${id}`, '--collect',
      '--property=Restart=on-failure', '--property=RestartSec=10s',
      `--setenv=CLEARED_REPO=${repo}`, `--setenv=CLEARED_STATE_DIR=${stateDir()}`];
    if (process.env.CLEARED_CONF || process.env.ORCH_CONF) args.push(`--setenv=CLEARED_CONF=${process.env.CLEARED_CONF || process.env.ORCH_CONF}`);
    execFileSync('systemd-run', [...args, process.execPath, executable, 'watch', String(id)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    if (unitRunning(id)) return; // An existing transient unit may be activating.
    // Manual installations without a user systemd manager still get a watch.
    const child = spawn(process.execPath, [executable, 'watch', String(id)], {
      cwd: repo, env, detached: true, stdio: 'ignore' });
    child.unref();
  }
}
function unitRunning(id) {
  try {
    const state = execFileSync('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', `cleared-release-watch-${id}.service`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return state === 'active' || state === 'activating';
  } catch { return false; }
}
function watcherRunning(row) {
  if (unitRunning(row.id)) return true;
  if (!row.watch_pid) return false;
  try {
    const cmd = readFileSync(`/proc/${row.watch_pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    return cmd.includes('release.mjs') && cmd.includes(`watch ${row.id} `);
  } catch { return false; }
}
export function resumeWatches(conf, db, repo, { running = watcherRunning, schedule = scheduleWatch,
  announce = notify, lockAvailable = () => {
    try { execFileSync('flock', ['-n', join(stateDir(), 'merge.lock'), 'true'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  } } = {}) {
  for (const row of db.prepare("SELECT * FROM releases WHERE status IN ('watching','rolling_back','verifying_rollback') ORDER BY id").all()) {
    if (running(row)) continue;
    if (row.status === 'rolling_back') {
      if (!lockAvailable()) continue; // A revert process still holds the merge lock.
      try {
        const base = baseName(conf);
        git(repo, 'fetch', '-q', 'origin', base);
        const candidate = row.planned_rollback_sha;
        let pushed = false;
        if (candidate && /^[0-9a-f]{40}$/.test(candidate)) {
          try { git(repo, 'merge-base', '--is-ancestor', candidate, `origin/${base}`); pushed = true; }
          catch { /* the exact planned commit is absent */ }
        }
        const body = pushed ? git(repo, 'show', '-s', '--format=%B', candidate) : '';
        if (pushed && body.includes(`Cleared-Rollback-Release: ${row.id}`) && body.includes(`Cleared-Reverted-Merge: ${row.merge_sha}`)) {
          setStatus(db, row.id, 'verifying_rollback', { rollbackSha: candidate });
          db.prepare('UPDATE releases SET rollback_pushed_at = ? WHERE id = ?').run(now(), row.id);
          record(db, 'rollback_pushed', row, `Recovered pushed revert ${candidate}`);
        } else {
          setStatus(db, row.id, 'failed');
          record(db, 'rollback_failed', row, 'Rollback process ended before a revert was found on the base branch');
          alertOwner(conf, db, row, productMessage(conf, 'rollback_failed', { title: row.title, reason: 'the rollback process stopped before a pushed revert was found' }), announce);
          continue;
        }
      } catch (error) {
        record(db, 'release_watch_failed', row, `Rollback recovery: ${error.message}`);
        continue;
      }
    }
    if (row.status === 'watching' && Date.now() >= Date.parse(row.merged_at) + releaseSettings(conf).watchMinutes * 60000) {
      setStatus(db, row.id, 'failed');
      record(db, 'release_watch_failed', row, 'The monitor stopped and its watch window elapsed');
      alertOwner(conf, db, row, productMessage(conf, 'release_watch_failed', { title: row.title, reason: 'the monitor stopped before the watch window ended' }), announce);
      continue;
    }
    try { schedule(repo, row.id); }
    catch (error) { record(db, 'release_watch_failed', row, `Monitor restart: ${error.message}`); }
  }
  reconcileNotifications(conf, db, { announce });
}
export function startRelease(conf, db, repo, ticket, pr, { readPull = () =>
  gh(repo, 'pr', 'view', String(pr), '--json', 'number,title,mergeCommit,mergedAt'), schedule = scheduleWatch } = {}) {
  const settings = releaseSettings(conf);
  const mergedByCleared = db.prepare("SELECT 1 FROM events WHERE kind = 'merged_by_script' AND ticket = ? AND value = ? LIMIT 1").get(ticket, pr);
  if (!mergedByCleared) throw new Error(`PR #${pr} was not recorded as merged by Cleared for ${ticket}`);
  const pull = readPull();
  if (pull.number !== undefined && Number(pull.number) !== Number(pr)) throw new Error(`PR #${pr} metadata did not match the requested PR`);
  const sha = pull.mergeCommit?.oid;
  if (!sha || !pull.mergedAt) throw new Error(`PR #${pr} has no merge commit; monitoring cannot start`);
  retryFetch(() => git(repo, 'fetch', '-q', 'origin', baseName(conf)));
  ensureMerge(repo, sha);
  const existing = db.prepare('SELECT * FROM releases WHERE merge_sha = ?').get(sha);
  if (existing) {
    if (existing.ticket !== ticket || existing.pr !== pr) throw new Error('The merge commit is already recorded for another release');
    if (existing.status === 'watching' && !watcherRunning(existing)) schedule(repo, existing.id);
    return;
  }
  if (activeRelease(db)) throw new Error('Another release is already being monitored');
  db.prepare('INSERT INTO releases(ticket,pr,merge_sha,title,merged_at,status) VALUES (?,?,?,?,?,?)')
    .run(ticket, pr, sha, pull.title, pull.mergedAt, settings.healthUrl || settings.healthCommand ? 'watching' : 'complete');
  const row = db.prepare('SELECT * FROM releases WHERE merge_sha = ?').get(sha);
  if (!settings.healthUrl && !settings.healthCommand) { record(db, 'release_health_unconfigured', row, 'No [release] health_url or health_command'); return; }
  schedule(repo, row.id);
}

async function main([command, ...args]) {
  const conf = loadConf();
  const lockEnabled = Boolean(conf.sections.security?.agent_user || conf.sections.security?.allow_shared_uid === 'true');
  const lockMessage = 'Release lock requires [security] agent_user; create a separate agent account and run serve/install.sh, or explicitly set [security] allow_shared_uid = true';
  const repo = projectDir();
  const db = openLedger();
  db.exec(schema);
  try {
    if (command === 'check') { releaseSettings(conf); return; }
    if (command === 'reconcile') return resumeWatches(conf, db, repo);
    if (command === 'active') { if (activeRelease(db)) process.exitCode = 3; return; }
    if (command === 'start') return startRelease(conf, db, repo, args[0], Number(args[1]));
    if (command === 'watch') {
      if (!lockEnabled) {
        conf.sections.release ||= {};
        conf.sections.release.auto_rollback = 'false';
      }
      db.prepare('UPDATE releases SET watch_pid = ? WHERE id = ?').run(process.pid, Number(args[0]));
      try { return await watchRelease(conf, db, repo, Number(args[0])); }
      catch (error) {
        const row = load(db, Number(args[0]));
        if (row.status === 'watching' || (row.status === 'rolling_back' && !row.planned_rollback_sha)) setStatus(db, row.id, 'failed');
        const rollbackError = error.message.startsWith('Rollback attempt failed:');
        record(db, rollbackError ? 'rollback_failed' : 'release_watch_failed', row, error.message);
        alertOwner(conf, db, row, productMessage(conf, rollbackError ? 'rollback_failed' : 'release_watch_failed', { title: row.title, reason: error.message }));
        throw error;
      } finally {
        db.prepare('UPDATE releases SET watch_pid = NULL WHERE id = ? AND watch_pid = ?').run(Number(args[0]), process.pid);
      }
    }
    if (command === 'auto') {
      if (!lockEnabled) throw new Error(lockMessage);
      const row = load(db, Number(args[0]));
      if (!canAutoRollback(releaseSettings(conf), row)) {
        record(db, 'rollback_refused', row, 'Automatic rollback gate is not satisfied');
        throw new Error('Automatic rollback requires a watching release with enough consecutive failed health checks');
      }
      const fresh = await probe(releaseSettings(conf), repo);
      if (fresh.ok) {
        db.prepare('UPDATE releases SET failures = 0, last_health = ? WHERE id = ?').run(fresh.detail, row.id);
        record(db, 'rollback_refused', row, 'A fresh health check passed');
        throw new Error('Fresh health check passed; rollback refused');
      }
      console.log(rollbackRelease(conf, db, repo, row, { automatic: true }));
      return;
    }
    if (command === 'rollback') {
      if (!lockEnabled) throw new Error(lockMessage);
      if (process.getuid() !== statSync(fileURLToPath(import.meta.url)).uid) throw new Error('Only the service account can execute a manual rollback');
      if (!process.env.ORCH_BROKER_SECRET || process.env.ORCH_BROKER_SECRET !== readFileSync(join(stateDir(), 'release-broker.secret'), 'utf8')) throw new Error('Only the release broker can execute a manual rollback');
      const [ticket, ...flags] = args;
      const usage = 'usage: cleared rollback <ticket> [--yes] [--force-with-migrations]';
      if (!ticket) throw new Error(usage);
      for (let i = 0; i < flags.length; i++) {
        if (!['--yes', '--force-with-migrations'].includes(flags[i])) throw new Error(usage);
      }
      const row = db.prepare('SELECT * FROM releases WHERE ticket = ? ORDER BY id DESC LIMIT 1').get(ticket);
      if (!row) throw new Error(`No Cleared release recorded for ${ticket}`);
      if (row.rollback_sha) throw new Error('This release was already rolled back');
      const p = plan(conf, repo, row);
      console.log(rollbackPreview(row, p.files));
      if (p.migrations && !flags.includes('--force-with-migrations')) throw new Error('This merge touches declared migrations; add --force-with-migrations after reviewing database effects');
      if (!flags.includes('--yes')) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        let input;
        try { input = await prompt.question('Type "rollback" to confirm: '); }
        finally { prompt.close(); }
        if (!confirmedRollback(input)) throw new Error('Rollback cancelled');
      }
      const sha = rollbackRelease(conf, db, repo, row, { forceWithMigrations: flags.includes('--force-with-migrations') });
      if (load(db, row.id).status === 'verifying_rollback' && !watcherRunning(load(db, row.id))) scheduleWatch(repo, row.id);
      console.log(`Pushed revert ${sha}`);
      return;
    }
    throw new Error('usage: release.mjs active | start TICKET PR | watch ID | rollback TICKET [--yes] [--force-with-migrations]');
  } finally { db.close(); }
}

if (runAsCommand(import.meta.url)) main(process.argv.slice(2)).catch((error) => {
  console.error(`release: ${error.message}`);
  process.exitCode ||= 1;
});
