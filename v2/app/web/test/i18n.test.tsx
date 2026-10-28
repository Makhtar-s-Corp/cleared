// Every word the app draws comes from a catalog of the person's language
// (the owner's requests of 2026-10-23, 08:30 and 08:40, lane i18n; it
// replaces lane 37's French test and lane 35's French shell test, which
// looked for English). Every screen on the fixtures, the sign-in page, the
// sidebar, the palette and the shortcut sheet are drawn in French and in
// English, in the states the screens have, and each text a person reads or
// hears (between tags, and in aria-label, title, placeholder, alt and the
// tooltips' data-tip) must be one of:
//   - a sentence of that language's catalogs, or one of its templates with
//     its placeholders filled;
//   - what the service, the harness or the person wrote: the fixtures' own
//     strings, and the forms the app gives them (a model's name, a path's
//     file name);
//   - a text with no word in it: a number, an id, a time, a sign;
//   - pieces of those joined by " · ", as the rows join their facts.
// A key drawn marked (⟦key⟧, a key the catalog lacks) fails, and so does a
// session's status or a ticket's state in the service's English, which
// arrives as data but is said in the person's language.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import type { NextInboxItem, SessionSummary, TrainState } from '../../../src/api/types.ts';
import { DEFAULT_STATES } from '../../../src/tickets/contract.ts';
import { askFixture, platformAsk } from '../../fixtures/ask.ts';
import { contractItem, inboxFixture, knowledgeItem, leadQuestion, requestItems, sessionPlanItem, trainRelease } from '../../fixtures/inbox.ts';
import { leadFixture } from '../../fixtures/lead.ts';
import { AUTHOR_ID, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW, towerFixture } from '../../fixtures/tower.ts';
import { LANGUAGES, loadCatalog, SCREENS, type Screen } from '../../src/catalog.ts';
import { hasMark, translator, type Translate } from '../lib/i18n.ts';
import { looksLikeCommand } from '../lib/intent.ts';
import { duration, estimate, since } from '../lib/time.ts';
import { AskScreen } from '../screens/ask/Ask.tsx';
import { answerParts } from '../screens/ask/model.ts';
import { planLine, type InboxView, type Local } from '../screens/inbox/model.ts';
import { Side, Thread } from '../screens/lead/Lead.tsx';
import type { LeadView } from '../screens/lead/model.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../screens/session/model.ts';
import { formatModel, towerModel } from '../screens/tower/model.ts';
import { TowerBody } from '../screens/tower/Tower.tsx';
import { Keys } from '../shell/Kbd.tsx';
import { Login } from '../shell/Login.tsx';
import Palette from '../shell/Palette.tsx';
import { paletteItems } from '../shell/palette.ts';
import { sessionGroups, sessionRows } from '../shell/model.ts';
import { ShortcutSheet } from '../shell/Shortcuts.tsx';
import type { ScreenName } from '../lib/routes.ts';
import { html, renderIndex, renderInbox, renderLead, renderSession, renderSidebar, strings, visibleText } from './render.tsx';

type Language = 'en' | 'fr';

// A screen's translator, as the shell gives it: the shell's catalog under the screen's.
const tOf = (screen: Screen, language: Language): Translate => translator({ ...loadCatalog('shell', language), ...loadCatalog(screen, language) });

