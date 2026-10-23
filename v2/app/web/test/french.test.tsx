// The whole app in French (docs/v2/ui-overhaul-plan.md, 2.5.6, lane 37; the
// owner's rule: French by default). Every screen on the fixtures, the sign-in
// page, the palette and the shortcut sheet are drawn in fr, in the states the
// screens have, and no text drawn is a marked key (a key the catalog lacks,
// lane 34's ⟦key⟧) or an English sentence of a catalog that French does not
// share. What the service or the harness wrote (a ticket's title, a
// session's phrase, the policy's sentence) is data and stays as written: a
// text equal to the fixtures' own words is not read as the app's.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { NextInboxItem, SessionSummary, TrainState } from '../../../src/api/types.ts';
import { askFixture, platformAsk } from '../../fixtures/ask.ts';
import { contractItem, inboxFixture, knowledgeItem, leadQuestion, requestItems, sessionPlanItem, trainRelease } from '../../fixtures/inbox.ts';
import { leadFixture } from '../../fixtures/lead.ts';
import { AUTHOR_ID, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW, towerFixture } from '../../fixtures/tower.ts';
import { loadCatalog, SCREENS, type Screen } from '../../src/catalog.ts';
import { hasMark, translator, type Translate } from '../lib/i18n.ts';
import { looksLikeCommand } from '../lib/intent.ts';
import { DEFAULT_STATES } from '../../../src/tickets/contract.ts';
import { AskScreen } from '../screens/ask/Ask.tsx';
import { planLine, type InboxView, type Local } from '../screens/inbox/model.ts';
import { duration, estimate, since } from '../lib/time.ts';
import type { LeadView } from '../screens/lead/model.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../screens/session/model.ts';
import { towerModel } from '../screens/tower/model.ts';
import { TowerBody } from '../screens/tower/Tower.tsx';
import { Login } from '../shell/Login.tsx';
import Palette from '../shell/Palette.tsx';
import { paletteItems } from '../shell/palette.ts';
import { sessionGroups, sessionRows } from '../shell/model.ts';
import { ShortcutSheet } from '../shell/Shortcuts.tsx';
import type { ScreenName } from '../lib/routes.ts';
import { html, renderIndex, renderInbox, renderLead, renderSession, renderSidebar, strings, visibleText } from './render.tsx';

// A screen's translator, as the shell gives it: the shell's catalog under the screen's.
const tOf = (screen: Screen, language: 'en' | 'fr'): Translate => translator({ ...loadCatalog('shell', language), ...loadCatalog(screen, language) });

