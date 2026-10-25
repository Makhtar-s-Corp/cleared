import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defaultValue, loadConf, parseConf, requiredValue, ORCH_HOME } from '../lib/conf.ts';
import { route } from '../lib/route.ts';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.ts';
import { conf, scratch, fixtureProject, sandbox, task, first } from './support.ts';

test('every alias, fallback, role and rule of agents.conf points to a declared model', () => {
  const example = readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8');
  const reference = readFileSync(join(ORCH_HOME, 'docs', 'configuration.md'), 'utf8');
  const sections = new Map();
  let section = '';
  for (const line of example.split('\n')) {
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) { section = heading[1]; sections.set(section, new Set()); continue; }
    const key = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=/);
    if (key && section !== 'rules') sections.get(section).add(key[1]);
  }
  for (const [name, keys] of sections) {
    const heading = `## \`[${name}]\``;
    const start = reference.indexOf(heading);
    assert.ok(start >= 0, `missing configuration section ${name}`);
    const next = reference.indexOf('\n## ', start + heading.length);
    const body = reference.slice(start, next < 0 ? undefined : next);
    for (const key of keys) {
      const row = body.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
      assert.ok(row, `undocumented setting ${name}.${key}`);
      assert.match(row, /\| (?:Required|Default:|Optional; no default)/, `missing requirement or default for ${name}.${key}`);
      const fallback = defaultValue(name, key);
      if (fallback !== undefined) assert.ok(row.includes(`Default: ${fallback} |`), `incorrect default for ${name}.${key}`);
      else if (requiredValue(name, key)) assert.match(row, /\| Required(?: |\|)/, `required setting ${name}.${key} marked optional`);
    }
  }
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
  const screen = first({ labels: ['Feature'], paths: ['web/pages/x.jsx'] });
  assert.notEqual(engine, screen);
  assert.equal(first({ labels: ['Feature'], project: 'Backend reliability' }), engine);
  assert.equal(first({ labels: ['Feature'], paths: ['api/finance.mjs'] }), engine);
  assert.equal(first({ labels: ['Feature'], project: 'Interface refresh' }), screen);
  assert.equal(first({ labels: ['Feature'], paths: ['web/pages/x.jsx'], prLines: 401 }), engine);
  assert.equal(first({ labels: ['Feature'], paths: ['web/pages/x.jsx'], prLines: 400 }), screen);
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


