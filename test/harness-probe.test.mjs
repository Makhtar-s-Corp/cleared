// The adapters' questions to a harness CLI (list-models, probe), serve/check-harness.sh and the installer's use of
// it, run through the real scripts with fake CLIs on PATH that write down their arguments, their environment, their
// folder and the program that started them.
//
// These tests prove the wiring only: which account, which prefixes, which environment, which timeout, how an answer
// is read, what the installer does with a failure. A fake Claude proves nothing about the real one: the proof that
// each configured harness answers is the installer's run on the host (serve/check-harness.sh), with the real CLIs
// signed in under the agents' account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { scratch } from './support.mjs';

// A fake CLI that answers by the name of the model it is asked: "answers-*" says OK, "wrong-*" says something
// else, "slow-*" never answers, "leak-*" fails with a key in its message, any other is unknown to it. Each call appends its arguments (one JSON array a
// line) to calls, its environment to env-<n>, and the name of the program that started it to parents.
const fakeClaude = (dir) => `#!/usr/bin/env bash
jq -nc '$ARGS.positional' --args -- "$@" >> "${join(dir, 'calls')}"
n=$(wc -l < "${join(dir, 'calls')}")
env > "${join(dir, 'env-')}$n"
ps -o comm= -p "$PPID" >> "${join(dir, 'parents')}"
pwd >> "${join(dir, 'cwds')}"
stat -c %a . >> "${join(dir, 'modes')}"
model=
previous=
for arg in "$@"; do [ "$previous" != --model ] || model=$arg; previous=$arg; done
case "$model" in
  answers-*) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"OK","modelUsage":{}}' ;;
  pretty-*) printf '%s\\n' '{' '  "type": "result",' '  "subtype": "success",' '  "is_error": false,' '  "result": "OK"' '}' ;;
  noisy-*) printf '%s\\n' 'Warning: an update is available' '{"type":"result","subtype":"success","is_error":false,"result":"OK"}' ;;
  stack-*) printf '%s\\n' 'Warning: an update is available' '    at Object.<anonymous> (/usr/lib/node_modules/cli.js:12:3)' 'Error: not logged in, run /login' >&2; exit 1 ;;
  leak-*) printf '%s\\n' '{"type":"result","is_error":true,"result":"Invalid API key sk-ant-api03-Zm9vYmFyYmF6cXV4cXV1eA · Please run /login"}'; exit 1 ;;
  wrong-*) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Hello, how can I help?","modelUsage":{}}' ;;
  slow-*) sleep 30 ;;
  *) printf '%s\\n' "{\\"type\\":\\"result\\",\\"is_error\\":true,\\"result\\":\\"There's an issue with the selected model ($model). It may not exist.\\"}"; exit 1 ;;
esac
`;

