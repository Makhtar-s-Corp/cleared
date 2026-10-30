// The setup assistant's screens as HTML (docs/v2/milestone-5-plan.md,
// section 5, lane v2-j5-assistant): the progress line with each step's
// state and time, the owner's first step, the forge and model steps, and a
// stub step; every word from the catalogs, in both languages, no raw time.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SetupView, StepView } from '../../../../src/setup/types.ts';
import { STEP_IDS } from '../../../../src/setup/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { credibleTime, setupTranslator } from '../../screens/setup/model.ts';
import { Progress } from '../../screens/setup/Setup.tsx';
import { OwnerFirst, OwnerStep } from '../../screens/setup/steps/Owner.tsx';
import { ForgeStep } from '../../screens/setup/steps/Forge.tsx';
import { ModelStep, pastedToken } from '../../screens/setup/steps/Model.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({}), post: async () => ({ status: 200, body: {} }) } as never;

const step = (id: StepView['id'], over: Partial<StepView> = {}): StepView => ({
  id, state: 'todo', filled: ['owner', 'forge', 'model'].includes(id), skippable: !['owner', 'forge', 'model'].includes(id),
  shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0, ...over,
});
const VIEW: SetupView = {
  owner: 'alex', current: 'model',
  steps: STEP_IDS.map((id) => id === 'owner' ? step(id, { state: 'done', personMs: 95_000 })
    : id === 'forge' ? step(id, { state: 'done', personMs: 130_000, machineMs: 1_400 })
      : id === 'workspace' ? step(id, { state: 'skipped' }) : step(id)),
  total: { personMs: 225_000, machineMs: 1_400 },
};

const noMark = (markup: string, what: string) => assert.doesNotMatch(markup, /⟦/, `${what}: no missing key`);
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };

// Issue #492: "Fait, 4 j 5 h" beside a step is gone; a step is its name and its mark.
test('the progress line: every step in order, the current one marked for assistive technology, no time beside any', () => {
  each((t, language) => {
    const markup = html(<Progress t={t} view={VIEW} current="model" />);
    noMark(markup, `progress ${language}`);
    assert.match(markup, /<ol class="setup-progress"/);
    assert.equal(markup.match(/<li /g)?.length, STEP_IDS.length);
    assert.equal(markup.match(/aria-current="step"/g)?.length, 1);
    assert.match(markup, /data-step="model"[^>]*aria-current="step"|aria-current="step"[^>]*data-step="model"/);
    assert.match(markup, /data-state="skipped"/);
    const text = visibleText(markup).join(' ');
    assert.doesNotMatch(text, /\bmin\b|\d\s?h\b|\d\s?j\b/, 'no time beside a step');
    assert.ok(text.includes(t('setup_state_done')), 'a state in words');
  });
});

test('a step\'s time in the fold: as a person reads it, and past an hour said so', () => {
  assert.equal(credibleTime(130_000, en), '2\u00a0min');
  assert.equal(credibleTime(40_000, en), '40s');
  assert.equal(credibleTime(4 * 86_400_000, en), en('setup_time_long'));
  assert.equal(credibleTime(4 * 86_400_000, fr), fr('setup_time_long'));
});

test('the first step: the setup code, the owner\'s name and password, each with its label and the browser\'s hints', () => {
  each((t, language) => {
    const markup = html(<OwnerFirst t={t} onMade={noop} />);
    noMark(markup, `owner first ${language}`);
    for (const id of ['setup-code', 'setup-name', 'setup-password']) assert.match(markup, new RegExp(`<label for="${id}"`), id);
    assert.match(markup, /id="setup-code"[^>]*autoComplete="one-time-code"|id="setup-code"[^>]*autocomplete="one-time-code"/i);
    assert.match(markup, /id="setup-password"[^>]*type="password"|type="password"[^>]*id="setup-password"/);
    assert.match(markup, /new-password/);
    assert.match(markup, /minLength="15"|minlength="15"/i);
  });
});

