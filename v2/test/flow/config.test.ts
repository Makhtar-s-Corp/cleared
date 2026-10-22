import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowConfigError, loadFlowConfig, parseConf, projectSettings, workspaceOf } from '../../src/flow/config.ts';
import { publicWorkspace } from '../../src/workspace/config.ts';

const conf = `
# a comment
[merge]
verdict = no blocking issues   # trailing words stay: only a full-line comment is one
tooling_paths = package-lock.json

[session]
image = cleared-v2-session:latest
safe_commands = npm ci, npm test, npm run typecheck
hosts = registry.npmjs.org, example.org
`;

test('parseConf reads sections and keys, ignoring comment lines', () => {
  const sections = parseConf(conf);
  assert.equal(sections.merge?.verdict, 'no blocking issues   # trailing words stay: only a full-line comment is one');
  assert.equal(sections.session?.image, 'cleared-v2-session:latest');
});

test('projectSettings gives the verdict phrase, the safe commands and the hosts as lists', () => {
  const settings = projectSettings(parseConf('[merge]\nverdict = no blocking issues\n[session]\nsafe_commands = npm ci, npm test\nhosts = registry.npmjs.org, example.org\n'));
  assert.equal(settings.verdict, 'no blocking issues');
  assert.deepEqual(settings.safeCommands, ['npm ci', 'npm test']);
  assert.deepEqual(settings.hosts, ['registry.npmjs.org', 'example.org']);
});

test('projectSettings gives the declared test services, in the form the guestbook commits, and none by default', () => {
  const settings = projectSettings(parseConf('[merge]\nverdict = no blocking issues\n[session]\nservices = postgres:16 POSTGRES_HOST_AUTH_METHOD=trust\n'));
  assert.deepEqual(settings.services.map((s) => [s.alias, s.image, s.sessionEnv.DATABASE_URL]), [['postgres', 'postgres:16', 'postgres://postgres@postgres:5432/postgres']]);
  assert.deepEqual(projectSettings(parseConf('[merge]\nverdict = no blocking issues\n')).services, []);
  assert.throws(() => projectSettings(parseConf('[merge]\nverdict = no blocking issues\n[session]\nservices = redis:7\n')), (error: unknown) => error instanceof FlowConfigError && /redis/.test(error.message));
});

test('without a verdict phrase the project cannot pass a review', () => {
  assert.throws(() => projectSettings(parseConf('[merge]\ntooling_paths = x\n')), FlowConfigError);
});

test('loadFlowConfig reads the environment and refuses what is missing or unsafe', () => {
  const env = { CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://github.com/example-org/cleared-example-guestbook.git', CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state' };
  const config = loadFlowConfig(env);
  assert.equal(config?.base, 'main');
  assert.equal(config?.authorModel, 'claude-opus-5-5');
  assert.equal(config?.reviewerModel, 'claude-sonnet-5-5');
  assert.equal(config?.idleMs, 15 * 60 * 1000);
  assert.equal(config?.maxReviewRounds, 2);
  assert.equal(config?.budgetUsd, undefined);
  assert.equal(config?.workdirRoot, '/state/work');
  assert.equal(loadFlowConfig({ ...env, CLEARED_V2_BUDGET_USD: '7.5' })?.budgetUsd, 7.5);
  assert.equal(loadFlowConfig({}), undefined, 'not configured: the flow does not start');
  assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_BUDGET_USD: 'lots' }), FlowConfigError);
  assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_PROJECT_DIR: 'relative' }), FlowConfigError);
  assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_REPO: 'not-owner-name' }), FlowConfigError);
});

test('CLEARED_V2_MERGE_RETRY_SECONDS spaces the merge retries, 60 seconds by default', () => {
  const env = { CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/g.git', CLEARED_V2_REPO: 'example-org/g', CLEARED_V2_STATE_DIR: '/state' };
  assert.equal(loadFlowConfig(env)?.mergeRetryMs, 60_000);
  assert.equal(loadFlowConfig({ ...env, CLEARED_V2_MERGE_RETRY_SECONDS: '15' })?.mergeRetryMs, 15_000);
  assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_MERGE_RETRY_SECONDS: '0' }), FlowConfigError);
  assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_MERGE_RETRY_SECONDS: '2.5' }), FlowConfigError);
});