// The same for Codex, in the JSON lines of \`codex exec --json\`.
const fakeCodex = (dir) => `#!/usr/bin/env bash
jq -nc '$ARGS.positional' --args -- "$@" >> "${join(dir, 'calls')}"
n=$(wc -l < "${join(dir, 'calls')}")
env > "${join(dir, 'env-')}$n"
ps -o comm= -p "$PPID" >> "${join(dir, 'parents')}"
pwd >> "${join(dir, 'cwds')}"
stat -c %a . >> "${join(dir, 'modes')}"
model=
previous=
for arg in "$@"; do [ "$previous" != --model ] || model=$arg; previous=$arg; done
case "$model" in
  answers-*) printf '%s\\n' '{"type":"thread.started"}' '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' '{"type":"turn.completed","usage":{}}' ;;
  wrong-*) printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Hello, how can I help?"}}' ;;
  slow-*) sleep 30 ;;
  *) printf '%s\\n' "{\\"type\\":\\"error\\",\\"message\\":\\"The model $model does not exist or you do not have access to it.\\"}"; echo 'Error: unexpected status 400' >&2; exit 1 ;;
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
  writeFileSync(join(dir, 'codex'), fakeCodex(dir), { mode: 0o755 });
  writeFileSync(join(dir, 'sudo'), fakeSudo(dir), { mode: 0o755 });
  writeFileSync(join(dir, 'bwrap'), fakeBwrap(dir), { mode: 0o755 });
  const security = agentUser ? `[security]\nagent_user = nobody\nbwrap_path = ${join(dir, 'bwrap')}\n` : '[security]\nagent_user =\n';
  writeFileSync(join(dir, 'agents.conf'), `${conf}${security}`);
  // The service's own temporary folder, closed to anybody else.
  const tmp = join(dir, 'private-tmp');
  mkdirSync(tmp, { mode: 0o700 });
  const env = {
    PATH: `${dir}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), TMPDIR: tmp,
    CLEARED_REPO: dir, CLEARED_CONF: join(dir, 'agents.conf'), CLEARED_STATE_DIR: state,
    // Never handed to the CLI: the subscription pays.
    ANTHROPIC_API_KEY: 'sk-ant-test-not-for-the-cli', OPENAI_API_KEY: 'sk-test-not-for-the-cli',
  };
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return {
    dir, env, read,
    adapter: (name, ...args) => spawnSync(join(ORCH_HOME, 'adapters', `${name}.sh`), args, { cwd: dir, env, encoding: 'utf8', timeout: 60000 }),
    check: (extra = {}) => spawnSync(join(ORCH_HOME, 'serve', 'check-harness.sh'), [], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 }),
    // The models asked a question (a call of `--version`, from the dashboard, asks none).
    asked: () => read('calls').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((args) => args.includes('--model')).map((args) => args[args.indexOf('--model') + 1]),
    calls: () => read('calls').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cliEnv: (n) => read(`env-${n}`),
    parents: () => read('parents').split('\n').filter(Boolean),
    cwds: () => read('cwds').split('\n').filter(Boolean),
    modes: () => read('modes').split('\n').filter(Boolean),
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
    for (const cwd of box.cwds()) assert.match(cwd, /^\/tmp\/cleared-probe-[^/]+$/);
    if (agentUser) assert.deepEqual(box.modes(), ['755', '755', '755']);
    assert.doesNotMatch(box.cliEnv(1), /^ANTHROPIC_API_KEY=/m);
    if (agentUser) {
      const sudo = box.read('sudo-calls').split('\n').filter((line) => / claude -p /.test(line));
      assert.equal(sudo.length, 3, box.read('sudo-calls'));
      for (const line of sudo) assert.match(line, new RegExp(`^-n -u nobody -- env .* timeout -k 10 120 ${join(box.dir, 'bwrap')} --dev-bind / / --die-with-parent --unshare-pid --proc /proc -- claude -p `));
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
  // Within one line (continuations are joined above): blanks only between the words, never a line break.
  const b = '[ \\t]+';
  const word = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\S+)`;
  const assigned = String.raw`(?:${b}-u${b}${word}|${b}\w+=${word}|${b}"\$\{\w+\[@\]\}")`;
  const runner = String.raw`(?:timeout(?:${b}-\S+)*(?:${b}-k${b}\S+)?${b}\S+|xargs(?:${b}-\S+)*|nohup|setsid(?:${b}-\S+)*|nice(?:${b}-n${b}\S+|${b}-\S+)*|stdbuf(?:${b}-\S+)*|exec|env(?:${assigned}|${b}-\S+)*|sudo(?:${b}-u${b}${word}|${b}-\S+)*(?:${b}--)?(?:${b}env${assigned}*)?)`;
  const around = new RegExp(String.raw`(?:^|[\s($\`;|&])${runner}${b}(${[...functions].join('|')})(?=[\s;)|&]|$)`, 'm');
  // The line of issue #85 is caught.
  assert.match('if out=$(cd "$empty" && timeout 120 cli -p --model "$candidate" 2>/dev/null)', around);
  assert.match('sudo -n -u "$agent_user" -- env PATH="$p" ledger event', around);
  for (const [name, text] of Object.entries(texts)) {
    const found = text.match(around);
    assert.equal(found, null, `${name} hands the shell function ${found?.[1]} to a program: ${found?.[0]}`);
  }
});

