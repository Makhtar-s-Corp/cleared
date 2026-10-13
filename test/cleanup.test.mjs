import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.mjs';
import { route } from '../lib/route.mjs';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.mjs';
import { conf, scratch, fixtureProject, sandbox, runLane, laneWithRemote, flowBox, reviewedPull, task, first } from './support.mjs';

test('closing a lane: work that only the lane holds is kept unless forced; what the remote holds is enough', () => {
  const box = sandbox();
  const remote = join(box.home, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', 'origin', 'main');
  const lane = (ticket) => {
    const path = join(box.home, 'lanes', `dev-${ticket}`);
    box.git('worktree', 'add', '-q', '-b', `dev/${ticket}`, path, 'origin/main');
    return path;
  };
  // Each commit has its own message: two empty commits made in the same second on the same parent would otherwise be one and the same commit.
  const commit = (path, message) => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', message]);
  const kill = (ticket, ...more) => spawnSync(join(box.home, 'kill-lane.sh'), [`dev/${ticket}`, ...more], { env: box.env, encoding: 'utf8' });
  const open = () => execFileSync('git', ['-C', box.repo, 'worktree', 'list'], { encoding: 'utf8' });

  lane('X-1'); // nothing of its own
  assert.equal(kill('X-1').status, 0);

  const pushed = lane('X-2');
  commit(pushed, 'work that is pushed');
  execFileSync('git', ['-C', pushed, 'push', '-q', 'origin', 'dev/X-2']);
  assert.equal(kill('X-2').status, 0);

  const local = lane('X-3');
  commit(local, 'work that only the lane holds');
  // Another local branch holding the commit is not a backup: it can be deleted too.
  box.git('branch', 'copy-of-X-3', 'dev/X-3');
  const refused = kill('X-3');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 commit\(s\) that the remote does not hold/);
  assert.match(open(), /dev\/X-3/);
  assert.equal(kill('X-3', '--force').status, 0);
  assert.doesNotMatch(open(), /dev\/X-/);
});


