// Connecting a workspace (docs/v2/milestone-5-plan.md, section 9, decision
// 15, matrix M10): the repositories the forge credential reaches, one or
// several picked, each cloned, read by the service map, and the proposal
// made of what guess.ts finds; then the workspace file written from what the
// person ticked, and nothing before.
//
//   <state>/repositories/<owner>/<name>   the clone of a picked repository,
//                                         a repository service's checkout
//   <state>/services/<name>/checkout      a folder service's own checkout,
//                                         cloned from the forge with the
//                                         repository's clone as a reference
//   <state>/workspace.conf                the workspace file, mode 600, named
//                                         by CLEARED_V2_WORKSPACE in the settings
//
// What the browser sends is names: of repositories on the forge's list, of
// the proposal's services and links. Every address cloned comes from the
// forge, and the proposal is made again from the clones before a write, so
// a tick the proposal does not hold is refused. The file is read back by
// parseWorkspace, as the service reads it, before it is written.
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkRepo, type Forge, type ForgeRepository } from '../forge/contract.ts';
import { baseCommit, readService } from '../map/source.ts';
import { writeSettings } from '../setup/settings.ts';
import { CheckoutError, git, projectCheckout } from './checkout.ts';
import { parseConf, parseWorkspace, WorkspaceError } from './config.ts';
import { contractOf, folderServices, proposeLinks, serviceNames, wantedFiles, type Tree } from './guess.ts';
import type { ConnectedService, ContractLine, ProposedService, WorkspaceProposal, WorkspaceWritten } from './types.ts';

export const WORKSPACE_FILE = 'workspace.conf';
// The most repositories one connect clones.
export const PICK_MAX = 10;

// A refusal, its message the code the screen says (its catalog's workspace_error_<code>).
export class ConnectError extends Error {
  override name = 'ConnectError';
}

// The keys a person may have written by hand in an earlier file, kept for a
// service of the same name; the others are the step's.
const HAND_KEYS = ['health_url', 'sensitivity', 'run', 'broker_socket', 'broker_state', 'forge'];

