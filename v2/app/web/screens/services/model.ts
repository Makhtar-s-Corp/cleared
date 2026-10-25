// The service map screen's rules (docs/v2/milestone-4-plan.md, section
// 11.4): where each box of the drawing goes, callers left of the services
// they call and each database under its owner; the links in words, which
// the drawing only repeats; the impact of the service picked, as the
// service computed it; the map's age and its problems. No React here, so
// the node tests read it.
import type { ServiceMap, ServiceMapLink, ServiceMapService } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';
import { ago } from '../../lib/time.ts';

type Api = ScreenContext['api'];

export const readMap = (api: Api): Promise<ServiceMap> => api<ServiceMap>('/service-map');
export const refreshMap = (api: Api): Promise<ServiceMap> => api<ServiceMap>('/service-map/refresh', { method: 'POST' });

export function mapFailure(error: unknown): string {
  return error instanceof ApiError && error.status === 503 ? 'map_down' : 'map_read_failed';
}

// ------------------------------------------------------------------ names

// The products' own names, the same in every language.
const ENGINES: Readonly<Record<string, string>> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite', mongodb: 'MongoDB', redis: 'Redis', sql: 'SQL',
};
const FORMATS: Readonly<Record<string, string>> = { openapi: 'OpenAPI', jsonschema: 'JSON Schema', protobuf: 'protobuf', events: 'AsyncAPI' };

export const engineName = (engine: string): string => ENGINES[engine] ?? engine;
export const formatName = (format: string): string => FORMATS[format] ?? format;

// A database by its words: "PostgreSQL of guestbook".
export function databaseName(map: Pick<ServiceMap, 'databases'>, id: string, t: Translate): string {
  const database = map.databases.find((d) => d.id === id);
  return database ? t('map_database', { engine: engineName(database.engine), owner: database.owner }) : id;
}

