import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME, loadConf } from '../lib/conf.mjs';
import { fixtureProject, laneWithRemote, scratch } from './support.mjs';

const example = loadConf(join(ORCH_HOME, 'agents.example.conf'));

function fakeClis(dir) {
  writeFileSync(join(dir, 'codex'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_ARGS"
printf '%s\\n' "\${GH_TOKEN:-}" "\${GITHUB_TOKEN:-}" "\${SSH_AUTH_SOCK:-}" "$TMPDIR" > "$FAKE_ENV"
last=
previous=
for arg in "$@"; do
  [ "$previous" != --output-last-message ] || last=$arg
  previous=$arg
done
cat > "$FAKE_PROMPT"
if [ "\${FAKE_COMMIT:-}" = yes ]; then
  printf 'work from Codex\\n' > note.txt
  git add note.txt
  git -c user.name=Codex -c user.email=codex@example.invalid commit -q -m 'feat: write the note'
fi
[ -z "$last" ] || printf 'Codex answer\\n' > "$last"
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Codex answer"}}' '{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":2,"output_tokens":3}}'
`, { mode: 0o755 });
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_ARGS"
printf '%s\\n' "\${GH_TOKEN:-}" "\${GITHUB_TOKEN:-}" "\${SSH_AUTH_SOCK:-}" "\${TMPDIR:-}" > "$FAKE_ENV"
cat > "$FAKE_PROMPT"
if [ "\${FAKE_COMMIT:-}" = yes ]; then
  printf 'work from Claude\\n' > note.txt
  git add note.txt
  git -c user.name=Claude -c user.email=claude@example.invalid commit -q -m 'feat: write the note'
fi
printf '%s\\n' '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"Claude answer"}]}}' '{"type":"result","is_error":false,"result":"Claude answer","modelUsage":{}}'
`, { mode: 0o755 });
}

function runRole(role, adapter, repo = fixtureProject(), extra = {}) {
  const dir = scratch('cleared-role-');
  fakeClis(dir);
  const prompt = join(dir, 'prompt.md');
  writeFileSync(prompt, 'password = "a-made-up-long-value"\n');
  const report = join(dir, 'report.md');
  const usage = join(dir, 'usage.json');
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    CLEARED_REPO: repo,
    CLEARED_CONF: join(ORCH_HOME, 'agents.example.conf'),
    CLEARED_STATE_DIR: join(dir, 'state'),
    FAKE_ARGS: join(dir, 'args'),
    FAKE_ENV: join(dir, 'env'),
    FAKE_PROMPT: join(dir, 'received'),
    ...extra,
  };
  const run = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; permissions_env "$2"; adapter_env "$3"; exec "$1/adapters/$3.sh" run --model m --prompt-file "$4" --report "$5" --usage "$6"', '_', ORCH_HOME, role, adapter, prompt, report, usage], {
    cwd: repo, env, encoding: 'utf8',
  });
  return {
    run,
    args: existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8').trim().split('\n') : [],
    prompt: existsSync(join(dir, 'received')) ? readFileSync(join(dir, 'received'), 'utf8') : '',
    report: existsSync(report) ? readFileSync(report, 'utf8') : '',
    usage: existsSync(usage) ? JSON.parse(readFileSync(usage, 'utf8')) : {},
    cliEnv: existsSync(join(dir, 'env')) ? readFileSync(join(dir, 'env'), 'utf8').trimEnd().split('\n') : [],
  };
}

