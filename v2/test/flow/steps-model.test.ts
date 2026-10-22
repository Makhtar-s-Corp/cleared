// The pure parts of a ticket's steps (docs/v2/milestone-2-plan.md,
// decision 26, lane 23): the steps a ticket gets when no plan item gives
// them, the siblings each kind of step runs with, the review prompt's
// paragraph on the files a human changed (decision 33), and the empty
// default lane 31 fills.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { HumanEdit } from '../../src/api/types.ts';
import type { SiblingSpec } from '../../src/container/services.ts';
import { humanEdits } from '../../src/flow/human-edits.ts';
import { reviewPrompt } from '../../src/flow/prompts.ts';
import { deriveSteps, stepSiblings } from '../../src/flow/steps.ts';
import type { ServiceConfig } from '../../src/workspace/config.ts';

const service = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, ...extra,
});

const GUESTBOOK = service('guestbook', { consumes: ['filter-api'], run: { dockerfile: 'Dockerfile', port: 8793 } });
const FILTER = service('filter-api', { run: { dockerfile: 'Dockerfile', port: 8795 }, contract: { format: 'openapi', path: 'contract/openapi.yaml' } });
const NOTES = service('notes');
const SERVICES = [GUESTBOOK, FILTER, NOTES];

test('a ticket across a provider and its consumer: the contract first, a step per service after it, the integration last on the consumer', () => {
  assert.deepEqual(deriveSteps(SERVICES, ['guestbook', 'filter-api']), [
    { kind: 'contract', service: 'filter-api', after: [] },
    { kind: 'service', service: 'filter-api', after: [1] },
    { kind: 'service', service: 'guestbook', after: [1] },
    { kind: 'integration', service: 'guestbook', after: [2, 3] },
  ]);
});

test('a one-service ticket has one service step; two services that do not consume each other run side by side, with no contract and no integration', () => {
  assert.deepEqual(deriveSteps(SERVICES, ['guestbook']), [{ kind: 'service', service: 'guestbook', after: [] }]);
  assert.deepEqual(deriveSteps(SERVICES, ['filter-api', 'notes']), [
    { kind: 'service', service: 'filter-api', after: [] },
    { kind: 'service', service: 'notes', after: [] },
  ]);
});

test('a consumer of a provider with no contract gets its integration step, and no contract step', () => {
  const plain = service('filter-api', { run: { dockerfile: 'Dockerfile', port: 8795 } });
  assert.deepEqual(deriveSteps([GUESTBOOK, plain], ['guestbook', 'filter-api']), [
    { kind: 'service', service: 'filter-api', after: [] },
    { kind: 'service', service: 'guestbook', after: [] },
    { kind: 'integration', service: 'guestbook', after: [1, 2] },
  ]);
});

// What the runtime plans for a session on each service (container/services.ts planSiblings).
const planned = (own: string): SiblingSpec[] => [
  { name: 'guestbook', port: 8793, real: { base: '/state/siblings/guestbook/c1', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-guestbook:c1', checkout: '/work/LOCAL-2/guestbook' } },
  {
    name: 'filter-api', port: 8795, contract: '/state/siblings/filter-api/c2/contract/openapi.yaml',
    real: { base: '/state/siblings/filter-api/c2', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-filter-api:c2', ...(own === 'filter-api' ? { checkout: '/work/LOCAL-2/filter-api' } : {}) },
  },
];
const VALIDATED = new Map([['filter-api', '/work/LOCAL-2/.validated/step-1/openapi.yaml']]);

test('a service step: its own service as planned, every other service with a contract as a fake built from the validated contract, the others left out', () => {
  assert.deepEqual(stepSiblings(planned('guestbook'), { kind: 'service', own: 'guestbook', validated: VALIDATED }), [
    planned('guestbook')[0],
    { name: 'filter-api', port: 8795, contract: '/work/LOCAL-2/.validated/step-1/openapi.yaml' },
  ]);
  assert.deepEqual(stepSiblings(planned('filter-api'), { kind: 'service', own: 'filter-api', validated: VALIDATED }), [planned('filter-api')[1]],
    'the guestbook has no contract to fake, and its own step changes its checkout meanwhile');
});

test('the integration step: every sibling real from the ticket branch, a contract read from the validated one', () => {
  const [guestbook, filter] = planned('guestbook') as [SiblingSpec, SiblingSpec];
  assert.deepEqual(stepSiblings(planned('guestbook'), { kind: 'integration', own: 'guestbook', validated: VALIDATED }), [
    guestbook,
    { ...filter, contract: '/work/LOCAL-2/.validated/step-1/openapi.yaml' },
  ]);
});

test('the consumer\'s own sibling is given the address of each service it names in [session] service_urls', () => {
  const siblings = stepSiblings(planned('guestbook'), { kind: 'service', own: 'guestbook', validated: VALIDATED, urls: { 'filter-api': 'FILTER_URL' } });
  assert.deepEqual(siblings[0]?.env, { FILTER_URL: 'http://filter-api:8795' });
  assert.equal(siblings[1]?.env, undefined);
});

test('the contract step keeps what the runtime planned', () => {
  assert.deepEqual(stepSiblings(planned('filter-api'), { kind: 'contract', own: 'filter-api', validated: new Map() }), planned('filter-api'));
});

const TICKET = { id: 'LOCAL-2', title: 'Held for review', body: 'An entry the filter flags is held for review.' };
const edit = (path: string, by: string, via: HumanEdit['via']): HumanEdit => ({ path, by, at: '2026-10-22T10:00:00.000Z', added: 3, removed: 1, before: 'a', after: 'b', via });

test('the review prompt names each file a human changed, and who, with the change; with no edit it is the prompt as before', () => {
  const before = reviewPrompt({ ticket: TICKET, base: 'main', verdict: 'no blocking issues' });
  assert.equal(reviewPrompt({ ticket: TICKET, base: 'main', verdict: 'no blocking issues', humanEdits: [] }), before);
  const text = reviewPrompt({ ticket: TICKET, base: 'main', verdict: 'no blocking issues', humanEdits: [edit('src/page.ts', 'u1', 'editor'), edit('test/page.test.ts', 'u2', 'terminal')] });
  assert.match(text, /`src\/page\.ts`, by u1 in the editor \(\+3 -1\)/);
  assert.match(text, /`test\/page\.test\.ts`, by u2 in the terminal \(\+3 -1\)/);
  assert.match(text, /a person changed/i);
  assert.ok(text.startsWith(before.split('\n')[0] as string));
});

test('humanEdits answers the journal\'s human edits, filled by lane 31 (test/flow/human-edits.test.ts has the merge per path)', () => {
  const value = { path: 'src/page.ts', by: 'u1', added: 1, removed: 0, before: 'a', after: 'b', via: 'editor' };
  assert.deepEqual(humanEdits({ events: [{ seq: 1, at: '2026-10-22T10:00:00.000Z', sessionId: 's1', ticket: 'LOCAL-2', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.human_edit', value } as never }] }),
    [{ ...value, at: '2026-10-22T10:00:00.000Z' }]);
  assert.deepEqual(humanEdits({ events: [] }), []);
});
