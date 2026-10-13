import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { openLedger, addEvent } from '../lib/ledger.mjs';
import { releaseSettings, canHumanRollback, canAutoRollback, shouldRollback, touchesMigrations,
  activeRelease, rollbackRelease, watchRelease, startRelease, rollbackPreview, confirmedRollback,
  reconcileNotifications, resumeWatches, retryFetch } from '../lib/release.mjs';
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
  assert.throws(() => releaseSettings({ sections: { tracker: { go_state: 'Go', todo_state: 'Todo' },
    release: { reopen_state: 'Go' } } }), /must not be the approval/);
  assert.throws(() => releaseSettings({ sections: { tracker: { go_state: 'Go', todo_state: 'Todo' },
    release: { reopen_state: 'Unknown' } } }), /configured non-approval/);
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
  assert.equal(touchesMigrations(['db/migrations/001.sql'], ['db/migrations']), true);
  assert.equal(touchesMigrations(['db/migrations/001.sql'], ['./db/migrations/']), true);
  assert.equal(touchesMigrations(['DB/Migrations/É.sql'], ['db/migrations']), true);
  assert.equal(touchesMigrations(['db/migrations-old/a.sql'], ['db/migrations/']), false);
});

test('a transient base fetch failure is retried before giving up on rollback', () => {
  let calls = 0;
  const paused = [];
  const result = retryFetch(() => { if (++calls < 3) throw new Error('HTTP 502'); return 'fetched'; },
    (ms) => paused.push(ms));
  assert.equal(result, 'fetched');
  assert.equal(calls, 3);
  assert.deepEqual(paused, [1000, 2000]);
  assert.throws(() => retryFetch(() => { throw new Error('offline'); }, () => {}), /failed after three attempts/);
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
  const releasePath = typeof migration === 'string' ? migration : migration ? 'schema.sql' : 'app.txt';
  mkdirSync(dirname(join(repo, releasePath)), { recursive: true });
  writeFileSync(join(repo, releasePath), 'release\n');
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
      migration_paths: 'schema.sql, db/migrations' } } };
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
    performRollback: () => {
      const sha = rollbackRelease(x.conf, x.db, x.repo,
        x.db.prepare('SELECT * FROM releases WHERE id = ?').get(x.row.id), {
          automatic: true, trackerFactory: () => ({ moveTicket: (...args) => moved.push(args) }),
          announce: (_conf, _ticket, body) => notices.push(body),
        });
      assert.equal(activeRelease(x.db).status, 'verifying_rollback', 'no second release starts before post-rollback health');
      return sha;
    },
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
    performRollback: () => {
      reverts++;
      x.db.prepare("UPDATE releases SET status = 'verifying_rollback', rollback_pushed_at = ? WHERE id = ?")
        .run(new Date(time).toISOString(), x.row.id);
    },
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

