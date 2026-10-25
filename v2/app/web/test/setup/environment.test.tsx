// The assistant's environment step as HTML (docs/v2/milestone-5-plan.md,
// sections 1 and 10, matrix C15): each service with what its base holds and
// its prepared image, in words beside its mark; a ready image with its
// build's time as a person reads it, a failed one with its reason and what
// to do; Build while nothing builds; no workspace said as such. Both
// languages, every word from the catalogs, no figure in milliseconds.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { EnvironmentService, EnvironmentView } from '../../../../src/container/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { EnvironmentStep, environmentSummary } from '../../screens/setup/steps/Environment.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 202, body: {} }) } as never;
const step = { id: 'environment', state: 'todo', filled: true, skippable: true, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 } as const;

const service = (over: Partial<EnvironmentService>): EnvironmentService => ({
  name: 'api', readable: true, devcontainer: 'none', install: 'npm ci', state: 'none', image: null, builtAt: null, buildMs: null, startedAt: null, error: null, ...over,
});
const MIXED: EnvironmentView = {
  workspace: true,
  services: [
    service({ name: 'api', state: 'ready', image: 'cleared-v2-prep-api:0123456789abcdef', builtAt: '2026-10-25T20:00:00.000Z', buildMs: 184_000 }),
    service({ name: 'web', devcontainer: 'dockerfile', install: null, state: 'failed', error: 'npm error code ERESOLVE' }),
    service({ name: 'jobs', devcontainer: 'image', state: 'building', startedAt: '2026-10-25T20:58:00.000Z' }),
    service({ name: 'mail', readable: false, devcontainer: null, install: null }),
  ],
};
const READY: EnvironmentView = { workspace: true, services: [MIXED.services[0] as EnvironmentService] };

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
    assert.ok(text.includes('cleared-v2-prep-api:0123456789abcdef'));
    assert.ok(text.includes('npm ci'));
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
    const markup = html(<EnvironmentStep t={t} step={step} api={api} onDone={noop} initial={{ workspace: false, services: [] }} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.match(markup, /data-environment-none/);
    assert.doesNotMatch(markup, /data-act="setup_environment_build"/);
  });
});
