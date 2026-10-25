// The impact of a change (section 11.4): who calls the services changed,
// directly and through others; who listens to their channels; who shares
// their databases; which callers must change with a contract; the landing
// order, the train's own function's; and the text the lead reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Service } from '../../src/api/types.ts';
import { buildMap, type ServiceRead } from '../../src/map/build.ts';
import { impactOf, impactText } from '../../src/map/impact.ts';
import { landingOrder } from '../../src/release/order.ts';

type Spec = Pick<Service, 'name' | 'kind' | 'path' | 'consumes' | 'contract'>;
const spec = (name: string, more: Partial<Spec> = {}): Spec => ({ name, kind: 'repository', path: null, consumes: [], contract: null, ...more });
const read = (name: string, files: Record<string, string> = {}, more: Partial<ServiceRead> = {}): ServiceRead => ({
  name, commit: `${name.length}`.repeat(40).slice(0, 40), files: Object.entries(files).map(([path, text]) => ({ path, text })), conf: null, packageJson: null, contract: null, problems: [], ...more,
});
const OPENAPI = 'openapi: 3.1.0\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /isrc:\n    post:\n      responses:\n        "200":\n          description: ok\n';
const AT = '2026-10-25T18:00:00.000Z';

// back-office calls web, web calls catalogue (declared and found), royalties reads catalogue's table.
const SERVICES = [
  spec('catalogue', { contract: { format: 'openapi', path: 'openapi.yaml' } }),
  spec('web', { consumes: ['catalogue'] }),
  spec('back-office', { consumes: ['web'] }),
  spec('royalties'),
];
const map = buildMap({
  workspace: 'w', at: AT, services: SERVICES,
  reads: [
    read('catalogue', { 'db/1.sql': 'CREATE TABLE isrc (id int);\n' }, { contract: OPENAPI, conf: '[session]\nservices = postgres:16\n' }),
    read('web', { 'src/api.ts': 'await fetch(`${CATALOGUE_URL}/isrc`);\n' }),
    read('back-office'),
    read('royalties', { 'src/report.ts': "await db.query('SELECT * FROM isrc');\n" }),
  ],
});

test('a change of the catalogue reaches web directly, back-office through web, and royalties through its table', () => {
  const impact = impactOf(map, ['catalogue']);
  assert.deepEqual(impact.services, [{
    service: 'catalogue', contract: true,
    callers: [
      { name: 'web', items: ['POST /isrc'], through: null, declared: true, found: true },
      { name: 'back-office', items: [], through: 'web', declared: true, found: false },
    ],
    listeners: [],
    sharing: [{ name: 'royalties', database: 'catalogue:postgres', tables: ['isrc'] }],
  }]);
  assert.deepEqual(impact.mustChange, ['web']);
  assert.deepEqual(impact.order, ['catalogue', 'web']);
});

test('the landing order is the train\'s own, over the calls declared and found', () => {
  for (const changed of [['catalogue'], ['web'], ['catalogue', 'back-office'], ['royalties', 'web']]) {
    const impact = impactOf(map, changed);
    const callers = impact.services.flatMap((s) => s.callers.filter((c) => c.through === null).map((c) => c.name));
    assert.deepEqual(impact.order, landingOrder(SERVICES, [...changed, ...callers]), changed.join(','));
  }
});

test('a caller changed with the provider is not one that must change; a caller of a service with no contract never is', () => {
  assert.deepEqual(impactOf(map, ['catalogue', 'web']).mustChange, []);
  assert.deepEqual(impactOf(map, ['web']).mustChange, []);
  assert.deepEqual(impactOf(map, ['web']).services[0]?.callers.map((c) => c.name), ['back-office']);
});

test('a service the map does not have is refused', () => {
  assert.throws(() => impactOf(map, ['billing']), /billing is not a service of this workspace/);
  assert.throws(() => impactOf(map, []), /at least one service/);
});

test('the lead\'s text: the map\'s age and commits, then per service its callers, listeners, databases and contract, then the order', () => {
  const text = impactText(map, impactOf(map, ['catalogue']), new Date('2026-10-25T18:12:00.000Z'));
  assert.equal(text, [
    'The service map was built 12 minutes ago, from the base commits catalogue 9999999, web 3333333, back-office 1111111, royalties 9999999.',
    '',
    'Changing catalogue:',
    '- Called by web: POST /isrc (declared in the workspace file and found in the code).',
    '- Called by back-office through web (declared in the workspace file, not found in the code).',
    '- Its database catalogue:postgres is also used by royalties: isrc.',
    '- It has a contract (openapi, openapi.yaml): a change of it is a contract step first, and web must change in the same ticket, or the release card blocks unless the change is backward compatible.',
    '',
    'Landing order: catalogue, then web.',
  ].join('\n'));
});

test('a call found and not declared is said, since the train does not know it', () => {
  const found = buildMap({
    workspace: 'w', at: AT, services: [spec('catalogue', { contract: { format: 'openapi', path: 'openapi.yaml' } }), spec('web')],
    reads: [read('catalogue', {}, { contract: OPENAPI }), read('web', { 'src/api.ts': 'await fetch(`${CATALOGUE_URL}/isrc`);\n' })],
  });
  const text = impactText(found, impactOf(found, ['catalogue']), new Date(AT));
  assert.match(text, /- Called by web: POST \/isrc \(found in the code, not declared in the workspace file: the release train does not know this call; add catalogue to web's consumes\)\./);
  assert.match(text, /^The service map was built just now/);
});

test('a service with nothing around it says so, and a map never built says that first', () => {
  const text = impactText(map, impactOf(map, ['back-office']), new Date(AT));
  assert.match(text, /Changing back-office:\n- No service calls it, listens to it or shares its databases\./);
  const never = { ...map, builtAt: null };
  assert.match(impactText(never, impactOf(never, ['back-office']), new Date(AT)), /^The service map has not been built yet/);
});
