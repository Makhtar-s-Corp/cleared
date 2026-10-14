import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { join, relative } from 'node:path';
import { ORCH_HOME, parseConf } from '../lib/conf.mjs';
import { forgeEnv, forgeSettings, forgeToken } from '../lib/forge.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { laneWithRemote, scratch } from './support.mjs';

// What the fake GitHub hands out: an installation token that must be seen by gh and git, and nowhere else.
const TOKEN = 'ghs_forgeTestInstallationToken0123456789';
const BOT = 'cleared-test[bot]';
const BOT_EMAIL = `98765+${BOT}@users.noreply.github.com`;
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function appKey(dir, mode = 0o600) {
  const key = join(dir, 'github-app.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode });
  chmodSync(key, mode);
  return key;
}
const forgeSection = (key) => `[forge]\nadapter = github\napp_id = 123\ninstallation_id = 456\napp_private_key_file = ${key}\napp_login = ${BOT}\napp_user_id = 98765\n`;

// A lane whose work leaves through the real scripts, with a fake GitHub around them: gh and the token endpoint
// (curl) write down what they were given, git records what a push would authenticate with, and the account has an
// ambient GitHub token and an ambient git credential that must not be used once an app is configured.
function forgeLane({ forge = true, keyMode = 0o600 } = {}) {
  const lane = laneWithRemote('dev/X-1', null);
  const { box } = lane;
  const bin = join(box.home, 'bin');
  const key = appKey(box.home, keyMode);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(box.home, 'curl-args')}"
cat > /dev/null
[ -z "\${FAKE_CURL_FAIL:-}" ] || { echo 'curl: (22) The requested URL returned error: 403' >&2; exit 22; }
printf '{"token":"${TOKEN}","expires_at":"%s"}\\n' "$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)"
`, { mode: 0o755 });
  renameSync(join(bin, 'gh'), join(bin, 'gh-original'));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "\${GH_TOKEN:-}" "\${GITHUB_TOKEN:-}" "$*" >> "${join(box.home, 'gh-seen')}"
exec "${join(bin, 'gh-original')}" "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = push ]; then
    { env | grep -E '^(GIT_CONFIG_|GH_TOKEN|GITHUB_TOKEN|GIT_AUTHOR|GIT_COMMITTER)' || true; } >> "${join(box.home, 'git-push-env')}"
    printf 'protocol=https\\nhost=github.com\\npath=example/project.git\\n\\n' | "${realGit}" credential fill >> "${join(box.home, 'git-credential')}" 2>&1 || echo "fill failed" >> "${join(box.home, 'git-credential')}"
    break
  fi
done
exec "${realGit}" "$@"
`, { mode: 0o755 });
  // The account's own git credential, as gh auth setup-git would have left it.
  writeFileSync(join(box.home, '.gitconfig'), '[credential]\n\thelper = "!f() { echo username=ambient; echo password=AMBIENT-PASSWORD; }; f"\n');
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8')}\n[adapter.first]\ncommits = no\nrunner = container\n${forge ? forgeSection(key) : ''}`);
  const env = { ...box.env, HOME: box.home, GH_TOKEN: 'ambient-gh-token', GITHUB_TOKEN: 'ambient-github-token', GIT_TERMINAL_PROMPT: '0' };
  const read = (name) => { try { return readFileSync(join(box.home, name), 'utf8'); } catch { return ''; } };
  return { ...lane, bin, key, env, read, confPath };
}

// One session of the lane: the fake model leaves a change, the dispatcher commits it, pushes and opens the pull request.
function session(lane, extra = {}) {
  const runDir = scratch('cleared-forge-run-');
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
  writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-forge\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n');
  const run = spawnSync(join(lane.box.home, 'lane-run.sh'), [runDir], { cwd: lane.path,
    env: { ...lane.env, FAKE_LEAVES: 'echo work > work.txt', ...extra }, encoding: 'utf8' });
  return { run, comment: readFileSync(join(runDir, 'comment.md'), 'utf8') };
}

// A script of the tool, run as the dispatcher runs them: lib/common.sh first.
const script = (lane, body, extra = {}, input = undefined) => spawnSync('bash', ['-c', `. "${join(lane.box.home, 'lib', 'common.sh')}"\n${body}`],
  { env: { ...lane.env, ...extra }, encoding: 'utf8', input, cwd: lane.box.repo });
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map((name) => join(dir, String(name))).filter((path) => statSync(path).isFile());
const author = (lane) => execFileSync(realGit, ['--git-dir', lane.remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'dev/X-1'], { encoding: 'utf8' }).trim();

