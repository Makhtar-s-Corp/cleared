// The Docker objects behind one session (milestone 1 plan, section 7), all
// labelled cleared.dev=v2 and cleared.session=<id>:
//   cleared-v2-<id>            internal network: no route to the host or out
//   cleared-v2-<id>-out        the egress container's own bridge network
//   cleared-v2-<id>-config     volume for the harness's config directory, kept
//                              after stop so that a session can resume
//   cleared-v2-<id>-svc-<a>    each declared test service, alias <a>
//   cleared-v2-<id>-sib-<s>    each sibling service of the workspace, alias <s>
//                              (milestone 2, decision 20): real, from its
//                              ticket layer cleared-v2-<id>-sib-<s>:ticket
//                              or its base layer, else Cleared's fake of it
//   cleared-v2-<id>-egress     the CONNECT proxy, alias egress, the only way out
//   cleared-v2-<id>-session    the session: the workdir and /tmp writable, the
//                              token file and the project's skills read only,
//                              limits, no capability; a reader's workdir, which
//                              holds READ_ONLY_MARK, read only too
// The egress container sits on its own labelled bridge rather than Docker's
// default one, so that nothing here touches an object without the label and
// the egress containers of two sessions never share a network.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAllowList } from '../../images/egress/proxy.ts';
import { DockerError, assertSessionId, type ContainerSpec, type Docker, type Limits } from './docker.ts';
import type { ImageChoice } from './devcontainer.ts';
import { ServiceError, dependencyChange, ticketLayerDockerfile, type ServiceSpec, type SiblingSpec } from './services.ts';

// The session image pins Claude Code's version; the tag follows it.
export const SESSION_IMAGE = 'cleared-v2-session:2.1.306';
export const EGRESS_IMAGE = 'cleared-v2-egress:1';
export const FAKE_IMAGE = 'cleared-v2-fake:1';

export const EGRESS_ALIAS = 'egress';
export const PROXY_PORT = 3128;
export const PROXY_URL = `http://${EGRESS_ALIAS}:${PROXY_PORT}`;

export const WORKDIR_MOUNT = '/workspace';
export const LOGIN_FILE_MOUNT = '/run/cleared/claude.token';
export const CONFIG_MOUNT = '/var/lib/cleared/claude-config';
export const ALLOW_MOUNT = '/etc/cleared/egress';
export const ALLOW_FILE = 'allow';
// Where Claude Code reads the skills of its configuration folder: the
// project's .claude/skills, as its base branch holds them, read only
// (milestone 2, decision 27).
export const SKILLS_MOUNT = `${CONFIG_MOUNT}/skills`;
export const FAKE_CONTRACT_MOUNT = '/etc/cleared/fake';
// A file at the root of a workdir that has the workdir mounted read only: a
// reader's (milestone 2, decision 28), which holds every named service's
// checkout at its base. The adapter gives the runtime the workdir alone, so
// the workdir carries it. A session that writes the file in its own
// checkout makes its next start read only, and nothing more.
export const READ_ONLY_MARK = '.cleared-read-only';

// What every session may reach: the model API and the npm registry. The
// project's declared hosts are added to these.
export const DEFAULT_ALLOW_HOSTS: readonly string[] = ['api.anthropic.com', 'registry.npmjs.org'];

export const DEFAULT_LIMITS: Limits = { memory: '4g', cpus: '2', pids: 1024 };
export const SERVICE_LIMITS: Limits = { memory: '1g', cpus: '1', pids: 512 };
export const EGRESS_LIMITS: Limits = { memory: '256m', cpus: '0.5', pids: 128 };
export const FAKE_LIMITS: Limits = { memory: '256m', cpus: '0.5', pids: 128 };

export function sessionNames(session: string) {
  const base = `cleared-v2-${session}`;
  return {
    network: base,
    outNetwork: `${base}-out`,
    volume: `${base}-config`,
    container: `${base}-session`,
    egress: `${base}-egress`,
    service: (alias: string) => `${base}-svc-${alias}`,
    sibling: (name: string) => `${base}-sib-${name}`,
    siblingImage: (name: string) => `${base}-sib-${name}:ticket`,
  };
}