for (const [adapter, key] of [['claude', 'ANTHROPIC_API_KEY'], ['codex', 'OPENAI_API_KEY']]) {
  for (const agentUser of [false, true]) {
    test(`probe of the ${adapter} adapter asks the real CLI one word${agentUser ? ' under [security] agent_user (sudo, then bubblewrap)' : ' as this account'}, from an empty folder, under a timeout, without API key`, () => {
      const box = harnessBox({ agentUser });
      const run = box.adapter(adapter, 'probe', 'answers-1');
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, 'ok answers-1\n');
      const [args] = box.calls();
      assert.equal(args.at(-1), 'Reply with the single word OK.');
      if (adapter === 'claude') {
        assert.equal(args[0], '-p');
        assert.equal(args[args.indexOf('--tools') + 1], '');
        for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--max-budget-usd']) assert.ok(args.includes(flag), `${flag}: ${args.join(' ')}`);
      } else {
        assert.equal(args[0], 'exec');
        for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config']) assert.ok(args.includes(flag), `${flag}: ${args.join(' ')}`);
        assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
      }
      assert.equal(args[args.indexOf('--model') + 1], 'answers-1');
      assert.deepEqual(box.parents(), ['timeout']);
      // A folder of its own in /tmp, not the one the probe was started from nor under the service's TMPDIR (closed
      // here, as a private one would be); open to the agents' account when there is one.
      const [cwd] = box.cwds();
      assert.match(cwd, /^\/tmp\/cleared-probe-[^/]+$/);
      if (agentUser) assert.deepEqual(box.modes(), ['755']);
      assert.equal(existsSync(cwd), false, 'the empty folder is removed afterwards');
      assert.doesNotMatch(box.cliEnv(1), new RegExp(`^${key}=`, 'm'));
      if (agentUser) {
        const started = box.read('sudo-calls').split('\n').filter((line) => new RegExp(` ${adapter} `).test(line));
        assert.equal(started.length, 1, box.read('sudo-calls'));
        assert.match(started[0], new RegExp(`^-n -u nobody -- env .* timeout -k 10 120 ${join(box.dir, 'bwrap')} --dev-bind / / --die-with-parent --unshare-pid --proc /proc -- ${adapter} `));
      } else {
        assert.equal(box.read('sudo-calls'), '');
      }
    });
  }

  test(`probe of the ${adapter} adapter fails on a wrong answer, an unknown model and a CLI that does not answer in time`, () => {
    const box = harnessBox({ agentUser: true });
    const wrong = box.adapter(adapter, 'probe', 'wrong-1');
    assert.equal(wrong.status, 1);
    assert.equal(wrong.stdout, 'FAIL wrong-1: the answer was not OK: Hello, how can I help?\n');
    const gone = box.adapter(adapter, 'probe', 'gone-1');
    assert.equal(gone.status, 1);
    assert.match(gone.stdout, /^FAIL gone-1: .*(It may not exist|does not exist)/);
    assert.equal(gone.stdout.split('\n').filter(Boolean).length, 1);
    const started = Date.now();
    const slow = spawnSync(join(ORCH_HOME, 'adapters', `${adapter}.sh`), ['probe', 'slow-1'], { cwd: box.dir, env: { ...box.env, CLEARED_PROBE_TIMEOUT: '1' }, encoding: 'utf8', timeout: 60000 });
    assert.equal(slow.status, 1, slow.stderr);
    assert.equal(slow.stdout, 'FAIL slow-1: no answer within 1s\n');
    assert.ok(Date.now() - started < 20000, 'stopped by its timeout, not by the end of the fake');
  });
}