test('without [forge], gh and git use the ambient credential exactly as before, and no token is minted', () => {
  const lane = forgeLane({ forge: false });
  const { run, comment } = session(lane);
  assert.equal(run.status, 0, run.stderr);
  assert.match(comment, /Pull request opened or updated: #41/);
  const seen = lane.read('gh-seen').trim().split('\n');
  assert.ok(seen.length >= 2, seen.join('\n'));
  for (const line of seen) assert.match(line, /^ambient-gh-token\|ambient-github-token\|/);
  // (The settings the test runner itself may carry in GIT_CONFIG_* are left as they are.)
  assert.doesNotMatch(lane.read('git-push-env'), /forge\.mjs|github\.com|GIT_AUTHOR|GIT_COMMITTER/, 'no git setting nor identity is added');
  assert.match(lane.read('git-push-env'), /^GH_TOKEN=ambient-gh-token$/m);
  assert.match(lane.read('git-credential'), /password=AMBIENT-PASSWORD/);
  assert.equal(author(lane), 'dispatcher <dispatcher@localhost>|dispatcher <dispatcher@localhost>');
  assert.equal(lane.read('curl-args'), '');
  assert.equal(existsSync(join(lane.box.state, 'forge')), false);
  assert.deepEqual(forgeEnv(parseConf(readFileSync(lane.confPath, 'utf8')), { A: '1' }), { A: '1' });
});

test('with [forge], gh gets the installation token, a push authenticates through the helper as x-access-token, and the dispatcher commits as the bot', () => {
  const lane = forgeLane();
  const { run, comment } = session(lane);
  assert.equal(run.status, 0, run.stderr);
  assert.match(comment, /Pull request opened or updated: #41/);
  assert.ok(lane.onRemote().some((line) => line.startsWith('dev/X-1 ')));
  // gh: the app's token, in its environment, for every call; never the ambient one, never in its arguments.
  const seen = lane.read('gh-seen').trim().split('\n');
  assert.ok(seen.some((line) => line.includes('pr create')), seen.join('\n'));
  for (const line of seen) {
    const [token, github, args] = line.split('|');
    assert.equal(token, TOKEN);
    assert.equal(github, TOKEN);
    assert.ok(!args.includes(TOKEN));
  }
  // git: the helper named in GIT_CONFIG_* answers for github.com, and the account's own helper is dropped.
  const credential = lane.read('git-credential');
  assert.match(credential, /^username=x-access-token$/m);
  assert.match(credential, new RegExp(`^password=${TOKEN}$`, 'm'));
  assert.doesNotMatch(credential, /AMBIENT/);
  const pushEnv = lane.read('git-push-env');
  assert.match(pushEnv, /^GIT_CONFIG_VALUE_\d+=!.*lib\/forge\.mjs' credential$/m);
  assert.match(pushEnv, /^GIT_CONFIG_KEY_\d+=url\.https:\/\/github\.com\/\.insteadOf$/m);
  assert.ok(!pushEnv.includes(TOKEN), 'the token is not in the environment git or the script runs with');
  assert.doesNotMatch(pushEnv, /^(GH_TOKEN|GITHUB_TOKEN)=/m, 'the ambient GitHub token is dropped once an app is configured');
  // The commit the dispatcher made after the session carries the app's identity.
  assert.equal(author(lane), `${BOT} <${BOT_EMAIL}>|${BOT} <${BOT_EMAIL}>`);
  // One token for the whole session (several gh calls and a push), asked for with the JWT on stdin only.
  const asked = lane.read('curl-args').trim().split('\n');
  assert.deepEqual(asked, ['--config - https://api.github.com/app/installations/456/access_tokens']);
  // Kept where only the service account reads it.
  const cache = join(lane.box.state, 'forge', 'installation-token.json');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  assert.equal(statSync(join(lane.box.state, 'forge')).mode & 0o777, 0o700);
  // Nowhere else: not in what the scripts printed, not in the ledger, not in any other file of the state or the lane.
  assert.ok(!`${run.stdout}${run.stderr}`.includes(TOKEN));
  for (const file of [...filesUnder(lane.box.state), ...filesUnder(lane.path).filter((path) => !path.includes('/.git/'))]) {
    if (file === cache) continue;
    assert.ok(!readFileSync(file).includes(TOKEN), `the token is in ${relative(lane.box.home, file)}`);
  }
});

test('the installation token is reused within its hour and renewed five minutes before it ends, from the service-owned cache', () => {
  const state = scratch('cleared-forge-state-');
  const conf = parseConf(forgeSection(appKey(state)));
  let clock = Date.parse('2026-10-14T08:00:00Z');
  let minted = 0;
  const request = (url) => {
    assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
    minted += 1;
    return { token: `token-${minted}`, expires_at: new Date(clock + 60 * 60_000).toISOString() };
  };
  const ask = () => forgeToken(conf, { state, now: () => clock, request }).token;
  assert.equal(ask(), 'token-1');
  clock += 30 * 60_000;
  assert.equal(ask(), 'token-1', 'another process, half an hour later, reads the cache');
  clock += 24 * 60_000;
  assert.equal(ask(), 'token-1');
  clock += 2 * 60_000;
  assert.equal(ask(), 'token-2', 'four minutes left: renewed');
  assert.equal(minted, 2);
  // A cache another account could read or write is not believed: a new token is minted and written privately.
  const cache = join(state, 'forge', 'installation-token.json');
  chmodSync(cache, 0o644);
  assert.equal(ask(), 'token-3');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
});

test('[forge] use_tracker_app = yes lends the GitHub tracker\'s app to the forge, one app for both; without it, other trackers and partial settings, nothing is guessed', () => {
  const keys = 'app_login = cleared-test\napp_id = 11\ninstallation_id = 22\napp_private_key_file = /srv/keys/app.pem\n';
  const tracker = (extra = '[forge]\nuse_tracker_app = yes\n') => parseConf(`[tracker]\nadapter = github\nrepository = example/project\n${keys}${extra}`);
  const shared = forgeSettings(tracker());
  assert.equal(shared.source, 'tracker');
  assert.equal(shared.app_id, '11');
  assert.equal(shared.installation_id, '22');
  assert.equal(shared.login, BOT);
  assert.equal(shared.identity, null, 'no bot user ID: commits keep the local identity');
  assert.deepEqual(forgeSettings(tracker('[forge]\nuse_tracker_app = yes\napp_user_id = 98765\n')).identity, { name: BOT, email: BOT_EMAIL });
  // An installation of the GitHub tracker that has not opted in keeps its ambient forge credential.
  assert.equal(forgeSettings(tracker('')), null);
  assert.equal(forgeSettings(tracker('[forge]\nuse_tracker_app = no\n')), null);
  // [forge] keys win over the tracker's.
  assert.equal(forgeSettings(tracker(forgeSection('/srv/keys/forge.pem'))).app_private_key_file, '/srv/keys/forge.pem');
  // Neither: the ambient credential.
  assert.equal(forgeSettings(parseConf(`[tracker]\nadapter = local\n${keys}`)), null);
  assert.equal(forgeSettings(parseConf('[tracker]\nadapter = local\n[forge]\nadapter = github\n')), null);
  assert.throws(() => forgeSettings(parseConf(`[tracker]\nadapter = local\n${keys}[forge]\nuse_tracker_app = yes\n`)), /use_tracker_app = yes needs \[tracker\] adapter = github/);
  assert.throws(() => forgeSettings(parseConf('[tracker]\nadapter = github\n[forge]\nuse_tracker_app = yes\n')), /\[tracker\] app_id is missing/);
  assert.throws(() => forgeSettings(tracker('[forge]\nuse_tracker_app = true\n')), /use_tracker_app must be yes or no/);
  assert.throws(() => forgeSettings(parseConf('[forge]\napp_id = 1\napp_private_key_file = /srv/k.pem\napp_login = x[bot]\napp_user_id = 2\n')), /\[forge\] installation_id is missing/);
  assert.throws(() => forgeSettings(parseConf('[forge]\nadapter = gitlab\n')), /unknown \[forge\] adapter/);
  assert.throws(() => forgeSettings(parseConf('[forge]\napp_id = 1\ninstallation_id = 2\napp_private_key_file = relative.pem\napp_login = x[bot]\napp_user_id = 2\n')), /absolute/);
  assert.throws(() => forgeSettings(parseConf('[forge]\napp_id = 1\ninstallation_id = 2\napp_private_key_file = /srv/k.pem\napp_login = x[bot]\n')), /\[forge\] app_user_id is missing/);
});

test('the GitHub tracker\'s app is the forge\'s only once [forge] use_tracker_app = yes: an existing installation is unchanged on upgrade', () => {
  const lane = forgeLane({ forge: false });
  writeFileSync(lane.confPath, readFileSync(lane.confPath, 'utf8').replace('[tracker]\nadapter = local\n',
    `[tracker]\nadapter = github\nrepository = example/project\napp_login = cleared-test[bot]\napp_id = 123\ninstallation_id = 456\napp_private_key_file = ${lane.key}\n`));
  const before = script(lane, 'echo "$CLEARED_FORGE_MODE"; gh pr list --state open > /dev/null');
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout.trim(), 'ambient');
  assert.match(lane.read('gh-seen'), /^ambient-gh-token\|/);
  assert.equal(lane.read('curl-args'), '');
  writeFileSync(lane.confPath, `${readFileSync(lane.confPath, 'utf8')}\n[forge]\nuse_tracker_app = yes\n`);
  const run = script(lane, 'echo "$CLEARED_FORGE_MODE $CLEARED_FORGE_LOGIN"; gh pr list --state open > /dev/null');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), `app ${BOT}`);
  assert.match(lane.read('gh-seen').trim().split('\n').at(-1), new RegExp(`^${TOKEN}\\|`));
});

