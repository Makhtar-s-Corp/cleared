// Where the filter API listens, read from the environment.
//   HOST  default 127.0.0.1 (this machine only); the image sets 0.0.0.0,
//         its port being published on 127.0.0.1 of the host only
//   PORT  default 8795

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8795;

// Ports refused even when asked for: 80 and 443 belong to the machine's
// public proxy, 8787 and 8788 are Cleared v1's dashboard and app, 8790 is
// reserved, 8791 to 8794 are Cleared v2's service, app, the guestbook and
// the preview listener.
export const RESERVED_PORTS: ReadonlySet<number> = new Set([80, 443, 8787, 8788, 8790, 8791, 8792, 8793, 8794]);

export type Config = {
  readonly host: string;
  readonly port: number;
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

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.PORT?.trim();
  const port = rawPort ? parsePort(rawPort) : DEFAULT_PORT;
  return { host, port };
}
