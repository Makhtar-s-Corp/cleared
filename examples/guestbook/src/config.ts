// Where the guestbook listens and which database it uses, read from the environment.
//   HOST          default 127.0.0.1 (this machine only); the image sets 0.0.0.0,
//                 its port being published on 127.0.0.1 of the host only
//   PORT          default 8793
//   DATABASE_URL  required, for example postgres://postgres@127.0.0.1:5432/postgres
//   FILTER_URL    optional, the filter API's address (http://filter-api:8795);
//                 set, every entry is checked by it before it is stored
//   PROOF_BREAK_HEALTH  1 turns the proof's provoked failure on (below)

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8793;

// Ports refused even when asked for: 80 and 443 belong to the machine's
// public proxy, 8787 and 8788 are Cleared v1's dashboard and app, 8790 is reserved.
export const RESERVED_PORTS: ReadonlySet<number> = new Set([80, 443, 8787, 8788, 8790]);

// The multi-service proof's provoked failure (README, "The proof's
// tickets"): its second ticket sets this to true in a change of its own, so
// /health answers 503 once that change is deployed and the release watch
// rolls the guestbook back. PROOF_BREAK_HEALTH=1 turns it on by hand.
export const PROOF_BREAK_HEALTH: boolean = false;

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly filterUrl?: string;
  readonly breakHealth: boolean;
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new ConfigError(`PORT must be a whole number, got "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new ConfigError(`PORT must be between 1 and 65535, got ${port}`);
  if (RESERVED_PORTS.has(port)) throw new ConfigError(`PORT ${port} is reserved (${[...RESERVED_PORTS].join(', ')}): choose a free port`);
  return port;
}

// The filter API's base address: http or https, no credentials, no query
// nor fragment, the trailing slash dropped so `${url}/check` is its route.
export function parseFilterUrl(value: string): string {
  // The value is never echoed: a wrong one may carry a password.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('FILTER_URL must be an http or https address');
  }
  if (url.username || url.password) throw new ConfigError('FILTER_URL must not carry credentials');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError('FILTER_URL must be an http or https address');
  if (url.search || url.hash) throw new ConfigError('FILTER_URL must not carry a query or a fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is not set');
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.PORT?.trim();
  const port = rawPort ? parsePort(rawPort) : DEFAULT_PORT;
  const rawFilter = env.FILTER_URL?.trim();
  const breakHealth = PROOF_BREAK_HEALTH || env.PROOF_BREAK_HEALTH?.trim() === '1';
  return { host, port, databaseUrl, ...(rawFilter ? { filterUrl: parseFilterUrl(rawFilter) } : {}), breakHealth };
}
