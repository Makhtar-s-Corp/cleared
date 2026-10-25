// No screen says a duration in minutes above 59 (the owner's request of
// 2026-10-23, lane durations): every screen is drawn on the fixtures, in
// both languages, at the fixtures' clock and a day and two hours later,
// when every age, every running session and every wait has passed an hour
// and a day; its visible text is read for "<n> min" with n of 60 or more.
// The sessions index said "1562 min" for a session started the day before.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { NextInboxItem, SessionSummary } from '../../../src/api/types.ts';
import { contractItem, inboxFixture, knowledgeItem, leadQuestion, requestItems, sessionPlanItem, trainRelease } from '../../fixtures/inbox.ts';
import { leadFixture } from '../../fixtures/lead.ts';
import { AUTHOR_ID, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW, towerFixture } from '../../fixtures/tower.ts';
import { loadCatalog, type Screen } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import type { InboxView } from '../screens/inbox/model.ts';
import type { LeadView } from '../screens/lead/model.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../screens/session/model.ts';
import { towerModel } from '../screens/tower/model.ts';
import { TowerBody } from '../screens/tower/Tower.tsx';
import Palette from '../shell/Palette.tsx';
import { paletteItems } from '../shell/palette.ts';
import { sessionRows } from '../shell/model.ts';
import { html, renderIndex, renderInbox, renderLead, renderSession, visibleText } from './render.tsx';

const tOf = (screen: Screen, language: 'en' | 'fr'): Translate => translator({ ...loadCatalog('shell', language), ...loadCatalog(screen, language) });
const LATER = new Date(FIXTURE_NOW.getTime() + (26 * 60 + 7) * 60_000);

function minutesAbove59(where: string, markup: string): void {
  for (const text of visibleText(markup)) {
    for (const [said, n] of text.matchAll(/(\d+)\s?min\b/g)) assert.ok(Number(n) < 60, `${where}: "${text}" says ${said}`);
  }
}

async function screens(now: Date, language: 'en' | 'fr'): Promise<readonly (readonly [string, string])[]> {
  const out: [string, string][] = [];
  const tower = await towerFixture(FIXTURE_NOW);
  const model = towerModel(tower, now);
  out.push(['tower', html(<TowerBody model={model} t={tOf('tower', language)} language={language} />)]);
  out.push(['sessions index', renderIndex({ sessions: tower.sessions, tickets: tower.tickets, now }, tOf('session', language))]);
  const items = paletteItems({ screen: 'tower', needs: model.needs, sessions: sessionRows(tower.sessions, tower.tickets), gestures: [], theme: 'light', t: tOf('tower', language) });
  out.push(['palette', html(<Palette t={tOf('tower', language)} items={items} dark={false} onRun={() => {}} onClose={() => {}} />)]);

  const session = sessionFixture(FIXTURE_NOW);
  const thread = emptyModel();
  applyAll(thread, session.store.events.after(AUTHOR_ID));
  for (const summary of session.sessions) {
    const view: SessionView = { summary: summary as SessionSummary, thread: threadOf(thread), ticket: session.ticket, siblings: session.sessions, me: 'demo-id', language, now };
    out.push([`session ${summary.id}`, renderSession(view, tOf('session', language))]);
  }

  const lead = await leadFixture(FIXTURE_NOW);
  const leadView: LeadView = { state: lead.state, messages: lead.messages, plans: lead.plans, planId: null, now, language, memory: null };
  out.push(['lead', renderLead(leadView, tOf('lead', language))]);

  const inbox = inboxFixture(FIXTURE_NOW, { sessionPlan: 'medium', reading: true });
  const requests = requestItems(FIXTURE_NOW, { reviewer: { id: 'fixture-158-review', ticket: 'LOCAL-158' }, author: { id: 'fixture-160', ticket: 'LOCAL-160' } });
  const all: NextInboxItem[] = [...inbox.items, ...requests, trainRelease(FIXTURE_NOW, 'landed'), leadQuestion(FIXTURE_NOW), sessionPlanItem(FIXTURE_NOW, 'low'), contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW)];
  const view = (selected: string | undefined): InboxView => ({
    items: all, tickets: inbox.tickets, sessions: inbox.sessions, selected, open: selected !== undefined, me: { id: 'user-demo', name: 'demo' }, now,
    local: new Map(), frame: 'desktop', plans: new Map(inbox.plans.map((plan) => [plan.id, plan])), language, wide: true,
  });
  out.push(['inbox', renderInbox(view(undefined), tOf('inbox', language), { handledOpen: true })]);
  for (const item of all) out.push([`inbox ${item.id}`, renderInbox(view(item.id), tOf('inbox', language))]);
  return out;
}

for (const language of ['fr', 'en'] as const) {
  test(`every screen in ${language}, at the fixtures' clock and a day later, says no duration in minutes above 59`, { timeout: 30_000 }, async () => {
    for (const now of [FIXTURE_NOW, LATER]) {
      const drawn = await screens(now, language);
      assert.ok(drawn.length > 10);
      for (const [where, markup] of drawn) minutesAbove59(`${where} (${language}, ${now === LATER ? 'a day later' : 'the fixtures\' clock'})`, markup);
    }
  });
}

test('the reading catches a duration in minutes above 59', () => {
  assert.throws(() => minutesAbove59('planted', html(<p><span>1562 min</span></p>)), /says 1562 min/);
  assert.doesNotThrow(() => minutesAbove59('planted', html(<p><span>1 j 2 h</span><span>59 min</span><span>10 h 30</span></p>)));
});
