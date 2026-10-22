// How the service is put together (docs/v2/milestone-1-plan.md, section 10).
// Eight modules, one file each under src/modules/, each declaring its tables,
// its routes and the registry slots it fills. main.ts assembles them; a lane
// fills its own module and never edits main.ts or another module. Every
// slot has an in-memory default, so a module that is still a stub leaves
// the service working on memory.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestPath } from '../server.ts';
import type { Harness, SessionAdapter, SessionId, UserId } from '../session/contract.ts';
import type { Store } from '../store/db.ts';
import { MemoryTicketStore, type TicketId, type TicketStore } from '../tickets/contract.ts';

export type User = { readonly id: UserId; readonly name: string };

export interface UserDirectory {
  get(id: UserId): Promise<User | undefined>;
  list(): Promise<User[]>;
}

// A review's outcome, written where merge-pr.sh reads it (lane 8): a `runs`
// row with role review and a report file ending with the [merge] verdict.
export type ReviewRecord = {
  readonly ticket: TicketId;
  readonly pr: number;
  readonly session: SessionId;
  readonly model: string;
  readonly verdict: 'pass' | 'changes_requested';
  readonly round: number;
  readonly report: string;
  readonly at: string;
};

export interface ReviewRecorder {
  record(review: ReviewRecord): Promise<void>;
}

// The human's approval, as the app forwards it: who, when the request was
// shown, and the exact heads shown, which the signed move is bound to
// (approval_context, decision 6).
export type ApprovalRequest = {
  readonly ticket: TicketId;
  readonly by: UserId;
  readonly requestedAt: string;
  readonly heads: readonly { readonly pr: number; readonly head: string }[];
};

export interface ApprovalWriter {
  approve(request: ApprovalRequest): Promise<void>;
}

export type Registry = {
  readonly sessionAdapters: Readonly<Partial<Record<Harness, SessionAdapter>>>;
  readonly ticketStore: TicketStore;
  readonly reviewRecorder: ReviewRecorder;
  readonly approvalWriter: ApprovalWriter;
  readonly users: UserDirectory;
};

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly params: Readonly<Record<string, string>>;   // the :name segments of the path, decoded
  readonly registry: Registry;
};

export type Route = {
  readonly method: Method;
  readonly path: string;                               // segments, ':name' for a parameter: '/api/sessions/:id/events'
  handle(context: RouteContext): void | Promise<void>;
};

// What a module may use to fill its slots: the store holds ledger.db, where
// its tables were created before provide is called.
export type ModuleDeps = { readonly store: Store };

export type Module = {
  readonly tables: readonly string[];                  // CREATE TABLE IF NOT EXISTS statements
  readonly routes: readonly Route[];
  readonly provide: (deps: ModuleDeps) => Partial<Registry>;
};

// lead and notify: milestone 2 (docs/v2/milestone-2-plan.md, decision 14).
export const MODULE_NAMES = ['sessions', 'users', 'tickets', 'flow', 'approval', 'inbox', 'lead', 'notify'] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

export const emptyModule: Module = { tables: [], routes: [], provide: () => ({}) };

export class MemoryUsers implements UserDirectory {
  readonly users = new Map<UserId, User>();
  async get(id: UserId) { return this.users.get(id); }
  async list() { return [...this.users.values()]; }
}

export class MemoryReviewRecorder implements ReviewRecorder {
  readonly records: ReviewRecord[] = [];
  async record(review: ReviewRecord) { this.records.push(review); }
}

export class MemoryApprovalWriter implements ApprovalWriter {
  readonly approvals: ApprovalRequest[] = [];
  async approve(request: ApprovalRequest) { this.approvals.push(request); }
}

export function defaultRegistry(): Registry {
  return {
    sessionAdapters: {},
    ticketStore: new MemoryTicketStore(),
    reviewRecorder: new MemoryReviewRecorder(),
    approvalWriter: new MemoryApprovalWriter(),
    users: new MemoryUsers(),
  };
}

export type App = {
  readonly registry: Registry;
  readonly tables: readonly string[];
  readonly routes: readonly Route[];
};

// The modules' tables and routes in module order, and the registry with
// each module's slots over the defaults. Two modules filling one slot, or
// declaring one route, is a mistake of the lanes: it stops the service.
// The modules' tables must exist before this runs (main.ts creates them).
export function assemble(modules: Readonly<Record<ModuleName, Module>>, deps: ModuleDeps): App {
  const slots: Record<string, unknown> = { ...defaultRegistry() };
  const slotOwner = new Map<string, ModuleName>();
  const routeOwner = new Map<string, ModuleName>();
  const tables: string[] = [];
  const routes: Route[] = [];
  for (const name of MODULE_NAMES) {
    const module = modules[name];
    tables.push(...module.tables);
    for (const route of module.routes) {
      const key = `${route.method} ${route.path}`;
      const owner = routeOwner.get(key);
      if (owner) throw new Error(`${key} is declared by both ${owner} and ${name}`);
      routeOwner.set(key, name);
      routes.push(route);
    }
    for (const [slot, value] of Object.entries(module.provide(deps))) {
      const owner = slotOwner.get(slot);
      if (owner) throw new Error(`${slot} is provided by both ${owner} and ${name}`);
      slotOwner.set(slot, name);
      slots[slot] = value;
    }
  }
  return { registry: slots as Registry, tables, routes };
}

export type Match =
  | { readonly route: Route; readonly params: Readonly<Record<string, string>> }
  | { readonly allow: readonly Method[] };

// The route for a method and a path, or the methods the path allows, or
// undefined when no route has this path.
export function matchRoute(routes: readonly Route[], method: string, path: string): Match | undefined {
  const parts = path.split('/');
  const allow: Method[] = [];
  for (const route of routes) {
    const pattern = route.path.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const matches = pattern.every((segment, i) => {
      const part = parts[i] as string;
      if (!segment.startsWith(':')) return segment === part;
      if (part === '') return false;
      try {
        params[segment.slice(1)] = decodeURIComponent(part);
        return true;
      } catch {
        return false;
      }
    });
    if (!matches) continue;
    if (route.method === method) return { route, params };
    allow.push(route.method);
  }
  return allow.length > 0 ? { allow } : undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', ...headers });
  response.end(text);
}

// Serves a request with the modules' routes, and anything no route claims
// (/health, unknown paths, a target the URL parser refuses) with `fallback`.
// A failing handler answers 500 without its error, which is logged by name
// only: an error message may carry what the cleaner would have removed.
export function dispatch(app: App, request: IncomingMessage, response: ServerResponse, fallback: (request: IncomingMessage, response: ServerResponse) => void): void {
  const path = requestPath(request.url ?? '/');
  const match = path === undefined ? undefined : matchRoute(app.routes, request.method ?? 'GET', path);
  if (!match) return fallback(request, response);
  if ('allow' in match) return sendJson(response, 405, { error: 'method not allowed' }, { allow: match.allow.join(', ') });
  const fail = (error: unknown) => {
    console.error(`cleared-v2: ${match.route.method} ${match.route.path} failed (${error instanceof Error ? error.name : typeof error})`);
    if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
    else response.destroy();
  };
  try {
    Promise.resolve(match.route.handle({ request, response, params: match.params, registry: app.registry })).catch(fail);
  } catch (error) {
    fail(error);
  }
}