test('the lanes are tidied once a day by rule, with no model and no loss: a lane whose change is live, an idle one with no open ticket, a trial one are closed; one attached to a ticket at work is left alone', () => {
  const lane = laneWithRemote('feat/a', 'feat: the work of the lane');
  const { box } = lane;
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8')
    .replace('[lanes]\n', '[lanes]\ntidy_hour = 0\nidle_hours = 24\ntrial_prefixes = test/, essai/\nbusy_states = In Progress\nclosed_states = Done, Canceled\narchives = .local/lane-archives\ntidy_reason_live = changement en ligne\ntidy_reason_idle = sans activité depuis un jour, aucun ticket ouvert\ntidy_reason_trial = équipe d’essai\ntidy_reason_waiting = n’attend plus que l’accord\n')
    .replace('[tracker]\nadapter = local\nteam = X\n', '[tracker]\nadapter = local\nteam = X\nvalidate_state = À valider\ngo_state = Go MEP\ndone_state = Done\n')
    .replace('live = no', 'live = yes'));
  const git = (path, ...args) => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  const add = (branch, { old = false } = {}) => {
    const path = join(box.home, 'lanes', branch.replace('/', '-'));
    box.git('worktree', 'add', '-q', '-b', branch, path, 'main');
    execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', `feat: the work of ${branch}`], old ? { env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' } } : {});
    // An old lane was also opened long ago: the day a worktree was opened counts as a sign of life.
    if (old) execFileSync('touch', ['-d', '2020-01-01T00:00:00Z', join(execFileSync('git', ['-C', path, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), 'gitdir')]);
    return path;
  };
  const pulls = (branch, list) => writeFileSync(join(box.home, `pr-head-${branch.replace('/', '-')}.json`), JSON.stringify(list));
  const state = (ticket, name) => writeFileSync(join(box.home, `tracker-state-${ticket}`), `${name}\n`);
  // a: its change is live, its ticket is done. It holds a commit the remote lacks and a file that exists nowhere else.
  pulls('feat/a', [{ number: 11, state: 'MERGED', title: 'feat: a (X-1)', body: '' }]);
  state('X-1', 'Done');
  writeFileSync(join(box.home, 'tracker-title-X-1'), 'Les budgets du mois');
  git(lane.path, 'push', '-q', 'origin', 'feat/a');
  mkdirSync(join(lane.path, '.local', 'notes'), { recursive: true });
  writeFileSync(join(lane.path, '.gitignore'), '.local/\n');
  git(lane.path, 'add', '.gitignore');
  git(lane.path, 'commit', '-q', '-m', 'chore: ignore');
  writeFileSync(join(lane.path, '.local', 'notes', 'capture d’écran.txt'), 'only here\n');
  // b: its change is live too, but its ticket is at work again: left alone.
  const b = add('feat/b');
  pulls('feat/b', [{ number: 12, state: 'MERGED', title: 'feat: b', body: 'X-2' }]);
  state('X-2', 'In Progress');
  // c: a trial lane, with work nobody saved.
  const c = add('test/c');
  writeFileSync(join(c, 'draft.txt'), 'unsaved\n');
  // d: no pull request, nothing for days, no ticket. e: the same, but at work today.
  const d = add('feat/d', { old: true });
  const e = add('feat/e');
  // f: its ticket only waits for the agreement of the user. A lane that only waits has no reason to stay open: its
  // branch is on the remote, and it is opened again only if a review asks for a correction (his rule of 2026-10-08).
  const f = add('feat/X-6-f');
  state('X-6', 'À valider');
  // w: one of its tickets waits for him, the other is at work: it works, it stays.
  const w = add('feat/X-7-X-8-w');
  state('X-7', 'Go MEP');
  state('X-8', 'In Progress');
  const tidy = (...args) => spawnSync(join(box.home, 'tidy-lanes.sh'), args, { env: { ...box.env, HOME: box.home }, encoding: 'utf8' });
  const remote = () => lane.onRemote().join('\n');
  const there = (path) => { try { readdirSync(path); return true; } catch { return false; } };
  // A dry run says what it would do, and does none of it.
  const dry = tidy('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).closed.map((one) => one.lane).sort(), ['feat-X-6-f', 'feat-a', 'feat-d', 'test-c']);
  assert.ok(there(lane.path) && there(c) && there(d));
  const done = tidy();
  assert.equal(done.status, 0, done.stderr);
  const result = JSON.parse(done.stdout);
  assert.deepEqual(result.closed.map((one) => [one.lane, one.name, one.why]).sort(), [['feat-X-6-f', 'Titre de X-6', 'n’attend plus que l’accord'], ['feat-a', 'Les budgets du mois', 'changement en ligne'], ['feat-d', 'feat-d', 'sans activité depuis un jour, aucun ticket ouvert'], ['test-c', 'test-c', 'équipe d’essai']]);
  assert.deepEqual([there(lane.path), there(b), there(c), there(d), there(e), there(f), there(w)], [false, true, false, false, true, false, true]);
  assert.equal(result.left, 3);
  assert.match(remote(), /^feat\/X-6-f /m, 'the branch of the lane that only waited is on the remote');
  // Nothing lost: the commits are on the remote, the unsaved work too as « wip », the file that existed nowhere else is archived.
  for (const branch of ['feat/a', 'test/c', 'feat/d']) assert.match(remote(), new RegExp(`^${branch} `, 'm'), branch);
  assert.match(execFileSync('git', ['--git-dir', lane.remote, 'log', '-1', '--format=%s', 'test/c'], { encoding: 'utf8' }), /^wip: /);
  assert.equal(readFileSync(join(box.repo, '.local', 'lane-archives', 'feat-a', `menage-${new Date().toLocaleDateString('sv-SE')}`, '.local', 'notes', 'capture d’écran.txt'), 'utf8'), 'only here\n');
  // Kept: in the ledger, and as a note for the digest in the words of the project.
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.equal(db.prepare("select value from events where kind = 'lanes_tidied'").get().value, 4);
  db.close();
  assert.match(readFileSync(join(box.state, 'digest-notes.jsonl'), 'utf8'), /« Les budgets du mois » : changement en ligne/);
  // Once a day, by the wake: a second wake the same day does not run it again.
  const g = add('test/g');
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, HOME: box.home }, encoding: 'utf8' });
  assert.equal(wake().status, 0);
  assert.equal(there(g), false, 'the wake tidies');
  const h = add('test/h');
  assert.equal(wake().status, 0);
  assert.equal(there(h), true, 'not twice the same day');
  // A lane the guard would not let out is left as it is, and said: nothing of it is committed, day after day.
  const secret = add('test/secret');
  writeFileSync(join(secret, 'notes.txt'), `le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}"\n`);
  const refused = tidy();
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(there(secret), true);
  assert.deepEqual(JSON.parse(refused.stdout).kept.filter((one) => one.lane === 'test-secret').map((one) => /guard/.test(one.why)), [true]);
  assert.equal(git(secret, 'log', '-1', '--format=%s').trim(), 'feat: the work of test/secret', 'no « wip » commit of what the guard refuses');
  assert.match(git(secret, 'status', '--porcelain'), /notes\.txt/);
  execFileSync('rm', [join(secret, 'notes.txt')]);
  // A lane with a session running in the ledger is at work, whatever its ticket says: a review is not cut in the middle.
  const reviewing = add('test/reviewing');
  const db2 = openLedger(join(box.state, 'ledger.db'));
  runStart(db2, { runId: 'run-reviewing', lane: 'test/reviewing', role: 'review', ticket: 'X-9', modelAlias: 'a', source: 'dispatcher' });
  db2.close();
  // A lane opened a moment ago on an old base has no commit of its own yet: it is not idle, it has just begun.
  const fresh = join(box.home, 'lanes', 'feat-fresh');
  box.git('worktree', 'add', '-q', '-b', 'feat/fresh', fresh, 'main');
  // A branch whose pull request is merged and that the remote no longer has is not put back there: what it still
  // holds is kept beside the archives.
  const gone = add('feat/gone');
  pulls('feat/gone', [{ number: 13, state: 'MERGED', title: 'feat: gone', body: '' }]);
  writeFileSync(join(gone, 'late.txt'), 'written after the merge\n');
  const after = tidy();
  assert.equal(after.status, 0, after.stderr);
  const last = JSON.parse(after.stdout);
  assert.equal(there(reviewing), true);
  assert.deepEqual(last.kept.filter((one) => one.lane === 'test-reviewing').map((one) => /session is running/.test(one.why)), [true]);
  assert.equal(there(fresh), true, 'a new lane');
  assert.equal(there(gone), false);
  assert.doesNotMatch(remote(), /^feat\/gone /m, 'not put back on the remote');
  const bundle = join(box.repo, '.local', 'lane-archives', 'feat-gone', `menage-${new Date().toLocaleDateString('sv-SE')}`, 'unpushed.bundle');
  assert.match(execFileSync('git', ['-C', box.repo, 'bundle', 'list-heads', bundle], { encoding: 'utf8' }), /feat\/gone/);
});


