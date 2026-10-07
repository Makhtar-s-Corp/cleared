import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../ops/orchestration/lib/conf.mjs';
import { route } from '../ops/orchestration/lib/route.mjs';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../ops/orchestration/lib/ledger.mjs';

const conf = loadConf(join(ORCH_HOME, 'agents.conf'));
const task = (over) => ({ role: 'dev', labels: [], project: null, paths: [], prLines: null, authorModel: null, forced: null, ...over });
const first = (over) => route(conf, task(over)).chain[0].alias;

test('every alias, fallback, role and rule of agents.conf points to a declared model', () => {
  const aliases = Object.keys(conf.models);
  for (const [from, to] of Object.entries(conf.fallbacks)) {
    assert.ok(aliases.includes(from), `fallback of an unknown model: ${from}`);
    assert.ok(aliases.includes(to), `fallback to an unknown model: ${to}`);
  }
  for (const alias of aliases) assert.ok(conf.fallbacks[alias], `${alias} has no declared fallback`);
  for (const alias of Object.values(conf.roles)) assert.ok(aliases.includes(alias));
  for (const rule of conf.rules) assert.ok(aliases.includes(rule.alias), rule.line);
});

test('the role default applies when no override matches', () => {
  assert.equal(first({ role: 'release' }), conf.roles.release);
  assert.equal(first({ role: 'mechanical' }), conf.roles.mechanical);
  assert.notEqual(first({ role: 'mechanical', prLines: 5000 }), conf.roles.mechanical, 'heavy mechanical work has its own model');
  assert.equal(first({ role: 'dev', labels: ['Improvement'], project: 'CI et infra' }), conf.roles.dev);
});

test('overrides by kind of task: engine, screen, and a screen pull request that grew', () => {
  const engine = first({ labels: ['Bug'] });
  const screen = first({ labels: ['Feature'], paths: ['frontend/pages/x.jsx'] });
  assert.notEqual(engine, screen);
  assert.equal(first({ labels: ['Feature'], project: 'Justesse du moteur' }), engine);
  assert.equal(first({ labels: ['Feature'], paths: ['server/finance.mjs'] }), engine);
  assert.equal(first({ labels: ['Feature'], project: 'Refonte des écrans' }), screen);
  assert.equal(first({ labels: ['Feature'], paths: ['frontend/pages/x.jsx'], prLines: 401 }), engine);
  assert.equal(first({ labels: ['Feature'], paths: ['frontend/pages/x.jsx'], prLines: 400 }), screen);
});

test('a condition on something unknown does not match', () => {
  const small = parseConf('[models]\na = x:1\nb = x:2\n[roles]\ndev = a\nrelease = a\n[rules]\ndev pr_lines>10 -> b\ndev path=server/ -> b\n');
  assert.equal(route(small, task({})).chain[0].alias, 'a');
});

test('the reviewer is never the model that wrote the pull request', () => {
  const author = conf.roles.review;
  const routed = route(conf, task({ role: 'review', authorModel: author }));
  assert.ok(routed.chain.length > 0);
  for (const candidate of routed.chain) assert.notEqual(candidate.model, conf.models[author].model);
  assert.equal(routed.notes.length, 1);
  const byId = route(conf, task({ role: 'review', authorModel: conf.models[author].model }));
  assert.deepEqual(byId.chain, routed.chain);
  const other = Object.keys(conf.models).find((alias) => conf.models[alias].model !== conf.models[author].model);
  assert.equal(route(conf, task({ role: 'review', authorModel: other })).chain[0].alias, author);
});

test('a review does not start when nobody knows who wrote the pull request', () => {
  assert.throws(() => route(conf, task({ role: 'review' })), /author of the pull request is unknown/);
});

test('every role with permissions never allows what it denies, nor a network or docker command', () => {
  const sections = Object.keys(conf.sections).filter((name) => name.startsWith('permissions.'));
  assert.ok(sections.includes('permissions.dev') && sections.includes('permissions.review'));
  const list = (text) => (text || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const name of sections) {
    const { mode, allow, deny } = conf.sections[name];
    assert.ok(['read-only', 'accept-edits'].includes(mode), `${name}: mode`);
    assert.ok(conf.roles[name.slice('permissions.'.length)], `${name}: not a role`);
    for (const allowed of list(allow)) {
      for (const denied of list(deny)) assert.ok(!(allowed === denied || allowed.startsWith(`${denied} `)), `${name} allows "${allowed}", which it denies`);
      assert.doesNotMatch(allowed, /^(curl|wget|ssh|scp|nc|docker|gh|npx)\b|^git (push|fetch|pull|clone|remote)\b|^npm (install|ci|i)\b|docker/, `${name} allows "${allowed}"`);
    }
    for (const must of ['curl', 'docker', 'git push']) assert.ok(list(deny).includes(must), `${name} does not deny ${must}`);
  }
});

test('the chain follows the declared fallbacks and stops on a loop', () => {
  const routed = route(conf, task({ role: 'mechanical' }));
  assert.equal(routed.chain[1].alias, conf.fallbacks[conf.roles.mechanical]);
  assert.equal(new Set(routed.chain.map((c) => c.alias)).size, routed.chain.length);
});

test('an unknown model is an error that says what to add, never a silent default', () => {
  assert.throws(() => route(conf, task({ forced: 'not-a-model' })), /unknown model "not-a-model"/);
  const broken = parseConf('[models]\na = x:1\n[roles]\ndev = missing\n');
  assert.throws(() => route(broken, task({})), /unknown model "missing"/);
  assert.throws(() => route(conf, task({ role: 'nobody' })), /no model for the role/);
});

