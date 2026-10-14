// The door of the heavy commands (when-free.sh) under [security] agent_user (#98): the teams' account takes it
// with flock on a file it may only read, outside Cleared's state, and learns whether the host is free from a
// status the service writes next to it; it never asks GitHub nor the state. Without agent_user nothing changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { sandbox, flowBox, laneWithRemote, scratch } from './support.mjs';

const holdThen = 'exec 9< "$1"; flock 9; shift; "$@"';

// A sandbox whose project names heavy commands; with agentUser, the agents' account is « nobody » and the door is
// a file of a service-owned folder outside the state. The team's own PATH has a gh and a sudo that only write
// down that they were called: a team under agent_user can use neither.
function doorBox({ agentUser = false, heavyLock = agentUser, wait = 0 } = {}) {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  const door = join(box.home, 'door');
  mkdirSync(door);
  const lock = join(door, 'heavy.lock');
  let conf = readFileSync(confPath, 'utf8').replace('[lanes]\n', `[lanes]\nheavy_commands = echo screens, sleep 3\nheavy_wait_minutes = ${wait}\n${heavyLock ? `heavy_lock = ${lock}\n` : ''}`);
  if (agentUser) conf = conf.replace('[security]\nallow_shared_uid = true\n', '[security]\nallow_shared_uid = true\nagent_user = nobody\n');
  writeFileSync(confPath, conf);
  mkdirSync(join(box.home, 'proc-none'), { recursive: true });
  const env = { ...box.env, HOME: box.home, ORCH_PROC_DIR: join(box.home, 'proc-none') };
  const teamBin = join(box.home, 'team-bin');
  mkdirSync(teamBin);
  for (const name of ['gh', 'sudo']) writeFileSync(join(teamBin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${join(box.home, 'team-calls')}"\nexit 1\n`, { mode: 0o755 });
  const teamEnv = { ...env, PATH: `${teamBin}:${env.PATH}` };
  const teamCalls = () => (existsSync(join(box.home, 'team-calls')) ? readFileSync(join(box.home, 'team-calls'), 'utf8') : '');
  // (Without agent_user a team asks the host itself, as the service does: its gh is the sandbox's.)
  const heavy = (args, extra = {}) => spawnSync(join(box.home, 'when-free.sh'), args, { env: { ...(agentUser ? teamEnv : env), ...extra }, encoding: 'utf8' });
  const lib = (script, extra = {}) => spawnSync('bash', ['-c', `. "$1/lib/common.sh"; ${script}`, '_', box.home], { env: { ...env, ...extra }, encoding: 'utf8' });
  // What the service writes for the teams: its folder is writable to it for that moment only, then closed again,
  // so that whatever the team does next is done without any right to write there.
  const writeStatus = (extra = {}) => {
    chmodSync(door, 0o755);
    const run = lib('host_status_write', extra);
    if (existsSync(lock)) chmodSync(lock, 0o444);
    chmodSync(door, 0o555);
    assert.equal(run.status, 0, run.stderr);
  };
  const statusPath = join(door, 'heavy.status.json');
  const status = () => JSON.parse(readFileSync(statusPath, 'utf8'));
  return { box, env, teamEnv, door, lock, heavy, lib, writeStatus, status, statusPath, teamCalls };
}

test('without agent_user the door is heavy.lock in the state, the host is asked as before, and no host status is written', () => {
  const { box, heavy, lib, env } = doorBox();
  const lock = join(box.state, 'heavy.lock');
  assert.equal(lib('heavy_lock_path').stdout.trim(), lock);
  assert.equal(heavy(['echo', 'screens']).stdout.trim(), 'screens');
  // Nothing written for teams: they ask the host themselves.
  assert.equal(lib('host_status_write').status, 0);
  assert.deepEqual(readdirSync(box.state).filter((name) => name.endsWith('.status.json')), []);
  // Held by somebody (even through a descriptor opened read-only): it waits, then says so.
  const held = spawnSync('bash', ['-c', holdThen, '_', lock, join(box.home, 'when-free.sh'), 'echo', 'screens'], { env, encoding: 'utf8' });
  assert.equal(held.status, 5);
  assert.match(held.stderr, /the host is not free/);
  // The host is asked, as before: checks running keep the door shut.
  const busy = heavy(['echo', 'screens'], { FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request"}]' });
  assert.equal(busy.status, 5);
  assert.equal(busy.stdout, '');
});

test('without agent_user, [lanes] heavy_lock moves the door only: the host is still asked live', () => {
  const { lock, heavy, lib, env, box } = doorBox({ heavyLock: true });
  assert.equal(lib('heavy_lock_path').stdout.trim(), lock);
  assert.equal(heavy(['echo', 'screens']).stdout.trim(), 'screens');
  assert.ok(existsSync(lock), 'the service creates a missing door');
  assert.equal(spawnSync('bash', ['-c', holdThen, '_', lock, join(box.home, 'when-free.sh'), 'echo', 'screens'], { env, encoding: 'utf8' }).status, 5);
  assert.equal(heavy(['echo', 'screens'], { FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request"}]' }).status, 5);
});

test('under agent_user a team takes the door read-only, runs when the host status says free, and never asks GitHub, sudo or the state', () => {
  const { box, lock, door, heavy, writeStatus, status, statusPath, teamCalls } = doorBox({ agentUser: true });
  // No status yet: unknown is not free. Nothing runs, and it says why.
  const missing = heavy(['echo', 'screens']);
  assert.equal(missing.status, 5);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^when-free\.sh: the host status the service writes for the teams .* is missing or unreadable/m);
  assert.match(missing.stderr, /"echo screens" was not run/);
  // The service writes it: booleans and times only.
  writeStatus();
  assert.deepEqual(Object.keys(status()).sort(), ['checks_starting', 'ci_running', 'deployment_settling', 'free', 'github_down', 'host_read', 'written_at', 'written_epoch']);
  assert.equal(status().free, true);
  assert.equal(statSync(statusPath).mode & 0o777, 0o644);
  // The door and its folder cannot be written by anyone here: read is all the team needs.
  assert.equal(statSync(lock).mode & 0o777, 0o444);
  assert.equal(statSync(door).mode & 0o777, 0o555);
  const run = heavy(['echo', 'screens', 'now']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'screens now');
  // Still only the commands the project names.
  assert.equal(heavy(['echo', 'anything']).status, 1);
  // The state is not where the team looks: its marker of checks starting means nothing to it (the status does).
  writeFileSync(join(box.state, 'checks-starting'), '');
  assert.equal(heavy(['echo', 'screens']).status, 0);
  assert.equal(teamCalls(), '', 'the team asked neither GitHub nor sudo');
});

test('under agent_user a host status that says busy, is stale or cannot be read keeps the door shut (exit 5)', () => {
  const { heavy, writeStatus, statusPath, door, lib } = doorBox({ agentUser: true });
  writeStatus({ FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request"}]' });
  const busy = heavy(['echo', 'screens']);
  assert.equal(busy.status, 5);
  assert.match(busy.stderr, /the host is not free for a heavy command/);
  // Checks the rules have just started (the marker in the state, which only the service reads) make it busy too.
  writeFileSync(join(lib('printf %s "$ORCH_STATE_DIR"').stdout, 'checks-starting'), '');
  writeStatus();
  assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).checks_starting, true);
  assert.equal(heavy(['echo', 'screens']).status, 5);
  execFileSync('touch', ['-d', '3 minutes ago', join(lib('printf %s "$ORCH_STATE_DIR"').stdout, 'checks-starting')]);
  writeStatus();
  assert.equal(heavy(['echo', 'screens']).status, 0);
  // Written more than five minutes ago (the wake stopped): unknown, so not free.
  const old = JSON.parse(readFileSync(statusPath, 'utf8'));
  chmodSync(door, 0o755);
  writeFileSync(statusPath, JSON.stringify({ ...old, written_epoch: old.written_epoch - 6 * 60 }));
  const stale = heavy(['echo', 'screens']);
  assert.equal(stale.status, 5);
  assert.equal(stale.stdout, '');
  assert.match(stale.stderr, /is older than 5 minutes or unreadable/);
  // From the future, or not a status at all: the same.
  writeFileSync(statusPath, JSON.stringify({ ...old, written_epoch: old.written_epoch + 3600 }));
  assert.equal(heavy(['echo', 'screens']).status, 5);
  writeFileSync(statusPath, 'free');
  assert.match(heavy(['echo', 'screens']).stderr, /older than 5 minutes or unreadable/);
});

test('under agent_user the door must be outside the state: one left in it is refused with the setting to change', () => {
  const { heavy, lib, box } = doorBox({ agentUser: true, heavyLock: false });
  assert.equal(lib('heavy_lock_path').stdout.trim(), join(box.state, 'heavy.lock'));
  const run = heavy(['echo', 'screens']);
  assert.equal(run.status, 5);
  assert.match(run.stderr, /is in Cleared's state .*\[lanes\] heavy_lock must name a file outside it/);
  // And nothing is written for the teams there.
  assert.equal(lib('host_status_write').status, 0);
  assert.deepEqual(readdirSync(box.state).filter((name) => name.endsWith('.status.json')), []);
});

test('under agent_user a door held by the service, or by another team, keeps a team waiting; freed, the team runs', async () => {
  const { lock, heavy, writeStatus, teamEnv, box } = doorBox({ agentUser: true });
  writeStatus();
  // The service holds it (a check start, a host Codex session): the team waits, then says so.
  const held = spawnSync('bash', ['-c', holdThen, '_', lock, join(box.home, 'when-free.sh'), 'echo', 'screens'], { env: teamEnv, encoding: 'utf8' });
  assert.equal(held.status, 5);
  assert.match(held.stderr, /the host is not free/);
  // Two teams: while one runs its heavy command (it keeps the door for its whole run), the other is kept out.
  const firstTeam = spawn(join(box.home, 'when-free.sh'), ['sleep', '3'], { env: teamEnv, stdio: 'ignore' });
  const firstDone = new Promise((resolve) => firstTeam.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = heavy(['echo', 'screens']);
  assert.equal(second.status, 5, 'the second team is kept out while the first one runs');
  assert.equal(await firstDone, 0);
  assert.equal(heavy(['echo', 'screens']).status, 0, 'and goes once the first one is done');
});

test('under agent_user a team waits for a door held by another, and runs once it is let go', { timeout: 90000 }, async () => {
  const { lock, writeStatus, teamEnv, box } = doorBox({ agentUser: true, wait: 1 });
  writeStatus();
  const holder = spawn('bash', ['-c', 'exec 9< "$1"; flock 9; sleep 3', '_', lock], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const started = Date.now();
  const team = spawn(join(box.home, 'when-free.sh'), ['echo', 'screens'], { env: teamEnv });
  let out = '';
  team.stdout.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => team.on('exit', resolve));
  holder.kill();
  assert.equal(code, 0);
  assert.equal(out.trim(), 'screens');
  assert.ok(Date.now() - started >= 2500, 'it waited for the door');
});

test('flock on a descriptor opened read-only takes the exclusive lock and keeps a writer out (real flock, no fake)', async () => {
  const dir = scratch('cleared-real-flock-');
  const lock = join(dir, 'heavy.lock');
  writeFileSync(lock, '');
  chmodSync(lock, 0o444);
  // The reader cannot write the file, and takes the lock all the same.
  const reader = spawn('bash', ['-c', 'exec 8< "$1" && flock -n 8 && echo held && sleep 3', '_', lock]);
  await new Promise((resolve) => reader.stdout.once('data', resolve));
  assert.notEqual(spawnSync('bash', ['-c', 'exec 9>> "$1"', '_', lock]).status, 0, 'the file cannot be opened for writing');
  chmodSync(lock, 0o644);
  // A writer (the service, who may write it) is kept out while the reader holds it.
  assert.equal(spawnSync('bash', ['-c', 'exec 9>> "$1" && flock -n 9', '_', lock]).status, 1);
  reader.kill();
  await new Promise((resolve) => reader.on('exit', resolve));
  assert.equal(spawnSync('bash', ['-c', 'exec 9>> "$1" && flock -n 9', '_', lock]).status, 0, 'free again once the reader is gone');
  // And the other way round: a writer holding it keeps a reader out.
  const writer = spawn('bash', ['-c', 'exec 9>> "$1" && flock -n 9 && echo held && sleep 3', '_', lock]);
  await new Promise((resolve) => writer.stdout.once('data', resolve));
  chmodSync(lock, 0o444);
  assert.equal(spawnSync('bash', ['-c', 'exec 8< "$1" && flock -n 8', '_', lock]).status, 1);
  writer.kill();
  await new Promise((resolve) => writer.on('exit', resolve));
});

test('checks the rules start hold the door while they are said to the teams: a team then finds the host busy; a team holding the door keeps them back', () => {
  const { flow, todo, by, session, pull, box, env } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  const door = join(box.home, 'door');
  mkdirSync(door);
  const lock = join(door, 'heavy.lock');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[lanes]\n', `[lanes]\nheavy_commands = echo screens\nheavy_wait_minutes = 0\nheavy_lock = ${lock}\n`));
  const ready = () => { try { return readFileSync(join(box.home, 'pr-ready'), 'utf8').trim().split('\n'); } catch { return []; } };
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const done = session('X-5');
  assert.equal(done.run.status, 0, done.run.stderr);
  pull({ headRefOid: done.head });
  // A team holds the door (read-only, as under agent_user): the checks wait.
  writeFileSync(lock, '');
  chmodSync(lock, 0o444);
  assert.equal(spawnSync('bash', ['-c', holdThen, '_', lock, join(box.home, 'flow-lanes.sh')], { env, encoding: 'utf8' }).status, 0);
  assert.deepEqual(ready(), [], 'the door is held by a team');
  // Under agent_user, the checks that start are written for the teams before the door is let go.
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[security]\nallow_shared_uid = true\n', '[security]\nallow_shared_uid = true\nagent_user = nobody\n'));
  assert.match(flow().stdout, /#41 is taken out of draft/);
  assert.deepEqual(ready(), ['41']);
  const status = JSON.parse(readFileSync(join(door, 'heavy.status.json'), 'utf8'));
  assert.equal(status.checks_starting, true);
  assert.equal(status.free, false);
  const team = spawnSync(join(box.home, 'when-free.sh'), ['echo', 'screens'], { env, encoding: 'utf8' });
  assert.equal(team.status, 5);
  assert.match(team.stderr, /the host is not free/);
  // And the door itself was let go.
  assert.equal(spawnSync('bash', ['-c', 'exec 8< "$1" && flock -n 8', '_', lock]).status, 0);
});

test('a host Codex session under agent_user holds the door from the service, and names it through sudo so its own heavy commands do not wait on it', () => {
  const lane = laneWithRemote('dev/X-98', null);
  const { box } = lane;
  const dir = scratch('cleared-codex-door-');
  const door = join(dir, 'door');
  mkdirSync(door);
  const lock = join(door, 'heavy.lock');
  // sudo and bubblewrap pass the command on (sudo resets the environment, as the real one does); codex says whether
  // the door is held, and runs a heavy command through the door.
  writeFileSync(join(dir, 'sudo'), `#!/usr/bin/env bash
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
user=$3; shift 4
case "$1" in id) exec id -u "$user" ;; test) exit 0 ;; env) shift; exec env -i HOME="$HOME" "$@" ;; *) exec "$@" ;; esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'bwrap'), `#!/usr/bin/env bash
while [ "$1" != -- ]; do shift; done; shift
[ "$1" != codex ] || shift
exec "${join(dir, 'codex')}" "$@"
`, { mode: 0o755 });
  writeFileSync(join(dir, 'codex'), `#!/usr/bin/env bash
echo "slot=\${CLEARED_HEAVY_SLOT:-}" > "${join(dir, 'seen')}"
(flock -n 7 && echo door=free || echo door=held) 7< "$CLEARED_HEAVY_SLOT" >> "${join(dir, 'seen')}"
PATH="${process.env.PATH}" "${join(ORCH_HOME, 'when-free.sh')}" echo screens >> "${join(dir, 'seen')}" 2>&1
previous=; for arg in "$@"; do [ "$previous" != --output-last-message ] || printf 'Codex answer\\n' > "$arg"; previous=$arg; done
cat > /dev/null
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Codex answer"}}'
`, { mode: 0o755 });
  const conf = readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8')
    .replace('agent_user =\n', 'agent_user = nobody\n').replace('bwrap_path = /usr/bin/bwrap', `bwrap_path = ${join(dir, 'bwrap')}`)
    .replace('heavy_wait_minutes = 30', `heavy_wait_minutes = 0\nheavy_lock = ${lock}`)
    .replace(/heavy_commands = .*\n/, 'heavy_commands = echo screens\n');
  assert.match(conf, /agent_user = nobody/);
  writeFileSync(join(dir, 'agents.conf'), conf);
  const prompt = join(dir, 'prompt.md');
  writeFileSync(prompt, 'Say hello.\n');
  mkdirSync(join(box.home, 'proc-none'), { recursive: true });
  const run = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; permissions_env dev; adapter_env codex; exec "$1/adapters/codex.sh" run --model m --prompt-file "$2" --report "$3" --usage "$4"',
    '_', ORCH_HOME, prompt, join(dir, 'report.md'), join(dir, 'usage.json')], { cwd: lane.path, encoding: 'utf8',
    env: { ...box.env, HOME: box.home, ORCH_PROC_DIR: join(box.home, 'proc-none'), PATH: `${dir}:${box.env.PATH}`, CLEARED_REPO: box.repo, CLEARED_CONF: join(dir, 'agents.conf'), CLEARED_STATE_DIR: box.state, ORCH_LANE: 'dev/X-98' } });
  assert.equal(run.status, 0, `${run.stderr}\n${existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : ''}`);
  const seen = readFileSync(join(dir, 'seen'), 'utf8');
  assert.match(seen, new RegExp(`^slot=${lock}$`, 'm'));
  assert.match(seen, /^door=held$/m, 'the session holds the door for its whole run');
  assert.match(seen, /^screens$/m, 'its heavy command did not wait on the door its own session holds');
  assert.equal(spawnSync('bash', ['-c', 'exec 8< "$1" && flock -n 8', '_', lock]).status, 0, 'let go when the session ends');
});
