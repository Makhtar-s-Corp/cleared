import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
    assert.ok(conf.roles[name.slice('permissions.'.length).replace(/-live$/, '')], `${name}: not a role`);
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
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'lane-run.sh'), join(ORCH_HOME, 'spawn-lane.sh'), join(ORCH_HOME, 'kill-lane.sh'), join(ORCH_HOME, 'wake.sh'), join(ORCH_HOME, 'push-lane.sh'), join(ORCH_HOME, 'tell-lane.sh'), join(ORCH_HOME, 'adopt-lane.sh'), join(ORCH_HOME, 'host-state.sh'), join(ORCH_HOME, 'talk.sh'), join(ORCH_HOME, 'talk-run.sh'), join(ORCH_HOME, 'decide.sh'), join(ORCH_HOME, 'confirm-decision.sh'), join(ORCH_HOME, 'check-lead-model.sh'), home]);
  execFileSync('mkdir', ['-p', join(home, 'adapters'), join(home, 'prompts'), repo, join(home, 'lanes')]);
  const fake = (name, exit) => writeFileSync(join(home, 'adapters', `${name}.sh`), `#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/../lib/contract.sh"
case "$1" in
  list-models) shift; [ ${name} != first ] || [ -z "\${FIRST_GONE:-}" ] || exit 0; printf '%s\\n' "$@" ;;
  talk) shift; [ ${name} != first ] || [ -z "\${FIRST_CANNOT_TALK:-}" ] || exit 2
    printf '%s\\n' "${name}" "$@" "edit=\${ORCH_EDIT_ONLY:-}" "read=\${ORCH_READ_DIRS:-}" "mode=\${ORCH_PERMISSION_MODE:-}" "allow=\${ORCH_ALLOW:-}" "run=\${ORCH_RUN_ID:-}" > "\${ORCH_STATE_DIR}/talked"; exit 0 ;;
  run) shift; contract_parse_run "$@"; printf '%s|%s|%s\\n' "\${ORCH_PERMISSION_MODE:-}" "\${ORCH_ALLOW:-}" "\${ORCH_DENY:-}" > "\${ORCH_STATE_DIR}/allowed-${name}"; echo "\${ORCH_SIGNED:-}" > "\${ORCH_STATE_DIR}/signed-${name}"; [ -z "\${FIRST_DIES:-}" ] || [ ${name} != first ] || exit 141; body=$(mktemp); echo "answer of ${name}" > "$body"
    contract_usage '{"tokens_total": 10}'; code=${exit}; contract_report ${name} "$code" "$body"; exit "$code" ;;
esac
`, { mode: 0o755 });
  fake('first', '${FIRST_EXIT:-0}');
  fake('second', '0');
  // Linear and GitHub as files the test writes: what they "say now".
  writeFileSync(join(home, 'linear.sh'), `#!/usr/bin/env bash
if [ "$1" = changes ]; then cat "${join(home, 'linear-now.json')}"; exit; fi
if [ "$1" = comment ]; then [ -z "\${FAKE_LINEAR_DOWN:-}" ] || exit 1; [ -z "\${FAKE_LINEAR_FULL:-}" ] || exit 4; { echo "$2 from=$4"; cat "$3"; } > "${join(home, 'linear-posted')}"; echo "https://example.test/comment"; exit; fi
if [ "$1" = waiting ]; then echo '[{"identifier":"X-7","title":"Un écran à valider","url":"u","since":"2026-01-02T10:00:00Z"}]'; exit; fi
if [ "$1" = comments ]; then echo '[{"id":"c1","createdAt":"2026-01-02T10:00:00Z","body":"Un commentaire du ticket de suivi."}]'; exit; fi
echo '{"identifier":"X-1","title":"t","url":"u","project":null,"labels":[]}'
`, { mode: 0o755 });
  writeFileSync(join(home, 'linear-now.json'), '[]');
  // What GitHub says of itself: all is well, unless a test writes otherwise. No test asks the real page.
  writeFileSync(join(home, 'github-status.json'), JSON.stringify({ components: ['Git Operations', 'Pull Requests', 'Actions', 'API Requests', 'Webhooks'].map((name) => ({ name, status: 'operational' })) }));
  writeFileSync(join(home, 'pulls-now.json'), '[]');
  writeFileSync(join(home, 'prompts', 'dev.md'), 'prompt\n');
  writeFileSync(join(home, 'prompts', 'release.md'), 'lead prompt\n');
  writeFileSync(join(home, 'prompts', 'handover.md'), 'handover prompt\n');
  writeFileSync(join(home, 'prompts', 'release-live.md'), 'acting lead prompt\n');
  writeFileSync(join(home, 'prompts', 'talk.md'), 'talk prompt, decisions in @DECISIONS@, default ticket @REPORT_ON@\n');
  writeFileSync(join(home, 'agents.conf'), `[models]\na = first:m1\nb = second:m2\n[fallbacks]\na = b\nb = a\n[roles]\ndev = a\nrelease = a\ntalk = a\n[talk]\nrole = talk\n[permissions.talk]\nmode = read-only\nallow = only-for-the-talk\ndeny = never\n[policy]\nguard_refusal = ${policy}\n[limits]\nmax_lanes = ${maxLanes}\ncounted_roles = dev\n[lanes]\nroot = ${join(home, 'lanes')}\nbase = main\npush_roles = dev talk\n[linear]\nteam = X\nwriteup_role =\n[lead]\nrole = release\nlive = no\nmax_minutes = 20\nname = chef de projet\nreport_on = X-100\nreport_hours = 6\nmessages_per_lane_per_hour = 2\n[permissions.release-live]\nmode = read-only\nallow = only-for-the-acting-lead\ndeny = never\n[currency]\nusd_eur = 1\n`);
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
if [ "$1 $2" = "pr list" ]; then [ -z "\${FAKE_GH_LIST_DOWN:-}" ] || exit 1; cat "${join(home, 'pulls-now.json')}"
elif [ "$1 $2" = "pr create" ]; then [ -z "\${FAKE_GH_DOWN:-}" ] || exit 1; printf '%s\\n' "$@" > "${join(home, 'pr-create-args')}"; echo "https://example.test/pull/41"
elif [ "$1 $2" = "run list" ]; then echo '[]'
elif [ "$1" = api ]; then echo 2020-01-01T00:00:00Z
else echo 0; fi
`, { mode: 0o755 });
  writeFileSync(join(home, 'bin', 'docker'), '#!/usr/bin/env bash\n', { mode: 0o755 });
  // FAKE_ORCA_FAILS: how many times it refuses to open a terminal before it does.
  writeFileSync(join(home, 'bin', 'orca'), `#!/usr/bin/env bash
if [ "$1 $2" = "terminal create" ]; then
  count=$(cat "${join(home, 'orca-calls')}" 2>/dev/null || echo 0); echo $((count + 1)) > "${join(home, 'orca-calls')}"
  [ "$count" -ge "\${FAKE_ORCA_FAILS:-0}" ] || exit 1
  echo '{"handle":"t1"}'
fi
if [ "$1 $2" = "worktree rm" ]; then exit 1; fi
if [ "$1 $2" = "terminal list" ]; then [ -z "\${FAKE_ORCA_DOWN:-}" ] || exit 1; cat "${join(home, 'terminals.json')}" 2>/dev/null || echo '{"result":{"terminals":[]}}'; fi
if [ "$1 $2" = "terminal send" ]; then printf '%s\\n' "$@" > "${join(home, 'orca-sent')}"; fi
if [ "$1 $2" = "terminal close" ]; then [ -z "\${FAKE_ORCA_CLOSE_FAILS:-}" ] || exit 1; echo "$4" >> "${join(home, 'orca-closed')}"; fi
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}`, ORCH_REPO: repo, ORCH_STATE_DIR: state, ORCH_CONF: join(home, 'agents.conf'), ORCH_GUARD_REF: 'main', ORCH_GITHUB_STATUS: `file://${join(home, 'github-status.json')}` };
  return { home, state, repo, env, git };
}

function runLane(box, firstExit, extra = {}, cwd = box.repo) {
  const runDir = mkdtempSync(join(tmpdir(), 'orch-run-'));
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }, { alias: 'b', adapter: 'second', model: 'm2' }]));
  writeFileSync(join(runDir, 'lane.env'), `ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-test\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=${extra.ORCH_COMMENT_TEST ?? 'none'}\nORCH_WRITEUP_ROLE=\n`);
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

