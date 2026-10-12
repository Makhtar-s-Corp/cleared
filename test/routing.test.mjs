import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { defaultValue, loadConf, parseConf, requiredValue, ORCH_HOME } from '../lib/conf.mjs';
import { route } from '../lib/route.mjs';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.mjs';
import { conf, scratch, fixtureProject, sandbox, runLane, laneWithRemote, flowBox, reviewedPull, task, first } from './support.mjs';

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


test('the report is written, and the adapter goes on, when the lane changed a few files', () => {
  const dir = scratch('orch-report-');
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
  assert.match(report, /## Report\n\nFait : rien\.\n\n## Changed files\n\n- \?\? /);
});


test('a backend that cannot start now hands over to the declared fallback, and says so', () => {
  const lane = runLane(sandbox(), 2);
  assert.equal(lane.status, 0);
  assert.deepEqual(lane.runs, [{ model: 'm1', outcome: 'refused', exit_code: 2 }, { model: 'm2', outcome: 'done', exit_code: 0 }]);
  assert.deepEqual(lane.events, ['model_fallback']);
  assert.match(lane.comment, /Fallback: a/);
});


test('a failure of the model is not a reason to try another one', () => {
  const lane = runLane(sandbox(), 1);
  assert.equal(lane.status, 1);
  assert.deepEqual(lane.runs, [{ model: 'm1', outcome: 'failed', exit_code: 1 }]);
  assert.deepEqual(lane.events, []);
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
  const dir = scratch('orch-claude-advisor-');
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
  const dir = scratch('orch-claude-');
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
  // Folders a role may read beyond its own worktree (what the lanes set apart for the user): named, never « everything ».
  const reads = (() => {
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCH_PERMISSION_MODE: 'read-only', ORCH_ALLOW: 'git status', ORCH_DENY: '', ORCH_READ: '/somewhere/kept captures, /elsewhere/notes' },
    });
    assert.equal(run.status, 0, run.stderr);
    const args = readFileSync(join(dir, 'args'), 'utf8').split('\n');
    return args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  })();
  assert.deepEqual(reads, ['Bash(git status)', 'Bash(git status *)', 'Read(//somewhere/kept captures/**)', 'Read(//elsewhere/notes/**)']);
  assert.ok(!allowed.some((tool) => tool.startsWith('Read(')), 'a role that names no folder gets none');
  for (const denied of ['Bash(curl)', 'Bash(curl *)', 'Bash(git push)', 'Bash(git push *)', 'WebFetch']) assert.ok(edits.includes(denied), denied);
  assert.ok(edits.includes('--strict-mcp-config'));
  const readOnly = call('read-only');
  assert.ok(!readOnly.includes('--permission-mode'));
  for (const denied of ['Edit', 'Write', 'NotebookEdit']) assert.ok(readOnly.includes(denied), denied);
});


test('the tracker text is the write-up when the writing model answers, the raw report when it does not', () => {
  const lane = (writerExit) => {
    const box = sandbox();
    writeFileSync(join(box.home, 'prompts', 'writeup.md'), 'reword\n');
    const runDir = scratch('orch-run-');
    writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
    writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'b', adapter: 'second', model: 'm2' }]));
    writeFileSync(join(runDir, 'writeup-chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
    writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-test\nORCH_REQUESTED_ALIAS=b\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=writing\n');
    const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env: { ...box.env, FIRST_EXIT: String(writerExit) }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(runDir, 'comment.md'), 'utf8');
  };
  const worded = lane(0);
  assert.match(worded, /Report formatted by m1/);
  assert.match(worded, /answer of first/);
  assert.doesNotMatch(worded, /answer of second/);
  const raw = lane(1);
  assert.match(raw, /Formatting failed/);
  assert.match(raw, /answer of second/);
  assert.match(raw, /Used model: `m2`/);
});


