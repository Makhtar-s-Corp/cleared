// What the workspace step guesses from a repository's files
// (docs/v2/milestone-5-plan.md, section 9, decision 15): a monorepo's
// folders from its workspaces or from top folders with a manifest of their
// own, a contract file under a known name, each service's name, and the
// links the service map finds between the services, with the file and line
// that suggested each. The two examples, guestbook and filter-api, as two
// repositories and as two folders of one: the guestbook's call of the filter
// API's POST /check, at src/filter.ts line 38, is the link proposed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFolder } from '../../src/map/source.ts';
import { contractOf, folderServices, proposeLinks, serviceNames, wantedFiles, type Tree } from '../../src/workspace/guess.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));

// A folder of the disk as a tree, every file under `prefix`, without node_modules.
function files(root: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(posix.join(root, relative)).sort()) {
      const path = relative ? posix.join(relative, name) : name;
      const stat = lstatSync(posix.join(root, path));
      if (stat.isDirectory()) { if (name !== 'node_modules') walk(path); }
      else if (stat.isFile()) out[prefix + path] = readFileSync(posix.join(root, path), 'utf8');
    }
  };
  walk('');
  return out;
}

const tree = (all: Record<string, string>): Tree => {
  const paths = Object.keys(all).sort();
  return { paths, files: Object.fromEntries(wantedFiles(paths).map((path) => [path, all[path] as string])) };
};

const OPENAPI = 'openapi: 3.0.3\ninfo:\n  title: t\n  version: "1"\npaths:\n  /items:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const ASYNCAPI = JSON.stringify({ asyncapi: '2.6.0', info: { title: 'events', version: '1' }, channels: { 'order.placed': { subscribe: { message: { payload: { type: 'object' } } } } } });

test('one repository with a manifest at its root and no workspaces is not a monorepo', () => {
  assert.equal(folderServices(tree(files(`${EXAMPLES}guestbook`))), null);
  assert.equal(folderServices(tree({ 'package.json': '{}', 'website/package.json': '{}', 'src/main.ts': '' })), null, 'one top folder with a manifest is a part, not a service');
});

test('a monorepo\'s folders: its package.json workspaces, globs at the end of a path included, in path order', () => {
  const found = folderServices(tree({
    'package.json': JSON.stringify({ workspaces: ['packages/*', 'api'] }),
    'packages/web/package.json': '{}', 'packages/admin/package.json': '{}', 'packages/README.md': '', 'api/package.json': '{}', 'docs/package.json': '{}',
  }));
  assert.deepEqual(found, { folders: ['api', 'packages/admin', 'packages/web'], from: 'workspaces' });
  assert.deepEqual(folderServices(tree({ 'package.json': JSON.stringify({ workspaces: { packages: ['svc/*'] } }), 'svc/a/package.json': '{}' })), { folders: ['svc/a'], from: 'workspaces' });
  assert.deepEqual(folderServices(tree({ 'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - \'lib\'\n', 'apps/one/package.json': '{}', 'lib/package.json': '{}' })), { folders: ['apps/one', 'lib'], from: 'workspaces' });
});

test('a workspaces entry that leaves the repository, or names a folder with no manifest, is not proposed', () => {
  assert.equal(folderServices(tree({ 'package.json': JSON.stringify({ workspaces: ['../other', '/abs', 'empty'] }), 'empty/README.md': '' })), null);
});

test('without workspaces, top folders with a manifest of their own, two at least, any language', () => {
  const found = folderServices(tree({
    'README.md': '', 'billing/go.mod': 'module billing', 'search/pyproject.toml': '', 'web/package.json': '{}', 'test/package.json': '{}', 'docs/x.md': '', 'deep/a/package.json': '{}',
  }));
  assert.deepEqual(found, { folders: ['billing', 'search', 'web'], from: 'manifests' }, 'a test folder and a manifest two levels down are not services');
});

test('the two examples as two folders of one repository', () => {
  const both = tree({ ...files(`${EXAMPLES}guestbook`, 'guestbook/'), ...files(`${EXAMPLES}filter-api`, 'filter-api/'), 'README.md': '# both\n' });
  assert.deepEqual(folderServices(both), { folders: ['filter-api', 'guestbook'], from: 'manifests' });
  assert.deepEqual(contractOf(both, 'filter-api'), { format: 'openapi', path: 'contract/openapi.yaml' }, 'the path is inside the folder');
  assert.equal(contractOf(both, 'guestbook'), null);
  assert.equal(contractOf(both, null), null, 'the repository as a whole has no contract at a known place');
});

