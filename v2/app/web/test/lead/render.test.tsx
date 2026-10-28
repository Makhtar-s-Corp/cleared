// The lead and plan screen's pure parts, on the lead fixture (the thread and
// the plan lane 1 plays from the scripted lead) and on lane 8's other plan
// states: the header line, the thread, the question bubble, the plan panel
// with its items, chips, estimates, footer and buttons, the memory panel,
// and which plan /lead shows.
import { test } from 'vitest';
import { renderLead, renderMemory, renderPlanPanel, renderThread, factsHtml } from '../render.tsx';
import assert from 'node:assert/strict';
import type { LeadState, Plan } from '../../../../src/api/types.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { leadFixture, otherPlans, waitingForAnswer } from '../../../fixtures/lead.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { choosePlan, headerLine, type LeadView } from '../../screens/lead/model.ts';
import { estimate } from '../../lib/time.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const count = (html: string, pattern: RegExp) => html.match(new RegExp(pattern.source, 'g'))?.length ?? 0;

async function view(over: Partial<LeadView> = {}): Promise<LeadView> {
  const fixture = await leadFixture(FIXTURE_NOW);
  return { state: fixture.state, messages: fixture.messages, plans: fixture.plans, planId: null, now: FIXTURE_NOW, language: 'en', memory: null, ...over };
}

test('the screen is Plans, as the sidebar, the top bar and the title say; the lead is the chat\'s heading (lane 38\'s art director, item 5)', async () => {
  const markup = renderLead(await view(), en);
  assert.match(markup, /<h1 class="sr-only">Plans<\/h1>/);
  assert.match(markup, /<h2 id="lead-title">Lead<\/h2>/);
  assert.equal([...markup.matchAll(/<h1\b/g)].length, 1);
});

test('the header line says the lead is always on, its context share and when it was refreshed from memory', async () => {
  const { state } = await view();
  assert.deepEqual(headerLine(state, FIXTURE_NOW, en), { text: 'Always on · context 45% · refreshed from memory 10\u00a0min ago', tone: 'on' });
  assert.equal(headerLine({ ...state, phase: 'working' }, FIXTURE_NOW, en).text, 'Always on · context 45% · refreshed from memory 10\u00a0min ago');
  assert.deepEqual(headerLine({ ...state, phase: 'starting', context: null, refreshedAt: null }, FIXTURE_NOW, en), { text: 'Starting', tone: 'quiet' });
  assert.deepEqual(headerLine({ ...state, phase: 'refreshing' }, FIXTURE_NOW, en), { text: 'Refreshing from memory', tone: 'quiet' });
  assert.deepEqual(headerLine({ ...state, phase: 'down' }, FIXTURE_NOW, en), { text: 'The Lead is not running', tone: 'down' });
  assert.equal(headerLine({ ...state, context: null }, FIXTURE_NOW, en).text, 'Always on · refreshed from memory 10\u00a0min ago', 'no measure yet: no share');
  assert.equal(headerLine({ ...state, refreshedAt: new Date(FIXTURE_NOW.getTime() - 3 * 3_600_000).toISOString() }, FIXTURE_NOW, en).text, 'Always on · context 45% · refreshed from memory 3h ago');
  assert.equal(headerLine(state, FIXTURE_NOW, fr).text, 'Toujours actif · contexte 45\u202f% · rechargé depuis la mémoire il y a 10\u00a0min');
});

test('the down state is a danger pill in the lead card, the live states are not', async () => {
  const live = renderLead(await view(), en);
  assert.ok(live.includes(`<p class="lead-line" id="lead-line">${factsHtml('Always on', 'context 45%', 'refreshed from memory 10\u00a0min ago')}</p>`), live);
  assert.doesNotMatch(live, /lead-down/);
  const v = await view();
  const down = renderLead({ ...v, state: { ...v.state, phase: 'down' } }, en);
  assert.match(down, /<p class="lead-line lead-down" id="lead-line">The Lead is not running<\/p>/);
});

