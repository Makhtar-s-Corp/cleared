import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { flowBox, sandbox, scratch } from './support.mjs';

// The fields of a process after its name: [0] its state, [2] its process group, [3] its session, [19] its start.
const stat = (pid) => {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return text.slice(text.lastIndexOf(') ') + 2).trim().split(' '); } catch { return null; }
};
const alive = (pid) => { const fields = stat(pid); return Boolean(fields) && fields[0] !== 'Z'; };
const argv = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((done) => setTimeout(done, 100)); }
  return check();
};
const stopGroup = (pid) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } };

// A sandbox whose project runs its sessions with no terminal at all, on a host where Orca is not even installed.
// systemd-run answers as a host with no user manager, unless FAKE_SCOPE asks it to run the scope (it then only
// writes down how it was asked).
function noneBox({ adapter = 'none' } = {}) {
  const box = sandbox();
  rmSync(join(box.home, 'bin', 'orca'));
  writeFileSync(join(box.home, 'agents.conf'), `${readFileSync(join(box.home, 'agents.conf'), 'utf8')}\n[terminal]\nadapter = ${adapter}\n`);
  writeFileSync(join(box.home, 'bin', 'systemd-run'), `#!/usr/bin/env bash
[ -n "\${FAKE_SCOPE:-}" ] || exit 1
printf '%s\\n' "$*" >> "${join(box.home, 'systemd-run-calls')}"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`, { mode: 0o755 });
  // Not in the sandbox, and in no folder of the PATH either: an Orca installed on the host is out of reach.
  const env = { ...box.env, PATH: [join(box.home, 'bin'), ...process.env.PATH.split(':').filter((dir) => dir && !existsSync(join(dir, 'orca')))].join(':') };
  delete env.INVOCATION_ID;
  assert.notEqual(spawnSync('bash', ['-c', 'command -v orca'], { env }).status, 0, 'no orca on the PATH');
  return { ...box, env };
}

// A run folder whose session holds on (its model "works" for 30 s), opened by a parent shell that holds a lock
// of its own (as a wake does) and ends at once.
function openHeld(box, extra = {}) {
  const runDir = scratch('orch-run-');
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
  writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-held\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n');
  const lock = join(box.home, 'parent.lock');
  const opened = spawnSync('bash', ['-c', `exec 8> "${lock}"; flock 8; . "${join(box.home, 'lib', 'common.sh')}"; terminal open "$1" "X-1 · dev · a" "${join(box.home, 'lane-run.sh')} $2" "$2" X-1`, 'parent', box.repo, runDir],
    { env: { ...box.env, FAKE_LEAVES: 'sleep 30', ...extra }, encoding: 'utf8', timeout: 15000 });
  return { opened, runDir, lock, handle: opened.stdout.trim() };
}
const closeWith = (box, handle) => spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal close "$1"`, 'close', handle], { env: box.env, encoding: 'utf8' });


test('[terminal] adapter is orca when the project says nothing, and a name with no adapter stops a spawn before anything is made', () => {
  const box = sandbox();
  const loaded = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; conf_get terminal adapter; terminal_adapter; echo "$terminal_loaded"`], { env: box.env, encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(loaded.stdout.trim().split('\n'), ['orca', 'orca']);

  const wrong = noneBox({ adapter: 'tmux' });
  const dry = spawnSync(join(wrong.home, 'spawn-lane.sh'), ['dev', 'X-2', '--dry-run'], { env: wrong.env, encoding: 'utf8' });
  assert.equal(dry.status, 1, 'a dry run says it too');
  assert.match(dry.stderr, /unknown \[terminal\] adapter "tmux"/);
  assert.equal(existsSync(join(wrong.state, 'ledger.db')), false, 'nothing was made, not even the ledger');
  const run = spawnSync(join(wrong.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none'], { env: wrong.env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unknown \[terminal\] adapter "tmux".*\(known: none orca\)/);
  assert.equal(existsSync(join(wrong.home, 'lanes', 'dev-X-2')), false, 'no worktree is made for a session that cannot start');
  assert.equal(existsSync(join(wrong.state, 'runs')), false);
});


test('[terminal] adapter = none starts the session detached: it outlives its parent, holds none of its locks, leads a session of its own, writes to the run log, and is the process cleared status checks', async (t) => {
  const box = noneBox();
  const { opened, runDir, lock, handle } = openHeld(box);
  assert.equal(opened.status, 0, opened.stderr);
  const [kind, pid, start, boot] = handle.split(':');
  t.after(() => stopGroup(Number(pid)));
  assert.equal(kind, 'none');
  assert.equal(start, stat(pid)[19], 'the handle holds the start of the process');
  assert.equal(boot, bootId());
  assert.deepEqual(readFileSync(join(runDir, 'terminal.none'), 'utf8').trim().split('\n'), [handle, box.repo]);
  // Its parent is gone; the session is not, and is the leader of its own session and process group.
  assert.ok(alive(pid));
  assert.equal(stat(pid)[3], pid);
  assert.equal(stat(pid)[2], pid);
  // The lock its parent held is not held by the session.
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0);
  // What it prints lands in its run folder.
  assert.ok(await until(() => { try { return /── dev\/X-1 · dev · a \(first: m1\) ──/.test(readFileSync(join(runDir, 'terminal.log'), 'utf8')); } catch { return false; } }));
  // The process is the one cleared status looks for: the run script under bash, the number in the pid file.
  assert.ok(await until(() => existsSync(join(runDir, 'pid'))));
  assert.equal(readFileSync(join(runDir, 'pid'), 'utf8').trim(), pid);
  assert.deepEqual(argv(pid).slice(0, 3).map((word, index) => (index === 0 ? word.split('/').at(-1) : word)), ['bash', join(box.home, 'lane-run.sh'), runDir]);
  // Closed: the session and the harness it started (its process group) are stopped.
  let harness = 0;
  assert.ok(await until(() => (harness = Number(spawnSync('pgrep', ['-g', pid, '-x', 'sleep'], { encoding: 'utf8' }).stdout.trim())) > 0), 'the model of the session is in its process group');
  assert.equal(closeWith(box, handle).status, 0);
  assert.ok(await until(() => !alive(pid) && !alive(harness), 10000), 'the session and its harness are stopped');
});


