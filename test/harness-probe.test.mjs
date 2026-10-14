// The adapters' questions to a harness CLI (list-models), run through the real adapter scripts with a fake CLI on
// PATH that writes down its arguments, its environment and the program that started it.
//
// These tests prove the wiring only: which account, which prefixes, which environment, which timeout, how an answer
// is read. A fake Claude proves nothing about the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { scratch } from './support.mjs';

// A fake CLI that answers by the name of the model it is asked: "answers-*" says OK, "wrong-*" says something
// else, "slow-*" never answers, any other is unknown to it. Each call appends its arguments (one JSON array a
// line) to calls, its environment to env-<n>, and the name of the program that started it to parents.
const fakeClaude = (dir) => `#!/usr/bin/env bash
jq -nc '$ARGS.positional' --args -- "$@" >> "${join(dir, 'calls')}"
n=$(wc -l < "${join(dir, 'calls')}")
env > "${join(dir, 'env-')}$n"
ps -o comm= -p "$PPID" >> "${join(dir, 'parents')}"
model=
previous=
for arg in "$@"; do [ "$previous" != --model ] || model=$arg; previous=$arg; done
case "$model" in
  answers-*) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"OK","modelUsage":{}}' ;;
  wrong-*) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Hello, how can I help?","modelUsage":{}}' ;;
  slow-*) sleep 30 ;;
  *) printf '%s\\n' "{\\"type\\":\\"result\\",\\"is_error\\":true,\\"result\\":\\"There's an issue with the selected model ($model). It may not exist.\\"}"; exit 1 ;;
esac
`;

// The account of the agents through a sudo that writes down what it is asked and only passes the command on, and
// a bubblewrap that does the same (the PATH under sudo is the agents' own: the CLI is named by its full path).
const fakeSudo = (dir) => `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(dir, 'sudo-calls')}"
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
case "$5" in id) exec id -u "$3" ;; test) exit 0 ;; *) shift 4; exec "$@" ;; esac
`;
const fakeBwrap = (dir) => `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(dir, 'bwrap-calls')}"
while [ "$1" != -- ]; do shift; done; shift
name=$1; shift
exec "${dir}/$name" "$@"
`;

