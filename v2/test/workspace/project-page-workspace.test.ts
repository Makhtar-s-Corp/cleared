// The project page per service of a workspace (issue #394, P59, P240, P241):
// the two example services of this repository, examples/guestbook and
// examples/filter-api, as examples/workspace.conf names them, first as two
// repositories, then as two folders of one. Every repository is a local bare
// one in a temporary folder, seeded from the examples' tracked files: no
// account, no network, nothing pushed beyond those folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { realEffects } from '../../src/flow/effects.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { CONFIG } from '../flow/support.ts';
import { commit, remote, tempDir } from './git.ts';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', 'examples');

// The tracked files of one example, the lock file left out (its size says
// nothing a page shows).
function example(name: string, under = ''): Record<string, string> {
  const dir = join(EXAMPLES, name);
  const files: Record<string, string> = {};
  for (const path of execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))
    if (!path.endsWith('package-lock.json')) files[`${under}${path}`] = readFileSync(join(dir, path), 'utf8');
  return files;
}

type Shape = 'repositories' | 'folders';

// The workspace of examples/workspace.conf: the guestbook first, consuming
// the filter API, which provides its OpenAPI contract.
function workspace(shape: Shape) {
  const root = tempDir(`page-${shape}`);
  const state = join(root, 'state');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: state };
  delete env.ORCH_LEDGER;
  const mono = shape === 'folders'
    ? remote({ ...example('guestbook', 'guestbook/'), ...example('filter-api', 'filter-api/'), 'README.md': '# Examples\n\nThe two example services, one folder each.\n', '.cleared/agents.conf': readFileSync(join(EXAMPLES, 'guestbook', '.cleared', 'agents.conf'), 'utf8') })
    : null;
  const service = (name: string, more: Partial<ServiceConfig>): ServiceConfig => ({
    name, kind: mono ? 'folder' : 'repository', repo: `example-org/cleared-example-${name}`, url: mono ?? remote(example(name)), base: 'main',
    path: mono ? name : null, dir: join(root, 'services', name, 'checkout'),
    healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, ...more,
  });
  const guestbook = service('guestbook', { consumes: ['filter-api'] });
  const filter = service('filter-api', { contract: { format: 'openapi', path: mono ? 'filter-api/contract/openapi.yaml' : 'contract/openapi.yaml' } });
  const ws: WorkspaceConfig = { id: 'guestbook', name: 'Guestbook and filter API', services: [guestbook, filter], file: join(root, 'workspace.conf') };
  const config = { ...CONFIG, projectDir: guestbook.dir, repoUrl: guestbook.url, workdirRoot: join(root, 'work'), workspace: ws };
  return { root, state, guestbook, filter, flow: realEffects(config, { env }) };
}

const pageOf = (state: string, name: string) => join(state, 'pages', `${name}.md`);
const read = (state: string, name: string) => readFileSync(pageOf(state, name), 'utf8');
// Each write renames a new file over the page (issue #360): an unchanged
// inode says the page was not written.
const inodeOf = (state: string, name: string) => statSync(pageOf(state, name)).ino;

