// Connecting a workspace (docs/v2/milestone-5-plan.md, section 9, decision
// 15, matrix M10): the repositories the forge credential reaches, picked,
// cloned, read by the service map, the links proposed, and the workspace
// file written from what the person ticked, nothing before. The two
// examples, guestbook and filter-api, as two repositories and as two
// folders of one, in temporary bare repositories a fake forge lists; then
// the step's routes, with a fake gh on PATH. No call reaches a forge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeRepository } from '../../src/forge/contract.ts';
import { readSettings, settingsPath } from '../../src/setup/settings.ts';
import { cloneEnvironment, confirm, ConnectError, listChoices, pick, propose, renderWorkspace, repositoryDir, WORKSPACE_FILE, type ServiceLines } from '../../src/workspace/connect.ts';
import { parseWorkspace } from '../../src/workspace/config.ts';
import { FakeForge } from '../forge/fake.ts';
import { fakeGh } from '../forge/fake-gh.ts';
import { PASSWORD, startSetup } from '../setup/support.ts';
import { gitIn, remote, tempDir } from './git.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
const MODEL = 'claude-opus-5-5';
// Built here, so no line of the repository holds a value shaped like a credential.
const GOOD = ['forge', 'credential', 'of', 'the', 'test'].join('-');

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

const repository = (repo: string, url: string, over: Partial<ForgeRepository> = {}): ForgeRepository => ({ repo, url, base: 'main', private: false, archived: false, ...over });

// The two examples as two repositories, and as two folders of a third.
function world(): ForgeRepository[] {
  return [
    repository('example-org/guestbook', remote(files(`${EXAMPLES}guestbook`))),
    repository('example-org/filter-api', remote(files(`${EXAMPLES}filter-api`))),
    repository('example-org/both', remote({ ...files(`${EXAMPLES}guestbook`, 'guestbook/'), ...files(`${EXAMPLES}filter-api`, 'filter-api/') })),
    repository('example-org/old', remote(), { archived: true }),
  ];
}

function state(): { readonly dir: string; readonly env: NodeJS.ProcessEnv; readonly settings: string } {
  const dir = tempDir('connect-state');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: dir };
  delete env.CLEARED_V2_PROJECT;
  delete env.CLEARED_V2_WORKSPACE;
  return { dir, env, settings: settingsPath(env) as string };
}

const nothingWritten = (dir: string, settings: string) => {
  assert.equal(existsSync(join(dir, WORKSPACE_FILE)), false, 'no workspace file before the tick');
  assert.equal(readSettings(settings).env.CLEARED_V2_WORKSPACE, undefined, 'no settings line before the tick');
};

test('the list: the repositories the credential reaches, by name, the archived ones counted apart', async () => {
  const listed = world();
  const choices = await listChoices(new FakeForge({ repositories: [...listed].reverse(), pulls: [] }));
  assert.deepEqual(choices.repositories.map((r) => r.repo), ['example-org/both', 'example-org/filter-api', 'example-org/guestbook']);
  assert.equal(choices.archived, 1);
});

test('a pick names repositories of the list only, ten at most, so no address of the browser is ever cloned', () => {
  const listed = world();
  assert.deepEqual(pick(listed, ['example-org/guestbook']).map((r) => r.url), [listed[0]?.url]);
  for (const [names, code] of [
    [[], 'invalid'], ['example-org/guestbook', 'invalid'], [[42], 'invalid'], [['example-org/nowhere'], 'unknown_repository'],
    [['example-org/old'], 'unknown_repository'], [[`file://${EXAMPLES}`], 'unknown_repository'],
    [Array.from({ length: 11 }, () => 'example-org/guestbook'), 'too_many'],
  ] as const) assert.throws(() => pick(listed, names), (error: unknown) => error instanceof ConnectError && error.message === code, JSON.stringify(names));
  assert.equal(pick(listed, ['example-org/guestbook', 'example-org/guestbook']).length, 1, 'a name picked twice is one repository');
});