test('the Claude adapter says "cannot start now" when the model produced nothing, and "failed" once it has worked', () => {
  const dir = scratch('orch-claude-');
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


test('the Codex adapter gives the work of a lane its tools through the door of the heavy commands, for the whole session; a text-only run gets none; a host that is not free is « cannot start now »', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  const task = join(box.home, 'task.sh');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[lanes]\n', `[lanes]\nheavy_commands = echo screens, ${task.replace(box.home, '~')}\nheavy_wait_minutes = 0\n`));
  mkdirSync(join(box.home, 'proc-none'), { recursive: true });
  mkdirSync(box.state, { recursive: true });
  writeFileSync(join(box.home, 'prompt.md'), 'the prompt of the lane\n');
  writeFileSync(task, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(box.home, 'task-args')}"\ncp "$2" "${join(box.home, 'task-prompt')}"\n(flock -n 9 && echo free || echo held) 9> "${join(box.state, 'heavy.lock')}" > "${join(box.home, 'door')}"\nprintf 'done'\n`, { mode: 0o755 });
  const env = { ...box.env, HOME: box.home, ORCH_PROC_DIR: join(box.home, 'proc-none'), ADAPTER_RUNNER: 'container', ADAPTER_TASK_SCRIPT: task };
  const call = (extra = {}, ci = 0) => {
    writeFileSync(join(box.home, 'bin', 'gh'), `#!/usr/bin/env bash\necho ${ci}\n`, { mode: 0o755 });
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'codex.sh'), ['run', '--model', 'm', '--prompt-file', join(box.home, 'prompt.md'), '--report', join(box.home, 'r.md'), '--usage', join(box.home, 'u.json')], { cwd: box.repo, encoding: 'utf8', env: { ...env, ...extra } });
    const read = (name) => { try { return readFileSync(join(box.home, name), 'utf8'); } catch { return ''; } };
    return { status: run.status, stderr: run.stderr, args: read('task-args').trim().split('\n'), prompt: read('task-prompt'), door: read('door').trim(), report: read('r.md') };
  };
  // Without the setting: the plain run, as before.
  const plain = call();
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(plain.args.slice(2), ['m']);
  assert.equal(plain.door, 'free', 'the plain run does not hold the door');
  // With it: the script is asked for its tools, the door is held while it runs, and the model is told how its work will be committed.
  const tools = call({ ADAPTER_TASK_TOOLS: 'yes' });
  assert.equal(tools.status, 0, tools.stderr);
  assert.deepEqual(tools.args.slice(2), ['m', '--tools']);
  assert.equal(tools.door, 'held');
  assert.match(tools.prompt, /^the prompt of the lane\n/);
  assert.match(tools.prompt, /\.commit-message/);
  // The write-up of a report is text only: no tools, no door.
  const text = call({ ADAPTER_TASK_TOOLS: 'yes', ORCH_TEXT_ONLY: '1' });
  assert.deepEqual(text.args.slice(2), ['m']);
  assert.equal(text.door, 'free');
  // Somebody holds the door (a screen test of another lane): this session could not start now, and nothing ran.
  rmSync(join(box.home, 'task-args'));
  const held = spawnSync('bash', ['-c', 'exec 9> "$1"; flock 9; shift; "$@"; code=$?; exit "$code"', '_', join(box.state, 'heavy.lock'), join(ORCH_HOME, 'adapters', 'codex.sh'), 'run', '--model', 'm', '--prompt-file', join(box.home, 'prompt.md'), '--report', join(box.home, 'r.md'), '--usage', join(box.home, 'u.json')], { cwd: box.repo, encoding: 'utf8', env: { ...env, ADAPTER_TASK_TOOLS: 'yes' } });
  assert.equal(held.status, 2, held.stderr);
  assert.throws(() => readFileSync(join(box.home, 'task-args')));
  assert.match(readFileSync(join(box.home, 'r.md'), 'utf8'), /^outcome: refused$/m);
  // A session that ran is never taken for a door that stayed shut: whatever it printed (the door's own words, read in a file), and whatever its code (5 is its own: a budget, elsewhere).
  writeFileSync(task, `#!/usr/bin/env bash\necho ran > "${join(box.home, 'task-args')}"\necho 'when-free.sh: "x" is not one of the heavy commands of the project' >&2\necho 'and it went on' >&2\nprintf 'done'\n`, { mode: 0o755 });
  const echoed = call({ ADAPTER_TASK_TOOLS: 'yes' });
  assert.equal(echoed.status, 0, echoed.stderr);
  assert.match(echoed.report, /^outcome: done$/m);
  writeFileSync(task, `#!/usr/bin/env bash\necho ran > "${join(box.home, 'task-args')}"\necho 'stopped by its budget' >&2\nexit 5\n`, { mode: 0o755 });
  const five = call({ ADAPTER_TASK_TOOLS: 'yes' });
  assert.equal(five.status, 5);
  assert.deepEqual(five.args, ['ran']);
  // A project that did not name the script among its heavy commands: said by the door, and « cannot start now » too.
  rmSync(join(box.home, 'task-args'));
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace(/heavy_commands = .*\n/, 'heavy_commands = echo screens\n'));
  const unnamed = call({ ADAPTER_TASK_TOOLS: 'yes' });
  assert.equal(unnamed.status, 2);
  assert.match(unnamed.report, /is not one of the heavy commands/);
  assert.deepEqual(unnamed.args, [''], 'the script never ran');
});