export async function listChoices(forge: Pick<Forge, 'listRepositories'>): Promise<{ readonly repositories: ForgeRepository[]; readonly archived: number }> {
  const all = await forge.listRepositories();
  const repositories = all.filter((r) => !r.archived).sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  return { repositories, archived: all.length - repositories.length };
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

// The picked repositories, from the forge's list only, in the order picked.
export function pick(listed: readonly ForgeRepository[], names: unknown): ForgeRepository[] {
  if (!strings(names) || names.length === 0) throw new ConnectError('invalid');
  if (names.length > PICK_MAX) throw new ConnectError('too_many');
  return [...new Set(names)].map((name) => {
    const found = listed.find((r) => r.repo === name && !r.archived);
    if (!found) throw new ConnectError('unknown_repository');
    return found;
  });
}

function wholeOf(repositories: readonly ForgeRepository[], whole: unknown): Set<string> {
  if (whole === undefined) return new Set();
  if (!strings(whole) || whole.some((name) => !repositories.some((r) => r.repo === name))) throw new ConnectError('invalid');
  return new Set(whole);
}

export function repositoryDir(stateDir: string, repo: string): string {
  checkRepo(repo);
  const [owner, name] = repo.split('/') as [string, string];
  return join(stateDir, 'repositories', owner, name);
}

// The debug switches of git that print a request's headers, Authorization
// included, which a failed git's last lines would carry into the log (the
// list of lib/forge.ts, DEBUG_VARIABLES).
const GIT_DEBUG = ['GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_TRACE_REDACT'];

// git's environment for a clone, and for the flow's fetches and pushes on an
// install with no GitHub App (forgeEnvironments, issue #421): no prompt, and
// for GitHub, gh as the credential helper (`gh auth setup-git` writes the
// same line), which reads GH_TOKEN itself; the value is never in a URL or a
// git setting, and no debug switch reaches git.
export function cloneEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return out;
  for (const name of GIT_DEBUG) delete out[name];
  let count = Number(env.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of [['credential.https://github.com.helper', ''], ['credential.https://github.com.helper', '!gh auth git-credential']]) {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

const failed = (error: unknown, what: string): never => {
  if (error instanceof ConnectError) throw error;
  if (error instanceof CheckoutError && /clone of another repository/.test(error.message)) throw new ConnectError('checkout_other');
  console.error(`cleared-v2: the workspace step could not ${what} (${error instanceof Error ? error.message : typeof error})`);
  throw new ConnectError('clone_failed');
};

async function originOf(dir: string): Promise<string> {
  return (await git(dir, ['remote', 'get-url', 'origin'])).trim();
}

// The clone of a picked repository: cloned when absent, else fetched (a
// proposal) or only checked (a write, which reads what the proposal read).
async function cloneOf(repository: ForgeRepository, stateDir: string, env: NodeJS.ProcessEnv, refresh: boolean): Promise<string> {
  const dir = repositoryDir(stateDir, repository.repo);
  try {
    if (!refresh && existsSync(dir)) {
      if ((await originOf(dir)) !== repository.url) throw new ConnectError('checkout_other');
      return dir;
    }
    await projectCheckout({ url: repository.url, dir, base: repository.base, env: cloneEnvironment(env) });
    return dir;
  } catch (error) {
    return failed(error, `clone ${repository.repo}`);
  }
}

// The paths of the base branch and the few files the guess reads, from git's objects.
async function treeOf(dir: string, base: string): Promise<Tree> {
  const commit = await baseCommit({ dir, base });
  if (commit === null) throw new ConnectError('clone_failed');
  const paths = (await git(dir, ['ls-tree', '-r', '-z', '--name-only', commit])).split('\0').filter(Boolean);
  const files: Record<string, string> = {};
  for (const path of wantedFiles(paths)) files[path] = await git(dir, ['show', `${commit}:${path}`]);
  return { paths, files };
}

type Planned = ProposedService & { readonly url: string; readonly base: string; readonly clone: string };
type Plan = { readonly proposal: Omit<WorkspaceProposal, 'machineMs'>; readonly services: readonly Planned[] };

async function plan(input: { readonly repositories: readonly ForgeRepository[]; readonly whole: unknown; readonly stateDir: string; readonly env: NodeJS.ProcessEnv; readonly refresh: boolean }): Promise<Plan> {
  const whole = wholeOf(input.repositories, input.whole);
  const read: { repository: ForgeRepository; clone: string; tree: Tree; folders: ReturnType<typeof folderServices> }[] = [];
  for (const repository of input.repositories) {
    const clone = await cloneOf(repository, input.stateDir, input.env, input.refresh);
    const tree = await treeOf(clone, repository.base).catch((error: unknown) => failed(error, `read ${repository.repo}`));
    read.push({ repository, clone, tree, folders: folderServices(tree) });
  }
  const entries = read.flatMap(({ repository, clone, tree, folders }) => (folders && !whole.has(repository.repo) ? folders.folders : [null])
    .map((path) => ({ repo: repository.repo, url: repository.url, base: repository.base, clone, path, contract: contractOf(tree, path) })));
  const names = serviceNames(entries);
  const services: Planned[] = entries.map((entry, i) => ({ ...entry, name: names[i] as string, kind: entry.path === null ? 'repository' : 'folder' }));
  const reads = await Promise.all(services.map((s) => readService({ name: s.name, base: s.base, dir: s.clone, path: s.path, contract: s.contract })))
    .catch((error: unknown) => failed(error, 'read the clones'));
  const links = proposeLinks(services.map((s) => ({ name: s.name, kind: s.kind, path: s.path, consumes: [], contract: s.contract })), reads);
  return {
    services,
    proposal: {
      repositories: read.map(({ repository, folders }) => ({
        repo: repository.repo, layout: folders && !whole.has(repository.repo) ? 'folders' : 'whole', folders: folders?.folders ?? [], from: folders?.from ?? null,
      })),
      services: services.map(({ name, repo, kind, path, contract }) => ({ name, repo, kind, path, contract })),
      links,
    },
  };
}

// Clones the picked repositories (or fetches them) and proposes services and links. Writes no setting.
export async function propose(input: { readonly repositories: readonly ForgeRepository[]; readonly whole: unknown; readonly stateDir: string; readonly env: NodeJS.ProcessEnv }): Promise<Omit<WorkspaceProposal, 'machineMs'>> {
  return (await plan({ ...input, refresh: true })).proposal;
}

// A folder service's checkout: a clone of its repository of its own, so no
// two services share one; the repository's clone lends its objects.
async function folderCheckout(service: Planned, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (existsSync(dir)) {
      if ((await originOf(dir)) !== service.url) throw new ConnectError('checkout_other');
      return;
    }
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    await git(dirname(dir), ['clone', '--quiet', '--origin', 'origin', '--no-recurse-submodules', '--reference-if-able', service.clone, '--dissociate', '--', service.url, dir], cloneEnvironment(env));
    if ((await baseCommit({ dir, base: service.base })) === null) throw new ConnectError('clone_failed');
  } catch (error) {
    failed(error, `make the checkout of ${service.name}`);
  }
}

// Written beside its name and renamed into place, mode 600.
function writeWhole(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.part`;
  rmSync(part, { force: true });
  try {
    const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, text); } finally { closeSync(fd); }
    renameSync(part, path);
  } finally {
    rmSync(part, { force: true });
  }
}

// A service as the file says it: the lines of one [service <name>] section.
export type ServiceLines = {
  readonly name: string;
  readonly kind: 'repository' | 'folder';
  readonly repo: string;
  readonly url: string;
  readonly base: string;
  readonly path: string | null;
  readonly dir: string;
  readonly consumes: readonly string[];
  readonly contract: ContractLine | null;                    // written only when ticked
  readonly hand: Readonly<Record<string, string>>;          // the keys a person wrote by hand, kept
};

// A line break or a NUL inside a value would end its line and start another
// (a section included), so every value is checked on its own, never the
// lines once joined.
const BREAK = /[\r\n\0]/;

export function renderWorkspace(input: { readonly id: string; readonly name: string; readonly services: readonly ServiceLines[] }): string {
  const value = (text: string): string => {
    if (BREAK.test(text)) throw new ConnectError('invalid');
    return text;
  };
  const lines: string[] = [
    '# The workspace, written by the setup assistant from what was ticked. A',
    '# person may add keys by hand (health_url, run, sensitivity, broker_*): a',
    '# later connect keeps them for a service of the same name.',
    '',
    '[workspace]',
    `id = ${value(input.id)}`,
    `name = ${value(input.name)}`,
  ];
  for (const service of input.services) {
    lines.push('', `[service ${value(service.name)}]`, `kind = ${service.kind}`, `repository = ${value(service.repo)}`, `url = ${value(service.url)}`, `base = ${value(service.base)}`);
    if (service.path !== null) lines.push(`path = ${value(service.path)}`);
    lines.push(`dir = ${value(service.dir)}`);
    if (service.consumes.length > 0) lines.push(`consumes = ${service.consumes.map(value).join(', ')}`);
    if (service.contract) lines.push(`contract = ${service.contract.format}:${value(service.contract.path)}`);
    for (const [key, kept] of Object.entries(service.hand)) lines.push(`${value(key)} = ${value(kept)}`);
  }
  return `${lines.join('\n')}\n`;
}

export type Ticks = { readonly services: unknown; readonly links: unknown; readonly contracts: unknown };

// Makes the proposal again from the clones, keeps what is ticked, reads the
// file back as the service would, makes the folder services' checkouts,
// then writes the file and names it in the settings. A refusal writes nothing.
export async function confirm(input: {
  readonly repositories: readonly ForgeRepository[];
  readonly whole: unknown;
  readonly ticks: Ticks;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly authorModel: string;
  readonly settings: string;
}): Promise<WorkspaceWritten> {
  const { ticks } = input;
  if (!strings(ticks.services) || !strings(ticks.links) || !strings(ticks.contracts) || ticks.services.length === 0) throw new ConnectError('invalid');
  const { services: planned, proposal } = await plan({ ...input, refresh: false });
  const kept = planned.filter((service) => (ticks.services as string[]).includes(service.name));
  if (ticks.services.some((name) => !kept.some((service) => service.name === name))) throw new ConnectError('changed');
  const keptNames = new Set(kept.map((service) => service.name));
  const links = proposal.links.filter((link) => (ticks.links as string[]).includes(link.id));
  if (ticks.links.some((id) => !links.some((link) => link.id === id)) || links.some((link) => !keptNames.has(link.from) || !keptNames.has(link.to))) throw new ConnectError('changed');
  const contracts = new Set(ticks.contracts);
  if ([...contracts].some((name) => !kept.some((service) => service.name === name && service.contract !== null))) throw new ConnectError('changed');

  const file = join(input.stateDir, WORKSPACE_FILE);
  let before: Record<string, Record<string, string>> = {};
  try { before = parseConf(readFileSync(file, 'utf8')); } catch { /* no earlier file */ }
  const id = input.env.CLEARED_V2_PROJECT || before.workspace?.id || (kept[0] as Planned).name;
  const dirOf = (service: Planned) => (service.kind === 'repository' ? service.clone : join(input.stateDir, 'services', service.name, 'checkout'));
  const text = renderWorkspace({
    id,
    name: before.workspace?.name || kept.map((service) => service.name).join(', '),
    services: kept.map((service) => ({
      name: service.name, kind: service.kind, repo: service.repo, url: service.url, base: service.base, path: service.path, dir: dirOf(service),
      consumes: links.filter((link) => link.from === service.name).map((link) => link.to),
      contract: service.contract && contracts.has(service.name) ? service.contract : null,
      hand: Object.fromEntries(HAND_KEYS.flatMap((key) => {
        const value = before[`service ${service.name}`]?.[key];
        return value === undefined ? [] : [[key, value]];
      })),
    })),
  });
  try {
    parseWorkspace(text, { file, authorModel: input.authorModel, stateDir: input.stateDir });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      if (/cycle/.test(error.message)) throw new ConnectError('cycle');
      console.error(`cleared-v2: the workspace step made a file the service would refuse (${error.message})`);
      throw new ConnectError('invalid_workspace');
    }
    throw error;
  }
  for (const service of kept) if (service.kind === 'folder') await folderCheckout(service, dirOf(service), input.env);
  writeWhole(file, text);
  writeSettings(input.settings, { env: { CLEARED_V2_WORKSPACE: file } });
  input.env.CLEARED_V2_WORKSPACE = file;
  return {
    services: kept.map(({ name, repo, path }): ConnectedService => ({ name, repo, path })),
    links: links.length,
    contracts: kept.filter((service) => service.contract && contracts.has(service.name)).length,
  };
}