test('a token that cannot be minted stops forge calls with the setting to look at, and never falls back to the ambient credential', () => {
  const lane = forgeLane();
  const failing = { FAKE_CURL_FAIL: '1' };
  const listed = script(lane, 'gh pr list --state open', failing);
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /\[forge\] app_id and installation_id/);
  assert.match(listed.stderr, /the ambient credential is not used/);
  assert.equal(lane.read('gh-seen'), '', 'gh is never run without the app token');
  const fill = script(lane, 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', failing);
  assert.notEqual(fill.status, 0);
  assert.doesNotMatch(fill.stdout, /AMBIENT/);
  assert.match(fill.stderr, /forge credential/);
  // Said in the ledger once an hour, without the token or the key.
  const db = openLedger(join(lane.box.state, 'ledger.db'));
  const said = db.prepare("select detail from events where kind = 'forge_token_failed'").all();
  db.close();
  assert.equal(said.length, 1);
  assert.match(said[0].detail, /installation_id/);
  assert.ok(!said[0].detail.includes(lane.key));
  // Another host stays with its own credential: only github.com is the forge's.
  const elsewhere = script(lane, 'printf "protocol=https\\nhost=example.com\\n\\n" | git credential fill', failing);
  assert.match(elsewhere.stdout, /password=AMBIENT-PASSWORD/);
});

