// The service map screen's rules (milestone 4, section 11): the drawing's
// places, callers to the left of the services they call and databases under
// their owner; the links in words, which the drawing only repeats; the
// impact of the service picked; the map's age and problems in readable
// words, in French and in English.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, type ServiceRead } from '../../../src/map/build.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { serviceMapFixture } from '../../fixtures/services.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../web/lib/screen.ts';
import { builtLine, impactLines, layout, linkRows, mapFailure, problemLines, readMap, refreshMap } from '../../web/screens/services/model.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('services', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('services', 'fr') });
const flat = (text: string) => text.replace(/\s/g, ' ');

const read = (name: string, files: Record<string, string> = {}, more: Partial<ServiceRead> = {}): ServiceRead => ({
  name, commit: 'a'.repeat(40), files: Object.entries(files).map(([path, text]) => ({ path, text })), conf: null, packageJson: null, contract: null, problems: [], ...more,
});
const spec = (name: string, consumes: string[] = [], contract: { readonly format: 'openapi' | 'events'; readonly path: string } | null = null) =>
  ({ name, kind: 'repository' as const, path: null, consumes, contract });
const OPENAPI = 'openapi: 3.1.0\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /isrc:\n    post:\n      responses:\n        "200":\n          description: ok\n';
const EVENTS = JSON.stringify({ asyncapi: '2.6.0', info: { title: 'E', version: '1' }, channels: { 'isrc.added': {} } });

// back-office -> web -> catalogue (declared), royalties listens to catalogue's events and reads its table.
const wide = buildMap({
  workspace: 'w', at: '2026-10-25T18:00:00.000Z',
  services: [spec('catalogue', [], { format: 'openapi', path: 'openapi.yaml' }), spec('web', ['catalogue']), spec('back-office', ['web']), spec('royalties'), spec('feed', [], { format: 'events', path: 'events.json' })],
  reads: [
    read('catalogue', { 'db/1.sql': 'CREATE TABLE isrc (id int);\n' }, { contract: OPENAPI, conf: '[session]\nservices = postgres:16\n' }),
    read('web', { 'src/api.ts': 'await fetch(`${CATALOGUE_URL}/isrc`);\n' }),
    read('back-office', {}, { problems: ['capped'] }),
    read('royalties', { 'src/a.ts': "db.query('SELECT * FROM isrc');\nbus.on('isrc.added', h);\n" }),
    read('feed', {}, { contract: EVENTS }),
  ],
});

test('the drawing puts each caller left of what it calls, the databases under their owner, and every link between two boxes', () => {
  const drawing = layout(wide);
  const box = (id: string) => drawing.boxes.find((b) => b.id === id);
  assert.deepEqual(['back-office', 'web', 'catalogue'].map((id) => box(id)?.column), [0, 1, 2]);
  assert.equal(box('royalties')?.column, 0, 'nobody calls it');
  assert.ok((box('catalogue:postgres')?.y ?? 0) > Math.max(...drawing.boxes.filter((b) => b.kind === 'service').map((b) => b.y)));
  const db = box('catalogue:postgres')!;
  const owner = box('catalogue')!;
  assert.equal(db.x + db.w / 2, owner.x + owner.w / 2, 'centred under its owner');
  assert.deepEqual(drawing.edges.map((e) => `${e.kind} ${e.from}>${e.to}`), wide.links.map((l) => `${l.kind} ${l.from}>${l.to}`));
  for (const edge of drawing.edges) assert.match(edge.path, /^M[\d.]+ [\d.]+ C/);
  assert.ok(drawing.width > 0 && drawing.height > 0);
  for (const b of drawing.boxes) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= drawing.width && b.y + b.h <= drawing.height, b.id);
});

test('the links in words: who calls whom and what, who listens, who uses which database, declared or found', () => {
  assert.deepEqual(linkRows(wide, en).map((row) => flat(row.text)), [
    'web calls catalogue: POST /isrc',
    'back-office calls web',
    'royalties listens to feed: isrc.added',
    'catalogue uses PostgreSQL of catalogue: isrc',
    'royalties uses PostgreSQL of catalogue: isrc',
  ]);
  assert.deepEqual(linkRows(wide, en).map((row) => row.state), [
    'declared and found in the code', 'declared, not found in the code', 'found in the code', 'found in the code', 'found in the code',
  ]);
  assert.deepEqual(linkRows(wide, fr).map((row) => flat(row.text)), [
    'web appelle catalogue : POST /isrc',
    'back-office appelle web',
    'royalties écoute feed : isrc.added',
    'catalogue utilise PostgreSQL de catalogue : isrc',
    'royalties utilise PostgreSQL de catalogue : isrc',
  ]);
  assert.equal(linkRows(wide, en)[0]?.places, 'src/api.ts:1');
});