test('the checkout of the project follows its base by itself: fast-forward only, never a copy somebody changed or works in, what is not tracked left alone, a refusal said once', () => {
  const home = scratch('orch-project-');
  const remote = join(home, 'remote.git');
  const project = join(home, 'project');
  const tools = join(home, 'tool');
  const state = join(home, 'state');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, project], { stdio: 'ignore' });
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  mkdirSync(tools, { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'project-update.sh'), tools]);
  writeFileSync(join(tools, 'agents.conf'), '[lanes]\nbase = origin/main\n\n[update]\nproject = yes\n');
  mkdirSync(join(project, '.cleared'), { recursive: true });
  writeFileSync(join(project, 'rules.md'), 'one\n');
  git(project, 'checkout', '-q', '-b', 'main');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'chore: the project');
  git(project, 'push', '-q', 'origin', 'main');
  writeFileSync(join(project, '.env.local'), 'SECRET=kept\n');
  const elsewhere = join(home, 'elsewhere');
  execFileSync('git', ['clone', '-q', remote, elsewhere], { stdio: 'ignore' });
  const live = (path, text, message) => { mkdirSync(dirname(join(elsewhere, path)), { recursive: true }); writeFileSync(join(elsewhere, path), text); git(elsewhere, 'add', '.'); git(elsewhere, 'commit', '-q', '-m', message); git(elsewhere, 'push', '-q', 'origin', 'HEAD:main'); return git(elsewhere, 'rev-parse', 'HEAD').trim(); };
  const env = { ...process.env, ORCH_REPO: project, ORCH_STATE_DIR: state, ORCH_CONF: join(tools, 'agents.conf') };
  const update = (extra = {}) => spawnSync(join(tools, 'project-update.sh'), [], { env: { ...env, ...extra }, encoding: 'utf8' });
  const head = () => git(project, 'rev-parse', 'HEAD').trim();
  const events = () => { try { const db = openLedger(join(state, 'ledger.db')); const rows = db.prepare("select kind from events where kind like 'project_%' order by rowid").all().map((row) => row.kind); db.close(); return rows; } catch { return []; } };
  // Up to date: nothing to do, nothing said.
  assert.equal(update().status, 3);
  assert.deepEqual(events(), []);
  // Something of the project went live, its settings for the tool among it: this copy takes it, and says it did.
  const second = live('.cleared/agents.conf', '[limits]\nmax_lanes = 2\n', 'chore: the settings of the project');
  const taken = update();
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(head(), second);
  assert.equal(readFileSync(join(project, '.cleared', 'agents.conf'), 'utf8'), '[limits]\nmax_lanes = 2\n');
  assert.equal(readFileSync(join(project, '.env.local'), 'utf8'), 'SECRET=kept\n', 'what is not tracked is left alone');
  assert.deepEqual(events(), ['project_updated']);
  // Switched off by the settings: nothing moves.
  writeFileSync(join(home, 'off.conf'), '[lanes]\nbase = origin/main\n[update]\nproject = no\n');
  const third = live('rules.md', 'two\n', 'docs: a rule');
  assert.equal(update({ ORCH_CONF: join(home, 'off.conf') }).status, 3);
  assert.equal(head(), second);
  // Somebody works in it on a branch: it never moves by itself, and nothing is said.
  git(project, 'checkout', '-q', '-b', 'work');
  assert.equal(update().status, 3);
  assert.deepEqual(events(), ['project_updated']);
  git(project, 'checkout', '-q', 'main');
  // A tracked file changed by hand: nothing is overwritten, said once for that version of the base.
  writeFileSync(join(project, 'rules.md'), 'by hand\n');
  const kept = update();
  assert.equal(kept.status, 1);
  assert.match(kept.stderr, /changed by hand/);
  assert.equal(readFileSync(join(project, 'rules.md'), 'utf8'), 'by hand\n');
  assert.equal(update().status, 1);
  assert.deepEqual(events(), ['project_updated', 'project_update_refused']);
  // Put back: taken at the next wake.
  git(project, 'checkout', '-q', '--', 'rules.md');
  assert.equal(update().status, 0);
  assert.equal(head(), third);
  // Commits of its own that the base does not have: refused too.
  writeFileSync(join(project, 'rules.md'), 'mine\n');
  git(project, 'commit', '-q', '-am', 'wip: mine');
  live('other.md', 'x\n', 'docs: other');
  const ahead = update();
  assert.equal(ahead.status, 1);
  assert.match(ahead.stderr, /holds commits/);
  // A file that is not tracked stands where a tracked one comes in: nothing is overwritten, and what git said is told.
  git(project, 'reset', '-q', '--hard', third);
  writeFileSync(join(project, 'notes.md'), 'not tracked\n');
  live('notes.md', 'tracked\n', 'docs: notes');
  const blocked = update();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /did not go through: .*notes\.md/);
  assert.equal(readFileSync(join(project, 'notes.md'), 'utf8'), 'not tracked\n');
  rmSync(join(project, 'notes.md'));
  assert.equal(update().status, 0);
  const fourth = head();
  // A project that enables updates explicitly still follows its base.
  writeFileSync(join(home, 'project.conf'), '[lanes]\nbase = origin/main\n[limits]\nmax_lanes = 2\n[update]\nproject = yes\n');
  const fifth = live('rules.md', 'three\n', 'docs: one more rule');
  assert.equal(update({ ORCH_CONF: join(home, 'project.conf') }).status, 0);
  assert.equal(head(), fifth);
  assert.notEqual(fifth, fourth);
  // A base named without its remote, or unknown here, is nothing to follow, and stops nothing.
  writeFileSync(join(home, 'odd.conf'), '[lanes]\nbase = origin/nowhere\n[update]\nproject = yes\n');
  assert.equal(update({ ORCH_CONF: join(home, 'odd.conf') }).status, 3);
  // A project the tool lives inside of is left to the update of the tool itself.
  const inside = join(project, 'tool-inside');
  mkdirSync(inside, { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'project-update.sh'), inside]);
  live('other-again.md', 'x\n', 'docs: other again');
  assert.equal(spawnSync(join(inside, 'project-update.sh'), [], { env, encoding: 'utf8' }).status, 3);
  assert.equal(head(), fifth);
  // Each wake asks for it, and goes on whatever it answers: a copy that could not move stops nothing.
  const box = sandbox();
  writeFileSync(join(box.home, 'project-update.sh'), `#!/usr/bin/env bash\necho asked >> "${join(box.home, 'project-calls')}"\nexit 1\n`, { mode: 0o755 });
  const woke = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(woke.status, 0, woke.stderr);
  assert.deepEqual(readFileSync(join(box.home, 'project-calls'), 'utf8').trim().split('\n'), ['asked']);
  // And the lead is told of a copy that did not move, in its own words.
  assert.match(readFileSync(join(ORCH_HOME, 'prompts', 'wake-events.jq'), 'utf8'), /project_update_refused/);
  assert.match(readFileSync(join(ORCH_HOME, 'lib', 'reviews.mjs'), 'utf8'), /'project_update_refused'/);
});


