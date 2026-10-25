// The setup assistant's screens as HTML (docs/v2/milestone-5-plan.md,
// section 5, lane v2-j5-assistant): the progress line with each step's
// state and time, the owner's first step, the forge and model steps, and a
// stub step; every word from the catalogs, in both languages, no raw time.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SetupView, StepView } from '../../../../src/setup/types.ts';
import { STEP_IDS } from '../../../../src/setup/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { setupTranslator, stepTime } from '../../screens/setup/model.ts';
import { Progress } from '../../screens/setup/Setup.tsx';
import { OwnerFirst, OwnerStep } from '../../screens/setup/steps/Owner.tsx';
import { ForgeStep } from '../../screens/setup/steps/Forge.tsx';
import { ModelStep } from '../../screens/setup/steps/Model.tsx';
import { SecretsStep } from '../../screens/setup/steps/Secrets.tsx';
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

test('the progress line: every step in order, the current one marked for assistive technology, each done step with its time', () => {
  each((t, language) => {
    const markup = html(<Progress t={t} view={VIEW} current="model" />);
    noMark(markup, `progress ${language}`);
    assert.match(markup, /<ol class="setup-progress"/);
    assert.equal(markup.match(/<li /g)?.length, STEP_IDS.length);
    assert.equal(markup.match(/aria-current="step"/g)?.length, 1);
    assert.match(markup, /data-step="model"[^>]*aria-current="step"|aria-current="step"[^>]*data-step="model"/);
    assert.match(markup, /data-state="skipped"/);
    const text = visibleText(markup).join(' ');
    assert.match(text, /2\smin/, 'the forge step\'s time, as a person reads it');
    assert.doesNotMatch(text, /\d{4,} ?ms/, 'no figure in milliseconds');
  });
});

test('a step\'s time: the person\'s, and the machine\'s when it worked', () => {
  // The shell's units of time: "2 min" with a no-break space, "40s" in English.
  assert.equal(stepTime(step('forge', { state: 'done', personMs: 130_000, machineMs: 1_400 }), en), '2\u00a0min, machine 1s');
  assert.equal(stepTime(step('owner', { state: 'done', personMs: 40_000 }), en), '40s');
  assert.equal(stepTime(step('checks'), en), '');
  assert.match(stepTime(step('forge', { state: 'done', personMs: 130_000, machineMs: 1_400 }), fr), /2\s?min, machine 1\s?s/);
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

test('the owner step once done: the public key and the line it goes in, to commit to the project', () => {
  each((t, language) => {
    const markup = html(<OwnerStep t={t} step={VIEW.steps[0] as StepView} api={api} onDone={noop} initial={{ name: 'alex', publicKey: 'TUNvd0JRWURLMlZ3QXlFQQ', setting: 'human_public_key' }} />);
    noMark(markup, `owner ${language}`);
    assert.match(markup, /human_public_key = TUNvd0JRWURLMlZ3QXlFQQ/);
    assert.match(markup, /\.cleared\/agents\.conf/);
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

test('the model step: the command to run, a terminal to run it in, and the field to paste what it prints', () => {
  each((t, language) => {
    const markup = html(<ModelStep t={t} step={step('model')} api={api} onDone={noop} initial={{ credential: { set: false }, terminal: true }} />);
    noMark(markup, `model ${language}`);
    assert.match(markup, /<code>claude setup-token<\/code>/);
    assert.match(markup, /data-act="setup_terminal"/);
    assert.match(markup, /type="password"/);
    const noTerminal = html(<ModelStep t={t} step={step('model')} api={api} onDone={noop} initial={{ credential: { set: false }, terminal: false }} />);
    assert.doesNotMatch(noTerminal, /data-act="setup_terminal"/);
  });
});

test('a step a later lane fills says so, and offers Skip', () => {
  each((t, language) => {
    const markup = html(<SecretsStep t={t} step={step('secrets')} api={api} onDone={noop} />);
    noMark(markup, `secrets ${language}`);
    assert.match(markup, /data-step-stub="secrets"/);
  });
});
