// A ticket's steps and the contract item over HTTP (docs/v2/milestone-2-plan.md,
// decision 26, lane 23): GET /api/tickets/:id/steps, and the contract
// item's POST /api/contracts/:id/approve and /sendback, served by
// flow/steps.ts with the checks of every route of the service's API.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type TicketStep } from '../../src/api/types.ts';
import { stepRoutes } from '../../src/flow/steps.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { quickAuthor, setup, until, type Setup } from './support.ts';

const PROOF = 'd'.repeat(64);
let t: Setup;
let server: Server;
let base = '';

before(async () => {
  t = await setup({ scripts: { author: quickAuthor }, config: { steps: true } });
  const app: App = { registry: t.engine.registry, tables: [], routes: stepRoutes({ engine: () => t.engine, proof: () => PROOF }) };
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

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

test('the steps of a ticket: the proof first, an unknown ticket not found, a one-service ticket its one step', async () => {
  assert.equal((await call('GET', `/api/tickets/${t.ticket.id}/steps`, {})).status, 401);
  assert.equal((await call('GET', '/api/tickets/LOCAL-99/steps', { [SERVICE_PROOF_HEADER]: PROOF })).status, 404);
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  const answer = await call('GET', `/api/tickets/${t.ticket.id}/steps`, { [SERVICE_PROOF_HEADER]: PROOF });
  assert.equal(answer.status, 200);
  assert.deepEqual((answer.json as TicketStep[]).map((s) => [s.position, s.kind, s.service, s.state]), [[1, 'service', 'guestbook', 'done']]);
});

test('Approve and Send back refuse a request without the proof, a write without a known user, an unknown item, and a Send back without its message', async () => {
  for (const path of ['/api/contracts/c1/approve', '/api/contracts/c1/sendback']) {
    assert.equal((await call('POST', path, { 'content-type': 'application/json', [SERVICE_USER_HEADER]: 'u1' }, { message: 'x' })).status, 401, `${path} without the proof`);
    assert.equal((await call('POST', path, { [SERVICE_PROOF_HEADER]: PROOF, 'content-type': 'application/json' }, { message: 'x' })).status, 403, `${path} without a user`);
    assert.equal((await call('POST', path, { ...person, [SERVICE_USER_HEADER]: 'ghost' }, { message: 'x' })).status, 403, `${path} with an unknown user`);
    assert.equal((await call('POST', path, person, { message: 'x' })).status, 404, `${path} of an unknown item`);
  }
  const item = t.inbox.addContract({ ticket: t.ticket.id, project: 'guestbook', sessionId: 's9', step: 'no-such-step', service: 'guestbook', path: 'contract/openapi.yaml', diff: '+x\n' });
  assert.equal((await call('POST', `/api/contracts/${encodeURIComponent(item.id)}/sendback`, person, { message: '' })).status, 400);
  assert.equal((await call('POST', `/api/contracts/${encodeURIComponent(item.id)}/sendback`, person, { message: 'x'.repeat(2001) })).status, 400);
  assert.equal((await call('POST', `/api/contracts/${encodeURIComponent(item.id)}/approve`, person)).status, 409, 'an item whose step the ticket does not have');
  assert.equal(t.inbox.item(item.id)?.state, 'waiting', 'nothing was handled');
});