test('the model a run is filed under is the one that wrote, not a helper it consulted, however much the helper cost; a role can be run without that helper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-advisor-'));
  const said = (model, parent = null) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { model, content: [{ type: 'text', text: 'working' }] } });
  // A sub-agent on another model writes more messages than the session itself: it is not the model of the run.
  const sub = [1, 2, 3, 4].map(() => said('a-sub-agent', 'toolu_1'));
  const result = JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 4, modelUsage: {
    'the-writer': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100, costUSD: 1 },
    'the-helper': { inputTokens: 200, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 3 },
  } });
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, 'args')}"\ncat > /dev/null\ncat <<'JSON'\n${[said('the-writer'), ...sub, said('the-writer'), said('<synthetic>'), result].join('\n')}\nJSON\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'p');
  const call = (extra = {}) => {
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'asked', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extra },
    });
    assert.equal(run.status, 0, run.stderr);
    return { usage: JSON.parse(readFileSync(join(dir, 'u.json'), 'utf8')), args: readFileSync(join(dir, 'args'), 'utf8').split('\n') };
  };
  const plain = call();
  assert.equal(plain.usage.model, 'the-writer');
  assert.deepEqual(plain.usage.helpers, [{ model: 'the-helper', cost_usd: 3 }], 'what the helper cost is in the usage file of the run');
  assert.equal(plain.usage.cost_usd, 4);
  assert.equal(plain.usage.tokens_total, 1340);
  assert.ok(!plain.args.includes('--settings'));
  // Asked without the helper: the CLI is told so by its settings, the one way it listens to (a refused tool does not remove it).
  const without = call({ ORCH_ADVISOR: 'no' });
  assert.equal(without.args[without.args.indexOf('--settings') + 1], '{"advisorModel":""}');
});

test('the project lead runs without the helper model: it coordinates, and the helper cost twice what it did itself', () => {
  for (const role of ['release', 'release-live']) assert.equal(conf.sections[`permissions.${role}`].advisor, 'no', role);
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[permissions.release-live]\nmode = read-only\n', '[permissions.release-live]\nmode = read-only\nadvisor = no\n'));
  const out = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; permissions_env release-live; echo "\${ORCH_ADVISOR:-unset}"; permissions_env talk; echo "\${ORCH_ADVISOR:-unset}"`], { env: box.env, encoding: 'utf8' });
  assert.deepEqual(out.stdout.trim().split('\n'), ['no', 'unset'], 'said for the role that has it, and not carried over to the next');
  // A role with nothing else in its permissions still gets it.
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8')}[permissions.dev]\nadvisor = no\n`);
  assert.equal(spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; permissions_env dev; echo "\${ORCH_ADVISOR:-unset} \${ORCH_PERMISSION_MODE:-none}"`], { env: box.env, encoding: 'utf8' }).stdout.trim(), 'no none');
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

test('the pre-check starts a session only for what is worth one: the rest waits and is handed to the next session, once', async () => {
  const { changes } = await import('../ops/orchestration/lib/wake.mjs');
  const worth = new Set(['comment', 'pr_checks']);
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Backlog', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: '2026-01-02T10:01:00Z', statusCheckRollup: [], ...over });
  const first = changes(null, [issue({})], [], new Set(), '2026-01-02T10:00:00Z', [], worth);
  // A draft opened and a ticket created: nobody has anything to decide yet.
  const linear = [issue({}), issue({ id: 'i2', identifier: 'X-2', createdAt: '2026-01-02T10:02:00Z', description: 'Un ticket de Makhtar' })];
  const quiet = changes(first.next, linear, [pull({})], new Set(), '2026-01-02T10:05:00Z', [], worth);
  assert.deepEqual(quiet.events, []);
  assert.deepEqual(quiet.next.waiting.map((event) => event.kind), ['pr_opened', 'ticket_new']);
  // Nothing new: what waits keeps waiting, once.
  const still = changes(quiet.next, linear, [pull({})], new Set(), '2026-01-02T10:06:00Z', [], worth);
  assert.deepEqual(still.events, []);
  assert.equal(still.next.waiting.length, 2);
  // The checks turn green: one session, which is handed what waited too.
  const green = changes(still.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })], new Set(), '2026-01-02T10:07:00Z', [], worth);
  assert.deepEqual(green.events.map((event) => event.kind), ['pr_opened', 'ticket_new', 'pr_ready']);
  assert.deepEqual(green.next.waiting, [], 'made ready is not worth a session, but it came with green checks');
  const pending = changes(still.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] })], new Set(), '2026-01-02T10:07:00Z', [], worth);
  assert.deepEqual(pending.events, []);
  const done = changes(pending.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })], new Set(), '2026-01-02T10:09:00Z', [], worth);
  assert.deepEqual(done.events.map((event) => event.kind), ['pr_opened', 'ticket_new', 'pr_ready', 'pr_checks']);
  assert.deepEqual(done.next.waiting, []);
  // No list of what is worth a session: everything is, as before.
  assert.deepEqual(changes(first.next, linear, [pull({})], new Set(), '2026-01-02T10:05:00Z').events.map((event) => event.kind), ['pr_opened', 'ticket_new']);
});

test('wake.sh: a draft opened starts nothing and opens no terminal; the next comment of the user starts one session that is told both, and the ledger says why it woke', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('live = no\n', 'live = no\nwake_on = comment, pr_checks\nterminals_kept = 3\n'));
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select kind, detail from events order by rowid').all().map((row) => ({ ...row })); db.close(); return rows; };
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify([{ number: 7, title: 'Un brouillon', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: new Date().toISOString(), statusCheckRollup: [] }]));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0, 'no terminal, no model');
  assert.deepEqual(events().map((event) => event.kind), ['wake_skipped']);
  assert.match(events()[0].detail, /1 waiting/);
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }])));
  const started = wake();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(calls(), 1);
  const runDir = started.stdout.trim();
  assert.match(readFileSync(join(runDir, 'prompt.md'), 'utf8'), /2 événement\(s\)[\s\S]*PR #7 \(Un brouillon[\s\S]*ouverte en brouillon[\s\S]*« OK, vas-y\. »/);
  assert.match(readFileSync(join(runDir, 'lane.env'), 'utf8'), /^ORCH_KEEP_TERMINALS=3$/m);
  const why = events().find((event) => event.kind === 'wake_started');
  assert.equal(why.detail, 'pr_opened #7, comment X-1');
});

test('a lane woken again and again keeps the terminals of its last sessions: the older ones are closed when a session ends, once, and no other lane is touched', () => {
  const box = sandbox();
  const runs = join(box.state, 'runs');
  const past = (name, handle, lane = 'release/lead') => {
    mkdirSync(join(runs, name), { recursive: true });
    writeFileSync(join(runs, name, 'lane.env'), `ORCH_LANE=${lane}\n`);
    writeFileSync(join(runs, name, 'terminal.handle'), `${handle}\n`);
  };
  const session = (name, handle, keep = 'ORCH_KEEP_TERMINALS=3\n', extra = {}) => {
    past(name, handle);
    writeFileSync(join(runs, name, 'prompt.md'), 'prompt\n');
    writeFileSync(join(runs, name, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
    writeFileSync(join(runs, name, 'lane.env'), `ORCH_LANE=release/lead\nORCH_TICKET=\nORCH_ROLE=release\nORCH_RUN_BASE=${name}\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n${keep}`);
    const run = spawnSync(join(box.home, 'lane-run.sh'), [join(runs, name)], { cwd: box.repo, env: { ...box.env, ...extra }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  const closed = () => { try { return readFileSync(join(box.home, 'orca-closed'), 'utf8').trim().split('\n'); } catch { return []; } };
  for (const n of [1, 2, 3, 4]) past(`lead-000${n}`, `t${n}`);
  past('X-9-0001', 'other', 'dev/X-9');
  // A session that was not asked to keep only the last ones closes nothing.
  session('lead-0005', 't5', '');
  assert.deepEqual(closed(), []);
  session('lead-0006', 't6');
  assert.deepEqual(closed(), ['t1', 't2', 't3']);
  assert.ok(readFileSync(join(runs, 'lead-0001', 'terminal.closed'), 'utf8'));
  assert.throws(() => readFileSync(join(runs, 'lead-0004', 'terminal.closed')));
  // The next one closes one more, and does not close again what is closed.
  session('lead-0007', 't7');
  assert.deepEqual(closed(), ['t1', 't2', 't3', 't4']);
  // Orca refuses to close and answers without a list: the terminal is not written down as closed, the next session tries again.
  writeFileSync(join(box.home, 'terminals.json'), JSON.stringify({ ok: false }));
  session('lead-0008', 't8', 'ORCH_KEEP_TERMINALS=3\n', { FAKE_ORCA_CLOSE_FAILS: '1' });
  assert.throws(() => readFileSync(join(runs, 'lead-0005', 'terminal.closed')));
  // It refuses to close a terminal it no longer shows: that one is forgotten.
  writeFileSync(join(box.home, 'terminals.json'), JSON.stringify({ result: { terminals: [{ handle: 't6' }] } }));
  session('lead-0009', 't9', 'ORCH_KEEP_TERMINALS=3\n', { FAKE_ORCA_CLOSE_FAILS: '1' });
  assert.ok(readFileSync(join(runs, 'lead-0005', 'terminal.closed'), 'utf8'));
  assert.throws(() => readFileSync(join(runs, 'lead-0006', 'terminal.closed')));
});

test('while GitHub is down, what its pull requests seem to do is no event and is not forgotten: it is read again once GitHub is back', async () => {
  const { changes } = await import('../ops/orchestration/lib/wake.mjs');
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: false, state: 'OPEN', updatedAt: '2026-01-02T10:01:00Z', statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...over });
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const first = changes(null, issue([]), [pull({})], new Set(), '2026-01-02T10:00:00Z');
  // The outage cancels the checks: nothing is said of it, and the pull request is remembered as it was.
  const cancelled = [pull({ statusCheckRollup: [{ conclusion: 'CANCELLED' }] })];
  const down = changes(first.next, issue([{ id: 'c1', body: 'Et ça ?', createdAt: '2026-01-02T10:03:00Z', url: 'u#c1' }]), cancelled, new Set(), '2026-01-02T10:05:00Z', [], null, { githubDown: true });
  assert.deepEqual(down.events.map((event) => event.kind), ['comment'], 'the user is still heard');
  assert.deepEqual(down.next.pulls, first.next.pulls);
  // Back: what is true now is said, once.
  const back = changes(down.next, issue([]), cancelled, new Set(), '2026-01-02T10:30:00Z');
  assert.deepEqual(back.events.map((event) => [event.kind, event.checks]), [['pr_checks', 'failure']]);
});

test('wake.sh during an outage of GitHub: no session for its events, the outage in the ledger with its start and its end, and the events handed out once it is over', () => {
  const box = sandbox();
  const wake = (extra = {}) => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select kind, at, value, detail from events order by rowid').all().map((row) => ({ ...row })); db.close(); return rows; };
  const status = (actions) => writeFileSync(join(box.home, 'github-status.json'), JSON.stringify({ components: [{ name: 'Git Operations', status: 'operational' }, { name: 'Actions', status: actions }, { name: 'Webhooks', status: 'degraded_performance' }] }));
  const pull = (checks) => [{ number: 7, title: 'Une PR', headRefName: 'b', isDraft: false, state: 'OPEN', updatedAt: new Date().toISOString(), statusCheckRollup: [{ conclusion: checks }] }];
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify(pull('SUCCESS')));
  assert.equal(wake().status, 0);
  // GitHub goes down and cancels the checks; it does not even answer the list of pull requests.
  status('major_outage');
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify(pull('CANCELLED')));
  const during = wake({ FAKE_GH_LIST_DOWN: '1' });
  assert.equal(during.status, 0, during.stderr);
  assert.equal(calls(), 0, 'no session to find out that nothing can be done');
  const started = readFileSync(join(box.state, 'wake', 'github-down'), 'utf8').split('\n')[0];
  assert.match(events().at(-1).detail, /GitHub is down/);
  assert.equal(wake({ FAKE_GH_LIST_DOWN: '1' }).status, 0);
  assert.equal(events().filter((event) => event.kind === 'github_down').length, 0, 'written once, when it ends');
  // Its status page cannot be read for a minute: that is not the end of the outage.
  writeFileSync(join(box.home, 'github-status.json'), 'not json');
  assert.equal(wake({ FAKE_GH_LIST_DOWN: '1' }).status, 0);
  assert.equal(events().filter((event) => event.kind === 'github_down').length, 0);
  assert.equal(readFileSync(join(box.state, 'wake', 'github-down'), 'utf8').split('\n')[0], started);
  // A slowdown is not an outage: it is over. One entry, with its start and its end; the cancelled checks are said now.
  status('operational');
  const after = wake();
  assert.equal(after.status, 0, after.stderr);
  const outage = events().filter((event) => event.kind === 'github_down');
  assert.equal(outage.length, 1);
  assert.equal(outage[0].at, started);
  assert.ok(outage[0].value >= 0);
  assert.match(outage[0].detail, new RegExp(`^from ${started} to \\S+: Actions$`));
  assert.throws(() => readFileSync(join(box.state, 'wake', 'github-down')));
  assert.equal(calls(), 1);
  assert.match(readFileSync(join(after.stdout.trim(), 'prompt.md'), 'utf8'), /PR #7 \(Une PR[\s\S]*vérifications : failure/);
});

test('host-state says the host is free for nothing while GitHub is down, and the dashboard explains the hole', async () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'github-status.json'), JSON.stringify({ components: [{ name: 'Pull Requests', status: 'partial_outage' }, { name: 'Actions', status: 'operational' }] }));
  const run = spawnSync(join(box.home, 'host-state.sh'), [], { env: { ...box.env, FAKE_GH_LIST_DOWN: '1', ORCH_PROC_DIR: join(box.home, 'proc-none') }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(run.stdout);
  assert.equal(state.github_is_down, 'Pull Requests');
  assert.equal(state.free_for_a_ci_run, false);
  assert.equal(state.free_for_a_merge, false);

  const { collect, render } = await import('../ops/orchestration/lib/dashboard.mjs');
  const db = openLedger(join(box.state, 'ledger.db'));
  const now = Date.parse('2026-10-07T16:00:00Z');
  addEvent(db, { kind: 'github_down', at: '2026-10-07T15:06:00Z', value: 26, detail: 'from 2026-10-07T15:06:00Z to 2026-10-07T15:32:00Z: Git Operations, Pull Requests, Actions' });
  const inputs = { lanes: [], worktrees: [], max_lanes: 3, waiting: [], cli: null, load: 1, cores: 4, swap_total_kb: 1, swap_free_kb: 1, mem_available_kb: 1, mem_total_kb: 2, github_down_since: null };
  const data = collect(db, conf, inputs, now);
  assert.deepEqual(data.outages, [{ at: '2026-10-07T15:06:00Z', minutes: 26, detail: 'Git Operations, Pull Requests, Actions' }]);
  assert.match(render(data, conf, now), /GitHub en panne[^<]*<\/span>[\s\S]*?26 min[\s\S]*?Git Operations, Pull Requests, Actions/);
  assert.match(render(collect(db, conf, { ...inputs, github_down_since: '2026-10-07T15:50:00Z' }, now), conf, now), /GitHub est en panne depuis/);
  db.close();
});

test('the lead does not start on a model that was set aside: the table must say the model decided last, and no other model takes its place', () => {
  const box = sandbox();
  const check = (extra = {}) => spawnSync(join(box.home, 'check-lead-model.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const wake = (extra = {}) => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const decide = (detail) => { const db = openLedger(join(box.state, 'ledger.db')); addEvent(db, { kind: 'role_model_changed', detail }); db.close(); };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const comment = (id) => ({ id, createdAt: new Date().toISOString(), url: `u#${id}`, body: 'OK, vas-y.' });
  // No decision written down: the table is the only word.
  assert.equal(check().status, 0);
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  // Decided: b, no longer a. The table still says a (the change is not merged yet): nothing starts, and it says why.
  decide('release: a -> b: too many wrong messages');
  decide('dev: a -> b: another role, which is not the lead');
  const refused = check();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /role release[\s\S]*\ba\b[\s\S]*not the one decided last \(b\)[\s\S]*too many wrong messages/);
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([comment('c1')])));
  const held = wake();
  assert.equal(held.status, 1);
  assert.equal(calls(), 0);
  // The table follows the decision: it starts, with that model and no fallback behind it.
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('release = a\n', 'release = b\n'));
  assert.equal(check().status, 0);
  const started = wake();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(calls(), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(started.stdout.trim(), 'chain.json'), 'utf8')).map((link) => link.alias), ['b']);
});