test('the account\'s own git configuration cannot send a forge push to SSH: its insteadOf and pushInsteadOf are not read, its identity and other credentials are kept', () => {
  for (const forge of [false, true]) {
    const lane = forgeLane({ forge });
    writeFileSync(join(lane.box.home, '.gitconfig'), `${readFileSync(join(lane.box.home, '.gitconfig'), 'utf8')}[user]\n\tname = Service Account\n[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n\tpushInsteadOf = https://github.com/\n`);
    const clone = scratch('cleared-forge-urls-');
    execFileSync(realGit, ['init', '-q', clone]);
    execFileSync(realGit, ['-C', clone, 'remote', 'add', 'origin', 'https://github.com/example/project.git']);
    execFileSync(realGit, ['-C', clone, 'remote', 'add', 'ssh', 'git@github.com:example/project.git']);
    const urls = script(lane, `git -C '${clone}' remote get-url --push origin; git -C '${clone}' remote get-url origin; git -C '${clone}' remote get-url --push ssh; git -C '${clone}' config user.name`);
    assert.equal(urls.status, 0, urls.stderr);
    if (forge) assert.deepEqual(urls.stdout.trim().split('\n'), ['https://github.com/example/project.git', 'https://github.com/example/project.git',
      'https://github.com/example/project.git', 'Service Account']);
    // The control: without an app, the account's rules apply as they always did.
    else assert.deepEqual(urls.stdout.trim().split('\n'), ['git@github.com:example/project.git', 'git@github.com:example/project.git',
      'git@github.com:example/project.git', 'Service Account']);
  }
});

