// Prepared images (docs/v2/milestone-5-plan.md, section 10, decision 13,
// matrix C15): per service, cleared-v2-prep-<service>:<hash>, where the hash
// covers what the base branch holds of the devcontainer file, its
// Dockerfile, the lock files and the install command, and the image it
// starts from. Built ahead with the dependencies installed outside the
// workdir's mount; built again after a merge that changes what the hash
// covers, and only then; the two newest of a service kept. Against a fake
// `docker` and temporary repositories: no Docker, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Docker, LABEL } from '../../src/container/docker.ts';
import {
  PREPARED_LABEL, PREPARED_WORKDIR, PreparedError, PreparedImages, SERVICE_LABEL, preparedAfterMerge, preparedDockerfile, preparedTag, readInputs, readRecord,
  type PreparedSource,
} from '../../src/container/prepared.ts';
import { SESSION_IMAGE } from '../../src/container/session-runtime.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import { tempDir } from '../workspace/git.ts';
import { CONF, LOCK, PACKAGE, fetched, land, project } from './prepared-fixture.ts';
import { FakeDocker } from './fake-docker.ts';

const builds = (fake: FakeDocker) => fake.calls.filter((call) => call.args[0] === 'build');
const valueOf = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];
const labelsOf = (args: readonly string[]): string[] => args.flatMap((arg, at) => (arg === '--label' ? [args[at + 1] as string] : []));

// What each build was given, read while it runs: its Dockerfile and the files of its context.
function recordBuilds(fake: FakeDocker): { dockerfile: string; context: string[]; files: Record<string, string> }[] {
  const seen: { dockerfile: string; context: string[]; files: Record<string, string> }[] = [];
  fake.intercept = (args) => {
    if (args[0] !== 'build') return undefined;
    const context = args[args.length - 1] as string;
    const file = valueOf(args, '--file') ?? join(context, 'Dockerfile');
    const names = readdirSync(context).sort();
    seen.push({ dockerfile: readFileSync(file, 'utf8'), context: names, files: Object.fromEntries(names.filter((n) => n !== 'Dockerfile' && !n.startsWith('.')).map((n) => [n, readFileSync(join(context, n), 'utf8')])) });
    return undefined;
  };
  return seen;
}

function images(fake: FakeDocker, stateDir = tempDir('prepared-state'), over: Partial<ConstructorParameters<typeof PreparedImages>[0]> = {}) {
  return new PreparedImages({ docker: new Docker(fake.runner), stateDir, ...over });
}

test('the hash covers the lock files, the install command, the devcontainer file, its Dockerfile and the image it starts from, as the base branch holds them', async () => {
  const { bare, source } = project();
  const first = await readInputs(source);
  assert.ok(first);
  assert.match(first.hash, /^[0-9a-f]{16}$/);
  assert.deepEqual(first.install, ['npm', 'ci']);
  assert.equal(first.devcontainer, 'none');
  assert.deepEqual(first.files, ['package-lock.json', 'package.json']);

  // Code, documentation and a script of package.json: the same image.
  land(bare, { 'src/index.ts': 'export const a = 1;\n', 'README.md': '# Changed\n', 'package.json': PACKAGE.replace('node --test', 'node --test test/') });
  fetched(source);
  assert.equal((await readInputs(source))?.hash, first.hash);

  // Not landed: the checkout's working tree is never read.
  writeFileSync(join(source.dir, 'package-lock.json'), LOCK('0.0.1'));
  assert.equal((await readInputs(source))?.hash, first.hash);

  const hashes = new Set([first.hash]);
  const after = async (files: Record<string, string>) => {
    land(bare, files);
    fetched(source);
    const hash = (await readInputs(source))?.hash as string;
    assert.ok(!hashes.has(hash), `a change of ${Object.keys(files).join(', ')} makes another hash`);
    hashes.add(hash);
  };
  await after({ 'package-lock.json': LOCK('8.13.2') });
  await after({ '.cleared/agents.conf': CONF('npm ci --omit=optional') });
  await after({ '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "Dockerfile" } }\n', '.devcontainer/Dockerfile': 'FROM cleared-v2-session:2.1.306\n' });
  await after({ '.devcontainer/Dockerfile': 'FROM cleared-v2-session:2.1.306\nRUN true\n' });
  const latest = await readInputs(source);
  assert.equal(latest?.devcontainer, 'dockerfile');
  assert.notEqual((await readInputs(source, { baseImage: 'cleared-v2-session:9.9.9' }))?.hash, latest?.hash, 'Cleared\'s own session image is in the hash');
});

