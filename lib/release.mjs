#!/usr/bin/env node
// Release monitoring and exact-merge rollback. The project deployment system
// observes pushes to the configured base branch; Cleared never deploys it.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  return { healthUrl: s.health_url || '', healthCommand: s.health_command || '', watchMinutes,
    deployGraceMinutes, failuresToRollback, autoRollback, reopenState: s.reopen_state || '',
    migrationPaths: (s.migration_paths || '').split(',').map((p) => p.trim()).filter(Boolean) };
}
export const shouldRollback = (settings, failures) => settings.autoRollback && failures >= settings.failuresToRollback;
export const canAutoRollback = (settings, row, at = Date.now()) => Boolean(
  row?.status === 'watching' && shouldRollback(settings, row.failures)
  && row.last_health && row.last_health !== 'HTTP 200' && row.last_health !== 'exit 0'
  && at >= Date.parse(row.merged_at) + settings.deployGraceMinutes * 60000
  && at < Date.parse(row.merged_at) + settings.watchMinutes * 60000,
);
export const canHumanRollback = (actor, owner) => Boolean(owner && actor?.kind === 'human' && actor.id === owner);
export const touchesMigrations = (files, paths) => files.some((file) => paths.some((path) =>
  path.endsWith('/') ? file.startsWith(path) : file === path));
export const rollbackPreview = (row, files) => `Ticket: ${row.ticket} — ${row.title}\nMerge to revert: ${row.merge_sha}\nFiles:\n${files.map((f) => `  ${f}`).join('\n')}`;
export const confirmedRollback = (input, yes = false) => yes || input.trim() === 'rollback';

