// The tower's milestone 2 parts (plan, section 7.2): the live lead card, the
// plans card, the plan card under Needs you, the grey line's plan count and
// week share, the lead's own sessions and questions, and the "Lead · always
// on" pill of the shell's header.
import { test } from 'vitest';
import { renderSidebar, renderTower, renderTowerBody } from './render.tsx';
import assert from 'node:assert/strict';
import type { InboxItem, LeadMessage, LeadState, Plan, PlanItem, SessionSummary } from '../../../src/api/types.ts';
import { FIXTURE_NOW, towerFixture } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { leadPillShown } from '../shell/model.ts';
import { ApiError } from '../lib/screen.ts';
import { lastLeadLine, loadTower, towerModel, type TowerData } from '../screens/tower/model.ts';
import { signedIn, startApp } from '../../test/support.ts';

const en: Translate = translator(loadCatalog('tower', 'en'));
const fr: Translate = translator(loadCatalog('tower', 'fr'));
const minutesAgo = (minutes: number) => new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();

function text(html: string): string {
  return html.replace(/<[^>]*>/g, '\n').split('\n').map((line) => line.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()).filter(Boolean).join('\n');
}

const item = (position: number, state: PlanItem['state'], title = `Item ${position}`): PlanItem => ({
  position, title, body: '- [ ] done', lane: 'full', size: 's', after: [], state, ticket: state === 'waiting' ? null : `LOCAL-${170 + position}`,
  estimate: { minutes: 12, costUsd: 0.3, weekPercent: null, samples: 0 },
});

const plan = (id: string, state: Plan['state'], items: readonly PlanItem[], title = 'A plan'): Plan => ({
  id, goal: `goal-${id}`, title, summary: 'A summary.', items, maxParallel: 2, state,
  totals: { minutes: 75, costUsd: 3.9, weekPercent: null, samples: 0 }, proposedAt: minutesAgo(60), approvedAt: null, approvedBy: null,
});

const leadState = (phase: LeadState['phase'], extra: Partial<LeadState> = {}): LeadState => ({
  generation: 1, sessionId: phase === 'down' || phase === 'starting' ? null : 'lead-session', phase, model: 'claude-opus-5-5',
  context: { percent: 12, totalTokens: 24_000, maxTokens: 200_000 }, highestPercent: 12, refreshedAt: null, refreshCount: 0,
  openCommitments: 0, pendingQuestion: null, ...extra,
});

test('the lead card is live: its state line, then the last thing the lead said to the owner', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const model = towerModel(data, FIXTURE_NOW);
  assert.deepEqual(model.lead, {
    phase: 'idle', percent: 31, refreshedMinutes: 10,
    line: 'LOCAL-161 is paused on a permission. I moved LOCAL-163 ahead so the machine stays busy.',
  });
  const html = renderTower(model, en);
  const words = text(html);
  assert.ok(words.includes('Always on · context 31% · refreshed 10 min ago'));
  assert.match(html, /<q>LOCAL-161 is paused on a permission\. I moved LOCAL-163 ahead so the machine stays busy\.<\/q>/, 'quoted in the reader\'s language by the browser');
  assert.match(html, /<form class="lead-ask" id="lead-ask"[^>]*>\s*<input id="lead-ask-input"[^>]*placeholder="Message the lead…"/);
  assert.doesNotMatch(words, /Comes in milestone 2|milestone 2/, 'the milestone 1 sentences are gone');
});