export type SessionRuntimeSpec = {
  readonly session: string;
  // Host paths: the ticket checkout, the token file, the allow list folder.
  readonly workdir: string;
  readonly tokenFile: string;
  readonly allowDir: string;
  // Hosts the project declares, added to DEFAULT_ALLOW_HOSTS.
  readonly allowHosts: readonly string[];
  // The host's own addresses, which the proxy refuses whatever resolves to them.
  readonly hostAddresses: readonly string[];
  readonly services: readonly ServiceSpec[];
  // The other services of the workspace (and the session's own, when it
  // runs), as siblings; and the host folder of the project's skills.
  readonly siblings?: readonly SiblingSpec[];
  readonly skills?: string;
  // uid:gid the session runs as: the service's own, so the workdir stays its.
  readonly user: string;
  readonly command: readonly string[];
  readonly image?: string;
  readonly egressImage?: string;
  readonly fakeImage?: string;
  readonly limits?: Limits;
  readonly env?: Readonly<Record<string, string>>;
  // Created but not started: the adapter starts it attached (Docker.attach).
  readonly interactive?: boolean;
  readonly readyTimeoutMs?: number;
  readonly readyPollMs?: number;
};

// How a sibling runs: its ticket layer, its base layer (the ticket does not
// touch it, or its ticket layer could not be built and it has no
// contract), or its fake; and whether it answered on its port in time.
export type StartedSibling = {
  readonly name: string;
  readonly container: string;
  readonly kind: 'ticket' | 'base' | 'fake';
  readonly ready: boolean;
  readonly reason?: string;                      // why it is not its ticket layer
};

export type StartedSession = {
  readonly session: string;
  readonly container: string;
  readonly egress: string;
  readonly services: readonly string[];
  readonly siblings: readonly StartedSibling[];
  readonly started: boolean;
};

export class RuntimeError extends Error {
  override name = 'RuntimeError';
}

function allowText(hosts: readonly string[]): string {
  const lines = [...new Set([...DEFAULT_ALLOW_HOSTS, ...hosts])];
  const text = `# Written by the Cleared v2 service: the hosts this session may reach.\n${lines.join('\n')}\n`;
  parseAllowList(text);
  return text;
}