// ---------------------------------------------------------------- the workspace (milestone 2, lane 14, decision 18)

const M1_ENV = {
  CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://github.com/example-org/cleared-example-guestbook.git',
  CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state', CLEARED_V2_BASE: 'trunk',
};

test('the milestone 1 variables make a one-service workspace, and the flow configuration is the one milestone 1 had', () => {
  const config = loadFlowConfig(M1_ENV);
  assert.ok(config);
  const { workspace, ...rest } = config;
  // The fields and values of the milestone 1 FlowConfig, unchanged.
  assert.deepEqual(rest, {
    project: 'guestbook', projectDir: '/srv/guestbook', repoUrl: 'https://github.com/example-org/cleared-example-guestbook.git',
    repo: 'example-org/cleared-example-guestbook', base: 'trunk', workdirRoot: '/state/work', authorModel: 'claude-opus-5-5',
    reviewerModel: 'claude-sonnet-5-5', idleMs: 15 * 60_000, maxReviewRounds: 2, budgetUsd: undefined, mergeRetryMs: 60_000,
  });
  // Its id is the old project value, so every existing row stays in it.
  assert.deepEqual(workspace, {
    id: 'guestbook', name: 'guestbook', file: null,
    services: [{
      name: 'guestbook', kind: 'repository', repo: 'example-org/cleared-example-guestbook', url: 'https://github.com/example-org/cleared-example-guestbook.git',
      base: 'trunk', path: null, dir: '/srv/guestbook', healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null,
      brokerSocket: null, brokerState: null,
    }],
  });
  assert.deepEqual(workspaceOf(config), workspace);
  // A FlowConfig written without its workspace (the tests' literals) reads as the same one-service workspace.
  assert.deepEqual(workspaceOf(rest), workspace);
  // The [session] services test containers keep their name and meaning.
  assert.deepEqual(projectSettings(parseConf('[merge]\nverdict = ok\n[session]\nservices = postgres:16\n')).services.map((s) => s.alias), ['postgres']);
});

const TWO = `
[workspace]
id = guestbook
name = Guestbook and its filter

[service guestbook]
kind = repository
repository = example-org/cleared-example-guestbook
url = https://github.com/example-org/cleared-example-guestbook.git
dir = /srv/guestbook
health_url = http://127.0.0.1:8793/health
consumes = filter-api
run = Dockerfile:3000

[service filter-api]
kind = folder
repository = example-org/cleared-examples
url = https://github.com/example-org/cleared-examples.git
base = develop
path = filter-api
contract = openapi:contract/openapi.yaml
sensitivity = reviewer:claude-sonnet-5-5
broker_socket = /state/filter-api/broker.sock
broker_state = /state/filter-api
`;

