import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, LeadMemory, LeadMessage, LeadState, Plan, SessionSummary } from '../../src/api/types.ts';
import { LEAD_TICKET } from '../../src/lead/contract.ts';
import type { CustomValue } from '../../src/session/events.ts';
import { leadFixture, LEAD_ANSWER } from '../fixtures/lead.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { fixtureSource } from '../fixtures/source.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { signedIn, startApp } from './support.ts';

test('the fixture source answers the service\'s routes from lane 1\'s fake sessions', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const sessions = await (await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } })).json() as SessionSummary[];
    assert.equal(sessions.length, 4);
    assert.ok(sessions.every((s) => s.lastSeq > 0), 'each session has stored events');
    const inbox = await (await fetch(`${app.base}/api/service/inbox`, { headers: { cookie } })).json() as InboxItem[];
    assert.deepEqual(inbox.map((i) => i.kind), ['release', 'permission', 'plan']);
    const first = sessions[0]!;
    const detail = await fetch(`${app.base}/api/service/sessions/${first.id}`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const events = await fetch(`${app.base}/api/service/sessions/${first.id}/events?after=0`, { headers: { cookie } });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const text = await events.text();
    assert.match(text, /^id: 1\nevent: STEP_STARTED\ndata: /);
    assert.equal((await fetch(`${app.base}/api/service/sessions/nope`, { headers: { cookie } })).status, 404);
  } finally {
    await app.close();
  }
});

test('creating a ticket works on the fixtures, in Todo, under the signed-in user', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie, csrf } = await signedIn(app);
    const created = await fetch(`${app.base}/api/service/tickets`, {
      method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'The guestbook shows the newest entry first', project: 'guestbook' }),
    });
    assert.equal(created.status, 201);
    const ticket = await created.json() as Ticket;
    assert.equal(ticket.status, 'Todo');
    assert.equal(ticket.title, 'The guestbook shows the newest entry first');
    const tickets = await (await fetch(`${app.base}/api/service/tickets`, { headers: { cookie } })).json() as Ticket[];
    assert.ok(tickets.some((t) => t.id === ticket.id));
    for (const body of ['{"title":"","project":"guestbook"}', '{"project":"guestbook"}', 'not json', JSON.stringify({ title: 'x'.repeat(201), project: 'guestbook' })]) {
      const refused = await fetch(`${app.base}/api/service/tickets`, { method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body });
      assert.equal(refused.status, 400, body);
    }
    assert.equal((await fetch(`${app.base}/api/service/tickets/${ticket.id}/approve`, { method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf } })).status, 404, 'the fixtures approve nothing');
  } finally {
    await app.close();
  }
});

// Milestone 2, lane 1: the lead's fixture is the scripted lead of the fake
// adapter played into a store, and the fixture source answers every read
// route of section 7.1 from it.
test('the lead fixture is played by the scripted lead: one question, one commitment, one plan, a context rising to 45 %', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const events = fixture.store.events.after(fixture.session.id);
  const customs = <N extends keyof CustomValue>(name: N): CustomValue[N][] =>
    events.flatMap(({ event }) => (event.type === 'CUSTOM' && event.name === name ? [event.value as CustomValue[N]] : []));
  assert.deepEqual(customs('cleared.question').map((q) => q.requestId), ['lead-question-1']);
  assert.deepEqual(customs('cleared.host_call').map((c) => [c.name, c.outcome]), [['search_memory', 'ok'], ['propose_plan', 'ok'], ['commit', 'ok']]);
  assert.deepEqual(customs('cleared.context_usage').map((c) => c.percent), [9, 12, 31, 45]);
  assert.equal(fixture.session.role, 'lead');
  assert.equal(fixture.session.ticket, LEAD_TICKET);

  assert.deepEqual(fixture.messages.map((m) => [m.by, m.kind]), [['system', 'refresh'], ['owner', 'message'], ['lead', 'question'], ['owner', 'message'], ['lead', 'plan']]);
  assert.deepEqual(fixture.messages.map((m) => m.seq), [1, 2, 3, 4, 5]);
  assert.equal(fixture.messages[3]?.text, LEAD_ANSWER);
  assert.equal(fixture.messages[2]?.question?.state, 'handled');
  assert.equal(fixture.state.context?.percent, 45);
  assert.equal(fixture.state.openCommitments, 1);
  const [plan] = fixture.plans;
  assert.ok(plan);
  assert.equal(fixture.messages[4]?.planId, plan.id);
  assert.deepEqual(plan.items.map((i) => [i.position, i.lane, i.after]), [[1, 'full', []], [2, 'full', [1]], [3, 'full', [2]], [4, 'fast', []], [5, 'fast', []]]);
  assert.equal(plan.totals.minutes, 120, 'the critical path 1, 2, 3, not the sum');
  assert.equal(plan.totals.samples, 23);
  assert.equal(plan.state, 'proposed');
  assert.ok(plan.items.every((i) => i.body.includes('- [ ]') && i.ticket === null && i.state === 'waiting'));
  assert.deepEqual(fixture.memory.commitments.map((c) => c.state), ['open', 'done']);
  assert.equal(fixture.session.project, 'guestbook', 'neutral names: the example guestbook');
});

