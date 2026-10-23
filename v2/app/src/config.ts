// The app's settings, read from the environment.
//   CLEARED_V2_APP_HOST      default 127.0.0.1; loopback only (127.0.0.1, ::1, localhost)
//   CLEARED_V2_APP_PORT      default 8792
//   CLEARED_V2_APP_SOURCE    service (default) or fixtures
//   CLEARED_V2_PORT          the service's port, default 8791 (src/config.ts)
//   CLEARED_V2_APP_LANGUAGE  fr (default, the owner's decision of 2026-10-23) or en
//   CLEARED_V2_APP_PROJECT   the project name in the header; else the last
//                            part of CLEARED_REPO or ORCH_REPO
//   CLEARED_V2_APP_ORIGIN    the address the browser uses when it is not the
//                            app's own (a proxy on this machine); writes must
//                            come from it
import { basename } from 'node:path';
import { DEFAULT_PORT as SERVICE_PORT, RESERVED_PORTS } from '../../src/config.ts';
import { LANGUAGES, type Language } from './catalog.ts';

export const DEFAULT_APP_HOST = '127.0.0.1';
export const DEFAULT_APP_PORT = 8792;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export type AppConfig = {
  readonly host: string;
  readonly port: number;
  readonly source: 'service' | 'fixtures';
  readonly serviceUrl: string;
  readonly language: Language;
  readonly project: string;
  readonly publicOrigin: string | undefined;
};

export class AppConfigError extends Error {
  override name = 'AppConfigError';
}

function port(name: string, value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new AppConfigError(`${name} must be a whole number, got "${raw}"`);
  const number = Number(raw);
  if (number < 1 || number > 65535) throw new AppConfigError(`${name} must be between 1 and 65535, got ${number}`);
  if (RESERVED_PORTS.has(number)) throw new AppConfigError(`${name} ${number} is reserved (${[...RESERVED_PORTS].join(', ')}): choose a free port`);
  return number;
}

export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.CLEARED_V2_APP_HOST?.trim() || DEFAULT_APP_HOST;
  if (!LOOPBACK.has(host)) throw new AppConfigError(`CLEARED_V2_APP_HOST must be this machine only (127.0.0.1, ::1 or localhost), got "${host}"`);
  const servicePort = port('CLEARED_V2_PORT', env.CLEARED_V2_PORT, SERVICE_PORT);
  const appPort = port('CLEARED_V2_APP_PORT', env.CLEARED_V2_APP_PORT, DEFAULT_APP_PORT);
  if (appPort === servicePort) throw new AppConfigError(`CLEARED_V2_APP_PORT ${appPort} is the service's port: choose another one`);
  const source = env.CLEARED_V2_APP_SOURCE?.trim() || 'service';
  if (source !== 'service' && source !== 'fixtures') throw new AppConfigError(`CLEARED_V2_APP_SOURCE must be service or fixtures, got "${source}"`);
  const language = env.CLEARED_V2_APP_LANGUAGE?.trim() || 'fr';
  if (!(LANGUAGES as readonly string[]).includes(language)) throw new AppConfigError(`CLEARED_V2_APP_LANGUAGE must be ${LANGUAGES.join(' or ')}, got "${language}"`);
  const repo = env.CLEARED_REPO || env.ORCH_REPO;
  const project = env.CLEARED_V2_APP_PROJECT?.trim() || (repo ? basename(repo) : '');
  const origin = env.CLEARED_V2_APP_ORIGIN?.trim();
  let publicOrigin: string | undefined;
  if (origin) {
    try { publicOrigin = new URL(origin).origin; }
    catch { throw new AppConfigError(`CLEARED_V2_APP_ORIGIN must be an address such as https://host:8443, got "${origin}"`); }
  }
  return { host, port: appPort, source, serviceUrl: `http://127.0.0.1:${servicePort}`, language: language as Language, project, publicOrigin };
}