test('probe of the claude adapter reads the result printed on one line, pretty-printed over several, or after a line that is not JSON', () => {
  const box = harnessBox();
  for (const model of ['answers-1', 'pretty-1', 'noisy-1']) {
    const run = box.adapter('claude', 'probe', model);
    assert.equal(run.status, 0, `${model}: ${run.stdout}${run.stderr}`);
    assert.equal(run.stdout, `ok ${model}\n`);
  }
});

test('probe never prints the key a CLI error carries, and keeps the paths of its reason readable', () => {
  const box = harnessBox();
  const run = box.adapter('claude', 'probe', 'leak-1');
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^FAIL leak-1: Invalid API key \[hidden\]/);
  assert.doesNotMatch(run.stdout + run.stderr, /Zm9vYmFy/);
  const reason = (text) => spawnSync('bash', ['-c', '. "$1/lib/contract.sh"; contract_probe_reason', '_', ORCH_HOME], { input: text, encoding: 'utf8' }).stdout;
  assert.equal(reason("\n  Error: Cannot find module '/home/service-account/cleared-checkout/lead-command.mjs'\nsecond line\n"),
    "Error: Cannot find module '/home/service-account/cleared-checkout/lead-command.mjs'\n");
  assert.equal(reason('token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB refused\n'), 'token [hidden] refused\n');
  // Keys with / + = or . (base64, a JWT) are hidden whole, not left in halves; so is a long hex key, and a piece of
  // a path that looks like one. Model ids, error names and hyphenated words stay.
  assert.equal(reason('refused AbCd1234/efGH+ijkl5678=mnOPqrst90== and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n'),
    'refused [hidden] and [hidden]\n');
  assert.equal(reason('invalid 0123456789abcdef0123456789abcdef01 at /run/secrets/AbCd1234efGH5678ijkl9012mnOP\n'), 'invalid [hidden] at /run/secrets/[hidden]\n');
  assert.equal(reason('failed: claude-sonnet-4-5-20250929 UnhandledPromiseRejectionWarning risk-assessment\n'), 'failed: claude-sonnet-4-5-20250929 UnhandledPromiseRejectionWarning risk-assessment\n');
  // The line that names the error, not the warning or the stack frame before it; else the first line.
  assert.equal(reason('Warning: an update is available\n    at Object.<anonymous> (/x/cli.js:1:2)\nError: not logged in\n'), 'Error: not logged in\n');
  assert.equal(reason('Hello there\nsecond line\n'), 'Hello there\n');
  const stack = box.adapter('claude', 'probe', 'stack-1');
  assert.equal(stack.status, 1);
  assert.equal(stack.stdout, 'FAIL stack-1: Error: not logged in, run /login\n');
});

const probedConf = `[models]
lead = claude:answers-lead
backup = claude:answers-backup
bug = claude:answers-bug
other = codex:answers-other
same = claude:answers-lead
unused = claude:answers-unused
unused-codex = codex:answers-unused
[fallbacks]
lead = backup
unused = lead
[roles]
dev = lead
[rules]
dev label=Bug -> bug
[harness]
dev = other
[review]
when_same = same
`;

test('serve/check-harness.sh probes each model the configuration can start once, under [security] agent_user, and no alias nothing names', () => {
  const box = harnessBox({ agentUser: true, conf: probedConf });
  const run = box.check();
  assert.equal(run.status, 0, run.stderr);
  // [roles], its [fallbacks], [rules], [harness], [review] when_same (the same model as the lead: asked once).
  assert.deepEqual(box.asked().sort(), ['answers-backup', 'answers-bug', 'answers-lead', 'answers-other']);
  for (const line of box.read('sudo-calls').split('\n').filter((line) => / (claude|codex) /.test(line))) assert.match(line, /^-n -u nobody -- env /);
  assert.match(run.stdout, /^Harness probe, as nobody: one small request per model, on the subscription\.$/m);
  assert.match(run.stdout, /^ {2}ADAPTER +MODEL +ALIASES +RESULT$/m);
  assert.match(run.stdout, /^ {2}claude +answers-lead +lead,same +ok$/m);
  assert.match(run.stdout, /^ {2}codex +answers-other +other +ok$/m);
  assert.doesNotMatch(run.stdout, /unused/);
});

