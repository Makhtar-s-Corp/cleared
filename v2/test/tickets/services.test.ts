// A ticket belongs to the workspace and names the services it touches
// (milestone 2, lane 14, decision 18): ticket_services, POST /api/tickets
// with services, GET /api/workspace.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApiRoutes } from '../../src/api/routes.ts';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type Workspace } from '../../src/api/types.ts';
import { workspaceOf } from '../../src/flow/config.ts';
import tickets, { recordWorkspaceOf } from '../../src/modules/tickets.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';
import { LocalTicketStore, TICKET_TABLES, WORKSPACE_TABLES } from '../../src/tickets/local-store.ts';
import { MIRROR_TABLES } from '../../src/tickets/mirror.ts';
import type { WorkspaceConfig } from '../../src/workspace/config.ts';
import { CONFIG, setup, type Setup } from '../flow/support.ts';

const agents = { kind: 'agents' as const, id: 'cleared-v2' };
const clock = () => '2026-10-23T08:00:00.000Z';

test('the memory store keeps the services a ticket names, and a ticket that names none has no services field', async () => {
  const store = new MemoryTicketStore({ now: clock });
  const two = await store.create({ title: 'Held for review', project: 'guestbook', services: ['filter-api', 'guestbook'] }, agents);
  assert.deepEqual(two.services, [
    { name: 'filter-api', branch: null, pr: null, state: 'open' },
    { name: 'guestbook', branch: null, pr: null, state: 'open' },
  ]);
  assert.deepEqual((await store.get(two.id))?.services, two.services);
  const one = await store.create({ title: 'Newest entry first', project: 'guestbook' }, agents);
  assert.equal('services' in one, false, 'the one-service ticket reads as before');
});

test('the local store writes ticket_services, creating it when only the tracker tables exist, and reads it back on get and list', async () => {
  const db = new DatabaseSync(':memory:');
  applyTables(db, TICKET_TABLES);
  const store = new LocalTicketStore(db, { stateDir: '/nonexistent', now: clock });
  const two = await store.create({ title: 'Held for review', project: 'guestbook', services: ['filter-api', 'guestbook'] }, agents);
  const one = await store.create({ title: 'Newest entry first', project: 'guestbook' }, agents);
  const expected = [
    { name: 'filter-api', branch: null, pr: null, state: 'open' },
    { name: 'guestbook', branch: null, pr: null, state: 'open' },
  ];
  assert.deepEqual(two.services, expected);
  assert.deepEqual((await store.get(two.id))?.services, expected);
  assert.deepEqual((await store.list()).map((t) => t.services), [expected, undefined]);
  assert.equal('services' in one, false);
  assert.deepEqual(db.prepare('SELECT ticket, service, branch, pr, state FROM ticket_services ORDER BY rowid').all().map((r) => ({ ...r })), [
    { ticket: 'LOCAL-1', service: 'filter-api', branch: null, pr: null, state: 'open' },
    { ticket: 'LOCAL-1', service: 'guestbook', branch: null, pr: null, state: 'open' },
  ]);
  // The tracker row itself is the one v1 writes: no column was added to it.
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM tracker_tickets WHERE id = 1').get() as object), ['id', 'title', 'body', 'labels', 'project', 'status', 'created_at', 'updated_at']);
});

test('the tickets module declares the workspace tables apart from the v1 tracker tables, and serves GET /api/workspace', () => {
  // The mirrors' tables come after (milestone 4, P230).
  assert.deepEqual(tickets.tables, [...TICKET_TABLES, ...WORKSPACE_TABLES, ...MIRROR_TABLES]);
  for (const statement of WORKSPACE_TABLES) assert.match(statement, /^CREATE TABLE IF NOT EXISTS (workspaces|services|ticket_services) /);
  assert.deepEqual(tickets.routes.map((r) => `${r.method} ${r.path}`), ['GET /api/workspace']);
});

