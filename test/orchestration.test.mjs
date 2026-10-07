import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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
  const small = parseConf('[models]\na = x:1\nb = x:2\n[roles]\ndev = a\n[rules]\ndev pr_lines>10 -> b\ndev path=server/ -> b\n');
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