test('serve/check-harness.sh fails, and says which model and why, when one does not answer or a named alias is not in [models]', () => {
  const box = harnessBox({ conf: probedConf.replace('backup = claude:answers-backup', 'backup = claude:gone-backup').replace('[harness]\ndev = other', '[harness]\ndev = missing') });
  const run = box.check();
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^ {2}claude +gone-backup +backup +FAIL: .*It may not exist/m);
  assert.match(run.stdout, /^ {2}claude +answers-lead +lead,same +ok$/m);
  assert.match(run.stdout, /FAIL: not in \[models\] \(named by \[harness\] dev\)/);
  assert.match(run.stderr, /^check-harness\.sh: claude:gone-backup \(backup\) did not answer: .*It may not exist/m);
  assert.match(run.stderr, /the alias missing, named by \[harness\] dev, is not in \[models\]/);
});

test('serve/check-harness.sh has nothing to ask when no model is named', () => {
  const box = harnessBox({ conf: '[models]\nunused = claude:answers-unused\n' });
  const run = box.check();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /nothing to probe/);
  assert.deepEqual(box.calls(), []);
});

// The installer, up to its units: a project with a committed configuration, Tailscale and systemd as fakes that
// write down what they are asked.
function installer(conf, { security = '[security]\nagent_user =\n' } = {}) {
  const box = harnessBox();
  const project = join(box.dir, 'project');
  mkdirSync(join(project, '.cleared'), { recursive: true });
  writeFileSync(join(project, '.cleared', 'agents.conf'), `${conf.replaceAll('@BOX@', box.dir)}[guard]\nterms = none\nallowed = none\n${security.replaceAll('@BOX@', box.dir)}`);
  const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const bin = join(box.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\necho 100.64.0.1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(box.dir, 'systemctl-calls')}'\ncase "$*" in *'is-enabled '*|*'is-active '*) exit 1;; *'show '*) echo inactive;; esac\nexit 0\n`, { mode: 0o755 });
  const { CLEARED_CONF, CLEARED_STATE_DIR, ...env } = box.env;
  const install = (extra = {}) => spawnSync(join(ORCH_HOME, 'serve', 'install.sh'), [], { cwd: box.dir, encoding: 'utf8', timeout: 120000,
    env: { ...env, ...extra, PATH: `${bin}:${env.PATH}`, CLEARED_REPO: project, XDG_STATE_HOME: join(box.dir, 'state-home'), ORCH_GUARD_REF: 'HEAD' } });
  const units = join(box.dir, '.config', 'systemd', 'user');
  return { box, install, systemctl: () => box.read('systemctl-calls'), units: () => (existsSync(units) ? readdirSync(units) : []) };
}

test('the installer stops before any unit when a configured harness model does not answer, naming the model and the reason', () => {
  const { box, install, systemctl, units } = installer(probedConf.replace('backup = claude:answers-backup', 'backup = claude:gone-backup'));
  const run = install();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /install\.sh: harness probe failed: claude:gone-backup \(backup\) did not answer: There's an issue with the selected model \(gone-backup\)/);
  assert.match(run.stderr, /No unit was installed or started/);
  assert.match(run.stderr, /CLEARED_SKIP_HARNESS_PROBE=1/);
  assert.match(run.stdout, /^ {2}claude +gone-backup +backup +FAIL: /m, 'the table is printed');
  assert.ok(box.asked().includes('gone-backup'));
  assert.doesNotMatch(systemctl(), /daemon-reload|enable --now|restart/);
  assert.deepEqual(units(), []);
});

