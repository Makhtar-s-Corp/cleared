import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME, loadConf } from '../lib/conf.mjs';
import { fixtureProject, laneWithRemote, scratch } from './support.mjs';

const example = loadConf(join(ORCH_HOME, 'agents.example.conf'));

function fakeClis(dir) {
  writeFileSync(join(dir, 'codex'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_ARGS"
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
    FAKE_PROMPT: join(dir, 'received'),
    ...extra,
  };
  const run = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; permissions_env "$2"; adapter_env "$3"; exec "$1/adapters/$3.sh" run --model m --prompt-file "$4" --report "$5" --usage "$6"', '_', ORCH_HOME, role, adapter, prompt, report, usage], {
    cwd: repo, env, encoding: 'utf8',
  });
  return {
    run,
    args: readFileSync(join(dir, 'args'), 'utf8').trim().split('\n'),
    prompt: readFileSync(join(dir, 'received'), 'utf8'),
    report: readFileSync(report, 'utf8'),
    usage: JSON.parse(readFileSync(usage, 'utf8')),
  };
}

test('every role gives Claude and host Codex the same configured edit and network intent', () => {
  const repo = fixtureProject();
  for (const [name, settings] of Object.entries(example.sections).filter(([key]) => key.startsWith('permissions.'))) {
    const role = name.slice('permissions.'.length);
    const claude = runRole(role, 'claude', repo);
    const codex = runRole(role, 'codex', repo, {
      ADAPTER_TASK_SCRIPT: '/does/not/exist', ADAPTER_TASK_TOOLS: 'yes', ADAPTER_COMMITS: 'no',
    });
    assert.equal(claude.run.status, 0, `${role}: ${claude.run.stderr}`);
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
    assert.ok(!codex.args.includes('/does/not/exist'), `${role}: container setting ignored`);
  }
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