test('[forge] adapter = github alone, or the example copied as it is, names no app: no node is started for it and nothing changes', () => {
  const lane = forgeLane({ forge: false });
  writeFileSync(join(lane.box.home, 'lib', 'forge.mjs'), `require('fs').writeFileSync(${JSON.stringify(join(lane.box.home, 'forge-ran'))}, 'ran');\n`);
  for (const added of ['[forge]\nadapter = github\n', readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').match(/\[forge\]\n(?:#.*\n|\s*\n)*/)[0]]) {
    writeFileSync(lane.confPath, `${readFileSync(lane.confPath, 'utf8')}\n${added}`);
    const run = script(lane, 'echo "$CLEARED_FORGE_MODE"; gh pr list --state open > /dev/null');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'ambient');
    assert.equal(existsSync(join(lane.box.home, 'forge-ran')), false);
    assert.match(lane.read('gh-seen').trim().split('\n').at(-1), /^ambient-gh-token\|/);
  }
  assert.equal(forgeSettings(parseConf(readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8'))), null);
});

test('serve/install.sh probes that the agents\' account reaches neither the forge\'s app key nor its token', () => {
  const lane = forgeLane();
  const paths = (conf) => { writeFileSync(lane.confPath, conf); return script(lane, 'forge_secret_paths').stdout.trim().split('\n'); };
  const original = readFileSync(lane.confPath, 'utf8');
  const tokens = [join(lane.box.state, 'forge'), join(lane.box.state, 'forge', 'installation-token.json')];
  assert.deepEqual(paths(original), [lane.key, ...tokens]);
  // The tracker's key, once it is lent to the forge.
  const lent = `${original.slice(0, original.indexOf('[forge]\n'))}[forge]\nuse_tracker_app = yes\n`.replace('[tracker]\nadapter = local\n', '[tracker]\nadapter = github\napp_private_key_file = /srv/keys/tracker.pem\n');
  assert.deepEqual(paths(lent), ['/srv/keys/tracker.pem', ...tokens]);
  // The installer reads that list and refuses an agents' account that can read, traverse or write any of it.
  const install = readFileSync(join(ORCH_HOME, 'serve', 'install.sh'), 'utf8');
  const probe = install.slice(install.indexOf('while IFS= read -r secret'), install.indexOf('done < <(forge_secret_paths)'));
  assert.ok(probe.length > 0, 'install.sh does not probe the forge secrets');
  for (const check of ['test -r', 'test -x', 'test -w', 'die ']) assert.ok(probe.includes(check), check);
});

test('when lib/forge.mjs itself cannot run, git stops like gh instead of using the ambient credential', () => {
  const lane = forgeLane();
  writeFileSync(join(lane.box.home, 'lib', 'forge.mjs'), 'process.exit(3);\n');
  writeFileSync(join(lane.box.home, '.gitconfig'), `${readFileSync(join(lane.box.home, '.gitconfig'), 'utf8')}[url "git@github.com:"]\n\tpushInsteadOf = https://github.com/\n`);
  const listed = script(lane, 'gh pr list --state open');
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /\[forge\] could not be read/);
  assert.equal(lane.read('gh-seen'), '');
  const fill = script(lane, 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill');
  assert.notEqual(fill.status, 0);
  assert.doesNotMatch(fill.stdout, /AMBIENT/);
  assert.match(fill.stderr, /\[forge\] could not be read/);
  const clone = scratch('cleared-forge-closed-');
  execFileSync(realGit, ['init', '-q', clone]);
  execFileSync(realGit, ['-C', clone, 'remote', 'add', 'origin', 'git@github.com:example/project.git']);
  assert.equal(script(lane, `git -C '${clone}' remote get-url --push origin`).stdout.trim(), 'https://github.com/example/project.git');
  // Nor does any of it reach a harness.
  const unset = script(lane, 'forge_harness_unset; printf "%s\\n" "${FORGE_UNSET[@]}"');
  for (const name of ['GH_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_GLOBAL']) assert.ok(unset.stdout.split('\n').includes(name), name);
});

test('a key file other accounts can read is refused before anything is asked of GitHub', () => {
  const lane = forgeLane({ keyMode: 0o640 });
  const listed = script(lane, 'gh pr list --state open');
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /\[forge\] app_private_key_file\) must be owned by the Cleared account and have mode 0600/);
  assert.equal(lane.read('curl-args'), '');
  assert.equal(lane.read('gh-seen'), '');
  // A configuration that cannot work is no better: forge calls stop with the missing key named.
  writeFileSync(lane.confPath, readFileSync(lane.confPath, 'utf8').replace('installation_id = 456\n', ''));
  const missing = script(lane, 'gh pr list --state open');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /\[forge\] installation_id is missing/);
  assert.equal(lane.read('gh-seen'), '');
});