test('the lead waits rather than run on another model: when its model is not available, no session starts and it is in the ledger', () => {
  const box = sandbox();
  const wake = (extra = {}) => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }])));
  const gone = wake({ FIRST_GONE: '1' });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /no other model takes its place/);
  assert.equal(calls(), 0);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(db.prepare("select kind from events where kind = 'model_fallback_failed'").all().length, 1);
  db.close();
  // Back: the comment was not lost.
  const back = wake();
  assert.equal(back.status, 0, back.stderr);
  assert.match(readFileSync(join(back.stdout.trim(), 'prompt.md'), 'utf8'), /OK, vas-y/);
});

test('starting the timer of the wakes by hand runs the check of the model first: a timer cannot put a model set aside back to work', () => {
  const dir = join(ORCH_HOME, 'serve');
  const timer = readFileSync(join(dir, 'orchestration-wake.timer'), 'utf8');
  assert.match(timer, /^Requires=orchestration-lead-model\.service$/m);
  assert.match(timer, /^After=orchestration-lead-model\.service$/m);
  const service = readFileSync(join(dir, 'orchestration-lead-model.service'), 'utf8');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=@ORCH_HOME@\/check-lead-model\.sh$/m);
  assert.doesNotMatch(service, /RemainAfterExit/, 'checked again at every start');
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
    // One locale the host has, whatever the session that started the units carried.
    assert.match(text, /^Environment=LANG=C\.UTF-8$/m, unit);
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
  assert.match(env, /ORCH_SIGNED=chef\\ de\\ projet/);
  // The run itself: its answer is posted in the report ticket, signed as the project lead.
  const lane = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(lane.status, 0, lane.stderr);
  const posted = readFileSync(join(box.home, 'linear-posted'), 'utf8');
  assert.match(posted, /^X-100 from=chef de projet, modèle a\n/);
  assert.match(posted, /answer of first/);
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

test('the handover wake says so, and fails, when it starts nothing: a session of the lead still running, or another wake at work', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'handover.md'), 'passation');
  const handover = () => spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'handover.md')], { env: box.env, encoding: 'utf8' });
  const first = handover();
  assert.equal(first.status, 0, first.stderr);
  // The session it started has not finished: a second handover starts nothing, and must not look like it did.
  const second = handover();
  assert.equal(second.status, 1);
  assert.match(second.stderr, /still running: nothing started/);
  assert.equal(Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')), 1);
  // An ordinary wake in the same situation stays quiet: it will come back in a minute.
  assert.equal(spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' }).status, 0);
});