function withWorkspaceFile(text: string, run: (env: NodeJS.ProcessEnv) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-workspace-'));
  try {
    const file = join(dir, 'workspace.conf');
    writeFileSync(file, text);
    run({ CLEARED_V2_WORKSPACE: file, CLEARED_V2_STATE_DIR: '/state' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a two-service workspace file parses with its kinds, consumes, run, contract and sensitivity', () => {
  withWorkspaceFile(TWO, (env) => {
    const config = loadFlowConfig(env);
    assert.ok(config);
    const workspace = workspaceOf(config);
    assert.equal(workspace.id, 'guestbook');
    assert.equal(workspace.name, 'Guestbook and its filter');
    assert.equal(workspace.file, env.CLEARED_V2_WORKSPACE);
    const [guestbook, filter] = workspace.services;
    assert.deepEqual(guestbook, {
      name: 'guestbook', kind: 'repository', repo: 'example-org/cleared-example-guestbook', url: 'https://github.com/example-org/cleared-example-guestbook.git',
      base: 'main', path: null, dir: '/srv/guestbook', healthUrl: 'http://127.0.0.1:8793/health', sensitivity: 'normal', consumes: ['filter-api'],
      run: { dockerfile: 'Dockerfile', port: 3000 }, contract: null, brokerSocket: null, brokerState: null,
    });
    assert.deepEqual(filter, {
      name: 'filter-api', kind: 'folder', repo: 'example-org/cleared-examples', url: 'https://github.com/example-org/cleared-examples.git',
      base: 'develop', path: 'filter-api', dir: '/state/services/filter-api/checkout', healthUrl: null, sensitivity: 'reviewer:claude-sonnet-5-5', consumes: [],
      run: null, contract: { format: 'openapi', path: 'contract/openapi.yaml' }, brokerSocket: '/state/filter-api/broker.sock', brokerState: '/state/filter-api',
    });
    // The milestone 1 fields name the workspace and its first service, until the flow publishes per service (lane 16).
    assert.equal(config.project, 'guestbook');
    assert.equal(config.projectDir, '/srv/guestbook');
    assert.equal(config.repo, 'example-org/cleared-example-guestbook');
    assert.equal(config.base, 'main');
    // The public shape leaves out the server's paths.
    const shown = publicWorkspace(workspace);
    assert.deepEqual(Object.keys(shown.services[1] as object).sort(), ['base', 'consumes', 'contract', 'healthUrl', 'kind', 'name', 'path', 'repo', 'run', 'sensitivity', 'url']);
    assert.ok(!JSON.stringify(shown).includes('/srv/') && !JSON.stringify(shown).includes('/state/'));
  });
  // run also reads as the Dockerfile and the port separated by a space.
  withWorkspaceFile(TWO.replace('run = Dockerfile:3000', 'run = Dockerfile 3000'), (env) =>
    assert.deepEqual(workspaceOf(loadFlowConfig(env)!).services[0]?.run, { dockerfile: 'Dockerfile', port: 3000 }));
});

test('the workspace file refuses an unknown kind, a service that consumes itself, a sensitivity naming no user, and the author model as a reviewer', () => {
  const refused = (text: string, pattern: RegExp) => withWorkspaceFile(text, (env) =>
    assert.throws(() => loadFlowConfig(env), (error: unknown) => error instanceof FlowConfigError && pattern.test(error.message), pattern.source));
  refused(TWO.replace('kind = folder', 'kind = submodule'), /\[service filter-api\] kind/);
  refused(TWO.replace('consumes = filter-api', 'consumes = guestbook'), /guestbook consumes itself/);
  refused(TWO.replace('sensitivity = reviewer:claude-sonnet-5-5', 'sensitivity = human:'), /names no user/);
  refused(TWO.replace('sensitivity = reviewer:claude-sonnet-5-5', 'sensitivity = reviewer:claude-opus-5-5'), /author model/);
  // The author model is the configured one, not a constant.
  withWorkspaceFile(TWO.replace('sensitivity = reviewer:claude-sonnet-5-5', 'sensitivity = reviewer:claude-opus-5-5'), (env) =>
    assert.equal(workspaceOf(loadFlowConfig({ ...env, CLEARED_V2_AUTHOR_MODEL: 'claude-sonnet-5-5', CLEARED_V2_REVIEWER_MODEL: 'claude-opus-5-5' })!).services[1]?.sensitivity, 'reviewer:claude-opus-5-5'));
  // And what else a file can get wrong.
  refused(TWO.replace('sensitivity = reviewer:claude-sonnet-5-5', 'sensitivity = strict'), /sensitivity/);
  refused(TWO.replace('consumes = filter-api', 'consumes = payments'), /consumes payments, which is not a service/);
  refused(`${TWO}\n[service payments]\nrepository = example-org/payments\nurl = https://example.invalid/p.git\nconsumes = guestbook\n`.replace('consumes = filter-api', 'consumes = payments'), /cycle/);
  refused(TWO.replace('contract = openapi:contract/openapi.yaml', 'contract = protobuf:filter.proto'), /OpenAPI/);
  refused(TWO.replace('run = Dockerfile:3000', 'run = Dockerfile'), /run/);
  refused(TWO.replace('path = filter-api', 'path = ../filter-api'), /path/);
  refused(TWO.replace('path = filter-api\n', ''), /folder.*path/);
  refused(TWO.replace('dir = /srv/guestbook', 'dir = srv/guestbook'), /dir/);
  refused(TWO.replace('health_url = http://127.0.0.1:8793/health', 'health_url = ftp://x'), /health_url/);
  refused(TWO.replace('repository = example-org/cleared-example-guestbook', 'repository = guestbook'), /owner\/name/);
  refused(TWO.replace('run = Dockerfile:3000', 'runs = Dockerfile:3000'), /unknown key runs/);
  refused(TWO.replace('[workspace]\nid = guestbook\n', '[workspace]\n'), /\[workspace\] id/);
  refused('[workspace]\nid = guestbook\n', /no \[service/);
  refused(`${TWO}\n[agents]\nx = 1\n`, /unknown section/);
  withWorkspaceFile(TWO, (env) => {
    assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_PROJECT: 'another' }), /CLEARED_V2_PROJECT/);
    assert.equal(loadFlowConfig({ ...env, CLEARED_V2_PROJECT: 'guestbook' })?.project, 'guestbook');
    assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_WORKSPACE: 'relative.conf' }), /absolute/);
    assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_WORKSPACE: '/nonexistent/workspace.conf' }), /cannot read/);
  });
});