// The harness of each adapter, started as the dispatcher starts it, writes down its whole environment and arguments.
function harnessRun(adapter, { agentUser = false } = {}) {
  const lane = forgeLane();
  const dir = scratch('cleared-forge-harness-');
  const cache = join(lane.box.state, 'forge');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  writeFileSync(join(cache, 'installation-token.json'), JSON.stringify({ app_id: '123', installation_id: '456', token: TOKEN,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }), { mode: 0o600 });
  const dump = `#!/usr/bin/env bash
env > "${join(dir, 'env')}"
printf '%s\\n' "$@" > "${join(dir, 'args')}"
cat > /dev/null
`;
  writeFileSync(join(dir, 'claude'), `${dump}printf '%s\\n' '{"type":"result","is_error":false,"result":"Claude answer","modelUsage":{}}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'codex'), `${dump}previous=; for arg in "$@"; do [ "$previous" != --output-last-message ] || printf 'Codex answer\\n' > "$arg"; previous=$arg; done
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Codex answer"}}'\n`, { mode: 0o755 });
  let conf = readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').replace('[forge]\n', `${forgeSection(lane.key)}`);
  if (agentUser) {
    // The account of the agents through a sudo and a bubblewrap that only pass the command on.
    writeFileSync(join(dir, 'sudo'), `#!/usr/bin/env bash
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
case "$5" in id) exec id -u "$3" ;; test) exit 0 ;; env) shift 4; exec "$@" ;; *) exit 1 ;; esac
`, { mode: 0o755 });
    writeFileSync(join(dir, 'bwrap'), `#!/usr/bin/env bash
while [ "$1" != -- ]; do shift; done; shift
[ "$1" != claude ] || shift
exec "${join(dir, 'claude')}" "$@"
`, { mode: 0o755 });
    conf = conf.replace('agent_user =\n', 'agent_user = nobody\n').replace('bwrap_path = /usr/bin/bwrap', `bwrap_path = ${join(dir, 'bwrap')}`);
  }
  writeFileSync(join(dir, 'agents.conf'), conf);
  const empty = scratch('cleared-forge-empty-');
  const prompt = join(dir, 'prompt.md');
  writeFileSync(prompt, 'Say hello.\n');
  const run = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; permissions_env writing; adapter_env "$2"; gh pr list > /dev/null; exec "$1/adapters/$2.sh" run --model m --prompt-file "$3" --report "$4" --usage "$5"',
    '_', ORCH_HOME, adapter, prompt, join(dir, 'report.md'), join(dir, 'usage.json')], { cwd: empty, encoding: 'utf8',
    env: { ...lane.env, PATH: `${dir}:${lane.env.PATH}`, CLEARED_REPO: lane.box.repo, CLEARED_CONF: join(dir, 'agents.conf'),
      CLEARED_STATE_DIR: lane.box.state, ORCH_TEXT_ONLY: '1' } });
  return { run, lane, env: readFileSync(join(dir, 'env'), 'utf8'), args: readFileSync(join(dir, 'args'), 'utf8') };
}

for (const [adapter, options] of [['claude', {}], ['claude', { agentUser: true }], ['codex', {}]]) {
  test(`no forge credential reaches the ${adapter} harness${options.agentUser ? ' started under [security] agent_user' : ''}: no token variable, no git credential setting, no identity, the token nowhere`, () => {
    const { run, lane, env, args } = harnessRun(adapter, options);
    assert.equal(run.status, 0, run.stderr);
    // The dispatcher around it did use the app (the gh call before the adapter).
    assert.match(lane.read('gh-seen'), new RegExp(`^${TOKEN}\\|`));
    const names = env.split('\n').map((line) => line.split('=')[0]);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
      assert.ok(!names.includes(name), `${name} reached the harness`);
    assert.doesNotMatch(env, /forge\.mjs|credential\.https/, 'the credential helper reached the harness');
    if (adapter === 'codex') assert.match(env, /^GIT_CONFIG_COUNT=2$/m, 'only the git settings of the Codex adapter itself');
    else assert.ok(!names.some((name) => name.startsWith('GIT_CONFIG_')), env);
    assert.ok(!env.includes(TOKEN));
    assert.ok(!args.includes(TOKEN));
  });
}

