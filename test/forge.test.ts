import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORCH_HOME, parseConf } from '../lib/conf.ts';
import { forgeEnv, forgeSettings, forgeToken } from '../lib/forge.ts';
import { openLedger } from '../lib/ledger.ts';
import { laneWithRemote, scratch } from './support.ts';
import type { Lane } from './support.ts';

// What the fake GitHub hands out: an installation token that must be seen by gh and git, and nowhere else.
const TOKEN = 'ghs_forgeTestInstallationToken0123456789';
const BOT = 'cleared-test[bot]';
const BOT_EMAIL = `98765+${BOT}@users.noreply.github.com`;
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function appKey(dir: string, mode = 0o600) {
  const key = join(dir, 'github-app.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode });
  chmodSync(key, mode);
  return key;
}
const forgeSection = (key: string) => `[forge]\nadapter = github\napp_id = 123\ninstallation_id = 456\napp_private_key_file = ${key}\napp_login = ${BOT}\napp_user_id = 98765\n`;

// A lane whose work leaves through the real scripts, with a fake GitHub around them: gh and the token endpoint
// (curl) write down what they were given, git records what a push would authenticate with, and the account has an
// ambient GitHub token and an ambient git credential that must not be used once an app is configured.
function forgeLane({ forge = true, keyMode = 0o600 } = {}) {
  const lane = laneWithRemote('dev/X-1', null);
  const { box } = lane;
  const bin = join(box.home, 'bin');
  const key = appKey(box.home, keyMode);
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
fs.appendFileSync(${JSON.stringify(join(box.home, 'curl-args'))}, process.argv.slice(2).join(' ') + '\\n');
try { fs.readFileSync(0); } catch { /* no input */ }
if (process.env.FAKE_CURL_FAIL) { process.stderr.write('curl: (22) The requested URL returned error: 403\\n'); process.exitCode = 22; }
else process.stdout.write('{"token":"${TOKEN}","expires_at":"' + new Date(Date.now() + 3_600_000).toISOString().replace(/\\.\\d{3}Z$/, 'Z') + '"}\\n');
`, { mode: 0o755 });
  renameSync(join(bin, 'gh'), join(bin, 'gh-original'));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(box.home, 'gh-seen'))}, (process.env.GH_TOKEN ?? '') + '|' + (process.env.GITHUB_TOKEN ?? '') + '|' + args.join(' ') + '\\n');
process.exitCode = spawnSync(${JSON.stringify(join(bin, 'gh-original'))}, args, { stdio: 'inherit' }).status ?? 1;
`, { mode: 0o755 });
  // A push: the environment it runs with (the lines of env that name git settings, identities or tokens) and what
  // the credential helpers git would ask answer for github.com.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const args = process.argv.slice(2);
if (args.includes('push')) {
  const lines = Object.entries(process.env).map(([name, value]) => name + '=' + value).join('\\n').split('\\n');
  fs.appendFileSync(${JSON.stringify(join(box.home, 'git-push-env'))}, lines.filter((line) => /^(GIT_CONFIG_|GH_TOKEN|GITHUB_TOKEN|GIT_AUTHOR|GIT_COMMITTER)/.test(line)).map((line) => line + '\\n').join(''));
  const credential = ${JSON.stringify(join(box.home, 'git-credential'))};
  const fd = fs.openSync(credential, 'a');
  const fill = spawnSync(${JSON.stringify(realGit)}, ['credential', 'fill'], { input: 'protocol=https\\nhost=github.com\\npath=example/project.git\\n\\n', stdio: ['pipe', fd, fd] });
  fs.closeSync(fd);
  if (fill.status !== 0) fs.appendFileSync(credential, 'fill failed\\n');
}
process.exitCode = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1;
`, { mode: 0o755 });
  // The account's own git credential, as gh auth setup-git would have left it.
  writeFileSync(join(box.home, '.gitconfig'), '[credential]\n\thelper = "!f() { echo username=ambient; echo password=AMBIENT-PASSWORD; }; f"\n');
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8')}\n[adapter.first]\ncommits = no\nrunner = container\n${forge ? forgeSection(key) : ''}`);
  const env = { ...box.env, HOME: box.home, GH_TOKEN: 'ambient-gh-token', GITHUB_TOKEN: 'ambient-github-token', GIT_TERMINAL_PROMPT: '0' };
  const read = (name: string) => { try { return readFileSync(join(box.home, name), 'utf8'); } catch { return ''; } };
  return { ...lane, bin, key, env, read, confPath };
}

