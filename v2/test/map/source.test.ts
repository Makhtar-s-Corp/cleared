// A service's files as its base branch holds them (section 11.3): read from
// git's objects at refs/remotes/origin/<base> of the service's own checkout,
// never its working tree; plain text files within the caps; a folder of a
// monorepo read alone. And the same rules on a folder of the disk, which the
// app's fixtures and the examples' test read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAP_CAPS, baseCommit, readFolder, readService } from '../../src/map/source.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function write(dir: string, files: Record<string, string | Buffer>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

// A repository pushed to a bare origin, then cloned: the clone is the service's checkout.
function repository(root: string, name: string, files: Record<string, string | Buffer>, links: Record<string, string> = {}) {
  const work = join(root, `${name}-work`);
  const origin = join(root, `${name}.git`);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  write(work, files);
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(join(work, path, '..'), { recursive: true });
    symlinkSync(target, join(work, path));
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  const checkout = join(root, name);
  git(root, 'clone', '-q', origin, checkout);
  const push = (more: Record<string, string>) => {
    write(work, more);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'more');
    git(work, 'push', '-q', 'origin', 'main');
  };
  return { checkout, push };
}

const service = (dir: string, more: Partial<Parameters<typeof readService>[0]> = {}) => ({ name: 'guestbook', base: 'main', dir, path: null, contract: null, ...more });

test('the base branch is read: a change of the working tree or an unpushed commit is not seen', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'map-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { checkout } = repository(root, 'guestbook', {
    'src/filter.ts': 'await fetch(`${base}/check`);\n',
    'test/fake.ts': 'serve("/check");\n',
    '.cleared/agents.conf': '[session]\nservices = postgres:16\n',
    'package.json': '{"dependencies":{"pg":"8.0.0"}}\n',
    'README.md': '# Guestbook\n',
  });
  write(checkout, { 'src/filter.ts': 'changed in the working tree\n', 'src/local.ts': 'not committed\n' });
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'local only');
  const read = await readService(service(checkout));
  assert.match(read.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(read.commit, await baseCommit(service(checkout)));
  assert.deepEqual(read.files, [{ path: 'src/filter.ts', text: 'await fetch(`${base}/check`);\n' }]);
  assert.equal(read.conf, '[session]\nservices = postgres:16\n');
  assert.equal(read.packageJson, '{"dependencies":{"pg":"8.0.0"}}\n');
  assert.deepEqual(read.problems, []);
});

test('a new commit on the base, once fetched, moves the base commit and is read', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'map-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { checkout, push } = repository(root, 'guestbook', { 'src/a.ts': 'export const a = 1;\n' });
  const before = await baseCommit(service(checkout));
  push({ 'src/b.ts': 'export const b = 2;\n' });
  assert.equal(await baseCommit(service(checkout)), before, 'not fetched yet: the same base');
  git(checkout, 'fetch', '-q', 'origin');
  const read = await readService(service(checkout));
  assert.notEqual(read.commit, before);
  assert.deepEqual(read.files.map((file) => file.path), ['src/a.ts', 'src/b.ts']);
});

test('a link, a file over the size cap, a binary file are not read; past the count cap the read says it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'map-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { checkout } = repository(root, 'guestbook', {
    'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n',
    'src/big.ts': `${'x'.repeat(MAP_CAPS.fileBytes)}\n`,
    'src/bin.ts': Buffer.from([0x61, 0x00, 0x62]),
  }, { 'src/link.ts': '/etc/hostname' });
  const read = await readService(service(checkout));
  assert.deepEqual(read.files.map((file) => file.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(read.problems, []);
  const capped = await readService(service(checkout), { ...MAP_CAPS, files: 2 });
  assert.deepEqual(capped.files.map((file) => file.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(capped.problems, ['capped']);
});

test('a folder of a monorepo is read alone, its paths inside it, its contract and its own agents.conf', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'map-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { checkout } = repository(root, 'mono', {
    'api/src/server.ts': 'export {};\n',
    'api/contract/openapi.yaml': 'openapi: 3.1.0\n',
    'api/.cleared/agents.conf': '[session]\nservices = mysql:8\n',
    'web/src/client.ts': 'await fetch(`${API}/items`);\n',
  });
  const read = await readService(service(checkout, { name: 'api', path: 'api', contract: { path: 'contract/openapi.yaml' } }));
  assert.deepEqual(read.files.map((file) => file.path), ['src/server.ts']);
  assert.equal(read.contract, 'openapi: 3.1.0\n');
  assert.equal(read.conf, '[session]\nservices = mysql:8\n');
});

test('a service not fetched yet has no commit and says so', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'map-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const read = await readService(service(join(root, 'absent')));
  assert.deepEqual([read.commit, read.files, read.problems], [null, [], ['not_fetched']]);
  assert.equal(await baseCommit(service(join(root, 'absent'))), null);
});

test('a folder of the disk is read by the same rules, without its links', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'map-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, { 'src/a.ts': 'a\n', 'test/a.test.ts': 'x\n', 'node_modules/pg/index.js': 'x\n', 'contract/events.json': '{}\n' });
  symlinkSync('/etc/hostname', join(root, 'src/link.ts'));
  const read = readFolder(root, { name: 'catalogue', contract: { format: 'events', path: 'contract/events.json' } });
  assert.deepEqual([read.commit, read.files.map((file) => file.path), read.contract, read.problems], [null, ['src/a.ts'], '{}\n', []]);
});
