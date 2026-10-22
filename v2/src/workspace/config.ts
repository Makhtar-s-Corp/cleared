// The workspace the service runs: one or several services, each a
// repository or a folder of a monorepo (docs/v2/milestone-2-plan.md,
// decision 18). A one-service workspace needs no file: it is built from the
// milestone 1 variables (CLEARED_V2_PROJECT, _PROJECT_DIR, _REPO, _REPO_URL,
// _BASE), with the old project value as its id, so every existing row, whose
// `project` holds that value, stays in it. A workspace of several services
// is one file, named by CLEARED_V2_WORKSPACE, in the format of agents.conf:
//
//   [workspace]
//   id = guestbook                       the `project` value of its rows
//   name = Guestbook and its filter
//
//   [service filter-api]
//   kind = repository                    or folder (a folder of a monorepo: path names it)
//   repository = owner/name
//   url = https://...                    what a checkout clones
//   base = main
//   path = filter-api                    folder only, relative to the repository
//   dir = /srv/filter-api                the service's checkout on this server
//   health_url = http://127.0.0.1:.../health
//   sensitivity = normal                 full, reviewer:<model>, human:<user>
//   consumes = other-service, ...
//   run = Dockerfile:3000                the Dockerfile that runs it, and its port
//   contract = openapi:contract/openapi.yaml
//   broker_socket = /...                 its release broker (decision 21)
//   broker_state = /...
//
// Each service repository keeps its own .cleared/agents.conf, read at its
// base branch, as before.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Service, Workspace } from '../api/types.ts';

export class WorkspaceError extends Error {
  override name = 'WorkspaceError';
}

// What the service knows of a service besides what the API shows: where its
// checkout is on this server, and its release broker. None of these paths
// leaves the service (publicWorkspace).
export type ServiceConfig = Service & {
  readonly dir: string;
  readonly brokerSocket: string | null;          // null: the milestone 1 socket
  readonly brokerState: string | null;           // null: the milestone 1 state folder
};

export type WorkspaceConfig = {
  readonly id: string;
  readonly name: string;
  readonly services: readonly ServiceConfig[];   // in the file's order; the first is the one milestone 1's fields name
  readonly file: string | null;                  // CLEARED_V2_WORKSPACE, or null for the one-service workspace
};

export type Sections = Record<string, Record<string, string>>;

