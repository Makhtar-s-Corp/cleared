// The setup module on a loopback port with a scratch state folder, for the
// service's setup tests: its routes as the app forwards them (the app's
// proof and the user's id), its start, and what it printed.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { defaultRegistry, dispatch, type App, type Registry } from '../../src/modules/registry.ts';
import { createSetupModule, type SetupModuleOptions } from '../../src/modules/setup.ts';
import users, { SqliteUsers, type PasswordParams } from '../../src/modules/users.ts';
import { handle } from '../../src/server.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';

export const FAST: PasswordParams = { algorithm: 'argon2id', memory: 64, passes: 1, parallelism: 1, saltLength: 16, tagLength: 32 };
export const PASSWORD = 'a long passphrase';
const PROOF = 'a'.repeat(64);

export type SetupService = {
  readonly base: string;
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly store: Store;
  readonly directory: SqliteUsers;
  readonly registry: Registry;
  readonly lines: string[];
  start(): void;
  call(path: string, options?: { readonly method?: string; readonly user?: string; readonly body?: unknown; readonly proof?: string | null }): Promise<{ status: number; text: string; json: any }>;
  close(): Promise<void>;
};

export async function startSetup(options: Partial<Omit<SetupModuleOptions, 'env' | 'proof' | 'log'>> & { readonly env?: Record<string, string> } = {}): Promise<SetupService> {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-setup-'));
  const env: NodeJS.ProcessEnv = { CLEARED_STATE_DIR: dir, ...options.env };
  const store = openStore(join(dir, 'ledger.db'));
  const lines: string[] = [];
  const { env: _env, ...rest } = options;
  const setup = createSetupModule({ ...rest, env, proof: () => PROOF, log: (line) => lines.push(line), fromEnvironment: new Set(Object.keys(options.env ?? {})) });
  applyTables(store.db, [...users.tables, ...setup.tables]);
  const directory = new SqliteUsers(store.db, { params: FAST });
  const registry: Registry = { ...defaultRegistry(), ...setup.provide({ store }), users: directory };
  const app: App = { registry, tables: setup.tables, routes: setup.routes };
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, dir, env, store, directory, registry, lines,
    start: () => setup.start?.(registry),
    async call(path, { method = 'GET', user, body, proof = PROOF } = {}) {
      const headers: Record<string, string> = {};
      if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
      if (user) headers[SERVICE_USER_HEADER] = user;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: response.status, text, json };
    },
    async close() {
      await setup.stop?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