test('the checkout the dispatcher runs from follows the base by itself: fast-forward only, a version that cannot run or a copy somebody changed is refused and said, and the wake goes on with the new scripts', () => {
  const home = scratch('orch-self-');
  const remote = join(home, 'remote.git');
  const checkout = join(home, 'checkout');
  const tools = join(checkout, 'ops', 'cleared');
  const state = join(home, 'state');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, checkout], { stdio: 'ignore' });
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  mkdirSync(join(tools, 'serve'), { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'self-update.sh'), tools]);
  writeFileSync(join(tools, 'agents.conf'), '[lanes]\nbase = origin/main\n\n[update]\nself = yes\n');
  writeFileSync(join(tools, 'serve', 'install.sh'), `#!/usr/bin/env bash\necho installed >> "${join(home, 'installed')}"\n`, { mode: 0o755 });
  writeFileSync(join(tools, 'step.sh'), '#!/usr/bin/env bash\necho one\n', { mode: 0o755 });
  git(checkout, 'checkout', '-q', '-b', 'main');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'chore: the tooling');
  git(checkout, 'push', '-q', 'origin', 'main');
  const elsewhere = join(home, 'elsewhere');
  execFileSync('git', ['clone', '-q', remote, elsewhere], { stdio: 'ignore' });
  const live = (path, text, message) => { mkdirSync(dirname(join(elsewhere, path)), { recursive: true }); writeFileSync(join(elsewhere, path), text, { mode: 0o755 }); git(elsewhere, 'add', '.'); git(elsewhere, 'commit', '-q', '-m', message); git(elsewhere, 'push', '-q', 'origin', 'HEAD:main'); return git(elsewhere, 'rev-parse', 'HEAD').trim(); };
  const env = { ...process.env, ORCH_REPO: checkout, ORCH_STATE_DIR: state, ORCH_CONF: join(tools, 'agents.conf') };
  const update = () => spawnSync(join(tools, 'self-update.sh'), [], { env, encoding: 'utf8' });
  const head = () => git(checkout, 'rev-parse', 'HEAD').trim();
  const events = () => { try { const db = openLedger(join(state, 'ledger.db')); const rows = db.prepare("select kind from events where kind like 'self_%' order by rowid").all().map((row) => row.kind); db.close(); return rows; } catch { return []; } };
  const installed = () => { try { return readFileSync(join(home, 'installed'), 'utf8').trim().split('\n').length; } catch { return 0; } };
  // Up to date: nothing to do, nothing said.
  assert.equal(update().status, 3);
  assert.deepEqual(events(), []);
  // A change of the tooling went live: this copy takes it, and says it did.
  const second = live('ops/cleared/step.sh', '#!/usr/bin/env bash\necho two\n', 'feat: step two');
  const taken = update();
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(head(), second);
  assert.deepEqual(events(), ['self_updated']);
  assert.equal(installed(), 0, 'the services did not change: not installed again');
  // What runs the services changed: they are installed again.
  live('ops/cleared/serve/unit.service', '[Unit]\n', 'feat: a unit');
  assert.equal(update().status, 0);
  assert.equal(installed(), 1);
  // A version whose scripts cannot even be read by the shell is not taken: this copy stays where it runs, said once.
  const good = head();
  const broken = live('ops/cleared/step.sh', '#!/usr/bin/env bash\nif then fi (\n', 'feat: broken');
  const refused = update();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /step\.sh/);
  assert.equal(head(), good);
  assert.equal(update().status, 1);
  assert.deepEqual(events(), ['self_updated', 'self_updated', 'self_update_refused'], 'said once for a version');
  // Repaired on the base: taken again.
  const repaired = live('ops/cleared/step.sh', '#!/usr/bin/env bash\necho three\n', 'fix: repaired');
  assert.notEqual(repaired, broken);
  assert.equal(update().status, 0);
  assert.equal(head(), repaired);
  // Somebody changed a file of this copy by hand: nothing is overwritten, it is said.
  writeFileSync(join(tools, 'step.sh'), '#!/usr/bin/env bash\necho by hand\n');
  live('ops/cleared/other.sh', '#!/usr/bin/env bash\necho other\n', 'feat: other');
  const kept = update();
  assert.equal(kept.status, 1);
  assert.match(kept.stderr, /changed by hand|not committed/);
  assert.equal(readFileSync(join(tools, 'step.sh'), 'utf8'), '#!/usr/bin/env bash\necho by hand\n');
  assert.equal(events().at(-1), 'self_update_refused');
  git(checkout, 'checkout', '-q', '--', '.');
  assert.equal(update().status, 0);
  // A copy on a branch of its own (a worktree where somebody works on the tooling) never moves by itself.
  git(checkout, 'checkout', '-q', '-b', 'feat/mine');
  live('ops/cleared/more.sh', '#!/usr/bin/env bash\necho more\n', 'feat: more');
  const mine = head();
  assert.equal(update().status, 3);
  assert.equal(head(), mine);
  git(checkout, 'checkout', '-q', 'main');
  // Switched off by the settings, nothing. (A project's file that says nothing of it leaves the tool's own setting in force.)
  writeFileSync(join(home, 'off.conf'), '[lanes]\nbase = origin/main\n[update]\nself = no\n');
  assert.equal(spawnSync(join(tools, 'self-update.sh'), [], { env: { ...env, ORCH_CONF: join(home, 'off.conf') }, encoding: 'utf8' }).status, 3);
  assert.notEqual(head(), git(elsewhere, 'rev-parse', 'HEAD').trim());
  // The wake that finds this copy updated goes on as the new wake, once.
  const box = sandbox();
  writeFileSync(join(box.home, 'self-update.sh'), `#!/usr/bin/env bash\necho "asked \${ORCH_SELF_UPDATED:-}" >> "${join(box.home, 'self-calls')}"\nprintf '#!/usr/bin/env bash\\necho "new wake \${ORCH_SELF_UPDATED:-}" >> "${join(box.home, 'self-calls')}"\\n' > "${join(box.home, 'wake.new')}"\nchmod +x "${join(box.home, 'wake.new')}"\nmv "${join(box.home, 'wake.new')}" "${join(box.home, 'wake.sh')}"\n`, { mode: 0o755 });
  const woke = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(woke.status, 0, woke.stderr);
  assert.deepEqual(readFileSync(join(box.home, 'self-calls'), 'utf8').trim().split('\n'), ['asked ', 'new wake 1']);
});


