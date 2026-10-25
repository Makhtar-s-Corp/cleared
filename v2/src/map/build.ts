// The map of a workspace (docs/v2/milestone-4-plan.md, section 12): each
// service's read, scanned against the others' contracts, joined with what
// the workspace file declares. A call is declared (the consumer's
// `consumes`), found (scan.ts), or both; an event goes from the service
// whose events contract has the channel to each service that names it; a
// database is a service's engine with the tables it creates, and a table
// another service reads or writes, without creating it, shares that
// database. With each map comes the impact of a change of each service
// (impact.ts), which the screen shows for the service picked.
import type { ContractFormat, Service } from '../api/types.ts';
import { impactOf, type Impact } from './impact.ts';
import { contractFacts, scanService, type Found, type MapFile, type Provided, type Scan } from './scan.ts';

export type { MapFile } from './scan.ts';

export type ServiceMapProblem = 'not_fetched' | 'fetch_failed' | 'contract_unreadable' | 'capped';

export type ServiceMapPlace = { readonly file: string; readonly line: number };

export type ServiceMapService = {
  readonly name: string;
  readonly commit: string | null;                 // the base commit read; null when the service is not fetched
  readonly contract: { readonly format: ContractFormat; readonly path: string; readonly operations: readonly string[]; readonly channels: readonly string[] } | null;
  readonly files: number;                         // the files read
  readonly problems: readonly ServiceMapProblem[];
  readonly dropped: number;                       // names left out: not identifiers
};

export type ServiceMapDatabase = {
  readonly id: string;                            // <owner>:<engine>
  readonly engine: string;                        // postgres, mysql, mariadb, sqlite, mongodb, redis, or sql when only its tables say it
  readonly owner: string;                         // the service whose code creates it, or whose settings name it
  readonly tables: readonly string[];
};

export type ServiceMapLink = {
  readonly kind: 'call' | 'event' | 'database';
  readonly from: string;                          // call: the caller; event: the service that publishes; database: the service that uses it
  readonly to: string;                            // call: the service called; event: the one that listens; database: the database's id
  readonly items: readonly string[];              // the operations, the channels or the tables
  readonly declared: boolean;                     // call: the workspace file's consumes says it; false for the others
  readonly found: boolean;                        // found in the code
  readonly places: readonly ServiceMapPlace[];    // at most five per item, in file order
};

export type ServiceMap = {
  readonly workspace: string;
  readonly builtAt: string | null;                // when the map was built from these commits; null: never
  readonly readAt: string | null;                 // when the service last looked for a moved base
  readonly services: readonly ServiceMapService[];
  readonly databases: readonly ServiceMapDatabase[];
  readonly links: readonly ServiceMapLink[];
  readonly impact: Readonly<Record<string, Impact>>;   // per service, the impact of a change of it alone
};

// What the map reads of a service: its base commit, its code files, its
// agents.conf, its package.json and its contract (source.ts).
export type ServiceRead = {
  readonly name: string;
  readonly commit: string | null;
  readonly files: readonly MapFile[];
  readonly conf: string | null;
  readonly packageJson: string | null;
  readonly contract: string | null;
  readonly problems: readonly ServiceMapProblem[];
};

export type MapServiceSpec = Pick<Service, 'name' | 'kind' | 'path' | 'consumes' | 'contract'>;

const SQL_ENGINES = ['postgres', 'mysql', 'mariadb', 'sqlite'];

const places = (found: readonly Found[]): ServiceMapPlace[] => {
  const seen = new Set<string>();
  return found.filter((f) => {
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)).map(({ file, line }) => ({ file, line }));
};
const itemsOf = (found: readonly Found[], order: readonly string[] = []): string[] => {
  const items = [...new Set(found.map((f) => f.item))];
  return order.length ? order.filter((item) => items.includes(item)) : items.sort();
};

// The map before any refresh: the workspace's services, nothing read.
export function emptyMap(workspace: string, services: readonly MapServiceSpec[]): ServiceMap {
  return {
    workspace, builtAt: null, readAt: null, databases: [], links: [], impact: {},
    services: services.map((service) => ({
      name: service.name, commit: null, files: 0, problems: ['not_fetched'], dropped: 0,
      contract: service.contract ? { format: service.contract.format, path: service.contract.path, operations: [], channels: [] } : null,
    })),
  };
}