test('[terminal] adapter = none signals only the process its handle names: another start, another boot, or a process that is no Cleared session is left alone', async (t) => {
  const box = noneBox();
  const { handle } = openHeld(box);
  const [, pid, start, boot] = handle.split(':');
  t.after(() => stopGroup(Number(pid)));
  // The same number with another start: the system gave it to another process.
  assert.equal(closeWith(box, `none:${pid}:${Number(start) + 1}:${boot}`).status, 0);
  assert.equal(closeWith(box, `none:${pid}:${start}:another-boot`).status, 0);
  assert.equal(closeWith(box, 'term_1').status, 0);
  await new Promise((done) => setTimeout(done, 300));
  assert.ok(alive(pid), 'nothing was signalled');
  // A process that started right, but is not a session of Cleared.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  assert.ok(await until(() => argv(other.pid)[0] === 'sleep', 5000));
  assert.equal(closeWith(box, `none:${other.pid}:${stat(other.pid)[19]}:${bootId()}`).status, 0);
  await new Promise((done) => setTimeout(done, 300));
  assert.ok(alive(other.pid), 'a process that is no Cleared session is never signalled');
  // The right handle closes it.
  assert.equal(closeWith(box, handle).status, 0);
  assert.ok(await until(() => !alive(pid), 10000));
});


// What this proves is how systemd-run is asked (a scope of the user's manager, collected) and that the process it
// hands over is the session. That a real oneshot unit ends without taking the session along needs a user manager,
// which the checks do not have: it is not covered here.
test('[terminal] adapter = none asks systemd-run --user for a scope of its own when it can, and the session is the process it runs', (t) => {
  const box = noneBox();
  const { opened, handle } = openHeld(box, { FAKE_SCOPE: '1' });
  assert.equal(opened.status, 0, opened.stderr);
  const pid = Number(handle.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.match(readFileSync(join(box.home, 'systemd-run-calls'), 'utf8'), /^--user --scope --collect --quiet --description=Cleared: X-1 · dev · a -- bash -c /m);
  assert.ok(alive(pid));
  assert.equal(stat(pid)[3], String(pid));
});


test('[terminal] adapter = none with no scope to be had: the session starts with setsid alone, and started by a unit it says it may end with it', (t) => {
  const box = noneBox();
  const unscoped = openHeld(box, { INVOCATION_ID: 'a-unit' });
  const other = Number(unscoped.handle.split(':')[1]);
  t.after(() => stopGroup(other));
  assert.match(unscoped.opened.stderr, /no scope of its own: it may end with the unit that started it/);
  assert.match(readFileSync(join(unscoped.runDir, 'terminal.log'), 'utf8'), /no scope of its own/);
  assert.ok(alive(other));
});


test('with [terminal] adapter = none and no Orca on the host, spawn-lane, wake and kill-lane run their sessions; adopt-lane refuses, and tell-lane keeps the message for the next session', async () => {
  const box = noneBox();
  const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none', '--wait'], { env: box.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(spawned.status, 0, spawned.stderr);
  const lane = JSON.parse(spawned.stdout);
  assert.match(lane.terminal, /^none:\d+:\d+:/);
  assert.equal(readFileSync(join(lane.run_dir, 'terminal.handle'), 'utf8').trim(), lane.terminal);
  assert.equal(readFileSync(join(lane.run_dir, 'exit-code'), 'utf8').trim(), '0');
  assert.match(readFileSync(join(lane.run_dir, 'terminal.log'), 'utf8'), /── dev\/X-2 · dev · a \(first: m1\) ──/);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(db.prepare("select lane, outcome from runs where lane = 'dev/X-2'").all().map((row) => ({ ...row })), [{ lane: 'dev/X-2', outcome: 'done' }]);
  db.close();

  // No terminal to write down, nor to type in; a lane of the dispatcher is still told by its ticket.
  const adopted = spawnSync(join(box.home, 'adopt-lane.sh'), ['dev-X-2', lane.terminal], { env: box.env, encoding: 'utf8' });
  assert.equal(adopted.status, 1);
  assert.match(adopted.stderr, /\[terminal\] adapter = none: sessions run without a terminal.*tell-lane\.sh <ticket>/);
  const told = spawnSync(join(box.home, 'tell-lane.sh'), ['X-2', '-'], { env: box.env, encoding: 'utf8', input: 'Pense aux tests.' });
  assert.equal(told.status, 0, told.stderr);
  assert.match(told.stdout, /handed to it at its next session/);

  const killed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-2', '--force'], { env: box.env, encoding: 'utf8' });
  assert.equal(killed.status, 0, killed.stderr);
  assert.equal(existsSync(lane.worktree), false);

  // The wake starts the session of the lead the same way, and is over before it.
  const issue = (comments) => writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify([{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }]));
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8', timeout: 60000 });
  issue([]);
  assert.equal(wake().status, 0);
  issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }]);
  const woke = wake();
  assert.equal(woke.status, 0, woke.stderr);
  const runDir = woke.stdout.trim().split('\n').at(-1);
  assert.match(readFileSync(join(runDir, 'terminal.handle'), 'utf8'), /^none:\d+:\d+:/);
  assert.ok(await until(() => existsSync(join(runDir, 'exit-code'))), 'the session of the lead ran to its end');
  assert.match(readFileSync(join(runDir, 'terminal.log'), 'utf8'), /── release\/lead · release · a/);
  assert.equal(existsSync(join(box.home, 'orca-calls')), false);
});