// The format of agents.conf: [section] headers, key = value lines, # or ;
// at the start of a line for a comment. A value keeps what follows it, a
// trailing # included, as v1 reads it.
export function parseConf(text: string): Sections {
  const sections: Sections = {};
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1] as string;
      sections[current] ??= {};
      continue;
    }
    const at = line.indexOf('=');
    if (at < 0 || !current) continue;
    (sections[current] as Record<string, string>)[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return sections;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// A service name is a path segment (<workdirs>/<ticket>/<service>) and a
// container's name on the session's network.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const SERVICE_KEYS = new Set(['kind', 'repository', 'url', 'base', 'path', 'dir', 'health_url', 'sensitivity', 'consumes', 'run', 'contract', 'broker_socket', 'broker_state']);

// A path inside the repository: relative, and never above it.
function inside(value: string): boolean {
  return value !== '' && !isAbsolute(value) && !value.split('/').some((part) => part === '..' || part === '');
}

export type WorkspaceOptions = {
  readonly authorModel: string;                  // a reviewer:<model> sensitivity must name another model
  readonly stateDir: string;                     // where a service's checkout is when its dir is not given
};

function sensitivityOf(value: string | undefined, where: string, options: WorkspaceOptions): Service['sensitivity'] {
  const text = value ?? 'normal';
  if (text === 'normal' || text === 'full') return text;
  const [kind, ...rest] = text.split(':');
  const who = rest.join(':').trim();
  if (kind === 'human') {
    if (!who) throw new WorkspaceError(`${where} sensitivity human: names no user`);
    if (!/^[A-Za-z0-9_.@-]+$/.test(who)) throw new WorkspaceError(`${where} sensitivity human:${who} is not a user name`);
    return `human:${who}`;
  }
  if (kind === 'reviewer') {
    if (!who) throw new WorkspaceError(`${where} sensitivity reviewer: names no model`);
    if (who === options.authorModel) throw new WorkspaceError(`${where} sensitivity reviewer:${who} names the author model: the reviewer is always another model`);
    return `reviewer:${who}`;
  }
  throw new WorkspaceError(`${where} sensitivity is normal, full, reviewer:<model> or human:<user>, not "${text}"`);
}

function serviceOf(name: string, keys: Record<string, string>, options: WorkspaceOptions): ServiceConfig {
  const where = `[service ${name}]`;
  if (!NAME.test(name)) throw new WorkspaceError(`${where}: a service name is lower-case letters, digits and dashes, at most 40`);
  for (const key of Object.keys(keys)) if (!SERVICE_KEYS.has(key)) throw new WorkspaceError(`${where} has an unknown key ${key}`);
  const kind = keys.kind ?? 'repository';
  if (kind !== 'repository' && kind !== 'folder') throw new WorkspaceError(`${where} kind is repository or folder, not "${kind}"`);
  const repo = keys.repository ?? '';
  if (!REPO.test(repo)) throw new WorkspaceError(`${where} repository must be owner/name`);
  const url = keys.url ?? '';
  if (!url) throw new WorkspaceError(`${where} names no url`);
  const base = keys.base || 'main';
  if (!BRANCH.test(base) || base.includes('..')) throw new WorkspaceError(`${where} base is not a branch name: "${base}"`);
  let path: string | null = null;
  if (kind === 'folder') {
    if (keys.path === undefined) throw new WorkspaceError(`${where} is a folder and names no path`);
    if (!inside(keys.path)) throw new WorkspaceError(`${where} path must be a folder inside the repository, not "${keys.path}"`);
    path = keys.path;
  } else if (keys.path !== undefined) {
    throw new WorkspaceError(`${where} path is for a folder of a monorepo (kind = folder)`);
  }
  const dir = keys.dir ?? join(options.stateDir, 'services', name, 'checkout');
  if (!isAbsolute(dir)) throw new WorkspaceError(`${where} dir must be an absolute path`);
  let healthUrl: string | null = null;
  if (keys.health_url !== undefined) {
    let parsed: URL | undefined;
    try { parsed = new URL(keys.health_url); } catch { parsed = undefined; }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) throw new WorkspaceError(`${where} health_url must be an http or https address`);
    healthUrl = keys.health_url;
  }
  let run: Service['run'] = null;
  if (keys.run !== undefined) {
    const match = /^(\S+?)(?::|\s+)(\d{1,5})$/.exec(keys.run);
    const port = Number(match?.[2]);
    if (!match || !inside(match[1] as string) || port < 1 || port > 65535) throw new WorkspaceError(`${where} run is the Dockerfile's path and its port (Dockerfile:3000), not "${keys.run}"`);
    run = { dockerfile: match[1] as string, port };
  }
  let contract: Service['contract'] = null;
  if (keys.contract !== undefined) {
    const match = /^openapi:(.+)$/.exec(keys.contract);
    if (!match) throw new WorkspaceError(`${where} contract: milestone 2 reads OpenAPI 3 only (openapi:<path>), not "${keys.contract}"`);
    if (!inside(match[1] as string)) throw new WorkspaceError(`${where} contract path must be inside the repository`);
    contract = { format: 'openapi', path: match[1] as string };
  }
  const absolute = (key: 'broker_socket' | 'broker_state'): string | null => {
    const value = keys[key];
    if (value === undefined) return null;
    if (!isAbsolute(value)) throw new WorkspaceError(`${where} ${key} must be an absolute path`);
    return value;
  };
  const consumes = [...new Set((keys.consumes ?? '').split(',').map((word) => word.trim()).filter(Boolean))];
  if (consumes.includes(name)) throw new WorkspaceError(`${where}: ${name} consumes itself`);
  return {
    name, kind, repo, url, base, path, dir, healthUrl, sensitivity: sensitivityOf(keys.sensitivity, where, options), consumes, run, contract,
    brokerSocket: absolute('broker_socket'), brokerState: absolute('broker_state'),
  };
}