// Each catalog's English that its French does not share, as exact texts and as templates.
const english = SCREENS.flatMap((screen) => {
  const en = loadCatalog(screen, 'en');
  const fr = loadCatalog(screen, 'fr');
  // A template with no word of its own ("{n}%") says nothing in a language: it is left out.
  const worded = (value: string) => (value.replace(/\{[a-z_]+\}/g, '').match(/\p{L}/gu) ?? []).length >= 2;
  return Object.entries(en).filter(([key, value]) => fr[key] !== value && worded(value)).map(([key, value]) => {
    const literal = value.split(/\{[a-z_]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?');
    return { key: `${screen}.${key}`, pattern: new RegExp(`^${literal}$`) };
  });
});

// The fixtures' own words: what the service, the harness or the person wrote.
async function dataWords(): Promise<Set<string>> {
  const tower = await towerFixture(FIXTURE_NOW);
  const lead = await leadFixture(FIXTURE_NOW);
  const session = sessionFixture(FIXTURE_NOW);
  const inbox = inboxFixture(FIXTURE_NOW, { train: 'waiting', sessionPlan: 'medium', reading: true });
  return strings([tower.sessions, tower.tickets, tower.inbox, tower.plans, lead.messages, lead.plans, lead.state, session.sessions, session.ticket, inbox.items, inbox.tickets, inbox.sessions, askFixture(), platformAsk()]);
}

// The service's English for a session's status and a ticket's state
// (src/flow/state.ts, PHRASES and toolPhrase; src/tickets/contract.ts,
// DEFAULT_STATES): they arrive as data, and the app says them in French
// (the owner's request of 2026-10-23, lane durations), so the fixtures'
// words do not excuse them.
const SERVICE_WORDS = new Set(['Starting', 'Working', 'Paused, waiting for you', 'Reviewing', 'Done', 'Stopped', 'Failed', 'Paused', ...Object.values(DEFAULT_STATES)]);
const servicePhrase = (text: string) => SERVICE_WORDS.has(text) || /^(?:Reading|Editing) \S+$/.test(text) || /^Searching for ./.test(text)
  || (text.startsWith('Running ') && looksLikeCommand(text.slice('Running '.length)));

function assertFrench(where: string, markup: string, data: ReadonlySet<string>): void {
  assert.ok(!hasMark(markup), `${where}: a key is missing from the catalog: ${/⟦[^⟧]*⟧/.exec(markup)?.[0]}`);
  for (const text of visibleText(markup)) {
    assert.ok(!servicePhrase(text), `${where}: "${text}" is the service's English for a status`);
    if (data.has(text)) continue;
    const hit = english.find(({ pattern }) => pattern.test(text));
    assert.ok(!hit, `${where}: "${text}" is the English of ${hit?.key}`);
  }
}

test('the sign-in page in French, with each of its errors', async () => {
  const data = await dataWords();
  const t = tOf('shell', 'fr');
  assertFrench('sign-in', html(<Login t={t} />), data);
  for (const key of ['login_wrong', 'login_refused']) assertFrench(`sign-in ${key}`, html(<Login t={t} error={t(key)} />), data);
  assertFrench('sign-in throttled', html(<Login t={t} error={t('login_throttled', { minutes: 5 })} />), data);
});

test('the tower, the sessions index and the sidebar in French', async () => {
  const data = await dataWords();
  const fixture = await towerFixture(FIXTURE_NOW);
  const t = tOf('tower', 'fr');
  const tower = html(<TowerBody model={towerModel(fixture, FIXTURE_NOW)} t={t} language="fr" />);
  assertFrench('tower', tower, data);
  // A request reads as the inbox reads it (lane 37's art director), not by the harness's words.
  assert.ok(visibleText(tower).includes('Installer date-fns'));
  assert.ok(!visibleText(tower).includes('Install date-fns to group dates by week'));
  assertFrench('sidebar', renderSidebar('tower', t, { waiting: 5, lead: 'on', groups: sessionGroups(sessionRows(fixture.sessions, fixture.tickets)), source: 'fixtures' }), data);
  assertFrench('sessions index', renderIndex({ sessions: fixture.sessions, tickets: fixture.tickets, now: FIXTURE_NOW }, tOf('session', 'fr')), data);
});

test('a session in French: its thread, its request, its columns', async () => {
  const data = await dataWords();
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const view: SessionView = { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: 'demo-id', language: 'fr', now: FIXTURE_NOW };
  assertFrench('session', renderSession(view, tOf('session', 'fr')), data);
});

test('the lead and a question to the code in French', async () => {
  const data = await dataWords();
  const fixture = await leadFixture(FIXTURE_NOW);
  const view: LeadView = { state: fixture.state, messages: fixture.messages, plans: fixture.plans, planId: null, now: FIXTURE_NOW, language: 'fr', memory: null };
  assertFrench('lead', renderLead(view, tOf('lead', 'fr')), data);
  const t = tOf('ask', 'fr');
  for (const ask of [askFixture(), platformAsk()]) assertFrench(`ask ${ask.state}`, html(<AskScreen ask={ask} t={t} language="fr" draft="" note="" busy={false} />), data);
});

// Issue 257, item 1: 13 local states for every item, slow under a loaded run.
test('the inbox in French: every kind, waiting and handled, each detail, and what a gesture leaves', { timeout: 30_000 }, async () => {
  const data = await dataWords();
  const fixture = inboxFixture(FIXTURE_NOW, { sessionPlan: 'medium', reading: true });
  const requests = requestItems(FIXTURE_NOW, { reviewer: { id: 'fixture-158-review', ticket: 'LOCAL-158' }, author: { id: 'fixture-160', ticket: 'LOCAL-160' } });
  const trains = (['waiting', 'blocked', 'landing', 'landed', 'rolled_back', 'halted'] as TrainState['state'][]).map((state) => ({ ...trainRelease(FIXTURE_NOW, state), id: `release:train-${state}` }));
  const items: NextInboxItem[] = [...fixture.items, ...requests, ...trains, leadQuestion(FIXTURE_NOW), sessionPlanItem(FIXTURE_NOW, 'low'), contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW)];
  const t = tOf('inbox', 'fr');
  const view = (overrides: Partial<InboxView>): InboxView => ({
    items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false, me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW,
    local: new Map(), frame: 'desktop', plans: new Map(fixture.plans.map((plan) => [plan.id, plan])), language: 'fr', wide: true, ...overrides,
  });
  assertFrench('inbox list', renderInbox(view({}), t, { handledOpen: true }), data);
  assertFrench('empty inbox', renderInbox(view({ items: [] }), t), data);
  const locals: (Local | undefined)[] = [
    undefined, { kind: 'busy' }, { kind: 'confirm' }, { kind: 'grace', dueAt: new Date(FIXTURE_NOW.getTime() + 30_000).toISOString() },
    { kind: 'approved', at: FIXTURE_NOW.toISOString() }, { kind: 'sent_back', at: FIXTURE_NOW.toISOString() }, { kind: 'answered', decision: 'allow_once' },
    { kind: 'answered', decision: 'reject_once' }, { kind: 'plan_approved', at: FIXTURE_NOW.toISOString() }, { kind: 'change' },
    { kind: 'plan_go', at: FIXTURE_NOW.toISOString() }, { kind: 'plan_changed', at: FIXTURE_NOW.toISOString() }, { kind: 'settled' },
  ];
  for (const item of items) {
    for (const local of locals) {
      const markup = renderInbox(view({ selected: item.id, open: true, local: new Map(local ? [[item.id, local]] : []) }), t);
      assertFrench(`inbox ${item.id} ${local?.kind ?? ''}`, markup, data);
    }
  }
});

test('the palette and the shortcut sheet in French, on every screen, the inbox\'s own keys included', async () => {
  const data = await dataWords();
  const fixture = await towerFixture(FIXTURE_NOW);
  const t = tOf('tower', 'fr');
  const model = towerModel(fixture, FIXTURE_NOW);
  for (const screen of ['tower', 'inbox', 'sessions', 'session', 'lead', 'ask'] as ScreenName[]) {
    const items = paletteItems({ screen, needs: model.needs, sessions: sessionRows(fixture.sessions, fixture.tickets), gestures: ['allow_once', 'allow_always', 'reject_once', 'takeover', 'giveback', 'new_ticket'], theme: 'light', t });
    assertFrench(`palette ${screen}`, html(<Palette t={t} items={items} dark={false} onRun={() => {}} onClose={() => {}} />), data);
    assertFrench(`sheet ${screen}`, html(<ShortcutSheet t={t} screen={screen} mac={false} onClose={() => {}} />), data);
  }
  const inboxSheet = visibleText(html(<ShortcutSheet t={t} screen="inbox" mac={false} onClose={() => {}} />));
  for (const expected of ['Autoriser une fois, ou afficher la ligne choisie', 'Refuser, ou afficher la ligne choisie', 'Espace']) assert.ok(inboxSheet.includes(expected), `missing: ${expected}`);
});

// Every phase a session can be in, with the service's own phrase for it,
// and the phrases it builds for a tool: the sessions index, the tower, the
// sidebar and the session's own status say them in French. "Stopped" and
// "Done" were drawn as the service wrote them.
test('every session status in French, on the sessions index, the tower and the session', async () => {
  const data = await dataWords();
  const fixture = await towerFixture(FIXTURE_NOW);
  const base = fixture.sessions[0] as SessionSummary;
  const phrases: readonly (readonly [SessionSummary['phase'], string])[] = [
    ['starting', 'Starting'], ['working', 'Working'], ['waiting_human', 'Paused, waiting for you'], ['reviewing', 'Reviewing'], ['done', 'Done'], ['stopped', 'Stopped'], ['failed', 'Failed'],
    ['working', 'Reading src/page.ts'], ['working', 'Editing src/page.ts'], ['reviewing', 'Searching for week'], ['working', 'Running npm test'],
  ];
  const sessions = phrases.map(([phase, status], n): SessionSummary => ({ ...base, id: `phase-${n}`, ticket: `LOCAL-${300 + n}`, phase, status }));
  const index = renderIndex({ sessions, tickets: fixture.tickets, now: FIXTURE_NOW }, tOf('session', 'fr'));
  assertFrench('sessions index, every phase', index, data);
  for (const word of ['Démarrage', 'Au travail', 'En pause, attend votre réponse', 'En relecture', 'Terminée', 'Arrêtée', 'Arrêtée sur une erreur', 'Lit src/page.ts', 'Modifie src/page.ts', 'Cherche week', 'Lance npm test']) {
    assert.ok(visibleText(index).includes(word), `the index says ${word}`);
  }
  const tower = html(<TowerBody model={towerModel({ ...fixture, sessions }, FIXTURE_NOW)} t={tOf('tower', 'fr')} language="fr" />);
  assertFrench('tower, every phase', tower, data);
  const session = sessionFixture(FIXTURE_NOW);
  for (const [phase, status] of phrases) {
    const summary = { ...(session.sessions[0] as SessionSummary), phase, status };
    const view: SessionView = { summary, thread: threadOf(emptyModel()), ticket: session.ticket, siblings: [summary], me: 'demo-id', language: 'fr', now: FIXTURE_NOW };
    assertFrench(`session ${phase} ${status}`, renderSession(view, tOf('session', 'fr')), data);
  }
  // The test reads the service's English as English.
  assert.throws(() => assertFrench('planted', html(<p><span>Stopped</span></p>), new Set(['Stopped'])), /service's English/);
});

test('times, durations, numbers and plurals in French', () => {
  const t = tOf('inbox', 'fr');
  const at = (minutes: number) => new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();
  assert.deepEqual([0, 12, 60, 195, 3000].map((m) => since(at(m), FIXTURE_NOW, t)), ['à l\'instant', '12 min', '1 h', '3 h 15', '2 j 2 h']);
  assert.deepEqual([34, 60, 135].map((m) => duration(m, t)), ['34 min', '1 h', '2 h 15']);
  assert.equal(estimate(135, t), '2 h 15');
  const plan = inboxFixture(FIXTURE_NOW).items.find((item) => item.kind === 'plan');
  assert.ok(plan?.kind === 'plan');
  const base = { items: [], tickets: [], sessions: [], selected: undefined, open: false, me: { id: 'u', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', language: 'fr' } as const;
  assert.equal(planLine({ ...plan, itemCount: 1 }, base, t).split(' · ')[0], '1 ticket', 'the singular');
  assert.equal(planLine(plan, base, t), '5 tickets · 2 h 15 · 3,9 % de la semaine', 'a decimal comma and a space before %');
  assert.equal(t('handled_group', { n: 3 }), 'Traité · 3');
});

test('the test reads English as English: the English app fails it', async () => {
  const data = await dataWords();
  assert.throws(() => assertFrench('sign-in', html(<Login t={tOf('shell', 'en')} />), data), /is the English of/);
  const fixture = inboxFixture(FIXTURE_NOW);
  const inbox: InboxView = { items: fixture.items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false, me: { id: 'u', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop' };
  assert.throws(() => assertFrench('inbox', renderInbox(inbox, tOf('inbox', 'en')), data), /is the English of/);
  // A key the catalogs lack is caught as a mark.
  assert.throws(() => assertFrench('marked', html(<p>{tOf('inbox', 'fr')('no_such_key')}</p>), data), /missing from the catalog/);
});