export function buildMap(input: { readonly workspace: string; readonly services: readonly MapServiceSpec[]; readonly reads: readonly ServiceRead[]; readonly at: string }): ServiceMap {
  const readOf = (name: string): ServiceRead => input.reads.find((read) => read.name === name)
    ?? { name, commit: null, files: [], conf: null, packageJson: null, contract: null, problems: ['not_fetched'] };
  // The contracts first: each service's code is read against the others'.
  const provided: Provided[] = [];
  const contractProblem = new Set<string>();
  const contracts = new Map<string, ServiceMapService['contract']>();
  for (const service of input.services) {
    if (!service.contract) { contracts.set(service.name, null); continue; }
    const text = readOf(service.name).contract;
    let facts: Pick<Provided, 'operations' | 'channels'> = { operations: [], channels: [] };
    if (text !== null) {
      try { facts = contractFacts(service.contract.format, service.contract.path, text); } catch { contractProblem.add(service.name); }
    } else if (readOf(service.name).commit !== null) contractProblem.add(service.name);
    provided.push({ service: service.name, ...facts });
    const all = text === null || contractProblem.has(service.name) ? [] : contractOperations(service.contract.format, service.contract.path, text);
    contracts.set(service.name, { format: service.contract.format, path: service.contract.path, operations: all, channels: [...facts.channels] });
  }
  const scans = new Map<string, Scan>(input.services.map((service) => {
    const read = readOf(service.name);
    return [service.name, scanService({ name: service.name, files: read.files, conf: read.conf, packageJson: read.packageJson, providers: provided })];
  }));
  const services: ServiceMapService[] = input.services.map((service) => {
    const read = readOf(service.name);
    return {
      name: service.name, commit: read.commit, contract: contracts.get(service.name) ?? null, files: read.files.length,
      problems: [...read.problems, ...(contractProblem.has(service.name) ? ['contract_unreadable' as const] : [])],
      dropped: scans.get(service.name)?.dropped ?? 0,
    };
  });

  const links: ServiceMapLink[] = [];
  // Calls: in the workspace's order of the callers, then of the services called.
  for (const caller of input.services) {
    const scan = scans.get(caller.name) as Scan;
    for (const provider of input.services) {
      if (provider.name === caller.name) continue;
      const found = scan.calls[provider.name] ?? [];
      const declared = caller.consumes.includes(provider.name);
      if (!declared && found.length === 0) continue;
      const order = provided.find((p) => p.service === provider.name)?.operations.map((op) => `${op.method} ${op.path}`) ?? [];
      links.push({ kind: 'call', from: caller.name, to: provider.name, items: itemsOf(found, order), declared, found: found.length > 0, places: places(found) });
    }
  }
  // Events: from the provider to each service that names one of its channels.
  for (const provider of input.services) {
    const channels = provided.find((p) => p.service === provider.name)?.channels ?? [];
    if (channels.length === 0) continue;
    for (const listener of input.services) {
      const found = scans.get(listener.name)?.listens[provider.name] ?? [];
      if (found.length === 0) continue;
      links.push({ kind: 'event', from: provider.name, to: listener.name, items: itemsOf(found, channels), declared: false, found: true, places: places(found) });
    }
  }
  // Databases: each service's engines, its tables in its SQL engine (sql when it names none).
  const databases: ServiceMapDatabase[] = [];
  const owners = new Map<string, { readonly id: string; readonly created: readonly Found[] }>();   // a table, its first creator's database
  for (const service of input.services) {
    const scan = scans.get(service.name) as Scan;
    const engines = [...scan.engines];
    const sql = engines.find((engine) => SQL_ENGINES.includes(engine)) ?? (scan.creates.length > 0 ? 'sql' : undefined);
    if (sql && !engines.includes(sql)) engines.push(sql);
    for (const engine of engines.sort()) {
      const created = engine === sql ? scan.creates : [];
      const id = `${service.name}:${engine}`;
      databases.push({ id, engine, owner: service.name, tables: itemsOf(created) });
      for (const table of itemsOf(created)) if (!owners.has(table)) owners.set(table, { id, created: created.filter((f) => f.item === table) });
      links.push({ kind: 'database', from: service.name, to: id, items: itemsOf(created), declared: false, found: true, places: places(created) });
    }
  }
  // A table another service reads or writes, and does not create itself.
  for (const service of input.services) {
    const scan = scans.get(service.name) as Scan;
    const own = new Set(scan.creates.map((f) => f.item));
    const shared = new Map<string, Found[]>();
    for (const use of scan.uses) {
      const owner = owners.get(use.item);
      if (!owner || own.has(use.item) || owner.id.startsWith(`${service.name}:`)) continue;
      shared.set(owner.id, [...(shared.get(owner.id) ?? []), use]);
    }
    for (const [id, found] of shared) links.push({ kind: 'database', from: service.name, to: id, items: itemsOf(found), declared: false, found: true, places: places(found) });
  }

  const map: ServiceMap = { workspace: input.workspace, builtAt: input.at, readAt: input.at, services, databases, links, impact: {} };
  return { ...map, impact: Object.fromEntries(input.services.map((service) => [service.name, impactOf(map, [service.name])])) };
}

// Every operation of a contract, as the screen names them ("POST /check"):
// an OpenAPI contract's, not the fakes' paths of the other formats.
function contractOperations(format: ContractFormat, path: string, text: string): string[] {
  if (format !== 'openapi') return [];
  return contractFacts(format, path, text).operations.map((op) => `${op.method} ${op.path}`);
}