const list = (names: readonly string[], t: Translate): string =>
  (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')}${t('map_and')}${names.at(-1)}`);

// ------------------------------------------------------------------ drawing

export const BOX = { w: 168, h: 56, gapX: 96, gapY: 24, pad: 24, dbW: 148, dbH: 48 } as const;

// A drawing at most this wide shrinks to a narrow screen; a wider one keeps
// its size and scrolls in its box, so its names stay readable.
export const FIT_WIDTH = 560;

export type Box = {
  readonly id: string;
  readonly kind: 'service' | 'database';
  readonly label: string;
  readonly column: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type Edge = {
  readonly kind: ServiceMapLink['kind'];
  readonly from: string;
  readonly to: string;
  readonly undeclared: boolean;
  readonly path: string;
};

export type Drawing = { readonly width: number; readonly height: number; readonly boxes: readonly Box[]; readonly edges: readonly Edge[] };

// A service's column: 0 when nothing calls it, else one more than its
// furthest caller's. A call found against a declared one can make a cycle;
// the depth stops at the number of services.
function columns(map: Pick<ServiceMap, 'services' | 'links'>): Map<string, number> {
  const calls = map.links.filter((link) => link.kind === 'call');
  const column = new Map<string, number>();
  const depth = (name: string, seen: readonly string[]): number => {
    const known = column.get(name);
    if (known !== undefined) return known;
    if (seen.includes(name) || seen.length > map.services.length) return 0;
    const callers = calls.filter((link) => link.to === name).map((link) => link.from);
    const value = callers.length === 0 ? 0 : Math.max(...callers.map((caller) => depth(caller, [...seen, name]) + 1));
    if (seen.length === 0) column.set(name, value);
    return value;
  };
  for (const service of map.services) column.set(service.name, depth(service.name, []));
  return column;
}

const n = (value: number) => Math.round(value * 10) / 10;

// A curve from one box to another: from the side facing it, or from the
// bottom of a service to the top of its database.
function curve(from: Box, to: Box, kind: Edge['kind']): string {
  if (kind === 'database') {
    const x1 = from.x + from.w / 2; const y1 = from.y + from.h;
    const x2 = to.x + to.w / 2; const y2 = to.y;
    const mid = (y1 + y2) / 2;
    return `M${n(x1)} ${n(y1)} C${n(x1)} ${n(mid)} ${n(x2)} ${n(mid)} ${n(x2)} ${n(y2)}`;
  }
  const forward = to.x > from.x;
  const x1 = forward ? from.x + from.w : from.x; const y1 = from.y + from.h / 2;
  const x2 = forward ? to.x : to.x + to.w; const y2 = to.y + to.h / 2;
  if (forward) {
    const mid = (x1 + x2) / 2;
    return `M${n(x1)} ${n(y1)} C${n(mid)} ${n(y1)} ${n(mid)} ${n(y2)} ${n(x2)} ${n(y2)}`;
  }
  // Backwards or in the same column: a loop out to the left.
  const out = Math.min(x1, x2) - BOX.gapX / 2;
  return `M${n(x1)} ${n(y1)} C${n(out)} ${n(y1)} ${n(out)} ${n(y2)} ${n(x2)} ${n(y2)}`;
}

export function layout(map: Pick<ServiceMap, 'services' | 'links' | 'databases'>): Drawing {
  const column = columns(map);
  const count = Math.max(1, ...[...column.values()].map((c) => c + 1));
  const rows = new Map<number, number>();
  const boxes: Box[] = [];
  // A column more on the left for a loop's room.
  const left = BOX.pad + (map.links.some((link) => link.kind !== 'database' && (column.get(link.to) ?? 0) <= (column.get(link.from) ?? 0) && link.kind === 'call') ? BOX.gapX / 2 : 0);
  for (const service of map.services) {
    const c = column.get(service.name) ?? 0;
    const row = rows.get(c) ?? 0;
    rows.set(c, row + 1);
    boxes.push({ id: service.name, kind: 'service', label: service.name, column: c, x: left + c * (BOX.w + BOX.gapX), y: BOX.pad + row * (BOX.h + BOX.gapY), w: BOX.w, h: BOX.h });
  }
  const servicesBottom = BOX.pad + Math.max(1, ...rows.values()) * (BOX.h + BOX.gapY) - BOX.gapY;
  // The databases a row under the services, each under its owner, side by side when an owner has several.
  const below = new Map<string, number>();
  for (const database of map.databases) {
    const owner = boxes.find((box) => box.id === database.owner);
    if (!owner) continue;
    const k = below.get(database.owner) ?? 0;
    below.set(database.owner, k + 1);
    boxes.push({
      id: database.id, kind: 'database', label: engineName(database.engine), column: owner.column,
      x: owner.x + (BOX.w - BOX.dbW) / 2, y: servicesBottom + BOX.gapX * 0.6 + k * (BOX.dbH + BOX.gapY), w: BOX.dbW, h: BOX.dbH,
    });
  }
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const edges: Edge[] = map.links.flatMap((link) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) return [];
    return [{ kind: link.kind, from: link.from, to: link.to, undeclared: link.kind === 'call' && !link.declared, path: curve(from, to, link.kind) }];
  });
  const width = Math.max(left + count * (BOX.w + BOX.gapX) - BOX.gapX, ...boxes.map((box) => box.x + box.w)) + BOX.pad;
  const height = Math.max(...boxes.map((box) => box.y + box.h), servicesBottom) + BOX.pad;
  return { width, height, boxes, edges };
}

// ------------------------------------------------------------------ words

export type LinkRow = {
  readonly key: string;
  readonly kind: ServiceMapLink['kind'];
  readonly text: string;
  readonly state: string;
  readonly undeclared: boolean;
  readonly places: string;
};

function stateOf(link: ServiceMapLink, t: Translate): string {
  if (link.kind !== 'call') return t('map_state_found');
  if (link.declared && link.found) return t('map_state_both');
  if (link.declared) return t('map_state_declared');
  return t('map_state_undeclared');
}

