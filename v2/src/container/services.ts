// The test services a project declares for its sessions, read from the
// `[session] services` setting of its configuration: a comma-separated list
// of `[alias=]image:tag`, for example `services = postgres:16`. An image may
// be followed by `NAME=value` words that restate its fixed environment (the
// guestbook commits `postgres:16 POSTGRES_HOST_AUTH_METHOD=trust`); a word
// that would change it is refused. Each service
// runs as a sibling container on the session's internal network, reachable
// under its alias (by default the image's name).
//
// Only images listed in KNOWN are accepted. An image declares VOLUME paths,
// and Docker would create an anonymous volume, without Cleared's label, for
// each one; the table names those paths so they become tmpfs mounts instead,
// and gives each image what the session needs to reach it.
import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractFormat } from '../api/types.ts';

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
    const [item = '', ...words] = raw.trim().split(/\s+/);
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
    for (const word of words) {
      const eq = word.indexOf('=');
      const key = word.slice(0, eq);
      if (eq < 1 || known.env[key] !== word.slice(eq + 1)) throw new ServiceError(`service "${raw.trim()}": "${word}" is not part of its fixed environment (${Object.entries(known.env).map(([k, v]) => `${k}=${v}`).join(' ')}): milestone 1 does not change a service's environment`);
    }
    if (services.some((s) => s.alias === alias)) throw new ServiceError(`service "${item}": the alias ${alias} is used twice`);
    services.push({ alias, image: `${name}:${tag}`, env: known.env, tmpfs: known.tmpfs, ready: known.ready, sessionEnv: known.sessionEnv(alias) });
  }
  return services;
}

// ------------------------------------------------------- test secrets
//
// A service's test secrets (docs/v2/milestone-5-plan.md, decision 12, C16)
// are environment variables of its session's container and of its real
// sibling. A name is an environment variable's, never one that Cleared, a
// harness, a test service or the system reads to run the container: the
// proxy, the home folder, the harness's login, Node's or the dynamic
// loader's options, git's, the certificates trusted. The store refuses
// such a name, and the runtime leaves it out again.
const TEST_VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_VARIABLES: ReadonlySet<string> = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TERM', 'LANG', 'TZ', 'HOSTNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'FTP_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  ...Object.values(KNOWN).flatMap((known) => [...Object.keys(known.env), ...Object.keys(known.sessionEnv('alias'))]),
]);
const RESERVED_PREFIXES: readonly string[] = ['CLEARED_', 'CLAUDE_', 'ANTHROPIC_', 'CODEX_', 'OPENAI_', 'CURSOR_', 'NODE_', 'NPM_CONFIG_', 'LD_', 'GIT_', 'SSH_', 'DOCKER_', 'EGRESS_', 'FAKE_'];

// Why a name cannot be a test secret's: not a variable's name, or one the container needs as it is.
export function variableRefusal(name: string): 'name' | 'reserved' | undefined {
  if (!TEST_VARIABLE.test(name)) return 'name';
  if (RESERVED_VARIABLES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'reserved';
  return undefined;
}

// The test secrets a container is given: those whose name passes, less any
// name the container already sets, which stays the container's.
export function testVariables(given: Readonly<Record<string, string>>, own: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(given).filter(([name]) => variableRefusal(name) === undefined && !Object.hasOwn(own, name)));
}

// ------------------------------------------------------------- siblings
//
// The other services of the workspace, run beside a session on its
// internal network under their names (milestone 2 plan, decision 20): the
// ticket's trial environment. A real sibling is built in two layers, so
// that no instruction a session wrote runs during a build and no build of
// the branch reaches a network: the base layer is the service's own `run`
// Dockerfile, built from its base branch as landed (a folder the service
// exports from its own checkout, never a session's); the ticket layer is
// Cleared's Dockerfile, FROM the base layer and a COPY of the ticket
// checkout, built with no network. A ticket that changes the dependencies
// cannot be built that way, and a service with no `run` cannot run at all:
// those are the fake, built from the service's contract.

export type SiblingSpec = {
  readonly name: string;                         // the service's name: its alias on the session network
  readonly port: number;                         // where it listens
  readonly real?: {
    readonly base: string;                       // host folder of the service's base branch
    readonly dockerfile: string;                 // its run Dockerfile, relative to that folder
    readonly tag: string;                        // the base layer's tag
    readonly checkout?: string;                  // the ticket checkout of the service: the ticket layer
  };
  readonly contract?: string;                    // host path of the contract file the fake answers from
  readonly contractFormat?: ContractFormat;      // its format; none is OpenAPI 3
  readonly env?: Readonly<Record<string, string>>;
};

// What a sibling's checkout may change without leaving the base layer: not
// the dependencies (package.json's four lists) nor a lock file.
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'] as const;

