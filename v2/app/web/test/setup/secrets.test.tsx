// The assistant's secrets step as HTML (docs/v2/milestone-5-plan.md, section
// 12, step 7 of the proof, C16): each service with its test values by name,
// the day each was set and by whom, never a value; a value that cannot be
// read said so with what to do; the form's fields labelled, the value field
// a password field; Done once a value is saved, else the step is skipped.
// Both languages, every word from the catalogs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TestValuesView } from '../../../../src/secrets/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { SecretsStep } from '../../screens/setup/steps/Secrets.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) } as never;
const step = { id: 'secrets', state: 'todo', filled: true, skippable: true, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 } as const;

const VIEW: TestValuesView = {
  workspace: true, key: 'ready',
  services: [
    { name: 'api', inWorkspace: true, values: [
      { service: 'api', name: 'PAYMENT_SANDBOX_KEY', setAt: '2026-10-25T09:00:00.000Z', setBy: 'alex', readable: true },
      { service: 'api', name: 'MAIL_TEST_PASSWORD', setAt: '2026-10-24T09:00:00.000Z', setBy: 'sam', readable: false },
    ] },
    { name: 'web', inWorkspace: true, values: [] },
  ],
};
const EMPTY: TestValuesView = { workspace: true, key: 'none', services: [{ name: 'api', inWorkspace: true, values: [] }] };

const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };

test('each service lists its values by name, with the day and the person, never a value', () => {
  each((t, language) => {
    const markup = html(<SecretsStep t={t} step={step} api={api} onDone={noop} initial={VIEW} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    const text = visibleText(markup).join(' ');
    for (const word of ['PAYMENT_SANDBOX_KEY', 'MAIL_TEST_PASSWORD', 'api', 'web', 'alex']) assert.ok(text.includes(word), `${language}: ${word}`);
    assert.ok(text.includes(language === 'en' ? '25 October' : '25 octobre'), `${language}: the day as a person reads it`);
    assert.ok(text.includes(t('test_values_unreadable')), `${language}: an unreadable value says so`);
    assert.ok(text.includes(t('test_values_none')), `${language}: a service with no value says so`);
    assert.ok(text.includes(t('test_values_warning')), `${language}: test values only, the agent reads them`);
    assert.ok(text.includes(t('test_values_next_session')), `${language}: a change reaches the next session`);
    assert.match(markup, /type="password"/, 'the value is typed in a password field');
    assert.match(markup, /autocomplete="off"/);
    assert.match(markup, /<label[^>]*for="setup-test-value-name"/, 'the name field is labelled');
    assert.match(markup, /<label[^>]*for="setup-test-value-value"/, 'the value field is labelled');
    assert.match(markup, /<label[^>]*for="setup-test-value-service"/, 'the service is picked when there are several');
    assert.match(markup, /aria-label="[^"]*PAYMENT_SANDBOX_KEY[^"]*"/, 'Remove and Replace name the value they act on');
    assert.doesNotMatch(markup, /data-act="setup_test_values_done"[^>]*disabled/, 'Done once a value is saved');
  });
});

test('nothing saved: Done is not offered, skipping is; no workspace and an unusable key are said', () => {
  each((t, language) => {
    const empty = html(<SecretsStep t={t} step={step} api={api} onDone={noop} initial={EMPTY} />);
    assert.match(empty, /data-act="setup_test_values_done"[^>]*disabled|disabled[^>]*data-act="setup_test_values_done"/, `${language}: Done waits for a value`);
    assert.doesNotMatch(empty, /setup-test-value-service/, 'one service: no choice to make');
    const none = visibleText(html(<SecretsStep t={t} step={step} api={api} onDone={noop} initial={{ workspace: false, key: 'none', services: [] }} />)).join(' ');
    assert.ok(none.includes(t('test_values_no_workspace')), language);
    const broken = html(<SecretsStep t={t} step={step} api={api} onDone={noop} initial={{ ...VIEW, key: 'unusable' }} />);
    assert.match(broken, /role="alert"/);
    assert.ok(visibleText(broken).join(' ').includes(t('test_values_key_unusable')), language);
  });
});

test('every refusal of the service has its words in both languages', () => {
  const codes = ['name', 'reserved', 'short', 'long', 'line', 'space', 'service', 'count', 'key', 'not_found', 'no_workspace', 'invalid_workspace', 'body', 'empty', 'other'];
  each((t, language) => {
    for (const code of codes) assert.doesNotMatch(t(`test_values_error_${code}`), /⟦/, `${language}: ${code}`);
  });
});

test('the words the step shares with the Services screen\'s panel are the same in both catalogs', () => {
  for (const language of ['en', 'fr']) {
    const step = JSON.parse(readFileSync(new URL(`../../../messages/setup-secrets.${language}.json`, import.meta.url), 'utf8')) as Record<string, string>;
    const services = JSON.parse(readFileSync(new URL(`../../../messages/services.${language}.json`, import.meta.url), 'utf8')) as Record<string, string>;
    const shared = Object.keys(step).filter((key) => key.startsWith('test_values_') && key !== 'test_values_title' && key !== 'test_values_intro' && !key.startsWith('test_values_step_'));
    assert.ok(shared.length > 10);
    for (const key of shared) assert.equal(services[key], step[key], `${language}: ${key}`);
  }
});
