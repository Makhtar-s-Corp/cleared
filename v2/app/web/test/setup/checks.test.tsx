// The assistant's checks step as HTML (docs/v2/milestone-5-plan.md, section
// 7, issue #415): each line with its level in words, what to do under a
// failure and never under a passed line, the summary with how many failed
// and how long the run took, in both languages, every word from the catalogs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ChecksView } from '../../../../src/doctor/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { ChecksStep, checksSummary } from '../../screens/setup/steps/Checks.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) } as never;
const step = { id: 'checks', state: 'todo', filled: true, skippable: true, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 } as const;

const FAILED: ChecksView = {
  failed: 1, tookMs: 2_400,
  lines: [
    { id: 'docker', level: 'ok', text: 'Docker 29.8.1 answers.' },
    { id: 'forge', level: 'fail', text: 'GitHub refuses the token (401).', todo: 'Make a new one on GitHub.' },
    { id: 'repository', level: 'off', text: 'Waits for a GitHub token that passes.' },
    { id: 'disk', level: 'notice', text: '12 GB free on the state folder\'s disk.', todo: 'Free some space on that disk.' },
    { id: 'state', level: 'ok', text: 'The state folder is this account\'s.', todo: 'never shown under a passed line' },
  ],
};
const WELL: ChecksView = { failed: 0, tookMs: 1_200, lines: FAILED.lines.filter((line) => line.level === 'ok') };

const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };

test('each line says its level in words, a failure and a notice say what to do, a passed line never does', () => {
  each((t, language) => {
    const markup = html(<ChecksStep t={t} step={step} api={api} onDone={noop} initial={FAILED} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.equal(markup.match(/<li /g)?.length, 5);
    for (const level of ['ok', 'fail', 'notice', 'off']) assert.match(markup, new RegExp(`data-level="${level}"`));
    const text = visibleText(markup).join(' ');
    for (const level of ['ok', 'fail', 'notice', 'off']) assert.ok(text.includes(t(`checks_level_${level}`)), `${language} ${level} in words`);
    assert.ok(text.includes('Make a new one on GitHub.'));
    assert.ok(text.includes('Free some space on that disk.'));
    assert.ok(!text.includes('never shown under a passed line'));
    assert.match(markup, /role="status"/);
    assert.match(markup, /data-act="setup_checks_again"/);
    assert.ok(text.includes('cleared doctor'), 'the same checks from a terminal');
  });
});

test('the summary: how many failed of how many, or none and how long it took, as a person reads it', () => {
  assert.equal(checksSummary(en, FAILED), '1 check failed, of 5. Fix it, then check again.');
  assert.equal(checksSummary(en, { ...FAILED, failed: 2 }), '2 checks failed, of 5. Fix them, then check again.');
  assert.equal(checksSummary(en, WELL), '2 checks, none failed, in 1s.');
  assert.match(checksSummary(fr, WELL), /^2 vérifications, aucune en échec, en 1\s?s\.$/);
  assert.doesNotMatch(checksSummary(en, { ...WELL, tookMs: 65_000 }), /\d{4,}|ms/);
});

test('all passed: the summary is the green one, and no note about notices', () => {
  each((t) => {
    const markup = html(<ChecksStep t={t} step={step} api={api} onDone={noop} initial={WELL} />);
    assert.match(markup, /class="setup-ok setup-checks-summary"/);
    assert.ok(!visibleText(markup).join(' ').includes(t('checks_notices')));
  });
});