// Issue #432: no step asks for a hand-edited file. Cleared keeps the public
// half and checks the approvals with it; the line stays at hand, folded,
// for a release lock set up by hand.
test('the owner step once done: nothing to add to a repository, the public half folded for a lock set up by hand', () => {
  each((t, language) => {
    const markup = html(<OwnerStep t={t} step={VIEW.steps[0] as StepView} api={api} onDone={noop} initial={{ name: 'alex', publicKey: 'TUNvd0JRWURLMlZ3QXlFQQ', setting: 'human_public_key' }} />);
    noMark(markup, `owner ${language}`);
    assert.match(markup, /<details[^>]*>[\s\S]*human_public_key = TUNvd0JRWURLMlZ3QXlFQQ[\s\S]*<\/details>/);
    const shown = visibleText(markup.replace(/<details[\s\S]*<\/details>/, '')).join(' ');
    assert.doesNotMatch(shown, /agents\.conf|commit/i, 'nothing outside the fold asks for a file or a commit');
  });
});

test('the forge step: a hidden field, the rights a fine-grained credential needs, and once set a date, never the value', () => {
  each((t, language) => {
    const empty = html(<ForgeStep t={t} step={step('forge')} api={api} onDone={noop} initial={{ credential: { set: false } }} />);
    noMark(empty, `forge ${language}`);
    assert.match(empty, /type="password"/);
    assert.match(empty, /autoComplete="off"|autocomplete="off"/i);
    assert.match(empty, /github\.com\/settings\/personal-access-tokens/);
    for (const right of language === 'en' ? ['Contents', 'Pull requests', 'Commit statuses', 'Metadata'] : ['Contents', 'Pull requests', 'Commit statuses', 'Metadata']) assert.match(empty, new RegExp(right));
    const set = html(<ForgeStep t={t} step={step('forge', { state: 'done', doneAt: '2026-10-25T10:03:00.000Z' })} api={api} onDone={noop} initial={{ credential: { set: true, at: '2026-10-25T10:03:00.000Z', source: 'assistant' } }} />);
    noMark(set, `forge set ${language}`);
    assert.match(visibleText(set).join(' '), language === 'en' ? /25 October/ : /25 octobre/);
    const env = html(<ForgeStep t={t} step={step('forge')} api={api} onDone={noop} initial={{ credential: { set: true, at: null, source: 'environment' } }} />);
    assert.match(visibleText(env).join(' '), /GH_TOKEN/);
    assert.doesNotMatch(env, /type="password"/, 'the environment\'s credential is not replaced from here');
  });
});

// Issue #490: the step runs the command itself and takes the token.
test('the model step: one button that opens the sign-in; what it runs and the field to paste in the fold', () => {
  each((t, language) => {
    const markup = html(<ModelStep t={t} step={step('model')} api={api} onDone={noop} initial={{ credential: { set: false }, terminal: true }} />);
    noMark(markup, `model ${language}`);
    const outside = markup.replace(/<details[\s\S]*<\/details>/, '');
    assert.match(outside, /data-act="setup_terminal"/);
    assert.doesNotMatch(outside, /setup-token|type="password"/, 'nothing to copy');
    assert.match(markup, /<details[\s\S]*<code>claude setup-token<\/code>[\s\S]*type="password"/);
    const noTerminal = html(<ModelStep t={t} step={step('model')} api={api} onDone={noop} initial={{ credential: { set: false }, terminal: false }} />);
    assert.doesNotMatch(noTerminal, /data-act="setup_terminal"/);
    assert.match(noTerminal.replace(/<details[\s\S]*<\/details>/, ''), /<code>claude setup-token<\/code>[\s\S]*type="password"/, 'elsewhere: the field is the action');
  });
});

test('what a terminal did to a token is undone, and words are left alone', () => {
  const token = ['sk', 'ant', 'oat01', 'x'.repeat(40)].join('-');
  assert.equal(pastedToken(`  ${token.slice(0, 20)}\n   ${token.slice(20)} \n`), token);
  assert.equal(pastedToken(' not a token '), 'not a token');
});
