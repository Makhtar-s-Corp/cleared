// Take over and Give back (docs/v2/milestone-2-plan.md, decisions 30 and
// 32, lane 20): POST /api/sessions/:id/takeover interrupts the author's
// session, settles what waited for the human as cancelled and pauses it for
// the single owner account (the first account of the users table); the
// flow leaves a paused session alone (no idle stop, no review, no Go of the
// delay, no message) until POST /api/sessions/:id/giveback resumes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type SessionDetail } from '../../src/api/types.ts';
import { takeoverRoutes } from '../../src/flow/takeover.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionAdapter, SessionId } from '../../src/session/contract.ts';
import { fakeEffects, finished, permission, setup, started, text, until, type Setup, type SetupOptions } from './support.ts';

const PROOF = 'f'.repeat(64);
const HOUR = 3600_000;

// The author waits on a permission, then for a message: the take over
// interrupts it there, and the session stays open for the Give back.
const waitsOnPermission: readonly FakeStep[] = [started, ...text('a1', 'I will sort the entries.'), permission, { awaitMessage: true }, finished(0.4)];
const asksQuestion: readonly FakeStep[] = [
  started,
  { question: { requestId: 'question-1', questions: [{ question: 'Newest first everywhere?', header: 'Order', options: [{ label: 'Yes (Recommended)' }, { label: 'Only on the list' }] }] } },
  { awaitMessage: true }, finished(0.2),
];
const proposal: FakeStep = { hostCall: { toolCallId: 'plan-1', name: 'propose_session_plan', input: { steps: ['Sort the list'], files: ['src/entries.ts'], confidence: 'high', reason: 'One function.' } } };
const proposes: readonly FakeStep[] = [started, proposal, finished(0.1), { awaitMessage: true }, started, finished(0.3)];

type Harness = Setup & { readonly base: string; readonly server: Server; readonly resumed: SessionId[]; close(): Promise<void> };

async function harness(options: SetupOptions = {}): Promise<Harness> {
  const t = await setup(options);
  t.users.users.set('u2', { id: 'u2', name: 'Second' });
  // resume, counted: Give back resumes the session under its own id.
  const resumed: SessionId[] = [];
  const adapter = t.registry.sessionAdapters['claude-code'] as SessionAdapter;
  const resume = adapter.resume.bind(adapter);
  adapter.resume = async (id) => { resumed.push(id); return resume(id); };
  const app: App = { registry: t.engine.registry, tables: [], routes: takeoverRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...t, base, server, resumed,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t.engine.close();
    },
  };
}

const as = (user: string) => ({ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: user });