// The landing order (decision 21) needs providers before consumers: a
// consumes line names a service of the workspace, and no service consumes
// itself through others.
function checkConsumes(services: readonly ServiceConfig[]): void {
  const byName = new Map(services.map((service) => [service.name, service]));
  for (const service of services)
    for (const other of service.consumes)
      if (!byName.has(other)) throw new WorkspaceError(`[service ${service.name}] consumes ${other}, which is not a service of this workspace`);
  const done = new Set<string>();
  const visit = (name: string, path: readonly string[]): void => {
    if (path.includes(name)) throw new WorkspaceError(`the services consume each other in a cycle: ${[...path, name].join(' -> ')}`);
    if (done.has(name)) return;
    for (const other of byName.get(name)?.consumes ?? []) visit(other, [...path, name]);
    done.add(name);
  };
  for (const service of services) visit(service.name, []);
}

export function parseWorkspace(text: string, options: WorkspaceOptions & { readonly file: string }): WorkspaceConfig {
  const sections = parseConf(text);
  const head = sections.workspace;
  if (!head?.id) throw new WorkspaceError('the workspace file has no [workspace] id');
  if (!ID.test(head.id)) throw new WorkspaceError(`[workspace] id is letters, digits, dots, dashes and underscores, not "${head.id}"`);
  const services: ServiceConfig[] = [];
  for (const [section, keys] of Object.entries(sections)) {
    if (section === 'workspace') continue;
    const match = /^service\s+(\S+)$/.exec(section);
    if (!match) throw new WorkspaceError(`the workspace file has an unknown section [${section}]`);
    services.push(serviceOf(match[1] as string, keys, options));
  }
  if (services.length === 0) throw new WorkspaceError('the workspace file has no [service <name>] section');
  checkConsumes(services);
  return { id: head.id, name: head.name || head.id, services, file: options.file };
}

// The workspace of the environment, or undefined when the service is not set
// up to run tickets (neither CLEARED_V2_WORKSPACE nor CLEARED_V2_PROJECT).
export function loadWorkspace(env: NodeJS.ProcessEnv, options: WorkspaceOptions): WorkspaceConfig | undefined {
  const file = env.CLEARED_V2_WORKSPACE;
  const project = env.CLEARED_V2_PROJECT;
  if (file) {
    if (!isAbsolute(file)) throw new WorkspaceError('CLEARED_V2_WORKSPACE must be an absolute path');
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch (error) { throw new WorkspaceError(`cannot read the workspace file CLEARED_V2_WORKSPACE names (${(error as NodeJS.ErrnoException).code ?? 'error'})`); }
    const workspace = parseWorkspace(text, { ...options, file });
    if (project && project !== workspace.id) throw new WorkspaceError(`CLEARED_V2_PROJECT names ${project}, and the workspace file's id is ${workspace.id}: unset one, or make them the same`);
    return workspace;
  }
  if (!project) return undefined;
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new WorkspaceError(`${name} is not set, and CLEARED_V2_PROJECT names a project`);
    return value;
  };
  const dir = need('CLEARED_V2_PROJECT_DIR');
  if (!isAbsolute(dir)) throw new WorkspaceError('CLEARED_V2_PROJECT_DIR must be an absolute path');
  const repo = need('CLEARED_V2_REPO');
  if (!REPO.test(repo)) throw new WorkspaceError('CLEARED_V2_REPO must be owner/name');
  const url = need('CLEARED_V2_REPO_URL');
  const service: ServiceConfig = {
    name: project, kind: 'repository', repo, url, base: env.CLEARED_V2_BASE || 'main', path: null, dir,
    healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null,
  };
  return { id: project, name: project, services: [service], file: null };
}

// What GET /api/workspace answers: the services without the server's paths.
export function publicWorkspace(workspace: WorkspaceConfig): Workspace {
  return {
    id: workspace.id,
    name: workspace.name,
    services: workspace.services.map(({ dir: _dir, brokerSocket: _socket, brokerState: _state, ...service }) => service),
  };
}