test('two repositories: each cloned, the filter API\'s contract and the guestbook\'s call of it proposed, nothing written', async () => {
  const listed = world();
  const { dir, env, settings } = state();
  const proposal = await propose({ repositories: pick(listed, ['example-org/guestbook', 'example-org/filter-api']), whole: [], stateDir: dir, env });
  for (const repo of ['example-org/guestbook', 'example-org/filter-api']) {
    const clone = repositoryDir(dir, repo);
    assert.equal(gitIn(clone, ['remote', 'get-url', 'origin']), listed.find((r) => r.repo === repo)?.url, `${repo} is cloned from its address`);
  }
  assert.deepEqual(proposal.repositories, [
    { repo: 'example-org/guestbook', layout: 'whole', folders: [], from: null },
    { repo: 'example-org/filter-api', layout: 'whole', folders: [], from: null },
  ]);
  assert.deepEqual(proposal.services, [
    { name: 'guestbook', repo: 'example-org/guestbook', kind: 'repository', path: null, contract: null },
    { name: 'filter-api', repo: 'example-org/filter-api', kind: 'repository', path: null, contract: { format: 'openapi', path: 'contract/openapi.yaml' } },
  ]);
  assert.deepEqual(proposal.links, [{ id: 'guestbook>filter-api', from: 'guestbook', to: 'filter-api', items: ['POST /check'], places: [{ file: 'src/filter.ts', line: 38 }] }]);
  nothingWritten(dir, settings);
});

test('two folders of one repository: proposed as folder services, the same call proposed, its place inside the folder', async () => {
  const listed = world();
  const { dir, env, settings } = state();
  const proposal = await propose({ repositories: pick(listed, ['example-org/both']), whole: [], stateDir: dir, env });
  assert.deepEqual(proposal.repositories, [{ repo: 'example-org/both', layout: 'folders', folders: ['filter-api', 'guestbook'], from: 'manifests' }]);
  assert.deepEqual(proposal.services, [
    { name: 'filter-api', repo: 'example-org/both', kind: 'folder', path: 'filter-api', contract: { format: 'openapi', path: 'contract/openapi.yaml' } },
    { name: 'guestbook', repo: 'example-org/both', kind: 'folder', path: 'guestbook', contract: null },
  ]);
  assert.deepEqual(proposal.links, [{ id: 'guestbook>filter-api', from: 'guestbook', to: 'filter-api', items: ['POST /check'], places: [{ file: 'src/filter.ts', line: 38 }] }]);
  nothingWritten(dir, settings);
  const whole = await propose({ repositories: pick(listed, ['example-org/both']), whole: ['example-org/both'], stateDir: dir, env });
  assert.deepEqual(whole.services, [{ name: 'both', repo: 'example-org/both', kind: 'repository', path: null, contract: null }], 'kept whole, it is one service');
  assert.deepEqual(whole.links, []);
});

