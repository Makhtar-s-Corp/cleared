// The Consumption screen as HTML (O15): per agent the tokens, the curve and
// the quota with its projection before and after the reset; the cost only
// when an agent reported it; the levers as pressed buttons; in both
// languages, every word from the catalog, nothing inline, no raw time.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Consumption } from '../../../src/api/types.ts';
import { consumptionFixture } from '../../fixtures/consumption.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { ConsumptionView } from '../screens/consumption/Consumption.tsx';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('consumption', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('consumption', 'fr') });
const data = (): Consumption => consumptionFixture('guestbook', () => FIXTURE_NOW).read('Europe/Paris');
const render = (t: Translate, language: 'en' | 'fr', value = data(), note = '') =>
  html(<ConsumptionView data={value} t={t} language={language} now={FIXTURE_NOW} note={note} />);

test('the screen draws each agent with its tokens, its curve and its quota, before and after the reset', () => {
  const markup = render(en, 'en');
  assert.match(markup, /<section class="consumption"[^>]*data-screen="consumption"/);
  assert.match(markup, /<h1[^>]*>What your agents consume<\/h1>/);
  for (const harness of ['claude-code', 'codex']) {
    assert.match(markup, new RegExp(`data-harness="${harness}" data-used="yes"`));
    assert.match(markup, new RegExp(`<svg[^>]*data-curve="${harness}"`));
    assert.match(markup, new RegExp(`data-quota="${harness}" data-verdict="(?:hit|ok)"`));
  }
  assert.match(markup, /data-total="claude-code">1\.5B</);
  assert.match(markup, /data-verdict="hit"/);
  assert.match(markup, /data-headline="hit"[^>]*>At the average pace of this cycle, Codex would reach 100%/);
  assert.equal(markup.match(/data-projection="before"/g)?.length, 2);
  assert.equal(markup.match(/data-projection="after"/g)?.length, 2, 'each quota says what happens after the reset');
  assert.match(markup, /<progress class="quota-bar" max="100" value="41"/);
  assert.equal(markup.match(/<circle class="curve-dot"/g)?.length, 14, 'seven days for each of the two agents');
});

test('the cost shows for the agent that reported it only, labelled as API-equivalent and as reported, not estimated', () => {
  const markup = render(en, 'en');
  assert.match(markup, /data-cost="shown"/);
  assert.match(markup, /data-cost-row="claude-code"/);
  assert.doesNotMatch(markup, /data-cost-row="codex"/);
  assert.match(markup, /API-equivalent cost/);
  assert.match(markup, /Reported by the agent at the end of each turn, not estimated here\./);
  const none = data();
  const without = { ...none, harnesses: none.harnesses.map((h) => ({ ...h, costUsd: null })) };
  const bare = render(en, 'en', without);
  assert.doesNotMatch(bare, /data-cost=|API-equivalent|\$/, 'no cost reported: no block, no figure, no zero');
});

test('an agent that never ran says so and draws no curve; no quota says it is not measured', () => {
  const value = data();
  const quiet = { ...value, harnesses: value.harnesses.map((h) => (h.harness === 'codex' ? { ...h, sessions: 0, tokens: 0, quotas: [], perDay: h.perDay.map((d) => ({ ...d, tokens: 0 })) } : h)) };
  const markup = render(en, 'en', quiet);
  assert.match(markup, /data-harness="codex" data-used="no"/);
  assert.match(markup, /No session has run on this agent yet\./);
  assert.doesNotMatch(markup, /data-curve="codex"/);
  assert.match(markup, /No quota measured yet/);
});

