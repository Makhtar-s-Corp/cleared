// The forge step's choice of GitHub or GitLab as HTML (docs/v2/milestone-5-plan.md,
// section 11, lane v2-j5-gitlab): two radio buttons in a labelled group,
// GitHub first and chosen until a GitLab token is saved alone; GitLab's
// fields (its address, gitlab.com by default, and a hidden field), the scope
// and the role it needs and where to make the token; once saved, the day and
// the address, never the value. Every word from the catalogs, both languages.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ForgeView, StepView } from '../../../../src/setup/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { checkedLine, ForgeStep, GitLabFields, gitlabTokenPage } from '../../screens/setup/steps/Forge.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({}), post: async () => ({ status: 200, body: {} }) } as never;
const step: StepView = { id: 'forge', state: 'todo', filled: true, skippable: false, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 };
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };
const noMark = (markup: string, what: string) => assert.doesNotMatch(markup, /⟦/, `${what}: no missing key`);

const NOTHING: Pick<ForgeView, 'credential' | 'gitlab'> = { credential: { set: false }, gitlab: { credential: { set: false }, address: 'https://gitlab.com' } };

test('the step offers GitHub and GitLab as two radio buttons of one labelled group, GitHub chosen first', () => {
  each((t, language) => {
    const markup = html(<ForgeStep t={t} step={step} api={api} onDone={noop} initial={NOTHING} />);
    noMark(markup, `choice ${language}`);
    assert.match(markup, /<fieldset[^>]*>[\s\S]*<legend[^>]*>[\s\S]*<\/legend>/);
    const radios = markup.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    assert.equal(radios.length, 2);
    assert.match(radios[0]!, /value="github"/);
    assert.match(radios[0]!, /checked/);
    assert.match(radios[1]!, /value="gitlab"/);
    assert.doesNotMatch(radios[1]!, /checked/);
    assert.match(visibleText(markup).join(' '), /GitHub[\s\S]*GitLab/);
    assert.match(markup, /github\.com\/settings\/personal-access-tokens/, 'GitHub\'s fields, as before');
  });
});

test('GitLab\'s fields: the address, gitlab.com by default, a hidden field, the api scope and the role, and the page that makes the token on that GitLab', () => {
  assert.equal(gitlabTokenPage('https://gitlab.com'), 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Cleared&scopes=api');
  assert.equal(gitlabTokenPage('https://example.org/gitlab'), 'https://example.org/gitlab/-/user_settings/personal_access_tokens?name=Cleared&scopes=api');
  each((t, language) => {
    const markup = html(<GitLabFields t={t} address="https://gitlab.com" busy={false} error="" onSubmit={noop} />);
    noMark(markup, `gitlab ${language}`);
    assert.match(markup, /type="url"/);
    assert.match(markup, /value="https:\/\/gitlab\.com"/);
    assert.match(markup, /type="password"/);
    assert.match(markup, /autocomplete="off"/i);
    assert.match(markup, /personal_access_tokens\?name=Cleared&amp;scopes=api/);
    const text = visibleText(markup).join(' ');
    assert.match(text, /\bapi\b/);
    assert.match(text, language === 'en' ? /Developer/ : /Développeur/);
    assert.match(text, language === 'en' ? /Maintainer/ : /Mainteneur/);
    for (const id of ['setup-gitlab-address', 'setup-gitlab-value']) assert.match(markup, new RegExp(`<label[^>]*for="${id}"`), `${id} has its label`);
  });
});

test('a GitLab token saved alone: GitLab chosen, its day and its address, Replace, never a field holding it', () => {
  each((t, language) => {
    const markup = html(<ForgeStep t={t} step={step} api={api} onDone={noop} initial={{ credential: { set: false }, gitlab: { credential: { set: true, at: '2026-10-25T10:03:00.000Z', source: 'assistant' }, address: 'https://gitlab.example.org' } }} />);
    noMark(markup, `gitlab set ${language}`);
    const radios = markup.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    assert.match(radios[1]!, /checked/);
    const text = visibleText(markup).join(' ');
    assert.match(text, language === 'en' ? /25 October/ : /25 octobre/);
    assert.match(text, /gitlab\.example\.org/);
    assert.doesNotMatch(markup, /type="password"/);
    assert.match(markup, /data-act="setup_gitlab_replace"/);
  });
});

test('a GitLab token file the environment names is said, and not replaced from here', () => {
  each((t) => {
    const markup = html(<ForgeStep t={t} step={step} api={api} onDone={noop} initial={{ credential: { set: false }, gitlab: { credential: { set: true, at: null, source: 'environment' }, address: 'https://gitlab.com' } }} />);
    assert.match(visibleText(markup).join(' '), /CLEARED_V2_GITLAB_TOKEN_FILE/);
    assert.doesNotMatch(markup, /type="password"/);
  });
});

test('what GitLab answered is said with its name, not GitHub\'s', () => {
  each((t, language) => {
    const line = checkedLine(t, { forge: 'gitlab', credential: { set: true, at: null, source: 'assistant' }, repositories: 2, more: false, sample: ['example/apps/filter-api', 'example/guestbook'] });
    assert.match(line, /GitLab/);
    assert.doesNotMatch(line, /GitHub/);
    assert.match(line, /example\/guestbook/);
    assert.doesNotMatch(line, /⟦/, language);
  });
});
