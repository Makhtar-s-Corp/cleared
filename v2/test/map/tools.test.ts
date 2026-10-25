// The lead's tool service_impact (section 11.4): given the services a goal
// changes, the impact read from the map, built first when it never was;
// refused with a sentence the model reads for a service the workspace does
// not have, an empty list, or a map not running yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANSWER_CAPS, LEAD_TOOLS } from '../../src/lead/contract.ts';
import { readFolder } from '../../src/map/source.ts';
import { MAP_TABLES, ServiceMaps } from '../../src/map/service.ts';
import { mapExtensions } from '../../src/map/tools.ts';
import { HostToolRefused, type HostCallContext } from '../../src/session/contract.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { parseWorkspace } from '../../src/workspace/config.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
const context = {} as HostCallContext;

function exampleMaps() {
  const store = openStore(':memory:');
  applyTables(store.db, MAP_TABLES);
  const workspace = parseWorkspace(readFileSync(`${EXAMPLES}workspace.conf`, 'utf8'), { file: `${EXAMPLES}workspace.conf`, authorModel: 'claude-opus-5-5', stateDir: '/tmp/unused' });
  return new ServiceMaps({
    db: store.db, project: workspace.id, services: workspace.services,
    fetch: async () => {}, head: async (service) => `${service.name === 'guestbook' ? 'a' : 'b'}`.repeat(40),
    read: async (service) => ({ ...readFolder(`${EXAMPLES}${service.name}`, workspace.services.find((s) => s.name === service.name)!), commit: `${service.name === 'guestbook' ? 'a' : 'b'}`.repeat(40) }),
    now: () => new Date('2026-10-25T18:00:00.000Z'),
  });
}

test('the tool is a line of the lead\'s contract, a list of services in, a text out, cut at 8 KB', () => {
  const tool = LEAD_TOOLS.find((candidate) => candidate.name === 'service_impact');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['services']);
  assert.equal(ANSWER_CAPS.service_impact, 8192);
  // The lead's rules are at their 5 KB budget (test/lead/plans/module.test.ts): when to call it is in its description.
  assert.match(tool.description, /before you propose a plan that changes a service/);
});

test('the impact of a change of the filter API, on the example workspace, the map built on the first call', async () => {
  const handler = mapExtensions(() => exampleMaps()).tools?.service_impact;
  assert.ok(handler);
  const text = await handler({ services: ['filter-api'] }, context);
  assert.equal(text, [
    'The service map was built just now, from the base commits guestbook aaaaaaa, filter-api bbbbbbb.',
    '',
    'Changing filter-api:',
    '- Called by guestbook: POST /check (declared in the workspace file and found in the code).',
    '- It has a contract (openapi, contract/openapi.yaml): a change of it is a contract step first, and guestbook must change in the same ticket, or the release card blocks unless the change is backward compatible.',
    '',
    'Landing order: filter-api, then guestbook.',
  ].join('\n'));
});

test('an unknown service, an empty list and a map not running are refused with a sentence', async () => {
  const maps = exampleMaps();
  const handler = mapExtensions(() => maps).tools?.service_impact;
  assert.ok(handler);
  await assert.rejects(handler({ services: ['billing'] }, context), (error: unknown) => error instanceof HostToolRefused && /billing is not a service of this workspace \(guestbook, filter-api\)/.test(error.message));
  await assert.rejects(handler({ services: [] }, context), (error: unknown) => error instanceof HostToolRefused && /at least one service/.test(error.message));
  await assert.rejects(handler({ services: 'filter-api' } as never, context), (error: unknown) => error instanceof HostToolRefused && /list of service names/.test(error.message));
  const down = mapExtensions(() => undefined).tools?.service_impact;
  await assert.rejects(down!({ services: ['guestbook'] }, context), (error: unknown) => error instanceof HostToolRefused && /not running yet/.test(error.message));
});
