// The inbox's milestone 2 items as HTML: the lead's plan (the capture's plan
// card, its detail with lane 8's plan panel and Approve, its handled state)
// and the lead's question, which is answered on the lead's screen. The lead's
// ticket is a sentinel that the screen never shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, Plan, PlanItemInbox, QuestionItem } from '../../../src/api/types.ts';
import { LEAD_TICKET as SERVICE_LEAD_TICKET } from '../../../src/lead/contract.ts';
import { LEAD_QUESTION_TEXT, PLAN_ID, PLAN_TITLE, inboxFixture, leadQuestion, planItemOf, proposedPlan } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../../public/i18n.ts';
import { ApiError } from '../../public/screen.ts';
import { LEAD_TICKET, afterPlanRefusal, detailKey, failure, ordered, readPlan, renderInbox, type InboxView, type Local } from '../../public/screens/inbox.ts';
import { strings, visibleText } from '../session/support.ts';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator(loadCatalog('inbox', 'en'));
const fr = translator(loadCatalog('inbox', 'fr'));

function viewOf(overrides: Partial<InboxView> = {}): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW);
  return {
    items: fixture.items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop',
    plans: new Map(fixture.plans.map((plan) => [plan.id, plan])), language: 'en', ...overrides,
  };
}

const planItem = () => inboxFixture(FIXTURE_NOW).items.find((i): i is PlanItemInbox => i.kind === 'plan') as PlanItemInbox;
const acts = (html: string) => [...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]);
const lineOf = (html: string, id: string) => new RegExp(`data-item="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?<span class="item-line">([^<]*)</span>`).exec(html)?.[1];

test('the screen\'s lead ticket is the service\'s', () => {
  assert.equal(LEAD_TICKET, SERVICE_LEAD_TICKET);
});