test('the dispatcher scripts name no model and no provider', () => {
  const names = new Set();
  for (const [alias, model] of Object.entries(conf.models)) { names.add(alias); names.add(model.model); names.add(model.adapter); }
  for (const word of ['gpt', 'opus', 'sonnet', 'haiku', 'fable', 'gemini']) names.add(word);
  const files = ['spawn-lane.sh', 'kill-lane.sh', 'lane-run.sh', 'check-cli.sh', 'dashboard.sh', 'lib/common.sh', 'lib/contract.sh', 'lib/route.mjs', 'lib/conf.mjs'];
  for (const file of files) {
    const code = readFileSync(join(ORCH_HOME, file), 'utf8').split('\n').filter((line) => !/^\s*(#|\/\/)/.test(line)).join('\n');
    for (const name of names) {
      assert.ok(!new RegExp(`(^|[^a-z_/.-])${name.replace(/[.]/g, '\\.')}([^a-z_/.-]|$)`, 'i').test(code), `${file} names "${name}"`);
    }
  }
  const adapters = readdirSync(join(ORCH_HOME, 'adapters')).map((f) => f.replace(/\.sh$/, ''));
  for (const model of Object.values(conf.models)) assert.ok(adapters.includes(model.adapter), `no adapter for ${model.adapter}`);
});

test('the ledger records a run, its cost and an event', () => {
  const db = openLedger(':memory:');
  runStart(db, { runId: 'r1', ticket: 'SEE-1', role: 'dev', model: 'm', provider: 'x', lane: 'dev/SEE-1', requestedModel: 'alias' });
  const pricing = parseConf('[currency]\nusd_eur = 0.5\n[prices]\npriced = 1 2 0.5 4 8\n');
  runEnd(db, pricing, { runId: 'r1', outcome: 'done', exitCode: 0, usage: { model: 'actual', tokens_in: 10, tokens_out: 20, tokens_cache: 30, tokens_cache_write: 40, cost_usd: 2 } });
  const row = db.prepare('select * from runs').get();
  assert.equal(row.model, 'actual');
  assert.equal(row.cost_eur, 1);
  assert.equal(row.cost_basis, 'cli');
  assert.equal(row.tokens_total, 100);
  assert.throws(() => runEnd(db, pricing, { runId: 'nope', outcome: 'done' }), /unknown run/);
  assert.throws(() => addEvent(db, { kind: 'made_up' }), /unknown event kind/);
  addEvent(db, { kind: 'lane_limit_reached', ticket: 'SEE-1', value: 3 });
  assert.equal(db.prepare('select count(*) n from events').get().n, 1);
});

test('a cost is computed from the price table only when the CLI gives none, and never guessed', () => {
  const pricing = parseConf('[currency]\nusd_eur = 0.5\n[prices]\npriced = 1 2 0.5 4 8\n');
  const usage = { tokens_in: 1e6, tokens_out: 1e6, tokens_cache: 1e6, tokens_cache_write: 2e6, tokens_cache_write_5m: 1e6 };
  assert.deepEqual(costEur(pricing, { ...usage, model: 'priced' }), { cost: (1 + 2 + 0.5 + 4 + 8) * 0.5, basis: 'prices' });
  assert.deepEqual(costEur(pricing, { ...usage, model: 'unpriced' }), { cost: null, basis: null });
  assert.equal(costEur(pricing, { model: 'unpriced', tokens_total: 1493 }).cost, null);
});

test('the report is written, and the adapter goes on, when the lane changed a few files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-report-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'changed.txt'), 'x');
  writeFileSync(join(dir, 'body.md'), 'Fait : rien.');
  const script = `set -euo pipefail; . "${join(ORCH_HOME, 'lib/contract.sh')}"; model=m; report=report.md; usage=usage.json; contract_started=now;
    contract_usage '{}'; contract_report test 0 body.md; echo after`;
  const run = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /after/);
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.match(report, /^format: lane-report\/1$/m);
  assert.match(report, /## Compte rendu\n\nFait : rien\.\n\n## Fichiers modifiés\n\n- \?\? /);
});

// A throwaway copy of the dispatcher with fake backends: `first` exits with
// FIRST_EXIT, `second` always answers. Nothing leaves the machine.
function sandbox({ policy = 'fallback', maxLanes = 3 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
  const state = join(home, 'state');
  const repo = join(home, 'repo');
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'lane-run.sh'), join(ORCH_HOME, 'spawn-lane.sh'), join(ORCH_HOME, 'kill-lane.sh'), join(ORCH_HOME, 'wake.sh'), join(ORCH_HOME, 'push-lane.sh'), home]);
  execFileSync('mkdir', ['-p', join(home, 'adapters'), join(home, 'prompts'), repo, join(home, 'lanes')]);
  const fake = (name, exit) => writeFileSync(join(home, 'adapters', `${name}.sh`), `#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/../lib/contract.sh"
case "$1" in
  list-models) shift; printf '%s\\n' "$@" ;;
  run) shift; contract_parse_run "$@"; [ -z "\${FIRST_DIES:-}" ] || [ ${name} != first ] || exit 141; body=$(mktemp); echo "answer of ${name}" > "$body"
    contract_usage '{"tokens_total": 10}'; code=${exit}; contract_report ${name} "$code" "$body"; exit "$code" ;;
esac
`, { mode: 0o755 });
  fake('first', '${FIRST_EXIT:-0}');
  fake('second', '0');
  // Linear and GitHub as files the test writes: what they "say now".
  writeFileSync(join(home, 'linear.sh'), `#!/usr/bin/env bash
if [ "$1" = changes ]; then cat "${join(home, 'linear-now.json')}"; exit; fi
if [ "$1" = comment ]; then { echo "$2 from=$4"; cat "$3"; } > "${join(home, 'linear-posted')}"; echo "https://example.test/comment"; exit; fi
echo '{"identifier":"X-1","title":"t","url":"u","project":null,"labels":[]}'
`, { mode: 0o755 });
  writeFileSync(join(home, 'linear-now.json'), '[]');
  writeFileSync(join(home, 'pulls-now.json'), '[]');
  writeFileSync(join(home, 'prompts', 'dev.md'), 'prompt\n');
  writeFileSync(join(home, 'prompts', 'release.md'), 'lead prompt\n');
  writeFileSync(join(home, 'prompts', 'handover.md'), 'handover prompt\n');
  writeFileSync(join(home, 'agents.conf'), `[models]\na = first:m1\nb = second:m2\n[fallbacks]\na = b\nb = a\n[roles]\ndev = a\nrelease = a\n[policy]\nguard_refusal = ${policy}\n[limits]\nmax_lanes = ${maxLanes}\ncounted_roles = dev\n[lanes]\nroot = ${join(home, 'lanes')}\nbase = main\npush_roles = dev\n[linear]\nteam = X\nwriteup_role =\n[lead]\nrole = release\nlive = no\nmax_minutes = 20\nname = chef de projet\nreport_on = X-100\n[currency]\nusd_eur = 1\n`);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  // The guard of the repository, as the scripts read it from the trusted ref.
  const realRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  execFileSync('mkdir', ['-p', join(repo, 'scripts')]);
  for (const file of ['codex-guard.mjs', 'codex-guard-allow.json', 'private-terms.mjs', 'private-terms.json']) execFileSync('cp', [join(realRoot, 'scripts', file), join(repo, 'scripts', file)]);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // No test talks to the real Orca: this one opens a terminal that runs nothing.
  execFileSync('mkdir', ['-p', join(home, 'bin')]);
  writeFileSync(join(home, 'bin', 'gh'), `#!/usr/bin/env bash
if [ "$1 $2" = "pr list" ]; then cat "${join(home, 'pulls-now.json')}"
elif [ "$1 $2" = "pr create" ]; then printf '%s\\n' "$@" > "${join(home, 'pr-create-args')}"; echo "https://example.test/pull/41"
else echo 0; fi
`, { mode: 0o755 });
  // FAKE_ORCA_FAILS: how many times it refuses to open a terminal before it does.
  writeFileSync(join(home, 'bin', 'orca'), `#!/usr/bin/env bash
if [ "$1 $2" = "terminal create" ]; then
  count=$(cat "${join(home, 'orca-calls')}" 2>/dev/null || echo 0); echo $((count + 1)) > "${join(home, 'orca-calls')}"
  [ "$count" -ge "\${FAKE_ORCA_FAILS:-0}" ] || exit 1
  echo '{"handle":"t1"}'
fi
if [ "$1 $2" = "worktree rm" ]; then exit 1; fi
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}`, ORCH_REPO: repo, ORCH_STATE_DIR: state, ORCH_CONF: join(home, 'agents.conf'), ORCH_GUARD_REF: 'main' };
  return { home, state, repo, env, git };
}

function runLane(box, firstExit, extra = {}, cwd = box.repo) {
  const runDir = mkdtempSync(join(tmpdir(), 'orch-run-'));
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }, { alias: 'b', adapter: 'second', model: 'm2' }]));
  writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-test\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n');
  const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd, env: { ...box.env, FIRST_EXIT: String(firstExit), ...extra }, encoding: 'utf8' });
  const db = openLedger(join(box.state, 'ledger.db'));
  const runs = db.prepare('select model, outcome, exit_code from runs order by rowid').all().map((row) => ({ ...row }));
  const events = db.prepare('select kind from events order by rowid').all().map((row) => row.kind);
  db.close();
  return { status: run.status, runs, events, comment: readFileSync(join(runDir, 'comment.md'), 'utf8') };
}