// The addresses are built, not written: the guard refuses credentials in a
// URL and an email-like address in the repository's text.
function addressWith(user: string, password: string): string {
  const url = new URL('https://github.example/example-org/guestbook.git');
  url.username = user;
  url.password = password;
  return url.href;
}

test('a service url carrying credentials is refused, from the file and from CLEARED_V2_REPO_URL (review round 1, followup 2)', () => {
  const plain = 'url = https://github.com/example-org/cleared-example-guestbook.git';
  withWorkspaceFile(TWO.replace(plain, `url = ${addressWith('someone', 'not-a-token')}`), (env) =>
    assert.throws(() => loadFlowConfig(env), (error: unknown) => error instanceof FlowConfigError && /\[service guestbook\] url carries credentials/.test(error.message) && !error.message.includes('not-a-token')));
  withWorkspaceFile(TWO.replace(plain, `url = ${addressWith('only-a-name', '')}`), (env) =>
    assert.throws(() => loadFlowConfig(env), /url carries credentials/));
  assert.throws(() => loadFlowConfig({ ...M1_ENV, CLEARED_V2_REPO_URL: addressWith('x-access', 'not-a-token') }),
    (error: unknown) => error instanceof FlowConfigError && /CLEARED_V2_REPO_URL carries credentials/.test(error.message) && !error.message.includes('not-a-token'));
  // A git address over ssh names its account, not a secret.
  const ssh = `${['git', 'github.com'].join('@')}:example-org/cleared-example-guestbook.git`;
  withWorkspaceFile(TWO.replace(plain, `url = ${ssh}`), (env) =>
    assert.equal(workspaceOf(loadFlowConfig(env)!).services[0]?.url, ssh));
});

test('the one-service workspace names its service by the service name rule, and keeps the project value as its id (review round 1, followup 3)', () => {
  const config = loadFlowConfig({ ...M1_ENV, CLEARED_V2_PROJECT: 'My_Project.v2' });
  assert.equal(config?.project, 'My_Project.v2');
  assert.equal(workspaceOf(config!).id, 'My_Project.v2');
  assert.equal(workspaceOf(config!).services[0]?.name, 'my-project-v2');
  const { workspace: _workspace, ...rest } = config!;
  assert.equal(workspaceOf(rest).services[0]?.name, 'my-project-v2', 'the same name from the milestone 1 fields');
  assert.equal(workspaceOf(loadFlowConfig({ ...M1_ENV, CLEARED_V2_PROJECT: '__' })!).services[0]?.name, 'service');
  assert.equal(workspaceOf(loadFlowConfig({ ...M1_ENV, CLEARED_V2_PROJECT: 'A'.repeat(60) })!).services[0]?.name, 'a'.repeat(40));
});

test('the proof\'s workspace file, examples/workspace.conf, parses as lane 28 wrote it', () => {
  const file = new URL('../../../examples/workspace.conf', import.meta.url).pathname;
  const workspace = workspaceOf(loadFlowConfig({ CLEARED_V2_WORKSPACE: file, CLEARED_V2_STATE_DIR: '/state' })!);
  assert.equal(workspace.id, 'guestbook');
  assert.deepEqual(workspace.services.map((s) => [s.name, s.consumes, s.run?.port, s.contract?.path ?? null]), [
    ['guestbook', ['filter-api'], 8793, null],
    ['filter-api', [], 8795, 'contract/openapi.yaml'],
  ]);
});
