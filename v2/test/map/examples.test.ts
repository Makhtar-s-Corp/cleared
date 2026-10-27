// The map of the two example repositories as they are committed
// (examples/workspace.conf, examples/guestbook, examples/filter-api): the
// guestbook calls the filter API's POST /check from src/filter.ts, which the
// workspace declares; it keeps its entries in Postgres; the filter API's
// contract has two operations. Its test fake, its own /health route and its
// DATABASE_URL are not in the map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildMap } from '../../src/map/build.ts';
import { readFolder } from '../../src/map/source.ts';
import { parseWorkspace } from '../../src/workspace/config.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
const AT = '2026-10-25T18:00:00.000Z';

function exampleMap() {
  const workspace = parseWorkspace(readFileSync(`${EXAMPLES}workspace.conf`, 'utf8'), { file: `${EXAMPLES}workspace.conf`, authorModel: 'claude-opus-5-5', stateDir: '/tmp/unused' });
  const reads = workspace.services.map((service) => readFolder(`${EXAMPLES}${service.name}`, service));
  return buildMap({ workspace: workspace.id, services: workspace.services, reads, at: AT });
}

test('the guestbook calls the filter API\'s POST /check, declared in the workspace and found in src/filter.ts', () => {
  const map = exampleMap();
  assert.deepEqual(map.services.map((service) => service.name), ['guestbook', 'filter-api']);
  assert.deepEqual(map.links.filter((link) => link.kind === 'call'), [{
    kind: 'call', from: 'guestbook', to: 'filter-api', items: ['POST /check'], declared: true, found: true, places: [{ file: 'src/filter.ts', line: 38 }],
  }]);
  assert.equal(map.builtAt, AT);
});

test('the filter API\'s contract is read with its two operations; the guestbook has none', () => {
  const map = exampleMap();
  assert.deepEqual(map.services.find((service) => service.name === 'filter-api')?.contract, {
    format: 'openapi', path: 'contract/openapi.yaml', operations: ['POST /check', 'GET /health'], channels: [],
  });
  assert.equal(map.services.find((service) => service.name === 'guestbook')?.contract, null);
});

test('the guestbook keeps its entries in Postgres; the filter API has no database', () => {
  const map = exampleMap();
  assert.deepEqual(map.databases, [{ id: 'guestbook:postgres', engine: 'postgres', owner: 'guestbook', tables: ['entries'] }]);
  assert.deepEqual(map.links.filter((link) => link.kind === 'database'), [{
    kind: 'database', from: 'guestbook', to: 'guestbook:postgres', items: ['entries'], declared: false, found: true, places: [{ file: 'src/store.ts', line: 28 }],
  }]);
});

test('no test fake, no served route, no setting\'s value and no event reach the map', () => {
  const map = exampleMap();
  const text = JSON.stringify(map);
  assert.ok(!text.includes('fake-filter'), 'the test helper is not read');
  assert.ok(!map.links.some((link) => link.items.includes('GET /health')), 'the guestbook serves /health, it does not call it');
  assert.ok(!text.includes('postgres://') && !text.includes('DATABASE_URL') && !text.includes('POSTGRES_HOST_AUTH_METHOD'));
  assert.deepEqual(map.links.filter((link) => link.kind === 'event'), []);
  for (const service of map.services) assert.deepEqual([service.problems, service.dropped], [[], 0], service.name);
});

test('a change of the filter API reaches the guestbook: its contract step first, the guestbook changed too or the card blocks, then the landing order', () => {
  const map = exampleMap();
  const filter = map.impact['filter-api'];
  assert.deepEqual(filter?.services, [{
    service: 'filter-api', contract: true,
    callers: [{ name: 'guestbook', items: ['POST /check'], through: null, declared: true, found: true }],
    listeners: [], sharing: [],
  }]);
  assert.deepEqual(filter?.mustChange, ['guestbook']);
  assert.deepEqual(filter?.order, ['filter-api', 'guestbook']);
  assert.deepEqual(filter?.undeclared, []);
  const guestbook = map.impact.guestbook;
  assert.deepEqual([guestbook?.services[0]?.callers, guestbook?.mustChange, guestbook?.order], [[], [], ['guestbook']]);
});