test('a backend that cannot start now hands over to the declared fallback, and says so', () => {
  const lane = runLane(sandbox(), 2);
  assert.equal(lane.status, 0);
  assert.deepEqual(lane.runs, [{ model: 'm1', outcome: 'refused', exit_code: 2 }, { model: 'm2', outcome: 'done', exit_code: 0 }]);
  assert.deepEqual(lane.events, ['model_fallback']);
  assert.match(lane.comment, /Repli : a/);
});

test('a refusal by the safeguard of a backend stops the lane when the policy says stop', () => {
  const lane = runLane(sandbox({ policy: 'stop' }), 3);
  assert.equal(lane.status, 3);
  assert.deepEqual(lane.runs, [{ model: 'm1', outcome: 'refused', exit_code: 3 }]);
  assert.deepEqual(lane.events, ['model_fallback_failed']);
  assert.match(lane.comment, /garde-fou/);
});

test('a refusal by the safeguard of a backend takes the fallback when the policy says fallback', () => {
  const lane = runLane(sandbox({ policy: 'fallback' }), 3);
  assert.equal(lane.status, 0);
  assert.deepEqual(lane.runs.map((run) => run.outcome), ['refused', 'done']);
  assert.deepEqual(lane.events, ['model_fallback']);
});

test('a failure of the model is not a reason to try another one', () => {
  const lane = runLane(sandbox(), 1);
  assert.equal(lane.status, 1);
  assert.deepEqual(lane.runs, [{ model: 'm1', outcome: 'failed', exit_code: 1 }]);
  assert.deepEqual(lane.events, []);
});

test('the lane limit refuses one lane too many and writes it down; an open lane is not opened twice', () => {
  const box = sandbox({ maxLanes: 1 });
  box.git('worktree', 'add', '-q', '-b', 'dev/X-1', join(box.home, 'lanes', 'dev-X-1'), 'main');
  const spawn = (ticket) => spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', ticket, '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  const twice = spawn('X-1');
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /already open/);
  const over = spawn('X-2');
  assert.equal(over.status, 3, over.stderr);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(db.prepare('select kind, ticket, value from events').all().map((row) => ({ ...row })), [{ kind: 'lane_limit_reached', ticket: 'X-2', value: 1 }]);
  db.close();
});

test('no allowed command runs whatever follows it, and none touches git state shared between lanes', () => {
  const list = (text) => (text || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const name of Object.keys(conf.sections).filter((section) => section.startsWith('permissions.'))) {
    for (const allowed of list(conf.sections[name].allow)) {
      assert.notEqual(allowed, 'node scripts/with-test-postgres.mjs', `${name}: this wrapper runs any command given after --`);
      assert.doesNotMatch(allowed, /^git (stash|switch|checkout|rebase|branch|worktree|reset|tag|update-ref)\b/, `${name} allows "${allowed}"`);
    }
  }
  assert.ok(conf.sections['permissions.mechanical'], 'a mechanical task that falls back needs its own permissions');
});

test('the Claude adapter turns the permissions of a role into the allow and deny lists of its CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, 'args')}"\ncat > /dev/null\necho '{"type":"result","is_error":false,"result":"ok","total_cost_usd":0,"modelUsage":{}}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'p');
  const call = (mode) => {
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCH_PERMISSION_MODE: mode, ORCH_ALLOW: 'git status, npm test', ORCH_DENY: 'curl, git push', ADAPTER_DENY_TOOLS: 'WebFetch', ADAPTER_CONNECTORS: 'none' },
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(dir, 'args'), 'utf8').split('\n');
  };
  const edits = call('accept-edits');
  const allowed = edits.slice(edits.indexOf('--allowedTools') + 1, edits.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['Bash(git status)', 'Bash(git status *)', 'Bash(npm test)', 'Bash(npm test *)']);
  assert.equal(edits[edits.indexOf('--permission-mode') + 1], 'acceptEdits');
  for (const denied of ['Bash(curl)', 'Bash(curl *)', 'Bash(git push)', 'Bash(git push *)', 'WebFetch']) assert.ok(edits.includes(denied), denied);
  assert.ok(edits.includes('--strict-mcp-config'));
  const readOnly = call('read-only');
  assert.ok(!readOnly.includes('--permission-mode'));
  for (const denied of ['Edit', 'Write', 'NotebookEdit']) assert.ok(readOnly.includes(denied), denied);
});

test('the Linear text is the write-up when the writing model answers, the raw report when it does not', () => {
  const lane = (writerExit) => {
    const box = sandbox();
    writeFileSync(join(box.home, 'prompts', 'writeup.md'), 'reword\n');
    const runDir = mkdtempSync(join(tmpdir(), 'orch-run-'));
    writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
    writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'b', adapter: 'second', model: 'm2' }]));
    writeFileSync(join(runDir, 'writeup-chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
    writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-test\nORCH_REQUESTED_ALIAS=b\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=writing\n');
    const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env: { ...box.env, FIRST_EXIT: String(writerExit) }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(runDir, 'comment.md'), 'utf8');
  };
  const worded = lane(0);
  assert.match(worded, /Texte mis en forme par m1/);
  assert.match(worded, /answer of first/);
  assert.doesNotMatch(worded, /answer of second/);
  const raw = lane(1);
  assert.match(raw, /La mise en forme a échoué/);
  assert.match(raw, /answer of second/);
  assert.match(raw, /Modèle utilisé : `m2`/);
});

test('the Claude adapter says "cannot start now" when the model produced nothing, and "failed" once it has worked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  writeFileSync(join(dir, 'prompt.md'), 'p');
  const call = (events) => {
    writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\ncat > /dev/null\ncat <<'JSON'\n${events.map((e) => JSON.stringify(e)).join('\n')}\nJSON\nexit 1\n`, { mode: 0o755 });
    return spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    }).status;
  };
  const refused = { type: 'result', is_error: true, api_error_status: 404, result: 'no such model', modelUsage: {} };
  assert.equal(call([{ type: 'assistant', error: 'model_not_found', message: { model: '<synthetic>', content: [{ type: 'text', text: 'no such model' }] } }, refused]), 2);
  assert.equal(call([refused]), 2);
  assert.equal(call([{ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'working' }] } }, { ...refused, api_error_status: 429 }]), 1);
});

test('the Codex adapter tells a guard refusal (3) from a CI run in progress (2), and reads the answer and the tokens', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'prompt.md'), 'p');
  const call = ({ ci = 0, script }) => {
    writeFileSync(join(box.home, 'bin', 'gh'), `#!/usr/bin/env bash\necho ${ci}\n`, { mode: 0o755 });
    writeFileSync(join(box.home, 'task.sh'), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'codex.sh'), ['run', '--model', 'm', '--prompt-file', join(box.home, 'prompt.md'), '--report', join(box.home, 'r.md'), '--usage', join(box.home, 'u.json')], {
      cwd: box.repo, encoding: 'utf8', env: { ...box.env, ADAPTER_TASK_SCRIPT: join(box.home, 'task.sh') },
    });
    return { status: run.status, report: readFileSync(join(box.home, 'r.md'), 'utf8'), usage: JSON.parse(readFileSync(join(box.home, 'u.json'), 'utf8')) };
  };
  const refusal = call({ script: 'echo "/tmp/x/repo/test/a.test.mjs:3: secret littéral" >&2; echo "Refusé : contenu sensible dans ce qui serait envoyé à Codex." >&2; exit 1' });
  assert.equal(refusal.status, 3);
  assert.match(refusal.report, /^outcome: refused$/m);
  assert.match(refusal.report, /- test\/a\.test\.mjs:3: secret littéral/);
  assert.equal(call({ ci: 1, script: 'exit 0' }).status, 2);
  const done = call({ script: 'printf "the answer\\nthe answer"; printf "tokens used\\n1,234\\n" >&2' });
  assert.equal(done.status, 0);
  assert.equal(done.usage.tokens_total, 1234);
  assert.match(done.report, /## Compte rendu\n\nthe answer\n\n## Fichiers modifiés/);
});