test('a contract under a known name: OpenAPI first, then AsyncAPI as events, read before it is proposed', () => {
  assert.deepEqual(contractOf(tree(files(`${EXAMPLES}filter-api`)), null), { format: 'openapi', path: 'contract/openapi.yaml' });
  assert.deepEqual(contractOf(tree({ 'openapi.json': JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } } }) }), null), { format: 'openapi', path: 'openapi.json' });
  assert.deepEqual(contractOf(tree({ 'api/openapi.yml': OPENAPI, 'asyncapi.json': ASYNCAPI }), null), { format: 'openapi', path: 'api/openapi.yml' });
  assert.deepEqual(contractOf(tree({ 'docs/asyncapi.json': ASYNCAPI }), null), { format: 'events', path: 'docs/asyncapi.json' });
  assert.equal(contractOf(tree({ 'openapi.yaml': 'not: [a contract' }), null), null, 'a file that cannot be read as a contract is not proposed');
  assert.equal(contractOf(tree({ 'src/vendor/openapi.yaml': OPENAPI }), null), null, 'only the known places');
});

test('the files the guess reads are few: the root\'s workspaces and the known contract names, two folders deep at most', () => {
  const wanted = wantedFiles(['package.json', 'pnpm-workspace.yaml', 'src/main.ts', 'contract/openapi.yaml', 'api/package.json', 'api/contract/openapi.yaml', 'src/openapi.yaml', 'a/b/c/openapi.yaml', 'packages/web/contract/asyncapi.json']);
  assert.deepEqual(wanted, ['api/contract/openapi.yaml', 'contract/openapi.yaml', 'package.json', 'packages/web/contract/asyncapi.json', 'pnpm-workspace.yaml', 'src/openapi.yaml']);
});

test('names: the repository\'s or the folder\'s, as a service name allows, the second of two the same told apart', () => {
  assert.deepEqual(serviceNames([{ repo: 'example-org/guestbook', path: null }, { repo: 'example-org/filter-api', path: null }]), ['guestbook', 'filter-api']);
  assert.deepEqual(serviceNames([{ repo: 'example-org/both', path: 'guestbook' }, { repo: 'example-org/both', path: 'filter-api' }]), ['guestbook', 'filter-api']);
  assert.deepEqual(serviceNames([{ repo: 'one/API', path: null }, { repo: 'two/api', path: null }, { repo: 'three/shop', path: 'packages/api' }]), ['api', 'two-api', 'shop-api']);
  assert.deepEqual(serviceNames([{ repo: 'a/x', path: 'svc/x' }, { repo: 'a/x', path: 'lib/x' }, { repo: 'b/x', path: 'svc/x' }]), ['x', 'x-x', 'x-2']);
  for (const name of serviceNames([{ repo: 'o/Some.Very_Long-Repository.Name.That.Goes.On.And.On', path: null }])) assert.match(name, /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
});

test('links: the guestbook\'s call of POST /check, found once the filter API\'s contract is proposed, with its place', () => {
  const services = [
    { name: 'guestbook', kind: 'repository' as const, path: null, consumes: [], contract: null },
    { name: 'filter-api', kind: 'repository' as const, path: null, consumes: [], contract: { format: 'openapi' as const, path: 'contract/openapi.yaml' } },
  ];
  const reads = services.map((service) => readFolder(`${EXAMPLES}${service.name}`, service));
  assert.deepEqual(proposeLinks(services, reads), [{ id: 'guestbook>filter-api', from: 'guestbook', to: 'filter-api', items: ['POST /check'], places: [{ file: 'src/filter.ts', line: 38 }] }]);
  assert.deepEqual(proposeLinks(services.map((service) => ({ ...service, contract: null })), reads), [], 'no contract proposed, nothing to read a call against');
});

test('a folder whose name holds a newline or another control character is never proposed, as a top folder or a workspaces entry', () => {
  const evil = 'evil\n[service injected]\nkind = repository';
  assert.deepEqual(folderServices(tree({ 'api/package.json': '{}', 'web/package.json': '{}', [`${evil}/package.json`]: '{}', 'tab\there/go.mod': '' })), { folders: ['api', 'web'], from: 'manifests' });
  assert.deepEqual(folderServices(tree({ 'package.json': JSON.stringify({ workspaces: [evil, 'packages/*'] }), [`${evil}/package.json`]: '{}', 'packages/ok/package.json': '{}', [`packages/${evil}/package.json`]: '{}' })), { folders: ['packages/ok'], from: 'workspaces' });
});