test('a call found and not declared says the train does not know it', () => {
  const found = buildMap({
    workspace: 'w', at: '2026-10-25T18:00:00.000Z', services: [spec('catalogue', [], { format: 'openapi', path: 'openapi.yaml' }), spec('web')],
    reads: [read('catalogue', {}, { contract: OPENAPI }), read('web', { 'src/api.ts': 'await fetch(`${CATALOGUE_URL}/isrc`);\n' })],
  });
  assert.deepEqual(linkRows(found, en).map((row) => [row.undeclared, row.state]), [[true, 'found in the code, not declared in the workspace']]);
  assert.ok(impactLines(found, 'catalogue', en).some((line) => line.kind === 'undeclared' && flat(line.text) === 'The workspace file does not declare that web calls catalogue: the release train does not know this call.'));
});

test('the impact of the service picked: its callers, through whom, its listeners, its databases, its contract and the order', () => {
  assert.deepEqual(impactLines(wide, 'catalogue', en).map((line) => flat(line.text)), [
    'web calls it: POST /isrc',
    'back-office calls it through web',
    'royalties uses its database: isrc',
    'Its contract (OpenAPI, openapi.yaml) changes first, in a contract step.',
    'web must change in the same ticket, or the release card blocks unless the change stays backward compatible.',
    'Landing order: catalogue, then web',
  ]);
  assert.deepEqual(impactLines(wide, 'catalogue', fr).map((line) => flat(line.text)), [
    "web l'appelle : POST /isrc",
    "back-office l'appelle via web",
    'royalties utilise sa base : isrc',
    "Son contrat (OpenAPI, openapi.yaml) change d'abord, dans une étape de contrat.",
    'web doit changer dans le même ticket, sinon la carte de mise en production bloque, sauf si le changement reste compatible.',
    "Ordre d'atterrissage : catalogue, puis web",
  ]);
  assert.deepEqual(impactLines(wide, 'feed', en).map((line) => flat(line.text)), ['royalties listens to its events: isrc.added', 'Its contract (AsyncAPI, events.json) changes first, in a contract step.', 'Landing order: feed']);
  assert.deepEqual(impactLines(wide, 'back-office', en).map((line) => flat(line.text)), ['No service calls it, listens to it or shares its databases.', 'Landing order: back-office']);
});

test('the map\'s age through the shell\'s durations, and each service\'s problems in words', () => {
  const now = new Date('2026-10-25T18:12:00.000Z');
  assert.equal(flat(builtLine(wide, now, en)), 'Built 12 min ago from the base branches');
  assert.equal(flat(builtLine(wide, now, fr)), 'Construite il y a 12 min à partir des branches de base');
  assert.equal(flat(builtLine({ ...wide, builtAt: null }, now, en)), 'Not built yet');
  assert.deepEqual(problemLines(wide.services.find((s) => s.name === 'back-office')!, en), ['Too large: read in part']);
  assert.deepEqual(problemLines({ ...wide.services[0]!, problems: ['not_fetched', 'fetch_failed', 'contract_unreadable'], dropped: 3 }, fr).map(flat), [
    'Pas encore récupéré', 'Récupération impossible : la carte montre la dernière base lue', 'Son contrat est illisible', 'Noms écartés : 3',
  ]);
});

test('the fixture is the example workspace\'s map, read by the service\'s own code', () => {
  const map = serviceMapFixture(FIXTURE_NOW);
  assert.deepEqual(map.services.map((s) => s.name), ['guestbook', 'filter-api']);
  assert.deepEqual(map.links.map((l) => `${l.kind} ${l.from}>${l.to} ${l.items.join(',')}`), ['call guestbook>filter-api POST /check', 'database guestbook>guestbook:postgres entries']);
});

test('the reads go to the service-map route; a 503 says the map is not available', async () => {
  const calls: { path: string; method?: string }[] = [];
  const api = (async (path: string, init?: { method?: string }) => { calls.push({ path, ...(init?.method ? { method: init.method } : {}) }); return wide; }) as unknown as ScreenContext['api'];
  await readMap(api);
  await refreshMap(api);
  assert.deepEqual(calls, [{ path: '/service-map' }, { path: '/service-map/refresh', method: 'POST' }]);
  assert.equal(mapFailure(new ApiError(503, 'down')), 'map_down');
  assert.equal(mapFailure(new Error('x')), 'map_read_failed');
});
