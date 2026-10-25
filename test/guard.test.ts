import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.ts';
import { route } from '../lib/route.ts';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.ts';
import { conf, scratch, fixtureProject, sandbox, laneWithRemote, task, first } from './support.ts';





test('[Linear adapter] a comment that the guard refuses never reaches tracker', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const called = ${JSON.stringify(join(dir, 'called'))};
fs.closeSync(fs.openSync(called, 'a'));
fs.utimesSync(called, new Date(), new Date());
process.stdout.write('{"data":{"issue":{"id":"i"},"commentCreate":{"success":true,"comment":{"id":"c","url":"u"}}}}\\n');
`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') };
  const post = (text: string) => {
    writeFileSync(join(dir, 'comment.md'), text);
    return spawnSync(join(ORCH_HOME, 'tracker.ts'), ['comment', 'X-1', join(dir, 'comment.md'), 'test'], { env, encoding: 'utf8' });
  };
  // Built at run time so that this file holds nothing the guard would flag.
  const flagged = `Le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}" est dans le rapport.`;
  const refused = post(flagged);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not sent/);
  assert.throws(() => readFileSync(join(dir, 'called')), 'the network was reached');
  // A ticket goes through the same guard, title and description.
  const open = (title: string, text: string) => {
    writeFileSync(join(dir, 'ticket.md'), text);
    return spawnSync(join(ORCH_HOME, 'tracker.ts'), ['create', 'Projet', 'Bug', title, join(dir, 'ticket.md')], { env, encoding: 'utf8' });
  };
  assert.notEqual(open('Un titre', flagged).status, 0);
  assert.notEqual(open(flagged, 'Une description.').status, 0);
  assert.throws(() => readFileSync(join(dir, 'called')), 'the network was reached');
  const sent = post('Fait : rien. Reste à faire : rien.');
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.stdout.trim(), 'u');
});







test('[Linear adapter] only an image, and only from the folder a lane sets apart for what may leave, may be sent to tracker', () => {
  const dir = scratch('orch-tracker-');
  const captures = join(dir, 'lanes', 'a-lane', 'to-send');
  mkdirSync(captures, { recursive: true });
  mkdirSync(join(dir, 'lanes', 'a-lane', 'deeper', 'to-send'), { recursive: true });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of the image')]);
  writeFileSync(join(captures, 'apres.png'), png);
  writeFileSync(join(captures, 'secret.png'), 'TOKEN=not-an-image\n');
  writeFileSync(join(dir, 'elsewhere.png'), png);
  writeFileSync(join(dir, 'lanes', 'a-lane', 'test-results.png'), png);
  writeFileSync(join(dir, 'lanes', 'a-lane', 'deeper', 'to-send', 'apres.png'), png);
  writeFileSync(join(dir, 'curl'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'curl-args'))}, args.map((arg) => arg + '\\n').join(''));
if (!(' ' + args.join(' ') + ' ').includes(' PUT ')) {
  try { fs.readFileSync(0); } catch { /* no input */ }
  process.stdout.write('{"data":{"fileUpload":{"success":true,"uploadFile":{"uploadUrl":"https://storage.example.test/put","assetUrl":"https://uploads.example.test/asset","headers":[{"key":"x-goog-content-length-range","value":"25,25"}]}}}}\\n');
}
`, { mode: 0o755 });
  const confPath = join(dir, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').replace(/^capture_roots = .*$/m, `capture_roots = ${join(dir, 'lanes')}/*/to-send`)}`);
  const repoRoot = fixtureProject();
  const upload = (file: string) => spawnSync(join(ORCH_HOME, 'tracker.ts'), ['upload', file], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state'), ORCH_CONF: confPath } });
  const sent = () => { try { return readFileSync(join(dir, 'curl-args'), 'utf8'); } catch { return ''; } };
  assert.match(upload(join(dir, 'elsewhere.png')).stderr, /not under a folder of captures/);
  assert.match(upload(join(captures, '..', 'to-send', '..', 'test-results.png')).stderr, /not under a folder of captures/);
  // The rest of a lane's worktree (its test results, the images of the repository) does not leave: only that one folder, at that one place.
  assert.match(upload(join(dir, 'lanes', 'a-lane', 'test-results.png')).stderr, /not under a folder of captures/);
  assert.match(upload(join(dir, 'lanes', 'a-lane', 'deeper', 'to-send', 'apres.png')).stderr, /not under a folder of captures/);
  assert.match(readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8'), /^capture_roots = ~\/work\/example\/\.local\/captures-tracker, ~\/work\/example\/\.local\/captures-tracker\/\*, ~\/work\/example-lanes\/example\/\*\/\.local\/captures-tracker$/m);
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
  const guard = (text: string, extra: NodeJS.ProcessEnv = {}) => {
    const file = join(box.home, 'out.txt');
    writeFileSync(file, text);
    return spawnSync(join(box.home, 'lib', 'tracker', 'guard.ts'), [file], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  };
  const term = 'Le contrat avec Zorglub Industries est signé.\n';
  const commit = (message: string) => { box.git('add', '-A'); box.git('commit', '-q', '-m', message); };
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
  const settings = (text: string) => writeFileSync(join(box.repo, '.cleared', 'agents.conf'), `${text}\n[guard]\nsalt = cleared-example-only\n`);
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
  const inTool = (...args: string[]) => execFileSync('git', ['-C', copy, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  inTool('checkout', '-q', '-b', 'main');
  inTool('add', '.');
  inTool('commit', '-q', '-m', 'the tool');
  inTool('push', '-q', 'origin', 'main');
  settings('[guard]\nsalt = cleared-example-only\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n');
  commit('chore: the lists again');
  const fromCopy = (text: string) => {
    const file = join(tool, 'out.txt');
    writeFileSync(file, text);
    return spawnSync(join(copy, 'lib', 'tracker', 'guard.ts'), [file], { env: { ...box.env, ORCH_CONF: join(copy, 'agents.conf'), ORCH_GUARD_TOOL_REF: 'origin/main' }, encoding: 'utf8' });
  };
  assert.match(fromCopy(term).stderr, /private term/);
  writeFileSync(join(copy, 'lib', 'guard', 'codex-guard.ts'), 'process.exit(0);\n');
  const edited = fromCopy(term);
  assert.equal(edited.status, 1, 'the guard that runs is the one of the branch the tool follows');
  assert.match(edited.stderr, /private term/);
  // When that branch does not carry the guard, the files of the checkout are what runs: said each time, not silent.
  const elsewhere = spawnSync(join(copy, 'lib', 'tracker', 'guard.ts'), [join(tool, 'out.txt')], { env: { ...box.env, ORCH_CONF: join(copy, 'agents.conf'), ORCH_GUARD_TOOL_REF: 'origin/absent' }, encoding: 'utf8' });
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
  const viaSettings = spawnSync(join(box.home, 'lib', 'tracker', 'guard.ts'), [join(box.home, 'out.txt')], { env: { ...noRef, ORCH_CONF: join(box.home, 'lane.conf') }, encoding: 'utf8' });
  assert.equal(viaSettings.status, 1, viaSettings.stderr);
  assert.match(viaSettings.stderr, /private term/);
  // « None », however it is written, is none.
  settings('[guard]\nterms = None\nallowed = NONE\n');
  commit('chore: none, in capitals');
  assert.equal(guard(term).status, 0);
});
