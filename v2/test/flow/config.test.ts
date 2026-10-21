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

test('without a verdict phrase the project cannot pass a review', () => {
  assert.throws(() => projectSettings(parseConf('[merge]\ntooling_paths = x\n')), FlowConfigError);
});

test('loadFlowConfig reads the environment and refuses what is missing or unsafe', () => {
  const env = { CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://github.com/Makhtar-s-Corp/cleared-example-guestbook.git', CLEARED_V2_REPO: 'Makhtar-s-Corp/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state' };
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