test('the spawn lock is released once the lane exists, not held while waiting for it', async () => {
  const box = sandbox();
  const args = (ticket, ...more) => [join(box.home, 'spawn-lane.sh'), ['dev', ticket, '--comment-on', 'none', ...more], { env: { ...box.env, ORCH_WAIT_SECONDS: '20' }, encoding: 'utf8' }];
  // The first lane never finishes (its terminal runs nothing): it waits 20 s.
  const waiting = spawn(...args('X-2', '--wait'));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const before = Date.now();
  const second = spawnSync(...args('X-3'));
  waiting.kill();
  assert.equal(second.status, 0, second.stderr);
  assert.ok(Date.now() - before < 10000, 'the second spawn waited for the first one to stop waiting');
});

test('a comment that the guard refuses never reaches Linear', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ntouch "${join(dir, 'called')}"\necho '{"data":{"issue":{"id":"i"},"commentCreate":{"success":true,"comment":{"id":"c","url":"u"}}}}'\n`, { mode: 0o755 });
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') };
  const post = (text) => {
    writeFileSync(join(dir, 'comment.md'), text);
    return spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-1', join(dir, 'comment.md'), 'test'], { env, encoding: 'utf8' });
  };
  // Built at run time so that this file holds nothing the guard would flag.
  const flagged = `Le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}" est dans le rapport.`;
  const refused = post(flagged);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not sent/);
  assert.throws(() => readFileSync(join(dir, 'called')), 'the network was reached');
  // A ticket goes through the same guard, title and description.
  const open = (title, text) => {
    writeFileSync(join(dir, 'ticket.md'), text);
    return spawnSync(join(ORCH_HOME, 'linear.sh'), ['create', 'Projet', 'Bug', title, join(dir, 'ticket.md')], { env, encoding: 'utf8' });
  };
  assert.notEqual(open('Un titre', flagged).status, 0);
  assert.notEqual(open(flagged, 'Une description.').status, 0);
  assert.throws(() => readFileSync(join(dir, 'called')), 'the network was reached');
  const sent = post('Fait : rien. Reste à faire : rien.');
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.stdout.trim(), 'u');
});

test('the dashboard page is refused to any peer outside the allowed ranges, and only the page is served', async () => {
  const { dashboardServer, allowed, TAILSCALE } = await import('../ops/orchestration/serve/serve-dashboard.mjs');
  for (const peer of ['100.88.1.2', '100.127.255.254', '::ffff:100.64.0.1', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12::9']) assert.ok(allowed(peer, TAILSCALE), peer);
  // A container of a Docker network, the loopback, a public address, the ranges next to Tailscale's, nonsense.
  for (const peer of ['172.18.0.5', '127.0.0.1', '::1', '10.0.1.7', '192.168.1.4', '8.8.8.8', '100.63.255.255', '100.128.0.1', '::ffff:172.18.0.5', 'fd7a:115c:a1e1::1', '', undefined, 'x']) assert.ok(!allowed(peer, TAILSCALE), String(peer));
  const dir = mkdtempSync(join(tmpdir(), 'orch-serve-'));
  writeFileSync(join(dir, 'index.html'), '<p>page</p>');
  writeFileSync(join(dir, 'secret.txt'), 'not served');
  const answer = async (ranges, path = '/') => {
    const server = dashboardServer({ file: join(dir, 'index.html'), ranges });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    const body = await response.text();
    await new Promise((resolve) => server.close(resolve));
    return [response.status, body];
  };
  assert.equal((await answer(TAILSCALE))[0], 403, 'the loopback is not the Tailscale network');
  assert.deepEqual(await answer(['127.0.0.0/8']), [200, '<p>page</p>']);
  assert.equal((await answer(['127.0.0.0/8'], '/secret.txt'))[0], 404);
  assert.equal((await answer(['127.0.0.0/8'], '/../secret.txt'))[0], 404);
});

test('a long session does not make the Claude adapter die before its report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  writeFileSync(join(dir, 'prompt.md'), 'p');
  // Several megabytes of events, as a real session writes.
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\ncat > /dev/null\nline='{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"${'x'.repeat(400)}"}]}}'\nfor i in $(seq 1 12000); do echo "$line"; done\necho '{"type":"result","is_error":false,"result":"the end","total_cost_usd":0,"modelUsage":{}}'\n`, { mode: 0o755 });
  const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64e6, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(run.status, 0, run.stderr.slice(-300));
  assert.match(readFileSync(join(dir, 'r.md'), 'utf8'), /## Compte rendu\n\nthe end\n/);
});

test('a CLI that ends with no result at all is a failure, not a reason to try another model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  writeFileSync(join(dir, 'prompt.md'), 'p');
  writeFileSync(join(dir, 'claude'), '#!/usr/bin/env bash\ncat > /dev/null\nexit 137\n', { mode: 0o755 });
  const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(run.status, 137);
  assert.match(readFileSync(join(dir, 'r.md'), 'utf8'), /^outcome: failed$/m);
});

test('a backend that dies without a report: the lane says so instead of posting an empty text', () => {
  const lane = runLane(sandbox(), 0, { FIRST_DIES: '1' });
  assert.equal(lane.status, 141);
  assert.deepEqual(lane.runs, [{ model: 'm1', outcome: 'failed', exit_code: 141 }]);
  assert.match(lane.comment, /sans compte rendu/);
  assert.match(lane.comment, /Modèle utilisé : `m1`/);
});

test('Linear saying no is an error: nothing is reported as sent or opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  const no = { data: { issue: { id: 'i' }, teams: { nodes: [{ id: 't' }] }, projects: { nodes: [{ id: 'p' }] }, issueLabels: { nodes: [{ id: 'l' }] }, commentCreate: { success: false, comment: null }, issueCreate: { success: false, issue: null } } };
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\necho '${JSON.stringify(no)}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'text.md'), 'Fait : rien.');
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') };
  for (const args of [['comment', 'X-1', join(dir, 'text.md'), 'test'], ['create', 'Projet', 'Bug', 'Un titre', join(dir, 'text.md')]]) {
    const run = spawnSync(join(ORCH_HOME, 'linear.sh'), args, { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0, args[0]);
    assert.equal(run.stdout.trim(), '', args[0]);
  }
  assert.throws(() => readFileSync(join(dir, 'state', 'linear-comments.jsonl')));
  assert.throws(() => readFileSync(join(dir, 'state', 'linear-issues.jsonl')));
});

test('the dashboard server answers 400 to a request it cannot read, and goes on serving', async () => {
  const { dashboardServer } = await import('../ops/orchestration/serve/serve-dashboard.mjs');
  const { connect } = await import('node:net');
  const dir = mkdtempSync(join(tmpdir(), 'orch-serve-'));
  writeFileSync(join(dir, 'index.html'), '<p>page</p>');
  const server = dashboardServer({ file: join(dir, 'index.html'), ranges: ['127.0.0.0/8'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const raw = await new Promise((resolve) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
  });
  try {
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the scripts run as commands from a folder whose name has a space or an accent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch été '));
  execFileSync('cp', ['-r', join(ORCH_HOME, 'serve'), join(ORCH_HOME, 'lib'), dir]);
  const served = spawnSync('node', [join(dir, 'serve', 'serve-dashboard.mjs')], { encoding: 'utf8' });
  assert.equal(served.status, 64, 'run with no argument, it must print its usage, not do nothing');
  const routed = spawnSync('node', [join(dir, 'lib', 'route.mjs')], { encoding: 'utf8', env: { ...process.env, ORCH_CONF: join(ORCH_HOME, 'agents.conf') } });
  assert.equal(routed.status, 1);
  assert.match(routed.stderr, /--role is required/);
  const env = { ...process.env, ORCH_CONF: join(ORCH_HOME, 'agents.conf'), ORCH_STATE_DIR: join(dir, 'state') };
  const ledger = spawnSync('node', [join(dir, 'lib', 'ledger.mjs'), 'init'], { encoding: 'utf8', env });
  assert.equal(ledger.status, 0, ledger.stderr);
  assert.match(ledger.stdout, /ledger\.db/);
  assert.equal(spawnSync('node', [join(dir, 'lib', 'dashboard.mjs')], { encoding: 'utf8', env }).status, 1, 'with no input file it fails, it does not do nothing');
  // Through a symbolic link too.
  execFileSync('ln', ['-s', join(dir, 'lib', 'route.mjs'), join(dir, 'route-link.mjs')]);
  assert.match(spawnSync('node', [join(dir, 'route-link.mjs')], { encoding: 'utf8', env }).stderr, /--role is required/);
});

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

test('a comment on a ticket Linear does not know is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\necho '{"data":{"issue":null}}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'text.md'), 'Fait : rien.');
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-404', join(dir, 'text.md'), 'test'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no such ticket: X-404/);
});

test('a line cut short in the session does not hide that the model worked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  writeFileSync(join(dir, 'prompt.md'), 'p');
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\ncat > /dev/null\necho '{"type":"system","subtype":"ini'\necho '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"working"}]}}'\necho '{"type":"result","is_error":true,"api_error_status":529,"result":"overloaded","modelUsage":{}}'\nexit 1\n`, { mode: 0o755 });
  const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(run.status, 1, 'the model had worked: a failure, not a fallback');
  assert.match(readFileSync(join(dir, 'r.md'), 'utf8'), /overloaded/);
});