export function linkRows(map: ServiceMap, t: Translate): LinkRow[] {
  return map.links.map((link) => {
    const items = link.items.join(', ');
    const to = link.kind === 'database' ? databaseName(map, link.to, t) : link.to;
    const key = link.kind === 'event' ? 'map_link_event' : link.kind === 'database' ? (items ? 'map_link_database' : 'map_link_database_bare') : (items ? 'map_link_call' : 'map_link_call_bare');
    return {
      key: `${link.kind}:${link.from}:${link.to}`, kind: link.kind, text: t(key, { from: link.from, to, items }), state: stateOf(link, t),
      undeclared: link.kind === 'call' && !link.declared, places: link.places.map((place) => `${place.file}:${place.line}`).join(', '),
    };
  });
}

export type ImpactLine = { readonly kind: 'caller' | 'through' | 'listener' | 'sharing' | 'contract' | 'must' | 'undeclared' | 'none' | 'order'; readonly text: string };

export function impactLines(map: ServiceMap, service: string, t: Translate): ImpactLine[] {
  const impact = map.impact[service];
  const one = impact?.services[0];
  if (!impact || !one) return [];
  const lines: ImpactLine[] = [];
  for (const caller of one.callers) {
    if (caller.through !== null) lines.push({ kind: 'through', text: t('map_impact_through', { name: caller.name, through: caller.through }) });
    else lines.push({ kind: 'caller', text: caller.items.length > 0 ? t('map_impact_caller', { name: caller.name, items: caller.items.join(', ') }) : t('map_impact_caller_bare', { name: caller.name }) });
  }
  for (const listener of one.listeners) lines.push({ kind: 'listener', text: t('map_impact_listener', { name: listener.name, items: listener.channels.join(', ') }) });
  for (const shared of one.sharing) {
    const own = shared.database.startsWith(`${service}:`);
    lines.push({ kind: 'sharing', text: t(own ? 'map_impact_sharing' : 'map_impact_shared', { name: shared.name, items: shared.tables.join(', ') }) });
  }
  const contract = map.services.find((s) => s.name === service)?.contract;
  if (contract) lines.push({ kind: 'contract', text: t('map_impact_contract', { format: formatName(contract.format), path: contract.path }) });
  if (impact.mustChange.length > 0) lines.push({ kind: 'must', text: t(impact.mustChange.length === 1 ? 'map_impact_must_one' : 'map_impact_must_many', { names: list(impact.mustChange, t) }) });
  for (const call of impact.undeclared) lines.push({ kind: 'undeclared', text: t('map_impact_undeclared', { from: call.from, to: call.to }) });
  if (one.callers.length === 0 && one.listeners.length === 0 && one.sharing.length === 0) lines.push({ kind: 'none', text: t('map_impact_none') });
  lines.push({ kind: 'order', text: t('map_impact_order', { order: impact.order.join(t('map_then')) }) });
  return lines;
}

export function builtLine(map: Pick<ServiceMap, 'builtAt'>, now: Date, t: Translate): string {
  return map.builtAt === null ? t('map_never') : t('map_built', { time: ago(map.builtAt, now, t) });
}

export function problemLines(service: ServiceMapService, t: Translate): string[] {
  return [...service.problems.map((problem) => t(`map_problem_${problem}`)), ...(service.dropped > 0 ? [t('map_problem_dropped', { n: String(service.dropped) })] : [])];
}

// A service's line under its name: its base commit, its contract.
export function serviceDetail(service: ServiceMapService, t: Translate): string {
  const base = service.commit ? t('map_service_commit', { commit: service.commit.slice(0, 7) }) : t('map_service_not_fetched');
  return service.contract ? `${base} · ${t('map_service_contract', { format: formatName(service.contract.format) })}` : base;
}