// A file at the top of a folder, or undefined when there is none. The
// folder and the file must be plain, never links: the checkout is written
// by a session, and the host does not follow what it planted.
function plainFile(dir: string, name: string): string | undefined {
  const folder = lstatSync(dir, { throwIfNoEntry: false });
  if (!folder?.isDirectory()) throw new ServiceError(`${dir} is not a plain folder`);
  const path = join(dir, name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new ServiceError(`${name} is not a plain file`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}

// Each dependency list of a package.json, as JSON text; none without a file.
function dependencies(text: string | undefined, where: string): Record<string, string> {
  if (text === undefined) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ServiceError(`${where} package.json is not JSON`); }
  const object = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(DEPENDENCY_FIELDS.map((field) => [field, JSON.stringify(object[field] ?? null)]));
}

// Why the checkout cannot be built on the base layer, or undefined when it
// can: its dependencies or a lock file differ from the base's.
export function dependencyChange(base: string, checkout: string): string | undefined {
  try {
    const before = dependencies(plainFile(base, 'package.json'), 'the base\'s');
    const after = dependencies(plainFile(checkout, 'package.json'), 'the checkout\'s');
    const field = DEPENDENCY_FIELDS.find((name) => (before[name] ?? 'null') !== (after[name] ?? 'null'));
    if (field) return `the ticket changes the package.json ${field}`;
    for (const lock of LOCK_FILES)
      if (plainFile(base, lock) !== plainFile(checkout, lock)) return `the ticket changes ${lock}`;
  } catch (error) {
    if (error instanceof ServiceError) return `the dependencies cannot be compared: ${error.message}`;
    throw error;
  }
  return undefined;
}

// The ticket layer: the base layer, and the checkout copied into its
// working folder. Nothing else: no RUN, no instruction from the branch.
export function ticketLayerDockerfile(baseTag: string, workdir: string): string {
  if (!/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(baseTag)) throw new ServiceError(`not an image tag: ${JSON.stringify(baseTag)}`);
  if (!/^\/[A-Za-z0-9._/-]*$/.test(workdir)) throw new ServiceError(`the base layer's working folder must be an absolute path, not ${JSON.stringify(workdir)}`);
  return `# Generated by Cleared v2 (decision 20): the base layer and the ticket's checkout, no other instruction.\nFROM ${baseTag}\nCOPY . ${workdir.replace(/\/+$/, '')}/\n`;
}

// What planSiblings reads of a service of the workspace (workspace/config.ts).
export type SiblingSource = {
  readonly name: string;
  readonly kind: 'repository' | 'folder';
  readonly path: string | null;                  // a folder of a monorepo: run and contract are relative to it
  readonly run: { readonly dockerfile: string; readonly port: number } | null;
  readonly contract: { readonly format: ContractFormat; readonly path: string } | null;
};

export type SiblingPlan = {
  readonly services: readonly SiblingSource[];
  readonly own: string;                          // the service the session works on
  readonly ownCheckout: string;                  // its ticket checkout: the session's workdir
  readonly checkoutOf: (name: string) => string | undefined;   // another service's ticket checkout, when the ticket has one
  readonly baseOf: (name: string) => Promise<{ readonly dir: string; readonly commit: string } | undefined>;
  readonly contractPort: (file: string, format: ContractFormat) => number | undefined;
};

export const DEFAULT_FAKE_PORT = 8080;

// The siblings of a session from its workspace: every service that runs or
// has a contract, the session's own one included when it runs (the Browser
// tab shows it), each real when it runs and its fake otherwise. A service
// whose base branch cannot be read is left out.
export async function planSiblings(plan: SiblingPlan): Promise<SiblingSpec[]> {
  const siblings: SiblingSpec[] = [];
  for (const service of plan.services) {
    const own = service.name === plan.own;
    if (!service.run && (own || !service.contract)) continue;
    const base = await plan.baseOf(service.name);
    if (!base) continue;
    const root = service.path ? join(base.dir, service.path) : base.dir;
    const contract = service.contract ? join(root, service.contract.path) : undefined;
    const checkout = own ? plan.ownCheckout : plan.checkoutOf(service.name);
    const port = service.run?.port ?? (contract === undefined || !service.contract ? undefined : plan.contractPort(contract, service.contract.format)) ?? DEFAULT_FAKE_PORT;
    siblings.push({
      name: service.name, port,
      ...(contract === undefined ? {} : { contract }),
      ...(service.contract && service.contract.format !== 'openapi' ? { contractFormat: service.contract.format } : {}),
      ...(service.run ? {
        real: {
          base: root, dockerfile: service.run.dockerfile, tag: `cleared-v2-base-${service.name}:${base.commit.slice(0, 12)}`,
          ...(checkout === undefined ? {} : { checkout: service.path ? join(checkout, service.path) : checkout }),
        },
      } : {}),
    });
  }
  return siblings;
}
