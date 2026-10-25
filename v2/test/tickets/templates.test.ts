// Ready-made tickets (P214, issue #330): the four templates' ids, the label a
// template's ticket carries, and the route that creates it: the label kept,
// an unknown kind or two kinds refused before the ticket exists.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { createApiRoutes } from '../../src/api/routes.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { TICKET_TEMPLATES, typeLabel, typeLabelProblem } from '../../src/tickets/templates.ts';
import { setup, type Setup } from '../flow/support.ts';

const PROOF = 'c'.repeat(64);
let t: Setup;
let server: Server;
let base = '';

before(async () => {
  t = await setup();
  const app: App = { registry: t.engine.registry, tables: [], routes: createApiRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const person = { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}/api/tickets`, { method: 'POST', headers: person, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

test('four templates, Bug, Review, CI and Question, each a type label', () => {
  assert.deepEqual(TICKET_TEMPLATES, ['bug', 'review', 'ci', 'question']);
  assert.deepEqual(TICKET_TEMPLATES.map(typeLabel), ['type:bug', 'type:review', 'type:ci', 'type:question']);
});

test('a ticket names one known kind at most; the other labels are not read', () => {
  assert.equal(typeLabelProblem([]), null);
  assert.equal(typeLabelProblem(['Quick', 'plan:p1', 'size:s', 'batch:batch-1', 'chat']), null);
  for (const template of TICKET_TEMPLATES) assert.equal(typeLabelProblem(['Quick', typeLabel(template)]), null);
  assert.match(typeLabelProblem(['type:feature']) ?? '', /type:feature/);
  assert.match(typeLabelProblem(['type:']) ?? '', /type:/);
  assert.match(typeLabelProblem(['type:bug', 'type:ci']) ?? '', /one/);
  assert.match(typeLabelProblem(['type:bug', 'type:bug']) ?? '', /one/);
});

test('the route keeps a template\'s label and refuses a bad kind before the ticket exists', async () => {
  const made = await post({ title: 'The guestbook drops long names', body: '## What happens\n\nCut at 40.', labels: ['type:bug'], project: 'guestbook' });
  assert.equal(made.status, 200);
  const ticket = made.json as Ticket;
  assert.deepEqual(ticket.labels, ['type:bug']);
  assert.deepEqual((await t.tickets.get(ticket.id))?.labels, ['type:bug']);

  const count = (await t.tickets.list()).length;
  for (const labels of [['type:feature'], ['type:bug', 'type:question']]) {
    const refused = await post({ title: 'Refused', labels, project: 'guestbook' });
    assert.equal(refused.status, 400, labels.join(','));
  }
  assert.equal((await t.tickets.list()).length, count, 'no ticket is created');
});