// The texts a person reads or hears: lane 34's reader, and the tooltips.
const said = (markup: string): string[] => [
  ...visibleText(markup),
  ...[...markup.matchAll(/\sdata-tip="([^"]*)"/g)].map((match) => (match[1] ?? '').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()).filter(Boolean),
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

// A language's sentences, exact, and its templates with a word of their own
// ("{n} min" has one; "{text} · {time}" has none and would match anything).
function catalogOf(language: Language): { readonly exact: ReadonlySet<string>; readonly templates: readonly RegExp[] } {
  const values = SCREENS.flatMap((screen) => Object.values(loadCatalog(screen, language)));
  const templates = values.filter((value) => /\{[a-z_]+\}/.test(value) && letters(value.replace(/\{[a-z_]+\}/g, '')) >= 1)
    .map((value) => new RegExp(`^${value.split(/\{[a-z_]+\}/).map(escape).join('.+?')}$`, 's'));
  return { exact: new Set(values.map((value) => value.trim())), templates };
}
const CATALOGS: Readonly<Record<Language, ReturnType<typeof catalogOf>>> = { en: catalogOf('en'), fr: catalogOf('fr') };

// The service's English for a session's status and a ticket's state
// (src/flow/state.ts, PHRASES and toolPhrase; src/tickets/contract.ts,
// DEFAULT_STATES), which the app says in the person's language.
const SERVICE_WORDS = new Set(['Starting', 'Working', 'Paused, waiting for you', 'Reviewing', 'Done', 'Stopped', 'Failed', 'Paused', ...Object.values(DEFAULT_STATES)]);
const servicePhrase = (text: string) => SERVICE_WORDS.has(text) || /^(?:Reading|Editing) \S+$/.test(text) || /^Searching for ./.test(text)
  || (text.startsWith('Running ') && looksLikeCommand(text.slice('Running '.length)));

// The fixtures' own words, and the forms the app gives some of them.
async function dataWords(): Promise<Set<string>> {
  const tower = await towerFixture(FIXTURE_NOW);
  const lead = await leadFixture(FIXTURE_NOW);
  const session = sessionFixture(FIXTURE_NOW);
  const inbox = inboxFixture(FIXTURE_NOW, { train: 'waiting', sessionPlan: 'medium', reading: true });
  const words = strings([tower, lead, session.sessions, session.ticket, Array.from(session.store.events.after(AUTHOR_ID)), inbox, askFixture(), platformAsk()]);
  for (const s of [...tower.sessions, ...session.sessions, ...inbox.sessions]) words.add(formatModel(s.harness, s.model));
  // An answer is drawn cut around the citations it links (P215): each piece is the answer's.
  for (const turn of askFixture().turns) for (const part of answerParts(turn.answer ?? '', turn.citations)) words.add(part.text.trim());
  // The project's and the person's names the sidebar is drawn with (render.tsx).
  words.add('Guestbook');
  words.add('alex');
  return withForms(words);
}

// A journal's event is JSON: its strings. A path is shown by its file
// name, a text by its lines, an option without its recommended mark.
function withForms(words: Set<string>): Set<string> {
  for (const word of [...words]) {
    if (/^[[{]/.test(word)) { try { strings(JSON.parse(word), words); } catch { /* not JSON */ } }
  }
  for (const word of [...words]) {
    words.add(word.replace(/ \(Recommended\)$/, ''));
    const name = word.split('/').at(-1);
    if (name) words.add(name);
    for (const line of word.split('\n')) words.add(line.replace(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ x]\]\s+)?/, '').trim());
  }
  return words;
}

// A sentence may start with a capital its catalog's fragment has not
// ("installer {packages}" heads a title as "Installer date-fns").
const cased = (text: string) => [text, text.charAt(0).toLowerCase() + text.slice(1), text.charAt(0).toUpperCase() + text.slice(1)];

function whole(text: string, language: Language, data: ReadonlySet<string>): boolean {
  // No word: a number, a time, a sign, a key's cap ("G"), a ticket's id, a commit's hash.
  if (letters(text) === 0 || text.length === 1 || /^[A-Z]+-\d+$|^[0-9a-f]{7,40}$/.test(text) || data.has(text)) return true;
  // A shortcut's keys, each a cap of the catalog's or a letter ("Ctrl K").
  if (text.split(' ').every((cap) => cap.length === 1 || CAPS[language].has(cap))) return true;
  // A command or a path the harness ran or touched is its own, in no language.
  if (looksLikeCommand(text) || (/^[\w./@:-]+$/.test(text) && /[./:]/.test(text))) return true;
  const { exact, templates } = CATALOGS[language];
  return cased(text).some((form) => exact.has(form) || templates.some((pattern) => pattern.test(form)));
}

// The keys' caps of each language (key_cap_*: Ctrl, Entrée, Échap...).
const CAPS: Readonly<Record<Language, ReadonlySet<string>>> = Object.fromEntries(LANGUAGES.map((language) => {
  const shell = loadCatalog('shell', language);
  return [language, new Set(Object.entries(shell).filter(([key]) => key.startsWith('key_cap_')).map(([, value]) => value))];
})) as unknown as Record<Language, ReadonlySet<string>>;