test('a base that is not fetched has no inputs, and an install command that is not one simple command is refused', async () => {
  const { source } = project({ '.cleared/agents.conf': CONF('npm ci && curl example.invalid | sh') });
  await assert.rejects(readInputs(source), (error: unknown) => error instanceof PreparedError && /install_command/.test(error.message));
  assert.equal(await readInputs({ ...source, base: 'nowhere' }), undefined);
  assert.equal(await readInputs({ ...source, dir: join(tempDir('none'), 'absent') }), undefined);
});

test('a folder of a monorepo: its own lock files and its own settings, and the folders beside it change nothing', async () => {
  const { bare, source } = project({
    'web/package.json': PACKAGE, 'web/package-lock.json': LOCK('8.13.1'), 'web/.cleared/agents.conf': CONF('npm ci --ignore-scripts'),
    'docs/package-lock.json': LOCK('1.0.0'),
  }, 'web');
  const first = await readInputs(source);
  assert.deepEqual(first?.files, ['package-lock.json', 'package.json']);
  assert.deepEqual(first?.install, ['npm', 'ci', '--ignore-scripts']);
  land(bare, { 'docs/package-lock.json': LOCK('2.0.0'), 'package-lock.json': LOCK('9.0.0') });
  fetched(source);
  assert.equal((await readInputs(source))?.hash, first?.hash);
  land(bare, { 'web/package-lock.json': LOCK('8.13.2') });
  fetched(source);
  assert.notEqual((await readInputs(source))?.hash, first?.hash);
});

test('the Dockerfile copies the manifests outside the workdir\'s mount, runs the install command without a shell, and links node_modules where /workspace finds it', () => {
  const text = preparedDockerfile({ from: SESSION_IMAGE, files: ['package-lock.json', 'package.json'], install: ['npm', 'ci'] });
  assert.match(text, new RegExp(`^FROM ${SESSION_IMAGE.replace(/[.]/g, '\\.')}$`, 'm'));
  assert.ok(text.includes(`COPY ["package-lock.json", "package.json", "${PREPARED_WORKDIR}/"]`));
  assert.ok(text.includes(`WORKDIR ${PREPARED_WORKDIR}`));
  assert.ok(text.includes('RUN ["npm", "ci"]'));
  assert.ok(text.includes(`RUN ["ln", "-s", "${PREPARED_WORKDIR}/node_modules", "/node_modules"]`));
  assert.ok(!/COPY[^\n]*\/workspace/.test(text), 'nothing is put under the workdir, which the checkout\'s mount hides');
  assert.ok(text.trimEnd().endsWith('WORKDIR /workspace'));

  const bare = preparedDockerfile({ from: 'mcr.microsoft.com/devcontainers/base:2', files: [], install: null });
  assert.ok(!bare.includes('COPY') && !bare.includes('RUN'), 'nothing to install: the image it starts from, labelled');
  assert.throws(() => preparedDockerfile({ from: 'node:24\nRUN curl example.invalid', files: [], install: null }), PreparedError);
  assert.throws(() => preparedDockerfile({ from: SESSION_IMAGE, files: ['../etc/passwd'], install: null }), PreparedError);
  assert.throws(() => preparedDockerfile({ from: SESSION_IMAGE, files: [], install: ['npm', 'ci\nRUN true'] }), PreparedError);
});

test('ensure builds the service\'s image once per hash, labelled, with the base\'s files; a second call builds nothing', async () => {
  const fake = new FakeDocker();
  const seen = recordBuilds(fake);
  const { source } = project();
  const stateDir = tempDir('prepared-state');
  const prepared = images(fake, stateDir);
  const inputs = await readInputs(source);
  const record = await prepared.ensure(source);
  assert.equal(record.state, 'ready');
  assert.equal(record.tag, preparedTag('api', inputs?.hash as string));
  assert.equal(record.tag, `cleared-v2-prep-api:${inputs?.hash}`);
  assert.equal(typeof record.buildMs, 'number');

  const [build] = builds(fake);
  assert.ok(build);
  assert.equal(valueOf(build.args, '--tag'), record.tag);
  assert.deepEqual(labelsOf(build.args).sort(), [LABEL, `${PREPARED_LABEL}=${inputs?.hash}`, `${SERVICE_LABEL}=api`].sort());
  assert.deepEqual(seen[0]?.context, ['Dockerfile', 'package-lock.json', 'package.json']);
  assert.equal(seen[0]?.files['package-lock.json'], LOCK('8.13.1'));
  assert.match(seen[0]?.dockerfile ?? '', new RegExp(`^FROM ${SESSION_IMAGE.replace(/[.]/g, '\\.')}$`, 'm'));
  assert.equal(existsSync(valueOf(build.args, '--file') as string), false, 'the build\'s context is removed once built');

  const again = await prepared.ensure(source);
  assert.equal(again.tag, record.tag);
  assert.equal(builds(fake).length, 1, 'the same hash builds nothing');
  assert.equal(readRecord(stateDir, 'api')?.state, 'ready');
  assert.equal(readRecord(stateDir, 'api')?.dir, source.dir, 'the record names the checkout, so a session start can read the hash again');
});

