// Where the service listens, read from the environment.
//   CLEARED_V2_HOST  default 127.0.0.1 (this machine only)
//   CLEARED_V2_PORT  default 8791

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8791;

// Ports the service refuses even when asked for them. 80 and 443 belong to
// the machine's public proxy (docs/concepts.md#decisions, issue #112); 8787
// and 8788 are the v1 dashboard and app defaults; 8790 is kept free on the
// owner's host.
export const RESERVED_PORTS: ReadonlySet<number> = new Set([80, 443, 8787, 8788, 8790]);

export type Config = {
  readonly host: string;
  readonly port: number;
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new ConfigError(`CLEARED_V2_PORT must be a whole number, got "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new ConfigError(`CLEARED_V2_PORT must be between 1 and 65535, got ${port}`);
  if (RESERVED_PORTS.has(port)) throw new ConfigError(`CLEARED_V2_PORT ${port} is reserved (${[...RESERVED_PORTS].join(', ')}): choose a free port`);
  return port;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.CLEARED_V2_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.CLEARED_V2_PORT?.trim();
  const port = rawPort ? parsePort(rawPort) : DEFAULT_PORT;
  return { host, port };
}