// The words that join two of the app's phrases into one sentence (lib/intent.ts, lib/request.ts).
const CONNECTORS: Readonly<Record<Language, RegExp>> = Object.fromEntries(LANGUAGES.map((language) => {
  const shell = loadCatalog('shell', language);
  const words = ['intent_and', 'request_then', 'request_then_ask'].map((key) => escape(shell[key] as string));
  return [language, new RegExp(`, | (?:${words.join('|')}) `)];
})) as Record<Language, RegExp>;

// A text, else its sentences, else its pieces joined by " · ", else its phrases joined by the catalog's words.
function fromCatalog(text: string, language: Language, data: ReadonlySet<string>): boolean {
  if (whole(text, language, data)) return true;
  for (const pieces of [text.split(/(?<=[.?!:])\s+/), text.split(' · ')]) {
    if (pieces.length > 1 && pieces.every((piece) => fromCatalog(piece.trim(), language, data))) return true;
  }
  // Each place a connector joins two phrases, the phrases on each side.
  for (const match of text.matchAll(new RegExp(CONNECTORS[language], 'g'))) {
    const at = match.index ?? 0;
    if (fromCatalog(text.slice(0, at), language, data) && fromCatalog(text.slice(at + match[0].length), language, data)) return true;
  }
  return false;
}

function assertCatalog(where: string, markup: string, language: Language, data: ReadonlySet<string>): void {
  assert.ok(!hasMark(markup), `${where}: a key is missing from the ${language} catalog: ${/⟦[^⟧]*⟧/.exec(markup)?.[0]}`);
  for (const text of said(markup)) {
    if (language === 'fr') assert.ok(!servicePhrase(text), `${where}: "${text}" is the service's English for a status`);
    assert.ok(fromCatalog(text, language, data), `${where} (${language}): "${text}" is from no ${language} catalog`);
  }
}