test('the plan card reads as the capture\'s: Plan, its age, its title, its tickets, its time and its share of the week', () => {
  const html = renderInbox(viewOf(), en);
  const shown = visibleText(html);
  for (const expected of ['4 waiting', 'Plan', '25 min', PLAN_TITLE]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  assert.equal(lineOf(html, `plan:${PLAN_ID}`), '5 tickets · 2 h 15 · 3.9 % of the week');
  const order = [...html.matchAll(/data-item="([^"]+)"/g)].map((m) => m[1]?.split(':')[0]);
  assert.deepEqual(order, ['release', 'permission', 'plan', 'question', 'permission'], 'the capture\'s order: release, permission, plan, question');
});

test('without a measured week the card says the cost, and one ticket is in the singular', () => {
  const item = planItem();
  const cost: PlanItemInbox = { ...item, totals: { ...item.totals, weekPercent: null } };
  assert.equal(lineOf(renderInbox(viewOf({ items: [cost] }), en), cost.id), '5 tickets · 2 h 15 · about $3.05');
  assert.equal(lineOf(renderInbox(viewOf({ items: [cost], language: 'fr' }), fr), cost.id), '5 tickets · 2 h 15 · environ 3,05\u00a0$');
  const one: PlanItemInbox = { ...cost, itemCount: 1, totals: { ...cost.totals, minutes: 40 } };
  assert.equal(lineOf(renderInbox(viewOf({ items: [one] }), en), one.id), '1 ticket · 40 min · about $3.05');
});

test('the plan\'s detail is lane 8\'s plan panel under the inbox\'s eyebrow, with Change and Approve in the inbox\'s bar', () => {
  const html = renderInbox(viewOf({ selected: `plan:${PLAN_ID}`, open: true }), en);
  const shown = visibleText(html);
  for (const expected of [
    'Plan to approve', 'Lead', 'Open on the lead\'s screen', PLAN_TITLE,
    'A GET /entries.json route that lists the entries', 'The time each entry was written, on the page', 'After 1, 2, 3 and 4',
    'Full circuit', 'Fast lane', '45 min · 1.0 %', '1 h 15 · 1.4 %',
    'About 2 h 15 of work', '3.9 % of the week', 'Up to 2 sessions at a time', 'Estimates from 23 similar tickets',
    'Signed in as demo', 'Change the plan', 'Approve the plan and start',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  assert.match(html, /<section class="plan-panel awaiting" data-plan="plan-3"/);
  assert.match(html, /<a class="d-link" href="\/plans\/plan-3">/);
  assert.doesNotMatch(html, /data-plan-action=/, 'the panel\'s own buttons are left out: the inbox\'s bar holds the gestures');
  assert.deepEqual(acts(html), ['approve_plan']);
  assert.match(html, /<a class="btn" href="\/plans\/plan-3">Change the plan<\/a>/, 'Change goes to the lead\'s screen, where the reply field is');
  assert.equal([...html.matchAll(/class="item-state /g)].length, 0, 'a proposed plan shows no item state');
});

test('a plan not read yet, or not readable, still shows what the inbox item says and can be approved', () => {
  const html = renderInbox(viewOf({ selected: `plan:${PLAN_ID}`, plans: new Map() }), en);
  const shown = visibleText(html);
  for (const expected of [
    'Plan to approve', PLAN_TITLE, proposedPlan(FIXTURE_NOW).summary, '5 tickets', 'About 2 h 15 of work', '3.9 % of the week', 'Approve the plan and start',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  assert.doesNotMatch(html, /class="plan-panel/);
  assert.deepEqual(acts(html), ['approve_plan']);
});

test('a plan the service answers in a shape the panel does not know is not handed to it (issue 177, item 2)', () => {
  const plan = proposedPlan(FIXTURE_NOW);
  assert.equal(readPlan(plan), plan);
  assert.equal(readPlan({ ...plan, state: 'archived' }), undefined);
  assert.equal(readPlan({ ...plan, items: [{ ...plan.items[0], state: 'parked' }] }), undefined);
  assert.equal(readPlan({ ...plan, items: [{ ...plan.items[0], lane: 'slow' }] }), undefined);
  assert.equal(readPlan({ ...plan, totals: null }), undefined);
  assert.equal(readPlan(null), undefined);
});

test('an approved plan leaves the waiting list; its line says how it runs, and its detail has no button', () => {
  const approved: Plan = { ...proposedPlan(FIXTURE_NOW), state: 'approved', approvedAt: FIXTURE_NOW.toISOString(), approvedBy: 'user-demo',
    items: proposedPlan(FIXTURE_NOW).items.map((item, n) => ({ ...item, ticket: `LOCAL-${301 + n}`, state: n < 2 ? 'running' : 'waiting' })) };
  const fixture = inboxFixture(FIXTURE_NOW);
  const items = fixture.items.map((item) => (item.kind === 'plan' ? { ...item, state: 'handled' as const } : item));
  const view = viewOf({ items, plans: new Map([[approved.id, approved]]), selected: `plan:${PLAN_ID}` });
  assert.ok(!ordered(items).waiting.some((item) => item.kind === 'plan'));
  const html = renderInbox(view, en);
  assert.equal(lineOf(html, `plan:${PLAN_ID}`), 'Lead · Running · 0 of 5 landed');
  assert.ok(visibleText(html).includes('LOCAL-301'));
  assert.deepEqual(acts(html), []);
  assert.ok(visibleText(html).includes('This no longer waits for you.'));
  const local = new Map<string, Local>([[`plan:${PLAN_ID}`, { kind: 'plan_approved', at: FIXTURE_NOW.toISOString() }]]);
  const done = visibleText(renderInbox({ ...view, local }, en));
  assert.ok(done.includes('Approved by you at 09:41. The tickets start in order, the first ones now.'), done.join('|'));
  const handledUnknown = renderInbox(viewOf({ items, plans: new Map() }), en);
  assert.equal(lineOf(handledUnknown, `plan:${PLAN_ID}`), 'Lead · no longer waits for you');
});

test('the lead\'s question is shown, with its choices, and sends the person to the lead\'s screen to answer it', () => {
  const question = leadQuestion(FIXTURE_NOW);
  const items: InboxItem[] = [...inboxFixture(FIXTURE_NOW).items, question];
  const list = renderInbox(viewOf({ items }), en);
  assert.equal(lineOf(list, question.id), 'Lead · waits for your answer on its screen');
  const html = renderInbox(viewOf({ items, selected: question.id, open: true }), en);
  const shown = visibleText(html);
  for (const expected of [
    'Question from the lead', 'Lead', 'Answer on the lead\'s screen', LEAD_QUESTION_TEXT, 'Only the visible ones', 'Recommended by the team',
    'All of them, with a hidden flag', 'The lead waits for your answer on its screen.',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  assert.doesNotMatch(html, /data-free=/, 'no free answer here: the session answer route refuses the lead\'s session');
  assert.deepEqual(acts(html), [], 'no Send: the answer is given on the lead\'s screen');
  assert.match(html, /<a class="btn" href="\/lead">Answer on the lead&#39;s screen<\/a>/);
  assert.equal([...html.matchAll(/href="\/lead"/g)].length, 1, 'one way to the lead\'s screen, in the bar');
  assert.match(html, /class="questions waits read"/);
  for (const option of html.matchAll(/<button[^>]*data-option=[^>]*>/g)) assert.match(option[0], /disabled/);
  const handled: QuestionItem = { ...question, state: 'handled' };
  assert.equal(lineOf(renderInbox(viewOf({ items: [handled] }), en), handled.id), 'Lead · no longer waits for you');
});

test('the lead\'s sentinel ticket is never on screen', () => {
  const question = leadQuestion(FIXTURE_NOW);
  const items: InboxItem[] = [...inboxFixture(FIXTURE_NOW).items, question, { ...question, id: 'handled-lead-question', state: 'handled' }];
  for (const selected of [`plan:${PLAN_ID}`, question.id, 'handled-lead-question']) {
    for (const plans of [viewOf().plans, new Map<string, Plan>()]) {
      const shown = visibleText(renderInbox(viewOf({ items, selected, plans }), en));
      for (const text of shown) assert.ok(text !== LEAD_TICKET && !text.startsWith(`${LEAD_TICKET} ·`), `the sentinel shows: ${JSON.stringify(text)}`);
    }
  }
});

test('the detail is redrawn when the plan it shows moves', () => {
  const plan = proposedPlan(FIXTURE_NOW);
  const before = viewOf({ selected: `plan:${PLAN_ID}` });
  const after = viewOf({ selected: `plan:${PLAN_ID}`, plans: new Map([[plan.id, { ...plan, state: 'superseded' }]]) });
  const unread = viewOf({ selected: `plan:${PLAN_ID}`, plans: new Map() });
  assert.notEqual(detailKey(before), detailKey(after));
  assert.notEqual(detailKey(before), detailKey(unread));
});

test('how a refusal of the plan\'s approval reads', () => {
  assert.deepEqual(failure(new ApiError(409, 'x'), 'approve_plan'), { key: 'approve_plan_conflict', settled: false });
  assert.deepEqual(failure(new ApiError(404, 'x'), 'approve_plan'), { key: 'approve_plan_gone', settled: false });
  assert.deepEqual(failure(new ApiError(503, 'x'), 'approve_plan'), { key: 'approve_plan_lead_off', settled: false });
  assert.deepEqual(failure(new ApiError(500, 'x'), 'approve_plan'), { key: 'approve_plan_failed', settled: false });
  assert.deepEqual(failure(new Error('network'), 'approve_plan'), { key: 'approve_plan_failed', settled: false });
});

test('a failed approval of a plan that the service did write reads as a plan that moved (issue 175, item 2)', () => {
  const plan = proposedPlan(FIXTURE_NOW);
  assert.equal(afterPlanRefusal('approve_plan_failed', { ...plan, state: 'approved' }), 'approve_plan_conflict');
  assert.equal(afterPlanRefusal('approve_plan_failed', plan), 'approve_plan_failed', 'still proposed: it did not reach the service');
  assert.equal(afterPlanRefusal('approve_plan_failed', undefined), 'approve_plan_failed');
  assert.equal(afterPlanRefusal('approve_plan_conflict', { ...plan, state: 'superseded' }), 'approve_plan_conflict');
});

test('every word of the plan and the lead\'s question comes from the catalog or from the data, with no inline style', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const question = leadQuestion(FIXTURE_NOW);
  const items: InboxItem[] = [...fixture.items, question];
  const allowed = strings([items, fixture.plans]);
  allowed.add('demo').add('Only the visible ones');
  for (const n of [1, 2, 3, 4, 5]) allowed.add(String(n));
  for (const selected of [`plan:${PLAN_ID}`, question.id]) {
    for (const local of [undefined, { kind: 'busy' }, { kind: 'plan_approved', at: FIXTURE_NOW.toISOString() }] as (Local | undefined)[]) {
      for (const plans of [viewOf().plans, new Map<string, Plan>()]) {
        const html = renderInbox(viewOf({ items, selected, open: true, plans, local: new Map(local ? [[selected, local]] : []) }), sentinel);
        for (const shown of visibleText(html)) {
          const rest = shown.replace(/«[a-z0-9_]+»/g, '').replace(/[·\s]+/g, ' ').trim();
          if (!/\p{L}/u.test(rest)) continue;
          assert.ok(allowed.has(rest), `not from the catalog nor the data: ${JSON.stringify(rest)}`);
        }
        assert.doesNotMatch(html, /\sstyle=/);
        assert.doesNotMatch(html, /<style|<script/);
      }
    }
  }
});

test('the plan and the lead\'s question in French have no English sentence left', () => {
  const enCatalog = { ...loadCatalog('inbox', 'en') };
  const frCatalog = loadCatalog('inbox', 'fr');
  const question = leadQuestion(FIXTURE_NOW);
  const items: InboxItem[] = [...inboxFixture(FIXTURE_NOW).items, question];
  for (const selected of [`plan:${PLAN_ID}`, question.id]) {
    for (const plans of [viewOf().plans, new Map<string, Plan>()]) {
      const html = renderInbox(viewOf({ items, selected, open: true, plans, language: 'fr' }), fr);
      for (const [key, value] of Object.entries(enCatalog)) {
        if (frCatalog[key] === value || value.length < 12 || !/\s/.test(value)) continue;
        const plain = value.replace(/\{[a-z_]+\}/g, '').trim();
        assert.ok(!html.includes(plain), `English left in French: ${plain}`);
      }
    }
  }
  const shown = visibleText(renderInbox(viewOf({ selected: `plan:${PLAN_ID}`, language: 'fr' }), fr));
  assert.ok(shown.includes('Approuver le plan et démarrer'));
  assert.ok(shown.includes('3,9 % de la semaine'));
});

test('what the plan and the lead\'s question say is escaped, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>"&';
  const plan = proposedPlan(FIXTURE_NOW);
  const bad: Plan = { ...plan, title: evil, summary: evil, items: plan.items.map((item) => ({ ...item, title: evil })) };
  const item: PlanItemInbox = { ...planItemOf(bad), title: evil, summary: evil };
  const question = leadQuestion(FIXTURE_NOW);
  const odd: QuestionItem = { ...question, questions: [{ question: evil, header: evil, options: [{ label: evil, description: evil }] }] };
  for (const plans of [new Map([[bad.id, bad]]), new Map<string, Plan>()]) {
    for (const selected of [item.id, odd.id]) {
      const html = renderInbox(viewOf({ items: [item, odd], plans, selected, open: true }), en);
      assert.ok(!html.includes('<img src=x'));
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'));
    }
  }
});
