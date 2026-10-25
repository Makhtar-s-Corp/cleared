// What one service's code says (docs/v2/milestone-4-plan.md, section 11.3):
// the calls to a provider's contract, the channels it listens to, its
// databases and their tables, read line by line from its files, its
// agents.conf and its package.json; and the traps the example repositories
// hold: a test's fake, a route the service serves, a setting's value, a
// name a session could have written to reach the lead's prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractFacts, isCodeFile, scanService, type Provided } from '../../src/map/scan.ts';

const FILTER: Provided = { service: 'filter-api', operations: [{ method: 'POST', path: '/check' }, { method: 'GET', path: '/health' }], channels: [] };
const scan = (files: Record<string, string>, more: Partial<Parameters<typeof scanService>[0]> = {}) => scanService({
  name: 'guestbook', files: Object.entries(files).map(([path, text]) => ({ path, text })), conf: null, packageJson: null, providers: [FILTER], ...more,
});

test('the files read are code, never the tests, the dependencies or the builds', () => {
  for (const path of ['src/filter.ts', 'src/page.tsx', 'lib/a.mjs', 'app/main.py', 'cmd/server.go', 'db/schema.sql', 'index.js'])
    assert.equal(isCodeFile(path), true, path);
  for (const path of [
    'test/helpers/fake-filter.ts', 'tests/a.py', 'src/__tests__/a.ts', 'spec/a.rb', 'src/filter.test.ts', 'src/filter.spec.ts', 'fixtures/a.ts',
    'node_modules/pg/index.js', 'vendor/x.go', 'dist/main.js', 'build/x.js', 'README.md', 'package-lock.json', 'contract/openapi.yaml', 'image.png',
  ]) assert.equal(isCodeFile(path), false, path);
});

test('a call is a path of the provider\'s contract after an interpolation, a base address, a concatenation, or on a line that calls fetch', () => {
  const facts = scan({
    'src/filter.ts': 'const response = await fetch(`${baseUrl}/check`, { method: \'POST\' });\n',
    'src/b.ts': '\n\nconst url = "http://filter-api:8795/check";\n',
    'src/c.ts': 'const url = base + \'/check\';\n',
    'src/d.py': 'requests.post(base_url, "/check")\n',
  });
  assert.deepEqual(facts.calls['filter-api'], [
    { item: 'POST /check', file: 'src/b.ts', line: 3 },
    { item: 'POST /check', file: 'src/c.ts', line: 1 },
    { item: 'POST /check', file: 'src/d.py', line: 1 },
    { item: 'POST /check', file: 'src/filter.ts', line: 1 },
  ]);
});

test('a route the service serves, a comparison, a comment and a longer path are not calls', () => {
  const facts = scan({
    'src/server.ts': [
      "// GET  /health   200 while the database answers",
      "const ROUTES = { '/': 'GET, HEAD', '/health': 'GET, HEAD', '/entries': 'POST' };",
      "if (path === '/health') return health();",
      " * POST /check from the docs",
      "const other = `${base}/checkout`;",
      "# fetch(`${base}/check`)",
    ].join('\n'),
  });
  assert.deepEqual(facts.calls, {});
});

test('a path with parameters matches any value of them, and every operation of a matched path is named', () => {
  const items: Provided = { service: 'items', operations: [{ method: 'GET', path: '/items/{id}' }, { method: 'DELETE', path: '/items/{id}' }, { method: 'GET', path: '/' }], channels: [] };
  const facts = scan({ 'src/a.ts': 'await fetch(`${ITEMS_URL}/items/${id}`);\nawait fetch(`${ITEMS_URL}/`);\n' }, { providers: [items] });
  assert.deepEqual(facts.calls.items, [{ item: 'GET /items/{id}', file: 'src/a.ts', line: 1 }, { item: 'DELETE /items/{id}', file: 'src/a.ts', line: 1 }]);
});