test('each state of the lead reads as such, and a lead the tower cannot read is not running', () => {
  const line = (lead: LeadState | null) => text(renderTowerBody(towerModel({ sessions: [], inbox: [], tickets: [], lead, leadLine: null, plans: [], weekLeft: null }, FIXTURE_NOW), en));
  assert.match(line(leadState('idle')), /Always on · context 12%/);
  assert.doesNotMatch(line(leadState('idle')), /refreshed/, 'a first generation was never refreshed');
  assert.match(line(leadState('working', { refreshedAt: minutesAgo(90), refreshCount: 1 })), /Always on · context 12% · refreshed 1 h 30 ago/);
  assert.match(line(leadState('idle', { context: null })), /^Always on$/m, 'no share before the first measure');
  assert.match(line(leadState('starting')), /^Starting$/m);
  assert.match(line(leadState('refreshing')), /^Refreshing from memory$/m);
  assert.match(line(leadState('down')), /^Not running$/m);
  assert.match(line(null), /^Not running$/m);
  assert.match(line(null), /No message from the lead yet\./);
  assert.match(renderTowerBody(towerModel({ sessions: [], inbox: [], tickets: [], lead: leadState('down'), leadLine: null, plans: [], weekLeft: null }, FIXTURE_NOW), en), /class="lead-state down"/, 'down is the danger state');
});

test('the last line is the lead\'s last message, plan or question to the owner, never the owner\'s nor a refresh', () => {
  const at = minutesAgo(1);
  const thread: LeadMessage[] = [
    { seq: 4, at, by: 'lead', kind: 'message', text: 'First.' },
    { seq: 5, at, by: 'lead', kind: 'plan', text: 'Here is the plan.', planId: 'plan-1' },
    { seq: 6, at, by: 'owner', kind: 'message', text: 'Thanks.', user: 'u1' },
    { seq: 7, at, by: 'system', kind: 'refresh', text: 'Refreshed from memory', generation: 2 },
  ];
  assert.deepEqual(lastLeadLine(thread, { after: 0, line: null }), { after: 7, line: 'Here is the plan.' });
  assert.deepEqual(lastLeadLine([], { after: 7, line: 'Here is the plan.' }), { after: 7, line: 'Here is the plan.' }, 'nothing new keeps the line');
  assert.deepEqual(lastLeadLine([{ seq: 8, at, by: 'lead', kind: 'question', text: 'Pages of 20?' }], { after: 7, line: 'Here is the plan.' }), { after: 8, line: 'Pages of 20?' });
});

test('the thread is read after the last seq, so a 48-hour thread is not fetched every ten seconds', async () => {
  const asked: string[] = [];
  const api = async <T,>(path: string): Promise<T> => {
    asked.push(path);
    if (path === '/lead/messages' || path.startsWith('/lead/messages?')) return [{ seq: 12, at: minutesAgo(1), by: 'lead', kind: 'message', text: 'Done.' }] as T;
    if (path === '/lead') return leadState('idle') as T;
    return [] as T;
  };
  const first = await loadTower(api, { after: 0, line: null });
  assert.equal(first.data.leadLine, 'Done.');
  const second = await loadTower(api, first.thread);
  assert.ok(asked.includes('/lead/messages'), 'the first read takes the whole thread');
  assert.ok(asked.includes('/lead/messages?after=12'), 'the next ones only what came after');
  assert.equal(second.thread.after, 12);
});

test('without the lead or the plans routes, the milestone 1 tower still loads', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const api = async <T,>(path: string): Promise<T> => {
    if (path === '/sessions') return data.sessions as T;
    if (path === '/inbox') return data.inbox as T;
    if (path === '/tickets') return data.tickets as T;
    throw new ApiError(404, path);
  };
  const { data: loaded } = await loadTower(api, { after: 0, line: null });
  assert.equal(loaded.lead, null);
  assert.deepEqual(loaded.plans, []);
  assert.equal(loaded.leadLine, null);
  const model = towerModel(loaded, FIXTURE_NOW);
  assert.equal(model.live.length, 4);
  assert.equal(model.landed.length, 2);
  const words = text(renderTowerBody(model, en));
  assert.match(words, /Not running/);
  assert.match(words, /No plan in progress\./);
  assert.match(words, /New goal/, 'and the one thing to do about it');
  const failing = async <T,>(path: string): Promise<T> => { throw new ApiError(path === '/inbox' ? 502 : 404, path); };
  await assert.rejects(loadTower(failing, { after: 0, line: null }), 'the tower\'s own data is still required');
});