type ForgeLane = ReturnType<typeof forgeLane>;

// A step of the kept commands, as they run it: the lane's copy of lib/script.ts (s), lib/forge.ts (f) and
// lib/conf.ts (c) imported, the project's environment set, then the code. out() prints a line; shown() passes a
// command's output on and takes its exit code; quiet() only its error output and its code.
const script = (lane: ForgeLane, code: string, extra: NodeJS.ProcessEnv = {}, input: string | undefined = undefined) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
const s = await import(${JSON.stringify(pathToFileURL(join(lane.box.home, 'lib', 'script.ts')).href)});
const f = await import(${JSON.stringify(pathToFileURL(join(lane.box.home, 'lib', 'forge.ts')).href)});
const c = await import(${JSON.stringify(pathToFileURL(join(lane.box.home, 'lib', 'conf.ts')).href)});
const out = (text) => process.stdout.write(text + '\\n');
const quiet = (run) => { process.stderr.write(run.stderr); process.exitCode = run.status; return run; };
const shown = (run) => { process.stdout.write(run.stdout); return quiet(run); };
s.projectEnv();
${code}`], { env: { ...lane.env, ...extra }, encoding: 'utf8', input, cwd: lane.box.repo });
// What the forge mode is, then a gh call of the scripts, its output left out.
const MODE = "out(f.forgeMode(c.loadConf()).mode); quiet(s.gh(['pr', 'list', '--state', 'open']));";
const LIST = "shown(s.gh(['pr', 'list', '--state', 'open']));";
const FILL = (host: string) => `shown(s.git(['credential', 'fill'], { input: 'protocol=https\\nhost=${host}\\n\\n' }));`;
// What the kept commands ask of the forge: a commit, a push of the lane's branch, and two gh calls.
const forgeCalls = (lane: ForgeLane, extra: NodeJS.ProcessEnv = {}) => ({ run: script(lane, `
const steps = [
  () => s.git(['-c', 'user.name=dispatcher', '-c', 'user.email=dispatcher@localhost', 'commit', '-q', '--allow-empty', '-m', 'feat: the work'], { cwd: ${JSON.stringify(lane.path)} }),
  () => s.git(['push', '-q', 'origin', 'dev/X-1'], { cwd: ${JSON.stringify(lane.path)} }),
  () => s.gh(['pr', 'list', '--state', 'open']),
  () => s.gh(['run', 'list', '--limit', '1']),
];
for (const step of steps) { if (quiet(step()).status !== 0) break; }`, extra) });
const filesUnder = (dir: string) => readdirSync(dir, { recursive: true }).map((name) => join(dir, String(name))).filter((path) => statSync(path).isFile());
const author = (lane: Lane) => execFileSync(realGit, ['--git-dir', lane.remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'dev/X-1'], { encoding: 'utf8' }).trim();

test('without [forge], gh and git use the ambient credential exactly as before, and no token is minted', () => {
  const lane = forgeLane({ forge: false });
  const { run } = forgeCalls(lane);
  assert.equal(run.status, 0, run.stderr);
  const seen = lane.read('gh-seen').trim().split('\n');
  assert.ok(seen.length >= 2, seen.join('\n'));
  for (const line of seen) assert.match(line, /^ambient-gh-token\|ambient-github-token\|/);
  // (The settings the test runner itself may carry in GIT_CONFIG_* are left as they are.)
  assert.doesNotMatch(lane.read('git-push-env'), /forge\.ts|github\.com|GIT_AUTHOR|GIT_COMMITTER/, 'no git setting nor identity is added');
  assert.match(lane.read('git-push-env'), /^GH_TOKEN=ambient-gh-token$/m);
  assert.match(lane.read('git-credential'), /password=AMBIENT-PASSWORD/);
  assert.equal(author(lane), 'dispatcher <dispatcher@localhost>|dispatcher <dispatcher@localhost>');
  assert.equal(lane.read('curl-args'), '');
  assert.equal(existsSync(join(lane.box.state, 'forge')), false);
  assert.deepEqual(forgeEnv(parseConf(readFileSync(lane.confPath, 'utf8')), { A: '1' }), { A: '1' });
});

test('with [forge], gh gets the installation token, a push authenticates through the helper as x-access-token, and the scripts commit as the bot', () => {
  const lane = forgeLane();
  const { run } = forgeCalls(lane);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(lane.onRemote().some((line) => line.startsWith('dev/X-1 ')));
  // gh: the app's token, in its environment, for every call; never the ambient one, never in its arguments.
  const seen = lane.read('gh-seen').trim().split('\n');
  assert.ok(seen.some((line) => line.includes('pr list')), seen.join('\n'));
  for (const line of seen) {
    const [token, github, args] = line.split('|');
    assert.equal(token, TOKEN);
    assert.equal(github, TOKEN);
    assert.ok(!args!.includes(TOKEN));
  }
  // git: the helper named in GIT_CONFIG_* answers for github.com, and the account's own helper is dropped.
  const credential = lane.read('git-credential');
  assert.match(credential, /^username=x-access-token$/m);
  assert.match(credential, new RegExp(`^password=${TOKEN}$`, 'm'));
  assert.doesNotMatch(credential, /AMBIENT/);
  const pushEnv = lane.read('git-push-env');
  assert.match(pushEnv, /^GIT_CONFIG_VALUE_\d+=!.*lib\/forge\.ts' credential$/m);
  assert.match(pushEnv, /^GIT_CONFIG_KEY_\d+=url\.https:\/\/github\.com\/\.insteadOf$/m);
  assert.ok(!pushEnv.includes(TOKEN), 'the token is not in the environment git or the script runs with');
  assert.doesNotMatch(pushEnv, /^(GH_TOKEN|GITHUB_TOKEN)=/m, 'the ambient GitHub token is dropped once an app is configured');
  // The commit the scripts made carries the app's identity.
  assert.equal(author(lane), `${BOT} <${BOT_EMAIL}>|${BOT} <${BOT_EMAIL}>`);
  // One token for the whole run (several gh calls and a push), asked for with the JWT on stdin only.
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
  const request = (url: string) => {
    assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
    minted += 1;
    return { token: `token-${minted}`, expires_at: new Date(clock + 60 * 60_000).toISOString() };
  };
  const ask = () => forgeToken(conf, { state, now: () => clock, request })!.token;
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
  const shared = forgeSettings(tracker())!;
  assert.equal(shared.source, 'tracker');
  assert.equal(shared.app_id, '11');
  assert.equal(shared.installation_id, '22');
  assert.equal(shared.login, BOT);
  assert.equal(shared.identity, null, 'no bot user ID: commits keep the local identity');
  assert.deepEqual(forgeSettings(tracker('[forge]\nuse_tracker_app = yes\napp_user_id = 98765\n'))!.identity, { name: BOT, email: BOT_EMAIL });
  // An installation of the GitHub tracker that has not opted in keeps its ambient forge credential.
  assert.equal(forgeSettings(tracker('')), null);
  assert.equal(forgeSettings(tracker('[forge]\nuse_tracker_app = no\n')), null);
  // [forge] keys win over the tracker's.
  assert.equal(forgeSettings(tracker(forgeSection('/srv/keys/forge.pem')))!.app_private_key_file, '/srv/keys/forge.pem');
  // Neither: the ambient credential.
  assert.equal(forgeSettings(parseConf(`[tracker]\nadapter = local\n${keys}`)), null);
  assert.equal(forgeSettings(parseConf('[tracker]\nadapter = local\n[forge]\nadapter = github\n')), null);
  assert.throws(() => forgeSettings(parseConf(`[tracker]\nadapter = local\n${keys}[forge]\nuse_tracker_app = yes\n`)), /use_tracker_app = yes needs \[tracker\] adapter = github/);
  assert.throws(() => forgeSettings(parseConf('[tracker]\nadapter = github\n[forge]\nuse_tracker_app = yes\n')), /\[tracker\] app_id is missing/);
  assert.throws(() => forgeSettings(tracker('[forge]\nuse_tracker_app = true\n')), /use_tracker_app must be yes or no/);
  assert.throws(() => forgeSettings(parseConf('[forge]\napp_id = 1\napp_private_key_file = /srv/k.pem\napp_login = x[bot]\napp_user_id = 2\n')), /\[forge\] installation_id is missing/);
  assert.throws(() => forgeSettings(parseConf('[forge]\nadapter = bitbucket\n')), /unknown \[forge\] adapter "bitbucket" \(known: github, gitlab\)/);
  // A GitLab service's lock (merge-pr.ts) reads GitLab itself: no GitHub App, git's ambient credential.
  assert.equal(forgeSettings(parseConf('[forge]\nadapter = gitlab\ngitlab_project = example/guestbook\n')), null);
  assert.throws(() => forgeSettings(parseConf('[forge]\nadapter = gitlab\napp_id = 1\n')), /\[forge\] adapter = gitlab takes no GitHub App key/);
  assert.throws(() => forgeSettings(parseConf('[forge]\napp_id = 1\ninstallation_id = 2\napp_private_key_file = relative.pem\napp_login = x[bot]\napp_user_id = 2\n')), /absolute/);
  assert.throws(() => forgeSettings(parseConf('[forge]\napp_id = 1\ninstallation_id = 2\napp_private_key_file = /srv/k.pem\napp_login = x[bot]\n')), /\[forge\] app_user_id is missing/);
});

test('the GitHub tracker\'s app is the forge\'s only once [forge] use_tracker_app = yes: an existing installation is unchanged on upgrade', () => {
  const lane = forgeLane({ forge: false });
  writeFileSync(lane.confPath, readFileSync(lane.confPath, 'utf8').replace('[tracker]\nadapter = local\n',
    `[tracker]\nadapter = github\nrepository = example/project\napp_login = cleared-test[bot]\napp_id = 123\ninstallation_id = 456\napp_private_key_file = ${lane.key}\n`));
  const before = script(lane, MODE);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout.trim(), 'ambient');
  assert.match(lane.read('gh-seen'), /^ambient-gh-token\|/);
  assert.equal(lane.read('curl-args'), '');
  writeFileSync(lane.confPath, `${readFileSync(lane.confPath, 'utf8')}\n[forge]\nuse_tracker_app = yes\n`);
  const run = script(lane, "const m = f.forgeMode(c.loadConf()); out(`${m.mode} ${m.login}`); quiet(s.gh(['pr', 'list', '--state', 'open']));");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), `app ${BOT}`);
  assert.match(lane.read('gh-seen').trim().split('\n').at(-1)!, new RegExp(`^${TOKEN}\\|`));
});

test('a token that cannot be minted stops forge calls with the setting to look at, and never falls back to the ambient credential', () => {
  const lane = forgeLane();
  const failing = { FAKE_CURL_FAIL: '1' };
  const listed = script(lane, LIST, failing);
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /\[forge\] app_id and installation_id/);
  assert.match(listed.stderr, /the ambient credential is not used/);
  assert.equal(lane.read('gh-seen'), '', 'gh is never run without the app token');
  const fill = script(lane, FILL('github.com'), failing);
  assert.notEqual(fill.status, 0);
  assert.doesNotMatch(fill.stdout, /AMBIENT/);
  assert.match(fill.stderr, /forge credential/);
  // Nor an askpass program of the account: the helper tells git to quit.
  writeFileSync(join(lane.bin, 'askpass'), `#!${process.execPath}\nprocess.stdout.write('AMBIENT-ASKPASS\\n');\n`, { mode: 0o755 });
  const asked = script(lane, FILL('github.com'), { ...failing, GIT_ASKPASS: join(lane.bin, 'askpass') });
  assert.notEqual(asked.status, 0);
  assert.doesNotMatch(asked.stdout, /AMBIENT/);
  // Said in the ledger once an hour, without the token or the key.
  const db = openLedger(join(lane.box.state, 'ledger.db'));
  const said = db.prepare("select detail from events where kind = 'forge_token_failed'").all() as { detail: string }[];
  db.close();
  assert.equal(said.length, 1);
  assert.match(said[0]!.detail, /installation_id/);
  assert.ok(!said[0]!.detail.includes(lane.key));
  // Another host stays with its own credential: only github.com is the forge's.
  const elsewhere = script(lane, FILL('example.com'), failing);
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
    const urls = script(lane, ['remote get-url --push origin', 'remote get-url origin', 'remote get-url --push ssh', 'config user.name']
      .map((args) => `process.stdout.write(s.git(${JSON.stringify(args.split(' '))}, { cwd: ${JSON.stringify(clone)} }).stdout);`).join('\n'));
    assert.equal(urls.status, 0, urls.stderr);
    if (forge) assert.deepEqual(urls.stdout.trim().split('\n'), ['https://github.com/example/project.git', 'https://github.com/example/project.git',
      'https://github.com/example/project.git', 'Service Account']);
    // The control: without an app, the account's rules apply as they always did.
    else assert.deepEqual(urls.stdout.trim().split('\n'), ['git@github.com:example/project.git', 'git@github.com:example/project.git',
      'git@github.com:example/project.git', 'Service Account']);
  }
});