test('two calls at once share one build', async () => {
  const fake = new FakeDocker();
  const { source } = project();
  const prepared = images(fake);
  const [one, two] = await Promise.all([prepared.ensure(source), prepared.ensure(source)]);
  assert.equal(one.tag, two.tag);
  assert.equal(builds(fake).length, 1);
});

test('a devcontainer naming Cleared\'s session image builds on this install\'s; another image is used as named; a Dockerfile is built first, labelled', async () => {
  for (const [named, expected] of [['cleared-v2-session:latest', SESSION_IMAGE], ['cleared-v2-session', SESSION_IMAGE], ['mcr.microsoft.com/devcontainers/javascript-node:24', 'mcr.microsoft.com/devcontainers/javascript-node:24']] as const) {
    const fake = new FakeDocker();
    const seen = recordBuilds(fake);
    const { source } = project({ '.devcontainer/devcontainer.json': `{\n  // the project's image\n  "image": "${named}",\n}\n` });
    await images(fake).ensure(source);
    assert.equal(builds(fake).length, 1, named);
    assert.match(seen[0]?.dockerfile ?? '', new RegExp(`^FROM ${expected.replace(/[.]/g, '\\.')}$`, 'm'), named);
  }

  const fake = new FakeDocker();
  const seen = recordBuilds(fake);
  const { source } = project({ '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "Dockerfile", "context": ".." } }\n', '.devcontainer/Dockerfile': 'FROM node:24\nCOPY package.json /tmp/\n' });
  const record = await images(fake).ensure(source);
  const [first, second] = builds(fake);
  assert.equal(valueOf(first?.args ?? [], '--tag'), `${record.tag}-devcontainer`);
  assert.ok(labelsOf(first?.args ?? []).includes(`${SERVICE_LABEL}=api`));
  assert.ok((valueOf(first?.args ?? [], '--file') ?? '').endsWith('/.devcontainer/Dockerfile'));
  assert.ok(seen[0]?.context.includes('package.json'), 'the devcontainer\'s context is the base\'s files');
  assert.equal(valueOf(second?.args ?? [], '--tag'), record.tag);
  assert.match(seen[1]?.dockerfile ?? '', new RegExp(`^FROM ${record.tag}-devcontainer$`, 'm'));
});

test('a build that fails is recorded with its reason, and the next call tries again', async () => {
  const fake = new FakeDocker();
  const { source } = project();
  const stateDir = tempDir('prepared-state');
  const prepared = images(fake, stateDir);
  fake.intercept = (args) => (args[0] === 'build' ? { code: 1, stdout: '', stderr: 'npm error code ERESOLVE\nnpm error more lines' } : undefined);
  await assert.rejects(prepared.ensure(source), (error: unknown) => error instanceof PreparedError && /ERESOLVE/.test(error.message));
  const failed = readRecord(stateDir, 'api');
  assert.equal(failed?.state, 'failed');
  assert.match(failed?.error ?? '', /ERESOLVE/);
  assert.ok(!(failed?.error ?? '').includes('\n'));
  fake.intercept = () => undefined;
  assert.equal((await prepared.ensure(source)).state, 'ready');
  assert.equal(builds(fake).length, 2);
});

