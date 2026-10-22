import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowConfigError, loadFlowConfig, parseConf, projectSettings } from '../../src/flow/config.ts';

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
