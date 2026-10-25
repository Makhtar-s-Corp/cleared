// The reader's effects on the host (decision 28, lane 25): a file of a
// service as its base branch holds it, read from git's objects, never from
// a folder a session writes; the ask's folder with every named service's
// base, the briefing and the read-only mark; and what a stop leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Docker } from '../../src/container/docker.ts';
import { READ_ONLY_MARK, sessionNames } from '../../src/container/session-runtime.ts';
import { ReaderError } from '../../src/reader/target.ts';
import { realReaderEffects } from '../../src/reader/workdir.ts';
import { projectCheckout } from '../../src/workspace/checkout.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { gitIn, remote, tempDir, writeFiles } from '../workspace/git.ts';
import { PAGE } from './support.ts';

const SESSION = '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b';

async function setup() {
  const url = remote({ 'src/page.ts': PAGE, 'bin/blob.dat': 'a\0b', '.env': 'TOKEN=1\n', 'svc/a.ts': 'export const a = 1;\n' });
  // A committed link: its blob holds a path, which a reader of the folder would follow.
  const seed = tempDir('seed');
  gitIn(seed, ['clone', '-q', url, 'w']);
  symlinkSync('/etc/hostname', join(seed, 'w', 'src', 'link.ts'));
  writeFiles(join(seed, 'w'), { 'NOTES.md': 'landed\n' });
  gitIn(join(seed, 'w'), ['add', '-A']);
  gitIn(join(seed, 'w'), ['commit', '-q', '-m', 'a link']);
  gitIn(join(seed, 'w'), ['push', '-q', 'origin', 'main']);
  const root = tempDir('reader');
  const project = await projectCheckout({ url, dir: join(root, 'project'), base: 'main' });
  // A change nobody landed: the reader never sees it.
  writeFiles(project.dir, { 'src/page.ts': 'not landed\n' });
  const fake = new FakeDocker();
  const effects = realReaderEffects({
    root: join(root, 'asks'),
    services: [{ name: 'guestbook', base: 'main', dir: project.dir, path: null }, { name: 'svc', base: 'main', dir: project.dir, path: 'svc' }],
    docker: new Docker(fake.runner),
  });
  return { root, project, effects, fake };
}

test('a file is read at the service\'s base, from git, and only a plain text file that is no secret', async () => {
  const { effects } = await setup();
  assert.equal(await effects.fileAt('guestbook', 'src/page.ts'), PAGE, 'the landed text, not the checkout\'s');
  assert.equal(await effects.fileAt('svc', 'a.ts'), 'export const a = 1;\n', 'a folder service reads inside its folder');
  for (const [service, path, why] of [
    ['guestbook', 'src/link.ts', 'a link'],
    ['guestbook', 'src/missing.ts', 'a missing file'],
    ['guestbook', 'src', 'a folder'],
    ['guestbook', 'bin/blob.dat', 'not text'],
    ['guestbook', '.env', 'a secret'],
    ['svc', '../src/page.ts', 'outside the folder'],
    ['billing', 'src/page.ts', 'an unknown service'],
  ] as const) await assert.rejects(effects.fileAt(service, path), (error: unknown) => error instanceof ReaderError && error.kind === 'invalid', why);
});

