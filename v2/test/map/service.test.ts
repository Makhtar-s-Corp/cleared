// The map kept up to date (section 12.4): built at the first refresh and
// stored; built again only when a service's base commit, a fetch's outcome
// or the workspace file moved; one refresh at a time; a timer of
// CLEARED_V2_MAP_MINUTES (10, 0 for never).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Service } from '../../src/api/types.ts';
import type { ServiceRead } from '../../src/map/build.ts';
import { MAP_MINUTES, MAP_TABLES, ServiceMaps, mapMinutes, type MapServiceConfig } from '../../src/map/service.ts';
import { applyTables, openStore } from '../../src/store/db.ts';

type Spec = Pick<Service, 'name' | 'kind' | 'path' | 'consumes' | 'contract'>;
const config = (name: string, more: Partial<Spec> = {}): MapServiceConfig => ({ name, kind: 'repository', path: null, consumes: [], contract: null, base: 'main', dir: `/srv/${name}`, ...more });

function harness(options: { fetchFails?: string[] } = {}) {
  const store = openStore(':memory:');
  applyTables(store.db, MAP_TABLES);
  const heads: Record<string, string | null> = { web: 'a'.repeat(40), catalogue: 'b'.repeat(40) };
  const files: Record<string, Record<string, string>> = { web: { 'src/api.ts': 'export {};\n' }, catalogue: {} };
  let now = new Date('2026-10-25T18:00:00.000Z');
  const reads: string[] = [];
  const fetched: string[] = [];
  const deps = {
    db: store.db, project: 'w',
    services: [config('web', { consumes: ['catalogue'] }), config('catalogue')],
    fetch: async (name: string) => {
      fetched.push(name);
      if (options.fetchFails?.includes(name)) throw new Error('fatal: could not read from remote repository');
    },
    head: async (service: { name: string }) => heads[service.name] ?? null,
    read: async (service: { name: string }): Promise<ServiceRead> => {
      reads.push(service.name);
      return { name: service.name, commit: heads[service.name] ?? null, files: Object.entries(files[service.name] ?? {}).map(([path, text]) => ({ path, text })), conf: null, packageJson: null, contract: null, problems: [] };
    },
    now: () => now,
  };
  return { store, heads, files, reads, fetched, deps, tick: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); } };
}

test('before any refresh the map is the empty one; the first refresh fetches, reads and stores it', async () => {
  const h = harness();
  const maps = new ServiceMaps(h.deps);
  assert.equal(maps.current().builtAt, null);
  const map = await maps.refresh();
  assert.deepEqual([h.fetched, h.reads], [['web', 'catalogue'], ['web', 'catalogue']]);
  assert.equal(map.builtAt, '2026-10-25T18:00:00.000Z');
  assert.deepEqual(map.services.map((s) => s.commit), ['a'.repeat(40), 'b'.repeat(40)]);
  assert.deepEqual(new ServiceMaps(h.deps).current(), map, 'stored: a restart reads it back');
});

test('a refresh with no base moved reads nothing again and only says when it looked', async () => {
  const h = harness();
  const maps = new ServiceMaps(h.deps);
  await maps.refresh();
  h.tick(10);
  const again = await maps.refresh();
  assert.deepEqual(h.reads, ['web', 'catalogue']);
  assert.deepEqual([again.builtAt, again.readAt], ['2026-10-25T18:00:00.000Z', '2026-10-25T18:10:00.000Z']);
});

test('a base that moved builds the map again from every service', async () => {
  const h = harness();
  const maps = new ServiceMaps(h.deps);
  await maps.refresh();
  h.heads.web = 'c'.repeat(40);
  h.files.web = { 'src/api.ts': 'export {};\n', 'db/1.sql': 'CREATE TABLE visits (id int);\n' };
  h.tick(10);
  const map = await maps.refresh();
  assert.deepEqual(h.reads, ['web', 'catalogue', 'web', 'catalogue']);
  assert.equal(map.builtAt, '2026-10-25T18:10:00.000Z');
  assert.deepEqual(map.databases.map((d) => d.id), ['web:sql']);
});

test('a fetch that fails keeps the last base read and says so on that service, with no error text', async () => {
  const h = harness({ fetchFails: ['catalogue'] });
  const map = await new ServiceMaps(h.deps).refresh();
  assert.deepEqual(map.services.map((s) => [s.name, s.problems]), [['web', []], ['catalogue', ['fetch_failed']]]);
  assert.ok(!JSON.stringify(map).includes('remote repository'));
});

test('two refreshes at once read once', async () => {
  const h = harness();
  const maps = new ServiceMaps(h.deps);
  const [a, b] = await Promise.all([maps.refresh(), maps.refresh()]);
  assert.deepEqual(a, b);
  assert.deepEqual(h.reads, ['web', 'catalogue']);
});

test('the timer refreshes every interval until stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness();
  const maps = new ServiceMaps(h.deps);
  maps.startTimer(10 * 60_000);
  t.mock.timers.tick(10 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.fetched, ['web', 'catalogue']);
  maps.stop();
  t.mock.timers.tick(10 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.fetched, ['web', 'catalogue']);
});

test('CLEARED_V2_MAP_MINUTES: a whole number of minutes, 0 for never, anything else the default, said', (t) => {
  const said = t.mock.method(console, 'error', () => {});
  assert.equal(MAP_MINUTES, 10);
  assert.deepEqual([mapMinutes(undefined), mapMinutes(''), mapMinutes('0'), mapMinutes('30')], [10, 10, 0, 30]);
  assert.equal(mapMinutes('soon'), 10);
  assert.equal(mapMinutes('-1'), 10);
  assert.equal(said.mock.callCount(), 2);
  assert.match(String(said.mock.calls[0]?.arguments[0]), /CLEARED_V2_MAP_MINUTES is a whole number of minutes, not "soon"/);
});