test('an unavailable tracker leaves the health alert in the retry outbox', async (t) => {
  const x = releasedProject(t);
  x.conf.sections.release.auto_rollback = 'false';
  const oldState = process.env.CLEARED_STATE_DIR;
  process.env.CLEARED_STATE_DIR = join(x.repo, '..');
  try {
    let time = x.clock;
    await watchRelease(x.conf, x.db, x.repo, x.row.id, {
      currentTime: () => time, wait: async (ms) => { time += ms; },
      check: async () => ({ ok: false, detail: 'HTTP 503' }),
      announce: () => { throw new Error('tracker unavailable'); },
    });
    const outbox = join(x.repo, '..', 'tracker-outbox');
    const files = readdirSync(outbox).filter((name) => name.endsWith('.md'));
    assert.equal(files.length, 1);
    assert.match(readFileSync(join(outbox, files[0]), 'utf8'), /HTTP 503/);
    assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'rollback_notification_failed'").get().n, 1);
  } finally {
    if (oldState === undefined) delete process.env.CLEARED_STATE_DIR;
    else process.env.CLEARED_STATE_DIR = oldState;
  }
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

test('non-ASCII migration filenames are detected before any automatic revert', (t) => {
  const x = releasedProject(t, { migration: 'db/migrations/é.sql' });
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

test('a later base commit blocks automatic rollback even without a conflict', async (t) => {
  const x = releasedProject(t);
  writeFileSync(join(x.repo, 'unrelated.txt'), 'later\n');
  x.git('add', '.'); x.git('commit', '-qm', 'later unrelated change'); x.git('push', '-q', 'origin', 'main');
  const head = x.git('rev-parse', 'HEAD');
  let time = x.clock, reverts = 0;
  const notices = [];
  await watchRelease(x.conf, x.db, x.repo, x.row.id, {
    currentTime: () => time, wait: async (ms) => { time += ms; },
    check: async () => ({ ok: false, detail: 'HTTP 503' }),
    performRollback: () => { reverts++; }, announce: (_conf, _ticket, body) => notices.push(body),
  });
  assert.equal(reverts, 0);
  assert.equal(x.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], head);
  assert.match(notices[0], /base branch moved/);
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

test('a remote owner comment must be fresh, unedited and name the exact merge', (t) => {
  const x = releasedProject(t);
  const row = { ...x.row, merged_at: new Date(Date.now() - 3600000).toISOString() };
  const comment = (age, editedAt = null, body = `Rollback ${row.ticket} ${row.merge_sha}`) => ({
    id: 'c1', by: { kind: 'human', id: 'human' }, body,
    createdAt: new Date(Date.now() - age).toISOString(), editedAt,
  });
  const tracker = (entry) => ({ whoAmI: () => ({ kind: 'agents', id: 'bot' }), comments: () => [entry] });
  assert.throws(() => authorizeManualRollback(x.conf, x.db, tracker(comment(11 * 60000)), row, 'c1'), /verified human/);
  assert.throws(() => authorizeManualRollback(x.conf, x.db, tracker(comment(60000, new Date().toISOString())), row, 'c1'), /verified human/);
  assert.throws(() => authorizeManualRollback(x.conf, x.db, tracker(comment(60000, null, 'Rollback another merge')), row, 'c1'), /verified human/);
  assert.equal(authorizeManualRollback(x.conf, x.db, tracker(comment(60000)), row, 'c1'), 'human');
  const previous = process.env.ORCH_BROKER_AGENT_REQUEST;
  process.env.ORCH_BROKER_AGENT_REQUEST = '1';
  try {
    const sharedIdentity = { whoAmI: () => ({ kind: 'human', id: 'human' }), comments: () => [comment(60000)] };
    assert.throws(() => authorizeManualRollback(x.conf, x.db, sharedIdentity, row, 'c1'), /verified human/);
    assert.equal(authorizeManualRollback(x.conf, x.db, tracker(comment(60000)), row, 'c1'), 'human');
  } finally {
    if (previous === undefined) delete process.env.ORCH_BROKER_AGENT_REQUEST;
    else process.env.ORCH_BROKER_AGENT_REQUEST = previous;
  }
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

test('local CLI refuses an agent and lets a human preview, confirm and push a revert', async (t) => {
  const x = releasedProject(t);
  const root = join(x.repo, '..');
  const configPath = join(root, 'agents.conf');
  const keyPath = join(root, 'human.key');
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const owner = userInfo().username;
  const configuration = (id, uid) => `[lanes]\nbase = origin/main\n[tracker]\nadapter = local\nowner_id = ${id}\nagents_uid = ${uid}\nhuman_private_key = ${keyPath}\ntodo_state = Todo\nprogress_state = Doing\nreview_state = Review\nvalidate_state = Validate\ngo_state = Go\ndone_state = Done\n[release]\nreopen_state = Todo\nauto_rollback = false\n`;
  const socket = join(root, 'broker.sock');
  const env = { ...process.env, CLEARED_REPO: x.repo, CLEARED_STATE_DIR: root, CLEARED_CONF: configPath, CLEARED_RELEASE_SOCKET: socket };
  const broker = spawn(process.execPath, [new URL('../serve/release-broker.mjs', import.meta.url).pathname], { env, stdio: 'ignore' });
  t.after(() => broker.kill('SIGTERM'));
  for (let i = 0; i < 100 && !existsSync(socket); i++) await pause(25);
  assert.ok(existsSync(socket));
  const cli = (...args) => spawnSync(process.execPath, [new URL('../cleared', import.meta.url).pathname, ...args], { env, encoding: 'utf8' });
  writeFileSync(configPath, configuration('another-user', String(process.getuid())));
  const agent = cli('rollback', 'LOCAL-1', '--yes');
  assert.notEqual(agent.status, 0);
  assert.match(agent.stderr, /verified human owner/);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'rollback_refused'").get().n, 1);
  writeFileSync(configPath, configuration(owner, '999999'));
  const created = cli('ticket', 'new', 'Test release');
  assert.equal(created.status, 0, created.stderr);
  const done = cli('ticket', 'move', 'LOCAL-1', 'Done');
  assert.equal(done.status, 0, done.stderr);
  const cancelled = spawnSync(process.execPath, [new URL('../cleared', import.meta.url).pathname, 'rollback', 'LOCAL-1'],
    { env, input: 'no\n', encoding: 'utf8' });
  assert.notEqual(cancelled.status, 0);
  assert.match(cancelled.stdout, /Merge to revert: [a-f0-9]{40}[\s\S]*app.txt/);
  assert.equal(x.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], x.row.merge_sha);
  const confirmed = cli('rollback', 'LOCAL-1', '--yes');
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(confirmed.stdout, /Pushed revert/);
  assert.equal(x.db.prepare('SELECT status FROM releases WHERE id = ?').get(x.row.id).status, 'rolled_back');
  assert.equal(x.db.prepare('SELECT status FROM tracker_tickets WHERE id = 1').get().status, 'Todo');
});

test('a second release is held while the first is watched', (t) => {
  const x = releasedProject(t);
  assert.equal(activeRelease(x.db).id, x.row.id);
  x.git('checkout', '-qb', 'other');
  writeFileSync(join(x.repo, 'other.txt'), 'second\n');
  x.git('add', '.'); x.git('commit', '-qm', 'other change');
  x.git('checkout', '-q', 'main'); x.git('merge', '--no-ff', '-qm', 'Merge other', 'other');
  x.git('push', '-q', 'origin', 'main');
  const secondSha = x.git('rev-parse', 'HEAD');
  addEvent(x.db, { kind: 'merged_by_script', ticket: 'LOCAL-2', value: 2 });
  assert.throws(() => startRelease(x.conf, x.db, x.repo, 'LOCAL-2', 2, {
    readPull: () => ({ mergeCommit: { oid: secondSha }, mergedAt: new Date().toISOString(), title: 'Second' }),
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

test('a stopped watch is restarted after a reboot without clearing the release gate', (t) => {
  const x = releasedProject(t);
  const resumed = [];
  resumeWatches(x.conf, x.db, x.repo, {
    running: () => false, lockAvailable: () => true, schedule: (_repo, id) => resumed.push(id), announce: () => {},
  });
  assert.deepEqual(resumed, [x.row.id]);
  assert.equal(activeRelease(x.db).id, x.row.id);
});

test('an elapsed watch after downtime fails visibly instead of pretending health was good', (t) => {
  const x = releasedProject(t);
  x.db.prepare('UPDATE releases SET merged_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3 * 60000).toISOString(), x.row.id);
  const notices = [];
  resumeWatches(x.conf, x.db, x.repo, {
    running: () => false, schedule: () => assert.fail('expired watch must not restart'),
    announce: (_conf, _ticket, body) => notices.push(body),
  });
  assert.equal(activeRelease(x.db), undefined);
  assert.match(notices[0], /could not finish monitoring/);
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'release_watch_failed'").get().n, 1);
});

test('a revert pushed before process death is found and verified once', async (t) => {
  const x = releasedProject(t);
  rollbackRelease(x.conf, x.db, x.repo, x.row, {
    trackerFactory: () => ({ moveTicket: () => {} }), announce: () => {},
  });
  x.db.prepare("UPDATE releases SET status = 'rolling_back', rollback_sha = NULL, rollback_pushed_at = NULL WHERE id = ?").run(x.row.id);
  const resumed = [];
  resumeWatches(x.conf, x.db, x.repo, {
    running: () => false, lockAvailable: () => true, schedule: (_repo, id) => resumed.push(id), announce: () => {},
  });
  assert.deepEqual(resumed, [x.row.id]);
  assert.equal(x.db.prepare('SELECT status FROM releases WHERE id = ?').get(x.row.id).status, 'verifying_rollback');
  let time = Date.now();
  await watchRelease(x.conf, x.db, x.repo, x.row.id, {
    currentTime: () => time, wait: async (ms) => { time += ms; },
    check: async () => ({ ok: true, detail: 'HTTP 200' }), announce: () => {},
  });
  assert.equal(x.db.prepare('SELECT status FROM releases WHERE id = ?').get(x.row.id).status, 'rolled_back');
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'rollback_health_ok'").get().n, 1);
});

test('a stopped rollback with no pushed revert fails visibly instead of blocking releases forever', (t) => {
  const x = releasedProject(t);
  x.db.prepare("UPDATE releases SET status = 'rolling_back' WHERE id = ?").run(x.row.id);
  const notices = [];
  resumeWatches(x.conf, x.db, x.repo, {
    running: () => false, lockAvailable: () => false, schedule: () => assert.fail('active revert owns the lock'),
    announce: () => assert.fail('active revert must not be declared failed'),
  });
  assert.equal(activeRelease(x.db).status, 'rolling_back');
  resumeWatches(x.conf, x.db, x.repo, {
    running: () => false, lockAvailable: () => true, schedule: () => assert.fail('no watcher should restart'),
    announce: (_conf, _ticket, body) => notices.push(body),
  });
  assert.equal(activeRelease(x.db), undefined);
  assert.match(notices[0], /could not roll back/);
});

test('a forged rollback trailer in an agent commit cannot satisfy recovery', (t) => {
  const x = releasedProject(t);
  writeFileSync(join(x.repo, 'unrelated.txt'), 'not a revert\n');
  x.git('add', '.');
  x.git('commit', '-qm', `Forged marker\n\nCleared-Rollback-Release: ${x.row.id}\nCleared-Reverted-Merge: ${x.row.merge_sha}`);
  x.git('push', '-q', 'origin', 'main');
  x.db.prepare("UPDATE releases SET status = 'rolling_back', planned_rollback_sha = ? WHERE id = ?")
    .run('0'.repeat(40), x.row.id);
  resumeWatches(x.conf, x.db, x.repo, {
    running: () => false, lockAvailable: () => true, schedule: () => assert.fail('no watcher'), announce: () => {},
  });
  assert.equal(x.db.prepare('SELECT status FROM releases WHERE id = ?').get(x.row.id).status, 'failed');
  assert.equal(x.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'rollback_pushed'").get().n, 0);
});