test('what a backend that cannot commit brings back is committed by the rules, under the message it wrote, and sent like any work; a backend that commits by itself is left alone', () => {
  const { flow, todo, by, record, box, env, stuck, pull } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8')}\n[adapter.first]\ncommits = no\n`);
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const kept = record('X-5');
  const run = (leaves, extra = {}) => spawnSync(join(box.home, 'lane-run.sh'), [join(box.state, 'runs', record('X-5').runs.at(-1).run)], { cwd: kept.worktree, env: { ...env, ANSWER: 'Fait.\n\nQuestions pour the user : aucune.', FAKE_LEAVES: leaves, ...extra }, encoding: 'utf8' });
  const remote = (...args) => execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), ...args], { encoding: 'utf8' }).trim();
  // Its work comes back as files changed in the worktree, with the message it wrote.
  const first = run(`mkdir -p server; echo 'export const note = 1;' > server/note.mjs; printf 'feat(notes): a first note\\n\\nWhy it is there.\\n' > .commit-message`);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(remote('log', '-1', '--format=%s', 'dev/X-5'), 'feat(notes): a first note');
  assert.equal(remote('show', 'dev/X-5:server/note.mjs'), 'export const note = 1;');
  assert.notEqual(spawnSync('git', ['--git-dir', join(box.home, 'remote.git'), 'cat-file', '-e', 'dev/X-5:.commit-message']).status, 0, 'the message file is not part of its work');
  assert.equal(execFileSync('git', ['-C', kept.worktree, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  // The rules find nothing left to send, and open no session to commit it.
  const after = flow();
  assert.doesNotMatch(after.stdout, /X-5: opened again \(unsent/);
  assert.deepEqual(stuck(), []);
  // A message that says nothing: the default subject, and the work is committed all the same.
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: true }]));
  const next = () => { pull({ headRefOid: remote('rev-parse', 'dev/X-5'), isDraft: true }); return spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-5', '--resume', '--comment-on', 'none', '--keep-status'], { env, encoding: 'utf8' }); };
  const again = next();
  assert.equal(again.status, 0, again.stderr);
  const blank = run(`echo 'export const note = 2;' > server/note.mjs; printf '  \\n\\n' > .commit-message`);
  assert.equal(blank.status, 0, blank.stderr);
  assert.match(remote('log', '-1', '--format=%s', 'dev/X-5'), /^chore: the work of a on X-5$/);
  assert.equal(remote('show', 'dev/X-5:server/note.mjs'), 'export const note = 2;');
  // A backend that commits by itself is left alone: what it did not commit stays its own to sort out.
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[adapter.first]\ncommits = no\n', ''));
  assert.equal(next().status, 0);
  const own = run(`echo 'export const note = 3;' > server/note.mjs`);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(remote('show', 'dev/X-5:server/note.mjs'), 'export const note = 2;', 'nothing was committed for it');
  assert.match(execFileSync('git', ['-C', record('X-5').worktree, 'status', '--porcelain'], { encoding: 'utf8' }), /server\/note\.mjs/);
});


test('the spawn lock is released once the lane exists, not held while waiting for it', () => {
  const box = sandbox();
  const args = (ticket, ...more) => [join(box.home, 'spawn-lane.sh'), ['dev', ticket, '--comment-on', 'none', ...more], { env: { ...box.env, ORCH_WAIT_SECONDS: '20' }, encoding: 'utf8' }];
  // The first lane never finishes (its terminal runs nothing): it waits 20 s.
  const [command, argv, options] = args('X-2', '--wait');
  const waiting = spawn(command, argv, { ...options, stdio: 'ignore', detached: true });
  waiting.unref();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
  const before = Date.now();
  const second = spawnSync(...args('X-3'));
  try { process.kill(-waiting.pid); } catch { /* already finished */ }
  assert.equal(second.status, 0, second.stderr);
  assert.ok(Date.now() - before < 10000, 'the second spawn waited for the first one to stop waiting');
});