test('the project the tool works on is named the same way for every script, its own settings and prompts come before the examples of the tool, and a path with odd characters is written as it is', () => {
  const dir = scratch('orch-named-');
  const config = join(dir, 'config');
  const first = join(dir, 'project-a');
  const second = join(dir, 'project b');
  for (const made of [join(config, 'cleared'), first, second]) mkdirSync(made, { recursive: true });
  const clean = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(dir, 'state') };
  const bash = (env) => spawnSync('bash', ['-c', 'set -euo pipefail; . "$1/lib/common.sh"; printf "%s\\n%s\\n%s\\n" "$ORCH_REPO" "$ORCH_CONF" "$ORCH_STATE_DIR"', '_', ORCH_HOME], { env: { ...clean, ...env }, encoding: 'utf8' }).stdout.trim().split('\n');
  const node = (env) => spawnSync('node', ['--no-warnings', '--input-type=module', '-e', `import { projectDir, confPath, stateDir } from ${JSON.stringify(join(ORCH_HOME, 'lib', 'conf.mjs'))}; console.log([projectDir(), confPath(), stateDir()].join('\\n'));`], { env: { ...clean, ...env }, encoding: 'utf8' }).stdout.trim().split('\n');
  const both = (env, expected, why) => { assert.deepEqual(bash(env), expected, `bash: ${why}`); assert.deepEqual(node(env), expected, `node: ${why}`); };
  // Nobody named a project: the repository the tool sits in (a project that carries its own copy of it).
  const own = execFileSync('git', ['-C', ORCH_HOME, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n')[0].replace(/^worktree /, '');
  both({}, [own, join(own, '.cleared', 'agents.conf'), join(dir, 'state', 'cleared', basename(own))], 'no project named');
  // Named once for the machine, in one line, whatever blanks surround it.
  writeFileSync(join(config, 'cleared', 'project'), `  ${second}  \r\n`);
  both({}, [second, join(second, '.cleared', 'agents.conf'), join(dir, 'state', 'cleared', 'project b')], 'named for the machine');
  // Whoever runs the script may name another one.
  both({ ORCH_REPO: first }, [first, join(first, '.cleared', 'agents.conf'), join(dir, 'state', 'cleared', 'project-a')], 'named by the caller');
  // Its own settings come before the example of the tool.
  mkdirSync(join(first, '.cleared', 'prompts'), { recursive: true });
  writeFileSync(join(first, '.cleared', 'agents.conf'), '[lanes]\nbase = main\n');
  execFileSync('git', ['-C', first, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', first, 'add', '.cleared/agents.conf']);
  both({ ORCH_REPO: first }, [first, join(first, '.cleared', 'agents.conf'), join(dir, 'state', 'cleared', 'project-a')], 'its own settings');
  // A tool installed under a path with « & » and « | »: written as it is in the permissions and in a prompt.
  const odd = join(dir, 'we&ird|tool');
  mkdirSync(join(odd, 'prompts'), { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), odd]);
  writeFileSync(join(odd, 'agents.conf'), '[permissions.dev]\nmode = accept-edits\nallow = npm test, {orch}/when-free.sh\ndeny = {orch}/merge-pr.sh\n');
  writeFileSync(join(odd, 'prompts', 'dev.md'), 'Lance `{orch}/when-free.sh npm run test:ui`.\n');
  const told = (env) => spawnSync('bash', ['-c', '. "$1/lib/common.sh"; permissions_env dev; printf "%s\\n%s\\n" "$ORCH_ALLOW" "$ORCH_DENY"; prompt_text "$(prompt_file dev)"', '_', odd], { env: { ...clean, ...env }, encoding: 'utf8' }).stdout;
  assert.equal(told({ ORCH_REPO: second, ORCH_CONF: join(odd, 'agents.conf') }), `npm test, ${odd}/when-free.sh\n${odd}/merge-pr.sh\nWrite to the user in en. Work and communicate with other agents in English.\n\nLance \`${odd}/when-free.sh npm run test:ui\`.\n`);
  // {kept} in what a role may read: the folder where what the lanes set apart for the user is kept.
  writeFileSync(join(odd, 'agents.conf'), `${readFileSync(join(odd, 'agents.conf'), 'utf8')}read = {kept}\n\n[lanes]\nkept_in = ~/kept for him\n`);
  const may = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; permissions_env dev; printf "%s\\n" "$ORCH_READ"', '_', odd], { env: { ...clean, ORCH_REPO: second, ORCH_CONF: join(odd, 'agents.conf') }, encoding: 'utf8' });
  assert.equal(may.stdout, `${join(dir, 'kept for him')}\n`, may.stderr);
  // A prompt that is not there is an error, never an empty prompt handed to a model.
  const missing = spawnSync('bash', ['-c', 'set -euo pipefail; . "$1/lib/common.sh"; prompt_text "$1/prompts/absent.md"; echo reached', '_', odd], { env: { ...clean, ORCH_REPO: second, ORCH_CONF: join(odd, 'agents.conf') }, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(missing.stdout, /reached/);
  // No project named anywhere and the tool sits in no repository: every script stops and says so, none works on
  // « wherever it was started from ».
  const nowhere = spawnSync('bash', ['-c', 'set -euo pipefail; . "$1/lib/common.sh"; echo reached', '_', odd], { env: { ...clean, XDG_CONFIG_HOME: join(dir, 'empty') }, cwd: ORCH_HOME, encoding: 'utf8' });
  assert.notEqual(nowhere.status, 0);
  assert.match(nowhere.stderr, /no project is named/);
  assert.doesNotMatch(nowhere.stdout, /reached/);
  // The prompt of the project, when it has one, is the one handed.
  writeFileSync(join(first, '.cleared', 'prompts', 'dev.md'), 'Projet : `{orch}/when-free.sh`.\n');
  assert.match(told({ ORCH_REPO: first, ORCH_CONF: join(odd, 'agents.conf') }), new RegExp(`\\nProjet : \`${odd.replace(/[|&]/g, '\\$&')}/when-free\\.sh\`\\.\\n$`));
});


test('a tool that is the whole of its repository updates itself too, and its services are installed again when they change', () => {
  const home = scratch('orch-root-');
  const remote = join(home, 'remote.git');
  const checkout = join(home, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, checkout], { stdio: 'ignore' });
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  mkdirSync(join(checkout, 'serve'), { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'self-update.sh'), checkout]);
  writeFileSync(join(checkout, 'agents.conf'), '[update]\nself = yes\n');
  writeFileSync(join(checkout, 'serve', 'install.sh'), `#!/usr/bin/env bash\necho installed >> "${join(home, 'installed')}"\n`, { mode: 0o755 });
  git(checkout, 'checkout', '-q', '-b', 'main');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'the tool');
  git(checkout, 'push', '-q', 'origin', 'main');
  const elsewhere = join(home, 'elsewhere');
  execFileSync('git', ['clone', '-q', remote, elsewhere], { stdio: 'ignore' });
  const live = (path, text) => { mkdirSync(dirname(join(elsewhere, path)), { recursive: true }); writeFileSync(join(elsewhere, path), text, { mode: 0o755 }); git(elsewhere, 'add', '.'); git(elsewhere, 'commit', '-q', '-m', `change ${path}`); git(elsewhere, 'push', '-q', 'origin', 'HEAD:main'); return git(elsewhere, 'rev-parse', 'HEAD').trim(); };
  const env = { ...process.env, ORCH_REPO: join(home, 'project'), ORCH_STATE_DIR: join(home, 'state'), ORCH_CONF: join(checkout, 'agents.conf') };
  const update = () => spawnSync(join(checkout, 'self-update.sh'), [], { env, encoding: 'utf8' });
  const installed = () => { try { return readFileSync(join(home, 'installed'), 'utf8').trim().split('\n').length; } catch { return 0; } };
  const second = live('step.sh', '#!/usr/bin/env bash\necho two\n');
  const taken = update();
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(git(checkout, 'rev-parse', 'HEAD').trim(), second);
  assert.equal(installed(), 0);
  live('serve/unit.service', '[Unit]\n');
  assert.equal(update().status, 0);
  assert.equal(installed(), 1, 'what runs the services changed');
  // A script of the new version the shell cannot read is still refused, at the root as elsewhere.
  live('step.sh', '#!/usr/bin/env bash\nif then fi (\n');
  const refused = update();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /step\.sh/);
});


