// The assistant's environment step as HTML (docs/v2/milestone-5-plan.md,
// sections 1 and 10, matrix C15): each service with what its base holds and
// its prepared image, in words beside its mark; a ready image with its
// build's time as a person reads it, a failed one with its reason and what
// to do; Build while nothing builds; no workspace said as such; the declared
// check's result in a ready image, and the setup session proposed with its
// reason, started, running, or waiting for a restart (C4). Both languages,
// every word from the catalogs, no figure in milliseconds.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { EnvironmentService, EnvironmentView } from '../../../../src/container/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { EnvironmentStep, checkReason, environmentSummary, sessionBody } from '../../screens/setup/steps/Environment.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 202, body: {} }) } as never;
const step = { id: 'environment', state: 'todo', filled: true, skippable: true, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 } as const;

const service = (over: Partial<EnvironmentService>): EnvironmentService => ({
  name: 'api', readable: true, devcontainer: 'none', foreignImage: null, install: 'npm ci', state: 'none', image: null, builtAt: null, buildMs: null, startedAt: null, error: null,
  checkCommand: null, check: null, proposal: null, setupTicket: null, ...over,
});
const MIXED: EnvironmentView = {
  workspace: true, sessions: 'ready',
  services: [
    service({ name: 'api', state: 'ready', image: 'cleared-v2-prep-api:9f2c4e6a8b0d1f3a', builtAt: '2026-10-25T20:00:00.000Z', buildMs: 184_000 }),
    service({ name: 'web', devcontainer: 'dockerfile', install: null, state: 'failed', error: 'npm error code ERESOLVE' }),
    service({ name: 'jobs', devcontainer: 'image', foreignImage: 'mcr.microsoft.com/devcontainers/javascript-node:24', state: 'building', startedAt: '2026-10-25T20:58:00.000Z' }),
    service({ name: 'mail', readable: false, devcontainer: null, install: null }),
  ],
};
const READY: EnvironmentView = { workspace: true, sessions: 'ready', services: [MIXED.services[0] as EnvironmentService] };

const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };

test('each service says its state in a word; its image, its time and what failed are in the fold', () => {
  each((t, language) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={MIXED} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.match(markup, /data-environment-step/);
    assert.equal(markup.match(/<li class="setup-env-item"/g)?.length, 4);
    for (const state of ['ready', 'failed', 'building', 'none']) assert.match(markup, new RegExp(`data-state="${state}"`));
    const outside = visibleText(markup.replace(/<details[\s\S]*<\/details>/, '')).join(' ');
    for (const state of ['ready', 'failed', 'building', 'none']) assert.ok(outside.includes(t(`environment_state_${state}`)), `${language} ${state} in words`);
    assert.ok(outside.includes(t('environment_failed')), 'a failure says what can be done');
    assert.doesNotMatch(outside, /devcontainer|install_command|agents\.conf|cleared-v2-prep|ERESOLVE/, 'no file or setting in the sentences');
    const text = visibleText(markup).join(' ');
    assert.match(text, /3\s?min/, 'the build\'s time, in the fold');
    assert.ok(text.includes('cleared-v2-prep-api:9f2c4e6a8b0d1f3a'));
    assert.ok(text.includes('npm ci'));
    assert.ok(text.includes(t('environment_foreign_image', { image: 'mcr.microsoft.com/devcontainers/javascript-node:24' })), 'an image not Cleared\'s says what a session needs in it');
    assert.match(text, /ERESOLVE/);
    assert.doesNotMatch(text, /\d\s?ms\b/, 'no figure in milliseconds');
    assert.match(markup, /aria-busy="true"/, 'a build running is said to assistive technology');
    assert.doesNotMatch(markup, /data-act="setup_environment_build"/, 'no Build while one runs');
  });
});

test('all ready: nothing to do, and building again is in the fold', () => {
  each((t) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={READY} />);
    assert.doesNotMatch(markup.replace(/<details[\s\S]*<\/details>/, ''), /data-act="setup_environment_build"/);
    assert.match(markup, /<details[\s\S]*data-act="setup_environment_build"/);
    assert.ok(visibleText(markup).join(' ').includes(t('environment_state_ready')));
    assert.ok(environmentSummary(t, READY).length > 0);
  });
});

test('nothing installed: one primary action, Prepare', () => {
  const view: EnvironmentView = { workspace: true, sessions: 'ready', services: [service({})] };
  each((t) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={view} />);
    assert.match(markup, /class="[^"]*primary[^"]*"[^>]*data-act="setup_environment_build"|data-act="setup_environment_build"[^>]*class="[^"]*primary/);
    assert.equal(markup.match(/primary/g)?.length, 1);
  });
});