test('Orca slow to open the terminal: the spawn waits, goes through, and the incident is in the ledger', () => {
  const box = sandbox();
  const run = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none'], { env: { ...box.env, FAKE_ORCA_FAILS: '3', ORCH_ORCA_WAIT: '4', ORCH_ORCA_STEP: '1', ORCH_ORCA_SLOW: '2' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const db = openLedger(join(box.state, 'ledger.db'));
  const events = db.prepare('select kind, ticket, value from events').all().map((row) => ({ ...row }));
  db.close();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'orca_terminal_delayed');
  assert.equal(events[0].ticket, 'X-2');
  assert.ok(events[0].value >= 2, `waited ${events[0].value} s`);
});

test('Orca never opens the terminal: after the wait and one more try the spawn fails, says how to run by hand, and it is in the ledger', () => {
  const box = sandbox();
  const run = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none'], { env: { ...box.env, FAKE_ORCA_FAILS: '999', ORCH_ORCA_WAIT: '2', ORCH_ORCA_STEP: '1', ORCH_ORCA_SLOW: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /run by hand/);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(db.prepare('select kind, ticket from events').all().map((row) => ({ ...row })), [{ kind: 'orca_terminal_failed', ticket: 'X-2' }]);
  db.close();
  const calls = Number(readFileSync(join(box.home, 'orca-calls'), 'utf8'));
  assert.ok(calls >= 3, `${calls} attempts: the wait, then one more`);
});

test('a lane of a role that is not counted does not take one of the three places', () => {
  const box = sandbox({ maxLanes: 1 });
  box.git('worktree', 'add', '-q', '-b', 'release/X-9', join(box.home, 'lanes', 'release-X-9'), 'main');
  const run = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('the pre-check of the project lead: what the user and the outside world did is an event, what agents wrote is not', async () => {
  const { changes, checksOf } = await import('../ops/orchestration/lib/wake.mjs');
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const comment = (id, body, createdAt = '2026-01-02T10:01:00Z') => ({ id, body, createdAt, url: `u#${id}` });
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: '2026-01-02T10:00:00Z', statusCheckRollup: [], ...over });

  // The very first wake only takes note: nothing that already exists is an event.
  const first = changes(null, [issue({ comments: [comment('c0', 'déjà là')] })], [pull({})], new Set(), '2026-01-02T10:00:00Z');
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.next.pulls, { 7: { state: 'draft', checks: 'none' } });

  const linear = [
    issue({ comments: [
      comment('c0', 'déjà là'),
      comment('c1', 'OK A'),
      comment('c2', '> Écrit par un agent (dev, lane dev/X-1), pas par Makhtar.\n\ntexte'),
      comment('c3', 'un commentaire posté par le script', '2026-01-02T10:02:00Z'),
      comment('c4', 'Chef de projet : pris en charge.'),
    ] }),
    issue({ id: 'i2', identifier: 'X-2', createdAt: '2026-01-02T10:03:00Z', description: 'Un ticket de Makhtar' }),
    issue({ id: 'i3', identifier: 'X-3', createdAt: '2026-01-02T10:03:00Z', description: '> Ticket ouvert par un agent (script), pas par Makhtar.' }),
    issue({ id: 'i4', identifier: 'X-4', createdAt: '2025-12-01T00:00:00Z', description: 'ancien, vu pour la première fois' }),
  ];
  const second = changes(first.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] }), pull({ number: 8, state: 'MERGED' })], new Set(['c3']), '2026-01-02T10:05:00Z');
  assert.deepEqual(second.events.map((event) => [event.kind, event.ticket ?? event.pr]), [['pr_ready', 7], ['comment', 'X-1'], ['ticket_new', 'X-2']]);
  assert.equal(second.events[1].text, 'OK A');

  // Nothing new: nothing. Then the checks turn red: one event, once.
  const pulls = [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })];
  const third = changes(second.next, linear, pulls, new Set(['c3']));
  assert.deepEqual(third.events, []);
  const red = [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] })];
  const fourth = changes(third.next, linear, red, new Set(['c3']));
  assert.deepEqual(fourth.events.map((event) => [event.kind, event.checks]), [['pr_checks', 'failure']]);
  assert.deepEqual(changes(fourth.next, linear, red, new Set(['c3'])).events, []);
  // Merged: said once, then forgotten.
  const merged = changes(fourth.next, linear, [pull({ state: 'MERGED' })], new Set(['c3']));
  assert.deepEqual(merged.events.map((event) => event.kind), ['pr_merged']);
  assert.deepEqual(merged.next.pulls, {});
  assert.equal(checksOf([{ status: 'IN_PROGRESS' }, { conclusion: 'SUCCESS' }]), 'pending');
  assert.equal(checksOf([{ conclusion: 'SKIPPED' }]), 'none');
});