export function harnessBox({ agentUser = false, conf = '' } = {}) {
  const dir = scratch('cleared-harness-');
  const state = join(dir, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(dir, 'claude'), fakeClaude(dir), { mode: 0o755 });
  writeFileSync(join(dir, 'sudo'), fakeSudo(dir), { mode: 0o755 });
  writeFileSync(join(dir, 'bwrap'), fakeBwrap(dir), { mode: 0o755 });
  const security = agentUser ? `[security]\nagent_user = nobody\nbwrap_path = ${join(dir, 'bwrap')}\n` : '[security]\nagent_user =\n';
  writeFileSync(join(dir, 'agents.conf'), `${conf}${security}`);
  const env = {
    PATH: `${dir}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'),
    CLEARED_REPO: dir, CLEARED_CONF: join(dir, 'agents.conf'), CLEARED_STATE_DIR: state,
    // Never handed to the CLI: the subscription pays.
    ANTHROPIC_API_KEY: 'sk-ant-test-not-for-the-cli', OPENAI_API_KEY: 'sk-test-not-for-the-cli',
  };
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return {
    dir, env, read,
    adapter: (name, ...args) => spawnSync(join(ORCH_HOME, 'adapters', `${name}.sh`), args, { cwd: dir, env, encoding: 'utf8', timeout: 60000 }),
    calls: () => read('calls').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cliEnv: (n) => read(`env-${n}`),
    parents: () => read('parents').split('\n').filter(Boolean),
  };
}

for (const agentUser of [false, true]) {
  test(`list-models of the claude adapter asks the CLI${agentUser ? ' under [security] agent_user (sudo, then bubblewrap)' : ' as this account'}, under a timeout: a model that answers is listed, an unavailable one is not`, () => {
    const box = harnessBox({ agentUser });
    const run = box.adapter('claude', 'list-models', 'answers-1', 'gone-1', 'answers-2');
    assert.equal(run.status, 0, run.stderr);
    // Before the fix `timeout 120 cli` exited 127 (cli is a function): no CLI was started and nothing was listed.
    assert.deepEqual(run.stdout.split('\n').filter(Boolean), ['answers-1', 'answers-2']);
    const calls = box.calls();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((args) => args[args.indexOf('--model') + 1]), ['answers-1', 'gone-1', 'answers-2']);
    for (const args of calls) {
      assert.equal(args[0], '-p');
      assert.equal(args[args.indexOf('--tools') + 1], '');
      assert.ok(args.includes('--no-session-persistence') && args.includes('--strict-mcp-config'), args.join(' '));
    }
    // The timeout is the program that started the CLI, in both cases.
    assert.deepEqual(box.parents(), ['timeout', 'timeout', 'timeout']);
    assert.doesNotMatch(box.cliEnv(1), /^ANTHROPIC_API_KEY=/m);
    if (agentUser) {
      const sudo = box.read('sudo-calls').split('\n').filter((line) => / claude -p /.test(line));
      assert.equal(sudo.length, 3, box.read('sudo-calls'));
      for (const line of sudo) assert.match(line, new RegExp(`^-n -u nobody -- env .* timeout -k 10 120 ${join(box.dir, 'bwrap')} --dev-bind / / -- claude -p `));
      assert.equal(box.read('bwrap-calls').split('\n').filter(Boolean).length, 3);
    } else {
      assert.equal(box.read('sudo-calls'), '');
    }
  });
}

test('list-models of the claude adapter lists nothing when no model answers', () => {
  const box = harnessBox();
  const run = box.adapter('claude', 'list-models', 'gone-1', 'gone-2');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(box.calls().length, 2);
});

// A tripwire over the source text, not a proof: a program that runs another (timeout, xargs, nohup, setsid, nice,
// stdbuf, env, sudo, exec) cannot run a function of the shell. `command` is left out: it is the way to run the
// program around a function of the same name (gh in lib/common.sh). It does not see a function named through a
// variable or an array.
test('no script hands one of its shell functions to a program that runs programs (timeout, xargs, env, sudo, ...)', () => {
  const shell = [...readdirSync(ORCH_HOME).filter((name) => name.endsWith('.sh')),
    ...['adapters', 'lib', 'serve'].flatMap((dir) => readdirSync(join(ORCH_HOME, dir), { recursive: true })
      .map((name) => join(dir, String(name))).filter((name) => name.endsWith('.sh')))];
  const texts = Object.fromEntries(shell.map((name) => [name, readFileSync(join(ORCH_HOME, name), 'utf8')
    .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').replace(/\\\n\s*/g, ' ')]));
  const functions = new Set(Object.values(texts).flatMap((text) => [...text.matchAll(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)/gm)].map((m) => m[1])));
  assert.ok(functions.has('cli') && functions.has('ledger') && functions.has('gh'), [...functions].join(' '));
  const word = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\S+)`;
  const runner = String.raw`(?:timeout(?:\s+-\S+)*(?:\s+-k\s+\S+)?\s+\S+|xargs(?:\s+-\S+)*|nohup|setsid(?:\s+-\S+)*|nice(?:\s+-n\s+\S+|\s+-\S+)*|stdbuf(?:\s+-\S+)*|exec|env(?:\s+-u\s+${word}|\s+-\S+|\s+\w+=${word}|\s+"\$\{\w+\[@\]\}")*|sudo(?:\s+-u\s+${word}|\s+-\S+)*(?:\s+--)?(?:\s+env(?:\s+-u\s+${word}|\s+\w+=${word}|\s+"\$\{\w+\[@\]\}")*)?)`;
  const around = new RegExp(String.raw`(?:^|[\s($\`;|&])${runner}\s+(${[...functions].join('|')})(?=[\s;)|&]|$)`, 'm');
  // The line of issue #85 is caught.
  assert.match('if out=$(cd "$empty" && timeout 120 cli -p --model "$candidate" 2>/dev/null)', around);
  assert.match('sudo -n -u "$agent_user" -- env PATH="$p" ledger event', around);
  for (const [name, text] of Object.entries(texts)) {
    const found = text.match(around);
    assert.equal(found, null, `${name} hands the shell function ${found?.[1]} to a program: ${found?.[0]}`);
  }
});