test('no workspace yet: said, with no Build', () => {
  each((t, language) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={{ workspace: false, services: [], sessions: 'no_flow' }} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.match(markup, /data-environment-none/);
    assert.doesNotMatch(markup, /data-act="setup_environment_build"/);
  });
});

const READY_AT = { state: 'ready' as const, image: 'cleared-v2-prep-api:9f2c4e6a8b0d1f3a', builtAt: '2026-10-25T20:00:00.000Z', buildMs: 184_000 };
const CHECKED: EnvironmentView = {
  workspace: true, sessions: 'ready',
  services: [
    service({ name: 'api', ...READY_AT, checkCommand: 'npm test', check: { command: 'npm test', passed: false, at: '2026-10-25T20:01:00.000Z', ms: 4_200, tail: 'not ok 2 - sqlite3: command not found' }, proposal: 'check_failed' }),
    service({ name: 'web', ...READY_AT, devcontainer: 'image', checkCommand: 'npm run check', check: { command: 'npm run check', passed: true, at: '2026-10-25T20:01:00.000Z', ms: 65_000, tail: '# pass 4' } }),
    service({ name: 'jobs', ...READY_AT, checkCommand: null, proposal: 'no_devcontainer', setupTicket: 'LOCAL-7' }),
    service({ name: 'mail', state: 'failed', error: 'E: Unable to locate package sqlite3', proposal: 'build_failed', checkCommand: 'npm test' }),
  ],
};

test('tests that fail are explained in one sentence, a start for each; a session running is shown live; the lines are in the fold', () => {
  each((t, language) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={CHECKED} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    const text = visibleText(markup).join(' ');
    assert.ok(text.includes(t('environment_check_missing')), 'a tool is missing from what was installed');
    assert.match(markup, /<pre class="setup-env-output" tabindex="0" aria-label="[^"]+" data-env-check="failed">not ok 2 - sqlite3: command not found<\/pre>/, 'the output, reachable by keyboard and named');
    assert.match(text, /npm run check[^.]*1\s?min/, 'the check\'s time as a person reads it');
    assert.ok(text.includes(t('environment_detail_check_none')), 'a service with no declared check says so');
    assert.equal(markup.replace(/<details[\s\S]*<\/details>/, '').match(/data-act="setup_environment_session"/g)?.length, 2, 'a start for each failure with no open session');
    assert.ok(text.includes(t('environment_session_doing', { service: 'jobs' })), 'an open session is said, not proposed again');
    assert.match(markup, /data-setup-live=/, 'its live state');
    assert.doesNotMatch(text, /\d\s?ms\b/);
  });
});

// The owner's report: tests fail because nothing is installed, with no human explanation.
test('why the tests fail, from what they printed', () => {
  const failing = (tail: string, install: string | null) => service({ install, check: { command: 'npm test', passed: false, at: '2026-10-25T20:01:00.000Z', ms: 1, tail } });
  assert.equal(checkReason(failing('sh: 1: vitest: not found', null)), 'none_installed');
  assert.equal(checkReason(failing('Error: Cannot find module x', 'npm ci')), 'missing');
  assert.equal(checkReason(failing('not ok 3 - totals', 'npm ci')), 'other');
  each((t) => {
    for (const reason of ['none_installed', 'missing', 'other']) {
      assert.doesNotMatch(t(`environment_check_${reason}`), /⟦|devcontainer|agents\.conf/);
    }
  });
});

test('with no flow, or a flow that read the workspace before, the proposal waits for a restart and offers no start', () => {
  for (const sessions of ['no_flow', 'restart'] as const) {
    each((t) => {
      const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={{ ...CHECKED, sessions }} />);
      assert.doesNotMatch(markup, /data-act="setup_environment_session"/);
      assert.ok(visibleText(markup).join(' ').includes(t('environment_session_restart')));
    });
  }
});

test('the setup session\'s ticket is the tower\'s Environment template, in the person\'s language, named after the service', () => {
  const english = sessionBody(en, 'api');
  assert.equal(english.service, 'api');
  assert.equal(english.title, 'Prepare the environment of the api service');
  assert.match(english.body, /^## The service\n/);
  assert.match(english.body, /cleared-v2-session/);
  const french = sessionBody(fr, 'api');
  assert.equal(french.title, 'Préparer l\'environnement du service api');
  assert.match(french.body, /^## Le service\n/);
  for (const t of [en, fr]) for (const key of ['environment_error_no_flow', 'environment_error_restart', 'environment_error_unknown_service', 'environment_error_invalid']) assert.doesNotMatch(t(key), /⟦/, key);
});