test('cleared status says which identity the forge calls use, and reports a configured app that cannot give a token', () => {
  const status = (lane) => {
    const json = spawnSync(process.execPath, [join(lane.box.home, 'lib', 'heartbeat.mjs'), 'status', '--json'], { env: lane.env, encoding: 'utf8' });
    const text = spawnSync(process.execPath, [join(lane.box.home, 'lib', 'heartbeat.mjs'), 'status'], { env: lane.env, encoding: 'utf8' });
    return { json: JSON.parse(json.stdout), text: text.stdout };
  };
  const ambient = status(forgeLane({ forge: false }));
  assert.deepEqual(ambient.json.services.forge.identity, { kind: 'ambient' });
  assert.match(ambient.text, /^Forge · GitHub\s+reachable · ambient credential$/m);
  const lane = forgeLane();
  const app = status(lane);
  assert.equal(app.json.services.forge.reachable, true);
  assert.deepEqual(app.json.services.forge.identity, { kind: 'app', login: BOT, commits: 'app' });
  assert.match(app.text, /^Forge · GitHub\s+reachable · as cleared-test\[bot\]$/m);
  // The probe asked as the installation, with its token.
  assert.match(lane.read('gh-seen'), new RegExp(`^${TOKEN}\\|${TOKEN}\\|api /installation/repositories`, 'm'));
  assert.ok(!app.json.problems.some((p) => p.code === 'forge_credential'));
  chmodSync(lane.key, 0o644);
  rmCache(lane);
  const broken = status(lane);
  assert.equal(broken.json.services.forge.reachable, false);
  const [failure] = broken.json.problems.filter((p) => p.code === 'forge_credential');
  assert.match(failure.message, /\[forge\] app_private_key_file/);
  assert.match(broken.text, /^Forge · GitHub\s+unreachable · as cleared-test\[bot\]$/m);
  assert.ok(!JSON.stringify(broken.json).includes(lane.key));
});
const rmCache = (lane) => execFileSync('rm', ['-rf', join(lane.box.state, 'forge')]);

// Every script that calls gh or reaches the remote with git gets the forge credential from lib/common.sh, and every
// node file that runs gh or a network git command gets it from lib/forge.mjs: a new call site cannot miss it.
test('no forge call site is left outside the forge credential', () => {
  const shell = [...readdirSync(ORCH_HOME).filter((name) => name.endsWith('.sh')),
    ...['adapters', 'lib', 'serve'].flatMap((dir) => readdirSync(join(ORCH_HOME, dir), { recursive: true })
      .map((name) => join(dir, String(name))).filter((name) => name.endsWith('.sh')))];
  const calls = /(^|[\s($`;|&])gh (pr|run|api|issue|repo|workflow)\b|\bgit\b[^\n|;]*\s(push|fetch|pull|ls-remote|clone)\b/m;
  let checked = 0;
  for (const name of shell) {
    const text = readFileSync(join(ORCH_HOME, name), 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    if (!calls.test(text) || name === 'lib/common.sh') continue;
    checked += 1;
    assert.match(text, /lib\/common\.sh"|\.\.\/lib\/common\.sh"|\.\.\/\.\.\/\.\.\)" && pwd\)\/lib\/common\.sh"/, `${name} calls the forge without lib/common.sh`);
  }
  assert.ok(checked >= 14, `only ${checked} shell call sites found`);
  const node = [...readdirSync(ORCH_HOME).filter((name) => name.endsWith('.mjs')), 'cleared',
    ...['lib', 'serve', 'app'].flatMap((dir) => readdirSync(join(ORCH_HOME, dir), { recursive: true })
      .map((name) => join(dir, String(name))).filter((name) => name.endsWith('.mjs')))];
  for (const name of node) {
    if (name === 'lib/tracker/adapters/github.mjs') continue; // the tracker's own calls, with the tracker's token
    const text = readFileSync(join(ORCH_HOME, name), 'utf8');
    if (/(execFileSync|execFile|spawnSync|spawn)\(\s*'gh'|run\('gh'/.test(text)) assert.match(text, /forgeGhEnv/, `${name} runs gh without the forge credential`);
    if (/'(push|fetch|pull|ls-remote|clone)'/.test(text) && /'git'/.test(text)) assert.match(text, /forgeEnv/, `${name} runs a network git command without the forge credential`);
  }
});