test('the plans card lists the plans under way: landed, running, next', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const model = towerModel(data, FIXTURE_NOW);
  assert.deepEqual(model.plans.map((p) => [p.title, p.landed, p.running, p.total, p.next, p.paused, p.segments]), [
    ['Entries on desktop', 3, 1, 6, 'Pages of 20 entries on desktop', false, ['landed', 'landed', 'landed', 'running', 'waiting', 'waiting']],
  ]);
  const html = renderTower(model, en);
  assert.ok(text(html).includes('3 of 6 landed · 1 running · next: Pages of 20 entries on desktop'));
  assert.match(html, /<a class="plan-row" href="\/plans\/plan-entries">/);
  assert.match(html, /<span class="plan-bar" role="img" aria-label="3 of 6 landed · 1 running">(<span class="seg (landed|running|waiting)"><\/span>){6}<\/span>/);
});

test('a plan in progress counts its approvals, held items and pause; proposed, done and rejected plans are not under way', () => {
  const plans = [
    plan('p1', 'paused', [item(1, 'landed'), item(2, 'needs_approval'), item(3, 'held'), item(4, 'cancelled'), item(5, 'ready', 'Next one')]),
    plan('p2', 'proposed', [item(1, 'waiting')]),
    plan('p3', 'done', [item(1, 'landed')]),
    plan('p4', 'rejected', [item(1, 'waiting')]),
    plan('p5', 'superseded', [item(1, 'waiting')]),
  ];
  const model = towerModel({ sessions: [], inbox: [], tickets: [], lead: null, leadLine: null, plans, weekLeft: null }, FIXTURE_NOW);
  assert.deepEqual(model.plans.map((p) => [p.id, p.landed, p.running, p.approval, p.held, p.total, p.next, p.paused, p.segments]), [
    ['p1', 1, 0, 1, 1, 4, 'Next one', true, ['landed', 'approval', 'held', 'waiting']],
  ]);
  const words = text(renderTowerBody(model, en));
  assert.ok(words.includes('Paused · 1 of 4 landed · 1 to approve · 1 held · next: Next one'), words);
  assert.match(words, /0 sessions running · 1 plan in progress · 0 landed today/);
  assert.match(renderTowerBody(model, en), /class="plan-bar" role="img" aria-label="1 of 4 landed · 1 to approve · 1 held"/, 'the label names the amber and red segments too');
});

test('a proposed plan is a card under Needs you, after what the teams wait for, linked to its plan', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const model = towerModel(data, FIXTURE_NOW);
  const card = model.needs.at(-1);
  assert.equal(card?.kind, 'plan');
  assert.equal(card?.href, '/plans/plan-readable');
  const html = renderTower(model, en);
  assert.match(html, /<a class="need row" href="\/plans\/plan-readable"/);
  assert.ok(text(html).includes('Plan\nMake the guestbook readable on desktop\nThe lead proposes 5 tickets, about 2 h of work and 4% of the week.\nGoal\n25 min'), 'its kind, its title, its line, then whose and how long');
});

test('a plan without the week share says its cost, one ticket reads in the singular, and French says it in French', () => {
  const proposal = (count: number, minutes: number, weekPercent: number | null): InboxItem => ({
    kind: 'plan', id: `plan-item-${count}`, ticket: 'lead', project: 'guestbook', since: minutesAgo(4), state: 'waiting', planId: `p${count}`,
    title: 'A goal', summary: 'A summary.', itemCount: count, totals: { minutes, costUsd: 3.9, weekPercent, samples: 2 },
  });
  const render = (inbox: InboxItem[], t: Translate) => text(renderTowerBody(towerModel({ sessions: [], inbox, tickets: [], lead: null, leadLine: null, plans: [], weekLeft: null }, FIXTURE_NOW), t));
  assert.match(render([proposal(5, 135, null)], en), /The lead proposes 5 tickets, about 2 h 15 of work, about \$3\.90\./);
  assert.match(render([proposal(1, 40, null)], en), /The lead proposes 1 ticket, about 40 min of work, about \$3\.90\./);
  assert.match(render([proposal(3, 60, 1.25)], en), /The lead proposes 3 tickets, about 1 h of work and 1\.3% of the week\./);
  assert.match(render([proposal(3, 60, 1.25)], fr), /Le lead propose 3 tickets, environ 1 h de travail et 1,3 % de la semaine\./);
  assert.match(render([proposal(5, 135, null)], fr), /environ 3,90 \$/);
});