test('only what is ticked reaches the workspace file, which the service reads, and the settings name it', async () => {
  const listed = world();
  const { dir, env, settings } = state();
  const repositories = pick(listed, ['example-org/guestbook', 'example-org/filter-api']);
  await propose({ repositories, whole: [], stateDir: dir, env });
  nothingWritten(dir, settings);
  const written = await confirm({ repositories, whole: [], ticks: { services: ['guestbook', 'filter-api'], links: ['guestbook>filter-api'], contracts: [] }, stateDir: dir, env, authorModel: MODEL, settings });
  assert.deepEqual(written, {
    services: [{ name: 'guestbook', repo: 'example-org/guestbook', path: null }, { name: 'filter-api', repo: 'example-org/filter-api', path: null }],
    links: 1, contracts: 0,
  });
  const file = join(dir, WORKSPACE_FILE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const workspace = parseWorkspace(readFileSync(file, 'utf8'), { file, authorModel: MODEL, stateDir: '/unused' });
  assert.equal(workspace.id, 'guestbook', 'the first service names the workspace');
  const [guestbook, filter] = workspace.services;
  assert.deepEqual(guestbook?.consumes, ['filter-api'], 'the ticked link');
  assert.equal(filter?.contract, null, 'the contract line was not ticked');
  assert.equal(guestbook?.dir, repositoryDir(dir, 'example-org/guestbook'), 'its checkout is the clone');
  assert.equal(guestbook?.url, listed[0]?.url);
  assert.equal(readSettings(settings).env.CLEARED_V2_WORKSPACE, file);
  assert.equal(env.CLEARED_V2_WORKSPACE, file, 'set in this process at once');
});

test('nothing ticked: no consumes and no contract line; a contract ticked alone is written alone', async () => {
  const listed = world();
  const { dir, env, settings } = state();
  const repositories = pick(listed, ['example-org/guestbook', 'example-org/filter-api']);
  await confirm({ repositories, whole: [], ticks: { services: ['guestbook', 'filter-api'], links: [], contracts: ['filter-api'] }, stateDir: dir, env, authorModel: MODEL, settings });
  const text = readFileSync(join(dir, WORKSPACE_FILE), 'utf8');
  assert.doesNotMatch(text, /consumes/);
  assert.match(text, /^contract = openapi:contract\/openapi\.yaml$/m);
});

test('folder services: each its own checkout of the repository, its origin the forge\'s address', async () => {
  const listed = world();
  const { dir, env, settings } = state();
  const repositories = pick(listed, ['example-org/both']);
  await confirm({ repositories, whole: [], ticks: { services: ['guestbook', 'filter-api'], links: ['guestbook>filter-api'], contracts: ['filter-api'] }, stateDir: dir, env, authorModel: MODEL, settings });
  const file = join(dir, WORKSPACE_FILE);
  const workspace = parseWorkspace(readFileSync(file, 'utf8'), { file, authorModel: MODEL, stateDir: '/unused' });
  const dirs = workspace.services.map((service) => service.dir);
  assert.equal(new Set(dirs).size, 2, 'two checkouts, never one shared');
  for (const service of workspace.services) {
    assert.equal(service.kind, 'folder');
    assert.equal(gitIn(service.dir, ['remote', 'get-url', 'origin']), listed[2]?.url);
    assert.equal(gitIn(service.dir, ['rev-parse', 'refs/remotes/origin/main']), gitIn(repositoryDir(dir, 'example-org/both'), ['rev-parse', 'refs/remotes/origin/main']));
  }
  assert.deepEqual(workspace.services.find((s) => s.name === 'guestbook')?.consumes, ['filter-api']);
  assert.deepEqual(workspace.services.find((s) => s.name === 'filter-api')?.contract, { format: 'openapi', path: 'contract/openapi.yaml' });
});

test('a tick the proposal does not hold, or a service left out of a ticked link, is refused, nothing written', async () => {
  const listed = world();
  const { dir, env, settings } = state();
  const repositories = pick(listed, ['example-org/guestbook', 'example-org/filter-api']);
  for (const ticks of [
    { services: ['guestbook', 'billing'], links: [], contracts: [] },
    { services: ['guestbook'], links: ['guestbook>filter-api'], contracts: [] },
    { services: ['guestbook', 'filter-api'], links: ['filter-api>guestbook'], contracts: [] },
    { services: ['guestbook', 'filter-api'], links: [], contracts: ['guestbook'] },
    { services: [], links: [], contracts: [] },
  ]) {
    await assert.rejects(confirm({ repositories, whole: [], ticks, stateDir: dir, env, authorModel: MODEL, settings }), (error: unknown) => error instanceof ConnectError, JSON.stringify(ticks));
    nothingWritten(dir, settings);
  }
});

test('a cycle of ticked links is refused before anything is written', async () => {
  const { dir, env, settings } = state();
  const ping = '// calls pong\nexport const go = (base: string) => fetch(`${base}/pong`);\n';
  const pong = '// calls ping\nexport const go = (base: string) => fetch(`${base}/ping`);\n';
  const contract = (path: string) => `openapi: 3.0.3\ninfo:\n  title: t\n  version: "1"\npaths:\n  ${path}:\n    get:\n      responses:\n        "200":\n          description: ok\n`;
  const repositories = [
    repository('example-org/ping', remote({ 'package.json': '{}', 'src/call.ts': ping, 'openapi.yaml': contract('/ping') })),
    repository('example-org/pong', remote({ 'package.json': '{}', 'src/call.ts': pong, 'openapi.yaml': contract('/pong') })),
  ];
  const proposal = await propose({ repositories, whole: [], stateDir: dir, env });
  assert.deepEqual(proposal.links.map((link) => link.id), ['ping>pong', 'pong>ping']);
  await assert.rejects(confirm({ repositories, whole: [], ticks: { services: ['ping', 'pong'], links: ['ping>pong', 'pong>ping'], contracts: ['ping', 'pong'] }, stateDir: dir, env, authorModel: MODEL, settings }),
    (error: unknown) => error instanceof ConnectError && error.message === 'cycle');
  nothingWritten(dir, settings);
});

test('the workspace\'s id: CLEARED_V2_PROJECT when set, else the file\'s earlier id, whose hand-written keys are kept', async () => {
  const listed = world();
  const { dir, env, settings } = state();
  const repositories = pick(listed, ['example-org/guestbook', 'example-org/filter-api']);
  const ticks = { services: ['guestbook', 'filter-api'], links: ['guestbook>filter-api'], contracts: ['filter-api'] };
  await confirm({ repositories, whole: [], ticks, stateDir: dir, env: { ...env, CLEARED_V2_PROJECT: 'demo' }, authorModel: MODEL, settings });
  const file = join(dir, WORKSPACE_FILE);
  assert.match(readFileSync(file, 'utf8'), /^id = demo$/m);
  writeFileSync(file, readFileSync(file, 'utf8').replace('[service guestbook]\n', '[service guestbook]\nhealth_url = http://127.0.0.1:8793/health\n'), { mode: 0o600 });
  await confirm({ repositories, whole: [], ticks, stateDir: dir, env, authorModel: MODEL, settings });
  const workspace = parseWorkspace(readFileSync(file, 'utf8'), { file, authorModel: MODEL, stateDir: '/unused' });
  assert.equal(workspace.id, 'demo', 'the rows of the first connect stay in the workspace');
  assert.equal(workspace.services.find((s) => s.name === 'guestbook')?.healthUrl, 'http://127.0.0.1:8793/health');
});

test('a checkout folder that holds another repository is refused, and left as it is', async () => {
  const listed = world();
  const { dir, env } = state();
  const clone = repositoryDir(dir, 'example-org/guestbook');
  mkdirSync(join(clone, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', listed[1]?.url as string, clone]);
  await assert.rejects(propose({ repositories: pick(listed, ['example-org/guestbook']), whole: [], stateDir: dir, env }), (error: unknown) => error instanceof ConnectError && error.message === 'checkout_other');
  assert.equal(gitIn(clone, ['remote', 'get-url', 'origin']), listed[1]?.url);
});

// A value with a line break would end its line and start another, a section
// included: every value the file is made of is checked on its own.
const SERVICE: ServiceLines = {
  name: 'api', kind: 'folder', repo: 'example-org/both', url: 'https://forge.invalid/example-org/both.git', base: 'main', path: 'api', dir: '/state/services/api/checkout',
  consumes: [], contract: { format: 'openapi', path: 'contract/openapi.yaml' }, hand: { health_url: 'http://127.0.0.1:8793/health' },
};

test('the file refuses a line break or a NUL in any value: path, contract, repository, address, base, name, dir, id, a kept key', () => {
  const text = renderWorkspace({ id: 'demo', name: 'api', services: [SERVICE] });
  assert.match(text, /^\[service api\]$/m);
  assert.match(text, /^path = api$/m);
  const evil = '\n[service injected]\nkind = repository';
  const cases: [string, Parameters<typeof renderWorkspace>[0]][] = [
    ['path', { id: 'demo', name: 'api', services: [{ ...SERVICE, path: `api${evil}` }] }],
    ['contract', { id: 'demo', name: 'api', services: [{ ...SERVICE, contract: { format: 'openapi', path: `openapi.yaml${evil}` } }] }],
    ['repository', { id: 'demo', name: 'api', services: [{ ...SERVICE, repo: `example-org/both${evil}` }] }],
    ['url', { id: 'demo', name: 'api', services: [{ ...SERVICE, url: `https://forge.invalid/x.git\r${evil}` }] }],
    ['base', { id: 'demo', name: 'api', services: [{ ...SERVICE, base: `main${evil}` }] }],
    ['name', { id: 'demo', name: 'api', services: [{ ...SERVICE, name: `api${evil}` }] }],
    ['dir', { id: 'demo', name: 'api', services: [{ ...SERVICE, dir: `/state${evil}` }] }],
    ['consumes', { id: 'demo', name: 'api', services: [{ ...SERVICE, consumes: [`web${evil}`] }] }],
    ['id', { id: `demo${evil}`, name: 'api', services: [SERVICE] }],
    ['workspace name', { id: 'demo', name: `api\0${evil}`, services: [SERVICE] }],
    ['kept key', { id: 'demo', name: 'api', services: [{ ...SERVICE, hand: { run: `Dockerfile:3000${evil}` } }] }],
  ];
  for (const [what, input] of cases) assert.throws(() => renderWorkspace(input), (error: unknown) => error instanceof ConnectError && error.message === 'invalid', what);
});

test('a repository with a folder named with a newline: the folder is not proposed, and no section is injected into the file', async () => {
  const { dir, env, settings } = state();
  const evil = 'evil\n[service injected]\nkind = repository';
  const repositories = [repository('example-org/mono', remote({ 'api/package.json': '{}', 'web/package.json': '{}', [`${evil}/package.json`]: '{}' }))];
  const proposal = await propose({ repositories, whole: [], stateDir: dir, env });
  assert.deepEqual(proposal.services.map((service) => service.path), ['api', 'web']);
  await confirm({ repositories, whole: [], ticks: { services: ['api', 'web'], links: [], contracts: [] }, stateDir: dir, env, authorModel: MODEL, settings });
  const text = readFileSync(join(dir, WORKSPACE_FILE), 'utf8');
  assert.doesNotMatch(text, /injected/);
  assert.deepEqual(text.match(/^\[service [^\]]+\]$/gm), ['[service api]', '[service web]']);
});

test('git asks gh for GitHub\'s credential, which reads GH_TOKEN itself: the value is in no git setting', () => {
  const env = cloneEnvironment({ PATH: '/usr/bin', GH_TOKEN: GOOD });
  const count = Number(env.GIT_CONFIG_COUNT);
  const entries = Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.deepEqual(entries, [['credential.https://github.com.helper', ''], ['credential.https://github.com.helper', '!gh auth git-credential']]);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  for (const [name, value] of Object.entries(env)) if (name !== 'GH_TOKEN') assert.ok(!String(value).includes(GOOD), name);
  assert.equal(cloneEnvironment({ PATH: '/usr/bin' }).GIT_CONFIG_COUNT, undefined, 'no credential, no helper');
});

// The step's routes, through the setup module, with a fake gh on PATH.
async function withStep(run: (call: (path: string, body?: unknown) => Promise<{ status: number; json: any; text: string }>, at: { dir: string; env: NodeJS.ProcessEnv; listed: ForgeRepository[] }) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const listed = world();
  const gh = fakeGh({ repositories: listed, pulls: [] });
  const service = await startSetup({ env: { PATH: gh.env.PATH as string, GH_TOKEN: GOOD, ...env } });
  try {
    const owner = await service.directory.add('alex', PASSWORD);
    const call = (path: string, body?: unknown) => service.call(path, { user: owner.id, ...(body === undefined ? {} : { method: 'POST', body }) });
    await run(call, { dir: service.dir, env: service.env, listed });
  } finally {
    await service.close();
  }
}

test('the step: the list, the proposal, then the file from the ticks, the step done with the machine\'s time', async () => {
  await withStep(async (call, { dir }) => {
    const view = await call('/api/setup/workspace');
    assert.equal(view.status, 200);
    assert.deepEqual(view.json.repositories.map((r: { repo: string }) => r.repo), ['example-org/both', 'example-org/filter-api', 'example-org/guestbook']);
    assert.deepEqual([view.json.archived, view.json.problem, view.json.connected, view.json.source], [1, null, null, null]);
    assert.ok(!view.text.includes('.git'), 'no clone address reaches the browser');
    const proposed = await call('/api/setup/workspace/propose', { repositories: ['example-org/guestbook', 'example-org/filter-api'] });
    assert.equal(proposed.status, 200);
    assert.deepEqual(proposed.json.links.map((link: { id: string }) => link.id), ['guestbook>filter-api']);
    assert.equal(typeof proposed.json.machineMs, 'number');
    assert.equal(existsSync(join(dir, WORKSPACE_FILE)), false);
    const confirmed = await call('/api/setup/workspace', { repositories: ['example-org/guestbook', 'example-org/filter-api'], services: ['guestbook', 'filter-api'], links: ['guestbook>filter-api'], contracts: ['filter-api'] });
    assert.equal(confirmed.status, 200);
    // Each says whether its base holds a .devcontainer (C4): both examples do.
    assert.deepEqual(confirmed.json, { services: [{ name: 'guestbook', repo: 'example-org/guestbook', path: null, devcontainer: true }, { name: 'filter-api', repo: 'example-org/filter-api', path: null, devcontainer: true }], links: 1, contracts: 1 });
    assert.ok(!confirmed.text.includes(dir), 'no path of this machine in the answer');
    const setup = await call('/api/setup');
    const step = setup.json.steps.find((s: { id: string }) => s.id === 'workspace');
    assert.equal(step.state, 'done');
    assert.equal(step.filled, true);
    const again = await call('/api/setup/workspace');
    assert.deepEqual(again.json.connected.services.map((s: { name: string; devcontainer: boolean }) => [s.name, s.devcontainer]), [['guestbook', true], ['filter-api', true]]);
    assert.equal(again.json.source, 'assistant');
  });
});

test('the step refuses a repository off the list and an unknown tick, and says what it refuses', async () => {
  await withStep(async (call) => {
    for (const [body, code] of [
      [{ repositories: ['example-org/elsewhere'] }, 'unknown_repository'],
      [{ repositories: 'example-org/guestbook' }, 'invalid'],
      [{ repositories: ['example-org/guestbook'], whole: ['example-org/filter-api'] }, 'invalid'],
    ] as const) {
      const refused = await call('/api/setup/workspace/propose', body);
      assert.deepEqual([refused.status, refused.json], [400, { error: code }], JSON.stringify(body));
    }
    const unknown = await call('/api/setup/workspace', { repositories: ['example-org/guestbook'], services: ['guestbook'], links: ['guestbook>filter-api'], contracts: [] });
    assert.deepEqual([unknown.status, unknown.json], [400, { error: 'changed' }]);
  });
});

test('a workspace file the environment names is the environment\'s: shown as such, never replaced from the browser', async () => {
  await withStep(async (call) => {
    const view = await call('/api/setup/workspace');
    assert.equal(view.json.source, 'environment');
    const refused = await call('/api/setup/workspace', { repositories: ['example-org/guestbook'], services: ['guestbook'], links: [], contracts: [] });
    assert.deepEqual([refused.status, refused.json], [409, { error: 'environment' }]);
  }, { CLEARED_V2_WORKSPACE: '/etc/cleared/workspace.conf' });
});

test('with no forge credential the list says so, and gh is not asked', async () => {
  const listed = world();
  const gh = fakeGh({ repositories: listed, pulls: [] });
  const service = await startSetup({ env: { PATH: gh.env.PATH as string } });
  try {
    const owner = await service.directory.add('alex', PASSWORD);
    const view = await service.call('/api/setup/workspace', { user: owner.id });
    assert.deepEqual([view.status, view.json.problem, view.json.repositories], [200, 'no_forge', []]);
    assert.deepEqual(gh.calls(), []);
  } finally {
    await service.close();
  }
});

test('a forge that fails is "unreachable", and none of gh\'s words reach the browser', async () => {
  const listed = world();
  const gh = fakeGh({ repositories: listed, pulls: [] }, { fail: 'api' });
  const service = await startSetup({ env: { PATH: gh.env.PATH as string, GH_TOKEN: GOOD } });
  try {
    const owner = await service.directory.add('alex', PASSWORD);
    const view = await service.call('/api/setup/workspace', { user: owner.id });
    assert.deepEqual([view.status, view.json.problem], [200, 'unreachable']);
    assert.ok(!view.text.includes('502'));
    const refused = await service.call('/api/setup/workspace/propose', { user: owner.id, method: 'POST', body: { repositories: ['example-org/guestbook'] } });
    assert.deepEqual([refused.status, refused.json], [502, { error: 'unreachable' }]);
  } finally {
    await service.close();
  }
});
