// The Services screen's Test secrets panel as HTML (docs/v2/milestone-5-plan.md,
// section 12, C16): each service of the workspace with its test values by
// name, the day each was set and by whom, never a value; a service no longer
// in the workspace listed apart so its values can be removed; the form to
// add or replace one; what the values are for and when a change takes
// effect. Both languages, every word from the catalogs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { TestValuesView } from '../../../src/secrets/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { TestValuesPanel } from '../screens/services/TestValues.tsx';
import { savedLine, testValueRefusal } from '../screens/services/test-values.ts';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('services', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('services', 'fr') });
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };

const VIEW: TestValuesView = {
  workspace: true, key: 'ready',
  services: [
    { name: 'guestbook', inWorkspace: true, values: [{ service: 'guestbook', name: 'PAYMENT_SANDBOX_KEY', setAt: '2026-10-25T09:00:00.000Z', setBy: 'alex', readable: true }] },
    { name: 'filter-api', inWorkspace: true, values: [] },
    { name: 'mail', inWorkspace: false, values: [{ service: 'mail', name: 'MAIL_TEST_PASSWORD', setAt: '2026-10-20T09:00:00.000Z', setBy: null, readable: true }] },
  ],
};

test('the panel lists each service\'s values by name, day and person, and a service gone from the workspace apart', () => {
  each((t, language) => {
    const markup = html(<TestValuesPanel t={t} view={VIEW} idPrefix="services" />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.match(markup, /<section[^>]*aria-labelledby="services-test-values-title"/);
    const text = visibleText(markup).join(' ');
    for (const word of ['guestbook', 'filter-api', 'mail', 'PAYMENT_SANDBOX_KEY', 'MAIL_TEST_PASSWORD', 'alex']) assert.ok(text.includes(word), `${language}: ${word}`);
    assert.ok(text.includes(t('test_values_gone')), `${language}: a service no longer in the workspace says so`);
    assert.ok(text.includes(t('test_values_warning')) && text.includes(t('test_values_next_session')), language);
    assert.match(markup, /<option[^>]*value="guestbook"/);
    assert.doesNotMatch(markup, /<option[^>]*value="mail"/, 'no new value for a service gone from the workspace');
    assert.match(markup, /type="password"/);
    assert.match(markup, /<label[^>]*for="services-test-value-value"/);
  });
});

test('a value\'s line says the day before the month, and the person when the service knows them', () => {
  const value = VIEW.services[0]?.values[0];
  assert.ok(value);
  assert.equal(savedLine(value, en), en('test_values_set_by', { date: '25 October', by: 'alex' }));
  assert.equal(savedLine(value, fr), fr('test_values_set_by', { date: '25 octobre', by: 'alex' }));
  assert.equal(savedLine({ ...value, setBy: null }, en), en('test_values_set', { date: '25 October' }));
});

test('a refusal is said in words, any unknown one as the general one', () => {
  each((t, language) => {
    assert.equal(testValueRefusal(t, { error: 'short' }), t('test_values_error_short'), language);
    assert.equal(testValueRefusal(t, { error: 'what is this' }), t('test_values_error_other'), language);
    assert.equal(testValueRefusal(t, null), t('test_values_error_other'), language);
  });
});

test('no workspace: the panel says so and offers no form', () => {
  each((t, language) => {
    const markup = html(<TestValuesPanel t={t} view={{ workspace: false, key: 'none', services: [] }} idPrefix="services" />);
    assert.ok(visibleText(markup).join(' ').includes(t('test_values_no_workspace')), language);
    assert.doesNotMatch(markup, /type="password"/);
  });
});
