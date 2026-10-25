// The map kept up to date (docs/v2/milestone-4-plan.md, section 11.4): one
// row per workspace in service_maps, the map and the key it was built
// from. A refresh fetches each service's checkout, reads each base commit,
// and builds the map again only when the key moved: a base commit, a
// fetch's outcome or the workspace file's services. A call is read against
// the provider's contract, so the whole map is built again, never one
// service. One refresh runs at a time; a second call waits for it. The
// lead module refreshes at the service's start and every
// CLEARED_V2_MAP_MINUTES (MAP_MINUTES; 0 for never), the screen on demand.
import type { DatabaseSync } from 'node:sqlite';
import { buildMap, emptyMap, type MapServiceSpec, type ServiceMap, type ServiceMapProblem, type ServiceRead } from './build.ts';
import { baseCommit, readService, type MapService } from './source.ts';

export const MAP_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS service_maps (
    project TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    map TEXT NOT NULL,
    built_at TEXT NOT NULL,
    read_at TEXT NOT NULL
  )`,
];

export const MAP_MINUTES = 10;

// CLEARED_V2_MAP_MINUTES: a whole number of minutes, 0 for never; anything else is the default, said.
export function mapMinutes(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return MAP_MINUTES;
  const minutes = Number(value);
  if (Number.isInteger(minutes) && minutes >= 0) return minutes;
  console.error(`cleared-v2: CLEARED_V2_MAP_MINUTES is a whole number of minutes, not "${value}": the service map is refreshed every ${MAP_MINUTES} minutes`);
  return MAP_MINUTES;
}

export type MapServiceConfig = MapServiceSpec & Pick<MapService, 'base' | 'dir'>;

export type ServiceMapsDeps = {
  readonly db: DatabaseSync;
  readonly project: string;
  readonly services: readonly MapServiceConfig[];
  readonly fetch?: (name: string) => Promise<void>;                 // fetches the service's checkout; none: read what is there
  readonly head?: (service: MapService) => Promise<string | null>;  // baseCommit by default
  readonly read?: (service: MapService) => Promise<ServiceRead>;    // readService by default
  readonly now?: () => Date;
};

type Row = { key: string; map: string; read_at: string };

export class ServiceMaps {
  readonly #deps: ServiceMapsDeps;
  #running: Promise<ServiceMap> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: ServiceMapsDeps) {
    this.#deps = deps;
  }

  // The clock the map is built by, which its age is read against.
  now(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  get services(): readonly string[] {
    return this.#deps.services.map((service) => service.name);
  }

  #source(service: MapServiceConfig): MapService {
    return { name: service.name, base: service.base, dir: service.dir, path: service.path, contract: service.contract ? { path: service.contract.path } : null };
  }

  #row(): Row | undefined {
    return this.#deps.db.prepare('SELECT key, map, read_at FROM service_maps WHERE project = ?').get(this.#deps.project) as Row | undefined;
  }

  // The stored map, or the empty one before any refresh.
  current(): ServiceMap {
    const row = this.#row();
    if (!row) return emptyMap(this.#deps.project, this.#deps.services);
    return { ...(JSON.parse(row.map) as ServiceMap), readAt: row.read_at };
  }

  refresh(): Promise<ServiceMap> {
    this.#running ??= this.#refresh().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #refresh(): Promise<ServiceMap> {
    const now = this.now().toISOString();
    const head = this.#deps.head ?? baseCommit;
    const read = this.#deps.read ?? ((service: MapService) => readService(service));
    const failed = new Set<string>();
    const commits: (string | null)[] = [];
    for (const service of this.#deps.services) {
      if (this.#deps.fetch) {
        try { await this.#deps.fetch(service.name); } catch { failed.add(service.name); }
      }
      commits.push(await head(this.#source(service)));
    }
    const key = JSON.stringify(this.#deps.services.map((service, i) => [service.name, service.kind, service.path, service.consumes, service.contract, commits[i], failed.has(service.name)]));
    const row = this.#row();
    if (row && row.key === key) {
      this.#deps.db.prepare('UPDATE service_maps SET read_at = ? WHERE project = ?').run(now, this.#deps.project);
      return this.current();
    }
    const reads: ServiceRead[] = [];
    for (const service of this.#deps.services) {
      const one = await read(this.#source(service));
      const problems: ServiceMapProblem[] = failed.has(service.name) ? [...one.problems, 'fetch_failed'] : [...one.problems];
      reads.push({ ...one, problems });
    }
    const map = buildMap({ workspace: this.#deps.project, services: this.#deps.services, reads, at: now });
    this.#deps.db.prepare(`INSERT INTO service_maps (project, key, map, built_at, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project) DO UPDATE SET key = excluded.key, map = excluded.map, built_at = excluded.built_at, read_at = excluded.read_at`)
      .run(this.#deps.project, key, JSON.stringify(map), now, now);
    return map;
  }

  // A refresh every `ms`; one that fails is one line, the next tries again.
  startTimer(ms: number): void {
    this.stop();
    this.#timer = setInterval(() => {
      void this.refresh().catch((error) => console.error(`cleared-v2: the service map's refresh failed (${error instanceof Error ? error.name : typeof error})`));
    }, ms);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