test('the wake of the project lead: nothing moved, nothing starts; a comment of the user starts one session, once', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select kind, ticket from events order by rowid').all().map((row) => ({ ...row })); db.close(); return rows; };
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const old = { id: 'c0', createdAt: '2026-01-01T00:00:00Z', url: 'u#c0', body: 'déjà là' };

  // First wake: it takes note of what exists. Second: nothing moved, and that is written down.
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([old])));
  assert.equal(wake().status, 0);
  assert.deepEqual(events(), []);
  assert.equal(wake().status, 0);
  assert.deepEqual(events(), [{ kind: 'wake_skipped', ticket: null }]);
  assert.equal(calls(), 0, 'no terminal, no model');

  // An agent comments: still nothing. The user comments: one session.
  const agent = { id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: '> Écrit par un agent (dev), pas par Makhtar.\n\nFait.' };
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([old, agent])));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0);
  const user = { id: 'c2', createdAt: new Date().toISOString(), url: 'u#c2', body: 'OK, vas-y.' };
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([old, agent, user])));
  const started = wake();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(calls(), 1);
  const runDir = started.stdout.trim();
  assert.match(readFileSync(join(runDir, 'prompt.md'), 'utf8'), /lead prompt[\s\S]*X-1 \(Titre\) — commentaire de Makhtar[\s\S]*« OK, vas-y\. »/);
  assert.match(readFileSync(join(runDir, 'lane.env'), 'utf8'), /ORCH_LANE=release\/lead[\s\S]*ORCH_COMMENT_ON=none/);
  assert.match(execFileSync('git', ['-C', box.repo, 'worktree', 'list'], { encoding: 'utf8' }), /\[release\/lead\]/);
  assert.deepEqual(events().slice(-1), [{ kind: 'comment_handled', ticket: 'X-1' }]);

  // The session has not finished: the next wake starts nothing and loses nothing.
  const later = { id: 'c3', createdAt: new Date().toISOString(), url: 'u#c3', body: 'Et aussi ceci.' };
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([old, agent, user, later])));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 1);
  // It finishes: the comment made meanwhile is handed to the next session, the first one is not handed again.
  writeFileSync(join(runDir, 'exit-code'), '0');
  const next = wake();
  assert.equal(calls(), 2);
  const prompt = readFileSync(join(next.stdout.trim(), 'prompt.md'), 'utf8');
  assert.match(prompt, /Et aussi ceci/);
  assert.doesNotMatch(prompt, /vas-y/);
});

test('a source that does not answer: the wake reads nothing, moves nothing, and fails', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'linear.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const run = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Linear did not answer/);
  assert.throws(() => readFileSync(join(box.state, 'wake', 'state.json')));
});

// A lane with one commit, in a sandbox whose repository has a remote.
function laneWithRemote(branch, message = 'feat: the work of the lane') {
  const box = sandbox();
  const remote = join(box.home, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', 'origin', 'main');
  const path = join(box.home, 'lanes', branch.replace('/', '-'));
  box.git('worktree', 'add', '-q', '-b', branch, path, 'main');
  if (message) execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', message]);
  const push = (target = path) => spawnSync(join(box.home, 'push-lane.sh'), [target], { env: box.env, encoding: 'utf8' });
  const onRemote = () => execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/heads'], { encoding: 'utf8' }).trim().split('\n');
  const created = () => { try { return readFileSync(join(box.home, 'pr-create-args'), 'utf8').trim().split('\n'); } catch { return null; } };
  return { box, remote, path, push, onRemote, created };
}

test('push-lane: the branch of the lane goes to the branch of the same name, and its draft pull request opens to the base', () => {
  const lane = laneWithRemote('dev/X-5');
  const run = lane.push();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '#41');
  assert.ok(lane.onRemote().some((ref) => ref.startsWith('dev/X-5 ')));
  const args = lane.created();
  assert.ok(args.includes('--draft'));
  assert.equal(args[args.indexOf('--base') + 1], 'main');
  assert.equal(args[args.indexOf('--head') + 1], 'dev/X-5');
  assert.equal(args[args.indexOf('--title') + 1], 'feat: the work of the lane');
});

test('push-lane refuses everything that is not a lane of a pushed role: the base branch, another branch, another role, a lane with nothing', () => {
  const lane = laneWithRemote('dev/X-5');
  const refused = (target, pattern) => { const run = lane.push(target); assert.equal(run.status, 1, pattern); assert.match(run.stderr, pattern); };
  refused(lane.box.repo, /is not the branch of a lane/); // the main checkout, on main
  lane.box.git('worktree', 'add', '-q', '-b', 'feature/free', join(lane.box.home, 'lanes', 'free'), 'main');
  refused(join(lane.box.home, 'lanes', 'free'), /is not the branch of a lane/);
  lane.box.git('worktree', 'add', '-q', '-b', 'release/X-7', join(lane.box.home, 'lanes', 'release-X-7'), 'main');
  refused(join(lane.box.home, 'lanes', 'release-X-7'), /are not pushed/);
  assert.deepEqual(lane.onRemote().map((ref) => ref.split(' ')[0]), ['main'], 'nothing left the machine');
  assert.equal(lane.created(), null);
  const empty = laneWithRemote('dev/X-6', null);
  const nothing = empty.push();
  assert.equal(nothing.status, 0);
  assert.match(nothing.stdout, /nothing to push/);
  assert.deepEqual(empty.onRemote().map((ref) => ref.split(' ')[0]), ['main']);
});

test('push-lane never forces: a remote branch that moved makes it fail, and stays as it was', () => {
  const lane = laneWithRemote('dev/X-5');
  // Someone else pushed another commit to the branch of the lane.
  const other = join(lane.box.home, 'other');
  execFileSync('git', ['clone', '-q', lane.remote, other]);
  execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@localhost', 'commit', '-q', '--allow-empty', '-m', 'someone else']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:refs/heads/dev/X-5']);
  const before = lane.onRemote();
  const run = lane.push();
  assert.notEqual(run.status, 0);
  assert.deepEqual(lane.onRemote(), before);
  assert.equal(lane.created(), null);
  assert.doesNotMatch(readFileSync(join(ORCH_HOME, 'push-lane.sh'), 'utf8').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n'), /--force|-f\b|\+HEAD|\+refs/);
});

test('push-lane sends nothing when a commit message is refused by the guard', () => {
  const flagged = `fix: le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}"`;
  const lane = laneWithRemote('dev/X-5', flagged);
  const run = lane.push();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refused by the guard/);
  assert.deepEqual(lane.onRemote().map((ref) => ref.split(' ')[0]), ['main']);
});