for (const language of LANGUAGES) {
  test(`${language}: the sign-in page, with each of its errors`, async () => {
    const data = await dataWords();
    const t = tOf('shell', language);
    assertCatalog('sign-in', html(<Login t={t} />), language, data);
    for (const key of ['login_wrong', 'login_refused']) assertCatalog(`sign-in ${key}`, html(<Login t={t} error={t(key)} />), language, data);
    assertCatalog('sign-in throttled', html(<Login t={t} error={t('login_throttled', { minutes: 5 })} />), language, data);
  });

  test(`${language}: the tower full and empty, the sessions index, the sidebar folded and open`, async () => {
    const data = await dataWords();
    const fixture = await towerFixture(FIXTURE_NOW);
    const t = tOf('tower', language);
    assertCatalog('tower', html(<TowerBody model={towerModel(fixture, FIXTURE_NOW)} t={t} language={language} />), language, data);
    assertCatalog('empty tower', html(<TowerBody model={towerModel({ ...fixture, inbox: [], sessions: [], plans: [], tickets: [] }, FIXTURE_NOW)} t={t} language={language} />), language, data);
    const groups = sessionGroups(sessionRows(fixture.sessions, fixture.tickets));
    assertCatalog('sidebar', renderSidebar('tower', t, { waiting: 5, lead: 'on', groups, source: 'fixtures' }), language, data);
    assertCatalog('rail', renderSidebar('tower', t, { mode: 'rail', waiting: 5, lead: 'down', groups }), language, data);
    assertCatalog('sessions index', renderIndex({ sessions: fixture.sessions, tickets: fixture.tickets, now: FIXTURE_NOW }, tOf('session', language)), language, data);
    assertCatalog('empty sessions index', renderIndex({ sessions: [], tickets: [], now: FIXTURE_NOW }, tOf('session', language)), language, data);
  });

  test(`${language}: a session, its thread, its request, its columns`, async () => {
    const data = await dataWords();
    const fixture = sessionFixture(FIXTURE_NOW);
    const model = emptyModel();
    applyAll(model, fixture.store.events.after(AUTHOR_ID));
    for (const summary of fixture.sessions) {
      const view: SessionView = { summary: summary as SessionSummary, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: 'demo-id', language, now: FIXTURE_NOW };
      assertCatalog(`session ${summary.id}`, renderSession(view, tOf('session', language)), language, data);
    }
  });

  test(`${language}: every session status, on the sessions index, the tower and the session`, async () => {
    const data = await dataWords();
    const fixture = await towerFixture(FIXTURE_NOW);
    const base = fixture.sessions[0] as SessionSummary;
    const phrases: readonly (readonly [SessionSummary['phase'], string])[] = [
      ['starting', 'Starting'], ['working', 'Working'], ['waiting_human', 'Paused, waiting for you'], ['reviewing', 'Reviewing'], ['done', 'Done'], ['stopped', 'Stopped'], ['failed', 'Failed'],
      ['working', 'Reading src/page.ts'], ['working', 'Editing src/page.ts'], ['reviewing', 'Searching for week'], ['working', 'Running npm test'],
    ];
    const sessions = phrases.map(([phase, status], n): SessionSummary => ({ ...base, id: `phase-${n}`, ticket: `LOCAL-${300 + n}`, phase, status }));
    const words = new Set([...data, ...sessions.map((s) => s.ticket), 'src/page.ts', 'page.ts', 'week', 'npm test']);
    const index = renderIndex({ sessions, tickets: fixture.tickets, now: FIXTURE_NOW }, tOf('session', language));
    assertCatalog('sessions index, every phase', index, language, words);
    if (language === 'fr') {
      for (const word of ['Démarrage', 'Au travail', 'En pause, attend votre réponse', 'En relecture', 'Terminée', 'Arrêtée', 'Arrêtée sur une erreur', 'Lit src/page.ts', 'Modifie src/page.ts', 'Cherche week', 'Lance npm test']) {
        assert.ok(said(index).includes(word), `the index says ${word}`);
      }
    }
    assertCatalog('tower, every phase', html(<TowerBody model={towerModel({ ...fixture, sessions }, FIXTURE_NOW)} t={tOf('tower', language)} language={language} />), language, words);
    const session = sessionFixture(FIXTURE_NOW);
    for (const [phase, status] of phrases) {
      const summary = { ...(session.sessions[0] as SessionSummary), phase, status };
      const view: SessionView = { summary, thread: threadOf(emptyModel()), ticket: session.ticket, siblings: [summary], me: 'demo-id', language, now: FIXTURE_NOW };
      assertCatalog(`session ${phase} ${status}`, renderSession(view, tOf('session', language)), language, words);
    }
  });

  test(`${language}: the Lead full and empty, and a question to the code`, async () => {
    const data = await dataWords();
    const fixture = await leadFixture(FIXTURE_NOW);
    const view: LeadView = { state: fixture.state, messages: fixture.messages, plans: fixture.plans, planId: null, now: FIXTURE_NOW, language, memory: null };
    assertCatalog('lead', renderLead(view, tOf('lead', language)), language, data);
    const empty = { state: { phase: 'idle' }, messages: [], plans: [], planId: null, now: FIXTURE_NOW, language, memory: null, trains: [] } as unknown as LeadView;
    assertCatalog('empty lead thread', html(<ol><Thread view={empty} t={tOf('lead', language)} /></ol>), language, data);
    assertCatalog('empty lead side', html(<Side view={empty} t={tOf('lead', language)} />), language, data);
    const t = tOf('ask', language);
    for (const ask of [askFixture(), platformAsk()]) assertCatalog(`ask ${ask.state}`, html(<AskScreen ask={ask} t={t} language={language} draft="" note="" busy={false} />), language, data);
  });

  // 13 local states for every item: slow under a loaded run (issue 257, item 1).
  test(`${language}: the inbox, every kind, waiting and handled, each detail, and what a gesture leaves`, { timeout: 60_000 }, async () => {
    const data = await dataWords();
    const fixture = inboxFixture(FIXTURE_NOW, { sessionPlan: 'medium', reading: true });
    const requests = requestItems(FIXTURE_NOW, { reviewer: { id: 'fixture-158-review', ticket: 'LOCAL-158' }, author: { id: 'fixture-160', ticket: 'LOCAL-160' } });
    const trains = (['waiting', 'blocked', 'landing', 'landed', 'rolled_back', 'halted'] as TrainState['state'][]).map((state) => ({ ...trainRelease(FIXTURE_NOW, state), id: `release:train-${state}` }));
    const items: NextInboxItem[] = [...fixture.items, ...requests, ...trains, leadQuestion(FIXTURE_NOW), sessionPlanItem(FIXTURE_NOW, 'low'), contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW)];
    const words = withForms(strings([requests, trains, leadQuestion(FIXTURE_NOW), sessionPlanItem(FIXTURE_NOW, 'low'), contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW)], new Set(data)));
    const t = tOf('inbox', language);
    const view = (overrides: Partial<InboxView>): InboxView => ({
      items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false, me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW,
      local: new Map(), frame: 'desktop', plans: new Map(fixture.plans.map((plan) => [plan.id, plan])), language, wide: true, ...overrides,
    });
    assertCatalog('inbox list', renderInbox(view({}), t, { handledOpen: true }), language, words);
    assertCatalog('empty inbox', renderInbox(view({ items: [] }), t), language, words);
    const locals: (Local | undefined)[] = [
      undefined, { kind: 'busy' }, { kind: 'confirm' }, { kind: 'grace', dueAt: new Date(FIXTURE_NOW.getTime() + 30_000).toISOString() },
      { kind: 'approved', at: FIXTURE_NOW.toISOString() }, { kind: 'sent_back', at: FIXTURE_NOW.toISOString() }, { kind: 'answered', decision: 'allow_once' },
      { kind: 'answered', decision: 'reject_once' }, { kind: 'plan_approved', at: FIXTURE_NOW.toISOString() }, { kind: 'change' },
      { kind: 'plan_go', at: FIXTURE_NOW.toISOString() }, { kind: 'plan_changed', at: FIXTURE_NOW.toISOString() }, { kind: 'settled' },
    ];
    for (const item of items) {
      for (const local of locals) {
        const markup = renderInbox(view({ selected: item.id, open: true, local: new Map(local ? [[item.id, local]] : []) }), t);
        assertCatalog(`inbox ${item.id} ${local?.kind ?? ''}`, markup, language, words);
      }
    }
  });

  test(`${language}: the palette and the shortcut sheet on every screen, the inbox's own keys included`, async () => {
    const data = await dataWords();
    const fixture = await towerFixture(FIXTURE_NOW);
    const t = tOf('tower', language);
    const model = towerModel(fixture, FIXTURE_NOW);
    for (const screen of ['tower', 'inbox', 'sessions', 'session', 'lead', 'ask'] as ScreenName[]) {
      const items = paletteItems({ screen, needs: model.needs, sessions: sessionRows(fixture.sessions, fixture.tickets), gestures: ['allow_once', 'allow_always', 'reject_once', 'takeover', 'giveback', 'new_ticket'], t });
      assertCatalog(`palette ${screen}`, html(<Palette t={t} items={items} onRun={() => {}} onClose={() => {}} />), language, data);
      for (const mac of [false, true]) assertCatalog(`sheet ${screen}`, html(<ShortcutSheet t={t} screen={screen} mac={mac} onClose={() => {}} />), language, data);
    }
  });
}

