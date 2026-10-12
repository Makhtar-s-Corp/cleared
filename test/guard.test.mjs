import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.mjs';
import { route } from '../lib/route.mjs';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.mjs';
import { conf, scratch, fixtureProject, sandbox, runLane, laneWithRemote, flowBox, reviewedPull, task, first } from './support.mjs';

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


test('a refusal by the safeguard of a backend stops the lane when the policy says stop', () => {
  const lane = runLane(sandbox({ policy: 'stop' }), 3);
  assert.equal(lane.status, 3);
  assert.deepEqual(lane.runs, [{ model: 'm1', outcome: 'refused', exit_code: 3 }]);
  assert.deepEqual(lane.events, ['model_fallback_failed']);
  assert.match(lane.comment, /provider guard/);
});


test('a refusal by the safeguard of a backend takes the fallback when the policy says fallback', () => {
  const lane = runLane(sandbox({ policy: 'fallback' }), 3);
  assert.equal(lane.status, 0);
  assert.deepEqual(lane.runs.map((run) => run.outcome), ['refused', 'done']);
  assert.deepEqual(lane.events, ['model_fallback']);
});


test('the Codex adapter tells a guard refusal (3) from a CI run in progress (2), and reads the answer and the tokens', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'prompt.md'), 'p');
  const call = ({ ci = 0, script }) => {
    writeFileSync(join(box.home, 'bin', 'gh'), `#!/usr/bin/env bash\necho ${ci}\n`, { mode: 0o755 });
    writeFileSync(join(box.home, 'task.sh'), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'codex.sh'), ['run', '--model', 'm', '--prompt-file', join(box.home, 'prompt.md'), '--report', join(box.home, 'r.md'), '--usage', join(box.home, 'u.json')], {
      cwd: box.repo, encoding: 'utf8', env: { ...box.env, ADAPTER_RUNNER: 'container', ADAPTER_TASK_SCRIPT: join(box.home, 'task.sh') },
    });
    return { status: run.status, report: readFileSync(join(box.home, 'r.md'), 'utf8'), usage: JSON.parse(readFileSync(join(box.home, 'u.json'), 'utf8')) };
  };
  const refusal = call({ script: 'echo "/tmp/x/repo/test/a.test.mjs:3: secret littéral" >&2; echo "Refusé : contenu sensible dans ce qui serait envoyé à Codex." >&2; exit 1' });
  assert.equal(refusal.status, 3);
  assert.match(refusal.report, /^outcome: refused$/m);
  assert.match(refusal.report, /- test\/a\.test\.mjs:3: secret littéral/);
  const englishRefusal = call({ script: 'echo "/tmp/x/repo/test/a.test.mjs:4: email address" >&2; echo "Refused: sensitive content in data that would be sent to Codex." >&2; exit 1' });
  assert.equal(englishRefusal.status, 3);
  assert.match(englishRefusal.report, /- test\/a\.test\.mjs:4: email address/);
  assert.equal(call({ ci: 1, script: 'exit 0' }).status, 2);
  const done = call({ script: 'printf "the answer\\nthe answer"; printf "tokens used\\n1,234\\n" >&2' });
  assert.equal(done.status, 0);
  assert.equal(done.usage.tokens_total, 1234);
  assert.equal(done.usage.limits, undefined, 'a run that says nothing of its subscription leaves nothing');
  assert.equal(done.usage.tokens_in, null, 'and one that says nothing of its tokens by kind leaves the split empty');
  // What the session used, by kind, passed on by the task script: kept as the ledger names it for every backend
  // (input that was not read from the cache, input read from it, output); the total stays the one the CLI printed.
  const used = call({ script: 'printf "ok"; printf \'tokens used\\n7,063\\ntoken usage {"input_tokens":29037,"cached_input_tokens":22016,"cache_write_input_tokens":0,"output_tokens":42,"reasoning_output_tokens":0,"total_tokens":29079}\\n\' >&2' });
  assert.deepEqual([used.usage.tokens_in, used.usage.tokens_cache, used.usage.tokens_out, used.usage.tokens_cache_write, used.usage.tokens_total], [7021, 22016, 42, 0, 7063]);
  // A line that cannot be read, or without the figures that count, leaves the split empty and takes nothing else with it.
  for (const line of ['not json', '{"input_tokens":"many","output_tokens":3}', '{"output_tokens":3}', '[1,2]']) {
    const odd = call({ script: `printf "ok"; printf 'tokens used\\n5\\ntoken usage ${line}\\n' >&2` });
    assert.deepEqual([odd.status, odd.usage.tokens_in, odd.usage.tokens_out, odd.usage.tokens_total], [0, null, null, 5], line);
  }
  // What the CLI recorded of its subscription, passed on by the task script: read under the names the windows have elsewhere.
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const limited = call({ script: `printf "ok"; printf 'rate limits {"primary":{"used_percent":41.5,"window_minutes":10080,"resets_at":${resets}},"secondary":{"used_percent":7,"window_minutes":300,"resets_at":${resets}},"plan_type":"x"}\\ntokens used\\n10\\n' >&2` });
  assert.equal(limited.status, 0);
  assert.deepEqual(limited.usage.limits, { windows: { seven_day: { used: 41.5, resets_at: new Date(resets * 1000).toISOString().replace('.000Z', 'Z') }, five_hour: { used: 7, resets_at: new Date(resets * 1000).toISOString().replace('.000Z', 'Z') } } });
  assert.equal(call({ script: `printf "ok"; printf 'rate limits not json\\n' >&2` }).usage.limits, undefined);
  // A window whose figures cannot be read does not take the other with it; two windows of the same length keep the fuller one.
  const odd = call({ script: `printf "ok"; printf 'rate limits {"primary":{"used_percent":93,"window_minutes":10080,"resets_at":${resets}},"secondary":{"used_percent":5,"window_minutes":300,"resets_at":1e30}}\\n' >&2` });
  assert.deepEqual(Object.keys(odd.usage.limits.windows), ['seven_day']);
  assert.equal(odd.usage.limits.windows.seven_day.used, 93);
  const twin = call({ script: `printf "ok"; printf 'rate limits {"primary":{"used_percent":93,"window_minutes":10080,"resets_at":${resets}},"secondary":{"used_percent":12,"window_minutes":10080,"resets_at":${resets}}}\\n' >&2` });
  assert.equal(twin.usage.limits.windows.seven_day.used, 93);
  assert.match(done.report, /## Report\n\nthe answer\n\n## Changed files/);
});