test('the installer of the services names one project for the machine and never two wakes: it refuses a tool that would work on itself, a second project, and a machine where another Cleared wake is active', () => {
  const home = scratch('orch-install-');
  const tool = join(home, 'tool');
  const bin = join(home, 'bin');
  for (const made of [tool, bin]) mkdirSync(made, { recursive: true });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'serve'), tool]);
  writeFileSync(join(tool, 'agents.conf'), '[lanes]\nbase = main\n');
  writeFileSync(join(tool, 'dashboard.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(tool, 'serve', 'check.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'tailscale'), '#!/usr/bin/env bash\necho 100.64.0.1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "$*" >> "${join(home, 'systemctl-calls')}"\nstate=$(cat "${join(home, 'cleared-wake-state')}" 2>/dev/null || echo absent)\ncase "$*" in\n  *is-enabled*cleared-wake.timer*) echo "$state"; case "$state" in enabled|static) exit 0 ;; *) exit 1 ;; esac ;;\n  *is-enabled*) echo static; exit 0 ;;\n  *is-active*) [ "$state" = enabled ] && exit 0 || exit 3 ;;\n  *show*-p*ActiveState*cleared-wake.service*) echo inactive; exit 0 ;;\nesac\nexit 0\n`, { mode: 0o755 });
  const project = fixtureProject();
  const other = scratch('orch-other-project-');
  execFileSync('git', ['-C', other, 'init', '-q', '-b', 'main']);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), ORCH_GUARD_REF: 'HEAD' };
  const install = (extra = {}) => spawnSync(join(tool, 'serve', 'install.sh'), [], { env: { ...env, ...extra }, encoding: 'utf8' });
  const named = () => { try { return readFileSync(join(home, 'config', 'cleared', 'project'), 'utf8'); } catch { return null; } };
  const calls = () => { try { return readFileSync(join(home, 'systemctl-calls'), 'utf8'); } catch { return ''; } };
  // Nobody named a project and the tool is a repository of its own: it would work on itself. Refused, nothing written.
  execFileSync('git', ['-C', tool, 'init', '-q', '-b', 'main']);
  const alone = install();
  assert.notEqual(alone.status, 0);
  assert.match(alone.stderr, /no project is named/);
  assert.equal(named(), null);
  assert.doesNotMatch(calls(), /enable --now/);
  // A folder that is not a checkout is not a project.
  assert.match(install({ ORCH_REPO: join(home, 'nowhere') }).stderr, /is not a folder of this machine/);
  assert.match(install({ ORCH_REPO: bin }).stderr, /is not a git checkout/);
  // A Cleared timer already wakes on this machine: two wakes would run. Refused, and it says what to do.
  writeFileSync(join(home, 'cleared-wake-state'), 'enabled');
  const twice = install({ ORCH_REPO: project });
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /Cleared wake timer is already active/);
  assert.doesNotMatch(calls(), /enable --now/);
  // Stopped: its timer is « disabled », and the service it started is « static » as any unit a timer starts. That is not waking.
  writeFileSync(join(home, 'cleared-wake-state'), 'disabled');
  // Named: written in the one line a terminal reads and in every unit, and the units are started.
  const done = install({ ORCH_REPO: project });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(named(), `${project}\n`);
  const units = join(home, '.config', 'systemd', 'user');
  for (const unit of readdirSync(units).filter((name) => name.endsWith('.service'))) assert.match(readFileSync(join(units, unit), 'utf8'), new RegExp(`^Environment=ORCH_REPO=${project}$`, 'm'), unit);
  assert.match(readFileSync(join(units, 'cleared-wake.service'), 'utf8'), new RegExp(`^ExecStart=${tool}/wake\\.sh$`, 'm'));
  assert.match(calls(), /enable --now cleared-release-broker\.service cleared-dashboard\.service cleared-dashboard-refresh\.timer cleared-wake\.timer/);
  // Run again for the same project: fine. For another one: refused, the machine already works on one.
  assert.equal(install({ ORCH_REPO: project }).status, 0);
  const second = install({ ORCH_REPO: other });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already works on/);
  assert.equal(named(), `${project}\n`);
  // A path a unit cannot hold as it is: refused, not written half right.
  const spaced = join(home, 'a project');
  mkdirSync(spaced);
  execFileSync('git', ['-C', spaced, 'init', '-q', '-b', 'main']);
  rmSync(join(home, 'config', 'cleared', 'project'));
  assert.match(install({ ORCH_REPO: spaced }).stderr, /cannot be written in a unit/);
});


