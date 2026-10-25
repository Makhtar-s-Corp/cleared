// The ready section of `cleared doctor` (docs/v2/milestone-5-plan.md,
// section 7, issue #415): read only, no build, no session, no model call.
// Each check against fakes, in French and in English; every failure says
// what to do; no line holds the forge credential or the model login, and the
// login file is never opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { READY_CHECKS, readyChecks, readyTranslator } from '../../src/doctor/ready.ts';
import type { DoctorLine } from '../../src/doctor/section.ts';
import { DOCTOR_MESSAGES_DIR } from '../../src/doctor/section.ts';
import { EGRESS_IMAGE, SESSION_IMAGE } from '../../src/container/session-runtime.ts';
import { FORGE_VALUE, GB, MODEL_VALUE, REPO, install, type Install } from './support.ts';
import { gitIn } from '../workspace/git.ts';

const run = (made: Install, language: 'en' | 'fr' = 'en') => readyChecks({ env: made.env, language, probes: made.probes() });
const byId = (lines: readonly DoctorLine[], id: string) => lines.filter((line) => line.id === id);
const one = (lines: readonly DoctorLine[], id: string): DoctorLine => {
  const found = byId(lines, id);
  assert.equal(found.length, 1, `one ${id} line: ${JSON.stringify(lines)}`);
  return found[0]!;
};
const clean = (lines: readonly DoctorLine[]) => {
  const text = JSON.stringify(lines);
  assert.ok(!text.includes(FORGE_VALUE), 'the forge credential is in no line');
  assert.ok(!text.includes(MODEL_VALUE), 'the model login is in no line');
  assert.ok(!text.includes('⟦'), `no missing word: ${text}`);
};

test('an install that is well: every check passes, in the documented order, in English and in French', async () => {
  const made = install();
  for (const language of ['en', 'fr'] as const) {
    const lines = await run(made, language);
    clean(lines);
    assert.deepEqual(lines.filter((line) => line.level !== 'ok'), [], `all ok in ${language}`);
    assert.deepEqual([...new Set(lines.map((line) => line.id))], [...READY_CHECKS]);
    assert.match(one(lines, 'docker').text, /29\.8\.1/);
    assert.match(one(lines, 'images').text, new RegExp(SESSION_IMAGE.replace(/[.]/g, '\\.')));
    assert.match(one(lines, 'repository').text, new RegExp(REPO));
  }
  const [en, fr] = [await run(made, 'en'), await run(made, 'fr')];
  assert.notEqual(one(en, 'state').text, one(fr, 'state').text, 'the words follow the language');
  assert.match(one(en, 'disk').text, /120 GB/);
  assert.match(one(fr, 'disk').text, /120\s?Go/);
});

test('read only: Docker is asked its version and labelled lists, nothing is built, made or started; GitHub is read twice', async () => {
  const made = install();
  await run(made);
  const verbs = made.docker.calls.map((call) => (['image', 'network', 'volume'].includes(call.args[0] ?? '') ? `${call.args[0]} ${call.args[1]}` : call.args[0]));
  for (const verb of verbs) assert.ok(['version', 'ps', 'image ls', 'image inspect', 'network ls', 'network inspect'].includes(verb ?? ''), `only reads: ${verb}`);
  for (const call of made.docker.calls.filter((c) => ['ps', 'ls'].includes(c.args[0] === 'ps' ? 'ps' : c.args[1] ?? ''))) assert.ok(call.args.includes('label=cleared.dev=v2'), call.args.join(' '));
  assert.deepEqual(made.github.requests.map((r) => r.path), ['/user', `/repos/${REPO}`]);
  assert.ok(made.github.requests.every((r) => r.auth === `Bearer ${FORGE_VALUE}`), 'the credential travels in the authorization header only');
});