test('a channel of a provider\'s events contract named in quotes is a subscription; in a comment it is not', () => {
  const events: Provided = { service: 'catalogue', operations: [], channels: ['isrc.added', 'isrc.removed'] };
  const facts = scan({ 'src/listen.ts': "bus.on('isrc.added', handle);\n// isrc.removed is not used\nconst name = 'isrc.addedLater';\n" }, { providers: [events] });
  assert.deepEqual(facts.listens, { catalogue: [{ item: 'isrc.added', file: 'src/listen.ts', line: 1 }] });
});

test('the databases: the engine from agents.conf\'s services, the package.json and node:sqlite; the tables created and used; never a setting\'s value', () => {
  const conf = [
    '[session]',
    'services = postgres:16 POSTGRES_HOST_AUTH_METHOD=trust, redis:7',
    'env = DATABASE_URL=postgres://owner:hunter2@db.example.invalid:5432/prod',
  ].join('\n');
  const facts = scan({
    'src/store.ts': 'const SCHEMA = `\nCREATE TABLE IF NOT EXISTS entries (\n  id SERIAL PRIMARY KEY\n);`;\nawait pool.query(\'SELECT id FROM entries ORDER BY id\');\nawait pool.query("INSERT INTO audit (at) VALUES ($1)");\n',
    'db/001.sql': '-- CREATE TABLE commented (id int);\ncreate table "public"."visits" (id int);\n',
    'src/local.ts': "import { DatabaseSync } from 'node:sqlite';\n",
  }, { conf, packageJson: JSON.stringify({ dependencies: { pg: '8.0.0', ioredis: '5.0.0' }, devDependencies: { mongodb: '6.0.0' } }) });
  assert.deepEqual(facts.engines, ['postgres', 'redis', 'sqlite']);
  assert.deepEqual(facts.creates.map((found) => [found.item, found.file, found.line]), [['visits', 'db/001.sql', 2], ['entries', 'src/store.ts', 2]]);
  assert.deepEqual(facts.uses.map((found) => found.item).sort(), ['audit', 'entries']);
  assert.ok(!JSON.stringify(facts).includes('postgres://') && !JSON.stringify(facts).includes('hunter2') && !JSON.stringify(facts).includes('DATABASE_URL'));
});

test('what a repository holds is kept only as an identifier: an odd file name or table is dropped and counted', () => {
  const facts = scan({
    'src/odd name‮.ts': 'await fetch(`${base}/check`);\n',
    'src/a.ts': `CREATE TABLE ${'x'.repeat(80)} (id int);\nCREATE TABLE ok_table (id int);\n`,
  });
  assert.deepEqual(facts.calls, {});
  assert.deepEqual(facts.creates.map((found) => found.item), ['ok_table']);
  assert.equal(facts.dropped, 2);
});

test('a provider is never scanned against itself, and at most five places are kept per item', () => {
  const lines = Array.from({ length: 8 }, () => 'await fetch(`${base}/check`);').join('\n');
  const own = scanService({ name: 'filter-api', files: [{ path: 'src/a.ts', text: lines }], conf: null, packageJson: null, providers: [FILTER] });
  assert.deepEqual(own.calls, {});
  const other = scan({ 'src/a.ts': lines });
  assert.equal(other.calls['filter-api']?.length, 5);
});

test('a contract is read by the fakes\' reader: its operations, or its channels for an events contract', () => {
  const openapi = 'openapi: 3.1.0\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /check:\n    post:\n      operationId: check\n      responses:\n        "200":\n          description: ok\n';
  assert.deepEqual(contractFacts('openapi', 'contract/openapi.yaml', openapi), { operations: [{ method: 'POST', path: '/check' }], channels: [] });
  const events = JSON.stringify({ asyncapi: '2.6.0', info: { title: 'E', version: '1' }, channels: { 'isrc.added': { subscribe: { message: { payload: { type: 'object' } } } } } });
  assert.deepEqual(contractFacts('events', 'contract/events.json', events), { operations: [], channels: ['isrc.added'] });
  assert.throws(() => contractFacts('openapi', 'contract/openapi.yaml', 'not: [a contract'));
});
