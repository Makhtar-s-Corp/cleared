// The map's two routes (section 11.4): GET /api/service-map, built at the
// first read, and POST /api/service-map/refresh, for a known user; the app's
// proof first, then the flow running. The lead module declares them, their
// table, and gives the lead its tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAP_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type ServiceMap } from '../../src/api/types.ts';
import { serviceMapRoutes } from '../../src/map/routes.ts';
import { MAP_TABLES, ServiceMaps } from '../../src/map/service.ts';
import lead from '../../src/modules/lead.ts';
import { MemoryUsers, defaultRegistry, dispatch, type Registry } from '../../src/modules/registry.ts';
import { handle as health } from '../../src/server.ts';
import { applyTables, openStore } from '../../src/store/db.ts';

const PROOF = 'proof-of-the-app';

async function serve(options: { running?: boolean } = {}) {
  const store = openStore(':memory:');
  applyTables(store.db, MAP_TABLES);
  let reads = 0;
  const maps = new ServiceMaps({
    db: store.db, project: 'w',
    services: [{ name: 'web', kind: 'repository', path: null, consumes: [], contract: null, base: 'main', dir: '/srv/web' }],
    fetch: async () => {}, head: async () => 'a'.repeat(40),
    read: async () => { reads++; return { name: 'web', commit: 'a'.repeat(40), files: [], conf: null, packageJson: null, contract: null, problems: [] }; },
    now: () => new Date('2026-10-25T18:00:00.000Z'),
  });
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1', name: 'owner' });
  const registry: Registry = { ...defaultRegistry(), users };
  const routes = serviceMapRoutes({ maps: () => (options.running === false ? undefined : maps), proof: () => PROOF });
  const server: Server = createServer((request, response) => dispatch({ registry, tables: [], routes }, request, response, health));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, o: { user?: string | null; proof?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    const proof = o.proof === undefined ? PROOF : o.proof;
    const user = o.user === undefined ? 'u1' : o.user;
    if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
    if (user !== null) headers[SERVICE_USER_HEADER] = user;
    const response = await fetch(`${base}${path}`, { method, headers });
    return { status: response.status, body: await response.json() as unknown };
  };
  return { call, reads: () => reads };
}

test('the lead module declares the map\'s routes and its table', () => {
  const declared = lead.routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual([...MAP_ROUTES].sort(), ['GET /api/service-map', 'POST /api/service-map/refresh']);
  for (const route of MAP_ROUTES) assert.ok(declared.includes(route), route);
  for (const table of MAP_TABLES) assert.ok(lead.tables.includes(table));
});

test('both routes answer 401 without the proof and 503 while the flow does not run; the refresh needs a known user', async () => {
  const t = await serve();
  const down = await serve({ running: false });
  for (const [method, path] of [['GET', '/api/service-map'], ['POST', '/api/service-map/refresh']] as const) {
    assert.equal((await t.call(method, path, { proof: 'wrong' })).status, 401);
    assert.equal((await down.call(method, path)).status, 503);
  }
  assert.equal((await t.call('POST', '/api/service-map/refresh', { user: 'stranger' })).status, 403);
  assert.equal((await t.call('POST', '/api/service-map/refresh', { user: null })).status, 403);
  assert.equal((await t.call('GET', '/api/service-map', { user: null })).status, 200, 'a read needs no user');
});

test('the first read builds the map; the next reads give the stored one; a refresh looks again', async () => {
  const t = await serve();
  const first = await t.call('GET', '/api/service-map');
  assert.equal(first.status, 200);
  assert.equal((first.body as ServiceMap).builtAt, '2026-10-25T18:00:00.000Z');
  await t.call('GET', '/api/service-map');
  assert.equal(t.reads(), 1);
  const refreshed = await t.call('POST', '/api/service-map/refresh');
  assert.equal(refreshed.status, 200);
  assert.deepEqual((refreshed.body as ServiceMap).services.map((s) => s.name), ['web']);
});