const schema = `CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, pr INTEGER NOT NULL,
  merge_sha TEXT NOT NULL UNIQUE, title TEXT NOT NULL, merged_at TEXT NOT NULL,
  status TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_health TEXT,
  rollback_sha TEXT, ended_at TEXT
  , notified_at TEXT
);
CREATE INDEX IF NOT EXISTS releases_ticket ON releases(ticket, id);`;
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gh = (repo, ...args) => JSON.parse(execFileSync('gh', args, { cwd: repo, encoding: 'utf8' }));
const record = (db, kind, row, detail = '') => addEvent(db, { kind, ticket: row?.ticket, detail, value: row?.pr });
const baseName = (conf) => {
  const base = conf.sections?.lanes?.base;
  if (!base || !/^(?:origin\/)?[A-Za-z0-9._/-]+$/.test(base)) throw new Error('Missing or invalid [lanes] base');
  return base.replace(/^origin\//, '');
};
const paths = (repo, sha) => git(repo, 'diff', '--name-only', '--no-renames', `${sha}^1`, sha).split('\n').filter(Boolean);
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
  return db.prepare("SELECT * FROM releases WHERE status IN ('watching', 'rolling_back') ORDER BY id DESC LIMIT 1").get();
}
function setStatus(db, id, status, extra = {}) {
  db.prepare('UPDATE releases SET status = ?, failures = COALESCE(?, failures), last_health = COALESCE(?, last_health), rollback_sha = COALESCE(?, rollback_sha), ended_at = ? WHERE id = ?')
    .run(status, extra.failures ?? null, extra.lastHealth ?? null, extra.rollbackSha ?? null, ['watching', 'rolling_back'].includes(status) ? null : now(), id);
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
  for (const row of db.prepare("SELECT * FROM releases WHERE status = 'rolled_back' AND notified_at IS NULL ORDER BY id").all()) {
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
function notify(conf, ticket, body) {
  const file = join(mkdtempSync(join(tmpdir(), 'cleared-release-message-')), 'message.md');
  try {
    writeFileSync(file, body);
    execFileSync(join(here, '..', 'tracker.sh'), ['comment', ticket, file, 'Cleared'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { rmSync(dirname(file), { recursive: true, force: true }); }
}
function verifier(conf, tracker, row, commentId) {
  const owner = conf.sections?.tracker?.owner_id;
  if (canHumanRollback(tracker.whoAmI(), owner)) return owner;
  if (commentId && owner) {
    const comment = tracker.comments(row.ticket).find((item) => String(item.id) === String(commentId));
    if (comment?.by?.kind === 'human' && comment.by.id === owner
      && comment.body.trim() === `Rollback ${row.ticket} ${row.merge_sha}`
      && Date.parse(comment.createdAt) > Date.parse(row.merged_at)) return owner;
  }
  return null;
}
export function authorizeManualRollback(conf, db, tracker, row, commentId) {
  const approver = verifier(conf, tracker, row, commentId);
  if (!approver) {
    record(db, 'rollback_refused', row, 'Unverified human identity');
    throw new Error('Only the verified human owner can request rollback');
  }
  return approver;
}
function plan(conf, repo, row) {
  const base = baseName(conf);
  const remote = git(repo, 'remote', 'get-url', 'origin');
  git(repo, 'fetch', '--quiet', 'origin', base);
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
  if (p.migrations && (automatic || !forceWithMigrations)) throw new Error('The merge touches declared migrations; automatic rollback is disabled. Manual rollback requires --force-with-migrations');
  if (!releaseSettings(conf).reopenState) throw new Error('Set [release] reopen_state before rollback; nothing was pushed');
  const temp = mkdtempSync(join(tmpdir(), 'cleared-rollback-'));
  record(db, 'rollback_started', row, `${row.merge_sha} at ${now()}`);
  setStatus(db, row.id, 'rolling_back');
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
    const sha = git(temp, 'rev-parse', 'HEAD');
    try { git(temp, 'push', 'origin', `HEAD:refs/heads/${p.base}`); }
    catch { throw new Error('Push was rejected because the base moved or branch protection refused it; nothing was forced'); }
    setStatus(db, row.id, 'rolled_back', { rollbackSha: sha });
    record(db, 'rollback_pushed', row, `${row.merge_sha} reverted by ${sha}`);
    try {
      deliverRollback(conf, db, load(db, row.id), { trackerFactory, announce });
    } catch (error) { record(db, 'rollback_notification_failed', row, error.message); }
    return sha;
  } catch (error) {
    if (!db.prepare('SELECT rollback_sha FROM releases WHERE id = ?').get(row.id)?.rollback_sha) setStatus(db, row.id, 'failed');
    throw error;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export async function watchRelease(conf, db, repo, id, { wait = sleep, check = probe,
  currentTime = Date.now, announce = notify, performRollback } = {}) {
  const settings = releaseSettings(conf);
  let row = load(db, id);
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
      if (p.migrations) {
        record(db, 'rollback_migrations_blocked', row, `Migration paths touched: ${p.files.join(', ')}; ${result.detail}`);
        announce(conf, row.ticket, productMessage(conf, 'rollback_migrations_blocked', { title: row.title, reason: result.detail }));
        setStatus(db, id, 'failed');
        return;
      }
      if (performRollback) await performRollback(row);
      else {
        mkdirSync(stateDir(), { recursive: true });
        execFileSync('flock', ['-x', join(stateDir(), 'merge.lock'), process.execPath,
          new URL(import.meta.url).pathname, 'auto', String(id)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      }
      await wait(settings.deployGraceMinutes * 60000);
      const after = await check(settings, repo);
      record(db, after.ok ? 'rollback_health_ok' : 'rollback_health_still_failing', row, after.detail);
      if (!after.ok) announce(conf, row.ticket, productMessage(conf, 'rollback_health_still_failing', { title: row.title, reason: after.detail }));
      return;
    }
    if (!settings.autoRollback && failures >= settings.failuresToRollback && !warned) {
      warned = true;
      record(db, 'release_health_failing', row, result.detail);
      announce(conf, row.ticket, productMessage(conf, 'release_health_failing', { title: row.title, reason: result.detail }));
    }
    await wait(Math.min(30000, Math.max(0, end - currentTime())));
  }
  if (load(db, id).status === 'watching') {
    setStatus(db, id, 'complete');
    record(db, 'release_watch_complete', row, row.last_health || 'watch window ended');
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
    // Manual installations without a user systemd manager still get a watch.
    const child = spawn(process.execPath, [executable, 'watch', String(id)], {
      cwd: repo, env, detached: true, stdio: 'ignore' });
    child.unref();
  }
}
export function startRelease(conf, db, repo, ticket, pr, { readPull = () =>
  gh(repo, 'pr', 'view', String(pr), '--json', 'number,title,mergeCommit,mergedAt'), schedule = scheduleWatch } = {}) {
  const settings = releaseSettings(conf);
  const mergedByCleared = db.prepare("SELECT 1 FROM events WHERE kind = 'merged_by_script' AND ticket = ? AND value = ? LIMIT 1").get(ticket, pr);
  if (!mergedByCleared) throw new Error(`PR #${pr} was not recorded as merged by Cleared for ${ticket}`);
  const pull = readPull();
  const sha = pull.mergeCommit?.oid;
  if (!sha || !pull.mergedAt) throw new Error(`PR #${pr} has no merge commit; monitoring cannot start`);
  git(repo, 'fetch', '-q', 'origin', baseName(conf));
  ensureMerge(repo, sha);
  if (activeRelease(db)) throw new Error('Another release is already being monitored');
  db.prepare('INSERT INTO releases(ticket,pr,merge_sha,title,merged_at,status) VALUES (?,?,?,?,?,?)')
    .run(ticket, pr, sha, pull.title, pull.mergedAt, settings.healthUrl || settings.healthCommand ? 'watching' : 'complete');
  const row = db.prepare('SELECT * FROM releases WHERE merge_sha = ?').get(sha);
  if (!settings.healthUrl && !settings.healthCommand) { record(db, 'release_health_unconfigured', row, 'No [release] health_url or health_command'); return; }
  schedule(repo, row.id);
}

async function main([command, ...args]) {
  const conf = loadConf();
  const repo = projectDir();
  const db = openLedger();
  db.exec(schema);
  try {
    if (command === 'check') { releaseSettings(conf); return; }
    if (command === 'reconcile') return reconcileNotifications(conf, db);
    if (command === 'active') { if (activeRelease(db)) process.exitCode = 3; return; }
    if (command === 'start') return startRelease(conf, db, repo, args[0], Number(args[1]));
    if (command === 'watch') {
      try { return await watchRelease(conf, db, repo, Number(args[0])); }
      catch (error) {
        const row = load(db, Number(args[0]));
        if (row.status === 'watching' || row.status === 'rolling_back') setStatus(db, row.id, 'failed');
        record(db, 'release_watch_failed', row, error.message);
        try { notify(conf, row.ticket, productMessage(conf, 'release_watch_failed', { title: row.title, reason: error.message })); }
        catch (noticeError) { record(db, 'rollback_notification_failed', row, noticeError.message); }
        throw error;
      }
    }
    if (command === 'auto') {
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
      const [ticket, ...flags] = args;
      const usage = 'usage: cleared rollback <ticket> [--yes] [--force-with-migrations] [--approval-comment ID]';
      if (!ticket) throw new Error(usage);
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--approval-comment') {
          if (!flags[++i] || flags[i].startsWith('--')) throw new Error(usage);
        } else if (!['--yes', '--force-with-migrations'].includes(flags[i])) throw new Error(usage);
      }
      const row = db.prepare('SELECT * FROM releases WHERE ticket = ? ORDER BY id DESC LIMIT 1').get(ticket);
      if (!row) throw new Error(`No Cleared release recorded for ${ticket}`);
      const tracker = createTracker(conf);
      const commentAt = flags.indexOf('--approval-comment');
      try { authorizeManualRollback(conf, db, tracker, row, commentAt >= 0 ? flags[commentAt + 1] : null); }
      finally { tracker.close?.(); }
      if (row.rollback_sha) throw new Error('This release was already rolled back');
      const p = plan(conf, repo, row);
      console.log(rollbackPreview(row, p.files));
      if (p.migrations && !flags.includes('--force-with-migrations')) throw new Error('This merge touches declared migrations; add --force-with-migrations after reviewing database effects');
      if (!flags.includes('--yes')) {
        process.stdout.write('Type "rollback" to confirm: ');
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        if (!confirmedRollback(input)) throw new Error('Rollback cancelled');
      }
      console.log(`Pushed revert ${rollbackRelease(conf, db, repo, row, { forceWithMigrations: flags.includes('--force-with-migrations') })}`);
      return;
    }
    throw new Error('usage: release.mjs active | start TICKET PR | watch ID | rollback TICKET [--yes] [--force-with-migrations] [--approval-comment ID]');
  } finally { db.close(); }
}

if (runAsCommand(import.meta.url)) main(process.argv.slice(2)).catch((error) => {
  console.error(`release: ${error.message}`);
  process.exitCode ||= 1;
});
