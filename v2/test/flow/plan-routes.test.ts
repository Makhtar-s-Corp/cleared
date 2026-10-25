// The session plan's Go and Change over HTTP (docs/v2/milestone-2-plan.md,
// decision 22, lane 17): POST /api/sessions/:id/plan/go and
// POST /api/sessions/:id/plan/change, served by flow/plan-gate.ts with the
// checks of every write of the service's API.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type SessionDetail } from '../../src/api/types.ts';
import { planGateRoutes } from '../../src/flow/plan-gate.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { fakeEffects, finished, setup, started, until, type Setup } from './support.ts';

const PROOF = 'd'.repeat(64);
const proposal = (id: string, confidence: string): FakeStep => ({ hostCall: { toolCallId: id, name: 'propose_session_plan', input: { steps: ['Sort'], files: ['src/entries.ts'], confidence, reason: 'One function.' } } });
const script: readonly FakeStep[] = [
  started, proposal('plan-1', 'low'), finished(0.1), { awaitMessage: true },
  started, proposal('plan-2', 'medium'), finished(0.1), { awaitMessage: true },
  started, finished(0.3),
];

let t: Setup;
let server: Server;
let base = '';

before(async () => {
  const settings = await fakeEffects([]).settings();
  t = await setup({ scripts: { author: script }, config: { authorTools: true }, effects: { settings: async () => settings } });
  const app: App = { registry: t.engine.registry, tables: [], routes: planGateRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.engine.close();
});

const person = { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

async function call(path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

const waiting = () => t.inbox.items().find((item) => item.kind === 'session_plan' && item.state === 'waiting');

test('the Go and the Change refuse a request without the proof, a write without a known user, and an unknown session', async () => {
  for (const path of ['/api/sessions/s1/plan/go', '/api/sessions/s1/plan/change']) {
    assert.equal((await call(path, { 'content-type': 'application/json', [SERVICE_USER_HEADER]: 'u1' }, { message: 'x' })).status, 401, `${path} without the proof`);
    assert.deepEqual((await call(path, { ...person, [SERVICE_PROOF_HEADER]: 'e'.repeat(64) }, { message: 'x' })).json, { error: 'unauthorized' });
    assert.equal((await call(path, { [SERVICE_PROOF_HEADER]: PROOF, 'content-type': 'application/json' }, { message: 'x' })).status, 403, `${path} without a user`);
    assert.equal((await call(path, { ...person, [SERVICE_USER_HEADER]: 'ghost' }, { message: 'x' })).status, 403, `${path} with an unknown user`);
    assert.equal((await call(path, person, { message: 'x' })).status, 404, `${path} of an unknown session`);
  }
});

test('the Change takes a message, the Go nothing; each answers 409 once nothing waits', async () => {
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!.id;
  await until(() => waiting() !== undefined, 'the first plan');
  await t.engine.settled();
  assert.equal((await call(`/api/sessions/${author}/plan/change`, person, {})).status, 400, 'a Change without a message');
  assert.equal((await call(`/api/sessions/${author}/plan/change`, person, { message: 'x'.repeat(2001) })).status, 400, 'a Change too long');
  const first = waiting()?.id;
  assert.deepEqual(await call(`/api/sessions/${author}/plan/change`, person, { message: 'Test the empty list.' }), { status: 200, json: { accepted: true } });
  await until(() => waiting() !== undefined && waiting()?.id !== first, 'the second plan');
  await t.engine.settled();
  assert.deepEqual(await call(`/api/sessions/${author}/plan/go`, person), { status: 200, json: { accepted: true } });
  const detail = t.engine.sessionDetail(author) as SessionDetail;
  assert.equal(detail.state.plan?.go?.by, 'u1');
  assert.equal(detail.state.plan?.confidence, 'medium');
  assert.equal((await call(`/api/sessions/${author}/plan/go`, person)).status, 409, 'a second Go');
  assert.equal((await call(`/api/sessions/${author}/plan/change`, person, { message: 'late' })).status, 409, 'a Change after the Go');
});
