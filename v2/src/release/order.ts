// The order a train lands in, and the compatibility check before approval
// (docs/v2/milestone-2-plan.md, decision 21).
//
// The order: providers before consumers, from the services' `consumes`
// lines (followed through services the ticket does not change), then the
// position the workspace file gives them. The workspace's configuration
// refuses a cycle, so there always is an order.
//
// The check: a ticket that changes a service's contract file without
// changing every service that consumes it is blocked on the card, with the
// proposal to extend the contract or keep it backward compatible; the owner
// can still ask the lead to add the missing step.
import { posix } from 'node:path';
import type { Service } from '../api/types.ts';

export type TrainService = Pick<Service, 'name' | 'consumes' | 'contract' | 'kind' | 'path'>;

export function landingOrder(services: readonly TrainService[], touched: readonly string[]): string[] {
  const byName = new Map(services.map((service, position) => [service.name, { service, position }]));
  for (const name of touched) if (!byName.has(name)) throw new Error(`${name} is not a service of this workspace`);
  // Every service a service consumes, directly or through others.
  const providers = new Map<string, Set<string>>();
  const reach = (name: string): Set<string> => {
    const known = providers.get(name);
    if (known) return known;
    const out = new Set<string>();
    providers.set(name, out);
    for (const other of byName.get(name)?.service.consumes ?? []) {
      out.add(other);
      for (const further of reach(other)) out.add(further);
    }
    return out;
  };
  const left = [...new Set(touched)].sort((a, b) => (byName.get(a)?.position ?? 0) - (byName.get(b)?.position ?? 0));
  const order: string[] = [];
  while (left.length > 0) {
    const next = left.findIndex((name) => ![...reach(name)].some((provider) => left.includes(provider)));
    order.push(...left.splice(next < 0 ? 0 : next, 1));
  }
  return order;
}

export type Compatibility = {
  readonly line: string | null;                                          // who consumes whom among the ticket's services, and whether it is changed
  readonly blocked: { readonly reason: string; readonly proposal: string } | null;
  readonly contracts: readonly string[];                                 // the services whose contract file the ticket changes
};

const and = (names: readonly string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// The contract file of a service, as a path of its repository: inside its
// folder for a folder of a monorepo.
function contractFile(service: TrainService): string | undefined {
  if (!service.contract) return undefined;
  return service.kind === 'folder' && service.path ? posix.join(service.path, service.contract.path) : service.contract.path;
}

// `changed`: the files each changed service's pull request changes, as
// paths of its repository. A service not in it is not changed by the ticket.
export function compatibility(services: readonly TrainService[], changed: Readonly<Record<string, readonly string[]>>): Compatibility {
  const touched = new Set(Object.keys(changed));
  const lines: string[] = [];
  const blocks: string[] = [];
  const untouchedConsumers: string[] = [];
  const contracts: string[] = [];
  for (const provider of services) {
    if (!touched.has(provider.name)) continue;
    const consumers = services.filter((service) => service.consumes.includes(provider.name));
    for (const consumer of consumers)
      lines.push(`${consumer.name} consumes ${provider.name} and is ${touched.has(consumer.name) ? '' : 'not '}changed in this ticket.`);
    const file = contractFile(provider);
    if (!file || !(changed[provider.name] ?? []).includes(file)) continue;
    contracts.push(provider.name);
    const missing = consumers.filter((consumer) => !touched.has(consumer.name)).map((consumer) => consumer.name);
    if (missing.length === 0) continue;
    untouchedConsumers.push(...missing.filter((name) => !untouchedConsumers.includes(name)));
    blocks.push(`${provider.name} changes its contract (${file}), and ${and(missing)}, which ${missing.length === 1 ? 'consumes' : 'consume'} it, ${missing.length === 1 ? 'is' : 'are'} not changed in this ticket.`);
  }
  const blocked = blocks.length === 0 ? null : {
    reason: blocks.join(' '),
    proposal: `Extend the contract so that ${and(untouchedConsumers)} ${untouchedConsumers.length === 1 ? 'keeps' : 'keep'} working as ${untouchedConsumers.length === 1 ? 'it is' : 'they are'} (add to it, without changing or removing what ${untouchedConsumers.length === 1 ? 'it calls' : 'they call'}), or keep the change backward compatible; or ask the lead to add a step on ${and(untouchedConsumers)}.`,
  };
  return { line: lines.length > 0 ? lines.join(' ') : null, blocked, contracts };
}