test('the ask\'s folder holds each named service at its base, the briefing and the mark, and is made again from scratch', async () => {
  const { root, project, effects } = await setup();
  const { dir, commits } = await effects.prepare({ id: 'ask-1', services: ['guestbook', 'svc'], briefing: '# Briefing\n' });
  assert.equal(dir, join(root, 'asks', 'ask-1'));
  const base = gitIn(project.dir, ['rev-parse', 'refs/remotes/origin/main']);
  assert.deepEqual(commits, { guestbook: base, svc: base }, 'the commit each service was exported at');
  assert.deepEqual(readdirSync(dir).sort(), ['CLAUDE.md', 'HANDOVER.md', READ_ONLY_MARK, 'guestbook', 'svc'].sort());
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# Briefing\n');
  assert.match(readFileSync(join(dir, 'HANDOVER.md'), 'utf8'), /nothing to hand over/i, 'the runner\'s Stop hook finds it, and a reader writes nothing');
  assert.equal(readFileSync(join(dir, 'guestbook', 'src', 'page.ts'), 'utf8'), PAGE);
  assert.equal(existsSync(join(dir, 'guestbook', '.git')), false);
  assert.deepEqual(readdirSync(join(dir, 'svc')), ['a.ts'], 'a folder service is its folder alone');

  const again = await effects.prepare({ id: 'ask-1', services: ['svc'], briefing: '# Again\n' });
  assert.equal(again.dir, dir);
  assert.equal(existsSync(join(dir, 'guestbook')), false, 'what the last session had is gone');
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# Again\n');
  for (const bad of ['', '../x', 'a/b', '.', '..']) await assert.rejects(effects.prepare({ id: bad, services: [], briefing: '' }), ReaderError, bad);
});

test('a citation\'s lines are counted at the commit the reader read, from git, after the base moved on', async () => {
  const { root, project, effects } = await setup();
  const { commits } = await effects.prepare({ id: 'ask-4', services: ['guestbook', 'svc'], briefing: 'x' });
  const read = commits.guestbook as string;
  // The base moves on: the page loses half its lines, and a new file lands.
  const seed = join(root, 'later');
  gitIn(root, ['clone', '-q', gitIn(project.dir, ['remote', 'get-url', 'origin']), 'later']);
  writeFiles(seed, { 'src/page.ts': 'short\n', 'src/new.ts': 'new\n' });
  gitIn(seed, ['add', '-A']);
  gitIn(seed, ['commit', '-q', '-m', 'later']);
  gitIn(seed, ['push', '-q', 'origin', 'main']);
  gitIn(project.dir, ['fetch', '-q', 'origin']);
  assert.equal(await effects.fileAt('guestbook', 'src/page.ts'), 'short\n', 'the base is the later commit now');
  assert.equal(await effects.linesAt('guestbook', read, 'src/page.ts'), 40, 'the page as the reader read it');
  assert.equal(await effects.linesAt('svc', commits.svc as string, 'a.ts'), 1, 'a folder service counts inside its folder');
  for (const [service, commit, path, why] of [
    ['guestbook', read, 'src/new.ts', 'a file landed after the reader read'],
    ['guestbook', read, 'src/link.ts', 'a link'],
    ['guestbook', read, 'src', 'a folder'],
    ['guestbook', read, 'bin/blob.dat', 'not text'],
    ['guestbook', read, '.env', 'a secret'],
    ['guestbook', read, '../x.ts', 'outside the service'],
    ['guestbook', 'main', 'src/page.ts', 'a branch, not a commit'],
    ['guestbook', 'f'.repeat(40), 'src/page.ts', 'a commit the checkout does not have'],
    ['billing', read, 'src/page.ts', 'an unknown service'],
  ] as const) await assert.rejects(effects.linesAt(service, commit, path), (error: unknown) => error instanceof ReaderError && error.kind === 'invalid', why);
});

test('a release removes the folder, the session\'s containers and its config volume, by its label', async () => {
  const { root, effects, fake } = await setup();
  const docker = new Docker(fake.runner);
  await docker.createVolume({ name: sessionNames(SESSION).volume, session: SESSION });
  await effects.prepare({ id: 'ask-2', services: ['guestbook'], briefing: 'x' });
  await effects.release({ id: 'ask-2', session: SESSION });
  assert.equal(existsSync(join(root, 'asks', 'ask-2')), false);
  assert.deepEqual(fake.volumes, []);
  assert.ok(fake.calls.length > 0, 'through the wrapper, whose label rule docker.test.ts proves')
  await effects.release({ id: 'ask-3', session: null });
});