test('the installer prints the probe table and goes on when every configured harness model answers', () => {
  const { box, install, systemctl, units } = installer(probedConf);
  const run = install();
  assert.match(run.stdout, /^Harness probe, as .*: one small request per model, on the subscription\.$/m);
  assert.match(run.stdout, /^ {2}claude +answers-lead +lead,same +ok$/m);
  assert.deepEqual(box.asked().sort(), ['answers-backup', 'answers-bug', 'answers-lead', 'answers-other']);
  assert.match(systemctl(), /enable --now cleared-release-broker\.service/);
  assert.ok(units().includes('cleared-wake.service'));
});

test('CLEARED_SKIP_HARNESS_PROBE=1 skips the probe, and the installer says so loudly', () => {
  const { box, install, systemctl } = installer(probedConf.replace('backup = claude:answers-backup', 'backup = claude:gone-backup'));
  const run = install({ CLEARED_SKIP_HARNESS_PROBE: '1' });
  assert.match(run.stderr, /WARNING: CLEARED_SKIP_HARNESS_PROBE=1: the harness models were NOT probed/);
  assert.deepEqual(box.asked(), []);
  assert.match(systemctl(), /enable --now cleared-release-broker\.service/);
});

// Issue #87: the installer's probes that start node as the agents' account inherited the folder it was started
// from; one closed to that account made node fail on its current directory. The sudo here answers the account
// checks as a well set up host would, and its node fails as the real one did unless it is started from /.
function agentInstaller(conf = '') {
  const run = installer(conf, { security: '[security]\nagent_user = nobody\nbwrap_path = @BOX@/bwrap\nsocket_path = @BOX@/run/release.sock\n' });
  mkdirSync(join(run.box.dir, 'run'), { mode: 0o755 });
  mkdirSync(join(run.box.dir, 'door'), { mode: 0o755 });
  writeFileSync(join(run.box.dir, 'sudo'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(run.box.dir, 'sudo-calls')}"
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
case "$5" in
  id) exec id -u "$3" ;;
  true | find) exit 0 ;;
  test)
    [ "$6 \${7##*/}" = "-r release-request.mjs" ] && exit 0
    # The door of the heavy commands (#98): its folder is writable to the agents' account only when a test says
    # so, its host status is readable.
    [ "$6 $7" = "-w ${join(run.box.dir, 'door')}" ] && [ -n "\${FAKE_AGENT_WRITES_DOOR:-}" ] && exit 0
    [ "$6 \${7##*.}" = "-r json" ] && exit 0
    exit 1 ;;
  bash)
    printf '%s\n' "$*" >> "${join(run.box.dir, 'door-probes')}"
    [ -z "\${FAKE_DOOR_CLOSED:-}" ] || { echo "bash: line 1: \${@: -1}: Permission denied" >&2; exit 1; }
    shift 4; exec "$@" ;;
  env)
    pwd >> "${join(run.box.dir, 'node-cwds')}"
    if [ "$PWD" != / ]; then printf '%s\\n' 'node:internal/bootstrap/switches/does_own_process_state:126' '    cwd = rawMethods.cwd();' 'Error: EACCES: permission denied, uv_cwd' >&2; exit 1; fi
    [ -z "\${FAKE_NODE_SAYS:-}" ] || { printf '%s\\n' "$FAKE_NODE_SAYS" 'a second line' >&2; exit 1; }
    exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  return run;
}

test('the installer starts node as the agents\' account from /, whatever folder it was started from (#87)', () => {
  const { box, install, systemctl } = agentInstaller();
  const run = install({ CLEARED_SKIP_HARNESS_PROBE: '1' });
  assert.doesNotMatch(run.stderr, /lead-actions|environment probe|release socket/, run.stderr);
  const cwds = box.read('node-cwds').split('\n').filter(Boolean);
  assert.ok(cwds.length >= 3, box.read('sudo-calls'));
  assert.deepEqual([...new Set(cwds)], ['/']);
  assert.match(systemctl(), /enable --now cleared-release-broker\.service/);
});