test('with [terminal] adapter = none, closing a worktree stops its live session whatever path names it: a lanes root behind a link, the path git gives', async (t) => {
  const box = noneBox();
  const real = join(box.home, 'real-lanes');
  const linked = join(box.home, 'linked-lanes');
  mkdirSync(real);
  symlinkSync(real, linked);
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace(`root = ${join(box.home, 'lanes')}`, `root = ${linked}`));
  const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-4', '--comment-on', 'none'], { env: { ...box.env, FAKE_LEAVES: 'sleep 30' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(spawned.status, 0, spawned.stderr);
  const lane = JSON.parse(spawned.stdout);
  const pid = Number(lane.terminal.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.equal(lane.worktree, join(linked, 'dev-X-4'));
  assert.match(spawnSync('git', ['-C', box.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout, new RegExp(`^worktree ${join(real, 'dev-X-4')}$`, 'm'), 'git names it by the resolved path');
  let harness = 0;
  assert.ok(await until(() => (harness = Number(spawnSync('pgrep', ['-g', String(pid), '-x', 'sleep'], { encoding: 'utf8' }).stdout.trim())) > 0), 'the session is at work');
  const killed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-4', '--force'], { env: box.env, encoding: 'utf8' });
  assert.equal(killed.status, 0, killed.stderr);
  assert.ok(await until(() => !alive(pid) && !alive(harness), 10000), 'the session and its harness were stopped before their worktree went');
  assert.equal(existsSync(join(real, 'dev-X-4')), false);
});


test('[Linear adapter] the default terminal adapter names the worktree in Orca and links it to its Linear issue', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[tracker]\nadapter = local\n', '[tracker]\nadapter = linear\n'));
  const run = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(box.home, 'orca-named'), 'utf8'), /^--worktree path:.*\/dev-X-2 --display-name X-2 · Titre de X-2 --linear-issue X-2 --comment dev · a · opened by Cleared$/m);
});


test('with [terminal] adapter = none, talk.sh holds the conversation in the terminal it is run from, and refuses to start one from none', () => {
  const box = noneBox();
  // No terminal: nothing is held, the mark that keeps the wakes back is taken away, the way to run it is said.
  const blind = spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(blind.status, 1);
  assert.match(blind.stderr, /run it by hand in a terminal: cd .*release-lead && .*talk-run\.sh /);
  assert.equal(existsSync(join(box.state, 'wake', 'talk')), false);
  // From a terminal (here: the one the test names), the conversation is held there and talk.sh returns at its end.
  const held = spawnSync(join(box.home, 'talk.sh'), [], { env: { ...box.env, ORCH_TTY: '/dev/null' }, encoding: 'utf8' });
  assert.equal(held.status, 0, held.stderr);
  assert.equal(readFileSync(join(box.state, 'talked'), 'utf8').split('\n')[0], 'first');
  const runDir = held.stdout.trim().split('\n').at(-1);
  assert.equal(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '0');
  assert.equal(existsSync(join(box.state, 'wake', 'talk')), false, 'the conversation is over: its mark is gone');
  assert.equal(existsSync(join(box.home, 'orca-calls')), false);
});


test('with [terminal] adapter = none, the harness still starts under [security] agent_user, through sudo -n', () => {
  const box = noneBox();
  const bin = join(box.home, 'bin');
  // The real adapter of a harness, the account of the agents, and a sudo that only writes down what it is asked.
  writeFileSync(join(box.home, 'adapters', 'claude.sh'), readFileSync(join(ORCH_HOME, 'adapters', 'claude.sh'), 'utf8'), { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(box.home, 'sudo-calls')}"
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
case "$5" in id) exec id -u "$3" ;; test) exit 0 ;; *) exit 1 ;; esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'bwrap'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8')
    .replace('a = first:m1', 'a = claude:m1')
    .replace('[security]\nallow_shared_uid = true\n', `[security]\nallow_shared_uid = true\nagent_user = nobody\nbwrap_path = ${join(bin, 'bwrap')}\n`));
  // The model was seen available a moment ago: no probe.
  mkdirSync(join(box.state, 'models'), { recursive: true });
  writeFileSync(join(box.state, 'models', 'claude.available'), `m1\t${Math.floor(Date.now() / 1000)}\n`);
  const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-3', '--comment-on', 'none', '--wait'], { env: box.env, encoding: 'utf8', timeout: 60000 });
  assert.match(spawned.stdout, /"terminal": "none:\d+:\d+:/, spawned.stderr);
  const calls = readFileSync(join(box.home, 'sudo-calls'), 'utf8').trim().split('\n');
  const harness = calls.find((line) => / claude -p --model m1 /.test(line));
  assert.ok(harness, calls.join('\n'));
  assert.match(harness, /^-n -u nobody -- env /);
});