test('the thread: the owner in ink on the right, the lead with its square, a grey refresh line, a plan line', async () => {
  const html = renderThread(await view(), en);
  assert.equal(count(html, /class="bubble owner"/), 2);
  assert.equal(count(html, /class="lead-row"/), 2, 'the question and the reply with the plan');
  assert.equal(count(html, /<span class="lead-mark small" aria-hidden="true">L<\/span>/), 2);
  assert.ok(html.includes(`<li class="system-line"><span>${factsHtml('Refreshed from memory', 'generation 3', '09:31')}</span></li>`), html);
  assert.match(text(html), /Goal: make the guestbook readable once it has many entries\. I want it before Friday\./);
  assert.match(text(html), /Pages of 20\. The phone keeps the long list\./);
  assert.match(text(html), /Here is a plan in five tickets\./);
  assert.doesNotMatch(html, /data-answer=|q-header|q-hint/, 'the fixture\'s question was answered: it reads as a line of the Lead, the answer below it');
  assert.match(html, /<div class="bubble lead question"><p class="bubble-text">Before I plan: on desktop/);
});

test('a question that waits is a bubble with its options as the clickable answers, the recommendation marked, and the reply field as its free answer', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const waiting = waitingForAnswer(fixture);
  const html = renderThread(await view({ state: waiting.state, messages: waiting.messages }), en);
  assert.match(html, /class="bubble lead question waits"/);
  assert.match(html, /<button type="button" class="choice" data-answer="Pages of 20 \(Recommended\)" data-q="0"><span class="choice-label">Pages of 20<\/span><span class="choice-rec">Recommended<\/span>/);
  assert.match(html, /<button type="button" class="choice" data-answer="One long list" data-q="0"><span class="choice-label">One long list<\/span>/);
  assert.doesNotMatch(html, /data-free=|data-choice-send/, 'the reply field below is the free answer');
  assert.match(html, /Or write your answer below\./);
  assert.match(text(html), /Before I plan: on desktop, do you want the entries in pages of 20/);
  assert.match(html, /<span class="choice-header">Desktop list<\/span>/);
  // A question that is not the pending one reads as a line of the lead.
  const stale = renderThread(await view({ state: { ...waiting.state, pendingQuestion: null }, messages: waiting.messages }), en);
  assert.doesNotMatch(stale, /data-answer=/);
  // An ask of several questions: each is picked, then Send answers them in one message.
  const asked = waiting.messages[2]?.question;
  assert.ok(asked);
  const several = waiting.messages.map((m) => (m.question ? { ...m, question: { ...asked, questions: [...asked.questions, { question: 'And on the phone?', options: [{ label: 'Same' }] }] } } : m));
  const two = renderThread(await view({ state: waiting.state, messages: several }), en);
  assert.equal(count(two, /aria-pressed="false"/), 3, 'the clicks pick');
  assert.match(two, /data-choice-send="true" disabled="">Send the answer/);
  assert.match(two, /Or write your answer below\./);
});