test('the lead\'s own question shows no ticket id and opens the lead, and its session is not a team session', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const question: InboxItem = {
    kind: 'question', id: 'lead-question', ticket: 'lead', project: 'guestbook', since: minutesAgo(7), state: 'waiting', sessionId: 'lead-session', requestId: 'r1',
    questions: [{ question: 'Pages of 20, or one long list?' }],
  };
  const leadSession: SessionSummary = {
    id: 'lead-session', project: 'guestbook', ticket: 'lead', role: 'lead', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'working',
    status: 'Planning', startedAt: minutesAgo(30), updatedAt: minutesAgo(1), lastSeq: 9,
  };
  const changed: TowerData = { ...data, inbox: [...data.inbox, question], sessions: [...data.sessions, leadSession] };
  const model = towerModel(changed, FIXTURE_NOW);
  assert.equal(model.live.length, 4, 'the lead is on its card, not in Live sessions');
  assert.ok(!model.live.some((s) => s.role === 'lead'));
  const card = model.needs.find((n) => n.id === 'lead-question');
  assert.equal(card?.href, '/lead');
  const html = renderTower(model, en);
  assert.match(html, /<a class="need row" href="\/lead"[^>]*>[\s\S]*?Pages of 20, or one long list\?[\s\S]*?The lead waits for your answer on its screen\.[\s\S]*?<span class="owner">Lead<\/span>/);
  assert.doesNotMatch(html, /<span class="id">lead<\/span>/, 'the sentinel ticket never shows');
  assert.ok(text(html).startsWith('Four things need you.') || text(html).includes('Four things need you.'));
  assert.match(text(html), /^4 sessions running/m);
});

test('the grey line gives the week left when the harness measures it', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  assert.equal(data.weekLeft, null, 'no route reports the week yet');
  const words = text(renderTower(towerModel({ ...data, weekLeft: 76 }, FIXTURE_NOW), en));
  assert.ok(words.includes('4 sessions running · 1 plan in progress · 2 landed today · Claude 76% left'));
  const french = text(renderTower(towerModel({ ...data, weekLeft: 76 }, FIXTURE_NOW), fr));
  assert.match(french, /Claude\u00a0: 76 % restants/);
});

test('the pill shows only while a generation of the lead is live, or refreshing between two', () => {
  assert.equal(leadPillShown(leadState('idle')), true);
  assert.equal(leadPillShown(leadState('working')), true);
  assert.equal(leadPillShown(leadState('refreshing')), true);
  assert.equal(leadPillShown(leadState('starting')), false);
  assert.equal(leadPillShown(leadState('down')), false);
  assert.equal(leadPillShown(null), false);
});

test('the shell draws the lead\'s dot beside Plans, none before the first read, so no page render calls the service', async () => {
  const app = await startApp();
  try {
    const { cookie } = await signedIn(app);
    for (const path of ['/', '/inbox', '/lead']) {
      const html = await (await fetch(`${app.base}${path}`, { headers: { cookie } })).text();
      assert.doesNotMatch(html, /lead-dot|sidebar/, `${path}: the server writes no sidebar; the shell draws it`);
    }
  } finally {
    await app.close();
  }
  const shell = translator(loadCatalog('shell', 'en'));
  for (const screen of ['tower', 'inbox', 'lead'] as const) assert.doesNotMatch(renderSidebar(screen, shell), /lead-dot/, `${screen}: not known yet, no dot`);
  const on = renderSidebar('tower', shell, { lead: 'on' });
  assert.match(on, /<a class="nav-item" href="\/lead"[^>]*>[^]*?<span class="lead-dot" id="lead-dot" data-lead="on" aria-hidden="true"><\/span><span class="sr-only">The lead is on<\/span>/);
  assert.match(renderSidebar('tower', shell, { lead: 'down' }), /data-lead="down"[^]*?The lead is not running/);
});