// What a merge does to the forge: a commit on the base branch of `url`.
function merged(root: string, url: string, files: Record<string, string>, message: string): void {
  const dir = join(root, `forge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  execFileSync('git', ['clone', '-q', '-b', 'main', url, dir], { stdio: 'ignore' });
  commit(dir, files, message);
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });
}

const ticketOn = (name: string): Ticket => ({
  id: 'LOCAL-3', title: 'Count the entries', body: 'Say how many.', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x',
  services: [{ name, branch: 'cleared/LOCAL-3', pr: null, state: 'open' as const }],
});

// Every file under the state folder, to look for a secret anywhere in it.
function everyText(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? everyText(path) : statSync(path).size < 5_000_000 ? readFileSync(path, 'utf8') : '';
  }).join('\n');
}

// The guestbook's page says the guestbook, the filter API's the filter API.
function ownPages(state: string, shape: Shape) {
  const guestbook = read(state, 'guestbook');
  const filter = read(state, 'filter-api');
  const at = shape === 'folders' ? { guestbook: 'guestbook/', filter: 'filter-api/' } : { guestbook: '', filter: '' };
  assert.match(guestbook, /# Project page: guestbook/);
  assert.match(guestbook, /Package: cleared-example-guestbook/);
  assert.match(guestbook, /A web page that lists guestbook entries and adds one/);
  assert.ok(guestbook.includes(`\`${at.guestbook}src/page.ts\``), 'the guestbook\'s own files');
  assert.match(guestbook, /npm run typecheck/);
  assert.ok(!guestbook.includes('cleared-example-filter-api') && !guestbook.includes('words.ts'), 'nothing of the filter API but its name');
  assert.match(filter, /# Project page: filter-api/);
  assert.match(filter, /Package: cleared-example-filter-api/);
  assert.match(filter, /tells whether a text holds a word of its list/);
  assert.ok(filter.includes(`\`${at.filter}src/words.ts\``), 'the filter API\'s own files');
  assert.ok(!filter.includes('cleared-example-guestbook') && !filter.includes('src/page.ts'), 'nothing of the guestbook');
  for (const page of [guestbook, filter]) assert.ok(Buffer.byteLength(page) <= 8 * 1024, 'at most 8 KiB');
  return { guestbook, filter };
}

test('two repository services: the first connection of each makes its own page, with where it sits in the workspace (P241)', async () => {
  const { state, guestbook, filter, flow } = workspace('repositories');
  await flow.refreshProject(guestbook);
  assert.ok(existsSync(pageOf(state, 'guestbook')), 'the guestbook\'s page from its first fetch');
  assert.ok(!existsSync(pageOf(state, 'filter-api')), 'the filter API is not connected yet');
  await flow.refreshProject(filter);
  const pages = ownPages(state, 'repositories');
  assert.match(pages.guestbook, /Consumes: `filter-api`\./);
  assert.doesNotMatch(pages.guestbook, /Provides the contract/);
  assert.match(pages.filter, /Provides the contract `contract\/openapi\.yaml` \(openapi\)\./);
  assert.doesNotMatch(pages.filter, /Consumes:/);
});