test('every failure says what to do, in both languages, and every word exists in French', async () => {
  const en = JSON.parse(readFileSync(join(DOCTOR_MESSAGES_DIR, 'ready.en.json'), 'utf8')) as Record<string, string>;
  const fr = JSON.parse(readFileSync(join(DOCTOR_MESSAGES_DIR, 'ready.fr.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort(), 'the same keys in both catalogs');
  for (const key of Object.keys(en)) {
    assert.ok(!/token|secret|key|pass/i.test(key), `the guard reads ${key} as an assigned secret`);
    assert.ok(!/—/.test(en[key]!) && !/—/.test(fr[key]!), `no em dash in ${key}`);
  }
  const broken = install();
  broken.docker.intercept = (args) => (args[0] === 'version' ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' } : undefined);
  broken.env.GH_TOKEN = '';
  rmSync(broken.modelFile, { force: true });
  chmodSync(broken.state, 0o777);
  broken.free = GB / 2;
  for (const language of ['en', 'fr'] as const) {
    const lines = await readyChecks({ env: broken.env, language, probes: broken.probes() });
    clean(lines);
    const failed = lines.filter((line) => line.level === 'fail');
    assert.ok(failed.length >= 5, JSON.stringify(failed));
    for (const line of failed) assert.ok(line.todo && line.todo.length > 10, `${line.id} says what to do in ${language}`);
  }
  chmodSync(broken.state, 0o700);
});

test('Docker that does not answer fails with what to do, and the checks that need it are not run', async () => {
  const made = install();
  made.docker.intercept = (args) => (args[0] === 'version' ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' } : undefined);
  const lines = await run(made);
  assert.equal(one(lines, 'docker').level, 'fail');
  assert.match(one(lines, 'docker').text, /Cannot connect/);
  assert.match(one(lines, 'docker').todo ?? '', /docker/i);
  for (const id of ['labels', 'images', 'pool']) assert.equal(one(lines, id).level, 'off', id);
  assert.equal(one(lines, 'state').level, 'ok', 'the rest still runs');
});

test('a Docker whose lists ignore the label filter fails: Cleared could act on what is not its own', async () => {
  const made = install();
  made.docker.honourFilters = false;
  made.docker.containers.push({ id: 'f'.repeat(64), name: 'someone-elses', labels: {}, state: 'running' });
  made.docker.images.push({ id: `sha256:${'e'.repeat(64)}`, name: 'someone-elses-image:1', labels: {} });
  made.docker.networks.push({ id: 'd'.repeat(64), name: 'someone-elses-net', labels: {}, subnet: '10.200.0.0/24' });
  const lines = await run(made);
  assert.equal(one(lines, 'labels').level, 'fail');
  assert.ok(one(lines, 'labels').todo);
  for (const id of ['images', 'pool']) assert.equal(one(lines, id).level, 'off', `${id} waits for lists that honour the filter`);
  assert.ok(!JSON.stringify(lines).includes('someone-elses'), 'no other object is named');
});

test('a missing image is named, and the install that builds it is what to do', async () => {
  const made = install();
  made.docker.images.splice(made.docker.images.findIndex((image) => image.name === EGRESS_IMAGE), 1);
  const lines = await run(made);
  assert.equal(one(lines, 'images').level, 'fail');
  assert.match(one(lines, 'images').text, new RegExp(EGRESS_IMAGE.replace(/[.]/g, '\\.')));
  assert.ok(!one(lines, 'images').text.includes(SESSION_IMAGE));
  assert.match(one(lines, 'images').todo ?? '', /compose -f v2\/compose\.yaml run --rm install/);
});

test('the address pool: fewer than two free subnets fails, counted from the daemon\'s pools and the labelled networks', async () => {
  const made = install();
  const probes = { ...made.probes(), daemonConfig: () => JSON.stringify({ 'default-address-pools': [{ base: '10.99.0.0/23', size: 24 }] }) };
  made.docker.networks.push({ id: 'a'.repeat(64), name: 'cleared-v2-net', labels: { 'cleared.dev': 'v2' }, subnet: '10.99.0.0/24' });
  const lines = await readyChecks({ env: made.env, language: 'en', probes });
  assert.equal(one(lines, 'pool').level, 'fail');
  assert.match(one(lines, 'pool').text, /\b1\b/);
  assert.ok(one(lines, 'pool').todo);
  made.docker.networks.length = 0;
  const freed = await readyChecks({ env: made.env, language: 'en', probes });
  assert.equal(one(freed, 'pool').level, 'ok');
});

test('the state folder: missing, unset, another account\'s, or open to others\' writes fails; readable by others is said', async () => {
  const made = install();
  chmodSync(made.state, 0o757);
  assert.equal(one(await run(made), 'state').level, 'fail');
  assert.match(one(await run(made), 'state').todo ?? '', /chmod go-w/);
  chmodSync(made.state, 0o755);
  assert.equal(one(await run(made), 'state').level, 'notice');
  chmodSync(made.state, 0o700);
  const other = await readyChecks({ env: made.env, language: 'en', probes: { ...made.probes(), uid: () => 4242 } });
  assert.equal(one(other, 'state').level, 'fail');
  const missing = { ...made.env, CLEARED_STATE_DIR: join(made.root, 'nowhere'), CLEARED_V2_STATE_DIR: join(made.root, 'nowhere') };
  const lines = await readyChecks({ env: missing, language: 'en', probes: made.probes() });
  assert.equal(one(lines, 'state').level, 'fail');
  assert.equal(one(lines, 'disk').level, 'off', 'no folder, no disk to measure');
  const unset = { ...made.env, CLEARED_STATE_DIR: '', CLEARED_V2_STATE_DIR: '', ORCH_STATE_DIR: '', ORCH_LEDGER: '', CLEARED_REPO: '' };
  assert.equal(one(await readyChecks({ env: unset, language: 'en', probes: made.probes() }), 'state').level, 'fail');
});

test('disk space: under 5 GB fails, under 20 GB is said, sizes as a person reads them', async () => {
  const made = install();
  made.free = 3.5 * GB;
  const low = one(await run(made), 'disk');
  assert.equal(low.level, 'fail');
  assert.match(low.text, /3\.5 GB/);
  assert.match(one(await run(made, 'fr'), 'disk').text, /3,5\s?Go/);
  made.free = 12 * GB;
  assert.equal(one(await run(made), 'disk').level, 'notice');
  made.free = 20 * GB;
  assert.equal(one(await run(made), 'disk').level, 'ok');
});

test('the settings file: none is said, open to others is said, a file it names for a variable that is refused fails by its variable, never by its value', async () => {
  const made = install();
  const settings = join(made.state, 'settings.conf');
  chmodSync(settings, 0o644);
  assert.equal(one(await run(made), 'settings').level, 'notice');
  chmodSync(settings, 0o600);
  chmodSync(made.forgeFile, 0o644);
  const lines = await run(made);
  clean(lines);
  const refused = byId(lines, 'credentials').find((line) => line.level === 'fail');
  assert.ok(refused, JSON.stringify(lines));
  assert.match(refused.text, /GH_TOKEN/);
  assert.match(refused.todo ?? '', /chmod 600/);
  chmodSync(made.forgeFile, 0o600);
  rmSync(settings);
  const none = byId(await run(made), 'settings');
  assert.deepEqual(none.map((line) => line.level), ['notice']);
});

test('the model login: looked at, never opened; missing or empty fails with the assistant\'s step, readable by others is said', async () => {
  const made = install();
  assert.equal(one(await run(made), 'model').level, 'ok', 'a file no one may read is present: the doctor only looks at it');
  chmodSync(made.modelFile, 0o644);
  const open = one(await run(made), 'model');
  assert.equal(open.level, 'notice');
  assert.match(open.todo ?? open.text, /chmod 600/);
  writeFileSync(made.modelFile, '');
  assert.equal(one(await run(made), 'model').level, 'fail');
  rmSync(made.modelFile);
  const missing = one(await run(made), 'model');
  assert.equal(missing.level, 'fail');
  assert.match(missing.todo ?? '', /setup-token/);
  const named = join(made.root, 'elsewhere.json');
  writeFileSync(named, '{}', { mode: 0o600 });
  assert.equal(one(await readyChecks({ env: { ...made.env, CLEARED_CLAUDE_CREDENTIALS: named }, language: 'en', probes: made.probes() }), 'model').level, 'ok', 'CLEARED_CLAUDE_CREDENTIALS wins, as the adapter reads it');
});

test('the forge: no credential, refused, forbidden or no answer each fail apart, and the repositories are then not checked', async () => {
  const made = install();
  made.env.GH_TOKEN = '';
  const none = await run(made);
  assert.equal(one(none, 'forge').level, 'fail');
  assert.equal(one(none, 'repository').level, 'off');
  assert.equal(made.github.requests.length, 0, 'nothing is asked of GitHub without a credential');
  made.env.GH_TOKEN = FORGE_VALUE;
  const texts: string[] = [];
  for (const [answer, word] of [[{ status: 401 }, /401/], [{ status: 403 }, /403/], ['silent', /15\s?s/]] as const) {
    made.github.user = answer;
    const lines = await run(made);
    clean(lines);
    assert.equal(one(lines, 'forge').level, 'fail');
    assert.match(one(lines, 'forge').text, word);
    assert.ok(one(lines, 'forge').todo);
    assert.equal(one(lines, 'repository').level, 'off');
    texts.push(one(lines, 'forge').text);
  }
  assert.equal(new Set(texts).size, 3, 'each said apart');
  made.env.GITHUB_TOKEN = FORGE_VALUE;
  made.env.GH_TOKEN = '';
  made.github.user = { status: 200, body: {} };
  assert.equal(one(await run(made), 'forge').level, 'ok', 'GITHUB_TOKEN, as gh reads it');
});

test('each repository of the workspace: not seen or read only fails, rights GitHub does not say are said', async () => {
  const made = install();
  made.github.repos.set(REPO, { status: 404 });
  assert.equal(one(await run(made), 'repository').level, 'fail');
  made.github.repos.set(REPO, { status: 200, body: { permissions: { push: false, pull: true } } });
  const read = one(await run(made), 'repository');
  assert.equal(read.level, 'fail');
  assert.match(read.todo ?? '', /Contents/);
  made.github.repos.set(REPO, { status: 200, body: {} });
  assert.equal(one(await run(made), 'repository').level, 'notice');
});

test('the checkouts: none yet is said, another repository, no base or not a checkout fails; nothing is fetched', async () => {
  const made = install();
  const before = gitIn(made.checkout, ['for-each-ref', '--format=%(refname) %(objectname)']);
  assert.equal(one(await run(made), 'checkout').level, 'ok');
  assert.equal(gitIn(made.checkout, ['for-each-ref', '--format=%(refname) %(objectname)']), before, 'no ref moved');
  const noWorkspace = { ...made.env, CLEARED_V2_PROJECT: '' };
  const none = await readyChecks({ env: noWorkspace, language: 'en', probes: made.probes() });
  assert.equal(one(none, 'checkout').level, 'notice');
  assert.equal(one(none, 'repository').level, 'off', 'said once, by the checkout line');
  const refused = await readyChecks({ env: { ...made.env, CLEARED_V2_REPO: 'not a repo' }, language: 'en', probes: made.probes() });
  assert.equal(one(refused, 'checkout').level, 'fail');
  assert.equal(one(await readyChecks({ env: { ...made.env, CLEARED_V2_BASE: 'release' }, language: 'en', probes: made.probes() }), 'checkout').level, 'fail');
  const other = { ...made.env, CLEARED_V2_REPO_URL: join(made.root, 'other.git') };
  assert.equal(one(await readyChecks({ env: other, language: 'en', probes: made.probes() }), 'checkout').level, 'fail');
  const absent = { ...made.env, CLEARED_V2_PROJECT_DIR: join(made.root, 'not-yet') };
  assert.equal(one(await readyChecks({ env: absent, language: 'en', probes: made.probes() }), 'checkout').level, 'notice', 'the first ticket clones it');
  const plain = join(made.root, 'plain');
  mkdirSync(plain);
  assert.equal(one(await readyChecks({ env: { ...made.env, CLEARED_V2_PROJECT_DIR: plain }, language: 'en', probes: made.probes() }), 'checkout').level, 'fail');
});

test('the translator falls back to English for a word French lacks, and the section has a title in both languages', () => {
  assert.notEqual(readyTranslator('en')('section_title'), readyTranslator('fr')('section_title'));
});