test('a listing of tickets that fills the page says it may be cut short', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  const nodes = Array.from({ length: 100 }, (_, i) => ({ identifier: `X-${i}`, title: 'T', url: 'u', updatedAt: '2026-01-01T00:00:00Z', state: { name: 'Done' }, project: null, assignee: null }));
  writeFileSync(join(dir, 'answer.json'), JSON.stringify({ data: { issues: { nodes } } }));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\ncat "${join(dir, 'answer.json')}"\n`, { mode: 0o755 });
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = spawnSync(join(ORCH_HOME, 'linear.sh'), ['list', 'Done'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).length, 100);
  assert.match(run.stderr, /may be cut short/);
});

test('the last message of a lane is a report for the lead only when its turn is over and it speaks to the lead', async () => {
  const { lastReport, laneReports } = await import('../ops/orchestration/lib/lanes.mjs');
  const say = (uuid, text, more = [], at = new Date(Date.now() - 120000).toISOString()) => JSON.stringify({ type: 'assistant', uuid, timestamp: at, message: { content: [{ type: 'text', text }, ...more] } });
  const user = (content) => JSON.stringify({ type: 'user', message: { content } });
  assert.equal(lastReport([say('a', 'Pour le chef de projet : fini.')]).id, 'a');
  // The turn goes on (a tool call), or someone wrote to the lane after: no report.
  assert.equal(lastReport([say('a', 'Je regarde.', [{ type: 'tool_use', name: 'Bash' }])]), null);
  assert.equal(lastReport([say('a', 'Pour le chef de projet : fini.'), user('continue')]), null);
  // A tool result is not someone writing to the lane.
  assert.equal(lastReport([say('a', 'x', [{ type: 'tool_use', name: 'Bash' }]), user([{ type: 'tool_result', content: 'ok' }]), say('b', 'Pour le chef de projet : fini.')]).id, 'b');
  const projects = mkdtempSync(join(tmpdir(), 'orch-projects-'));
  const lane = (name, text) => {
    const path = `/lanes/${name}`;
    const dir = join(projects, path.replace(/[^A-Za-z0-9]/g, '-'));
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 's.jsonl'), `${say(`id-${name}`, text)}\n`);
    return { name, path, branch: `b/${name}` };
  };
  const reports = laneReports([lane('one', 'Pour le chef de projet : prêt.'), lane('two', 'Voilà, Makhtar, c’est fait.'), { name: 'none', path: '/lanes/none', branch: 'b' }], projects);
  assert.deepEqual(reports.map((report) => [report.lane, report.id]), [['one', 'id-one']]);
  // Too fresh (the turn may go on in the next line of the log) or too old (a report of days ago is not a request): neither.
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  const timed = (name, when) => { const l = lane(name, 'x'); writeFileSync(join(projects, l.path.replace(/[^A-Za-z0-9]/g, '-'), 's.jsonl'), `${say(`id-${name}`, 'Pour le chef de projet : prêt.', [], when)}\n`); return l; };
  assert.deepEqual(laneReports([timed('fresh', at(5000)), timed('old', at(7 * 3600e3)), timed('right', at(600e3))], projects, { maxHours: 6 }).map((report) => report.lane), ['right']);
});

test('the lead is not woken by what it wrote itself, nor by a lane it was told to leave alone: only the lanes at work are read', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('live = no\n', 'live = yes\nnot_lanes = old-lead\n'));
  const projects = join(box.home, 'projects');
  const says = (worktree, branch, text) => {
    const path = join(box.home, 'lanes', worktree);
    box.git('worktree', 'add', '-q', '-b', branch, path, 'main');
    const dir = join(projects, path.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: `r-${worktree}`, timestamp: new Date(Date.now() - 120000).toISOString(), message: { content: [{ type: 'text', text }] } })}\n`);
  };
  // The lead's own lane (its report of the last wake), a lane of the dispatcher, the old lead kept open: none is a lane at work.
  says('release-lead', 'release/lead', 'Pour le chef de projet : mon compte rendu du réveil précédent.');
  says('dev-X-9', 'dev/X-9', 'Pour le chef de projet : lane du dispatcher, finie.');
  says('old-lead', 'chore/old-lead', 'Pour le chef de projet : je suis l’ancien.');
  says('a-lane', 'feat/a-lane', 'Pour le chef de projet : j’ai fini, je demande un créneau.');
  mkdirSync(join(box.home, '.claude'), { recursive: true });
  execFileSync('ln', ['-s', projects, join(box.home, '.claude', 'projects')]);
  const seen = spawnSync(join(box.home, 'wake.sh'), ['--dry-run'], { env: { ...box.env, HOME: box.home }, encoding: 'utf8' });
  assert.equal(seen.status, 0, seen.stderr);
  assert.deepEqual(JSON.parse(seen.stdout).filter((event) => event.kind === 'lane_report').map((event) => event.lane), ['a-lane']);
});

test('the acting lead: a report of a lane wakes it, with the prompt and the permissions of the acting lead; while it observes, lanes are not read', () => {
  const box = sandbox();
  const projects = join(box.home, 'projects');
  const lanePath = join(box.home, 'lanes', 'old-lane');
  box.git('worktree', 'add', '-q', '-b', 'feat/old', lanePath, 'main');
  const dir = join(projects, lanePath.replace(/[^A-Za-z0-9]/g, '-'));
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 's.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'r1', timestamp: new Date(Date.now() - 120000).toISOString(), message: { content: [{ type: 'text', text: 'Pour le chef de projet : main est réintégrée, je demande le créneau de CI.' }] } })}\n`);
  const env = { ...box.env, HOME: box.home };
  execFileSync('mkdir', ['-p', join(box.home, '.claude')]);
  execFileSync('ln', ['-s', projects, join(box.home, '.claude', 'projects')]);
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env, encoding: 'utf8' });
  // Observing: the first wake takes note, the second finds nothing: the lane is not read.
  wake();
  const observing = wake();
  assert.equal(observing.stdout.trim(), '');
  // Acting: the report is an event.
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('live = no', 'live = yes'));
  const acting = wake();
  assert.equal(acting.status, 0, acting.stderr);
  const runDir = acting.stdout.trim();
  const prompt = readFileSync(join(runDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /^acting lead prompt/);
  assert.match(prompt, /Lane old-lane \(branche feat\/old\) — son dernier message[\s\S]*je demande le créneau de CI/);
  const laneEnv = readFileSync(join(runDir, 'lane.env'), 'utf8');
  assert.match(laneEnv, /ORCH_PERMISSIONS=release-live/);
  assert.match(laneEnv, /ORCH_COMMENT_ON=none/);
  // The run gets the permissions of the acting lead, not those of the role.
  spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(readFileSync(join(box.state, 'allowed-first'), 'utf8').trim(), 'read-only|only-for-the-acting-lead|never');
  // What it writes to the user says which model wrote it.
  assert.equal(readFileSync(join(box.state, 'signed-first'), 'utf8').trim(), 'chef de projet, modèle a');
  // Said once: the next wake does not hand the same report again.
  writeFileSync(join(runDir, 'exit-code'), '0');
  assert.equal(wake().stdout.trim(), '');
});

test('the acting lead may answer and read, nothing more: its permissions refuse the scripts that open, close, push or create', () => {
  const live = conf.sections['permissions.release-live'];
  const list = (text) => text.split(',').map((item) => item.trim());
  assert.equal(live.mode, 'read-only');
  const scripts = list(live.allow).filter((item) => item.startsWith('ops/'));
  // It answers by two scripts; the rest only reads (what the user wrote in Linear, the state of the host).
  assert.deepEqual(scripts, ['ops/orchestration/linear.sh comment', 'ops/orchestration/linear.sh comments', 'ops/orchestration/linear.sh issue', 'ops/orchestration/linear.sh waiting', 'ops/orchestration/tell-lane.sh', 'ops/orchestration/host-state.sh']);
  for (const refused of ['ops/orchestration/linear.sh create', 'ops/orchestration/spawn-lane.sh', 'ops/orchestration/kill-lane.sh', 'ops/orchestration/push-lane.sh', 'gh', 'orca', 'git push']) assert.ok(list(live.deny).includes(refused), refused);
});