test('a merge that changes a lock file builds again; one that does not builds nothing; a service never prepared is left alone', async () => {
  const fake = new FakeDocker();
  const { bare, source } = project();
  const other = project();
  const otherSource: PreparedSource = { ...other.source, service: 'web' };
  const prepared = images(fake);
  await prepared.ensure(source);
  const listener = preparedAfterMerge({ images: prepared, services: () => [source, otherSource], fetch: async (s) => fetched(s) });
  const merged = (): FlowEvent => ({ type: 'release_merged', at: '2026-10-25T21:00:00.000Z', project: 'demo', ticket: 't1', pr: 7 });

  land(bare, { 'src/index.ts': 'export const b = 2;\n' });
  await listener(merged());
  assert.equal(builds(fake).length, 1, 'code only: nothing built');

  await listener({ type: 'ticket_started', at: '2026-10-25T21:00:00.000Z', project: 'demo', ticket: 't1', by: 'u1', origin: null, session: 's1' });
  land(bare, { 'package-lock.json': LOCK('8.13.2') });
  await listener({ type: 'ticket_started', at: '2026-10-25T21:00:00.000Z', project: 'demo', ticket: 't2', by: 'u1', origin: null, session: 's2' });
  assert.equal(builds(fake).length, 1, 'only a merge builds');
  await listener(merged());
  assert.equal(builds(fake).length, 2, 'a lock file changed: built again');
  const tags = builds(fake).map((call) => valueOf(call.args, '--tag'));
  assert.notEqual(tags[0], tags[1]);
  assert.ok(tags.every((tag) => tag?.startsWith('cleared-v2-prep-api:')), 'web was never prepared: no build for it');
});

test('the cleanup keeps the two newest images of the service and removes nothing else', async () => {
  const fake = new FakeDocker();
  const { bare, source } = project({ '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "Dockerfile" } }\n', '.devcontainer/Dockerfile': 'FROM node:24\n' });
  // What is not this service's: another service whose name starts the same, an image named as
  // this service's without the label, and one with this service's label under another name.
  fake.images.push(
    { id: 'sha256:other', name: 'cleared-v2-prep-api-v2:0123456789abcdef', labels: { 'cleared.dev': 'v2', [SERVICE_LABEL]: 'api-v2', [PREPARED_LABEL]: '0123456789abcdef' } },
    { id: 'sha256:unlabelled', name: 'cleared-v2-prep-api:fedcba9876543210', labels: {} },
    { id: 'sha256:named', name: 'someone-else:1', labels: { 'cleared.dev': 'v2', [SERVICE_LABEL]: 'api', [PREPARED_LABEL]: 'fedcba9876543210' } },
  );
  const prepared = images(fake);
  const tags: string[] = [];
  for (const version of ['8.13.1', '8.13.2', '8.13.3']) {
    if (version !== '8.13.1') { land(bare, { 'package-lock.json': LOCK(version) }); fetched(source); }
    tags.push((await prepared.ensure(source)).tag);
  }
  const names = fake.images.map((image) => image.name).sort();
  assert.deepEqual(names, [
    'cleared-v2-prep-api-v2:0123456789abcdef', `${tags[1]}`, `${tags[1]}-devcontainer`, `${tags[2]}`, `${tags[2]}-devcontainer`,
    'cleared-v2-prep-api:fedcba9876543210', 'someone-else:1',
  ].sort());
  const removed = fake.calls.filter((call) => call.args[0] === 'image' && call.args[1] === 'rm');
  assert.equal(removed.length, 2, 'the oldest image and its devcontainer layer');
});

test('choose: the ready image; a stale one waits for its build and says so; no record is the default; a failed build falls back with its reason', async () => {
  const fake = new FakeDocker();
  const { bare, source } = project();
  const stateDir = tempDir('prepared-state');
  const prepared = images(fake, stateDir);

  const none = await prepared.choose('api');
  assert.deepEqual(none, { kind: 'default', reason: 'not_prepared', waitedMs: 0 });

  const record = await prepared.ensure(source);
  const before = builds(fake).length;
  const ready = await prepared.choose('api', () => assert.fail('a ready image is not waited for'));
  assert.deepEqual({ kind: ready.kind, image: ready.image }, { kind: 'prepared', image: record.tag });
  assert.equal(builds(fake).length, before, 'nothing built at the start');

  land(bare, { 'package-lock.json': LOCK('8.13.2') });
  fetched(source);
  let waits = 0;
  const fresh = await prepared.choose('api', () => { waits += 1; });
  assert.equal(waits, 1);
  assert.equal(fresh.kind, 'prepared');
  assert.notEqual(fresh.image, record.tag);
  assert.equal(builds(fake).length, before + 1);

  land(bare, { 'package-lock.json': LOCK('8.13.3') });
  fetched(source);
  fake.intercept = (args) => (args[0] === 'build' ? { code: 1, stdout: '', stderr: 'no space left on device' } : undefined);
  const fallback = await prepared.choose('api');
  assert.equal(fallback.kind, 'default');
  assert.equal(fallback.reason, 'build_failed');
});
