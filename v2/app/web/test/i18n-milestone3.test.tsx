// The screens of milestone 3 in both languages (O23, lane j2-i18n-audit):
// Consumption, the batches, the hand-over to Codex, the Close, the Editor and
// Terminal tabs and Open in an editor. test/i18n.test.tsx draws the screens
// of milestones 1 and 2 on the fixtures; these were added after it. Each is
// drawn twice, with the real catalogs (no key drawn marked, ⟦key⟧) and with a
// translator that says «key» for every key: a word left over is one the
// component wrote itself, unless the data (the fixtures, the service's own
// reason or status) brought it.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Batch, Consumption, EditorLinks, SessionSummary } from '../../../src/api/types.ts';
import { consumptionFixture } from '../../fixtures/consumption.ts';
import { AUTHOR_ID, USER, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { LANGUAGES, loadCatalog, type Language, type Screen } from '../../src/catalog.ts';
import { EditorFrame } from '../components/editor/Editor.tsx';
import { editorSentence, editorStart, type EditorState } from '../components/editor/model.ts';
import { TerminalFrame } from '../components/terminal/Terminal.tsx';
import { closedLine, type CloseReason, type TerminalStatus } from '../components/terminal/model.ts';
import { closeFailureKey } from '../lib/close.ts';
import { hasMark, translator, type Translate } from '../lib/i18n.ts';
import { ConsumptionView } from '../screens/consumption/Consumption.tsx';
import { Composer, HandoverButton } from '../screens/session/Session.tsx';
import { SessionHead } from '../screens/session/Glance.tsx';
import { OpenInEditor, TabStrip } from '../screens/session/Tabs.tsx';
import { TABS } from '../screens/session/tabs.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../screens/session/model.ts';
import { BatchCards, BatchForm, Bar } from '../screens/tower/Tower.tsx';
import { batchRows } from '../screens/tower/model.ts';
import { html, visibleText } from './render.tsx';

const real = (screen: Screen, language: Language): Translate => translator({ ...loadCatalog('shell', language), ...loadCatalog(screen, language) });
const sentinel: Translate = (key) => `«${key}»`;
const LETTERS = /\p{L}/u;

// What is left of a draw once the catalog's words are taken out: the data's own.
function written(markup: string): string[] {
  return visibleText(markup).map((text) => text.replace(/«[^»]*»/g, '').replace(/[\s·,.:;()%$/\\|  \u2013\u2014-]+/g, ' ').trim()).filter((text) => LETTERS.test(text));
}

// A word the component wrote is the same in both languages' draws; a date or a
// number said by Intl is not ("Oct 15" and "15 oct."), so only what the two
// draws share, of three letters or more, is a word of the component's own.
function both(where: string, screen: Screen, draw: (t: Translate, language: Language) => string, data: readonly string[] = []): void {
  const left = new Map<Language, string[]>();
  for (const language of LANGUAGES) {
    const marked = draw(real(screen, language), language);
    assert.ok(!hasMark(marked), `${where} (${language}): a key is missing: ${/\u27e6[^\u27e7]*\u27e7/.exec(marked)?.[0]}`);
    left.set(language, written(draw(sentinel, language)).filter((text) => (text.match(/\p{L}/gu) ?? []).length >= 3 && !data.some((word) => text.includes(word))));
  }
  const shared = (left.get('en') ?? []).filter((text) => (left.get('fr') ?? []).includes(text));
  assert.deepEqual(shared, [], `${where}: words the component wrote itself`);
}

const item = (position: number, state: 'queued' | 'started' | 'failed', status: string, note: string | null = null) =>
  ({ position, ticket: `LOCAL-${200 + position}`, title: `Ticket ${position}`, state, status, note }) as const;
const batch: Batch = {
  id: 'batch-2', project: 'guestbook', by: 'owner', at: '2026-10-24T10:00:00.000Z', lanes: 3, running: 3, hold: { reason: 'lanes', running: 3, lanes: 3 },
  items: [item(1, 'started', 'In Progress'), item(2, 'started', 'In Review'), item(3, 'failed', 'Todo', 'the clone failed'), item(4, 'queued', 'Todo'), item(5, 'started', 'Needs Approval'), item(6, 'started', 'Ready to Ship'), item(7, 'started', 'Done')],
};
const quotaBatch: Batch = { ...batch, id: 'batch-1', hold: { reason: 'quota', window: 'five_hour', percent: 90, stop: 85 }, items: [item(1, 'queued', 'Todo')] };

test('the Consumption screen says every word from the catalogs, whatever the data (an agent unused, no quota, no cost, a lever paused)', () => {
  const data = (): Consumption => consumptionFixture('guestbook', () => FIXTURE_NOW).read('Europe/Paris');
  const full = data();
  const unused = { ...full, harnesses: full.harnesses.map((h) => (h.harness === 'codex' ? { ...h, sessions: 0, tokens: 0, quotas: [], perDay: h.perDay.map((d) => ({ ...d, tokens: 0 })) } : h)) };
  const noCost = { ...full, harnesses: full.harnesses.map((h) => ({ ...h, costUsd: null })) };
  const quiet = { ...full, harnesses: [] };
  for (const [name, value] of Object.entries({ full, unused, noCost, quiet })) {
    both(`consumption ${name}`, 'consumption', (t, language) => html(<ConsumptionView data={value} t={t} language={language} now={FIXTURE_NOW} />), ['claude-code', 'codex', 'Europe/Paris', 'Opus', 'Sonnet', 'Haiku']);
  }
  both('consumption note', 'consumption', (t, language) => html(<ConsumptionView data={full} t={t} language={language} now={FIXTURE_NOW} note={t('consumption_read_failed')} busy />), ['claude-code', 'codex', 'Opus', 'Sonnet', 'Haiku']);
});

test('the batch chip, form and cards say every word from the catalogs, with each ticket state and each hold', () => {
  both('batch bar', 'tower', (t) => html(<><Bar t={t} title="" body="" batchOpen /><Bar t={t} title="" body="" /></>));
  both('batch form', 'tower', (t) => html(<><BatchForm t={t} text="" note="" /><BatchForm t={t} text={'One\nTwo'} note={t('batch_few', { n: 2 })} busy /></>), ['One', 'Two']);
  both('batch cards', 'tower', (t) => html(<BatchCards t={t} rows={batchRows([batch, quotaBatch])} />), ['Ticket', 'LOCAL', 'the clone failed', 'batch']);
});

function view(summary: Partial<SessionSummary>, extra: Partial<SessionView> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return { summary: { ...(fixture.sessions[0] as SessionSummary), ...summary }, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...extra };
}

test('the composer says the hand-over to Codex and back, and why it is off, from the catalogs', () => {
  const cases: Partial<SessionSummary>[] = [{ harness: 'claude-code' }, { harness: 'codex' }, { harness: 'cursor' }, { role: 'reviewer' }];
  for (const summary of cases) {
    both(`composer ${JSON.stringify(summary)}`, 'session', (t) => html(<><Composer view={view(summary)} t={t} /><Composer view={view(summary)} t={t} note={t('handover_failed')} /><HandoverButton view={view(summary)} t={t} handing /></>), ['Claude Code', 'Codex', 'Cursor']);
  }
  both('composer taken over', 'session', (t) => html(<Composer view={view({ harness: 'claude-code' }, { takenOver: { by: USER, at: FIXTURE_NOW.toISOString() } as never })} t={t} />), ['Claude Code', 'Codex']);
});

test('the tabs, Open in an editor, the terminal and the editor say every word from the catalogs', () => {
  for (const tab of TABS) both(`tab ${tab}`, 'session', (t) => html(<TabStrip tab={tab} t={t} />));
  const links: EditorLinks = { mode: 'ssh', links: [{ editor: 'vscode', url: 'vscode://x' }, { editor: 'cursor', url: 'cursor://x' }] as never };
  both('open in an editor', 'session', (t) => html(<><OpenInEditor t={t} offer={links} /><OpenInEditor t={t} offer={links} expanded /><OpenInEditor t={t} offer={{ ...links, mode: 'local' }} expanded /></>));
  const reasons: CloseReason[] = ['give_back', 'idle', 'closed', 'exit', 'lost', 'refused', 'unsupported'];
  const statuses: TerminalStatus[] = [{ kind: 'opening' }, { kind: 'open', cols: 80, rows: 24 }, ...reasons.map((reason): TerminalStatus => ({ kind: 'closed', reason }))];
  for (const mode of ['harness', 'shell'] as const) {
    both(`terminal ${mode}`, 'session', (t) => html(<>{statuses.map((status, i) => <TerminalFrame key={i} t={t} status={status} mode={mode} harness="Codex" canHarness />)}</>), ['Codex']);
    for (const reason of reasons) both(`closed line ${reason} ${mode}`, 'session', (t) => closedLine(reason, t, mode));
  }
  const doc = { path: 'src/a.ts', loaded: 'a', hash: 'h' };
  const states: EditorState[] = [
    { status: 'clean', doc, text: 'a' }, { status: 'changed', doc, text: 'b' }, { status: 'saving', doc, text: 'b', sent: 'b' }, { status: 'saved', doc, text: 'b', at: FIXTURE_NOW.toISOString() },
    { status: 'conflict', doc, text: 'b', current: 'h2' }, { status: 'refused', doc, text: 'b', rule: null, reason: 'the service said no' }, { status: 'failed', doc, text: 'b' },
  ];
  for (const taken of [false, true]) {
    both(`editor ${taken}`, 'session', (t) => html(<>{states.map((state, i) => <EditorFrame key={i} t={t} state={state} taken={taken} stale={i % 2 === 0} />)}</>), ['src/a.ts', 'the service said no']);
    for (const state of states) both(`editor sentence ${state.status}`, 'session', (t) => editorSentence(state, t, { taken }), ['the service said no']);
  }
  assert.equal(editorStart({ path: 'x', text: '', hash: 'h' } as never).status, 'clean');
});

test('the Close says every refusal from the catalogs, in both languages', () => {
  for (const status of [0, 400, 401, 403, 404, 409, 500, 503]) {
    for (const screen of ['session', 'inbox'] as const) both(`close refusal ${status}`, screen, (t) => t(closeFailureKey(status), { n: 2000 }));
  }
  both('close reasons', 'session', (t) => `${t('close_empty')} ${t('close_long', { n: 2000 })}`);
  both('session head', 'session', (t) => html(<SessionHead view={view({})} t={t} />), ['LOCAL', 'Add', 'Guestbook', 'Upcoming group entries by week']);
});