// Writes the allow list the egress proxy reads, in one rename, so the proxy
// never reads half a file. The folder, not the file, is mounted: a rename
// replaces the file's inode, which a file mount would not follow.
export function writeAllowList(dir: string, hosts: readonly string[]): string {
  const text = allowText(hosts);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = join(dir, ALLOW_FILE);
  const temporary = join(dir, `.${ALLOW_FILE}.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  chmodSync(temporary, 0o644);
  renameSync(temporary, file);
  return file;
}

function validate(spec: SessionRuntimeSpec): void {
  assertSessionId(spec.session);
  for (const [what, path] of [['workdir', spec.workdir], ['token file', spec.tokenFile], ['allow list folder', spec.allowDir]] as const) {
    if (!isAbsolute(path)) throw new RuntimeError(`${what} must be an absolute path, got ${JSON.stringify(path)}`);
  }
  const user = /^([0-9]+):([0-9]+)$/.exec(spec.user);
  if (!user || user[1] === '0' || user[2] === '0') throw new RuntimeError(`the session runs as a numeric uid:gid other than root, got ${JSON.stringify(spec.user)}`);
  allowText(spec.allowHosts);
  for (const address of spec.hostAddresses) {
    if (isIP(address) === 0) throw new RuntimeError(`not an address: ${JSON.stringify(address)}`);
  }
  const aliases = spec.services.map((service) => service.alias);
  if (new Set(aliases).size !== aliases.length) throw new RuntimeError(`a service alias is used twice: ${aliases.join(', ')}`);
  const names = new Set<string>();
  for (const sibling of spec.siblings ?? []) {
    const what = `sibling ${JSON.stringify(sibling.name)}`;
    if (!SIBLING_NAME.test(sibling.name) || RESERVED.has(sibling.name)) throw new RuntimeError(`${what}: a service name is lower-case letters, digits and dashes, and not ${[...RESERVED].join(', ')}`);
    if (aliases.includes(sibling.name) || names.has(sibling.name)) throw new RuntimeError(`${what}: the name is used twice on the session network`);
    names.add(sibling.name);
    if (!Number.isInteger(sibling.port) || sibling.port < 1 || sibling.port > 65535) throw new RuntimeError(`${what}: not a port: ${sibling.port}`);
    if (!sibling.real && sibling.contract === undefined) throw new RuntimeError(`${what}: neither a run nor a contract`);
    if (sibling.contract !== undefined && !isAbsolute(sibling.contract)) throw new RuntimeError(`${what}: the contract must be an absolute path`);
    const real = sibling.real;
    if (real) {
      if (!isAbsolute(real.base) || (real.checkout !== undefined && !isAbsolute(real.checkout))) throw new RuntimeError(`${what}: the base and the checkout must be absolute paths`);
      if (real.dockerfile === '' || isAbsolute(real.dockerfile) || real.dockerfile.split('/').some((part) => part === '..' || part === '')) throw new RuntimeError(`${what}: the Dockerfile must be inside the service`);
      if (!TAG.test(real.tag)) throw new RuntimeError(`${what}: not an image tag: ${JSON.stringify(real.tag)}`);
    }
  }
  if (spec.skills !== undefined && !isAbsolute(spec.skills)) throw new RuntimeError(`the skills folder must be an absolute path, got ${JSON.stringify(spec.skills)}`);
}

const SIBLING_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['egress', 'session', 'localhost']);
const TAG = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

// Run with `node -e <script> <host> <port>` in the egress container, which
// sits on the session network and is Cleared's own image: exit 0 when the
// sibling accepts a connection.
export const SIBLING_PROBE = `const [h,p]=process.argv.slice(1);const s=require('net').connect({host:h,port:+p,timeout:2000});
s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));`;

// The address of a running sibling on the session network, from a labelled
// inspect, or undefined when it is not running. The probe and the preview
// connect to it, never to the name: a name that no longer resolves on the
// session network would be looked up outside it, through the egress
// container's other network.
export async function siblingAddress(docker: Docker, session: string, service: string): Promise<string | undefined> {
  const names = sessionNames(session);
  type Inspected = { State?: { Running?: boolean }; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } };
  let inspected: Inspected;
  try {
    inspected = await docker.inspect(session, names.sibling(service)) as Inspected;
  } catch (error) {
    if (error instanceof DockerError) return undefined;
    throw error;
  }
  const address = inspected.NetworkSettings?.Networks?.[names.network]?.IPAddress ?? '';
  return inspected.State?.Running === true && isIP(address) === 4 ? address : undefined;
}

type SiblingImage = { readonly image: string; readonly kind: StartedSibling['kind']; readonly reason?: string; readonly built?: string };

// The image a sibling runs, building its layers (decision 20). Its ticket
// layer goes with the session: labelled with it, removed at stop. A layer
// that cannot be built falls back to the fake, else to the base layer.
async function siblingImage(docker: Docker, session: string, sibling: SiblingSpec, fakeImage: string): Promise<SiblingImage> {
  const fallback = (reason: string, base: boolean): SiblingImage => {
    if (sibling.contract !== undefined) return { image: fakeImage, kind: 'fake', reason };
    if (base && sibling.real) return { image: sibling.real.tag, kind: 'base', reason };
    throw new RuntimeError(`sibling ${sibling.name}: ${reason}, and it has no contract to fake`);
  };
  const real = sibling.real;
  if (!real) return { image: fakeImage, kind: 'fake', reason: 'the service declares no run' };
  try {
    await docker.build({ context: real.base, dockerfile: join(real.base, real.dockerfile), tag: real.tag });
  } catch (error) {
    if (error instanceof DockerError) return fallback(`the base layer could not be built: ${error.message}`, false);
    throw error;
  }
  if (real.checkout === undefined) return { image: real.tag, kind: 'base' };
  const change = dependencyChange(real.base, real.checkout);
  if (change) return fallback(change, true);
  let text: string;
  try {
    text = ticketLayerDockerfile(real.tag, (await docker.image(real.tag))?.workdir ?? '');
  } catch (error) {
    if (error instanceof ServiceError) return fallback(`the ticket layer cannot be written: ${error.message}`, true);
    throw error;
  }
  // The generated Dockerfile lives outside the checkout, which the session writes.
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-layer-'));
  const tag = sessionNames(session).siblingImage(sibling.name);
  try {
    writeFileSync(join(dir, 'Dockerfile'), text);
    await docker.build({ context: real.checkout, dockerfile: join(dir, 'Dockerfile'), tag, network: 'none', session, timeoutMs: 600_000 });
  } catch (error) {
    if (error instanceof DockerError) return fallback(`the ticket layer could not be built: ${error.message}`, true);
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { image: tag, kind: 'ticket', built: tag };
}

// Polls until ready, a stop (true from `gone`), or the deadline: false then.
async function answers(ready: () => Promise<boolean>, gone: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return true;
    if (Date.now() >= deadline || (await gone())) return false;
    await sleep(pollMs);
  }
}

async function waitFor(what: string, ready: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    const seconds = Math.round(timeoutMs / 1000);
    if (Date.now() >= deadline) throw new RuntimeError(`${what} did not become ready within ${seconds} second${seconds === 1 ? '' : 's'}`);
    await sleep(pollMs);
  }
}

// Whether the workdir holds the read-only mark: a plain file, not a link.
function readOnlyWorkdir(workdir: string): boolean {
  return lstatSync(join(workdir, READ_ONLY_MARK), { throwIfNoEntry: false })?.isFile() === true;
}

export async function startSession(docker: Docker, spec: SessionRuntimeSpec): Promise<StartedSession> {
  validate(spec);
  const { session } = spec;
  const names = sessionNames(session);
  const timeoutMs = spec.readyTimeoutMs ?? 60_000;
  const pollMs = spec.readyPollMs ?? 500;

  // A session that still has containers or networks is running, or was not
  // stopped: starting it again would collide with it, so it is refused, and
  // nothing of it is touched.
  const existing = { containers: (await docker.containers(session)).length, networks: (await docker.networks(session)).length };
  if (existing.containers + existing.networks > 0)
    throw new RuntimeError(`session ${session} already has ${existing.containers} containers and ${existing.networks} networks: stop it first`);

  // What this call creates, the only objects its cleanup removes.
  const created = { containers: [] as string[], networks: [] as string[], images: [] as string[] };
  const siblings: { readonly spec: SiblingSpec; readonly container: string; readonly image: SiblingImage }[] = [];
  const startedSiblings: StartedSibling[] = [];
  const network = async (name: string, internal: boolean): Promise<void> => {
    await docker.createNetwork({ name, session, internal });
    created.networks.push(name);
  };
  const container = async (containerSpec: ContainerSpec): Promise<void> => {
    await docker.createContainer(containerSpec);
    created.containers.push(containerSpec.name);
  };
  try {
    for (const sibling of spec.siblings ?? []) {
      const image = await siblingImage(docker, session, sibling, spec.fakeImage ?? FAKE_IMAGE);
      if (image.built) created.images.push(image.built);
      siblings.push({ spec: sibling, container: names.sibling(sibling.name), image });
    }

    await network(names.network, true);
    await network(names.outNetwork, false);
    await docker.createVolume({ name: names.volume, session });

    for (const service of spec.services) {
      await container({
        name: names.service(service.alias), session, role: 'service', image: service.image,
        networks: [{ name: names.network, aliases: [service.alias] }],
        tmpfs: service.tmpfs, env: service.env, limits: SERVICE_LIMITS,
      });
      await docker.start(session, names.service(service.alias));
    }

    // A sibling runs code the session wrote: no capability, on the session
    // network only, with the test services' variables (its database).
    const servicesEnv: Record<string, string> = Object.assign({}, ...spec.services.map((service) => service.sessionEnv));
    for (const { spec: sibling, container: name, image } of siblings) {
      // An image's VOLUME paths are tmpfs: Docker would otherwise create an
      // anonymous volume for each, without Cleared's label.
      const volumes = (await docker.image(image.image))?.volumes ?? [];
      const common = {
        name, session, networks: [{ name: names.network, aliases: [sibling.name] }], dropAllCapabilities: true, noNewPrivileges: true, tmpfs: volumes,
      };
      if (image.kind === 'fake') {
        const contract = sibling.contract as string;
        await container({
          ...common, role: 'fake', image: image.image, readOnly: true, limits: FAKE_LIMITS,
          mounts: [{ type: 'bind', source: dirname(contract), target: FAKE_CONTRACT_MOUNT, readonly: true }],
          env: {
            FAKE_CONTRACT: `${FAKE_CONTRACT_MOUNT}/${basename(contract)}`, FAKE_PORT: String(sibling.port),
            ...(sibling.contractFormat ? { FAKE_FORMAT: sibling.contractFormat } : {}),
          },
        });
      } else {
        await container({ ...common, role: 'sibling', image: image.image, limits: SERVICE_LIMITS, env: { ...servicesEnv, ...sibling.env } });
      }
      await docker.start(session, name);
    }

    writeAllowList(spec.allowDir, spec.allowHosts);
    await container({
      name: names.egress, session, role: 'egress', image: spec.egressImage ?? EGRESS_IMAGE,
      networks: [{ name: names.outNetwork }, { name: names.network, aliases: [EGRESS_ALIAS] }],
      readOnly: true, dropAllCapabilities: true, noNewPrivileges: true, limits: EGRESS_LIMITS,
      mounts: [{ type: 'bind', source: spec.allowDir, target: ALLOW_MOUNT, readonly: true }],
      env: {
        EGRESS_ALLOW_FILE: `${ALLOW_MOUNT}/${ALLOW_FILE}`,
        EGRESS_LISTEN_HOST: EGRESS_ALIAS,
        EGRESS_PORT: String(PROXY_PORT),
        EGRESS_DENY_ADDRESSES: spec.hostAddresses.join(','),
      },
    });
    await docker.start(session, names.egress);

    for (const service of spec.services) {
      await waitFor(service.alias, async () => (await docker.exec(session, names.service(service.alias), service.ready)).code === 0, timeoutMs, pollMs);
    }
    await waitFor('the egress proxy', async () => (await docker.logs(session, names.egress)).includes('"listening"'), timeoutMs, pollMs);
    // A sibling that never answers (the session broke its service) does
    // not hold the session back: it is reported, and the session can fix it.
    for (const sibling of siblings) {
      const ready = await answers(
        async () => {
          const address = await siblingAddress(docker, session, sibling.spec.name);
          return address !== undefined && (await docker.exec(session, names.egress, ['node', '-e', SIBLING_PROBE, address, String(sibling.spec.port)])).code === 0;
        },
        async () => (await siblingAddress(docker, session, sibling.spec.name)) === undefined,
        timeoutMs, pollMs,
      );
      startedSiblings.push({ name: sibling.spec.name, container: sibling.container, kind: sibling.image.kind, ready, ...(sibling.image.reason === undefined ? {} : { reason: sibling.image.reason }) });
    }

    const noProxy = ['localhost', '127.0.0.1', ...spec.services.map((service) => service.alias), ...siblings.map((sibling) => sibling.spec.name)].join(',');
    await container({
      name: names.container, session, role: 'session', image: spec.image ?? SESSION_IMAGE,
      networks: [{ name: names.network }],
      user: spec.user, readOnly: true, tmpfs: ['/tmp'], dropAllCapabilities: true, noNewPrivileges: true,
      limits: spec.limits ?? DEFAULT_LIMITS,
      mounts: [
        { type: 'bind', source: spec.workdir, target: WORKDIR_MOUNT, ...(readOnlyWorkdir(spec.workdir) ? { readonly: true } : {}) },
        { type: 'bind', source: spec.tokenFile, target: LOGIN_FILE_MOUNT, readonly: true },
        { type: 'volume', source: names.volume, target: CONFIG_MOUNT },
        ...(spec.skills === undefined ? [] : [{ type: 'bind' as const, source: spec.skills, target: SKILLS_MOUNT, readonly: true }]),
      ],
      env: {
        HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL, https_proxy: PROXY_URL, http_proxy: PROXY_URL,
        NO_PROXY: noProxy, no_proxy: noProxy,
        HOME: '/tmp',
        CLAUDE_CONFIG_DIR: CONFIG_MOUNT,
        ...servicesEnv,
        ...spec.env,
      },
      workdir: WORKDIR_MOUNT,
      interactive: spec.interactive,
      command: spec.command,
    });
    if (!spec.interactive) await docker.start(session, names.container);
  } catch (error) {
    // Leave nothing half started of what this call created; the config
    // volume stays, as after a stop. A cleanup that fails is reported with
    // the first error, and what may be left behind.
    try {
      await docker.removeSession(session, { only: created });
    } catch (cleanup) {
      const left = [...created.containers, ...created.networks, ...created.images].join(', ');
      throw new RuntimeError(`${(error as Error).message}; cleanup failed: ${(cleanup as Error).message}; possibly left behind: ${left}`, { cause: error });
    }
    throw error;
  }
  return {
    session,
    container: names.container,
    egress: names.egress,
    services: spec.services.map((service) => names.service(service.alias)),
    siblings: startedSiblings,
    started: !spec.interactive,
  };
}

// Removes the session's containers and networks. The config volume stays
// until the ticket is done (removeSessionVolume), so the harness can resume.
export function stopSession(docker: Docker, session: string): Promise<{ containers: number; networks: number; images: number }> {
  return docker.removeSession(session);
}

export function removeSessionVolume(docker: Docker, session: string): Promise<number> {
  return docker.removeVolumes(session);
}

// Builds Cleared's three images from v2/images, labelled.
export async function buildBaseImages(docker: Docker, imagesDir: string): Promise<void> {
  await docker.build({ context: join(imagesDir, 'session'), tag: SESSION_IMAGE });
  await docker.build({ context: join(imagesDir, 'egress'), tag: EGRESS_IMAGE });
  await docker.build({ context: join(imagesDir, 'fake'), tag: FAKE_IMAGE });
}

// The image a project's sessions run: Cleared's, the one its devcontainer
// file names, or the one built from its devcontainer Dockerfile, labelled.
export async function sessionImage(docker: Docker, choice: ImageChoice, project: string): Promise<string> {
  if (choice.kind !== 'dockerfile') return choice.image;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) throw new RuntimeError(`not a project name: ${JSON.stringify(project)}`);
  const tag = `cleared-v2-project-${project}:latest`;
  await docker.build({ context: choice.context, dockerfile: choice.dockerfile, tag });
  return tag;
}