test('the core\'s scripts name no model and no provider', () => {
  const names = new Set();
  for (const [alias, model] of Object.entries(conf.models)) { names.add(alias); names.add(model.model); names.add(model.adapter); }
  for (const word of ['gpt', 'opus', 'sonnet', 'haiku', 'fable', 'gemini']) names.add(word);
  const files = ['lib/script.ts', 'lib/route.ts', 'lib/conf.ts'];
  for (const file of files) {
    const code = readFileSync(join(ORCH_HOME, file), 'utf8').split('\n').filter((line) => !/^\s*(#|\/\/)/.test(line)).join('\n');
    for (const name of names) {
      assert.ok(!new RegExp(`(^|[^a-z_/.-])${name.replace(/[.]/g, '\\.')}([^a-z_/.-]|$)`, 'i').test(code), `${file} names "${name}"`);
    }
  }
});


test('the ledger records a run, its cost and an event', () => {
  const db = openLedger(':memory:');
  runStart(db, { runId: 'r1', ticket: 'EX-1', role: 'dev', model: 'm', provider: 'x', lane: 'dev/EX-1', requestedModel: 'alias' });
  const pricing = parseConf('[currency]\nusd_eur = 0.5\n[prices]\npriced = 1 2 0.5 4 8\n');
  runEnd(db, pricing, { runId: 'r1', outcome: 'done', exitCode: 0, usage: { model: 'actual', tokens_in: 10, tokens_out: 20, tokens_cache: 30, tokens_cache_write: 40, cost_usd: 2 } });
  const row = db.prepare('select * from runs').get();
  assert.equal(row.model, 'actual');
  assert.equal(row.cost_eur, 1);
  assert.equal(row.cost_basis, 'cli');
  assert.equal(row.tokens_total, 100);
  assert.throws(() => runEnd(db, pricing, { runId: 'nope', outcome: 'done' }), /unknown run/);
  assert.throws(() => addEvent(db, { kind: 'made_up' }), /unknown event kind/);
  addEvent(db, { kind: 'lane_limit_reached', ticket: 'EX-1', value: 3 });
  assert.equal(db.prepare('select count(*) n from events').get().n, 1);
});


test('a cost is computed from the price table only when the CLI gives none, and never guessed', () => {
  const pricing = parseConf('[currency]\nusd_eur = 0.5\n[prices]\npriced = 1 2 0.5 4 8\n');
  const usage = { tokens_in: 1e6, tokens_out: 1e6, tokens_cache: 1e6, tokens_cache_write: 2e6, tokens_cache_write_5m: 1e6 };
  assert.deepEqual(costEur(pricing, { ...usage, model: 'priced' }), { cost: (1 + 2 + 0.5 + 4 + 8) * 0.5, basis: 'prices' });
  assert.deepEqual(costEur(pricing, { ...usage, model: 'unpriced' }), { cost: null, basis: null });
  assert.equal(costEur(pricing, { model: 'unpriced', tokens_total: 1493 }).cost, null);
});

















test('[Linear adapter] tracker saying no is an error: nothing is reported as sent or opened', () => {
  const dir = scratch('orch-tracker-');
  const no = { data: { issue: { id: 'i' }, teams: { nodes: [{ id: 't' }] }, projects: { nodes: [{ id: 'p' }] }, issueLabels: { nodes: [{ id: 'l' }] }, commentCreate: { success: false, comment: null }, issueCreate: { success: false, issue: null } } };
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\necho '${JSON.stringify(no)}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'text.md'), 'Fait : rien.');
  const repoRoot = fixtureProject();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') };
  for (const args of [['comment', 'X-1', join(dir, 'text.md'), 'test'], ['create', 'Projet', 'Bug', 'Un titre', join(dir, 'text.md')]]) {
    const run = spawnSync(join(ORCH_HOME, 'tracker.ts'), args, { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0, args[0]);
    assert.equal(run.stdout.trim(), '', args[0]);
  }
  assert.throws(() => readFileSync(join(dir, 'state', 'tracker-comments.jsonl')));
  assert.throws(() => readFileSync(join(dir, 'state', 'tracker-issues.jsonl')));
});


test('the scripts run as commands from a folder whose name has a space or an accent', () => {
  const dir = scratch('orch été ');
  execFileSync('cp', ['-r', join(ORCH_HOME, 'serve'), join(ORCH_HOME, 'lib'), dir]);
  const routed = spawnSync('node', [join(dir, 'lib', 'route.ts')], { encoding: 'utf8', env: { ...process.env, ORCH_CONF: join(ORCH_HOME, 'agents.example.conf') } });
  assert.equal(routed.status, 1);
  assert.match(routed.stderr, /--role is required/);
  const env = { ...process.env, ORCH_CONF: join(ORCH_HOME, 'agents.example.conf'), ORCH_STATE_DIR: join(dir, 'state') };
  const ledger = spawnSync('node', [join(dir, 'lib', 'ledger.ts'), 'init'], { encoding: 'utf8', env });
  assert.equal(ledger.status, 0, ledger.stderr);
  assert.match(ledger.stdout, /ledger\.db/);
  // Through a symbolic link too.
  execFileSync('ln', ['-s', join(dir, 'lib', 'route.ts'), join(dir, 'route-link.ts')]);
  assert.match(spawnSync('node', [join(dir, 'route-link.ts')], { encoding: 'utf8', env }).stderr, /--role is required/);
});


test('[Linear adapter] a comment on a ticket tracker does not know is an error', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\necho '{"data":{"issue":null}}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'text.md'), 'Fait : rien.');
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.ts'), ['comment', 'X-404', join(dir, 'text.md'), 'test'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no such ticket: X-404/);
});