// Closing a lane ends its whole tree (issue #93). Under [security] agent_user the harness runs under another
// account: the service cannot signal it, and sudo stops passing signals on once it is gone. Here one account plays
// both: the sudo writes down what it is asked and runs it, and the harness ignores its parent and SIGTERM, so that
// only a SIGKILL of its group ends it. What this proves is the wiring (which group is signalled, from which
// account, in which order, and that nothing is left or that what is left is said); that the agents' account really
// reaches its own processes is proved on the host (see the recipe of the pull request).
function agentBox(box) {
  const bin = join(box.home, 'bin');
  writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(box.home, 'sudo-calls')}"
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
shift 4
# The agents' account says one of its processes is still in the group, whatever is done to it.
if [ -n "\${FAKE_AGENT_HOLDS:-}" ] && [ "$1" = sh ]; then echo held; exit 0; fi
# A sudo that hangs, whatever it is asked.
[ -z "\${FAKE_SUDO_HANGS:-}" ] || exec sleep 60
# A sudo that does not answer for the agents' account when it is asked what is left (it still signals).
if [ -n "\${FAKE_AGENT_SILENT:-}" ] && [ "$1" = sh ]; then exit 1; fi
exec "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'harness'), `#!/usr/bin/env bash
trap '' TERM HUP INT
echo $$ >> "${join(box.home, 'harness-pids')}"
while :; do sleep 0.2; done
`, { mode: 0o755 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[security]\nallow_shared_uid = true\n', '[security]\nallow_shared_uid = true\nagent_user = nobody\n'));
  const env = { ...box.env, FAKE_LEAVES: 'harness', ORCH_STOP_GRACE: '1' };
  const harnesses = () => { try { return readFileSync(join(box.home, 'harness-pids'), 'utf8').trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
  const calls = () => { try { return readFileSync(join(box.home, 'sudo-calls'), 'utf8').trim().split('\n'); } catch { return []; } };
  const group = (pgid) => spawnSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).stdout.trim();
  return { ...box, env, harnesses, calls, group };
}
const stopAll = (box) => { for (const pid of box.harnesses()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };


test('[terminal] adapter = none under [security] agent_user: closing a session ends its whole process group, a harness that ignores its parent and SIGTERM included, from both accounts', async (t) => {
  const box = agentBox(noneBox());
  t.after(() => stopAll(box));
  const { opened, handle } = openHeld(box, { FAKE_LEAVES: 'harness' });
  assert.equal(opened.status, 0, opened.stderr);
  const pid = Number(handle.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.ok(await until(() => box.harnesses().length === 1), 'the harness is at work');
  const [harness] = box.harnesses();
  assert.equal(stat(harness)[2], String(pid), 'in the process group of the session');
  const closed = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal close "$1"`, 'close', handle], { env: box.env, encoding: 'utf8' });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(alive(harness), false, 'the harness is gone when the close returns');
  assert.equal(box.group(pid), '', 'nothing of its group is left');
  // The agents' account was asked to signal that group, and that one only: TERM, then KILL once the grace was over.
  const signalled = box.calls().filter((line) => /^-n -u nobody -- kill /.test(line));
  assert.deepEqual(signalled, [`-n -u nobody -- kill -TERM -- -${pid}`, `-n -u nobody -- kill -KILL -- -${pid}`]);
  assert.ok(box.calls().some((line) => line.startsWith('-n -u nobody -- sh -c ') && line.endsWith(` cleared-check ${pid}`)), 'and what it still holds was checked');
});


