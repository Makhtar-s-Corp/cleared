// A ticket in steps (docs/v2/milestone-2-plan.md, decision 26, lane 23), on
// the fake adapter: the contract step on the providing service, its diff
// proposed in the inbox, sent back once and validated; the service steps in
// parallel, each with its siblings as the step's kind wants them; the
// integration on the consumer; then the review and one release card. And
// what goes wrong: a contract step that touched another file, a step that
// fails, a validated contract changed after its validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractItem, ReleaseItem, TicketStep } from '../../src/api/types.ts';
import type { SiblingSpec } from '../../src/container/services.ts';
import { FlowEngine, type FlowEffects } from '../../src/flow/engine.ts';
import { describeFlowEvent } from '../../src/lead/prompts.ts';
import type { ServiceLock } from '../../src/release/lock.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { finished, quickAuthor, setup, started, text, until, type Setup } from './support.ts';

const service = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: `/run/${name}/release.sock`, brokerState: `/state/${name}`, ...extra,
});

const WORKSPACE: WorkspaceConfig = {
  id: 'guestbook', name: 'Guestbook and its filter', file: '/etc/cleared/workspace.conf',
  services: [
    service('guestbook', { consumes: ['filter-api'], run: { dockerfile: 'Dockerfile', port: 8793 }, brokerSocket: null, brokerState: null }),
    service('filter-api', { run: { dockerfile: 'Dockerfile', port: 8795 }, contract: { format: 'openapi', path: 'contract/openapi.yaml' } }),
  ],
};
const HEAD: Record<string, string> = { guestbook: 'a'.repeat(40), 'filter-api': 'b'.repeat(40) };

// A turn that waits for a message before it ends: two of them prove two steps live at once.
const waiting = (id: string): readonly FakeStep[] => [started, ...text(id, 'Working on it.'), { awaitMessage: true }, finished(0.5)];
const failing: readonly FakeStep[] = [started, { emit: { type: 'RUN_ERROR', message: 'the container stopped', code: 'exit' } }];