const TWO: WorkspaceConfig = {
  id: 'guestbook', name: 'Guestbook and its filter', file: '/state/workspace.conf',
  services: [
    { ...workspaceOf(CONFIG).services[0]!, consumes: ['filter-api'], run: { dockerfile: 'Dockerfile', port: 3000 } },
    {
      name: 'filter-api', kind: 'repository', repo: 'example-org/cleared-example-filter-api', url: 'https://example.invalid/filter-api.git', base: 'main', path: null,
      dir: '/srv/filter-api', healthUrl: null, sensitivity: 'full', consumes: [], run: null, contract: { format: 'openapi', path: 'contract/openapi.yaml' },
      brokerSocket: '/state/filter-api/broker.sock', brokerState: '/state/filter-api',
    },
  ],
};

test('the workspace rows mirror the configuration, are written once, and keep their creation time', () => {
  const store = openStore(':memory:');
  try {
    applyTables(store.db, tickets.tables);
    recordWorkspaceOf(store.db, {}, clock);
    assert.deepEqual(store.db.prepare('SELECT * FROM workspaces').all(), [], 'no project, no workspace');
    const env = {
      CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git',
      CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state',
    };
    recordWorkspaceOf(store.db, env, clock);
    recordWorkspaceOf(store.db, env, () => '2026-10-24T08:00:00.000Z');
    assert.deepEqual(store.db.prepare('SELECT * FROM workspaces').all().map((r) => ({ ...r })), [{ id: 'guestbook', name: 'guestbook', created_at: '2026-10-23T08:00:00.000Z' }]);
    assert.deepEqual(store.db.prepare('SELECT * FROM services').all().map((r) => ({ ...r })), [{
      workspace: 'guestbook', name: 'guestbook', kind: 'repository', repo: 'example-org/cleared-example-guestbook', url: 'https://example.invalid/guestbook.git',
      base: 'main', path: null, health_url: null, sensitivity: 'normal', consumes: '[]', run: null, contract: null, created_at: '2026-10-23T08:00:00.000Z',
    }]);
  } finally {
    store.close();
  }
});

let t: Setup;
let server: Server;
let base = '';
const PROOF = 'b'.repeat(64);
const person = { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

before(async () => {
  t = await setup({ config: { workspace: TWO } });
  const app: App = { registry: t.engine.registry, tables: [], routes: createApiRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, { method, headers: person, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}

test('GET /api/workspace answers the workspace and its services, without the server\'s paths', async () => {
  const { status, json } = await call('GET', '/api/workspace');
  assert.equal(status, 200);
  const workspace = json as Workspace;
  assert.equal(workspace.id, 'guestbook');
  assert.deepEqual(workspace.services.map((s) => [s.name, s.sensitivity, s.consumes, s.contract]), [
    ['guestbook', 'normal', ['filter-api'], null],
    ['filter-api', 'full', [], { format: 'openapi', path: 'contract/openapi.yaml' }],
  ]);
  assert.ok(!JSON.stringify(json).includes('/srv/') && !JSON.stringify(json).includes('/state/'));
  const refused = await fetch(`${base}/api/workspace`);
  assert.equal(refused.status, 401, 'the proof first, as every route');
});

test('POST /api/tickets takes the services a ticket touches, and refuses an unknown one, a repeated one or a wrong shape', async () => {
  const created = await call('POST', '/api/tickets', { title: 'Held for review', project: 'guestbook', services: ['filter-api', 'guestbook'] });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.deepEqual(created.json.services.map((s: { name: string }) => s.name), ['filter-api', 'guestbook']);
  assert.deepEqual((await t.tickets.get(created.json.id))?.services?.map((s) => s.name), ['filter-api', 'guestbook']);
  const count = (await t.tickets.list()).length;
  for (const [services, pattern] of [
    [['payments'], /payments is not a service of workspace guestbook/],
    [['guestbook', 'guestbook'], /more than once/],
    ['guestbook', /list/],
    [[3], /list/],
    [[], /at least one/],
  ] as const) {
    const refused = await call('POST', '/api/tickets', { title: 'x', project: 'guestbook', services });
    assert.equal(refused.status, 400, JSON.stringify(services));
    assert.match(refused.json.error, pattern);
  }
  assert.equal((await t.tickets.list()).length, count, 'nothing was created by the refused ones');
  // Without services, as in milestone 1.
  const plain = await call('POST', '/api/tickets', { title: 'Newest entry first', project: 'guestbook' });
  assert.equal(plain.status, 200);
  assert.equal('services' in plain.json, false);
});