test('the plan panel against the capture: five numbered items, After lines, lane chips, estimates, the footer and the two buttons', async () => {
  const [plan] = (await leadFixture(FIXTURE_NOW)).plans;
  assert.ok(plan);
  const html = renderPlanPanel(plan, en);
  assert.match(html, /<section class="plan-panel awaiting"[^>]*aria-labelledby="plan-title-plan-1"/);
  assert.match(html, /<p class="plan-eyebrow">Plan to approve<\/p>/);
  assert.match(html, /<h2 id="plan-title-plan-1">Make a long guestbook readable<\/h2>/);
  assert.match(html, /<p class="plan-summary">Pages of 20 entries on desktop, the long list on the phone\. Ready by Friday\.<\/p>/);
  assert.equal(count(html, /<li class="plan-item"/), 5);
  for (let n = 1; n <= 5; n += 1) assert.match(html, new RegExp(`<span class="plan-n" aria-hidden="true">${n}</span>`));
  assert.deepEqual([...html.matchAll(/<p class="plan-after">([^<]+)<\/p>/g)].map((m) => m[1]), ['After 1', 'After 2']);
  assert.equal(count(html, /<span class="lane full">Full circuit<\/span>/), 3);
  assert.equal(count(html, /<span class="lane fast">Fast lane<\/span>/), 2);
  assert.deepEqual([...html.matchAll(/<span class="plan-estimate">([^<]+)<\/span>/g)].map((m) => m[1]), ['40\u00a0min · 1.2%', '50\u00a0min · 1.6%', '30\u00a0min · 0.8%', '10\u00a0min · 0.2%', '5\u00a0min · 0.1%']);
  assert.deepEqual([...html.matchAll(/<li class="plan-fact">([^<]+)<\/li>/g)].map((m) => m[1]), ['About 2h of work', '3.9% of the week', 'Up to 2 sessions at a time', 'Estimates from 23 similar tickets']);
  assert.match(html, /<button type="button" class="plain plan-change" data-plan-action="change">Change the plan<\/button>/);
  assert.match(html, /<button type="button" class="primary plan-go" data-plan-action="approve">Approve the plan and start<\/button>/);
  assert.match(html, /Day headings in the list of entries/);
  assert.match(html, /An empty page says “No entries yet”/);
});

test('without the week\'s share an estimate is in dollars, and below three samples the footer says the estimates are defaults', () => {
  const { running } = otherPlans(FIXTURE_NOW);
  const html = renderPlanPanel(running, en);
  assert.deepEqual([...html.matchAll(/<span class="plan-estimate">([^<]+)<\/span>/g)].map((m) => m[1]), ['12\u00a0min · $0.30', '12\u00a0min · $0.30', '5\u00a0min · $0.15', '5\u00a0min · $0.15', '30\u00a0min · $0.80']);
  assert.deepEqual([...html.matchAll(/<li class="plan-fact">([^<]+)<\/li>/g)].map((m) => m[1]), ['About 42\u00a0min of work', 'About\u00a0$1.70', 'Up to 2 sessions at a time', 'Default estimates: not enough history yet']);
  assert.match(renderPlanPanel(running, fr, { language: 'fr' }), /12\u00a0min · 0,30\u00a0\$/);
  assert.match(renderPlanPanel({ ...running, maxParallel: 1 }, en), /<li class="plan-fact">One session at a time<\/li>/);
});

test('a running plan says so, counts what landed, shows each ticket and its state, and offers Pause; paused offers Resume; done offers nothing', () => {
  const { running, paused, done } = otherPlans(FIXTURE_NOW);
  const html = renderPlanPanel(running, en);
  assert.match(html, /<section class="plan-panel"/, 'a running plan does not wait for the person: no amber');
  assert.match(html, /<p class="plan-eyebrow">Running · 1 of 5 landed<\/p>/);
  assert.match(html, /<span class="id">LOCAL-201<\/span>/);
  assert.deepEqual([...html.matchAll(/<span class="item-state ([a-z_]+)">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]), [
    ['landed', 'Landed'], ['needs_approval', 'Waits for your approval'], ['running', 'Running'], ['ready', 'Ready to start'], ['waiting', 'Waiting'],
  ]);
  assert.match(html, /<p class="plan-after">After 1, 2, 3 and 4<\/p>/);
  assert.match(html, /data-plan-action="pause">Pause<\/button>/);
  assert.doesNotMatch(html, /data-plan-action="approve"/);
  const stopped = renderPlanPanel(paused, en);
  assert.match(stopped, /<p class="plan-eyebrow">Paused · 1 of 5 landed<\/p>/);
  assert.match(stopped, /data-plan-action="resume">Resume<\/button>/);
  const ended = renderPlanPanel(done, en);
  assert.match(ended, /<p class="plan-eyebrow">Done · 2 of 2 landed<\/p>/);
  assert.doesNotMatch(ended, /<button/);
  assert.match(renderPlanPanel({ ...running, state: 'superseded' }, en), /<p class="plan-eyebrow">Replaced by a newer plan<\/p>/);
  assert.match(renderPlanPanel({ ...running, state: 'rejected' }, en), /<p class="plan-eyebrow">Not approved<\/p>/);
});

