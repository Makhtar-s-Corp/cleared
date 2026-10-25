import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowConfigError, PLAN_GO_MINUTES, QUESTION_DEFAULTS, loadFlowConfig, parseConf, projectSettings, workspaceOf } from '../../src/flow/config.ts';
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

test('[session] plan_go_minutes is the delay of a session plan\'s Go, when the service sets it (lane 17)', () => {
  const read = (conf: string) => projectSettings(parseConf(`[merge]\nverdict = ok\n${conf}`));
  assert.equal(read('[session]\nplan_go_minutes = 25\n').planGoMinutes, 25);
  assert.equal(read('[session]\nplan_go_minutes = 2.5\n').planGoMinutes, 2.5);
  // Unset, the engine's default of 10 minutes applies, and the settings carry nothing new.
  assert.equal('planGoMinutes' in read(''), false);
  assert.equal(PLAN_GO_MINUTES, 10);
  for (const wrong of ['soon', '0', '-5']) assert.throws(() => read(`[session]\nplan_go_minutes = ${wrong}\n`), (error: unknown) => error instanceof FlowConfigError && /plan_go_minutes/.test(error.message), wrong);
});

test('[session] question_timeout_minutes and question_default are the project\'s own delay and default for its questions (issue #269)', () => {
  const read = (conf: string) => projectSettings(parseConf(`[merge]\nverdict = ok\n${conf}`));
  assert.equal(read('[session]\nquestion_timeout_minutes = 5\n').questionTimeoutMinutes, 5);
  assert.equal(read('[session]\nquestion_timeout_minutes = 0.5\n').questionTimeoutMinutes, 0.5);
  for (const rule of QUESTION_DEFAULTS) assert.equal(read(`[session]\nquestion_default = ${rule}\n`).questionDefault, rule);
  // Unset, the service's delay and the recommended option apply, and the settings carry nothing new.
  assert.equal('questionTimeoutMinutes' in read(''), false);
  assert.equal('questionDefault' in read(''), false);
  for (const wrong of ['soon', '0', '-5']) assert.throws(() => read(`[session]\nquestion_timeout_minutes = ${wrong}\n`), (error: unknown) => error instanceof FlowConfigError && /question_timeout_minutes/.test(error.message), wrong);
  for (const wrong of ['Recommended', 'last', 'none']) assert.throws(() => read(`[session]\nquestion_default = ${wrong}\n`), (error: unknown) => error instanceof FlowConfigError && /question_default must be one of recommended, first, park/.test(error.message), wrong);
});

test('[session] service_urls and [merge] guarded_paths reach the settings when the service sets them (lane 23)', () => {
  const read = (conf: string) => projectSettings(parseConf(`[merge]\nverdict = ok\n${conf}`));
  assert.deepEqual(read('[session]\nservice_urls = filter-api:FILTER_URL, notes:NOTES_URL\n').serviceUrls, { 'filter-api': 'FILTER_URL', notes: 'NOTES_URL' });
  assert.deepEqual(read('[merge]\nverdict = ok\nguarded_paths = deploy/, migrations/\n').guardedPaths, ['deploy/', 'migrations/']);
  assert.equal('serviceUrls' in read(''), false);
  assert.equal('guardedPaths' in read(''), false);
  for (const wrong of ['filter-api', 'filter-api:filter_url', 'Filter:FILTER_URL', 'filter-api:PATH'])
    assert.throws(() => read(`[session]\nservice_urls = ${wrong}\n`), (error: unknown) => error instanceof FlowConfigError && /service_urls/.test(error.message), wrong);
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
  assert.equal(config?.maxReviewRounds, 3, 'the author-reviewer channel\'s bound (issue 291)');
  assert.equal(loadFlowConfig({ ...env, CLEARED_V2_REVIEW_ROUNDS: '5' })?.maxReviewRounds, 5);
  assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_REVIEW_ROUNDS: '1.5' }), FlowConfigError);
  assert.equal(config?.budgetUsd, undefined);
  assert.equal(config?.workdirRoot, '/state/work');
  assert.equal(config?.steps, true, 'a ticket runs in steps (lane 23)');
  assert.equal(loadFlowConfig({ ...env, CLEARED_V2_BUDGET_USD: '7.5' })?.budgetUsd, 7.5);
  // The app's address the proof receipt links its captures to (P210); none by default.
  assert.equal(loadFlowConfig({ ...env, CLEARED_NOTIFY_LINK_BASE: 'https://cleared.example.invalid' })?.linkBase, 'https://cleared.example.invalid');
  assert.equal(loadFlowConfig(env)?.linkBase, undefined);
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
  const { workspace, authorTools, steps, questionTimeoutMs, questionLeadMs, ...rest } = config;
  // The author's host tools and the session plan's gate (lane 17), and the
  // ticket's steps (lane 23), on in every configuration the service reads;
  // so is a team's question's delay (issue #290).
  assert.equal(authorTools, true);
  assert.equal(steps, true);
  assert.equal(questionTimeoutMs, 30 * 60_000);
  assert.equal(questionLeadMs, 10 * 60_000);
  // The fields and values of the milestone 1 FlowConfig, unchanged but the
  // review rounds' default, 3 since the review channel (issue 291).
  assert.deepEqual(rest, {
    project: 'guestbook', projectDir: '/srv/guestbook', repoUrl: 'https://github.com/example-org/cleared-example-guestbook.git',
    repo: 'example-org/cleared-example-guestbook', base: 'trunk', workdirRoot: '/state/work', authorModel: 'claude-opus-5-5',
    reviewerModel: 'claude-sonnet-5-5', idleMs: 15 * 60_000, maxReviewRounds: 3, budgetUsd: undefined, mergeRetryMs: 60_000,
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

test('a contract is OpenAPI 3, JSON Schema, protobuf or events, by the prefix of its path (M11)', () => {
  for (const format of ['openapi', 'jsonschema', 'protobuf', 'events'] as const)
    withWorkspaceFile(TWO.replace('contract = openapi:contract/openapi.yaml', `contract = ${format}:contract/filter.file`), (env) =>
      assert.deepEqual(workspaceOf(loadFlowConfig(env)!).services[1]?.contract, { format, path: 'contract/filter.file' }));
});

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
  // Milestone 3 (M11): the other contract formats are read; anything else is refused with the list.
  refused(TWO.replace('contract = openapi:contract/openapi.yaml', 'contract = swagger:filter.json'), /openapi, jsonschema, protobuf, events/);
  refused(TWO.replace('contract = openapi:contract/openapi.yaml', 'contract = protobuf:../filter.proto'), /inside the repository/);
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