test('when node fails as the agents\' account, the installer\'s message carries the first line it wrote (#87)', () => {
  const { install, systemctl } = agentInstaller();
  const run = install({ CLEARED_SKIP_HARNESS_PROBE: '1', FAKE_NODE_SAYS: 'sudo: a password is required' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /install\.sh: Configure the narrow agent-to-service sudo rule for serve\/lead-actions\.mjs; see docs\/security\.md \(the lead client as nobody said: sudo: a password is required\)$/m);
  assert.doesNotMatch(run.stderr, /a second line/);
  assert.doesNotMatch(systemctl(), /enable --now/);
});

// #98: the door of the heavy commands under agent_user lives outside the state; the installer makes it and proves,
// as the agents' account, that it can open it read-only and take its lock, and can write neither it nor its folder.
const doorConf = (lock = '@BOX@/door/heavy.lock') => `[lanes]\nheavy_commands = npm run test:ui\n${lock ? `heavy_lock = ${lock}\n` : ''}`;

test('the installer makes the door of the heavy commands outside the state and proves the agents\' account takes it read-only (#98)', () => {
  const { box, install, systemctl } = agentInstaller(doorConf());
  const run = install({ CLEARED_SKIP_HARNESS_PROBE: '1' });
  // (As in the tests above, the installer goes on to its units; what follows them needs a real host.)
  assert.doesNotMatch(run.stderr, /heavy_lock|host status/, run.stderr);
  const lock = join(box.dir, 'door', 'heavy.lock');
  assert.equal(execFileSync('stat', ['-c', '%a', lock], { encoding: 'utf8' }).trim(), '644');
  const status = JSON.parse(readFileSync(join(box.dir, 'door', 'heavy.status.json'), 'utf8'));
  assert.equal(status.free, false, 'not free until a wake has read the host');
  assert.match(box.read('door-probes'), new RegExp(`^-n -u nobody -- bash -c exec 8< "\\$1" && flock -w 60 8 _ ${lock}$`, 'm'));
  assert.match(box.read('sudo-calls'), new RegExp(`-- test -w ${join(box.dir, 'door')}$`, 'm'));
  assert.match(box.read('sudo-calls'), new RegExp(`-- test -w ${lock}$`, 'm'));
  assert.match(systemctl(), /enable --now cleared-release-broker\.service/);
});

for (const [name, extra, expected] of [
  ['the agents\' account can write the folder of the door', { FAKE_AGENT_WRITES_DOOR: '1' }, /install\.sh: nobody can write the directory of \[lanes\] heavy_lock \(.*\/door\): it may open the door for reading, nothing more$/m],
  ['the agents\' account cannot open the door read-only', { FAKE_DOOR_CLOSED: '1' }, /install\.sh: nobody cannot open \[lanes\] heavy_lock \(.*\/door\/heavy\.lock\) read-only and take its lock: .*Permission denied/m],
]) {
  test(`the installer stops before any unit when ${name} (#98)`, () => {
    const { box, install, systemctl } = agentInstaller(doorConf());
    const run = install({ CLEARED_SKIP_HARNESS_PROBE: '1', ...extra });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, expected);
    assert.doesNotMatch(systemctl(), /enable --now/);
  });
}

test('under agent_user the installer refuses heavy commands with no door outside the state, or a door inside it (#98)', () => {
  const none = agentInstaller(doorConf(''));
  const missing = none.install({ CLEARED_SKIP_HARNESS_PROBE: '1' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /install\.sh: Set \[lanes\] heavy_lock to an absolute path outside Cleared state, .*\(for example .*\/run\/heavy\.lock\)/);
  assert.doesNotMatch(none.systemctl(), /enable --now/);
  const inside = agentInstaller(doorConf('@BOX@/state-home/cleared/project/heavy.lock'));
  const refused = inside.install({ CLEARED_SKIP_HARNESS_PROBE: '1' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /install\.sh: \[lanes\] heavy_lock \(.*\) is inside Cleared state, which nobody must not open/);
});