test('tell-lane says it in the terminal written for that lane, and nowhere else', () => {
  const box = sandbox();
  execFileSync('mkdir', ['-p', box.state]);
  const worktree = join(box.home, 'lanes', 'old-lane');
  box.git('worktree', 'add', '-q', '-b', 'old-lane', worktree, 'main');
  writeFileSync(join(box.state, 'lanes.json'), JSON.stringify({ 'old-lane': 'term_1' }));
  const terminals = (list) => writeFileSync(join(box.home, 'terminals.json'), JSON.stringify({ result: { terminals: list } }));
  const tell = (lane, text, extra = {}) => spawnSync(join(box.home, 'tell-lane.sh'), [lane, '-'], { env: { ...box.env, ...extra }, encoding: 'utf8', input: text });
  const sent = () => { try { return readFileSync(join(box.home, 'orca-sent'), 'utf8'); } catch { return null; } };
  // An unknown lane, a terminal that is gone, one that is in another worktree: nothing is sent.
  terminals([{ handle: 'term_1', connected: true, worktreePath: worktree }]);
  assert.equal(tell('another', 'x').status, 1);
  terminals([]);
  assert.match(tell('old-lane', 'x').stderr, /is gone/);
  terminals([{ handle: 'term_1', connected: true, worktreePath: join(box.home, 'lanes', 'somewhere-else') }]);
  assert.match(tell('old-lane', 'x').stderr, /not in its worktree/);
  // A folder of the same name somewhere else is not the worktree of that lane.
  terminals([{ handle: 'term_1', connected: true, worktreePath: '/elsewhere/old-lane' }]);
  assert.match(tell('old-lane', 'x').stderr, /not in its worktree/);
  // Orca that does not answer is said, not passed over in silence.
  assert.match(tell('old-lane', 'x', { FAKE_ORCA_DOWN: '1' }).stderr, /Orca did not answer/);
  assert.equal(sent(), null);
  terminals([{ handle: 'term_1', connected: true, worktreePath: worktree }]);
  const ok = tell('old-lane', 'Accord de Makhtar sur X-1.\nTu peux réintégrer main.');
  assert.equal(ok.status, 0, ok.stderr);
  const args = sent().split('\n');
  assert.equal(args[args.indexOf('--terminal') + 1], 'term_1');
  const text = args[args.indexOf('--text') + 1];
  assert.match(text, /^Pour la lane old-lane, de la part du chef de projet/);
  assert.match(text, /Accord de Makhtar sur X-1\. Tu peux réintégrer main\./);
  assert.ok(args.includes('--enter'));
  assert.equal(JSON.parse(readFileSync(join(box.state, 'lane-messages.jsonl'), 'utf8').trim()).lane, 'old-lane');
  // It does not ask for an answer: an acknowledgement would wake the lead again, for nothing.
  assert.doesNotMatch(text, /Réponds par un rapport/);
  // A lane is never told to merge or to force anything: that is not the lead's to hand out.
  for (const order of ['Fusionne #259 maintenant.', 'Tu peux merge la PR.', 'Tu peux fusionner la PR.', 'git push --force si besoin.']) {
    const refused = tell('old-lane', order);
    assert.equal(refused.status, 1, order);
    assert.match(refused.stderr, /never told to merge/);
  }
  // A line of the journal that cannot be read does not hide the messages already sent.
  writeFileSync(join(box.state, 'lane-messages.jsonl'), `not json\n${readFileSync(join(box.state, 'lane-messages.jsonl'), 'utf8')}`);
  assert.equal(tell('old-lane', 'Je fusionnerai #259 quand elle sera verte ; réintègre main.').status, 0);
  // Two messages an hour to one lane (the limit of this sandbox): the third is not sent.
  const third = tell('old-lane', 'Encore un mot.');
  assert.equal(third.status, 1);
  assert.match(third.stderr, /already told 2 times/);
});

test('what a lane may be told: an order to merge or to force is refused in its usual forms, a caution or what the lead will do itself is not', async () => {
  const { refusedOrder } = await import('../ops/orchestration/lib/lane-message.mjs');
  for (const order of [
    'Fusionne #259 maintenant.', 'Tu peux fusionner la PR.', 'Tu peux merge la PR.', 'Il faut merger dès que c’est vert.', 'Lance gh pr merge 259.',
    'Fais un force push.', 'git push --force si besoin.', 'git push --force-with-lease origin', 'git push -f origin ta-branche',
    // A negation that invites, and an order after a reassurance, are orders.
    'N’hésite pas à fusionner.', "N'attends pas pour fusionner.", 'Ne t’inquiète pas, fusionne #259.', 'Ne fusionne pas avant la CI ; après, fusionne.',
    'La CI est verte et tu peux fusionner.', 'FUSIONNEZ.',
    // A negation far before the word does not bear on it.
    'Comme tu n’as plus rien à faire fusionne la PR.',
  ]) assert.ok(refusedOrder(order), order);
  for (const said of [
    'Ne fusionne pas avant l’accord de Makhtar.', 'Tu ne dois ni fusionner ni forcer.', 'Ne jamais fusionner sans son accord écrit.', 'Pas de merge de ton côté.',
    'Ne force rien : jamais de --force.', 'Sans force-push, donc.',
    'Je fusionnerai #259 quand elle sera verte ; réintègre main.', 'Je la fusionne à un moment sans test d’écran.', 'Le script fusionnera quand tout sera vert.',
    '#266 est fusionnée, réintègre main.', 'Une fois #259 fusionnée, c’est ton tour.', 'Après la fusion de #266, réintègre main.',
    'Réintègre main et pousse une seule fois.', 'Le conflit émerge dans server/core.mjs.',
  ]) assert.equal(refusedOrder(said), null, said);
});

test('adopt-lane writes down the terminal of a lane only when Orca shows it in that worktree', () => {
  const box = sandbox();
  const worktree = join(box.home, 'lanes', 'old-lane');
  box.git('worktree', 'add', '-q', '-b', 'old-lane', worktree, 'main');
  const terminals = (answer) => writeFileSync(join(box.home, 'terminals.json'), JSON.stringify(answer));
  terminals({ result: { terminals: [{ handle: 'term_9', connected: true, worktreePath: worktree }, { handle: 'term_7', connected: true, worktreePath: '/elsewhere/old-lane' }] } });
  const adopt = (lane, handle, extra = {}) => spawnSync(join(box.home, 'adopt-lane.sh'), [lane, handle], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  assert.equal(adopt('old-lane', 'term_8').status, 1);
  assert.equal(adopt('another', 'term_9').status, 1);
  // A folder of the same name somewhere else is not the worktree of that lane.
  assert.match(adopt('old-lane', 'term_7').stderr, /not in the worktree/);
  // Orca that does not answer, or answers without a list, is said: no silent stop.
  const down = adopt('old-lane', 'term_9', { FAKE_ORCA_DOWN: '1' });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /Orca did not answer/);
  terminals({ ok: false });
  const noList = adopt('old-lane', 'term_9');
  assert.equal(noList.status, 1);
  assert.match(noList.stderr, /no list of terminals/);
  assert.throws(() => readFileSync(join(box.state, 'lanes.json')));
  terminals({ result: { terminals: [{ handle: 'term_9', connected: true, worktreePath: worktree }] } });
  assert.equal(adopt('old-lane', 'term_9').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(box.state, 'lanes.json'), 'utf8')), { 'old-lane': 'term_9' });
});

test('host-state sees a screen test from the command that runs it, before any browser, and not from whoever only names one', async () => {
  const { screenProcesses } = await import('../ops/orchestration/lib/screens.mjs');
  const named = [
    ['claude', 'Lance npm run test:ui puis playwright, et lis scripts/run-ui-tests.mjs'],
    ['bash', '-c', 'pgrep -f "playwright|test:ui|capture-all|run-ui-tests"'],
    ['node', 'scripts/with-test-postgres.mjs', '--', 'node', '--test', 'test/orchestration.test.mjs'],
    ['vim', 'scripts/run-ui-tests.mjs'],
    // Installing the browsers is not a screen test.
    ['npx', 'playwright', 'install', 'chromium'],
  ];
  const running = [
    ['npm run test:ui'],
    ['node', 'scripts/with-test-postgres.mjs', '--', 'npm', 'run', 'test:ui:run'],
    ['node', '/somewhere/budgeting/scripts/run-ui-tests.mjs'],
    ['node', 'scripts/capture-all.mjs'],
    ['node', 'scripts/ui-shots.mjs', 'http://127.0.0.1:4173'],
    ['node', '/somewhere/node_modules/.bin/playwright', 'test'],
    ['npx', 'playwright', 'test', '--project=chromium'],
    ['/home/someone/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', '--headless'],
    ['/opt/old/headless_shell', '--no-sandbox'],
  ];
  assert.equal(screenProcesses(named).length, 0);
  for (const argv of running) assert.equal(screenProcesses([argv]).length, 1, argv.join(' '));

  // The script itself, on a process table written by the test.
  const box = sandbox();
  const proc = join(box.home, 'proc');
  const process_ = (pid, argv) => { mkdirSync(join(proc, String(pid)), { recursive: true }); writeFileSync(join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`); };
  mkdirSync(join(proc, 'self'), { recursive: true });
  named.forEach((argv, index) => process_(100 + index, argv));
  const state = () => {
    const run = spawnSync(join(box.home, 'host-state.sh'), [], { env: { ...box.env, ORCH_PROC_DIR: proc }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const quiet = state();
  assert.equal(quiet.screen_tests_or_captures_running, 0);
  assert.equal(quiet.free_for_a_merge, true);
  // npm names its own process in one piece: no browser yet, and the host is already not free for a merge.
  writeFileSync(join(proc, '200'), ''); // a file that is not a process is passed over
  mkdirSync(join(proc, '201'));
  writeFileSync(join(proc, '201', 'cmdline'), 'npm run test:ui\0\0\0');
  const busy = state();
  assert.equal(busy.screen_tests_or_captures_running, 1);
  assert.equal(busy.free_for_a_merge, false);
});

test('the acting lead cannot write down a terminal itself, and a comment made of blanks is not posted', () => {
  const deny = conf.sections['permissions.release-live'].deny.split(',').map((item) => item.trim());
  assert.ok(deny.includes('ops/orchestration/adopt-lane.sh'));
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ntouch "${join(dir, 'called')}"\necho '{}'\n`, { mode: 0o755 });
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: '  \n \n', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 1);
  assert.throws(() => readFileSync(join(dir, 'called')));
});