test('a comment that the guard refuses never reaches Linear', () => {
  const dir = scratch('orch-linear-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ntouch "${join(dir, 'called')}"\necho '{"data":{"issue":{"id":"i"},"commentCreate":{"success":true,"comment":{"id":"c","url":"u"}}}}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
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


test('push-lane sends nothing when a commit message is refused by the guard', () => {
  const flagged = `fix: le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}"`;
  const lane = laneWithRemote('dev/X-5', flagged);
  const run = lane.push();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refused by the guard/);
  assert.deepEqual(lane.onRemote().map((ref) => ref.split(' ')[0]), ['main']);
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


test('only an image, and only from the folder a lane sets apart for what may leave, may be sent to Linear', () => {
  const dir = scratch('orch-linear-');
  const captures = join(dir, 'lanes', 'a-lane', 'to-send');
  mkdirSync(captures, { recursive: true });
  mkdirSync(join(dir, 'lanes', 'a-lane', 'deeper', 'to-send'), { recursive: true });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of the image')]);
  writeFileSync(join(captures, 'apres.png'), png);
  writeFileSync(join(captures, 'secret.png'), 'TOKEN=not-an-image\n');
  writeFileSync(join(dir, 'elsewhere.png'), png);
  writeFileSync(join(dir, 'lanes', 'a-lane', 'test-results.png'), png);
  writeFileSync(join(dir, 'lanes', 'a-lane', 'deeper', 'to-send', 'apres.png'), png);
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${join(dir, 'curl-args')}"
case " $* " in *" PUT "*) exit 0 ;; esac
cat > /dev/null
echo '{"data":{"fileUpload":{"success":true,"uploadFile":{"uploadUrl":"https://storage.example.test/put","assetUrl":"https://uploads.example.test/asset","headers":[{"key":"x-goog-content-length-range","value":"25,25"}]}}}}'
`, { mode: 0o755 });
  const confPath = join(dir, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').replace(/^capture_roots = .*$/m, `capture_roots = ${join(dir, 'lanes')}/*/to-send`)}`);
  const repoRoot = fixtureProject();
  const upload = (file) => spawnSync(join(ORCH_HOME, 'linear.sh'), ['upload', file], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state'), ORCH_CONF: confPath } });
  const sent = () => { try { return readFileSync(join(dir, 'curl-args'), 'utf8'); } catch { return ''; } };
  assert.match(upload(join(dir, 'elsewhere.png')).stderr, /not under a folder of captures/);
  assert.match(upload(join(captures, '..', 'to-send', '..', 'test-results.png')).stderr, /not under a folder of captures/);
  // The rest of a lane's worktree (its test results, the images of the repository) does not leave: only that one folder, at that one place.
  assert.match(upload(join(dir, 'lanes', 'a-lane', 'test-results.png')).stderr, /not under a folder of captures/);
  assert.match(upload(join(dir, 'lanes', 'a-lane', 'deeper', 'to-send', 'apres.png')).stderr, /not under a folder of captures/);
  assert.match(readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8'), /^capture_roots = ~\/work\/example\/\.local\/captures-linear, ~\/work\/example\/\.local\/captures-linear\/\*, ~\/work\/example-lanes\/example\/\*\/\.local\/captures-linear$/m);
  assert.match(upload(join(captures, 'secret.png')).stderr, /not a PNG or JPEG image/);
  assert.match(upload(join(captures, 'missing.png')).stderr, /no such file/);
  assert.equal(sent(), '', 'nothing left the machine');
  const ok = upload(join(captures, 'apres.png'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'https://uploads.example.test/asset');
  assert.match(sent(), /PUT[\s\S]*x-goog-content-length-range: 25,25[\s\S]*https:\/\/storage\.example\.test\/put/);
});


test('the guard reads project lists at the committed base and keeps generic checks when private lists are absent', () => {
  const box = sandbox();
  const guard = (text, extra = {}) => {
    const file = join(box.home, 'out.txt');
    writeFileSync(file, text);
    return spawnSync('bash', ['-c', '. "$1/lib/common.sh"; guard_text "$2"', '_', box.home, file], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  };
  const term = 'Le contrat avec Zorglub Industries est signé.\n';
  const commit = (message) => { box.git('add', '-A'); box.git('commit', '-q', '-m', message); };
  assert.equal(guard('Rien de privé ici.\n').status, 0, guard('Rien de privé ici.\n').stderr);
  // An invented private term of the project, which the tool knows only by its fingerprint: refused, and not shown.
  const refused = guard(term);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /private term/);
  assert.doesNotMatch(refused.stderr, /Zorglub/);
  // The file of the checkout is emptied (a session ran code there): the list read is the one at the base.
  writeFileSync(join(box.repo, 'scripts', 'private-terms.json'), '{"salt_id":"e99d7c89dddc","hashes":[]}\n');
  assert.equal(guard(term).status, 1, 'the list is read at the base, not from the files of the checkout');
  box.git('checkout', '-q', '--', 'scripts/private-terms.json');
  // The project carries its own settings: what they say at the base comes before the example of the tool.
  mkdirSync(join(box.repo, '.cleared'), { recursive: true });
  const settings = (text) => writeFileSync(join(box.repo, '.cleared', 'agents.conf'), `${text}\n[guard]\nsalt = cleared-example-only\n`);
  settings('[guard]\nterms = none\nallowed = none\n');
  commit('chore: no private term');
  assert.equal(guard(term).status, 0, 'this project says it has no private term');
  // (built at run time so that this file holds nothing the guard would flag)
  assert.equal(guard(`Le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}" est dans le rapport.\n`).status, 1, 'what is refused everywhere still is');
  settings('[guard]\nsalt = cleared-example-only\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n');
  commit('chore: the lists');
  // The same file rewritten in the checkout, not at the base: nothing changes.
  settings('[guard]\nterms = none\nallowed = none\n');
  assert.equal(guard(term).status, 1, 'settings changed in the checkout do not weaken the guard');
  box.git('checkout', '-q', '--', '.cleared');
  // A misspelt key is refused rather than silently treated as no list.
  settings('[guard]\nterm = scripts/private-terms.json\nallowed = none\n');
  commit('chore: a typo');
  const typo = guard('Rien de privé ici.\n');
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /unknown \[guard\] key/);
  settings('[lanes]\nbase = main\n');
  commit('chore: no section');
  assert.equal(guard('Rien de privé ici.\n').status, 0, 'a project with no fingerprint lists keeps generic checks');
  // A list that is named and is not there at the base: refused too.
  settings('[guard]\nterms = scripts/gone.json\nallowed = none\n');
  commit('chore: a list that is not there');
  assert.match(guard('Rien de privé ici.\n').stderr, /could not be read/);
  // The code of the guard: when the tool is a checkout that follows a branch, it is the one of that branch. A copy
  // somebody edited by hand (the self-update then refuses to move it) does not run an edited guard.
  const tool = scratch('orch-tool-');
  const remote = join(tool, 'remote.git');
  const copy = join(tool, 'copy');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, copy], { stdio: 'ignore' });
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), copy]);
  writeFileSync(join(copy, 'agents.conf'), '[lanes]\nbase = main\n\n[guard]\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n');
  const inTool = (...args) => execFileSync('git', ['-C', copy, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  inTool('checkout', '-q', '-b', 'main');
  inTool('add', '.');
  inTool('commit', '-q', '-m', 'the tool');
  inTool('push', '-q', 'origin', 'main');
  settings('[guard]\nsalt = cleared-example-only\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n');
  commit('chore: the lists again');
  const fromCopy = (text) => {
    const file = join(tool, 'out.txt');
    writeFileSync(file, text);
    return spawnSync('bash', ['-c', '. "$1/lib/common.sh"; guard_text "$2"', '_', copy, file], { env: { ...box.env, ORCH_CONF: join(copy, 'agents.conf'), ORCH_GUARD_TOOL_REF: 'origin/main' }, encoding: 'utf8' });
  };
  assert.match(fromCopy(term).stderr, /private term/);
  writeFileSync(join(copy, 'lib', 'guard', 'codex-guard.mjs'), 'process.exit(0);\n');
  const edited = fromCopy(term);
  assert.equal(edited.status, 1, 'the guard that runs is the one of the branch the tool follows');
  assert.match(edited.stderr, /private term/);
  // When that branch does not carry the guard, the files of the checkout are what runs: said each time, not silent.
  const elsewhere = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; guard_text "$2"', '_', copy, join(tool, 'out.txt')], { env: { ...box.env, ORCH_CONF: join(copy, 'agents.conf'), ORCH_GUARD_TOOL_REF: 'origin/absent' }, encoding: 'utf8' });
  assert.match(elsewhere.stderr, /the guard runs from the files of this checkout/);
  // Where the lists are read is not a setting: a settings file that names a branch of a lane as the base changes nothing.
  box.git('checkout', '-q', '-b', 'dev/X-9');
  settings('[guard]\nterms = none\nallowed = none\n');
  commit('chore: a lane empties the list on its branch');
  box.git('checkout', '-q', 'main');
  writeFileSync(join(box.home, 'lane.conf'), `${readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('base = main', 'base = dev/X-9')}`);
  const { ORCH_GUARD_REF: _unused, ...noRef } = box.env;
  box.git('update-ref', 'refs/remotes/origin/main', 'main');
  box.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  writeFileSync(join(box.home, 'out.txt'), term);
  const viaSettings = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; guard_text "$2"', '_', box.home, join(box.home, 'out.txt')], { env: { ...noRef, ORCH_CONF: join(box.home, 'lane.conf') }, encoding: 'utf8' });
  assert.equal(viaSettings.status, 1, viaSettings.stderr);
  assert.match(viaSettings.stderr, /private term/);
  // « None », however it is written, is none.
  settings('[guard]\nterms = None\nallowed = NONE\n');
  commit('chore: none, in capitals');
  assert.equal(guard(term).status, 0);
});