test('the fixture source answers the lead and plan read routes, and refuses their writes', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie, csrf } = await signedIn(app);
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${app.base}/api/service${path}`, { headers: { cookie, ...headers } });
    const state = await (await get('/lead')).json() as LeadState;
    assert.deepEqual([state.generation, state.phase, state.context?.percent, state.refreshCount, state.model], [3, 'idle', 45, 2, 'claude-opus-5-5']);
    const thread = await (await get('/lead/messages')).json() as LeadMessage[];
    assert.equal(thread.length, 5);
    assert.deepEqual((await (await get('/lead/messages?after=3')).json() as LeadMessage[]).map((m) => m.seq), [4, 5]);
    const stream = await get('/lead/stream?after=4');
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const frames = await stream.text();
    assert.match(frames, /^id: 5\nevent: message\ndata: /);
    assert.match(frames, /\nevent: state\ndata: /);
    assert.match(frames, /\nevent: plan\ndata: /);
    assert.ok(!frames.includes('id: 4\n'), 'the stream starts after the seq it is given');
    assert.match(await (await get('/lead/stream', { 'last-event-id': '4' })).text(), /^id: 5\n/);
    const memory = await (await get('/lead/memory')).json() as LeadMemory;
    assert.equal(memory.handover?.generation, 2);
    assert.equal(memory.commitments.length, 2);
    const plans = await (await get('/plans')).json() as Plan[];
    assert.deepEqual(plans.map((p) => p.state), ['proposed', 'approved'], 'the lead\'s proposal, then the tower\'s plan under way');
    const plan = plans[0] as Plan;
    assert.equal(((await (await get(`/plans/${plan.id}`)).json()) as Plan).title, plan.title);
    assert.equal((await get('/plans/nope')).status, 404);
    const inbox = await (await get('/inbox')).json() as InboxItem[];
    assert.equal(inbox.filter((i) => i.kind === 'plan').length, 1, 'one plan waits: the lead fixture\'s');
    const item = inbox.find((i) => i.kind === 'plan');
    assert.ok(item && item.kind === 'plan');
    assert.deepEqual([item.ticket, item.planId, item.itemCount, item.state], [LEAD_TICKET, plan.id, 5, 'waiting']);

    const post = (path: string, body: unknown) => fetch(`${app.base}/api/service${path}`, { method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const [path, body] of [['/lead/messages', { text: 'hello' }], [`/plans/${plan.id}/approve`, {}], [`/plans/${plan.id}/reject`, { message: 'no' }], [`/plans/${plan.id}/pause`, {}], [`/plans/${plan.id}/resume`, {}]] as const) {
      assert.equal((await post(path, body)).status, 404, path);
    }
  } finally {
    await app.close();
  }
});
