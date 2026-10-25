// The map of a workspace from each service's read and the workspace file
// (section 11.4): a call declared, found, or both; an event from a provider's
// channels to who listens; a database and who else reads its tables; what
// could not be read said per service.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Service } from '../../src/api/types.ts';
import { buildMap, emptyMap, type ServiceRead } from '../../src/map/build.ts';

type Spec = Pick<Service, 'name' | 'kind' | 'path' | 'consumes' | 'contract'>;
const spec = (name: string, more: Partial<Spec> = {}): Spec => ({ name, kind: 'repository', path: null, consumes: [], contract: null, ...more });
const read = (name: string, files: Record<string, string>, more: Partial<ServiceRead> = {}): ServiceRead => ({
  name, commit: 'a'.repeat(40), files: Object.entries(files).map(([path, text]) => ({ path, text })), conf: null, packageJson: null, contract: null, problems: [], ...more,
});
const AT = '2026-10-25T18:00:00.000Z';
const OPENAPI = (paths: readonly string[]) => `openapi: 3.1.0\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n${paths.map((p) => `  ${p}:\n    post:\n      responses:\n        "200":\n          description: ok\n`).join('')}`;

test('a call the code makes and the workspace does not declare is found only; one declared and not found is declared only', () => {
  const map = buildMap({
    workspace: 'w', at: AT,
    services: [spec('web', { consumes: ['royalties'] }), spec('catalogue', { contract: { format: 'openapi', path: 'openapi.yaml' } }), spec('royalties')],
    reads: [
      read('web', { 'src/api.ts': 'await fetch(`${CATALOGUE_URL}/isrc`);\n' }),
      read('catalogue', {}, { contract: OPENAPI(['/isrc']) }),
      read('royalties', {}),
    ],
  });
  assert.deepEqual(map.links.filter((link) => link.kind === 'call').map(({ from, to, items, declared, found }) => ({ from, to, items, declared, found })), [
    { from: 'web', to: 'catalogue', items: ['POST /isrc'], declared: false, found: true },
    { from: 'web', to: 'royalties', items: [], declared: true, found: false },
  ]);
  assert.deepEqual(map.impact.catalogue?.undeclared, [{ from: 'web', to: 'catalogue' }]);
});

test('an events contract\'s channels go from its service to each service that names one', () => {
  const events = JSON.stringify({ asyncapi: '2.6.0', info: { title: 'E', version: '1' }, channels: { 'isrc.added': { subscribe: { message: { payload: { type: 'object' } } } }, 'isrc.gone': {} } });
  const map = buildMap({
    workspace: 'w', at: AT,
    services: [spec('catalogue', { contract: { format: 'events', path: 'events.json' } }), spec('royalties'), spec('web')],
    reads: [read('catalogue', {}, { contract: events }), read('royalties', { 'src/listen.ts': "bus.on('isrc.added', h);\nbus.on('isrc.gone', h);\n" }), read('web', {})],
  });
  assert.deepEqual(map.services[0]?.contract, { format: 'events', path: 'events.json', operations: [], channels: ['isrc.added', 'isrc.gone'] });
  assert.deepEqual(map.links, [{
    kind: 'event', from: 'catalogue', to: 'royalties', items: ['isrc.added', 'isrc.gone'], declared: false, found: true,
    places: [{ file: 'src/listen.ts', line: 1 }, { file: 'src/listen.ts', line: 2 }],
  }]);
  assert.deepEqual(map.impact.catalogue?.services[0]?.listeners, [{ name: 'royalties', channels: ['isrc.added', 'isrc.gone'] }]);
});

test('a table another service reads or writes makes the database shared; a table both create is each one\'s own', () => {
  const map = buildMap({
    workspace: 'w', at: AT,
    services: [spec('catalogue'), spec('royalties'), spec('web')],
    reads: [
      read('catalogue', { 'db/1.sql': 'CREATE TABLE isrc (id int);\nCREATE TABLE users (id int);\n' }, { conf: '[session]\nservices = postgres:16\n' }),
      read('royalties', { 'src/report.ts': "await db.query('SELECT * FROM isrc JOIN payouts ON true');\n", 'db/1.sql': 'CREATE TABLE payouts (id int);\n' }, { packageJson: '{"dependencies":{"pg":"8"}}' }),
      read('web', { 'db/1.sql': 'CREATE TABLE users (id int);\n' }),
    ],
  });
  assert.deepEqual(map.databases, [
    { id: 'catalogue:postgres', engine: 'postgres', owner: 'catalogue', tables: ['isrc', 'users'] },
    { id: 'royalties:postgres', engine: 'postgres', owner: 'royalties', tables: ['payouts'] },
    { id: 'web:sql', engine: 'sql', owner: 'web', tables: ['users'] },
  ]);
  const shared = map.links.filter((link) => link.kind === 'database' && link.from !== link.to.split(':')[0]);
  assert.deepEqual(shared.map(({ from, to, items }) => ({ from, to, items })), [{ from: 'royalties', to: 'catalogue:postgres', items: ['isrc'] }]);
  assert.deepEqual(map.impact.catalogue?.services[0]?.sharing, [{ name: 'royalties', database: 'catalogue:postgres', tables: ['isrc'] }]);
  assert.deepEqual(map.impact.web?.services[0]?.sharing, []);
});

test('an engine with no table is a database too; a service with two engines keeps its tables in the SQL one', () => {
  const map = buildMap({
    workspace: 'w', at: AT, services: [spec('cache')],
    reads: [read('cache', { 'db/1.sql': 'CREATE TABLE hits (id int);\n' }, { conf: '[session]\nservices = redis:7, postgres:16\n' })],
  });
  assert.deepEqual(map.databases, [
    { id: 'cache:postgres', engine: 'postgres', owner: 'cache', tables: ['hits'] },
    { id: 'cache:redis', engine: 'redis', owner: 'cache', tables: [] },
  ]);
});

test('a contract that cannot be read, a service not fetched, a read past its cap: each said on its service', () => {
  const map = buildMap({
    workspace: 'w', at: AT,
    services: [spec('catalogue', { contract: { format: 'openapi', path: 'openapi.yaml' } }), spec('web', { consumes: ['catalogue'] }), spec('royalties')],
    reads: [read('catalogue', {}, { contract: 'not: [yaml' }), read('web', {}, { commit: null, problems: ['not_fetched'] }), read('royalties', {}, { problems: ['capped'] })],
  });
  assert.deepEqual(map.services.map((service) => [service.name, service.commit, service.problems]), [
    ['catalogue', 'a'.repeat(40), ['contract_unreadable']], ['web', null, ['not_fetched']], ['royalties', 'a'.repeat(40), ['capped']],
  ]);
  assert.deepEqual(map.services[0]?.contract, { format: 'openapi', path: 'openapi.yaml', operations: [], channels: [] });
  assert.deepEqual(map.links.map(({ from, to, declared, found }) => ({ from, to, declared, found })), [{ from: 'web', to: 'catalogue', declared: true, found: false }]);
});

test('the empty map names the services and nothing else, built never', () => {
  const map = emptyMap('w', [spec('web'), spec('catalogue')]);
  assert.deepEqual([map.builtAt, map.readAt, map.links, map.databases], [null, null, [], []]);
  assert.deepEqual(map.services.map((service) => [service.name, service.commit, service.problems]), [['web', null, ['not_fetched']], ['catalogue', null, ['not_fetched']]]);
});