test('two repository services: a session on the consumer connects its provider, and each service is briefed on its own page', async () => {
  const { state, guestbook, filter, flow } = workspace('repositories');
  const consumer = await flow.prepareWorkdir({ ticket: ticketOn('guestbook'), role: 'author', service: guestbook });
  assert.ok(existsSync(pageOf(state, 'filter-api')), 'the provider fetched for the contract has its page too');
  const own = readFileSync(join(consumer.workdir, 'CLAUDE.md'), 'utf8');
  assert.match(own, /## Generated page of the service guestbook\n/);
  assert.match(own, / {4}\| .*A web page that lists guestbook entries/);
  assert.ok(!own.includes('Generated page of the service filter-api'));
  assert.match(consumer.briefing.projectPage, /Project page: guestbook/, 'the guestbook commits no page: the generated one is the contract\'s');
  const provider = await flow.prepareWorkdir({ ticket: ticketOn('filter-api'), role: 'author', service: filter });
  const text = readFileSync(join(provider.workdir, 'CLAUDE.md'), 'utf8');
  assert.match(text, /## Generated page of the service filter-api\n/);
  assert.match(text, / {4}\| .*tells whether a text holds a word/);
  assert.ok(!text.includes('Generated page of the service guestbook'));
  const reviewer = await flow.prepareWorkdir({ ticket: { ...ticketOn('filter-api'), status: 'In Review' }, role: 'reviewer', service: filter });
  assert.match(readFileSync(join(reviewer.workdir, 'CLAUDE.md'), 'utf8'), /## Generated page of the service filter-api\n/, 'the reviewer too');
});

test('two repository services: a merge on one makes its page again and leaves the other\'s as it is', async () => {
  const { root, state, guestbook, filter, flow } = workspace('repositories');
  await flow.refreshProject(guestbook);
  await flow.refreshProject(filter);
  const before = inodeOf(state, 'guestbook');
  merged(root, filter.url, { 'src/severity.ts': 'export {};\n' }, 'Merge pull request #12 from cleared/LOCAL-3: a severity per word');
  await flow.updateProjectPages?.({ ticket: 'LOCAL-3', pr: 12 });
  assert.match(read(state, 'filter-api'), /a severity per word/);
  assert.match(read(state, 'filter-api'), /`src\/severity\.ts`/);
  assert.equal(inodeOf(state, 'guestbook'), before, 'the guestbook\'s base did not move');
  assert.doesNotMatch(read(state, 'guestbook'), /a severity per word/);
});

test('two folders of one repository: each folder service gets the page of its folder, not of the repository (P240)', async () => {
  const { state, guestbook, filter, flow } = workspace('folders');
  await flow.refreshProject(guestbook);
  await flow.refreshProject(filter);
  const pages = ownPages(state, 'folders');
  assert.match(pages.guestbook, /from the folder `guestbook` of the base branch `main`/);
  assert.match(pages.filter, /from the folder `filter-api` of the base branch `main`/);
  assert.doesNotMatch(pages.guestbook, /The two example services, one folder each/, 'the repository\'s README is not the folder\'s');
  assert.ok(!pages.guestbook.includes('`README.md`'), 'the layout is the folder\'s only');
  assert.match(pages.guestbook, /From the folder `guestbook`:/, 'the scripts run in the folder');
  assert.match(pages.filter, /Provides the contract `filter-api\/contract\/openapi\.yaml` \(openapi\)\./);
  assert.match(pages.guestbook, /Commands a session may run unasked/, 'the safe commands are the repository\'s');
});

test('two folders of one repository: a merge in one folder makes its page again; the other folder\'s page is not written', async () => {
  const { root, state, guestbook, filter, flow } = workspace('folders');
  await flow.refreshProject(guestbook);
  await flow.refreshProject(filter);
  const before = { guestbook: inodeOf(state, 'guestbook'), filter: inodeOf(state, 'filter-api') };
  merged(root, filter.url, { 'filter-api/src/severity.ts': 'export {};\n' }, 'A severity per word');
  await flow.updateProjectPages?.({ ticket: 'LOCAL-3', pr: 12 });
  assert.notEqual(inodeOf(state, 'filter-api'), before.filter);
  assert.match(read(state, 'filter-api'), /A severity per word/);
  assert.equal(inodeOf(state, 'guestbook'), before.guestbook, 'nothing of the guestbook\'s folder changed');
  assert.doesNotMatch(read(state, 'guestbook'), /A severity per word/, 'a commit of another folder is not the guestbook\'s decision');
  merged(root, guestbook.url, { 'guestbook/src/count.ts': 'export {};\n' }, 'Count the entries');
  await flow.refreshProject(guestbook);
  assert.match(read(state, 'guestbook'), /Count the entries/);
  assert.doesNotMatch(read(state, 'filter-api'), /Count the entries/);
});

test('two folders of one repository: a session on a folder service is briefed on its folder\'s page', async () => {
  const { filter, flow } = workspace('folders');
  const prepared = await flow.prepareWorkdir({ ticket: ticketOn('filter-api'), role: 'author', service: filter });
  const text = readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8');
  assert.match(text, /## Generated page of the service filter-api\n/);
  assert.match(text, / {4}\| .*`filter-api\/src\/words\.ts`/);
  assert.ok(!text.includes('guestbook/src/page.ts'));
});

test('neither example\'s page holds a secret, nor anything else in the state folder', async () => {
  for (const shape of ['repositories', 'folders'] as const) {
    const { state, guestbook, filter, flow } = workspace(shape);
    await flow.refreshProject(guestbook);
    await flow.refreshProject(filter);
    for (const text of [read(state, 'guestbook'), read(state, 'filter-api'), everyText(state)]) {
      assert.doesNotMatch(text, /\.env\b|\.npmrc|PRIVATE KEY/);
      assert.ok(!text.includes('[removed:'), 'the examples hold nothing the cleaner had to take out');
    }
  }
});