test('a comment read on stdin is posted, signed by the one who runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issue":{"id":"i"},"commentCreate":{"success":true,"comment":{"id":"c","url":"u"}}}}'\n`, { mode: 0o755 });
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Une question pour toi.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_SIGNED: 'chef de projet' } });
  assert.equal(run.status, 0, run.stderr);
  const asked = readFileSync(join(dir, 'asked'), 'utf8');
  assert.match(asked, /Écrit par un agent \(chef de projet\), pas par Makhtar/);
  assert.match(asked, /Une question pour toi\./);
  assert.equal(spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: '', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } }).status, 1);
});

test('the user is not written more than a few times an hour by all the agents together: beyond, the comment is refused and is to be grouped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-linear-'));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issue":{"id":"i"},"commentCreate":{"success":true,"comment":{"id":"c","url":"u"}}}}'\n`, { mode: 0o755 });
  const repoRoot = execFileSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const limit = Number(conf.sections.linear.comments_per_hour);
  assert.equal(limit, 6);
  const post = (from) => spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Un mot.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_SIGNED: from } });
  const entry = (minutesAgo, from) => JSON.stringify({ id: `c${minutesAgo}`, ticket: 'X-2', from, at: new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d+Z$/, 'Z') });
  mkdirSync(join(dir, 'state'));
  // Five in the last hour, by several agents, and older ones that no longer count: one more goes.
  writeFileSync(join(dir, 'state', 'linear-comments.jsonl'), `${[entry(200, 'a'), entry(61, 'a'), entry(50, 'chef de projet'), entry(40, 'a'), entry(30, 'review'), entry(20, 'chef de projet'), entry(10, 'a')].join('\n')}\nnot json\n`);
  assert.equal(post('chef de projet').status, 0);
  // That made six: the next one is refused, whoever writes it, and nothing is sent.
  const asked = readFileSync(join(dir, 'asked'), 'utf8');
  const refused = post('another agent');
  assert.match(refused.stderr, /already written 6 times in the last hour[\s\S]*[Gg]roup/);
  assert.equal(readFileSync(join(dir, 'asked'), 'utf8'), asked);
  assert.equal(refused.status, 4, 'told apart from a failure: the caller keeps the text for a grouped comment');
  // The limit holds without its setting (a typing mistake must not switch the rule of the user off).
  const noKey = join(dir, 'agents.conf');
  writeFileSync(noKey, readFileSync(join(ORCH_HOME, 'agents.conf'), 'utf8').replace(/^comments_per_hour = .*$/m, 'coments_per_hour = 6'));
  assert.equal(spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Un mot.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_CONF: noKey } }).status, 4);
  // Nor without a number in it.
  const notANumber = join(dir, 'agents-six.conf');
  writeFileSync(notANumber, readFileSync(join(ORCH_HOME, 'agents.conf'), 'utf8').replace(/^comments_per_hour = .*$/m, 'comments_per_hour = six'));
  assert.equal(spawnSync(join(ORCH_HOME, 'linear.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Un mot.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_CONF: notANumber } }).status, 4);
  // What the user confirms himself is his own word, not one more message of an agent: it is never held back.
  const pending = join(dir, 'state', 'decisions', 'pending', 'd1');
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, 'text.md'), 'Ma décision.\n');
  writeFileSync(join(pending, 'decision.json'), JSON.stringify({ ticket: 'X-1', adr: false, run: '', at: '2026-01-02T10:00:00Z' }));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') };
  const own = spawnSync(join(ORCH_HOME, 'confirm-decision.sh'), [], { encoding: 'utf8', env });
  assert.equal(own.status, 0, own.stderr);
  assert.match(readFileSync(join(dir, 'asked'), 'utf8'), /Ma décision\./);
  // Only that script: a command that merely names it, or another script of that name, is an agent like the others.
  const before = readFileSync(join(dir, 'asked'), 'utf8');
  const impostor = join(dir, 'confirm-decision.sh');
  writeFileSync(impostor, `#!/usr/bin/env bash\n"${join(ORCH_HOME, 'linear.sh')}" comment X-1 - "an agent" <<< "Un mot de plus."\n`, { mode: 0o755 });
  assert.equal(spawnSync(impostor, [], { encoding: 'utf8', env }).status, 4);
  assert.equal(spawnSync('bash', ['-c', `"${join(ORCH_HOME, 'linear.sh')}" comment X-1 - "an agent" <<< "Je cite ${join(ORCH_HOME, 'confirm-decision.sh')}."`], { encoding: 'utf8', env }).status, 4);
  assert.equal(readFileSync(join(dir, 'asked'), 'utf8'), before);
});

