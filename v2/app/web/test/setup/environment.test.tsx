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
import { EnvironmentStep, environmentSummary, sessionBody } from '../../screens/setup/steps/Environment.tsx';
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

test('each service says its image in words, its build\'s time as a person reads it, and a failure what to do', () => {
  each((t, language) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={MIXED} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.match(markup, /data-environment-step/);
    assert.equal(markup.match(/<li /g)?.length, 4);
    for (const state of ['ready', 'failed', 'building', 'none']) assert.match(markup, new RegExp(`data-state="${state}"`));
    const text = visibleText(markup).join(' ');
    for (const state of ['ready', 'failed', 'building', 'none']) assert.ok(text.includes(t(`environment_state_${state}`)), `${language} ${state} in words`);
    assert.match(text, /3\s?min/, 'the build\'s time');
    assert.ok(text.includes('cleared-v2-prep-api:9f2c4e6a8b0d1f3a'));
    assert.ok(text.includes('npm ci'));
    assert.ok(text.includes(t('environment_foreign_image', { image: 'mcr.microsoft.com/devcontainers/javascript-node:24' })), 'an image not Cleared\'s says what a session needs in it');
    assert.match(text, /ERESOLVE/);
    assert.ok(text.includes(t('environment_failed_todo')));
    assert.doesNotMatch(text, /\d\s?ms\b/, 'no figure in milliseconds');
    assert.match(markup, /aria-busy="true"/, 'a build running is said to assistive technology');
    assert.match(markup, /data-act="setup_environment_build"[^>]*disabled|disabled[^>]*data-act="setup_environment_build"/, 'no second Build while one runs');
  });
});

test('all ready: the summary says so, and Build again is offered', () => {
  each((t) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={READY} />);
    assert.ok(visibleText(markup).join(' ').includes(environmentSummary(t, READY)));
    assert.match(markup, /data-act="setup_environment_build"/);
    assert.doesNotMatch(markup, /data-act="setup_environment_build"[^>]*disabled/);
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

test('each ready image says its check\'s result, a failed one its last lines; a setup session is proposed with its reason, or said running', () => {
  each((t, language) => {
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={CHECKED} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    const text = visibleText(markup).join(' ');
    assert.ok(text.includes(`npm test ${t('environment_check_failed')}`));
    assert.match(markup, /<pre class="setup-env-output" tabindex="0" aria-label="[^"]+">not ok 2 - sqlite3: command not found<\/pre>/, 'the output, reachable by keyboard and named');
    assert.match(markup, /data-env-check="passed"/);
    assert.match(text, /npm run check[^.]*1\s?min/, 'the check\'s time as a person reads it');
    assert.ok(text.includes(t('environment_no_check')), 'a service with no declared check says so');
    for (const reason of ['check_failed', 'build_failed']) {
      assert.match(markup, new RegExp(`data-env-session="${reason}"`));
      assert.ok(text.includes(t(`environment_proposal_${reason}`)), `${language} ${reason}`);
    }
    assert.equal(markup.match(/data-act="setup_environment_session"/g)?.length, 2, 'a start for each proposal with no open session');
    assert.ok(text.includes(t('environment_session_open', { ticket: 'LOCAL-7' })), 'an open session is said, not proposed again');
    assert.doesNotMatch(text, /\d\s?ms\b/);
  });
});

test('every image built but a check red: the summary says so, not that all is ready', () => {
  const view: EnvironmentView = { ...CHECKED, services: CHECKED.services.slice(0, 3) };
  each((t) => {
    assert.equal(environmentSummary(t, view), t('environment_summary_check_failed_one'));
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={view} />);
    assert.doesNotMatch(markup, /class="setup-ok setup-env-summary"/);
    const both = { ...view, services: view.services.map((s) => (s.check ? { ...s, check: { ...s.check, passed: false } } : s)) };
    assert.equal(environmentSummary(t, both), t('environment_summary_check_failed_many', { failed: 2 }));
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
  assert.equal(english.title, 'Prepare the environment of api');
  assert.match(english.body, /^## The service\n/);
  assert.match(english.body, /cleared-v2-session/);
  const french = sessionBody(fr, 'api');
  assert.equal(french.title, 'Préparer l\'environnement du service api');
  assert.match(french.body, /^## Le service\n/);
  for (const t of [en, fr]) for (const key of ['environment_error_no_flow', 'environment_error_restart', 'environment_error_unknown_service', 'environment_error_invalid']) assert.doesNotMatch(t(key), /⟦/, key);
});