test('[terminal] adapter = none under [security] agent_user: close-worktree and kill-lane end the harness before the worktree goes; a run script that died is no shield for what it left', async (t) => {
  const box = agentBox(noneBox());
  t.after(() => stopAll(box));
  const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-6', '--comment-on', 'none'], { env: box.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(spawned.status, 0, spawned.stderr);
  const lane = JSON.parse(spawned.stdout);
  const pid = Number(lane.terminal.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.ok(await until(() => box.harnesses().length === 1), 'the harness is at work');
  const [harness] = box.harnesses();
  const closed = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal close-worktree "$1"`, 'close', lane.worktree], { env: box.env, encoding: 'utf8' });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(alive(harness), false);
  assert.equal(box.group(pid), '');
  assert.ok(existsSync(lane.worktree), 'closing the terminals of a worktree removes nothing');

  // The run script is gone (killed by hand, or by a close that could not reach the agents' account) and the
  // harness is left in its group: kill-lane still finds it by the group of the handle, and ends it.
  const again = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-7', '--comment-on', 'none'], { env: box.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(again.status, 0, again.stderr);
  const other = JSON.parse(again.stdout);
  const leader = Number(other.terminal.split(':')[1]);
  t.after(() => stopGroup(leader));
  assert.ok(await until(() => box.harnesses().length === 2));
  const left = box.harnesses()[1];
  process.kill(leader, 'SIGKILL');
  assert.ok(await until(() => !alive(leader), 5000));
  assert.ok(alive(left), 'the harness outlived its run script');
  const killed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-7', '--force'], { env: box.env, encoding: 'utf8' });
  assert.equal(killed.status, 0, killed.stderr);
  assert.equal(alive(left), false, 'no process of the lane remains');
  assert.equal(box.group(leader), '');
  assert.ok(box.calls().includes(`-n -u nobody -- kill -TERM -- -${leader}`), box.calls().join('\n'));
  assert.equal(existsSync(other.worktree), false);
});


test('[terminal] adapter = none under [security] agent_user: what the agents\' account still holds after SIGKILL is said, and kill-lane leaves the worktree, its branch and its runs', async (t) => {
  const box = agentBox(noneBox());
  t.after(() => stopAll(box));
  const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-8', '--comment-on', 'none'], { env: box.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(spawned.status, 0, spawned.stderr);
  const lane = JSON.parse(spawned.stdout);
  const pid = Number(lane.terminal.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.ok(await until(() => box.harnesses().length === 1));
  const killed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-8', '--force'], { env: { ...box.env, FAKE_AGENT_HOLDS: '1' }, encoding: 'utf8' });
  assert.equal(killed.status, 1);
  assert.match(killed.stderr, new RegExp(`the session ${lane.terminal} is not over: processes of nobody are still in its group ${pid} after SIGKILL`));
  assert.match(killed.stderr, /kill-lane\.sh: a session of dev\/X-8 could not be stopped: its worktree, its branch and its runs are left as they are/);
  assert.ok(existsSync(lane.worktree), 'the worktree stays');
  assert.equal(spawnSync('git', ['-C', box.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/dev/X-8']).status, 0, 'and its branch');
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.equal(db.prepare("select count(*) n from events where kind = 'session_not_stopped'").get().n, 1);
  assert.deepEqual(db.prepare("select outcome from runs where lane = 'dev/X-8'").all().map((row) => row.outcome), ['running'], 'its run is not said killed');
  db.close();
});


// The bubblewrap prefix of the agents' sessions, run for real with harmless programs: when what started it dies
// (sudo, under a session that is closed), nothing of the sandbox is left, not even a process that left its process
// group. Without the options of the prefix, the control shows the sandbox outliving its parent.
const bwrapWorks = spawnSync('/usr/bin/bwrap', ['--dev-bind', '/', '/', '--die-with-parent', '--unshare-pid', '--proc', '/proc', '--', 'true']).status === 0;
test('the bubblewrap prefix of agent_mount_args takes the whole sandbox down with its parent (real bubblewrap)', { skip: bwrapWorks ? false : 'needs /usr/bin/bwrap and user namespaces' }, async (t) => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[security]\nallow_shared_uid = true\n', '[security]\nallow_shared_uid = true\nbwrap_path = /usr/bin/bwrap\n'));
  const outside = scratch('orch-no-git-');
  const built = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; agent_mount_args; printf '%s\\n' "\${AGENT_MOUNT_ARGS[@]}"`], { cwd: outside, env: box.env, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const prefix = built.stdout.trim().split('\n');
  assert.deepEqual(prefix, ['/usr/bin/bwrap', '--dev-bind', '/', '/', '--die-with-parent', '--unshare-pid', '--proc', '/proc']);
  const sleeps = (tag) => readdirSync('/proc').filter((pid) => /^\d+$/.test(pid) && alive(pid) && argv(pid)[0] === 'sleep' && argv(pid)[1]?.startsWith(tag)).map(Number);
  const trial = async (words) => {
    const tag = `${4000 + Math.floor(Math.random() * 1000)}.${process.pid}`;
    // The parent stands for sudo: bwrap is its child and it stays; inside, the harness has a child in its group
    // and one that left it (setsid).
    const parent = spawn('bash', ['-c', `"$@" -- bash -c "sleep ${tag}1 & setsid sleep ${tag}2 & exec sleep ${tag}3"; :`, 'parent', ...words], { stdio: 'ignore', detached: true });
    t.after(() => { for (const pid of sleeps(tag)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
    assert.ok(await until(() => sleeps(tag).length === 3, 10000), 'the sandbox is at work');
    process.kill(parent.pid, 'SIGKILL');
    await until(() => sleeps(tag).length === 0, 5000);
    return sleeps(tag);
  };
  assert.deepEqual(await trial(prefix), [], 'nothing of the sandbox is left');
  assert.notDeepEqual(await trial(['/usr/bin/bwrap', '--dev-bind', '/', '/']), [], 'without them, the sandbox outlives its parent');
});


test('[terminal] adapter = none under [security] agent_user: the flow stops a session that runs too long, harness included, before it opens the lane again', async (t) => {
  const flowed = flowBox({ maxLanes: 1 });
  const { box, todo, by, record } = flowed;
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 9\nsession_hours = 1')}\n[terminal]\nadapter = none\n`);
  // No user manager here: the sessions start with setsid alone.
  writeFileSync(join(box.home, 'bin', 'systemd-run'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const agent = agentBox(box);
  t.after(() => stopAll(agent));
  const env = { ...flowed.env, ORCH_STOP_GRACE: '1' };
  todo(['X-5']);
  by('X-5', 0);
  const opened = spawnSync(join(box.home, 'flow-lanes.sh'), [], { env: { ...env, FAKE_LEAVES: 'harness' }, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  assert.ok(await until(() => agent.harnesses().length === 1), `the session of X-5 is at work\n${opened.stdout}${opened.stderr}`);
  const [harness] = agent.harnesses();
  const kept = record('X-5');
  const runDir = join(box.state, 'runs', kept.runs.at(-1).run);
  const pid = Number(readFileSync(join(runDir, 'terminal.handle'), 'utf8').split(':')[1]);
  t.after(() => stopGroup(pid));
  kept.runs.at(-1).at = new Date(Date.now() - 61 * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(kept));
  const stopped = spawnSync(join(box.home, 'flow-lanes.sh'), [], { env, encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /X-5: its session runs for more than 1 hours: stopped\n/);
  assert.equal(alive(harness), false, 'its harness is gone');
  assert.equal(agent.group(pid), '', 'nothing of its group is left');
  assert.ok(agent.calls().includes(`-n -u nobody -- kill -TERM -- -${pid}`), agent.calls().join('\n'));
  assert.equal(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '124');
  // The lane is opened again: its new session is waited for before the files of the test go.
  const next = join(box.state, 'runs', record('X-5').runs.at(-1).run);
  assert.notEqual(next, runDir);
  assert.ok(await until(() => existsSync(join(next, 'exit-code'))), 'the session opened again ran to its end');
});


// The project lead under [security] agent_user (issue #94): the acting lead (permissions release-live) runs without
// bubblewrap, from the project's main checkout; the lead that observes, and every lead of an install without
// agent_user, keep the lane of the lead. The real claude adapter runs a fake CLI through a sudo and a bubblewrap
// that write down what they are asked and pass the command on (the CLI is found first on the PATH sudo is handed).
function leadBox({ agentUser, live }) {
  const box = noneBox();
  const bin = join(box.home, 'bin');
  writeFileSync(join(box.home, 'adapters', 'claude.sh'), readFileSync(join(ORCH_HOME, 'adapters', 'claude.sh'), 'utf8'), { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(box.home, 'sudo-calls')}"
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
case "$5" in id) exec id -u "$3" ;; test) exit 0 ;; esac
shift 4
words=()
for word in "$@"; do case "$word" in PATH=*) words+=("PATH=${bin}:/usr/bin:/bin") ;; *) words+=("$word") ;; esac; done
exec "\${words[@]}"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'bwrap'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(box.home, 'bwrap-calls')}"
while [ "$1" != -- ]; do shift; done; shift
exec "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash
pwd -P >> "${join(box.home, 'claude-cwds')}"
printf '%s\\n' '{"type":"assistant","message":{"model":"m1","content":[{"type":"text","text":"ok"}]}}'
printf '%s\\n' '{"type":"result","is_error":false,"result":"## Report\\n\\nNothing to do.\\n","total_cost_usd":0,"modelUsage":{}}'
`, { mode: 0o755 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8')
    .replace('a = first:m1', 'a = claude:m1')
    .replace('live = no\n', `live = ${live}\n`)
    .replace('[security]\nallow_shared_uid = true\n', `[security]\nallow_shared_uid = true\n${agentUser ? `agent_user = nobody\nbwrap_path = ${join(bin, 'bwrap')}\n` : ''}`));
  // The model was seen available a moment ago: no probe.
  mkdirSync(join(box.state, 'models'), { recursive: true });
  writeFileSync(join(box.state, 'models', 'claude.available'), `m1\t${Math.floor(Date.now() / 1000)}\n`);
  const read = (name) => { try { return readFileSync(join(box.home, name), 'utf8'); } catch { return ''; } };
  // One wake that only reads, then one woken by a comment of the user: it starts a session of the lead.
  const wake = async () => {
    const issue = (comments) => writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify([{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }]));
    const once = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8', timeout: 60000 });
    issue([]);
    assert.equal(once().status, 0);
    issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }]);
    const woke = once();
    assert.equal(woke.status, 0, woke.stderr);
    const runDir = woke.stdout.trim().split('\n').at(-1);
    assert.ok(await until(() => existsSync(join(runDir, 'exit-code'))), 'the session of the lead ran to its end');
    return { runDir, log: readFileSync(join(runDir, 'terminal.log'), 'utf8'), where: readFileSync(join(runDir, 'terminal.none'), 'utf8').trim().split('\n')[1] };
  };
  return { ...box, read, wake };
}


test('with [security] agent_user, the acting project lead starts in the main checkout, without bubblewrap, and its lane is neither made nor touched', async () => {
  const box = leadBox({ agentUser: true, live: 'yes' });
  const { runDir, log, where } = await box.wake();
  assert.doesNotMatch(log, /release role must run from the service-owned main checkout/);
  assert.equal(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '0', log);
  assert.equal(where, box.repo, 'the session was opened in the main checkout');
  assert.deepEqual(box.read('claude-cwds').trim().split('\n'), [box.repo], 'and the CLI ran there');
  const started = box.read('sudo-calls').split('\n').filter((line) => / claude -p /.test(line));
  assert.equal(started.length, 1, box.read('sudo-calls'));
  assert.match(started[0], /^-n -u nobody -- env .* claude -p /);
  assert.doesNotMatch(started[0], /bwrap/, 'no bubblewrap around the acting lead');
  assert.equal(box.read('bwrap-calls'), '');
  assert.equal(existsSync(join(box.home, 'lanes', 'release-lead')), false, 'no worktree is made for it');
  assert.equal(spawnSync('git', ['-C', box.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/release/lead']).status, 1, 'nor its branch');
  assert.equal(spawnSync('git', ['-C', box.repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '', 'the main checkout is left as it was');
});


test('with [security] agent_user, the project lead that observes still runs in its lane, through bubblewrap', async () => {
  const box = leadBox({ agentUser: true, live: 'no' });
  const { runDir, log, where } = await box.wake();
  const lane = join(box.home, 'lanes', 'release-lead');
  assert.equal(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '0', log);
  assert.equal(where, lane);
  assert.deepEqual(box.read('claude-cwds').trim().split('\n'), [lane]);
  assert.match(box.read('bwrap-calls'), /--dev-bind \/ \/ --die-with-parent --unshare-pid --proc \/proc --ro-bind .* -- claude -p /);
});


test('without [security] agent_user, the acting project lead still runs in its lane', async () => {
  const box = leadBox({ agentUser: false, live: 'yes' });
  const { runDir, log, where } = await box.wake();
  const lane = join(box.home, 'lanes', 'release-lead');
  assert.equal(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '0', log);
  assert.equal(where, lane);
  assert.deepEqual(box.read('claude-cwds').trim().split('\n'), [lane]);
  assert.equal(box.read('sudo-calls'), '');
});


test('the project\'s main checkout is never closed nor removed as the worktree of a lane, by any terminal adapter, and kill-lane refuses a lane checked out there', async (t) => {
  for (const adapter of ['none', 'orca']) {
    const box = adapter === 'none' ? noneBox() : sandbox();
    // A session at work in the main checkout, as the acting lead's is.
    const held = adapter === 'none' ? openHeld(box) : null;
    const pid = held ? Number(held.handle.split(':')[1]) : 0;
    if (held) t.after(() => stopGroup(pid));
    const verb = (name, path) => spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal "$1" "$2"`, 'verb', name, path], { env: box.env, encoding: 'utf8' });
    for (const path of [box.repo, `${box.repo}/`, join(box.repo, '..', 'repo')]) {
      for (const name of ['close-worktree', 'remove-worktree']) {
        const refused = verb(name, path);
        assert.equal(refused.status, 1, `${adapter} ${name} ${path}`);
        assert.match(refused.stderr, /is the project's main checkout, not the worktree of a lane: it is neither closed nor removed/);
      }
    }
    assert.ok(existsSync(join(box.repo, '.git')), 'the main checkout is there');
    assert.equal(spawnSync('git', ['-C', box.repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '');
    if (held) assert.ok(alive(pid), 'its session was not stopped');
    if (adapter === 'orca') assert.equal(existsSync(join(box.home, 'orca-closed')), false, 'Orca was asked nothing');
    // A lane's branch checked out in the main checkout by hand: kill-lane leaves it.
    box.git('checkout', '-q', '-b', 'dev/X-9');
    const killed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-9', '--force'], { env: box.env, encoding: 'utf8' });
    assert.equal(killed.status, 1);
    assert.match(killed.stderr, /dev\/X-9 is checked out in the project's main checkout .* which is never closed/);
    assert.ok(existsSync(join(box.repo, '.git')));
  }
});


test('[terminal] adapter = none under [security] agent_user: when the run script is gone and the service sees nothing of its group (/proc with hidepid), the agents\' account is asked; what it holds, or its silence, keeps the worktree', async (t) => {
  const box = agentBox(noneBox());
  t.after(() => stopAll(box));
  const open = async (ticket) => {
    const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', ticket, '--comment-on', 'none'], { env: box.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(spawned.status, 0, spawned.stderr);
    const lane = JSON.parse(spawned.stdout);
    const pid = Number(lane.terminal.split(':')[1]);
    t.after(() => stopGroup(pid));
    const count = box.harnesses().length;
    assert.ok(await until(() => box.harnesses().length === count + 1));
    // The whole group ends here, as far as the service can see: what the agents' account still holds there is
    // only what its sudo says (a /proc mounted with hidepid shows the service nothing of it).
    process.kill(-pid, 'SIGKILL');
    assert.ok(await until(() => box.group(pid) === '', 5000));
    return { lane, pid };
  };
  const held = await open('X-10');
  const kept = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-10', '--force'], { env: { ...box.env, FAKE_AGENT_HOLDS: '1' }, encoding: 'utf8' });
  assert.equal(kept.status, 1, kept.stderr);
  assert.match(kept.stderr, new RegExp(`the session ${held.lane.terminal} is not over: processes of nobody are still in its group ${held.pid} after SIGKILL`));
  assert.ok(existsSync(held.lane.worktree), 'the worktree stays');
  assert.ok(box.calls().includes(`-n -u nobody -- kill -KILL -- -${held.pid}`), 'the group the agents\' account holds was signalled');
  // The agents' account does not answer: nobody can say the session is over.
  const silent = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-10', '--force'], { env: { ...box.env, FAKE_AGENT_SILENT: '1' }, encoding: 'utf8' });
  assert.equal(silent.status, 1);
  assert.match(silent.stderr, new RegExp(`the session ${held.lane.terminal} cannot be said over: its run script is gone and sudo -n -u nobody could not say whether processes of nobody are left in its group ${held.pid}`));
  assert.ok(existsSync(held.lane.worktree));
  // It says nothing is left: the lane closes.
  const closed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-10', '--force'], { env: box.env, encoding: 'utf8' });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(existsSync(held.lane.worktree), false);
});


test('[terminal] adapter = none under [security] agent_user: a sudo that does not answer is said even by a caller that stops at the first error (set -e)', async (t) => {
  const box = agentBox(noneBox());
  t.after(() => stopAll(box));
  const { opened, handle } = openHeld(box, { FAKE_LEAVES: 'harness' });
  assert.equal(opened.status, 0, opened.stderr);
  const pid = Number(handle.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.ok(await until(() => box.harnesses().length === 1));
  const strict = spawnSync('bash', ['-c', `set -e; . "${join(box.home, 'lib', 'common.sh')}"; terminal_adapter; none_stop_group "$1" "$2"; echo over`, 'strict', String(pid), handle],
    { env: { ...box.env, FAKE_AGENT_SILENT: '1' }, encoding: 'utf8' });
  assert.equal(strict.status, 1);
  assert.equal(strict.stdout, '');
  assert.match(strict.stderr, new RegExp(`the session ${handle} is not over: sudo -n -u nobody could not stop and check the processes of nobody in its group ${pid}; its worktree is left as it is`));
});


// What the agents' account is asked runs for real here: the sudo of agentBox only passes the command on (no answer
// is made up), against a group whose leader is really gone and whose member is really left.
test('[terminal] adapter = none: the questions put to the agents\' account read its /proc for real: a group left by its leader is held, one with an older member is foreign, a number in use is taken, an ended one is free', async (t) => {
  const box = agentBox(noneBox());
  const ask = (fn, ...args) => spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal_adapter; ${fn} "$@"`, 'ask', ...args], { env: box.env, encoding: 'utf8' }).stdout.trim();
  // A leader of its own session and group, with a member in the background; the leader ends when told.
  const leader = spawn('setsid', ['sh', '-c', 'sleep 300 & read word'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => stopGroup(leader.pid));
  assert.ok(await until(() => alive(leader.pid) && stat(leader.pid)[2] === String(leader.pid) && box.group(leader.pid).split('\n').length === 2, 5000), 'the leader and its member are there');
  const start = Number(stat(leader.pid)[19]);
  assert.equal(ask('none_agent_holds', String(leader.pid), 'nobody'), 'held');
  leader.stdin.end();
  assert.ok(await until(() => !alive(leader.pid), 5000), 'the leader is gone');
  const [member] = box.group(leader.pid).split('\n').map(Number);
  assert.ok(alive(member), 'its member is left in its group');
  assert.equal(stat(member)[3], String(leader.pid), 'in its session');
  assert.equal(ask('none_agent_orphans', String(leader.pid), String(start), 'nobody'), 'held');
  assert.equal(ask('none_agent_orphans', String(leader.pid), String(Number(stat(member)[19]) + 1), 'nobody'), 'foreign', 'a member older than the leader is not of its session');
  assert.equal(ask('none_agent_orphans', String(process.pid), '0', 'nobody'), 'taken', 'a number a process has is not a group left behind');
  assert.equal(ask('none_agent_holds', String(leader.pid), 'nobody'), 'held');
  process.kill(member, 'SIGKILL');
  assert.ok(await until(() => box.group(leader.pid) === '', 5000));
  assert.equal(ask('none_agent_orphans', String(leader.pid), String(start), 'nobody'), 'free');
  assert.equal(ask('none_agent_holds', String(leader.pid), 'nobody'), 'free');
});


test('[terminal] adapter = none under [security] agent_user: a sudo that hangs is bounded (CLEARED_SUDO_WAIT) and counts as one that does not answer, never as a group found empty', async (t) => {
  const box = agentBox(noneBox());
  t.after(() => stopAll(box));
  const { opened, handle } = openHeld(box, { FAKE_LEAVES: 'harness' });
  assert.equal(opened.status, 0, opened.stderr);
  const pid = Number(handle.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.ok(await until(() => box.harnesses().length === 1));
  const env = { ...box.env, FAKE_SUDO_HANGS: '1', CLEARED_SUDO_WAIT: '1' };
  const began = Date.now();
  const closed = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal close "$1"`, 'close', handle], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(closed.status, 1, closed.stderr);
  assert.match(closed.stderr, new RegExp(`the session ${handle} is not over: sudo -n -u nobody could not stop and check the processes of nobody in its group ${pid}`));
  assert.ok(Date.now() - began < 30000, `bounded: ${Date.now() - began} ms`);
  // A group left by its leader: asked of a sudo that hangs, no answer at all (the close then fails, said).
  const asked = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal_adapter; none_agent_orphans "$1" 0 nobody`, 'ask', String(pid)], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(asked.stdout, '');
  assert.notEqual(asked.status, 0);
});
