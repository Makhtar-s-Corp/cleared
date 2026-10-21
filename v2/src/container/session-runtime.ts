// The Docker objects behind one session (milestone 1 plan, section 7), all
// labelled cleared.dev=v2 and cleared.session=<id>:
//   cleared-v2-<id>            internal network: no route to the host or out
//   cleared-v2-<id>-out        the egress container's own bridge network
//   cleared-v2-<id>-config     volume for the harness's config directory, kept
//                              after stop so that a session can resume
//   cleared-v2-<id>-svc-<a>    each declared test service, alias <a>
//   cleared-v2-<id>-egress     the CONNECT proxy, alias egress, the only way out
//   cleared-v2-<id>-session    the session: the workdir and /tmp writable, the
//                              token file read only, limits, no capability
// The egress container sits on its own labelled bridge rather than Docker's
// default one, so that nothing here touches an object without the label and
// the egress containers of two sessions never share a network.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAllowList } from '../../images/egress/proxy.ts';
import { assertSessionId, type Docker, type Limits } from './docker.ts';
import type { ImageChoice } from './devcontainer.ts';
import type { ServiceSpec } from './services.ts';

// The session image pins Claude Code's version; the tag follows it.
export const SESSION_IMAGE = 'cleared-v2-session:2.1.306';
export const EGRESS_IMAGE = 'cleared-v2-egress:1';

export const EGRESS_ALIAS = 'egress';
export const PROXY_PORT = 3128;
export const PROXY_URL = `http://${EGRESS_ALIAS}:${PROXY_PORT}`;

export const WORKDIR_MOUNT = '/workspace';
export const LOGIN_FILE_MOUNT = '/run/cleared/claude.token';
export const CONFIG_MOUNT = '/var/lib/cleared/claude-config';
export const ALLOW_MOUNT = '/etc/cleared/egress';
export const ALLOW_FILE = 'allow';

// What every session may reach: the model API and the npm registry. The
// project's declared hosts are added to these.
export const DEFAULT_ALLOW_HOSTS: readonly string[] = ['api.anthropic.com', 'registry.npmjs.org'];

export const DEFAULT_LIMITS: Limits = { memory: '4g', cpus: '2', pids: 1024 };
export const SERVICE_LIMITS: Limits = { memory: '1g', cpus: '1', pids: 512 };
export const EGRESS_LIMITS: Limits = { memory: '256m', cpus: '0.5', pids: 128 };

export function sessionNames(session: string) {
  const base = `cleared-v2-${session}`;
  return {
    network: base,
    outNetwork: `${base}-out`,
    volume: `${base}-config`,
    container: `${base}-session`,
    egress: `${base}-egress`,
    service: (alias: string) => `${base}-svc-${alias}`,
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
  // uid:gid the session runs as: the service's own, so the workdir stays its.
  readonly user: string;
  readonly command: readonly string[];
  readonly image?: string;
  readonly egressImage?: string;
  readonly limits?: Limits;
  readonly env?: Readonly<Record<string, string>>;
  // Created but not started: the adapter starts it attached (Docker.attach).
  readonly interactive?: boolean;
  readonly readyTimeoutMs?: number;
  readonly readyPollMs?: number;
};

export type StartedSession = {
  readonly session: string;
  readonly container: string;
  readonly egress: string;
  readonly services: readonly string[];
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
}

async function waitFor(what: string, ready: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) throw new RuntimeError(`${what} did not become ready within ${timeoutMs} ms`);
    await sleep(pollMs);
  }
}

export async function startSession(docker: Docker, spec: SessionRuntimeSpec): Promise<StartedSession> {
  validate(spec);
  const { session } = spec;
  const names = sessionNames(session);
  const timeoutMs = spec.readyTimeoutMs ?? 60_000;
  const pollMs = spec.readyPollMs ?? 500;
  try {
    await docker.createNetwork({ name: names.network, session, internal: true });
    await docker.createNetwork({ name: names.outNetwork, session, internal: false });
    await docker.createVolume({ name: names.volume, session });

    for (const service of spec.services) {
      await docker.createContainer({
        name: names.service(service.alias), session, role: 'service', image: service.image,
        networks: [{ name: names.network, aliases: [service.alias] }],
        tmpfs: service.tmpfs, env: service.env, limits: SERVICE_LIMITS,
      });
      await docker.start(session, names.service(service.alias));
    }

    writeAllowList(spec.allowDir, spec.allowHosts);
    await docker.createContainer({
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

    const noProxy = ['localhost', '127.0.0.1', ...spec.services.map((service) => service.alias)].join(',');
    await docker.createContainer({
      name: names.container, session, role: 'session', image: spec.image ?? SESSION_IMAGE,
      networks: [{ name: names.network }],
      user: spec.user, readOnly: true, tmpfs: ['/tmp'], dropAllCapabilities: true, noNewPrivileges: true,
      limits: spec.limits ?? DEFAULT_LIMITS,
      mounts: [
        { type: 'bind', source: spec.workdir, target: WORKDIR_MOUNT },
        { type: 'bind', source: spec.tokenFile, target: LOGIN_FILE_MOUNT, readonly: true },
        { type: 'volume', source: names.volume, target: CONFIG_MOUNT },
      ],
      env: {
        HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL, https_proxy: PROXY_URL, http_proxy: PROXY_URL,
        NO_PROXY: noProxy, no_proxy: noProxy,
        HOME: '/tmp',
        CLAUDE_CONFIG_DIR: CONFIG_MOUNT,
        ...Object.assign({}, ...spec.services.map((service) => service.sessionEnv)),
        ...spec.env,
      },
      workdir: WORKDIR_MOUNT,
      interactive: spec.interactive,
      command: spec.command,
    });
    if (!spec.interactive) await docker.start(session, names.container);
  } catch (error) {
    // Leave nothing half started; the config volume stays, as after a stop.
    await docker.removeSession(session).catch(() => undefined);
    throw error;
  }
  return {
    session,
    container: names.container,
    egress: names.egress,
    services: spec.services.map((service) => names.service(service.alias)),
    started: !spec.interactive,
  };
}

// Removes the session's containers and networks. The config volume stays
// until the ticket is done (removeSessionVolume), so the harness can resume.
export function stopSession(docker: Docker, session: string): Promise<{ containers: number; networks: number }> {
  return docker.removeSession(session);
}

export function removeSessionVolume(docker: Docker, session: string): Promise<number> {
  return docker.removeVolumes(session);
}

// Builds Cleared's two images from v2/images, labelled.
export async function buildBaseImages(docker: Docker, imagesDir: string): Promise<void> {
  await docker.build({ context: join(imagesDir, 'session'), tag: SESSION_IMAGE });
  await docker.build({ context: join(imagesDir, 'egress'), tag: EGRESS_IMAGE });
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