test('the report of a lane that the hourly limit holds back is kept, and leaves later in one grouped comment', () => {
  const box = sandbox();
  const lane = runLane(box, 0, { FAKE_LINEAR_FULL: '1', ORCH_COMMENT_TEST: 'X-1' });
  assert.equal(lane.status, 0);
  const outbox = readdirSync(join(box.state, 'linear-outbox'));
  assert.equal(outbox.length, 1);
  assert.match(outbox[0], /^X-1--/);
  // A second one waits too; the next wake that may write groups them in one comment on the ticket of the reports.
  writeFileSync(join(box.state, 'linear-outbox', 'X-2--other.md'), 'Compte rendu de X-2.\n');
  writeFileSync(join(box.state, 'linear-outbox', 'notes.txt'), 'not a report\n');
  const flush = (extra = {}) => spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; flush_outbox`], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  // A wake killed while it was sending left some aside: they are taken back, not forgotten.
  mkdirSync(join(box.state, 'linear-outbox', 'sending.killed'));
  writeFileSync(join(box.state, 'linear-outbox', 'sending.killed', 'X-3--left.md'), 'Compte rendu de X-3.\n');
  assert.equal(flush({ FAKE_LINEAR_FULL: '1' }).status, 0);
  execFileSync('mv', [join(box.state, 'linear-outbox', 'X-3--left.md'), join(box.home, 'taken-back.md')]);
  assert.deepEqual(readdirSync(join(box.state, 'linear-outbox')).sort(), [outbox[0], 'X-2--other.md', 'notes.txt'].sort(), 'still held: nothing is lost');
  assert.equal(flush().status, 0);
  const posted = readFileSync(join(box.home, 'linear-posted'), 'utf8');
  assert.match(posted, /^X-100 from=/);
  assert.match(posted, /2 comptes rendus groupés[\s\S]*### X-1[\s\S]*answer of first[\s\S]*### X-2[\s\S]*Compte rendu de X-2\./);
  assert.deepEqual(readdirSync(join(box.state, 'linear-outbox')), ['notes.txt'], 'only what was sent is removed');
});

test('the discussion has no right to act: its permissions name what it may read and the one script it proposes with, and refuse the rest', () => {
  const talk = conf.sections['permissions.talk'];
  const list = (text) => text.split(',').map((item) => item.trim());
  assert.equal(conf.sections.talk.role, 'talk');
  assert.ok(conf.models[conf.roles.talk], 'the model of the discussion comes from the table');
  assert.equal(talk.mode, 'read-only');
  assert.deepEqual(list(talk.allow), [
    'ops/orchestration/decide.sh', 'ops/orchestration/linear.sh issue', 'ops/orchestration/linear.sh comments', 'ops/orchestration/linear.sh list',
    'ops/orchestration/linear.sh waiting', 'ops/orchestration/host-state.sh', 'ops/orchestration/tell-lane.sh --list',
    'git status', 'git log', 'git show', 'git ls-files',
  ]);
  for (const refused of ['ops/orchestration/confirm-decision.sh', 'ops/orchestration/linear.sh comment', 'ops/orchestration/linear.sh create', 'ops/orchestration/spawn-lane.sh', 'ops/orchestration/kill-lane.sh', 'ops/orchestration/push-lane.sh', 'ops/orchestration/adopt-lane.sh', 'gh', 'orca', 'git push', 'git commit']) assert.ok(list(talk.deny).includes(refused), refused);
  assert.ok(conf.sections.lanes.push_roles.split(/\s+/).includes('talk'), 'the file of the decisions leaves by the narrow push script');
  // Confirming a decision is the user's: no role may run it, whatever else it may do.
  for (const [name, section] of Object.entries(conf.sections).filter(([key]) => key.startsWith('permissions.'))) {
    assert.ok(list(section.deny).includes('ops/orchestration/confirm-decision.sh'), name);
    assert.ok(!list(section.allow ?? '').some((item) => item.includes('confirm-decision')), name);
  }
  // A read command of git must not become a way to write a file, or to read one outside the repository.
  for (const role of ['talk', 'release-live', 'review']) {
    for (const option of ['*--output*', '*--no-index*']) assert.ok(list(conf.sections[`permissions.${role}`].deny).includes(option), `${role} ${option}`);
  }
});

test('the Claude adapter holds a conversation where nothing is asked for: reading stays in the folders it is given, one file may be edited, the rest is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-talk-'));
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, 'args')}"\necho "key=\${ANTHROPIC_API_KEY:-none}" > "${join(dir, 'env')}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'the briefing');
  const call = (extra) => {
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['talk', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--session-id', 's-1'], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'not-for-a-subscription', ORCH_PERMISSION_MODE: 'read-only', ORCH_ALLOW: 'ops/orchestration/decide.sh, git log', ORCH_DENY: '*--output*, gh, git push', ADAPTER_CONNECTORS: 'none', ...extra },
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(dir, 'args'), 'utf8').trim().split('\n');
  };
  const args = call({ ORCH_EDIT_ONLY: '/somewhere/talk-X-100/docs/decisions.md', ORCH_READ_DIRS: '/somewhere/release-lead:/somewhere/talk-X-100' });
  assert.ok(!args.includes('-p'), 'a conversation, not a run without a screen');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['Read(//somewhere/release-lead/**)', 'Read(//somewhere/talk-X-100/**)', 'Bash(ops/orchestration/decide.sh)', 'Bash(ops/orchestration/decide.sh *)', 'Bash(git log)', 'Bash(git log *)', 'Edit(//somewhere/talk-X-100/docs/decisions.md)']);
  // The search tools read anywhere once allowed: they are not offered. Files of secrets are refused wherever they are.
  for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(!allowed.includes(tool), tool);
  for (const denied of ['Write', 'NotebookEdit', 'Read(//**/.env*)', 'Bash(*--output*)', 'Bash(gh)', 'Bash(git push *)']) assert.ok(args.includes(denied), denied);
  assert.equal(args[args.indexOf('--add-dir') + 1], '/somewhere/talk-X-100');
  assert.equal(args[args.indexOf('--session-id') + 1], 's-1');
  assert.equal(args.at(-1), 'the briefing');
  assert.equal(readFileSync(join(dir, 'env'), 'utf8').trim(), 'key=none', 'the conversation is on the subscription, never on an API key');
  // No file named: no edit at all; no folder named: the current one.
  const none = call({});
  assert.ok(none.slice(none.indexOf('--disallowedTools')).includes('Edit'));
  assert.ok(!none.some((arg) => arg.startsWith('Edit(')));
  assert.ok(none.includes(`Read(/${dir}/**)`));
  // The other backend has no conversation to offer: the next model of the chain takes it.
  assert.equal(spawnSync(join(ORCH_HOME, 'adapters', 'codex.sh'), ['talk', '--model', 'm', '--prompt-file', join(dir, 'prompt.md')], { encoding: 'utf8' }).status, 2);
});

test('talk.sh opens one conversation in the lane of the lead, briefed by scripts; talk-run.sh holds it with the permissions of the discussion and writes it to the ledger as a discussion', () => {
  const box = sandbox();
  const brief = spawnSync(join(box.home, 'talk.sh'), ['--dry-run'], { env: box.env, encoding: 'utf8' });
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /talk prompt, decisions in .*\/lanes\/talk-X-100\/docs\/decisions\.md, default ticket X-100/);
  assert.match(brief.stdout, /X-7 \(Un écran à valider\)/);
  assert.match(brief.stdout, /Un commentaire du ticket de suivi\./);
  assert.throws(() => readFileSync(join(box.home, 'orca-calls')), 'a dry run opens nothing');

  const opened = spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')), 1);
  const runDir = opened.stdout.trim().split('\n').at(-1);
  const worktrees = execFileSync('git', ['-C', box.repo, 'worktree', 'list'], { encoding: 'utf8' });
  assert.match(worktrees, /\[release\/lead\]/);
  assert.match(worktrees, /\[talk\/X-100\]/);
  // A wake of the lead that ends does not close the terminal of a conversation: it is not one of its sessions.
  assert.throws(() => readFileSync(join(runDir, 'lane.env')));

  // The conversation itself (the terminal of the test runs nothing: it is run here).
  const lead = join(box.home, 'lanes', 'release-lead');
  const held = spawnSync(join(box.home, 'talk-run.sh'), [runDir], { cwd: lead, env: { ...box.env, FIRST_CANNOT_TALK: '1', ORCH_TTY: '/dev/null' }, encoding: 'utf8' });
  assert.equal(held.status, 0, held.stderr);
  const said = readFileSync(join(box.state, 'talked'), 'utf8').trim().split('\n');
  assert.equal(said[0], 'second', 'a backend that cannot talk hands over to the next of the chain');
  const decisions = join(box.home, 'lanes', 'talk-X-100');
  assert.ok(said.includes(`edit=${join(decisions, 'docs', 'decisions.md')}`));
  assert.ok(said.includes(`read=${lead}:${decisions}`));
  assert.ok(said.includes('mode=read-only') && said.includes('allow=only-for-the-talk'));
  // The session has no log here: its tokens are unknown in the ledger, not zero.
  assert.match(held.stdout, /tokens restent inconnus/);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual({ ...db.prepare("select role, lane, source, model, outcome, tokens_total from runs where outcome = 'done'").get() }, { role: 'talk', lane: 'release/lead', source: 'discussion', model: 'm2', outcome: 'done', tokens_total: null });
  assert.deepEqual(db.prepare('select model, outcome from runs order by rowid').all().map((r) => ({ ...r })), [{ model: 'm1', outcome: 'refused' }, { model: 'm2', outcome: 'done' }]);
  db.close();
  // The conversation is over: its mark is gone.
  assert.throws(() => readFileSync(join(box.state, 'wake', 'talk')));
});

test('never two agents in the lane of the lead: an open discussion holds its short sessions back without losing what moves, and no discussion opens while one is at work', (t) => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  // A discussion is open: the mark holds the process of a conversation that lives.
  const conversation = spawn('bash', ['-c', 'exec -a talk-run.sh sleep 60'], { stdio: 'ignore' });
  t.after(() => conversation.kill());
  writeFileSync(join(box.state, 'wake', 'talk'), `${conversation.pid}\n`);
  writeFileSync(join(box.home, 'linear-now.json'), JSON.stringify(issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }])));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0, 'no session while the user talks with the lead');
  assert.match(spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8' }).stderr, /already open/);
  // So does a discussion that is being opened, for the time a terminal takes to open, and no longer.
  writeFileSync(join(box.state, 'wake', 'talk'), `opening ${Math.floor(Date.now() / 1000)}\n`);
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0);
  // The mark of a conversation that died without saying so holds nothing back, even when its number now belongs to
  // another process (this one).
  writeFileSync(join(box.state, 'wake', 'talk'), `${process.pid}\n`);
  assert.equal(spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; talk_open`], { env: box.env }).status, 1);
  // Nor does an opening that never became a conversation; what moved meanwhile is handed out.
  writeFileSync(join(box.state, 'wake', 'talk'), `opening ${Math.floor(Date.now() / 1000) - 600}\n`);
  const started = wake();
  assert.equal(calls(), 1);
  assert.match(readFileSync(join(started.stdout.trim(), 'prompt.md'), 'utf8'), /OK, vas-y/);
  // That session is at work: no discussion opens in its folder.
  const refused = spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /short session of the project lead is at work/);
  assert.equal(calls(), 1);
});

test('a decision is proposed by the discussion and leaves only when the user confirms it: Linear, the ledger with the source discussion, and docs/decisions.md by a draft pull request', () => {
  const lane = laneWithRemote('talk/X-100', null);
  const { box } = lane;
  const env = { ...box.env, ORCH_RUN_ID: 'talk-1-talk-a1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' };
  const decide = (args, input) => spawnSync(join(box.home, 'decide.sh'), args, { env, encoding: 'utf8', input });
  const confirm = (args = [], extra = {}) => spawnSync(join(box.home, 'confirm-decision.sh'), args, { env: { ...env, ...extra }, encoding: 'utf8' });
  const decisions = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select kind, source, ticket, run_id, detail from events where kind = 'decision'").all().map((row) => ({ ...row })); db.close(); return rows; };
  const posted = () => { try { return readFileSync(join(box.home, 'linear-posted'), 'utf8'); } catch { return null; } };
  const waiting = () => { try { return readdirSync(join(box.state, 'decisions', 'pending')); } catch { return []; } };

  // Refusals: no ticket, nothing to say, a file instead of what the session was told (a file could be anything on the disk).
  assert.equal(decide(['not-a-ticket', '-'], 'x').status, 1);
  assert.equal(decide(['X-5', '-'], ' \n').status, 1);
  assert.match(decide(['X-5', join(box.home, 'agents.conf')], '').stderr, /never a file/);
  assert.deepEqual(waiting(), []);

  // Proposed: kept, and nothing has left.
  const proposed = decide(['X-5', '-'], 'On garde le bouton\nsous la liste.');
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.match(proposed.stdout, /rien n'est encore parti[\s\S]*! ops\/orchestration\/confirm-decision\.sh/);
  assert.equal(waiting().length, 1);
  assert.equal(posted(), null);
  assert.deepEqual(decisions(), []);
  // Linear does not answer: the decision still waits, and a second try takes it.
  assert.match(confirm([], { FAKE_LINEAR_DOWN: '1' }).stderr, /still waits/);
  assert.deepEqual(decisions(), []);
  const done = confirm();
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Transcrite : https:\/\/example\.test\/comment/);
  assert.match(posted(), /^X-5 from=chef de projet, en discussion\n\*\*Décision de Makhtar, transcrite pendant une discussion avec le chef de projet et confirmée par lui\*\*[\s\S]*On garde le bouton\nsous la liste\./);
  assert.deepEqual(decisions(), [{ kind: 'decision', source: 'discussion', ticket: 'X-5', run_id: 'talk-1-talk-a1', detail: 'On garde le bouton sous la liste.' }]);
  assert.deepEqual(waiting(), []);
  // A decision the user drops never leaves.
  decide(['X-6', '-'], 'Finalement non.');
  assert.equal(confirm(['--drop', waiting()[0]]).status, 0);
  assert.equal(decisions().length, 1);
  assert.doesNotMatch(posted(), /Finalement non/);

  // --adr: only with a change to the file of the decisions, and to nothing else, in the worktree of the decisions.
  assert.match(decide(['X-5', '-', '--adr'], 'Une règle.').stderr, /needs a change to docs\/decisions\.md/);
  mkdirSync(join(lane.path, 'docs'), { recursive: true });
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\n');
  execFileSync('git', ['-C', lane.path, 'add', '.']);
  execFileSync('git', ['-C', lane.path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'docs: the file of the decisions']);
  execFileSync('git', ['-C', lane.path, 'push', '-q', 'origin', 'HEAD:main']);
  execFileSync('git', ['-C', box.repo, 'merge', '-q', '--ff-only', 'talk/X-100']);
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\nUne règle qui dure.\n');
  writeFileSync(join(lane.path, 'other.md'), 'not for a discussion\n');
  assert.match(decide(['X-5', '-', '--adr'], 'Une règle.').stderr, /and to nothing else/);
  execFileSync('rm', [join(lane.path, 'other.md')]);
  assert.equal(decide(['X-5', '-', '--adr'], 'Une règle qui dure.').status, 0);
  assert.equal(execFileSync('git', ['-C', lane.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), 'M docs/decisions.md', 'proposing commits nothing');
  // One at a time: a second one is not prepared while the first waits.
  assert.match(decide(['X-6', '-'], 'Une autre.').stderr, /already waits for the user/);
  // The file is touched again after the proposal: what would leave is not what the user was shown. Nothing leaves.
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\nUne règle qui dure.\nEt une ligne glissée après coup.\n');
  const touched = confirm();
  assert.equal(touched.status, 1);
  assert.match(touched.stderr, /changed since this decision was proposed/);
  assert.equal(execFileSync('git', ['-C', lane.path, 'log', '--format=%s', 'main..HEAD'], { encoding: 'utf8' }), '');
  assert.equal(confirm(['--drop', waiting()[0]]).status, 0);
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\nUne règle qui dure.\n');
  assert.equal(decide(['X-5', '-', '--adr'], 'Une règle qui dure.').status, 0);
  // The push fails once (GitHub does not open the pull request): nothing is said to be decided, and the next try sends the commit already made.
  // The first run shows the whole change, removed lines included, and sends nothing; the second one sends.
  const shown = confirm([], { FAKE_GH_DOWN: '1' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Ce qui changera dans docs\/decisions\.md[\s\S]*\+Une règle qui dure\.[\s\S]*Rien n'est parti/);
  assert.equal(execFileSync('git', ['-C', lane.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), 'M docs/decisions.md');
  const failed = confirm([], { FAKE_GH_DOWN: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /nothing is transcribed yet/);
  assert.equal(decisions().length, 1);
  assert.doesNotMatch(posted(), /Une règle qui dure/);
  const adr = confirm();
  assert.equal(adr.status, 0, adr.stderr);
  assert.equal(decisions().length, 2);
  assert.match(posted(), /Une règle qui dure\.[\s\S]*Écrite aussi dans `docs\/decisions\.md`/);
  assert.ok(lane.onRemote().some((ref) => ref.startsWith('talk/X-100 ')), 'the branch of the decisions left, to its namesake');
  assert.ok(lane.created().includes('--draft'));
  assert.equal(execFileSync('git', ['-C', lane.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('the decisions of a second discussion are written on top of the base as it is now, and a branch that holds decisions is never started over', () => {
  const lane = laneWithRemote('talk/X-100', 'docs: a decision of an earlier discussion');
  const { box } = lane;
  const head = () => execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const earlier = head();
  // The base moved on meanwhile.
  box.git('commit', '-q', '--allow-empty', '-m', 'chore: the base moves');
  const moved = execFileSync('git', ['-C', box.repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const open = (extra = {}) => spawnSync(join(box.home, 'talk.sh'), [], { env: { ...box.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', ...extra }, encoding: 'utf8' });
  assert.equal(open().status, 0);
  const ancestors = execFileSync('git', ['-C', lane.path, 'rev-list', 'HEAD'], { encoding: 'utf8' });
  assert.ok(ancestors.includes(earlier), 'the earlier decision is still there');
  assert.ok(ancestors.includes(moved), 'the base was brought in');
  // That conversation ends (the terminal of the test ran nothing: its mark is taken away here). A second one is refused while the first is open.
  assert.match(open().stderr, /already open/);
  execFileSync('rm', [join(box.state, 'wake', 'talk')]);
  // Its folder disappears: the branch is taken back as it is.
  box.git('worktree', 'remove', '--force', lane.path);
  const kept = execFileSync('git', ['-C', box.repo, 'rev-parse', 'talk/X-100'], { encoding: 'utf8' }).trim();
  assert.equal(open().status, 0);
  assert.equal(head(), kept);
});

test('the import of the past takes back out the sessions of a worktree the dispatcher opened, and only those', () => {
  const box = sandbox();
  const home = mkdtempSync(join(tmpdir(), 'orch-user-'));
  const prefix = join(box.home, 'lanes').replace(/[^A-Za-z0-9]/g, '-');
  const session = (worktree, id) => {
    const dir = join(home, '.claude', 'projects', `${prefix}-${worktree}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } })}\n`);
  };
  session('release-lead', 'aaaaaaaa-1111');
  session('old-lane', 'bbbbbbbb-2222');
  const db = openLedger(join(box.state, 'ledger.db'));
  const row = (id, source) => db.prepare('INSERT INTO runs (run_id, role, started_at, source) VALUES (?, ?, ?, ?)').run(id, 'dev', '2020-01-01T00:00:00Z', source);
  row('legacy:aaaaaaaa:2020-01-01T00:00:00Z', 'legacy');
  row('legacy:bbbbbbbb:2020-01-01T00:00:00Z', 'legacy');
  row('lead-1-release-a1', 'dispatcher');
  db.close();
  const run = spawnSync('node', ['--no-warnings', join(ORCH_HOME, 'import-legacy.mjs'), '--no-linear', '--days', '1'], { env: { ...box.env, HOME: home }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).removed, 1);
  const after = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(after.prepare('select run_id from runs order by run_id').all().map((r) => r.run_id), ['lead-1-release-a1', 'legacy:bbbbbbbb:2020-01-01T00:00:00Z']);
  after.close();
});

test('the tokens of a conversation are counted from its own session log, each message once', async () => {
  const { sessionUsage } = await import('../ops/orchestration/lib/session-usage.mjs');
  const message = (id, usage, model = 'm-big') => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
  const usage = sessionUsage([
    message('a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    message('a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    message('b', { input_tokens: 1, output_tokens: 2 }),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    'not json',
    message('c', { input_tokens: 999 }, '<synthetic>'),
  ], 'asked');
  assert.deepEqual(usage, { model: 'm-big', tokens_in: 11, tokens_out: 7, tokens_cache: 100, tokens_cache_write: 20, tokens_total: 138, cost_usd: null });
  assert.equal(sessionUsage([], 'asked').tokens_total, 0);
});

test('the sessions of a worktree the dispatcher opened are not the old way of working: the import of the past leaves them out', async () => {
  const { dispatcherWorktree } = await import('../ops/orchestration/lib/lanes.mjs');
  const roles = Object.keys(conf.roles);
  for (const name of ['release-lead', 'dev-SEE-105', 'review-SEE-112', 'talk-SEE-112']) assert.equal(dispatcherWorktree(name, roles), true, name);
  for (const name of ['orrchestrator', 'app-rapide', 'release-notes', 'dev-something', 'fiche-enveloppe-projet']) assert.equal(dispatcherWorktree(name, roles), false, name);
});
