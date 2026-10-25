// The impact of a change of one or more services (docs/v2/milestone-4-plan.md,
// section 11.4), from the map alone: who calls them, directly or through
// others; who listens to their channels; who shares their databases; which
// callers must change in the same ticket when a contract changes (the rule
// the release card applies, release/order.ts compatibility); and the order
// the services land in, computed by the train's own landingOrder over the
// calls declared and found, so the two never disagree. impactText says it
// for the lead's tool service_impact.
import { landingOrder } from '../release/order.ts';
import type { ServiceMap } from './build.ts';

export type ImpactCaller = {
  readonly name: string;
  readonly items: readonly string[];       // the operations it calls, for a direct caller; none through another
  readonly through: string | null;         // null: it calls the service; else the service it calls on the way
  readonly declared: boolean;
  readonly found: boolean;
};

export type ServiceImpact = {
  readonly service: string;
  readonly contract: boolean;
  readonly callers: readonly ImpactCaller[];
  readonly listeners: readonly { readonly name: string; readonly channels: readonly string[] }[];
  readonly sharing: readonly { readonly name: string; readonly database: string; readonly tables: readonly string[] }[];
};

export type Impact = {
  readonly changed: readonly string[];
  readonly services: readonly ServiceImpact[];
  readonly mustChange: readonly string[];  // direct callers of a changed service with a contract, not changed themselves
  readonly undeclared: readonly { readonly from: string; readonly to: string }[];   // calls found that the workspace file does not declare
  readonly order: readonly string[];       // the changed services and their direct callers, in landing order
};

type MapPart = Pick<ServiceMap, 'services' | 'links'>;

export class ImpactError extends Error {
  override name = 'ImpactError';
}

export function impactOf(map: MapPart, changed: readonly string[]): Impact {
  const names = map.services.map((service) => service.name);
  if (changed.length === 0) throw new ImpactError('Name at least one service.');
  for (const name of changed) if (!names.includes(name)) throw new ImpactError(`${name} is not a service of this workspace (${names.join(', ')}).`);
  const wanted = [...new Set(changed)];
  const calls = map.links.filter((link) => link.kind === 'call');
  const callersOf = (name: string) => calls.filter((link) => link.to === name);
  const services: ServiceImpact[] = wanted.map((name) => {
    const callers: ImpactCaller[] = callersOf(name).map((link) => ({ name: link.from, items: link.items, through: null, declared: link.declared, found: link.found }));
    // The callers of the callers, each once, named with the service it calls on the way.
    const seen = new Set([name, ...callers.map((c) => c.name)]);
    const queue = callers.map((c) => c.name);
    while (queue.length > 0) {
      const via = queue.shift() as string;
      for (const link of callersOf(via)) {
        if (seen.has(link.from)) continue;
        seen.add(link.from);
        callers.push({ name: link.from, items: [], through: via, declared: link.declared, found: link.found });
        queue.push(link.from);
      }
    }
    const listeners = map.links.filter((link) => link.kind === 'event' && link.from === name).map((link) => ({ name: link.to, channels: link.items }));
    const sharing = map.links.filter((link) => link.kind === 'database' && link.from !== name && link.to.startsWith(`${name}:`))
      .map((link) => ({ name: link.from, database: link.to, tables: link.items }));
    // A database of another service that this one uses: its owner shares it too.
    for (const link of map.links.filter((l) => l.kind === 'database' && l.from === name && !l.to.startsWith(`${name}:`))) {
      const owner = map.services.find((service) => link.to.startsWith(`${service.name}:`))?.name;
      if (owner) sharing.push({ name: owner, database: link.to, tables: link.items });
    }
    return { service: name, contract: map.services.find((service) => service.name === name)?.contract != null, callers, listeners, sharing };
  });
  const direct = services.flatMap((s) => s.callers.filter((c) => c.through === null).map((c) => c.name));
  const mustChange = [...new Set(services.filter((s) => s.contract).flatMap((s) => s.callers.filter((c) => c.through === null).map((c) => c.name)))].filter((name) => !wanted.includes(name));
  const involved = new Set([...wanted, ...direct]);
  const undeclared = calls.filter((link) => !link.declared && (wanted.includes(link.to) || wanted.includes(link.from))).map(({ from, to }) => ({ from, to }));
  const train = map.services.map((service) => ({
    name: service.name, kind: 'repository' as const, path: null, contract: null,
    consumes: [...new Set(calls.filter((link) => link.from === service.name).map((link) => link.to))],
  }));
  return { changed: wanted, services, mustChange, undeclared, order: orderOf(train, [...involved]) };
}

// The train's order; a found call against a declared one can make a cycle,
// which the workspace file alone never does: then the workspace's order.
function orderOf(train: Parameters<typeof landingOrder>[0], touched: readonly string[]): string[] {
  try { return landingOrder(train, touched); }
  catch { return train.map((service) => service.name).filter((name) => touched.includes(name)); }
}

const and = (names: readonly string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const short = (commit: string | null) => (commit ? commit.slice(0, 7) : 'not fetched');

function age(from: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function state(declared: boolean, found: boolean, caller: string, service: string): string {
  if (declared && found) return 'declared in the workspace file and found in the code';
  if (declared) return 'declared in the workspace file, not found in the code';
  return `found in the code, not declared in the workspace file: the release train does not know this call; add ${service} to ${caller}'s consumes`;
}

// The impact as the lead reads it, in English as the lead's other tools answer.
export function impactText(map: Pick<ServiceMap, 'builtAt' | 'services' | 'links'>, impact: Impact, now: Date): string {
  const commits = map.services.map((service) => `${service.name} ${short(service.commit)}`).join(', ');
  const head = map.builtAt === null
    ? 'The service map has not been built yet: what follows is what the workspace file declares.'
    : `The service map was built ${age(map.builtAt, now)}, from the base commits ${commits}.`;
  const lines = [head];
  for (const s of impact.services) {
    lines.push('', `Changing ${s.service}:`);
    for (const c of s.callers) {
      const what = c.through === null && c.items.length > 0 ? `: ${c.items.join(', ')}` : '';
      lines.push(`- Called by ${c.name}${c.through === null ? '' : ` through ${c.through}`}${what} (${state(c.declared, c.found, c.name, c.through ?? s.service)}).`);
    }
    for (const l of s.listeners) lines.push(`- ${l.name} listens to its events: ${l.channels.join(', ')}.`);
    for (const d of s.sharing) lines.push(d.database.startsWith(`${s.service}:`)
      ? `- Its database ${d.database} is also used by ${d.name}: ${d.tables.join(', ')}.`
      : `- It uses the database ${d.database} of ${d.name}: ${d.tables.join(', ')}.`);
    const contract = map.services.find((service) => service.name === s.service)?.contract;
    if (contract) {
      const callers = s.callers.filter((c) => c.through === null && impact.mustChange.includes(c.name)).map((c) => c.name);
      lines.push(`- It has a contract (${contract.format}, ${contract.path}): a change of it is a contract step first${callers.length > 0
        ? `, and ${and(callers)} must change in the same ticket, or the release card blocks unless the change is backward compatible.` : '.'}`);
    }
    if (s.callers.length === 0 && s.listeners.length === 0 && s.sharing.length === 0) lines.push('- No service calls it, listens to it or shares its databases.');
  }
  lines.push('', `Landing order: ${impact.order.join(', then ')}.`);
  return lines.join('\n');
}
