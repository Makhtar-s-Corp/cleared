// The ask from a session's Plan tab as HTML (decision 28, matrix C11): a
// card under the plan with the question's field and Ask, which says what
// the reader reads; drawn with or without a plan, before and after the Go,
// on an ended session; in both languages, with no inline style.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionPlan, SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, SESSION_PLAN, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { PlanTab } from '../../screens/session/Tabs.tsx';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
const sentinel: Translate = (key) => `«${key}»`;

function viewOf(summary: Partial<SessionSummary> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const first = fixture.sessions[0] as SessionSummary;
  return { summary: { ...first, ...summary }, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW };
}

const card = (markup: string) => /<section class="card plan-ask"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? '';

test('the Plan tab asks about the code: the field, Ask, and what the reader reads', () => {
  const markup = html(<PlanTab view={viewOf({ service: 'guestbook' })} plan={SESSION_PLAN} t={en} />);
  const ask = card(markup);
  assert.ok(ask, 'the ask card is drawn');
  assert.match(ask, /<form[^>]*id="plan-ask"/);
  assert.match(ask, /<label[^>]*for="plan-ask-input"/);
  assert.match(ask, /<textarea[^>]*id="plan-ask-input"[^>]*maxlength="4000"/);
  assert.match(ask, /<button[^>]*type="submit"[^>]*data-act="plan_ask"|<button[^>]*data-act="plan_ask"[^>]*type="submit"/);
  assert.match(ask, /role="status"/);
  const text = visibleText(ask);
  for (const expected of ['Ask about the code', 'Your question about the code', 'Ask',
    'Read only, on the base branch of guestbook: the reader does not see this session\'s changes, and never edits, commits or pushes.'])
    assert.ok(text.includes(expected), `missing: ${expected}`);
  assert.doesNotMatch(markup, /style="/, 'no inline style');
});

test('the card is there with no plan, while the plan waits, and on an ended session; a session with no service asks every service', () => {
  const waiting: SessionPlan = { ...SESSION_PLAN, go: null };
  assert.ok(card(html(<PlanTab view={viewOf()} plan={null} t={en} />)));
  assert.ok(card(html(<PlanTab view={viewOf()} plan={waiting} t={en} />)));
  assert.ok(card(html(<PlanTab view={viewOf({ phase: 'done', status: 'Done' })} plan={SESSION_PLAN} t={en} />)));
  assert.ok(visibleText(card(html(<PlanTab view={viewOf()} plan={null} t={en} />))).some((line) => line.startsWith('Read only, on the base branch of every service')));
});

test('while the question is sent, the field and Ask wait; a note says what went wrong', () => {
  const sending = card(html(<PlanTab view={viewOf()} plan={SESSION_PLAN} t={en} ask={{ text: 'Where is an entry stored?', busy: true, status: '' }} />));
  assert.match(sending, /<textarea[^>]*disabled=""/);
  assert.match(sending, /<button[^>]*data-act="plan_ask"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-act="plan_ask"/);
  assert.match(sending, />Where is an entry stored\?<\/textarea>/);
  const refused = card(html(<PlanTab view={viewOf()} plan={SESSION_PLAN} t={en} ask={{ text: '', busy: false, status: 'Write the question first.' }} />));
  assert.match(refused, /<p class="plan-ask-note" role="status">Write the question first\.<\/p>/);
  assert.doesNotMatch(refused, /disabled=""/);
});

test('in French, every word of the card', () => {
  const text = visibleText(card(html(<PlanTab view={viewOf({ service: 'guestbook' })} plan={SESSION_PLAN} t={fr} />)));
  for (const expected of ['Interroger le code', 'Votre question sur le code', 'Demander',
    'Lecture seule, sur la branche de base de guestbook : le lecteur ne voit pas les changements de cette session, et ne modifie, ne valide ni ne pousse jamais rien.'])
    assert.ok(text.includes(expected), `missing: ${expected}`);
});

test('every word of the card is a key of the session\'s catalog, in both languages', () => {
  const keys = [...card(html(<PlanTab view={viewOf({ service: 'guestbook' })} plan={SESSION_PLAN} t={sentinel} />)).matchAll(/«([a-z_]+)»/g)].map((m) => m[1] as string);
  assert.ok(keys.includes('plan_ask_title'));
  for (const language of ['en', 'fr'] as const) {
    const catalog = { ...loadCatalog('shell', language), ...loadCatalog('session', language) };
    for (const key of keys) assert.equal(typeof catalog[key], 'string', `${language} ${key}`);
  }
});
