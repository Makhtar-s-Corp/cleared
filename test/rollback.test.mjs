import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, addEvent } from '../lib/ledger.mjs';
import { releaseSettings, canHumanRollback, canAutoRollback, shouldRollback, touchesMigrations,
  activeRelease, rollbackRelease, watchRelease, startRelease, rollbackPreview, confirmedRollback,
  reconcileNotifications } from '../lib/release.mjs';
import { authorizeManualRollback } from '../lib/release.mjs';

test('release defaults are inert and repeated failures trigger only when enabled', () => {
  const off = releaseSettings({ sections: {} });
  assert.equal(off.autoRollback, false);
  assert.equal(off.watchMinutes, 15);
  assert.equal(off.deployGraceMinutes, 5);
  assert.equal(off.failuresToRollback, 3);
  assert.equal(shouldRollback(off, 3), false);
  const on = releaseSettings({ sections: { release: { auto_rollback: 'true', health_command: 'true', reopen_state: 'Todo' } } });
  assert.equal(shouldRollback(on, 2), false);
  assert.equal(shouldRollback(on, 3), true);
  assert.throws(() => releaseSettings({ sections: { release: { auto_rollback: 'true' } } }), /requires health_url or health_command/);
});

test('only the configured human owner can request rollback', () => {
  assert.equal(canHumanRollback({ kind: 'agents', id: 'bot' }, 'alice'), false);
  assert.equal(canHumanRollback({ kind: 'shared', id: 'alice' }, 'alice'), false);
  assert.equal(canHumanRollback({ kind: 'human', id: 'other' }, 'alice'), false);
  assert.equal(canHumanRollback({ kind: 'human', id: 'alice' }, 'alice'), true);
});

test('declared migration paths disable automatic rollback', () => {
  assert.equal(touchesMigrations(['src/a.js'], ['db/migrations/']), false);
  assert.equal(touchesMigrations(['db/migrations/001.sql'], ['db/migrations/']), true);
  assert.equal(touchesMigrations(['db/migrations-old/a.sql'], ['db/migrations/']), false);
});

function releasedProject(t, { migration = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cleared-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'project');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, repo]);
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'app.txt'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'initial'); git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(repo, migration ? 'schema.sql' : 'app.txt'), 'release\n');
  git('add', '.'); git('commit', '-qm', 'feature');
  git('checkout', '-q', 'main'); git('merge', '--no-ff', '-qm', 'Merge feature', 'feature');
  git('push', '-q', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  const db = openLedger(join(root, 'ledger.db'));
  activeRelease(db);
  const clock = Date.now();
  db.prepare('INSERT INTO releases(ticket,pr,merge_sha,title,merged_at,status) VALUES (?,?,?,?,?,?)')
    .run('LOCAL-1', 1, sha, 'Test release', new Date(clock).toISOString(), 'watching');
  const row = db.prepare('SELECT * FROM releases WHERE merge_sha = ?').get(sha);
  const conf = { sections: { lanes: { base: 'origin/main' }, tracker: { owner_id: 'human' },
    release: { health_command: 'true', deploy_grace_minutes: '0', watch_minutes: '2',
      failures_to_rollback: '3', auto_rollback: 'true', reopen_state: 'Todo',
      migration_paths: 'schema.sql' } } };
  return { repo, db, row, conf, git, clock };
}

test('a healthy release finishes its watch without rollback', async (t) => {
  const x = releasedProject(t);
  let time = x.clock;
  await watchRelease(x.conf, x.db, x.repo, x.row.id, {
    currentTime: () => time, wait: async (ms) => { time += ms; },
    check: async () => ({ ok: true, detail: 'HTTP 200' }), announce: () => assert.fail('no alert expected'),
  });
  assert.equal(x.db.prepare('SELECT status FROM releases WHERE id = ?').get(x.row.id).status, 'complete');
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'release_watch_complete'").get().n, 1);
});