// What the runtime plans for a session on a service (planSiblings): both services real, the filter API with its contract.
const planned = (ticket: string, own: string): SiblingSpec[] => [
  { name: 'guestbook', port: 8793, real: { base: '/state/siblings/guestbook/c1', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-guestbook:c1', checkout: `/work/${ticket}/guestbook` } },
  {
    name: 'filter-api', port: 8795, contract: '/state/siblings/filter-api/c2/contract/openapi.yaml',
    real: { base: '/state/siblings/filter-api/c2', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-filter-api:c2', checkout: `/work/${ticket}/filter-api` },
  },
];

type Read = Awaited<ReturnType<NonNullable<FlowEffects['stepChanges']>>>;
const contractRead = (n: number, extra: string[] = []): Read => ({
  files: ['contract/openapi.yaml', ...extra],
  contract: { path: 'contract/openapi.yaml', diff: `@@ -1 +1 @@\n-ok\n+severity ${n}\n`, blob: `blob-${n}`, snapshot: `/work/LOCAL-2/.validated/contract-${n}/openapi.yaml` },
});

function locks(t: () => Setup): (svc: ServiceConfig) => ServiceLock {
  return (svc) => ({
    service: svc.name,
    async recordReview() {},
    async ask() { return { requestedAt: new Date(t().clock.now).toISOString() }; },
    check() { return undefined; },
    async sign() {},
    async release() { return { outcome: 'queued', message: '' }; },
    async rollback() { return { ok: true, message: '' }; },
  });
}

type Options = { authors?: (readonly FakeStep[])[]; reads?: Record<string, Read[]>; reopen?: readonly FakeStep[] };

async function stepped(options: Options = {}) {
  let t: Setup | undefined;
  const reads = options.reads ?? {};
  const asked: { service: string; snapshot?: string }[] = [];
  const effects: Partial<FlowEffects> = {
    async settings(svc) {
      return {
        verdict: 'no blocking issues', safeCommands: [], hosts: [], services: [], scripts: ['test'],
        ...(svc?.name === 'guestbook' ? { serviceUrls: { 'filter-api': 'FILTER_URL' } } : {}),
      };
    },
    async prepareWorkdir({ ticket, role, service: svc }) {
      return { workdir: svc ? `/work/${ticket.id}/${svc.name}` : `/work/${ticket.id}`, briefing: { projectPage: `${role}`, decisions: [], glossary: [], lessons: [], lastHandover: null } };
    },
    async siblings({ ticket, service: svc }) { return planned(ticket, svc.name); },
    async stepChanges({ service: svc, snapshot }) {
      asked.push({ service: svc.name, ...(snapshot ? { snapshot } : {}) });
      const next = reads[svc.name]?.shift();
      if (next) return next;
      return svc.name === 'filter-api' ? contractRead(9) : { files: ['src/page.ts'], contract: null };
    },
    async publish(input) {
      const name = input.service?.name ?? 'guestbook';
      return { url: `https://example.invalid/${name}/pull/7`, number: 7, head: HEAD[name] as string, created: true };
    },
    async changes(input) {
      const name = input.service?.name ?? 'guestbook';
      const file = name === 'filter-api' ? 'contract/openapi.yaml' : 'src/page.ts';
      return { files: [file], diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n` };
    },
  };
  t = await setup({
    scripts: { authors: options.authors ?? [quickAuthor, waiting('s1'), waiting('s2'), quickAuthor], ...(options.reopen ? { reopen: options.reopen } : {}) },
    config: { workspace: WORKSPACE, steps: true }, effects, locks: locks(() => t as Setup),
  });
  const ticket = await t.tickets.create({ title: 'Held for review', body: 'An entry the filter flags is held for review instead of refused.\n\n- [ ] a flagged entry is held', project: 'guestbook', services: ['guestbook', 'filter-api'] }, { kind: 'human', id: 'u1' });
  const steps = async () => (await t.engine.ticketSteps(ticket.id)) as TicketStep[];
  const states = async () => (await steps()).map((s) => `${s.position} ${s.kind} ${s.service} ${s.state}`);
  const contract = () => t.inbox.contracts({ ticket: ticket.id }).at(-1) as ContractItem | undefined;
  return { t: t as Setup, ticket, steps, states, contract, asked };
}

test('a two-service ticket: the contract step, sent back once and validated, the two service steps in parallel with a fake each, the integration with real siblings, then one release card', async () => {
  const { t, ticket, steps, states, contract, asked } = await stepped({ reads: { 'filter-api': [contractRead(1), contractRead(2), contractRead(2)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.settled();

  // The contract step ran alone, on the providing service, in its own checkout.
  assert.equal(t.startedSessions.length, 1);
  const first = t.startedSessions[0]!;
  assert.equal(first.input.service, 'filter-api');
  assert.equal(first.input.workdir, '/work/LOCAL-2/filter-api');
  assert.match(first.input.prompt, /contract step/i);
  assert.match(first.input.prompt, /contract\/openapi\.yaml/);
  assert.deepEqual((await states()), ['1 contract filter-api validating', '2 service filter-api waiting', '3 service guestbook waiting', '4 integration guestbook waiting']);
  assert.deepEqual((await steps())[0]?.after, []);
  assert.deepEqual((await steps())[3]?.after, [2, 3]);
  const item = contract() as ContractItem;
  assert.equal(item.service, 'filter-api');
  assert.equal(item.path, 'contract/openapi.yaml');
  assert.match(item.diff, /severity 1/);
  assert.equal(item.sessionId, first.id);
  assert.equal(item.step, (await steps())[0]?.id);
  assert.match(asked[0]?.snapshot ?? '', /^\/work\/LOCAL-2\/\.validated\//, 'the contract is kept as validated under the ticket\'s folder');

  // Sent back once: the step's session is reopened with the message, and proposes a new diff.
  await t.engine.sendBackContract(item.id, 'Add an example for a flagged entry.', 'u1');
  assert.equal(t.inbox.item(item.id)?.state, 'handled');
  assert.deepEqual((t.inbox.item(item.id) as ContractItem).outcome?.decision, 'send_back');
  await until(() => contract() !== undefined, 'the second contract item');
  assert.notEqual(contract()?.id, item.id);
  await t.engine.settled();
  assert.ok(t.store.events.after(first.id).some(({ event }) => JSON.stringify(event).includes('Add an example for a flagged entry.')), 'the message reached the step\'s session');
  assert.equal(t.startedSessions.length, 1, 'the same session, resumed');
  assert.match(contract()?.diff ?? '', /severity 2/);
  assert.equal((await states())[0], '1 contract filter-api validating');

  // Validated: the two service steps start at once, each with its siblings.
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => t.startedSessions.length === 3, 'the two service steps');
  await t.engine.settled();
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api running', '3 service guestbook running', '4 integration guestbook waiting']);
  const [filterStep, guestbookStep] = [t.startedSessions[1]!, t.startedSessions[2]!];
  assert.equal(filterStep.input.service, 'filter-api');
  assert.equal(guestbookStep.input.service, 'guestbook');
  assert.equal(guestbookStep.input.workdir, '/work/LOCAL-2/guestbook');
  const validated = '/work/LOCAL-2/.validated/contract-2/openapi.yaml';
  assert.deepEqual(guestbookStep.input.siblings, [
    { ...planned('LOCAL-2', 'guestbook')[0], env: { FILTER_URL: 'http://filter-api:8795' } },
    { name: 'filter-api', port: 8795, contract: validated },
  ], 'the guestbook step: its own service real, the filter API a fake of the validated contract');
  assert.deepEqual(filterStep.input.siblings, [planned('LOCAL-2', 'filter-api')[1]], 'the filter API step: its own service only');

  // Both end; the integration starts on the consumer with every sibling real.
  await t.engine.send(filterStep.id, 'Go on.', 'u1');
  await t.engine.send(guestbookStep.id, 'Go on.', 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  await t.engine.settled();
  const integration = t.startedSessions[3]!;
  assert.equal(integration.input.role, 'author');
  assert.equal(integration.input.service, 'guestbook');
  assert.match(integration.input.prompt, /integration step/i);
  assert.deepEqual(integration.input.siblings, [
    { ...planned('LOCAL-2', 'guestbook')[0], env: { FILTER_URL: 'http://filter-api:8795' } },
    { ...planned('LOCAL-2', 'guestbook')[1], contract: validated },
  ]);
  assert.equal(t.startedSessions[4]?.input.role, 'reviewer');
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api done', '3 service guestbook done', '4 integration guestbook done']);
  assert.ok((await steps()).every((s) => typeof s.costUsd === 'number'));
  assert.equal((await steps())[0]?.costUsd, 0.5, 'the contract step\'s session: its first turn and the turn after the send back');
  const releases = t.inbox.list().filter((i): i is ReleaseItem => i.kind === 'release' && i.ticket === ticket.id);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0]?.train?.services.map((s) => s.service), ['filter-api', 'guestbook']);
  assert.ok(releases[0]?.flags?.some((f) => f.kind === 'contract'), 'the contract file is flagged on the card (issue 205, item 1)');
  await t.engine.close();
});

test('a one-service ticket with steps on has one service step, done when its author is', async () => {
  const t = await setup({ scripts: { author: quickAuthor }, config: { steps: true } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  const steps = (await t.engine.ticketSteps(t.ticket.id)) as TicketStep[];
  assert.deepEqual(steps.map((s) => [s.kind, s.service, s.state, s.session]), [['service', 'guestbook', 'done', t.startedSessions[0]?.id]]);
  await t.engine.close();
});

test('a ticket without steps on answers no step; an unknown ticket is not found', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  assert.deepEqual(await t.engine.ticketSteps(t.ticket.id), []);
  assert.equal(await t.engine.ticketSteps('LOCAL-99'), undefined);
  await t.engine.close();
});

test('a contract step that changed another file than the contract puts the ticket back with a note naming it, and proposes nothing', async () => {
  const { t, ticket, states, contract } = await stepped({ reads: { 'filter-api': [contractRead(1, ['src/check.ts'])] } });
  await t.engine.start(ticket.id, 'u1');
  await until(async () => (await t.tickets.get(ticket.id))?.status === 'Todo', 'the put back');
  await t.engine.settled();
  assert.equal(contract(), undefined);
  assert.equal((await states())[0], '1 contract filter-api failed');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.equal(back?.type === 'ticket_put_back' && back.reason, 'step_failed');
  assert.match(back?.type === 'ticket_put_back' ? back.note : '', /src\/check\.ts/);
  await t.engine.close();
});

test('a contract step that left the contract as it was proposes nothing and the service steps start', async () => {
  const { t, ticket, states, contract } = await stepped({ reads: { 'filter-api': [{ files: [], contract: { path: 'contract/openapi.yaml', diff: '', blob: 'blob-0', snapshot: null } }] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 3, 'the service steps');
  await t.engine.settled();
  assert.equal(contract(), undefined);
  assert.deepEqual((await states()).slice(0, 3), ['1 contract filter-api done', '2 service filter-api running', '3 service guestbook running']);
  await t.engine.close();
});

test('a step that fails stops the ticket\'s other steps, keeps what is done, and tells the lead; started again, the ticket goes on from there', async () => {
  const { t, ticket, states, contract } = await stepped({ authors: [quickAuthor, failing, waiting('s2'), waiting('s3'), waiting('s4'), quickAuthor], reads: { 'filter-api': [contractRead(1)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(async () => (await t.tickets.get(ticket.id))?.status === 'Todo', 'the put back');
  await t.engine.settled();
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api failed', '3 service guestbook waiting', '4 integration guestbook waiting']);
  const guestbookStep = t.startedSessions[2]!;
  assert.equal(t.store.sessions.get(guestbookStep.id)?.status, 'stopped', 'the other running step was stopped');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.ok(back && back.type === 'ticket_put_back' && back.reason === 'step_failed');
  const line = describeFlowEvent(back) ?? '';
  assert.match(line, /step 2/i);
  assert.match(line, /filter-api/);

  // Started again: the contract is not asked again; the two service steps run.
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 5, 'the service steps again');
  await t.engine.settled();
  assert.deepEqual(t.startedSessions.slice(3).map((s) => s.input.service), ['filter-api', 'guestbook']);
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api running', '3 service guestbook running', '4 integration guestbook waiting']);
  await t.engine.close();
});

test('the provider\'s service step that changed the validated contract puts the ticket back', async () => {
  const { t, ticket, states, contract } = await stepped({ authors: [quickAuthor, quickAuthor, waiting('s2')], reads: { 'filter-api': [contractRead(1), contractRead(5)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(async () => (await t.tickets.get(ticket.id))?.status === 'Todo', 'the put back');
  await t.engine.settled();
  assert.equal((await states())[1], '2 service filter-api failed');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.match(back?.type === 'ticket_put_back' ? back.note : '', /validated contract/);
  await t.engine.close();
});

test('a contract approved while its ticket is in Todo starts nothing; a contract item is answered once', async () => {
  const { t, ticket, states, contract } = await stepped({ reads: { 'filter-api': [contractRead(1)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.settled();
  await t.engine.close();
  // The service restarts: the new engine puts the ticket back, and the contract item still waits.
  const again = new FlowEngine(t.deps);
  await again.recover();
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Todo');
  const item = contract() as ContractItem;
  assert.equal(item.state, 'waiting');
  await again.approveContract(item.id, 'u1');
  await again.settled();
  assert.equal(t.startedSessions.length, 1, 'nothing started');
  assert.equal((await states())[0], '1 contract filter-api done');
  await assert.rejects(again.approveContract(item.id, 'u1'), /already/);
  // Started again, the ticket goes on from the service steps.
  await again.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 3, 'the service steps');
  await again.settled();
  await again.close();
});