async function post(h: Harness, path: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${h.base}${path}`, { method: 'POST', headers });
  const body = await response.text();
  return { status: response.status, json: body ? JSON.parse(body) : undefined };
}

async function startAuthor(h: Harness, waits: () => boolean, what: string): Promise<SessionId> {
  await h.engine.start(h.ticket.id, 'u1');
  await until(waits, what);
  await h.engine.settled();
  return h.startedSessions[0]!.id;
}

const detail = (h: Harness, id: SessionId) => h.engine.sessionDetail(id) as SessionDetail;
const events = (h: Harness, id: SessionId) => h.store.events.after(id).map((e) => e.event);

test('the routes ask for the proof and a known user; Take over is the owner\'s alone, and an unknown session is 404', async () => {
  const h = await harness();
  try {
    for (const path of ['/api/sessions/s1/takeover', '/api/sessions/s1/giveback']) {
      assert.equal((await post(h, path, { [SERVICE_USER_HEADER]: 'u1' })).status, 401, `${path} without the proof`);
      assert.equal((await post(h, path, { [SERVICE_PROOF_HEADER]: PROOF })).status, 403, `${path} without a user`);
      assert.equal((await post(h, path, as('ghost'))).status, 403, `${path} with an unknown user`);
      assert.equal((await post(h, path, as('u1'))).status, 404, `${path} of an unknown session`);
    }
    const refused = await post(h, '/api/sessions/s1/takeover', as('u2'));
    assert.equal(refused.status, 403, 'a second account is refused before the session is looked at');
    assert.match((refused.json as { error: string }).error, /owner/);
  } finally {
    await h.close();
  }
});

test('Take over interrupts the author, settles what waited as cancelled and pauses it for the owner; a second account changes nothing', async () => {
  const h = await harness({ scripts: { author: waitsOnPermission } });
  try {
    const id = await startAuthor(h, () => h.inbox.waitingFor(h.startedSessions[0]?.id ?? '') > 0, 'the permission');
    const before = h.store.events.after(id).length;

    const second = await post(h, `/api/sessions/${id}/takeover`, as('u2'));
    assert.equal(second.status, 403);
    assert.equal(h.store.events.after(id).length, before, 'nothing was journaled for the refused take over');
    assert.equal(detail(h, id).takenOver ?? null, null);
    assert.equal(h.inbox.waitingFor(id), 1, 'the permission still waits');

    h.clock.now += 60_000;
    const taken = await post(h, `/api/sessions/${id}/takeover`, as('u1'));
    assert.deepEqual(taken, { status: 200, json: { accepted: true, by: 'u1' } });
    await h.engine.settled();
    await until(() => events(h, id).some((e) => e.type === 'RUN_FINISHED' && e.outcome.type === 'cancelled'), 'the interrupted turn');

    const answered = events(h, id).filter((e) => e.type === 'CUSTOM' && e.name === 'cleared.permission_answered');
    assert.ok(answered.length >= 1 && answered.every((e) => e.type === 'CUSTOM' && e.name === 'cleared.permission_answered' && e.value.decision === 'cancelled'), 'the permission was settled as cancelled');
    assert.equal(h.inbox.waitingFor(id), 0, 'nothing waits in the inbox for a paused session');
    const paused = detail(h, id);
    assert.deepEqual(paused.takenOver, { by: 'u1', at: new Date(h.clock.now).toISOString() });
    assert.deepEqual(paused.state.takenOver, paused.takenOver);
    assert.ok(h.engine.sessions().some((s) => s.id === id && s.takenOver?.by === 'u1'), 'the list says it too');

    assert.equal((await post(h, `/api/sessions/${id}/takeover`, as('u1'))).status, 409, 'a second take over');
  } finally {
    await h.close();
  }
});

test('a question that waited is cancelled by the take over', async () => {
  const h = await harness({ scripts: { author: asksQuestion } });
  try {
    const id = await startAuthor(h, () => h.inbox.waitingFor(h.startedSessions[0]?.id ?? '') > 0, 'the question');
    assert.equal((await post(h, `/api/sessions/${id}/takeover`, as('u1'))).status, 200);
    await h.engine.settled();
    assert.equal(h.inbox.waitingFor(id), 0);
    const settled = events(h, id).find((e) => e.type === 'CUSTOM' && e.name === 'cleared.permission_answered' && e.value.requestId === 'question-1');
    assert.ok(settled && settled.type === 'CUSTOM' && settled.name === 'cleared.permission_answered' && settled.value.decision === 'cancelled', 'the question reads cancelled');
  } finally {
    await h.close();
  }
});

test('a paused session is neither stopped by the idle rule, nor reviewed, nor written to, nor restarted for an hour; Give back resumes it', async () => {
  const h = await harness({ scripts: { author: waitsOnPermission } });
  try {
    const id = await startAuthor(h, () => h.inbox.waitingFor(h.startedSessions[0]?.id ?? '') > 0, 'the permission');
    assert.equal((await post(h, `/api/sessions/${id}/takeover`, as('u1'))).status, 200);
    await h.engine.settled();

    for (let minutes = 0; minutes < 61; minutes += 5) {
      h.clock.now += 5 * 60_000;
      await h.engine.tick();
      await h.engine.settled();
    }
    assert.ok(h.engine.sessionDetail(id)?.takenOver, 'still taken over an hour later');
    assert.ok(!['stopped', 'failed', 'done'].includes(detail(h, id).phase), `not ended (${detail(h, id).phase})`);
    assert.equal(h.startedSessions.length, 1, 'no reviewer and no new author started');
    assert.deepEqual(h.resumed, [], 'nothing resumed it');
    assert.equal((await h.tickets.get(h.ticket.id))?.status, 'In Progress');
    assert.ok(!events(h, id).some((e) => e.type === 'RUN_ERROR'), 'no stop was journaled');
    await assert.rejects(h.engine.send(id, 'hello', 'u1'), /taken over/, 'a message waits for the Give back');

    assert.equal((await post(h, `/api/sessions/${id}/giveback`, as('u2'))).status, 403, 'only who took it over gives it back');
    assert.deepEqual(await post(h, `/api/sessions/${id}/giveback`, as('u1')), { status: 200, json: { accepted: true } });
    assert.deepEqual(h.resumed, [id], 'resumed under its own id');
    assert.equal(detail(h, id).takenOver ?? null, null);
    assert.ok(events(h, id).some((e) => e.type === 'TEXT_MESSAGE_CONTENT' && /gave the session back/.test(e.delta)), 'the session is told');
    // The resumed author ends its turn: the review starts as it would have.
    await until(() => h.startedSessions.some((s) => s.input.role === 'reviewer'), 'the review');
    await h.engine.settled();
    assert.equal((await post(h, `/api/sessions/${id}/giveback`, as('u1'))).status, 409, 'nothing to give back any more');
  } finally {
    await h.close();
  }
});

test('the idle rule counts from the Give back, not from the take over', async () => {
  const h = await harness({ scripts: { author: waitsOnPermission, reopen: [{ awaitMessage: true }, { awaitMessage: true }] } });
  try {
    const id = await startAuthor(h, () => h.inbox.waitingFor(h.startedSessions[0]?.id ?? '') > 0, 'the permission');
    await post(h, `/api/sessions/${id}/takeover`, as('u1'));
    await h.engine.settled();
    h.clock.now += 2 * HOUR;
    await h.engine.tick();
    assert.equal((await post(h, `/api/sessions/${id}/giveback`, as('u1'))).status, 200);
    await h.engine.settled();
    h.clock.now += 60_000;
    await h.engine.tick();
    await h.engine.settled();
    assert.ok(!['stopped', 'failed'].includes(detail(h, id).phase), 'one minute after the Give back, the session runs');
  } finally {
    await h.close();
  }
});

test('a reviewer\'s session is not taken over, nor an ended one', async () => {
  const h = await harness({ scripts: { author: [started, finished(0.2)], reviewers: [[started, { awaitMessage: true }, finished(0.1)]] } });
  try {
    await h.engine.start(h.ticket.id, 'u1');
    await until(() => h.startedSessions.some((s) => s.input.role === 'reviewer'), 'the review');
    await h.engine.settled();
    const author = h.startedSessions[0]!.id;
    const reviewer = h.startedSessions.find((s) => s.input.role === 'reviewer')!.id;
    assert.equal((await post(h, `/api/sessions/${reviewer}/takeover`, as('u1'))).status, 409, 'a reviewer');
    assert.equal((await post(h, `/api/sessions/${author}/takeover`, as('u1'))).status, 409, 'an author whose turn ended');
  } finally {
    await h.close();
  }
});

test('a held session plan stays in the inbox while paused, gets no Go from the delay, and takes its Go after the Give back', async () => {
  const settings = await fakeEffects([]).settings();
  const h = await harness({ scripts: { author: proposes }, config: { authorTools: true }, effects: { settings: async () => settings } });
  try {
    const plan = () => h.inbox.items().find((item) => item.kind === 'session_plan' && item.state === 'waiting');
    const id = await startAuthor(h, () => plan() !== undefined, 'the session plan');
    assert.equal((await post(h, `/api/sessions/${id}/takeover`, as('u1'))).status, 200);
    await h.engine.settled();
    assert.ok(plan(), 'the plan still waits for its Go');
    h.clock.now += 30 * 60_000;
    await h.engine.tick();
    await h.engine.settled();
    assert.equal(detail(h, id).state.plan?.go ?? null, null, 'no Go by the delay while paused');
    await assert.rejects(h.engine.planGo(id, 'u1'), /taken over/, 'no Go by the owner while paused');
    assert.equal((await post(h, `/api/sessions/${id}/giveback`, as('u1'))).status, 200);
    await h.engine.settled();
    await h.engine.planGo(id, 'u1');
    await h.engine.settled();
    assert.equal(detail(h, id).state.plan?.go?.by, 'u1');
  } finally {
    await h.close();
  }
});