test('the levers are pressed buttons with real states, and a refusal is said under them', () => {
  const markup = render(en, 'en', data(), 'The service refused this change.');
  assert.match(markup, /data-lever="model"[^>]*data-active="no"/);
  assert.match(markup, /<button[^>]*aria-pressed="true"[^>]*data-choice="model:default"[^>]*>Default<\/button>/);
  assert.match(markup, /data-choice="model:claude-haiku-5-5"[^>]*>Haiku 5\.5</);
  assert.doesNotMatch(markup, /data-choice="model:claude-sonnet-5-5"/, 'the reviewers\' model is not offered');
  assert.match(markup, /data-choice="lanes:1"[^>]*>1</);
  assert.match(markup, /data-choice="pause:pause"[^>]*>Pause</);
  assert.match(markup, /role="alert">The service refused this change\./);
  const value = data();
  const on = render(en, 'en', { ...value, levers: { model: { ...value.levers.model, choice: 'claude-haiku-5-5', current: 'claude-haiku-5-5' }, maxLanes: { choice: 1, options: [1, 2, 3] }, paused: true } });
  assert.match(on, /data-lever="pause"[^>]*data-active="yes"/);
  assert.match(on, /aria-pressed="true"[^>]*data-choice="lanes:1"/);
  assert.match(on, /Schedules are paused/);
  assert.match(on, /data-choice="pause:pause"[^>]*>Resume</);
});

test('in French every word is the catalog\'s, the percent keeps its no-break space, and nothing is a raw time', () => {
  const markup = render(fr, 'fr');
  const text = visibleText(markup).join('\n');
  assert.match(markup, /<h1[^>]*>La consommation de vos agents<\/h1>/);
  assert.match(text, /Anticiper les limites/);
  assert.match(text, /Au rythme moyen de ce cycle, Codex atteindrait 100 % le /);
  assert.match(text, /Reset dans 3\s?j\s?12\s?h/);
  assert.match(text, /Coût équivalent API/);
  assert.match(text, /Changer le modèle des prochains départs/);
  assert.match(text, /Limiter les sessions en parallèle/);
  assert.match(text, /Mettre les programmations en pause/);
  for (const page of [text, visibleText(render(en, 'en')).join('\n')]) {
    assert.doesNotMatch(page, /⟦/, 'no missing key');
    assert.doesNotMatch(page, /\d{4}-\d{2}-\d{2}T/, 'no ISO time');
    assert.doesNotMatch(page, /\b\d{6,}\s?ms\b/, 'no raw milliseconds');
  }
  assert.doesNotMatch(markup, /\sstyle=/);
  assert.ok(!markup.includes(String.fromCharCode(0x2014)), 'no em dash');
});

// Issue #270: each quota says where its figure comes from and when it was
// read; a failed reading is said, with its reason, beside the last figure.
test('the quota says its source and its time, and a failed reading is said in both languages', () => {
  const markup = render(en, 'en');
  assert.match(visibleText(markup).join('\n'), /Read [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d\d:\d\d\s[AP]M, from the agent's usage page\./);
  assert.match(visibleText(markup).join('\n'), /Read .*, from a session's report\./);
  assert.doesNotMatch(markup, /data-reading="failed"/);
  const value = data();
  const failed = { ...value, harnesses: value.harnesses.map((h) => (h.harness === 'claude-code' ? { ...h, lastReading: { at: new Date(FIXTURE_NOW.getTime() - 5 * 60_000).toISOString(), source: 'claude-code /api/oauth/usage', ok: false, error: 'the endpoint answered HTTP 503' } } : h)) };
  for (const [t, language, said] of [[en, 'en', /The last quota reading failed \(.+\): the endpoint answered HTTP 503\./], [fr, 'fr', /Le dernier relevé de quota a échoué \(.+\)\s: the endpoint answered HTTP 503\./]] as const) {
    const page = render(t, language, failed);
    assert.match(page, /data-quota="claude-code" data-verdict="ok"[\s\S]*data-reading="failed"/, 'the figure stays, the failure beside it');
    assert.match(visibleText(page).join('\n'), said);
    assert.doesNotMatch(visibleText(page).join('\n'), /\d{4}-\d{2}-\d{2}T/);
  }
  // No figure at all, and the reading failed: still said.
  const none = { ...failed, harnesses: failed.harnesses.map((h) => (h.harness === 'claude-code' ? { ...h, quotas: [] } : h)) };
  assert.match(render(en, 'en', none), /No quota measured yet[\s\S]*data-reading="failed"/);
});
