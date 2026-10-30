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

test('every line is in the fold, its level in words, a failure and a notice saying what to do, a passed line never', () => {
  each((t, language) => {
    const markup = html(<ChecksStep t={t} step={step} api={api} onDone={noop} initial={FAILED} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.equal(markup.match(/<li class="setup-check"/g)?.length, 5);
    assert.match(markup, /<details class="setup-detail">[\s\S]*data-check="docker"/, 'in the fold');
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

// The owner's request of 2026-10-30: 14 lines of plumbing became one sentence.
test('the summary: everything is ready, or how many things to fix', () => {
  assert.equal(checksSummary(en, FAILED), 'One thing to fix.');
  assert.equal(checksSummary(en, { ...FAILED, failed: 2 }), '2 things to fix.');
  assert.equal(checksSummary(en, WELL), 'Everything is ready.');
  assert.equal(checksSummary(fr, WELL), 'Tout est prêt.');
});

test('all passed: the summary is the green one, and no note about notices', () => {
  each((t) => {
    const markup = html(<ChecksStep t={t} step={step} api={api} onDone={noop} initial={WELL} />);
    assert.match(markup, /class="setup-ok setup-checks-summary"/);
    assert.ok(!visibleText(markup).join(' ').includes(t('checks_notices')));
  });
});

test('what needs an action is outside the fold: one sentence and its button, nothing about what passed', () => {
  each((t) => {
    const markup = html(<ChecksStep t={t} step={step} api={api} onDone={noop} initial={FAILED} />);
    const shown = visibleText(markup.replace(/<details[\s\S]*<\/details>/, '')).join(' ');
    assert.ok(shown.includes(t('checks_fail_forge')));
    assert.match(markup.replace(/<details[\s\S]*<\/details>/, ''), /data-fix="forge"[\s\S]*href="\/setup\/forge"/);
    assert.ok(!shown.includes('Docker 29.8.1'), 'what passed stays in the fold');
    assert.ok(!shown.includes('12 GB'), 'a notice too');
    const well = html(<ChecksStep t={t} step={step} api={api} onDone={noop} initial={WELL} />);
    assert.ok(visibleText(well.replace(/<details[\s\S]*<\/details>/, '')).join(' ').includes(t('checks_ready')));
  });
});