test('a dev lane that finished: its branch is pushed, its pull request is in the ledger and in the Linear text', () => {
  const lane = laneWithRemote('dev/X-1');
  const result = runLane(lane.box, 0, {}, lane.path);
  assert.equal(result.status, 0);
  assert.match(result.comment, /PR ouverte ou mise à jour : #41/);
  const db = openLedger(join(lane.box.state, 'ledger.db'));
  assert.deepEqual({ ...db.prepare('select pr_number, lines_changed from runs').get() }, { pr_number: 41, lines_changed: 0 });
  db.close();
});

test('every unit that runs a script of the dispatcher finds the tools of the user: orca and the CLIs live in his own folder', () => {
  const dir = join(ORCH_HOME, 'serve');
  for (const unit of readdirSync(dir).filter((name) => name.endsWith('.service'))) {
    const text = readFileSync(join(dir, unit), 'utf8');
    assert.match(text, /^Environment=PATH=%h\/\.local\/bin:/m, unit);
  }
  for (const timer of readdirSync(dir).filter((name) => name.endsWith('.timer'))) assert.ok(readdirSync(dir).includes(timer.replace('.timer', '.service')), timer);
});

test('an old ticket touched again does not bring its old comments back as news; one created while the last wake was reading is not lost', async () => {
  const { changes } = await import('../ops/orchestration/lib/wake.mjs');
  const previous = { at: '2026-01-02T10:00:00Z', seen: [], pulls: {} };
  const old = { id: 'i9', identifier: 'X-9', title: 'Vieux', url: 'u', state: 'Done', project: 'P', createdAt: '2025-11-01T00:00:00Z', description: 'd',
    comments: [{ id: 'k1', createdAt: '2025-11-02T00:00:00Z', url: 'u#k1', body: 'un vieux commentaire' }, { id: 'k2', createdAt: '2026-01-02T10:00:30Z', url: 'u#k2', body: 'le nouveau' }] };
  // Created five seconds before the time the last wake noted, but after Linear had answered it.
  const missed = { id: 'i8', identifier: 'X-8', title: 'Créé pendant la lecture', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-02T09:59:55Z', description: 'de Makhtar', comments: [] };
  const { events } = changes(previous, [old, missed], [], new Set(), '2026-01-02T10:01:00Z');
  assert.deepEqual(events.map((event) => [event.kind, event.ticket, event.text]), [['ticket_new', 'X-8', 'de Makhtar'], ['comment', 'X-9', 'le nouveau']]);
});

test('Linear is asked for the newest comments of a ticket (first:, which it serves newest first), never the oldest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issues":{"nodes":[]},"viewer":{"assignedIssues":{"nodes":[]}}}}'\n`, { mode: 0o755 });
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state') };
  for (const args of [['changes', '2026-01-01T00:00:00Z'], ['waiting']]) assert.equal(spawnSync(join(ORCH_HOME, 'linear.sh'), args, { env, encoding: 'utf8' }).status, 0, args[0]);
  const asked = readFileSync(join(dir, 'asked'), 'utf8');
  assert.match(asked, /comments\(first: 20\)/);
  assert.match(asked, /comments\(first: 1\)/);
  assert.doesNotMatch(asked, /comments\(last:/);
});

test('what the push script says is read from its last line, whatever git or gh wrote before; a failed push is said as such', () => {
  const lane = (script) => {
    const box = sandbox();
    writeFileSync(join(box.home, 'push-lane.sh'), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    return runLane(box, 0).comment;
  };
  assert.match(lane('echo "remote: Create a pull request" >&2; echo "warning from gh"; echo "#41"'), /PR ouverte ou mise à jour : #41/);
  assert.match(lane('echo "nothing to push: dev/X-1 has no commit of its own"'), /Rien à pousser/);
  // An answer nobody expected is said as such, not passed off as "nothing to push".
  const odd = lane('echo "something else"');
  assert.match(odd, /Réponse inattendue du script de push : something else/);
  // The reason of a failure is the script's own last word, not a hint of git after it.
  assert.match(lane('echo "push-lane.sh: dev/X-1 not pushed: its changes are refused by the guard" >&2; echo "hint: see the manual" >&2; exit 1'), /n'a pas été poussée : push-lane\.sh: dev\/X-1 not pushed: its changes are refused/);
  const failed = lane('echo "push-lane.sh: dev/X-1 not pushed: a commit message is refused by the guard" >&2; exit 1');
  assert.match(failed, /La branche n'a pas été poussée : push-lane\.sh: dev\/X-1 not pushed/);
  assert.doesNotMatch(failed, /Rien à pousser|PR ouverte/);
});

test('push-lane sends nothing when the changes of the branch hold what the guard refuses', () => {
  const lane = laneWithRemote('dev/X-5', null);
  writeFileSync(join(lane.path, 'notes.md'), `Le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}"\n`);
  execFileSync('git', ['-C', lane.path, 'add', 'notes.md']);
  execFileSync('git', ['-C', lane.path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'docs: notes']);
  const run = lane.push();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refused by the guard/);
  assert.deepEqual(lane.onRemote().map((ref) => ref.split(' ')[0]), ['main']);
});

test('the lane of the project lead is never reset: with work of its own in it, the wake stops and touches nothing', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([])));
  wake();
  const path = join(box.home, 'lanes', 'release-lead');
  box.git('worktree', 'add', '-q', '-b', 'release/lead', path, 'main');
  execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'work left in the lane of the lead']);
  box.git('commit', '-q', '--allow-empty', '-m', 'main moves on');
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([{ id: 'c2', createdAt: new Date().toISOString(), url: 'u#c2', body: 'OK' }])));
  const run = wake();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /left untouched/);
  assert.match(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /work left in the lane of the lead/);
});

test('a run that stops before its end still says it is over', () => {
  const box = sandbox();
  const runDir = mkdtempSync(join(tmpdir(), 'orch-run-'));
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'g', adapter: 'ghost', model: 'm' }]));
  writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-test\nORCH_REQUESTED_ALIAS=g\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n');
  const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.notEqual(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '0');
});

test('the lane of the project lead: a commit of its own stops the wake even when the base did not move, once in the ledger; a stray untracked file does not', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const blocked = () => { const db = openLedger(join(box.state, 'ledger.db')); const n = db.prepare("select count(*) n from events where kind = 'lead_lane_blocked'").get().n; db.close(); return n; };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const comment = (id) => ({ id, createdAt: new Date().toISOString(), url: `u#${id}`, body: `message ${id}` });
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([])));
  wake();
  const path = join(box.home, 'lanes', 'release-lead');
  box.git('worktree', 'add', '-q', '-b', 'release/lead', path, 'main');
  // An untracked file left behind is no reason to stop.
  writeFileSync(join(path, 'left-behind.txt'), 'x');
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([comment('c1')])));
  const fine = wake();
  assert.equal(fine.status, 0, fine.stderr);
  writeFileSync(join(fine.stdout.trim(), 'exit-code'), '0');
  // A commit of its own, the base not having moved: the wake stops, and says so once.
  execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'work left in the lane of the lead']);
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([comment('c1'), comment('c2')])));
  assert.equal(wake().status, 1);
  assert.equal(wake().status, 1);
  assert.equal(blocked(), 1);
  assert.match(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /work left/);
});

test('a state file that cannot be read makes the wake start over as a first one, not fail every minute', async () => {
  const { changes } = await import('../ops/orchestration/lib/wake.mjs');
  for (const broken of [{}, { at: 'not a date', seen: [], pulls: {} }, { seen: ['x'] }]) {
    const { events, next } = changes(broken, [{ id: 'i1', identifier: 'X-1', title: 't', url: 'u', state: 's', project: null, createdAt: new Date().toISOString(), description: 'd', comments: [] }], []);
    assert.deepEqual(events, []);
    assert.ok(!Number.isNaN(Date.parse(next.at)));
  }
});