test('a long session does not make the Claude adapter die before its report', () => {
  const dir = scratch('orch-claude-');
  writeFileSync(join(dir, 'prompt.md'), 'p');
  // Several megabytes of events, as a real session writes.
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\ncat > /dev/null\nline='{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"${'x'.repeat(400)}"}]}}'\nfor i in $(seq 1 12000); do echo "$line"; done\necho '{"type":"result","is_error":false,"result":"the end","total_cost_usd":0,"modelUsage":{}}'\n`, { mode: 0o755 });
  const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'r.md'), '--usage', join(dir, 'u.json')], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64e6, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(run.status, 0, run.stderr.slice(-300));
  assert.match(readFileSync(join(dir, 'r.md'), 'utf8'), /## Report\n\nthe end\n/);
});


test('a CLI that ends with no result at all is a failure, not a reason to try another model', () => {
  const dir = scratch('orch-claude-');
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
  assert.match(lane.comment, /without a report/);
  assert.match(lane.comment, /Used model: `m1`/);
});


test('tracker saying no is an error: nothing is reported as sent or opened', () => {
  const dir = scratch('orch-tracker-');
  const no = { data: { issue: { id: 'i' }, teams: { nodes: [{ id: 't' }] }, projects: { nodes: [{ id: 'p' }] }, issueLabels: { nodes: [{ id: 'l' }] }, commentCreate: { success: false, comment: null }, issueCreate: { success: false, issue: null } } };
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\necho '${JSON.stringify(no)}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'text.md'), 'Fait : rien.');
  const repoRoot = fixtureProject();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') };
  for (const args of [['comment', 'X-1', join(dir, 'text.md'), 'test'], ['create', 'Projet', 'Bug', 'Un titre', join(dir, 'text.md')]]) {
    const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), args, { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0, args[0]);
    assert.equal(run.stdout.trim(), '', args[0]);
  }
  assert.throws(() => readFileSync(join(dir, 'state', 'tracker-comments.jsonl')));
  assert.throws(() => readFileSync(join(dir, 'state', 'tracker-issues.jsonl')));
});


test('the scripts run as commands from a folder whose name has a space or an accent', () => {
  const dir = scratch('orch été ');
  execFileSync('cp', ['-r', join(ORCH_HOME, 'serve'), join(ORCH_HOME, 'lib'), dir]);
  const served = spawnSync('node', [join(dir, 'serve', 'serve-dashboard.mjs')], { encoding: 'utf8' });
  assert.equal(served.status, 64, 'run with no argument, it must print its usage, not do nothing');
  const routed = spawnSync('node', [join(dir, 'lib', 'route.mjs')], { encoding: 'utf8', env: { ...process.env, ORCH_CONF: join(ORCH_HOME, 'agents.example.conf') } });
  assert.equal(routed.status, 1);
  assert.match(routed.stderr, /--role is required/);
  const env = { ...process.env, ORCH_CONF: join(ORCH_HOME, 'agents.example.conf'), ORCH_STATE_DIR: join(dir, 'state') };
  const ledger = spawnSync('node', [join(dir, 'lib', 'ledger.mjs'), 'init'], { encoding: 'utf8', env });
  assert.equal(ledger.status, 0, ledger.stderr);
  assert.match(ledger.stdout, /ledger\.db/);
  assert.equal(spawnSync('node', [join(dir, 'lib', 'dashboard.mjs')], { encoding: 'utf8', env }).status, 1, 'with no input file it fails, it does not do nothing');
  // Through a symbolic link too.
  execFileSync('ln', ['-s', join(dir, 'lib', 'route.mjs'), join(dir, 'route-link.mjs')]);
  assert.match(spawnSync('node', [join(dir, 'route-link.mjs')], { encoding: 'utf8', env }).stderr, /--role is required/);
});


test('a comment on a ticket tracker does not know is an error', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\necho '{"data":{"issue":null}}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'text.md'), 'Fait : rien.');
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-404', join(dir, 'text.md'), 'test'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no such ticket: X-404/);
});


test('a line cut short in the session does not hide that the model worked', () => {
  const dir = scratch('orch-claude-');
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