test('three failures push one exact revert, reopen the ticket and report recovery', async (t) => {
  const x = releasedProject(t);
  let time = x.clock;
  let checks = 0;
  const moved = [], notices = [];
  await watchRelease(x.conf, x.db, x.repo, x.row.id, {
    currentTime: () => time, wait: async (ms) => { time += ms; },
    check: async () => (++checks <= 3 ? { ok: false, detail: 'HTTP 503' } : { ok: true, detail: 'HTTP 200' }),
    announce: (_conf, _ticket, body) => notices.push(body),
    performRollback: () => rollbackRelease(x.conf, x.db, x.repo,
      x.db.prepare('SELECT * FROM releases WHERE id = ?').get(x.row.id), {
      automatic: true, trackerFactory: () => ({ moveTicket: (...args) => moved.push(args) }),
      announce: (_conf, _ticket, body) => notices.push(body),
    }),
  });
  assert.equal(checks, 4);
  assert.deepEqual(moved, [['LOCAL-1', 'Todo']]);
  assert.equal(readFileSync(join(x.repo, 'app.txt'), 'utf8'), 'release\n', 'the checkout is not rewritten');
  x.git('fetch', '-q', 'origin', 'main');
  assert.equal(x.git('show', 'origin/main:app.txt'), 'before');
  assert.equal(x.db.prepare('SELECT status FROM releases WHERE id = ?').get(x.row.id).status, 'rolled_back');
  assert.deepEqual(x.db.prepare("SELECT kind FROM events WHERE kind LIKE 'rollback_%' ORDER BY event_id").all().map((r) => r.kind),
    ['rollback_started', 'rollback_pushed', 'rollback_health_ok']);
  assert.match(notices[0], /HTTP 503/);
});

test('health still failing after revert alerts once and never reverts again', async (t) => {
  const x = releasedProject(t);
  let time = x.clock, reverts = 0;
  const notices = [];
  await watchRelease(x.conf, x.db, x.repo, x.row.id, {
    currentTime: () => time, wait: async (ms) => { time += ms; },
    check: async () => ({ ok: false, detail: 'HTTP 503' }),
    performRollback: () => { reverts++; x.db.prepare("UPDATE releases SET status = 'rolled_back' WHERE id = ?").run(x.row.id); },
    announce: (_conf, _ticket, body) => notices.push(body),
  });
  assert.equal(reverts, 1);
  assert.match(notices[0], /still failing/);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'rollback_health_still_failing'").get().n, 1);
});

test('bad health with automatic rollback off is reported without a revert', async (t) => {
  const x = releasedProject(t);
  x.conf.sections.release.auto_rollback = 'false';
  let time = x.clock, reverts = 0;
  const notices = [];
  await watchRelease(x.conf, x.db, x.repo, x.row.id, {
    currentTime: () => time, wait: async (ms) => { time += ms; },
    check: async () => ({ ok: false, detail: 'HTTP 503' }),
    performRollback: () => { reverts++; }, announce: (_conf, _ticket, body) => notices.push(body),
  });
  assert.equal(reverts, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /disabled/);
});

test('a later conflicting change is never pushed over', (t) => {
  const x = releasedProject(t);
  writeFileSync(join(x.repo, 'app.txt'), 'later change\n');
  x.git('add', '.'); x.git('commit', '-qm', 'later change'); x.git('push', '-q', 'origin', 'main');
  const latest = x.git('rev-parse', 'HEAD');
  assert.throws(() => rollbackRelease(x.conf, x.db, x.repo, x.row, {
    trackerFactory: () => ({ moveTicket: () => {} }), announce: () => {},
  }), /conflicts.*nothing was pushed/);
  assert.equal(x.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], latest);
});

test('a merge touching a declared migration cannot auto revert', (t) => {
  const x = releasedProject(t, { migration: true });
  assert.throws(() => rollbackRelease(x.conf, x.db, x.repo, x.row, { automatic: true }), /migrations/);
  assert.equal(x.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], x.row.merge_sha);
});

test('failing health on a migration release alerts instead of auto reverting', async (t) => {
  const x = releasedProject(t, { migration: true });
  let time = x.clock, reverts = 0;
  const notices = [];
  await watchRelease(x.conf, x.db, x.repo, x.row.id, {
    currentTime: () => time, wait: async (ms) => { time += ms; },
    check: async () => ({ ok: false, detail: 'HTTP 503' }),
    performRollback: () => { reverts++; }, announce: (_conf, _ticket, body) => notices.push(body),
  });
  assert.equal(reverts, 0);
  assert.match(notices[0], /migration/);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'rollback_migrations_blocked'").get().n, 1);
});

