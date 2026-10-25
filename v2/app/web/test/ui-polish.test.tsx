// The polish pass over the screens the ten ideas of 2026-10-25 added (lane
// j3-ui-polish, matrix P221, docs/v2/ui-overhaul-plan.md section 5): a Done
// ticket's right column speaks of a finished ticket and draws no card that
// can only be empty; the Plan tab's question card says nothing twice and
// does not explain the interface to itself; the harness pick's words say
// the rule it applies, in the words of the rest of the app; a release with
// no picture at all says so once instead of two empty frames; the
// template's row does not repeat its chip. English and French.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Consumption, ReleaseItem, SessionSummary } from '../../../src/api/types.ts';
import { consumptionFixture } from '../../fixtures/consumption.ts';
import { inboxFixture } from '../../fixtures/inbox.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../lib/i18n.ts';
import { ConsumptionView } from '../screens/consumption/Consumption.tsx';
import { type InboxView } from '../screens/inbox/model.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../screens/session/model.ts';
import { RightCards } from '../screens/session/Session.tsx';
import { PlanAskCard } from '../screens/session/Tabs.tsx';
import { Bar } from '../screens/tower/Tower.tsx';
import { html, renderInbox, visibleText } from './render.tsx';

const of = (screen: string, language: 'en' | 'fr') => translator({ ...loadCatalog('shell', language), ...loadCatalog(screen, language) });
const LANGUAGES = ['en', 'fr'] as const;
const shown = (markup: string) => visibleText(markup).join('\n');

function sessionView(status: string): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const ticket = fixture.ticket && { ...fixture.ticket, status };
  // A ticket whose sessions changed no file and reported no check.
  const thread = threadOf(model);
  const state = thread.state && { ...thread.state, files: [], checks: [] };
  return { summary: fixture.sessions[0] as SessionSummary, thread: { ...thread, state }, ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW };
}

test('a Done ticket\'s right column says "no file changed" and "no check reported" as facts, and draws no "screen so far" card', () => {
  const words = { en: ['No file changed.', 'No check reported.', 'Screen so far'], fr: ['Aucun fichier modifié.', 'Aucune vérification annoncée.', "L'écran jusqu'ici"] };
  for (const language of LANGUAGES) {
    const [files, checks, screen] = words[language];
    const done = visibleText(html(<RightCards view={sessionView('Done')} t={of('session', language)} />));
    assert.ok(done.includes(files as string), `${language}: ${files}`);
    assert.ok(done.includes(checks as string), `${language}: ${checks}`);
    assert.ok(!done.includes(screen as string), `${language}: no card that can only be empty`);
    assert.doesNotMatch(done.join('\n'), /yet|pour l'instant|Pas encore/, `${language}: nothing waits on a Done ticket`);
  }
});

test('a ticket still running keeps its "yet" and its "screen so far" card', () => {
  const running = shown(html(<RightCards view={sessionView('In Progress')} t={of('session', 'en')} />));
  assert.match(running, /No file changed yet\./);
  assert.match(running, /No check reported yet\./);
  assert.match(running, /Screen so far/);
});

test('the Plan tab\'s question card names the question once and does not explain where the answer opens', () => {
  for (const language of LANGUAGES) {
    const t = of('session', language);
    const markup = html(<PlanAskCard service="guestbook" t={t} />);
    assert.match(markup, /<label for="plan-ask-input" class="sr-only">/, `${language}: the field keeps its name for a screen reader`);
    assert.doesNotMatch(markup, /its own page|sa propre page/, `${language}: no sentence about the interface itself`);
  }
  assert.equal(loadCatalog('session', 'en').plan_ask_opens, undefined);
  assert.equal(loadCatalog('session', 'fr').plan_ask_opens, undefined);
});

const consumption = (): Consumption => consumptionFixture('guestbook', () => FIXTURE_NOW).read('Europe/Paris');

test('Consumption says tokens as the rest of the French app does: jetons', () => {
  const markup = html(<ConsumptionView data={consumption()} t={of('consumption', 'fr')} language="fr" now={FIXTURE_NOW} />);
  assert.doesNotMatch(shown(markup), /\btokens\b/);
  assert.match(shown(markup), /\bjetons\b/);
});

test('the wins table\'s headers are short enough for a phone, and French agrees with "variantes"', () => {
  const header = (language: 'en' | 'fr') => [...html(<ConsumptionView data={consumption()} t={of('consumption', language)} language={language} now={FIXTURE_NOW} />)
    .matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(header('en'), ['Type', 'Agent', 'Ran', 'Tests passed', 'Kept']);
  assert.deepEqual(header('fr'), ['Type', 'Agent', 'Lancées', 'Tests réussis', 'Gardées']);
});

test('the harness pick\'s words say the rule it applies (the fewest tokens), never "cheapest", and call it the agent pick', () => {
  for (const language of LANGUAGES) {
    const words = { ...loadCatalog('consumption', language), ...loadCatalog('inbox', language) };
    for (const key of ['consumption_wins_sub', 'variants_pick_rule']) {
      assert.doesNotMatch(words[key] ?? '', /cheapest|moins coûteuse/, `${language} ${key}`);
      assert.match(words[key] ?? '', /fewest tokens|moins de jetons/, `${language} ${key}`);
    }
  }
  const en = { ...loadCatalog('consumption', 'en'), ...loadCatalog('inbox', 'en') };
  for (const key of ['consumption_wins_empty', 'variants_kept_fewest', 'variants_kept_fastest']) assert.match(en[key] ?? '', /agent pick/, key);
  for (const language of LANGUAGES) assert.doesNotMatch(loadCatalog('inbox', language).variant_waiting ?? '', /\blane\b/, `${language}: no lane shown to a person`);
  assert.doesNotMatch(loadCatalog('inbox', 'fr').variant_no_diff ?? '', /commité/);
});

function inboxView(release: ReleaseItem): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW);
  return { items: [release], tickets: fixture.tickets, sessions: fixture.sessions, selected: release.id, open: true, me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'phone' };
}

test('a release with no picture at all says so once, with no frames and no switch; one picture keeps both frames', () => {
  const release = inboxFixture(FIXTURE_NOW).items.find((item) => item.kind === 'release') as ReleaseItem;
  const bare: ReleaseItem = { ...release, captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } } };
  for (const language of LANGUAGES) {
    const markup = renderInbox(inboxView(bare), of('inbox', language));
    assert.equal([...markup.matchAll(/class="shot-none"/g)].length, 1, `${language}: one line`);
    assert.doesNotMatch(markup, /class="device"|data-frame=/, `${language}: no empty frame, no switch`);
    assert.doesNotMatch(shown(markup), /yet|Pas encore/, `${language}: a missing picture is not coming later`);
  }
  const one: ReleaseItem = { ...bare, captures: { ...bare.captures, after: { desktop: '/api/service/captures/after-desktop.svg', phone: null } } };
  const markup = renderInbox(inboxView(one), of('inbox', 'en'));
  assert.equal([...markup.matchAll(/class="device"/g)].length, 2);
  assert.match(markup, /data-frame="phone"/);
});

test('the template row does not repeat its chip\'s word', () => {
  for (const language of LANGUAGES) {
    const t = of('tower', language);
    const row = /<div[^>]*id="ask-templates"[\s\S]*?<\/div>/.exec(html(<Bar t={t} title="" body="" template="bug" />))?.[0] ?? '';
    assert.ok(row, 'the row is shown');
    assert.ok(!visibleText(row).includes(t('bar_template')), `${language}: "${t('bar_template')}" is said by the chip only`);
  }
});