test('[forge] adapter = github alone, or the example copied as it is, names no app: nothing changes', () => {
  const lane = forgeLane({ forge: false });
  for (const added of ['[forge]\nadapter = github\n', readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').match(/\[forge\]\n(?:#.*\n|\s*\n)*/)![0]]) {
    writeFileSync(lane.confPath, `${readFileSync(lane.confPath, 'utf8')}\n${added}`);
    const run = script(lane, MODE);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'ambient');
    assert.equal(lane.read('curl-args'), '', 'no token is asked for');
    assert.match(lane.read('gh-seen').trim().split('\n').at(-1)!, /^ambient-gh-token\|/);
  }
  assert.equal(forgeSettings(parseConf(readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8'))), null);
});

test('the rest of the account\'s git configuration still applies under the app: signing, excludes, proxy, includeIf identity, other hosts; only what touches github.com is dropped', () => {
  const read = (forge: boolean) => {
    const lane = forgeLane({ forge });
    writeFileSync(join(lane.box.home, 'included.conf'), '[user]\n\temail = included@example.org\n');
    writeFileSync(join(lane.box.home, '.gitconfig'), `${readFileSync(join(lane.box.home, '.gitconfig'), 'utf8')}[commit]
\tgpgsign = true
[core]
\texcludesFile = ${join(lane.box.home, 'ignored')}
[http]
\tproxy = http://proxy.example.org:3128
[includeIf "gitdir:${lane.box.repo}/"]
\tpath = ${join(lane.box.home, 'included.conf')}
[url "ssh://git@example.org/"]
\tinsteadOf = https://example.org/
[url "git@github.com:"]
\tpushInsteadOf = https://github.com/
[credential "https://github.com"]
\thelper = "!echo password=AMBIENT-SCOPED"
[http "https://github.com/"]
\textraHeader = AUTHORIZATION: basic AMBIENT-HEADER
`);
    const keys = ['commit.gpgsign', 'core.excludesfile', 'http.proxy', 'user.email', 'url.ssh://git@example.org/.insteadof',
      'url.git@github.com:.pushinsteadof', 'credential.https://github.com.helper', 'http.https://github.com/.extraheader'];
    const got = script(lane, keys.map((key) => `out(${JSON.stringify(key)} + '=' + s.git(['config', '--get-all', ${JSON.stringify(key)}]).stdout.split('\\n').filter(Boolean).map((line) => line + '|').join(''));`).join('\n'));
    assert.equal(got.status, 0, got.stderr);
    return Object.fromEntries(got.stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  };
  const ambient = read(false);
  const app = read(true);
  for (const key of ['commit.gpgsign', 'core.excludesfile', 'http.proxy', 'user.email', 'url.ssh://git@example.org/.insteadof']) {
    assert.ok(ambient[key], key);
    assert.equal(app[key]!.replace(/\/tmp\/orch-home-[^/]+/, ''), ambient[key]!.replace(/\/tmp\/orch-home-[^/]+/, ''), key);
  }
  assert.equal(app['user.email'], 'included@example.org|');
  assert.equal(app['url.git@github.com:.pushinsteadof'], '');
  assert.doesNotMatch(app['credential.https://github.com.helper']!, /AMBIENT/);
  assert.match(app['credential.https://github.com.helper']!, /forge\.ts' credential\|$/);
  assert.doesNotMatch(app['http.https://github.com/.extraheader']!, /AMBIENT/);
});

test('the debug switches of gh and git are off wherever the token is: the gh call and the scripts\' git', () => {
  const lane = forgeLane();
  const debug = { GH_DEBUG: 'api', DEBUG: 'api', GIT_TRACE: '1', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1', GIT_TRACE_REDACT: '0' };
  writeFileSync(join(lane.bin, 'gh'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const lines = Object.entries(process.env).map(([name, value]) => name + '=' + value).join('\\n').split('\\n');
fs.appendFileSync(${JSON.stringify(join(lane.box.home, 'gh-debug'))}, lines.filter((line) => /^(GH_DEBUG|DEBUG|GIT_TRACE|GIT_TRACE_CURL|GIT_CURL_VERBOSE|GIT_TRACE_REDACT)=/.test(line)).map((line) => line + '\\n').join(''));
fs.appendFileSync(${JSON.stringify(join(lane.box.home, 'gh-seen'))}, (process.env.GH_TOKEN ?? '') + '|' + (process.env.GITHUB_TOKEN ?? '') + '|' + process.argv.slice(2).join(' ') + '\\n');
`, { mode: 0o755 });
  const run = script(lane, "quiet(s.gh(['pr', 'list'])); out(String(Object.keys(f.forgeEnv(c.loadConf())).filter((name) => /^(GH_DEBUG|GIT_TRACE|GIT_TRACE_CURL|GIT_CURL_VERBOSE|GIT_TRACE_REDACT)$/.test(name)).length));", debug);
  assert.equal(run.status, 0, run.stderr);
  assert.match(lane.read('gh-seen'), new RegExp(`^${TOKEN}\\|`));
  assert.equal(lane.read('gh-debug'), '', 'gh ran with a debug switch');
  assert.equal(run.stdout.trim(), '0', 'the scripts\' git still has a debug switch');
  // Without an app nothing is touched.
  const ambient = forgeLane({ forge: false });
  const kept = script(ambient, "out(f.forgeEnv(c.loadConf()).GIT_TRACE === '1' ? '1' : '0');", debug);
  assert.equal(kept.stdout.trim(), '1');
});

test('a url rewrite in the repository\'s own git configuration that sends the origin to SSH stops every forge call', () => {
  const lane = forgeLane();
  const git = (...args: string[]) => execFileSync(realGit, ['-C', lane.box.repo, ...args]);
  git('remote', 'set-url', 'origin', 'https://github.com/example/project.git');
  const state = () => script(lane, MODE);
  assert.equal(state().stdout.trim(), 'app', 'an https origin on github.com is the app\'s');
  for (const rule of ['pushInsteadOf', 'insteadOf']) {
    git('config', `url.git@github.com:.${rule}`, 'https://github.com/');
    const refused = state();
    assert.equal(refused.stdout.trim(), 'error', rule);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /origin of the project leads to git@github\.com:example\/project\.git, not https:\/\/github\.com\//);
    // git refuses too, before any SSH connection: no ambient key is tried.
    const pushed = script(lane, "shown(s.git(['push', 'origin', 'HEAD:refs/heads/x']));");
    assert.notEqual(pushed.status, 0);
    assert.match(pushed.stderr, /cleared forge credential: the origin of the project leads to/);
    git('config', '--unset', `url.git@github.com:.${rule}`);
  }
  assert.ok(!lane.read('gh-seen').split('\n').some((line) => line.includes('ambient')));
  // A local or file:// origin needs no credential and is accepted (the other tests push to one).
  git('remote', 'set-url', 'origin', lane.remote);
  assert.equal(state().stdout.trim(), 'app');
});

test('when lib/forge.ts itself cannot run, no command of the scripts runs: neither gh nor git uses the ambient credential', () => {
  const lane = forgeLane();
  writeFileSync(join(lane.box.home, 'lib', 'forge.ts'), "console.error('Error: Cannot find module node:fs/broken'); process.exit(3);\n");
  const listed = script(lane, LIST);
  assert.notEqual(listed.status, 0);
  assert.equal(lane.read('gh-seen'), '');
  const fill = script(lane, FILL('github.com'));
  assert.notEqual(fill.status, 0);
  assert.doesNotMatch(fill.stdout, /AMBIENT/);
  assert.equal(lane.read('git-credential'), '');
});

test('a key file other accounts can read is refused before anything is asked of GitHub', () => {
  const lane = forgeLane({ keyMode: 0o640 });
  const listed = script(lane, LIST);
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /\[forge\] app_private_key_file\) must be owned by the Cleared account and have mode 0600/);
  assert.equal(lane.read('curl-args'), '');
  assert.equal(lane.read('gh-seen'), '');
  // A configuration that cannot work is no better: forge calls stop with the missing key named.
  writeFileSync(lane.confPath, readFileSync(lane.confPath, 'utf8').replace('installation_id = 456\n', ''));
  const missing = script(lane, LIST);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /\[forge\] installation_id is missing/);
  assert.equal(lane.read('gh-seen'), '');
});

test('cleared status says which identity the forge calls use, and reports a configured app that cannot give a token', () => {
  type Problem = { code: string; message: string };
  const status = (lane: ForgeLane) => {
    const json = spawnSync(process.execPath, [join(lane.box.home, 'lib', 'heartbeat.ts'), 'status', '--json'], { env: lane.env, encoding: 'utf8' });
    const text = spawnSync(process.execPath, [join(lane.box.home, 'lib', 'heartbeat.ts'), 'status'], { env: lane.env, encoding: 'utf8' });
    return { json: JSON.parse(json.stdout) as { services: { forge: { identity: unknown; reachable: boolean } }; problems: Problem[] }, text: text.stdout };
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
  assert.match(failure!.message, /\[forge\] app_private_key_file/);
  assert.match(broken.text, /^Forge · GitHub\s+unreachable · as cleared-test\[bot\]$/m);
  assert.ok(!JSON.stringify(broken.json).includes(lane.key));
});
const rmCache = (lane: ForgeLane) => execFileSync('rm', ['-rf', join(lane.box.state, 'forge')]);

// A tripwire over the source text, not a proof. It finds: shell scripts that call gh or a network git command
// without sourcing lib/common.sh; shell code that runs gh around the gh function of lib/common.sh (command, exec,
// env, nohup, timeout, xargs, a .../bin/gh path, or `sh -c`/`bash -c` strings), whose call would take the ambient
// credential; and node files that run gh, or git with a literal push/fetch/pull/ls-remote/clone argument or a
// `...` spread of arguments, without lib/forge.ts. It does not see a command assembled at run time (a variable
// holding gh or the git verb, eval, a program handed the name), nor a node file that receives its git arguments
// from elsewhere without spreading them: a reviewer still reads new forge calls.
test('scripts that call the forge source lib/common.sh, none runs gh around its function, and node forge calls use lib/forge.ts', () => {
  const shell = [...readdirSync(ORCH_HOME).filter((name) => name.endsWith('.sh')),
    ...['lib', 'serve'].flatMap((dir) => readdirSync(join(ORCH_HOME, dir), { recursive: true })
      .map((name) => join(dir, String(name))).filter((name) => name.endsWith('.sh')))];
  const calls = /(^|[\s($`;|&])gh (pr|run|api|issue|repo|workflow)\b|\bgit\b[^\n|;]*\s(push|fetch|pull|ls-remote|clone)\b/m;
  const around = /(^|[\s($`;|&])(command|exec|env(\s+(-u\s+\S+|-\S+|\w+=\S*))*|nohup|xargs(\s+-\S+)*|timeout(\s+-\S+)*\s+\S+)\s+gh\b|\/bin\/gh\b|\b(ba)?sh\s+-c\s+["'][^"'\n]*\bgh\s/m;
  let checked = 0;
  for (const name of shell) {
    const text = readFileSync(join(ORCH_HOME, name), 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    // The one place gh is meant to be run directly: the function that hands it the token.
    const own = name === 'lib/common.sh' ? text.replace(/GH_TOKEN=\$forge_token GITHUB_TOKEN=\$forge_token command gh "\$@"|ambient\) command gh "\$@"/g, '') : text;
    const bypass = own.match(around);
    assert.equal(bypass, null, `${name} runs gh around the forge credential of lib/common.sh: ${bypass?.[0]}`);
    if (!calls.test(text) || name === 'lib/common.sh') continue;
    checked += 1;
    assert.match(text, /lib\/common\.sh"|\.\.\/lib\/common\.sh"|\.\.\/\.\.\/\.\.\)" && pwd\)\/lib\/common\.sh"/, `${name} calls the forge without lib/common.sh`);
  }
  assert.ok(shell.length === 0 || checked >= 1, `only ${checked} shell call sites found`);
  const node = [...readdirSync(ORCH_HOME).filter((name) => /\.(mjs|ts)$/.test(name)), 'cleared',
    ...['lib', 'serve', 'app'].flatMap((dir) => readdirSync(join(ORCH_HOME, dir), { recursive: true })
      .map((name) => join(dir, String(name))).filter((name) => /\.(mjs|ts)$/.test(name) && !name.includes('node_modules')))];
  const ghFiles: string[] = [];
  for (const name of node) {
    if (name === 'lib/tracker/adapters/github.ts') continue; // the tracker's own calls, with the tracker's token
    const text = readFileSync(join(ORCH_HOME, name), 'utf8');
    if (/(execFileSync|execFile|spawnSync|spawn)\(\s*'gh'|run\('gh'|exec(Sync)?\(\s*[`'"][^`'"]*\bgh\s/.test(text)) { ghFiles.push(name); assert.match(text, /forgeGhEnv/, `${name} runs gh without the forge credential`); }
    const networkGit = /'(push|fetch|pull|ls-remote|clone)'/.test(text) && /'git'/.test(text);
    const spreadGit = /(execFileSync|execFile|spawnSync|spawn)\(\s*'git',\s*\[[^\]]*\.\.\.\w+/.test(text);
    if (networkGit || spreadGit) assert.match(text, /forgeEnv/, `${name} may run a network git command without the forge credential`);
  }
  // The Node commands that replaced the bash scripts (merge-pr.ts, ask-validation.ts) run gh through lib/script.ts.
  assert.ok(ghFiles.includes('lib/script.ts'), `the check reads the gh calls of lib/script.ts: ${ghFiles.join(', ')}`);
});