test('push-lane judges what a branch adds, not what it removes: taking a refused value out of a file does not block the lane', () => {
  const flagged = `Le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}"`;
  const lane = laneWithRemote('dev/X-5', null);
  // The value is already on the base branch; the lane removes it.
  writeFileSync(join(lane.box.repo, 'notes.md'), `${flagged}\nune ligne\n`);
  lane.box.git('add', 'notes.md');
  lane.box.git('commit', '-q', '-m', 'docs: notes');
  lane.box.git('push', '-q', 'origin', 'main');
  execFileSync('git', ['-C', lane.path, 'merge', '-q', '--ff-only', 'main']);
  writeFileSync(join(lane.path, 'notes.md'), 'une ligne\n');
  execFileSync('git', ['-C', lane.path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-am', 'docs: the value goes away']);
  const run = lane.push();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '#41');
});

test('push-lane sends nothing when the changes of the branch cannot be read at all', () => {
  const lane = laneWithRemote('dev/X-5', null);
  // A branch with no history in common with the base: its changes against the base cannot be computed.
  const tree = execFileSync('git', ['-C', lane.box.repo, 'mktree'], { input: '', encoding: 'utf8' }).trim();
  const orphan = execFileSync('git', ['-C', lane.box.repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit-tree', tree, '-m', 'feat: from nowhere'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', lane.path, 'reset', '-q', '--hard', orphan]);
  const run = lane.push();
  assert.notEqual(run.status, 0);
  assert.deepEqual(lane.onRemote().map((ref) => ref.split(' ')[0]), ['main']);
  assert.equal(lane.created(), null);
});

test('push-lane does not refuse a branch for a value that only shows in the context of its changes', () => {
  const flagged = `Le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}"`;
  const lane = laneWithRemote('dev/X-5', null);
  // The value is on the base, on a line git quotes as context in the header of the hunk below it.
  writeFileSync(join(lane.box.repo, 'notes.txt'), `${flagged}\n\n\n\n\n\n\n\n fin\n`);
  lane.box.git('add', 'notes.txt');
  lane.box.git('commit', '-q', '-m', 'docs: notes');
  lane.box.git('push', '-q', 'origin', 'main');
  execFileSync('git', ['-C', lane.path, 'merge', '-q', '--ff-only', 'main']);
  writeFileSync(join(lane.path, 'notes.txt'), `${flagged}\n\n\n\n\n\n\n\n fin\n une ligne de plus\n-- et une qui commence par deux tirets\n`);
  execFileSync('git', ['-C', lane.path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-am', 'docs: one more line']);
  assert.match(execFileSync('git', ['-C', lane.path, 'diff', '--unified=0', 'main...HEAD'], { encoding: 'utf8' }), /^@@ .* @@ Le mot de/m, 'the fixture must put the value in a hunk header');
  const run = lane.push();
  assert.equal(run.status, 0, run.stderr);
});

test('wake.sh itself starts over as a first wake on a state file it cannot read, instead of failing every minute', () => {
  for (const broken of ['{}', '{"at":"not a date","seen":[],"pulls":{}}', 'not json at all']) {
    const box = sandbox();
    execFileSync('mkdir', ['-p', join(box.state, 'wake')]);
    writeFileSync(join(box.state, 'wake', 'state.json'), broken);
    const run = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
    assert.equal(run.status, 0, `${broken}: ${run.stderr}`);
    assert.ok(!Number.isNaN(Date.parse(JSON.parse(readFileSync(join(box.state, 'wake', 'state.json'), 'utf8')).at)), broken);
  }
});

test('a blockage of the lead lane that was cleared is written again if it comes back', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const blocked = () => { const db = openLedger(join(box.state, 'ledger.db')); const n = db.prepare("select count(*) n from events where kind = 'lead_lane_blocked'").get().n; db.close(); return n; };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const comment = (id) => ({ id, createdAt: new Date().toISOString(), url: `u#${id}`, body: `message ${id}` });
  const path = join(box.home, 'lanes', 'release-lead');
  const leave = () => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'left']);
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([])));
  wake();
  box.git('worktree', 'add', '-q', '-b', 'release/lead', path, 'main');
  leave();
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([comment('c1')])));
  assert.equal(wake().status, 1);
  assert.equal(blocked(), 1);
  // Someone cleans the lane; then nothing moves for a while (the comment is taken by a session first).
  execFileSync('git', ['-C', path, 'reset', '-q', '--hard', 'main']);
  const taken = wake();
  assert.equal(taken.status, 0, taken.stderr);
  writeFileSync(join(taken.stdout.trim(), 'exit-code'), '0');
  assert.equal(wake().status, 0);
  // The blockage comes back: it is written again.
  leave();
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([comment('c1'), comment('c2')])));
  assert.equal(wake().status, 1);
  assert.equal(blocked(), 2);
});

test('the handover wake: one session that rereads the handover and says what it understood in the report ticket, whatever moved or not', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'handover.md'), 'Chef de projet : passation. Trois tickets en cours.');
  const run = spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'handover.md')], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const runDir = run.stdout.trim();
  const prompt = readFileSync(join(runDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /^handover prompt/);
  assert.match(prompt, /Chef de projet : passation\. Trois tickets en cours\./);
  assert.doesNotMatch(prompt, /lead prompt/);
  const env = readFileSync(join(runDir, 'lane.env'), 'utf8');
  assert.match(env, /ORCH_COMMENT_ON=X-100/);
  assert.match(env, /ORCH_FROM=chef\\ de\\ projet/);
  // The run itself: its answer is posted in the report ticket, signed as the project lead.
  const lane = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(lane.status, 0, lane.stderr);
  const posted = readFileSync(join(box.home, 'linear-posted'), 'utf8');
  assert.match(posted, /^X-100 from=chef de projet\n/);
  assert.match(posted, /answer of first/);
  // A wake that is not the handover still refuses to act.
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('live = no', 'live = yes'));
  writeFileSync(join(box.home, 'linear-now.json'), '[]');
  spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify([{ id: 'i1', identifier: 'X-1', title: 'T', url: 'u', state: 's', project: null, createdAt: new Date().toISOString(), description: 'de Makhtar', comments: [] }]));
  writeFileSync(join(runDir, 'exit-code'), '0');
  const acting = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(acting.status, 1);
  assert.match(acting.stderr, /not built yet/);
});

test('the handover wake needs a handover to read, and a ticket to answer in', () => {
  const box = sandbox();
  assert.equal(spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'nowhere.md')], { env: box.env, encoding: 'utf8' }).status, 1);
  writeFileSync(join(box.home, 'handover.md'), 'x');
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('report_on = X-100\n', ''));
  const run = spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'handover.md')], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /report_on/);
});

test('Linear is asked for the tickets of one state, to check what a handover says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issues":{"nodes":[{"identifier":"X-1","title":"T","url":"u","updatedAt":"2026-01-01T00:00:00Z","state":{"name":"In Progress"},"project":{"name":"P"},"assignee":null}]}}}'\n`, { mode: 0o755 });
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = spawnSync(join(ORCH_HOME, 'linear.sh'), ['list', 'In Progress'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [{ identifier: 'X-1', title: 'T', url: 'u', updatedAt: '2026-01-01T00:00:00Z', state: 'In Progress', project: 'P', assignee: null }]);
  assert.match(readFileSync(join(dir, 'asked'), 'utf8'), /In Progress/);
});
