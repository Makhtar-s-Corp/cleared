// The test services a project declares for its sessions, read from the
// `[session] services` setting of its configuration: a comma-separated list
// of `[alias=]image:tag`, for example `services = postgres:16`. Each service
// runs as a sibling container on the session's internal network, reachable
// under its alias (by default the image's name).
//
// Only images listed in KNOWN are accepted. An image declares VOLUME paths,
// and Docker would create an anonymous volume, without Cleared's label, for
// each one; the table names those paths so they become tmpfs mounts instead,
// and gives each image what the session needs to reach it.

export type ServiceSpec = {
  readonly alias: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly tmpfs: readonly string[];
  // A command run in the service container until it exits 0.
  readonly ready: readonly string[];
  // Variables given to the session container.
  readonly sessionEnv: Readonly<Record<string, string>>;
};

export class ServiceError extends Error {
  override name = 'ServiceError';
}

type Known = {
  readonly env: Readonly<Record<string, string>>;
  readonly tmpfs: readonly string[];
  readonly ready: readonly string[];
  readonly sessionEnv: (alias: string) => Readonly<Record<string, string>>;
};

// postgres: the official image (docker.io/library/postgres), version 16
// only: its VOLUME is /var/lib/postgresql/data, and the doctor run checks
// that the service container has no volume mount. Another version is added
// once its VOLUME paths are checked the same way.
// Trust authentication: the database is a disposable test service on a
// network only the session reaches, so no password exists to be leaked.
const KNOWN: Readonly<Record<string, Known>> = {
  postgres: {
    env: { POSTGRES_HOST_AUTH_METHOD: 'trust' },
    tmpfs: ['/var/lib/postgresql/data'],
    // TCP on 127.0.0.1, so the temporary server of the first start, which
    // listens on the Unix socket only, does not count as ready.
    ready: ['pg_isready', '--quiet', '--host', '127.0.0.1', '--username', 'postgres'],
    sessionEnv: (alias) => ({ DATABASE_URL: `postgres://postgres@${alias}:5432/postgres` }),
  },
};

const KNOWN_TAGS: Readonly<Record<string, RegExp>> = {
  postgres: /^16(\.[0-9]+)?$/,
};

const ALIAS = /^[a-z][a-z0-9-]{0,30}$/;
const RESERVED = new Set(['egress', 'session', 'localhost']);

export function parseServices(setting: string): ServiceSpec[] {
  if (setting.trim() === '') return [];
  const services: ServiceSpec[] = [];
  for (const raw of setting.split(',')) {
    const item = raw.trim();
    const at = item.indexOf('=');
    const image = at < 0 ? item : item.slice(at + 1);
    const colon = image.indexOf(':');
    const name = colon < 0 ? image : image.slice(0, colon);
    const tag = colon < 0 ? '' : image.slice(colon + 1);
    const alias = at < 0 ? name : item.slice(0, at);
    const known = KNOWN[name];
    if (!known) throw new ServiceError(`service "${item}": only these images are supported in milestone 1: ${Object.keys(KNOWN).map((n) => `${n}:<tag>`).join(', ')}`);
    if (!KNOWN_TAGS[name]?.test(tag)) throw new ServiceError(`service "${item}": give an explicit supported tag, for example ${name}:16`);
    if (!ALIAS.test(alias) || RESERVED.has(alias)) throw new ServiceError(`service "${item}": the alias must be lowercase letters, digits and dashes, and not ${[...RESERVED].join(', ')}`);
    if (services.some((s) => s.alias === alias)) throw new ServiceError(`service "${item}": the alias ${alias} is used twice`);
    services.push({ alias, image: `${name}:${tag}`, env: known.env, tmpfs: known.tmpfs, ready: known.ready, sessionEnv: known.sessionEnv(alias) });
  }
  return services;
}
