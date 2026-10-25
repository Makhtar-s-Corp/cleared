// The doctor's images section (docs/v2/milestone-5-plan.md, section 10,
// matrix C15): each service's prepared image, said ready with its age and
// its build's time, missing, stale, building or failed with what to do;
// then a session started on the newest ready image, the time to its
// container's first answer measured against the 10-second target, and every
// object of it removed by label. Not run by default: it starts a container.
// Against a fake `docker` and temporary repositories, in both languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Docker } from '../../src/container/docker.ts';
import { PreparedImages } from '../../src/container/prepared.ts';
import images, { imagesChecks } from '../../src/doctor/sections/images.ts';
import { tempDir } from '../workspace/git.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { LOCK, fetched, land, project } from '../container/prepared-fixture.ts';

const NOW = new Date('2026-10-25T12:00:00.000Z');

// A workspace of four services: api prepared, web never, jobs prepared then
// moved by a merge, old whose build failed.
async function install() {
  const state = tempDir('doctor-images');
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  const services = { api: project({}, null, 'api'), web: project({}, null, 'web'), jobs: project({}, null, 'jobs'), old: project({}, null, 'old') };
  const at = { value: new Date('2026-10-25T09:00:00.000Z') };
  const prepared = new PreparedImages({ docker, stateDir: state, now: () => at.value });
  await prepared.ensure(services.api.source);
  await prepared.ensure(services.jobs.source);
  land(services.jobs.bare, { 'package-lock.json': LOCK('8.13.2') });
  fetched(services.jobs.source);
  fake.intercept = (args) => (args[0] === 'build' ? { code: 1, stdout: '', stderr: 'npm error code ERESOLVE' } : undefined);
  await prepared.ensure(services.old.source).catch(() => undefined);
  fake.intercept = () => undefined;
  const file = join(state, 'workspace.conf');
  writeFileSync(file, ['[workspace]', 'id = demo', ...Object.entries(services).flatMap(([name, made]) => [
    `[service ${name}]`, `repository = example-org/${name}`, `url = ${made.bare}`, `dir = ${made.dir}`,
  ])].join('\n') + '\n');
  return { fake, docker, state, env: { CLEARED_V2_STATE_DIR: state, CLEARED_V2_WORKSPACE: file } as NodeJS.ProcessEnv };
}

// A clock that moves 2.4 seconds between the start and the first answer.
const clock = () => {
  let at = 1_000;
  return () => { const now = at; at += 2_400; return now; };
};

test('the section is named as its file, is not run by default, and has a title in both languages', () => {
  assert.equal(images.name, 'images');
  assert.equal(images.byDefault, false);
  assert.match(images.title('en'), /^images/);
  assert.match(images.title('fr'), /^images/);
  assert.notEqual(images.title('en'), images.title('fr'));
});

test('no workspace yet: a notice, and no session started', async () => {
  const fake = new FakeDocker();
  const lines = await imagesChecks({ env: { CLEARED_V2_STATE_DIR: tempDir('doctor-images') }, language: 'en', docker: new Docker(fake.runner), now: () => NOW, clock: clock() });
  assert.deepEqual(lines.map((line) => [line.id, line.level]), [['workspace', 'notice'], ['start', 'off']]);
  assert.ok(lines[0]?.todo);
  assert.equal(fake.calls.filter((call) => call.args[0] === 'create').length, 0);
});

test('each service\'s image is said, then a session on the newest ready one is timed and removed', async () => {
  for (const language of ['en', 'fr'] as const) {
    const made = await install();
    const before = made.fake.calls.length;
    const lines = await imagesChecks({ env: made.env, language, docker: made.docker, now: () => NOW, clock: clock() });
    const by = Object.fromEntries(lines.filter((line) => line.id === 'image').map((line) => [line.text.split(/[ :]/)[0], line]));
    assert.deepEqual(Object.keys(by).sort(), ['api', 'jobs', 'old', 'web'], language);
    assert.equal(by.api?.level, 'ok');
    assert.match(by.api?.text ?? '', /cleared-v2-prep-api:[0-9a-f]{16}/);
    assert.match(by.api?.text ?? '', language === 'en' ? /3\s?h ago/ : /il y a 3\s?h/, 'its age as a person reads it');
    assert.equal(by.web?.level, 'notice');
    assert.ok(by.web?.todo);
    assert.equal(by.jobs?.level, 'notice', 'a merge moved what it holds: built again at the next merge or start');
    assert.equal(by.old?.level, 'fail');
    assert.match(by.old?.text ?? '', /ERESOLVE/);
    assert.ok(by.old?.todo);

    const start = lines.find((line) => line.id === 'start');
    assert.equal(start?.level, 'ok', language);
    assert.match(start?.text ?? '', /2\s?s/, 'the measure, in seconds');
    assert.match(start?.text ?? '', /10\s?s/, 'the target');
    for (const line of lines) assert.doesNotMatch(`${line.text} ${line.todo ?? ''}`, /\d\s?ms\b/, 'no figure in milliseconds');

    const created = made.fake.calls.slice(before).filter((call) => call.args[0] === 'create');
    assert.ok(created.some((call) => call.args.includes(lines.find((l) => l.level === 'ok' && l.id === 'image')?.text.match(/cleared-v2-prep-\S+:[0-9a-f]{16}/)?.[0] ?? '?')), 'the session ran the prepared image');
    assert.ok(created.every((call) => call.args.includes('cleared.dev=v2')));
    assert.ok(!made.fake.calls.slice(before).some((call) => call.args[0] === 'build'), 'the doctor builds nothing');
    assert.deepEqual([made.fake.containers.length, made.fake.networks.length, made.fake.volumes.length], [0, 0, 0], 'everything the measure made is removed');
  }
});

test('a session that does not start is a failure with what to do, and nothing is left', async () => {
  const made = await install();
  made.fake.intercept = (args) => (args[0] === 'network' && args[1] === 'create' ? { code: 1, stdout: '', stderr: 'all predefined address pools have been fully subnetted' } : undefined);
  const lines = await imagesChecks({ env: made.env, language: 'fr', docker: made.docker, now: () => NOW, clock: clock() });
  const start = lines.find((line) => line.id === 'start');
  assert.equal(start?.level, 'fail');
  assert.match(start?.text ?? '', /address pools/);
  assert.ok(start?.todo);
  assert.deepEqual([made.fake.containers.length, made.fake.networks.length], [0, 0]);
});