test('the base is brought into a lane without a model when nothing has to be decided: merged and sent by the rules, its review and the agreement kept; a conflict goes to the lane', () => {
  const { flow, todo, by, there, record, session, stuck, pull, box, lane } = flowBox();
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('base_without_model = no\n', ''));
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const kept = record('X-5');
  mkdirSync(join(kept.worktree, 'server'), { recursive: true });
  writeFileSync(join(kept.worktree, 'server', 'toast.mjs'), 'export const toast = 1;\n');
  execFileSync('git', ['-C', kept.worktree, 'add', 'server/toast.mjs']);
  const done = session('X-5', { commit: 'fix: the toast closes' });
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  flow();
  assert.equal(there('X-5'), false, 'its worktree is closed');
  // The base moves on code, in files the lane did not touch.
  mkdirSync(join(box.repo, 'server'), { recursive: true });
  writeFileSync(join(box.repo, 'server', 'core.mjs'), 'export const x = 1;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: code on the base');
  box.git('push', '-q', 'origin', 'main');
  // The branch of the lane is gone from this checkout (seen live: a lane that took up an older pull request): it is made again from the remote.
  box.git('branch', '-D', 'dev/X-5');
  const merged = flow();
  assert.match(merged.stdout, /X-5: the base is brought in without a model \(#41\)/);
  assert.equal(record('X-5').runs.length, 1, 'no session was opened for it');
  assert.equal(there('X-5'), false, 'nothing is left behind');
  const remoteHead = execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'rev-parse', 'dev/X-5'], { encoding: 'utf8' }).trim();
  assert.notEqual(remoteHead, done.head);
  assert.equal(execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'show', `${remoteHead}:server/core.mjs`], { encoding: 'utf8' }), 'export const x = 1;\n');
  assert.equal(execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'show', `${remoteHead}:server/toast.mjs`], { encoding: 'utf8' }), 'export const toast = 1;\n');
  assert.equal(execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'rev-list', '--parents', '-n', '1', remoteHead], { encoding: 'utf8' }).trim().split(' ').length, 3, 'a merge of the base, nothing else');
  // The base moves again, on the very file of the lane: nothing can be decided without a model.
  writeFileSync(join(box.repo, 'server', 'toast.mjs'), 'export const toast = 2;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: the base changes the same file');
  box.git('push', '-q', 'origin', 'main');
  pull({ headRefOid: remoteHead, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  const conflict = flow();
  assert.match(conflict.stdout, /X-5: opened again \(base:/);
  assert.equal(record('X-5').runs.length, 2);
  assert.match(session('X-5', { commit: null }).prompt, /\| The base branch advanced on code/);
  assert.deepEqual(stuck(), []);
  assert.equal(execFileSync('git', ['-C', box.repo, 'rev-parse', 'dev/X-5'], { encoding: 'utf8' }).trim(), remoteHead, 'the merge git could not make is not left on the branch');
});


test('a base brought in without a model leaves nothing behind when it cannot be sent: the branch is where it was, the refusal is not asked again every minute, and what a dead round left is cleared and never counted as a lane', () => {
  const { flow, todo, by, there, record, session, pull, box, env } = flowBox();
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('base_without_model = no\n', ''));
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const kept = record('X-5');
  mkdirSync(join(kept.worktree, 'server'), { recursive: true });
  writeFileSync(join(kept.worktree, 'server', 'toast.mjs'), 'export const toast = 1;\n');
  execFileSync('git', ['-C', kept.worktree, 'add', 'server/toast.mjs']);
  const done = session('X-5', { commit: 'fix: the toast closes' });
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  flow();
  assert.equal(there('X-5'), false);
  mkdirSync(join(box.repo, 'server'), { recursive: true });
  writeFileSync(join(box.repo, 'server', 'core.mjs'), 'export const x = 1;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: code on the base');
  box.git('push', '-q', 'origin', 'main');
  // The push is refused (here: the remote does not take it).
  const hook = join(box.home, 'remote.git', 'hooks', 'pre-receive');
  mkdirSync(join(box.home, 'remote.git', 'hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const tip = () => execFileSync('git', ['-C', box.repo, 'rev-parse', 'dev/X-5'], { encoding: 'utf8' }).trim();
  const worktrees = () => execFileSync('git', ['-C', box.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const refused = flow();
  assert.doesNotMatch(refused.stdout, /brought in without a model/);
  assert.match(refused.stdout, /X-5: opened again \(base:/, 'the lane takes it');
  assert.doesNotMatch(worktrees(), /\.base-X-5/);
  assert.equal(Object.keys(record('X-5').done).filter((key) => key.startsWith('nobase:')).length, 1, 'tried once for that state of the branch and of the base');
  rmSync(hook);
  // Its session brings the base in itself; the merge of the rules is not found under it.
  const again = session('X-5', { commit: null, bringBase: true });
  assert.equal(execFileSync('git', ['-C', box.repo, 'rev-list', '--count', '--merges', `${done.head}..${again.head}`], { encoding: 'utf8' }).trim(), '1', 'one merge, the one of the session');
  pull({ headRefOid: again.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  flow();
  assert.equal(there('X-5'), false);
  // A round that died in the middle: its worktree, on the branch of the lane, with a merge no remote has.
  writeFileSync(join(box.repo, 'server', 'core.mjs'), 'export const x = 2;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: more code on the base');
  box.git('push', '-q', 'origin', 'main');
  box.git('fetch', '-q', 'origin');
  const spot = join(box.home, 'lanes', '.base-X-5');
  box.git('worktree', 'add', '-q', spot, 'dev/X-5');
  writeFileSync(join(execFileSync('git', ['-C', spot, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), 'base-before'), `${again.head}\n`);
  execFileSync('git', ['-C', spot, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'merge', '-q', '--no-edit', 'origin/main']);
  assert.notEqual(tip(), again.head);
  // It is no lane: it takes no place, and is not the worktree a lane is opened again in.
  const counted = spawnSync('bash', ['-c', '. "$ORCH_HOME/lib/common.sh"; dispatcher_lanes'], { env: { ...env, ORCH_HOME: box.home }, encoding: 'utf8' });
  assert.equal(counted.status, 0, counted.stderr);
  assert.doesNotMatch(counted.stdout, /dev\/X-5/);
  const cleared = flow();
  assert.match(cleared.stdout, /what a round left of a base brought in without a model is cleared \(\.base-X-5\)/);
  assert.match(cleared.stdout, /X-5: the base is brought in without a model \(#41\)/, 'and the round goes on from the branch as it was');
  assert.doesNotMatch(worktrees(), /\.base-X-5/);
  assert.equal(execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'rev-list', '--count', '--merges', `${again.head}..dev/X-5`], { encoding: 'utf8' }).trim(), '1', 'one merge left, the one that was sent');
  // A directory of that name git no longer knows as a worktree goes too; one that cannot be removed is said, and the round goes on.
  const stray = join(box.home, 'lanes', '.base-X-9');
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, '.git'), 'gitdir: /nowhere\n');
  assert.match(flow().stdout, /is cleared \(\.base-X-9\)/);
  assert.throws(() => readdirSync(stray));
  if (process.getuid() !== 0) {
    mkdirSync(join(stray, 'held'), { recursive: true });
    writeFileSync(join(stray, '.git'), 'gitdir: /nowhere\n');
    writeFileSync(join(stray, 'held', 'file'), 'x\n');
    chmodSync(join(stray, 'held'), 0o500);
    const held = flow();
    chmodSync(join(stray, 'held'), 0o700);
    rmSync(stray, { recursive: true, force: true });
    assert.equal(held.status, 0, held.stderr);
    assert.match(held.stdout, /could not be cleared \(.*\.base-X-9\)/);
    assert.match(held.stdout, /X-5: /, 'the lanes are looked at all the same');
  }
  // A merge that is not the one the rules wrote down is somebody's work: it is not taken back.
  const sent = execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'rev-parse', 'dev/X-5'], { encoding: 'utf8' }).trim();
  writeFileSync(join(box.repo, 'server', 'core.mjs'), 'export const x = 3;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: still more code on the base');
  box.git('push', '-q', 'origin', 'main');
  box.git('fetch', '-q', 'origin');
  box.git('worktree', 'add', '-q', spot, 'dev/X-5');
  execFileSync('git', ['-C', spot, 'merge', '-q', '--ff-only', 'origin/dev/X-5']);
  // The tip written down is an older one: this merge does not sit on it.
  writeFileSync(join(execFileSync('git', ['-C', spot, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), 'base-before'), `${again.head}\n`);
  execFileSync('git', ['-C', spot, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'merge', '-q', '--no-edit', 'origin/main']);
  const theirs = tip();
  assert.notEqual(theirs, sent);
  pull({ headRefOid: sent, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.match(flow().stdout, /is cleared \(\.base-X-5\)/);
  assert.equal(tip(), theirs, 'the branch still has it');
});