test('a gesture on its way disables the panel\'s buttons, and a failure is said under them', async () => {
  const [plan] = (await leadFixture(FIXTURE_NOW)).plans;
  assert.ok(plan);
  const busy = renderPlanPanel(plan, en, { busy: true, note: 'The plan could not be approved. Try again.' });
  assert.equal(count(busy, /<button[^>]* disabled/), 2);
  assert.match(busy, /<p class="plan-note" role="status">The plan could not be approved\. Try again\.<\/p>/);
  assert.doesNotMatch(renderPlanPanel(plan, en, { actions: false }), /<button/, 'a panel shown without its gestures');
});

test('durations read as the capture writes them', () => {
  assert.equal(estimate(5, en), '5\u00a0min');
  assert.equal(estimate(40, en), '40\u00a0min');
  assert.equal(estimate(60, en), '1h');
  assert.equal(estimate(120, en), '2h');
  assert.equal(estimate(135, en), '2h\u00a015m');
  assert.equal(estimate(62, en), '1h\u00a02m');
  assert.equal(estimate(0.4, en), '1\u00a0min', 'never zero');
});

test('which plan the screen shows: the one in the address, else one to approve, else one running or paused, else the last done', () => {
  const { running, paused, done } = otherPlans(FIXTURE_NOW);
  const proposed: Plan = { ...running, id: 'plan-9', state: 'proposed', proposedAt: FIXTURE_NOW.toISOString() };
  assert.equal(choosePlan([done, running, proposed], null)?.id, 'plan-9');
  assert.equal(choosePlan([done, running], null)?.id, running.id);
  assert.equal(choosePlan([done, { ...paused, id: 'plan-p' }], null)?.id, 'plan-p');
  assert.equal(choosePlan([done, { ...done, id: 'plan-late', proposedAt: FIXTURE_NOW.toISOString() }], null)?.id, 'plan-late');
  assert.equal(choosePlan([{ ...running, state: 'superseded' }, { ...running, id: 'x', state: 'rejected' }], null), undefined, 'a plan no longer in play is shown only from its address');
  assert.equal(choosePlan([done, running], done.id)?.id, done.id);
  assert.equal(choosePlan([done], 'nope'), undefined);
});

test('the side: the plan, the other plans as links, an empty state, a plan the address names but nobody has', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const { running, done } = otherPlans(FIXTURE_NOW);
  const all = renderLead(await view({ plans: [...fixture.plans, running, done] }), en);
  assert.match(all, /<h2 id="plan-title-plan-1">/);
  assert.match(all, /<a href="\/plans\/plan-2">Make the guestbook ready for a small team<\/a> <span class="faint">Running · 1 of 5 landed<\/span>/);
  assert.match(all, /<a href="\/plans\/plan-0">Newest entries first<\/a> <span class="faint">Done · 2 of 2 landed<\/span>/);
  const none = renderLead(await view({ plans: [] }), en);
  assert.match(none, /<div class="empty-state block" id="plan-empty">[^]*?No plan yet\.<span class="empty-note">The Lead proposes one once you give it a goal\.<\/span>[^]*?Give the Lead a goal<\/button>/, 'what to do, and the action');
  const missing = renderLead(await view({ planId: 'plan-404' }), en);
  assert.match(missing, /There is no plan plan-404\./);
});

