// The harness of the tests of a ticket in steps: a two-service workspace
// (the guestbook consuming the filter API, which provides the contract), the
// reads of what each step changed, and a ticket started on it.
import type { ContractItem, TicketStep } from '../../src/api/types.ts';
import type { LeverReader } from '../../src/consumption/levers.ts';
import type { SiblingSpec } from '../../src/container/services.ts';
import type { FlowEffects } from '../../src/flow/engine.ts';
import type { ServiceLock } from '../../src/release/lock.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { finished, quickAuthor, setup, started, text, type Setup } from './support.ts';

export const service = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: `/run/${name}/release.sock`, brokerState: `/state/${name}`, ...extra,
});

export const WORKSPACE: WorkspaceConfig = {
  id: 'guestbook', name: 'Guestbook and its filter', file: '/etc/cleared/workspace.conf',
  services: [
    service('guestbook', { consumes: ['filter-api'], run: { dockerfile: 'Dockerfile', port: 8793 }, brokerSocket: null, brokerState: null }),
    service('filter-api', { run: { dockerfile: 'Dockerfile', port: 8795 }, contract: { format: 'openapi', path: 'contract/openapi.yaml' } }),
  ],
};
export const HEAD: Record<string, string> = { guestbook: 'a'.repeat(40), 'filter-api': 'b'.repeat(40) };

// A turn that waits for a message before it ends: two of them prove two steps live at once.
export const waiting = (id: string): readonly FakeStep[] => [started, ...text(id, 'Working on it.'), { awaitMessage: true }, finished(0.5)];
export const failing: readonly FakeStep[] = [started, { emit: { type: 'RUN_ERROR', message: 'the container stopped', code: 'exit' } }];

// What the runtime plans for a session on a service (planSiblings): both services real, the filter API with its contract.
export const planned = (ticket: string, own: string): SiblingSpec[] => [
  { name: 'guestbook', port: 8793, real: { base: '/state/siblings/guestbook/c1', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-guestbook:c1', checkout: `/work/${ticket}/guestbook` } },
  {
    name: 'filter-api', port: 8795, contract: '/state/siblings/filter-api/c2/contract/openapi.yaml',
    real: { base: '/state/siblings/filter-api/c2', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-filter-api:c2', checkout: `/work/${ticket}/filter-api` },
  },
];

export type Read = Awaited<ReturnType<NonNullable<FlowEffects['stepChanges']>>>;
export const contractRead = (n: number, extra: string[] = []): Read => ({
  files: ['contract/openapi.yaml', ...extra],
  contract: { path: 'contract/openapi.yaml', diff: `@@ -1 +1 @@\n-ok\n+severity ${n}\n`, blob: `blob-${n}`, snapshot: `/work/LOCAL-2/.validated/contract-${n}/openapi.yaml` },
});

export function locks(t: () => Setup): (svc: ServiceConfig) => ServiceLock {
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

export type Options = { authors?: (readonly FakeStep[])[]; reads?: Record<string, Read[]>; reopen?: readonly FakeStep[]; levers?: LeverReader; effects?: Partial<FlowEffects>; clean?: (text: string) => string };

export async function stepped(options: Options = {}) {
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
    // Each service's ticket branch, as the reviewer is given it.
    async branchChanges({ service: svc }) {
      const diff = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-ok\n+${line}\n`;
      return svc.name === 'filter-api'
        ? { files: ['contract/openapi.yaml', 'src/check.ts'], diff: diff('contract/openapi.yaml', 'severity 2') + diff('src/check.ts', 'answers a severity') }
        : { files: ['src/page.ts'], diff: diff('src/page.ts', 'held for review') };
    },
  };
  t = await setup({
    scripts: { authors: options.authors ?? [quickAuthor, waiting('s1'), waiting('s2'), quickAuthor], ...(options.reopen ? { reopen: options.reopen } : {}) },
    config: { workspace: WORKSPACE, steps: true }, effects: { ...effects, ...options.effects }, ...(options.clean ? { clean: options.clean } : {}), locks: locks(() => t as Setup), ...(options.levers ? { levers: options.levers } : {}),
  });
  const ticket = await t.tickets.create({ title: 'Held for review', body: 'An entry the filter flags is held for review instead of refused.\n\n- [ ] a flagged entry is held', project: 'guestbook', services: ['guestbook', 'filter-api'] }, { kind: 'human', id: 'u1' });
  const steps = async () => (await t.engine.ticketSteps(ticket.id)) as TicketStep[];
  const states = async () => (await steps()).map((s) => `${s.position} ${s.kind} ${s.service} ${s.state}`);
  const contract = () => t.inbox.contracts({ ticket: ticket.id }).at(-1) as ContractItem | undefined;
  return { t: t as Setup, ticket, steps, states, contract, asked };
}