test('agent rollback is rejected and audited; human owner may proceed', (t) => {
  const x = releasedProject(t);
  assert.throws(() => authorizeManualRollback(x.conf, x.db, {
    whoAmI: () => ({ kind: 'agents', id: 'bot' }), comments: () => [],
  }, x.row), /verified human owner/);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'rollback_refused'").get().n, 1);
  assert.equal(authorizeManualRollback(x.conf, x.db, {
    whoAmI: () => ({ kind: 'human', id: 'human' }), comments: () => [],
  }, x.row), 'human');
});

test('direct automatic rollback is refused without a live failed watch', (t) => {
  const x = releasedProject(t);
  const settings = releaseSettings(x.conf);
  assert.equal(canAutoRollback(settings, x.row, x.clock), false);
  assert.equal(canAutoRollback(settings, { ...x.row, failures: 3, last_health: 'HTTP 503' }, x.clock), true);
  assert.equal(canAutoRollback(settings, { ...x.row, failures: 3, last_health: 'HTTP 503' }, x.clock + 120000), false);
  assert.equal(canAutoRollback({ ...settings, autoRollback: false }, { ...x.row, failures: 3, last_health: 'HTTP 503' }, x.clock), false);
});

test('manual rollback previews the exact merge and needs explicit confirmation', (t) => {
  const x = releasedProject(t);
  assert.match(rollbackPreview(x.row, ['app.txt']), /LOCAL-1.*Test release[\s\S]*Merge to revert: [a-f0-9]{40}[\s\S]*app.txt/);
  assert.equal(confirmedRollback('no'), false);
  assert.equal(confirmedRollback('rollback\n'), true);
  assert.equal(confirmedRollback('', true), true);
});

test('a second release is held while the first is watched', (t) => {
  const x = releasedProject(t);
  assert.equal(activeRelease(x.db).id, x.row.id);
  addEvent(x.db, { kind: 'merged_by_script', ticket: 'LOCAL-2', value: 2 });
  assert.throws(() => startRelease(x.conf, x.db, x.repo, 'LOCAL-2', 2, {
    readPull: () => ({ mergeCommit: { oid: x.row.merge_sha }, mergedAt: new Date().toISOString(), title: 'Second' }),
    schedule: () => assert.fail('no second watcher'),
  }), /already being monitored/);
});

test('no health probe records one skipped watch and does not hold the release gate', (t) => {
  const x = releasedProject(t);
  x.db.prepare("UPDATE releases SET status = 'complete' WHERE id = ?").run(x.row.id);
  x.conf.sections.release.health_command = '';
  x.conf.sections.release.auto_rollback = 'false';
  let scheduled = false;
  // A different PR needs a different merge commit. The first entry is the
  // synthetic earlier release; drop it before testing the same SHA.
  x.db.prepare('DELETE FROM releases WHERE id = ?').run(x.row.id);
  addEvent(x.db, { kind: 'merged_by_script', ticket: 'LOCAL-1', value: 1 });
  startRelease(x.conf, x.db, x.repo, 'LOCAL-1', 1, {
    readPull: () => ({ mergeCommit: { oid: x.row.merge_sha }, mergedAt: new Date(x.clock).toISOString(), title: 'Test release' }),
    schedule: () => { scheduled = true; },
  });
  assert.equal(scheduled, false);
  assert.equal(activeRelease(x.db), undefined);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'release_health_unconfigured'").get().n, 1);
});

test('failed ticket notification stays pending and is retried on the next wake', (t) => {
  const x = releasedProject(t);
  const moved = [];
  rollbackRelease(x.conf, x.db, x.repo, x.row, {
    trackerFactory: () => ({ moveTicket: (...args) => moved.push(args) }),
    announce: () => { throw new Error('tracker down'); },
  });
  assert.equal(x.db.prepare('SELECT notified_at FROM releases WHERE id = ?').get(x.row.id).notified_at, null);
  const notices = [];
  reconcileNotifications(x.conf, x.db, {
    trackerFactory: () => ({ moveTicket: (...args) => moved.push(args) }),
    announce: (_conf, _ticket, body) => notices.push(body),
  });
  assert.equal(notices.length, 1);
  assert.ok(x.db.prepare('SELECT notified_at FROM releases WHERE id = ?').get(x.row.id).notified_at);
  reconcileNotifications(x.conf, x.db, { announce: () => assert.fail('already delivered') });
});
