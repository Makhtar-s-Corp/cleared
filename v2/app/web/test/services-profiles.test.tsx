// The Services screen's Agent profile panel as HTML (issue #452): the
// profile's and the environment's versions, newest first, each with its
// day, its person and what it sets; the current one marked, every other
// one with its Restore button; a refusal in words. Both languages, every
// word from the catalogs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DEFAULT_ENVIRONMENT, DEFAULT_PROFILE, type ProfilesView } from '../../../src/profiles/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { ProfilesPanel } from '../screens/services/Profiles.tsx';
import { environmentFacts, profileFacts, profileRefusal } from '../screens/services/profiles.ts';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('services', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('services', 'fr') });
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };

const VIEW: ProfilesView = {
  profile: {
    current: 3,
    versions: [
      { version: 1, body: DEFAULT_PROFILE, createdAt: '2026-10-20T09:00:00.000Z', createdBy: null, restoredFrom: null },
      { version: 2, body: { ...DEFAULT_PROFILE, harness: 'auto', authorModel: 'claude-opus-5-1', allowedTools: ['make check'] }, createdAt: '2026-10-25T09:00:00.000Z', createdBy: 'alex', restoredFrom: null },
      { version: 3, body: DEFAULT_PROFILE, createdAt: '2026-10-27T09:00:00.000Z', createdBy: 'sam', restoredFrom: 1 },
    ],
  },
  environment: {
    current: 1,
    versions: [{ version: 1, body: DEFAULT_ENVIRONMENT, createdAt: '2026-10-20T09:00:00.000Z', createdBy: null, restoredFrom: null }],
  },
};

test('the panel lists both histories newest first, the current version marked and the others restorable', () => {
  each((t, language) => {
    const markup = html(<ProfilesPanel t={t} view={VIEW} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.match(markup, /<section[^>]*aria-labelledby="profiles-title"/);
    const agent = markup.slice(markup.indexOf('data-profiles-object="agent"'), markup.indexOf('data-profiles-object="environment"'));
    const versions = [...agent.matchAll(/data-profile-version="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(versions, ['3', '2', '1'], `${language}: newest first`);
    const restore = [...markup.matchAll(/<button[^>]*data-restore="(agent|environment):(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(restore, ['agent:2', 'agent:1'], `${language}: every version but the current one`);
    const text = visibleText(markup).join(' ');
    for (const word of ['alex', 'sam', 'claude-opus-5-1', 'make check']) assert.ok(text.includes(word), `${language}: ${word}`);
    assert.ok(text.includes(t('profiles_current')), language);
    assert.ok(text.includes(t('profiles_restored_from', { version: 1 })), language);
    assert.ok(text.includes(t('profiles_intro')), language);
  });
});

test('a version\'s facts: the service\'s own where it names none', () => {
  assert.deepEqual(profileFacts(DEFAULT_PROFILE, en), [
    'Harness: Claude Code', 'Author model: the service\'s', 'Reviewer model: the service\'s', 'Role prompts: none', 'Allowed commands: Cleared\'s and the project\'s', 'MCP servers: none', 'Skills: the project\'s',
  ]);
  assert.deepEqual(profileFacts({ ...DEFAULT_PROFILE, harness: 'auto', authorModel: 'claude-opus-5-1', rolePrompts: { author: 'Be brief.', reviewer: '' }, allowedTools: ['make check'] }, en).slice(0, 5), [
    'Harness: picked automatically', 'Author model: claude-opus-5-1', 'Reviewer model: the service\'s', 'Role prompts: author', 'Allowed commands: also make check',
  ]);
  assert.deepEqual(environmentFacts(DEFAULT_ENVIRONMENT, en), [
    'Image: Cleared\'s', 'Network: the project\'s hosts', 'Allowed hosts: none added', 'CPUs: Cleared\'s', 'Memory: Cleared\'s',
  ]);
  assert.deepEqual(environmentFacts({ image: 'cleared-v2-session:custom', network: 'model-only', allowedHosts: [], cpus: '1', memory: '2g' }, en), [
    'Image: cleared-v2-session:custom', 'Network: the model API and the npm registry only', 'Allowed hosts: none added', 'CPUs: 1', 'Memory: 2g',
  ]);
  for (const fact of [...profileFacts(DEFAULT_PROFILE, fr), ...environmentFacts(DEFAULT_ENVIRONMENT, fr)]) assert.doesNotMatch(fact, /⟦/);
});

test('a refusal is said in words, any unknown one as the general one', () => {
  each((t, language) => {
    assert.equal(profileRefusal(t, { error: 'sensitive' }), t('profiles_error_sensitive'), language);
    assert.equal(profileRefusal(t, { error: 'unchanged' }), t('profiles_error_unchanged'), language);
    assert.equal(profileRefusal(t, { error: 'what is this' }), t('profiles_error_other'), language);
    assert.equal(profileRefusal(t, null), t('profiles_error_other'), language);
  });
});