test('each safe role maps to both CLIs, while host Codex refuses trusted-script write roles', () => {
  const { path: repo } = laneWithRemote('dev/X-99', null);
  execFileSync('git', ['-C', repo, 'branch', 'dev/X-98']);
  for (const [name, settings] of Object.entries(example.sections).filter(([key]) => key.startsWith('permissions.'))) {
    const role = name.slice('permissions.'.length);
    const claude = runRole(role, 'claude', repo);
    const codex = runRole(role, 'codex', repo, {
      ADAPTER_TASK_SCRIPT: '/does/not/exist', ADAPTER_TASK_TOOLS: 'yes', ADAPTER_COMMITS: 'no',
      GH_TOKEN: 'test-forge-token', GITHUB_TOKEN: 'test-github-token', SSH_AUTH_SOCK: '/tmp/test-agent.sock',
    });
    assert.equal(claude.run.status, 0, `${role}: ${claude.run.stderr}`);
    if (role === 'release-live') {
      assert.equal(codex.run.status, 2, role);
      assert.match(codex.report, /requires \[security\] agent_user/, role);
      continue;
    }
    if (settings.mode === 'read-only' && settings.write) {
      assert.equal(codex.run.status, 2, role);
      assert.match(codex.report, /needs trusted scripts to write state/, role);
      assert.deepEqual(codex.args, [], role);
      continue;
    }
    assert.equal(codex.run.status, 0, `${role}: ${codex.run.stderr}`);
    assert.equal(codex.prompt, claude.prompt, role);
    assert.match(codex.report, /adapter: codex/);
    assert.equal(codex.usage.tokens_total, 12);
    if (settings.mode === 'accept-edits') assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'acceptEdits', role);
    if (settings.mode === 'read-only') assert.ok(claude.args.includes('Edit'), `${role}: Claude edit denied`);
    const profile = codex.args.find((arg) => arg.startsWith('permissions.cleared='));
    assert.ok(profile, `${role}: Codex profile`);
    assert.match(profile, new RegExp(`extends=":${settings.mode === 'accept-edits' ? 'workspace' : 'read-only'}"`), role);
    assert.match(profile, new RegExp(`network=\\{enabled=${settings.network === 'yes' ? 'true' : 'false'}\\}`), role);
    assert.ok(codex.args.includes('approval_policy="never"'), role);
    assert.ok(codex.args.includes('--ignore-user-config'), role);
    assert.ok(codex.args.some((arg) => arg.startsWith('projects.') && arg.endsWith('trust_level="untrusted"')), `${role}: project config is isolated`);
    assert.ok(!codex.args.includes('/does/not/exist'), `${role}: container setting ignored`);
    assert.deepEqual(codex.cliEnv.slice(0, 3), ['', '', ''], `${role}: forge credentials are removed`);
    assert.match(codex.cliEnv[3], /cleared-tmp$/, `${role}: lane-local temporary directory`);
    if (settings.mode === 'accept-edits' && settings.allow?.includes('git commit')) {
      assert.match(profile, /commondir"="read"/, `${role}: Git common-directory pointer is protected`);
      assert.match(profile, /config\.worktree"="read"/, `${role}: worktree config is protected`);
      assert.match(profile, /objects\/info"="read"/, `${role}: alternate object store is protected`);
      assert.match(profile, /refs\/heads\/dev\/X-98"="deny"/, `${role}: sibling branch is protected`);
    }
  }
});

test('a host Codex work session does not start when its heavy-command slot cannot open', () => {
  const repo = fixtureProject();
  const dir = scratch('cleared-gate-');
  const conf = join(dir, 'agents.conf');
  writeFileSync(conf, readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').replace('heavy_wait_minutes = 30', 'heavy_wait_minutes = 0'));
  const result = runRole('review', 'codex', repo, {
    CLEARED_CONF: conf, ORCH_LANE: 'review/X-99', CLEARED_STATE_DIR: join(dir, 'state'),
  });
  assert.equal(result.run.status, 2, result.run.stderr);
  assert.deepEqual(result.args, []);
  assert.match(result.report, /host stayed busy/);
});

test('a text-only Codex write-up can run outside a Git checkout', () => {
  const empty = scratch('cleared-writeup-');
  const result = runRole('writing', 'codex', empty, { ORCH_TEXT_ONLY: '1' });
  assert.equal(result.run.status, 0, result.run.stderr);
  assert.ok(result.args.includes('--ephemeral'));
  assert.ok(result.args.includes('--skip-git-repo-check'));
});

test('a commit-capable host run refuses the main checkout', () => {
  const repo = fixtureProject();
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'dev/X-100']);
  const result = runRole('dev', 'codex', repo);
  assert.equal(result.run.status, 64);
  assert.match(result.report, /linked lane worktree/);
  assert.deepEqual(result.args, []);
});

for (const harness of ['codex', 'claude']) test(`host ${harness} commits in its lane and the shared push guard checks the commit`, () => {
  const { box, path, onRemote, push } = laneWithRemote('dev/X-55', null);
  mkdirSync(join(box.repo, '.cleared'), { recursive: true });
  writeFileSync(join(box.repo, '.cleared', 'agents.conf'), '[guard]\nterms = none\nallowed = none\n');
  box.git('add', '.cleared/agents.conf');
  box.git('commit', '-q', '-m', 'chore: configure guard');
  box.git('push', '-q', 'origin', 'main');
  execFileSync('git', ['-C', path, 'merge', '-q', 'main']);
  const done = runRole('dev', harness, path, { FAKE_COMMIT: 'yes', CLEARED_REPO: box.repo, CLEARED_CONF: join(box.home, 'agents.conf'), CLEARED_STATE_DIR: box.state, ORCH_GUARD_REF: 'main' });
  assert.equal(done.run.status, 0, done.run.stderr);
  assert.match(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /feat: write the note/);
  const sent = push();
  assert.equal(sent.status, 0, sent.stderr);
  assert.ok(onRemote().some((line) => line.startsWith('dev/X-55 ')));
  writeFileSync(join(path, 'note.txt'), 'password = "a-made-up-long-value"\n');
  execFileSync('git', ['-C', path, 'add', 'note.txt']);
  execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'fix: update the note']);
  const blocked = push();
  assert.notEqual(blocked.status, 0, 'the guard must refuse the outgoing diff regardless of harness');
  assert.match(blocked.stderr, /refused by the guard/);
});