test('the memory panel: the last handover, the commitments open then done, the refreshes and the highest share', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const html = renderMemory(fixture.memory, fixture.state, FIXTURE_NOW, en);
  const open = renderLead(await view({ memory: fixture.memory }), en);
  assert.match(open, /<button type="button" class="link-button" id="lead-remember" aria-expanded="true" aria-controls="lead-memory">What does the Lead remember\?<\/button>/);
  assert.match(open, /<h2 id="memory-title">What the Lead remembers<\/h2>/);
  assert.match(renderLead(await view({ memory: 'loading' }), en), /Reading what the Lead remembers…/);
  assert.match(renderLead(await view(), en), /aria-expanded="false"/);
  assert.match(text(html), /Refreshed 2 times · highest context 45% · claude · opus-5\.5/);
  assert.match(text(html), /Last handover Generation 2 handed over at 09:31, in its own words\. The owner asked for nothing new since the morning\./);
  assert.match(text(html), /Open commitments When the first ticket of the plan lands, tell the owner how long it took from start to live\./);
  assert.match(text(html), /Done Tell the owner when the checks of the example are green again\. Done at 05:41: Told at 15:41: green after the lock file fix\./);
  const machine = renderMemory({ handover: { id: 'h', generation: 4, at: FIXTURE_NOW.toISOString(), summary: 'the Lead did not write its account', machine: true }, commitments: [] }, { ...fixture.state, refreshCount: 1 }, FIXTURE_NOW, en);
  assert.match(text(machine), /Generation 4 handed over at 09:41\. The service wrote it: the Lead did not write its own account\./);
  assert.match(text(machine), /Refreshed once/);
  assert.match(text(machine), /Nothing is open\./);
  const first = renderMemory({ handover: null, commitments: [] }, { ...fixture.state, refreshCount: 0, highestPercent: null }, FIXTURE_NOW, en);
  assert.match(text(first), /No handover yet: this is the Lead's first generation\./);
  assert.match(text(first), /Not refreshed yet/);
});

test('every value is escaped', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const [plan] = fixture.plans;
  assert.ok(plan);
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderPlanPanel({ ...plan, title: evil, summary: evil, items: plan.items.map((i) => ({ ...i, title: evil })) }, en);
  assert.doesNotMatch(html, /<img/);
  const thread = renderThread(await view({ messages: fixture.messages.map((m) => ({ ...m, text: evil })) }), en);
  assert.doesNotMatch(thread, /<img/);
});

test('every key the screen and the panel use exists in French, so a French page renders the same states', async () => {
  const keys = new Set<string>();
  const record: Translate = (key, values) => { keys.add(key); return en(key, values); };
  const fixture = await leadFixture(FIXTURE_NOW);
  const { running, paused, done } = otherPlans(FIXTURE_NOW);
  const waiting = waitingForAnswer(fixture);
  const states: LeadState[] = (['starting', 'idle', 'working', 'refreshing', 'down'] as const).map((phase) => ({ ...fixture.state, phase }));
  for (const state of states) renderLead(await view({ state, plans: [...fixture.plans, running, done] }), record);
  renderLead(await view({ state: waiting.state, messages: waiting.messages, plans: [] }), record);
  renderLead(await view({ planId: 'nope', memory: 'loading' }), record);
  renderLead(await view({ memory: 'failed' }), record);
  renderLead(await view({ memory: fixture.memory }), record);
  for (const plan of [running, paused, done, { ...running, state: 'superseded' as const }, { ...running, state: 'rejected' as const }, { ...running, maxParallel: 1 }]) renderPlanPanel(plan, record, { busy: true, note: 'x' });
  for (const n of [1, 30, 61, 120]) estimate(n, record);
  assert.ok(keys.size > 40);
  for (const key of keys) assert.doesNotThrow(() => fr(key, { n: 1, h: 1, m: 1, id: 'p', time: '1', ago: '1', amount: '1', list: '1', last: '2', model: 'm', text: 't', landed: 1, total: 2, state: 's', note: 'n', generation: 1 }), key);
});