test('the French key names and the inbox\'s sheet', () => {
  const t = tOf('tower', 'fr');
  const caps = (node: ReactNode) => visibleText(html(node));
  assert.deepEqual(caps(<Keys keys={['Enter']} t={t} mac={false} />), ['Entrée']);
  assert.deepEqual(caps(<Keys keys={['Esc']} t={t} mac={false} />), ['Échap']);
  assert.deepEqual(caps(<Keys keys={['G', 'T']} t={t} mac={false} then />), ['G', 'puis', 'T']);
  const sheet = visibleText(html(<ShortcutSheet t={t} screen="inbox" mac={false} onClose={() => {}} />));
  for (const expected of ['Autoriser une fois, ou afficher la ligne choisie', 'Refuser, ou afficher la ligne choisie', 'Espace']) assert.ok(sheet.includes(expected), `missing: ${expected}`);
});

test('times, durations, numbers and plurals in each language', () => {
  const at = (minutes: number) => new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();
  const fr = tOf('inbox', 'fr');
  const en = tOf('inbox', 'en');
  assert.deepEqual([0, 12, 60, 195, 3000].map((m) => since(at(m), FIXTURE_NOW, fr)), ['à l\'instant', '12\u00a0min', '1\u00a0h', '3\u00a0h\u00a015', '2\u00a0j\u00a02\u00a0h']);
  assert.deepEqual([0, 12, 60, 195, 3000].map((m) => since(at(m), FIXTURE_NOW, en)), ['just now', '12\u00a0min', '1h', '3h\u00a015m', '2d\u00a02h']);
  assert.deepEqual([34, 60, 135].map((m) => duration(m, fr)), ['34\u00a0min', '1\u00a0h', '2\u00a0h\u00a015']);
  assert.equal(estimate(135, en), '2h\u00a015m');
  const plan = inboxFixture(FIXTURE_NOW).items.find((item) => item.kind === 'plan');
  assert.ok(plan?.kind === 'plan');
  const base = { items: [], tickets: [], sessions: [], selected: undefined, open: false, me: { id: 'u', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop' } as const;
  assert.equal(planLine({ ...plan, itemCount: 1 }, { ...base, language: 'fr' }, fr).split(' · ')[0], '1 ticket', 'the singular');
  assert.equal(planLine(plan, { ...base, language: 'fr' }, fr), '5 tickets · 2\u00a0h\u00a015 · 3,9\u202f% de la semaine', 'a decimal comma and a space before %');
  assert.equal(planLine(plan, { ...base, language: 'en' }, en), '5 tickets · 2h\u00a015m · 3.9% of the week');
  assert.equal(fr('handled_group', { n: 3 }), 'Traité · 3');
});

test('every key in both languages, with the same placeholders', () => {
  for (const screen of SCREENS) {
    const en = loadCatalog(screen, 'en');
    const fr = loadCatalog(screen, 'fr');
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort(), `${screen}: the same keys`);
  }
});

test('the test reads a word from no catalog: a hard-coded word, English in French, a missing key', async () => {
  const data = await dataWords();
  assert.throws(() => assertCatalog('planted', html(<p><span>Loading</span></p>), 'en', data), /is from no en catalog/);
  assert.throws(() => assertCatalog('planted', html(<button aria-label="Close" />), 'fr', data), /is from no fr catalog/);
  assert.throws(() => assertCatalog('sign-in', html(<Login t={tOf('shell', 'en')} />), 'fr', data), /is from no fr catalog/);
  assert.throws(() => assertCatalog('marked', html(<p>{tOf('inbox', 'fr')('no_such_key')}</p>), 'fr', data), /missing from the fr catalog/);
  assert.throws(() => assertCatalog('planted', html(<p><span>Stopped</span></p>), 'fr', new Set(['Stopped'])), /service's English/);
  assert.doesNotThrow(() => assertCatalog('planted', html(<p><span>LOCAL-161 · 12:05</span><span>{tOf('tower', 'fr')('need_release', { age: '3\u00a0min' })}</span></p>), 'fr', data));
});

// What no render above reaches (a failure's note, a state the fixtures do
// not hold): no component writes a word of its own, between tags or in an
// attribute a person reads or hears; its words are its catalog's.
function ownWords(name: string, source: string): string[] {
  const code = source.replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  for (const [, attribute, text] of code.matchAll(/\s(aria-label|title|placeholder|alt|data-tip|label)="([^"]*)"/g)) if (letters(text ?? '') >= 2) found.push(`${name}: ${attribute}="${text}"`);
  // Text between a tag's end and the next tag or expression (">Close<", "> Close {"), not code ("cond ? <A /> : <B />").
  for (const [, text] of code.matchAll(/<[A-Za-z][^<>]*?[^=]>([^<>{}]*\p{L}{2}[^<>{}]*)(?=[<{])/gu)) {
    if (text && !/[;=()?:]|&&|\|\|/.test(text)) found.push(`${name}: >${text.trim()}<`);
  }
  return found;
}

test('no component writes a visible word of its own', () => {
  const dir = new URL('..', import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.tsx') && !name.startsWith('test/'));
  assert.ok(files.length > 20);
  assert.deepEqual(files.flatMap((name) => ownWords(name, readFileSync(join(dir, name), 'utf8'))), []);
  assert.deepEqual(ownWords('planted.tsx', '<Button aria-label="Close" onClick={x}>Close</Button>'), ['planted.tsx: aria-label="Close"', 'planted.tsx: >Close<']);
  assert.deepEqual(ownWords('planted.tsx', '{busy ? <Spinner /> : <Done size={16} />}'), []);
});
