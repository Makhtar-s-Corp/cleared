// The ready section of `cleared doctor` (docs/v2/milestone-5-plan.md,
// section 7, issue #415): is this install ready for a first ticket. Read
// only: Docker is asked its version and lists filtered on cleared.dev=v2,
// nothing is built, made or started; GitHub is read; git reads the
// checkouts and fetches nothing; the ledger is opened read only, for the
// orphans line; no session, no model call. The model login
// is looked at (its kind, owner, mode and size) and never opened; the forge
// credential travels in the authorization header only, and every line is
// scrubbed of it before it leaves. Each line is passed, failed with what to
// do, a notice, or not run when what it needs failed above it.
//
// Thresholds: the address pool needs two free subnets (one session's two
// networks); the state folder's disk fails under 5 GB and is a notice under
// 20 GB (the session image alone is several gigabytes).
import { readFileSync, statSync, statfsSync, lstatSync, type Stats } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Language } from '../../app/src/catalog.ts';
import type { Translate } from '../../app/web/lib/i18n.ts';
import { decimal, lasted } from '../../app/web/lib/time.ts';
import { Docker, LabelRuleError } from '../container/docker.ts';
import { DOCKER_DEFAULT_POOLS, interfaceSubnets, poolUsage, poolsOfDaemon } from '../container/pool.ts';
import { EGRESS_IMAGE, SESSION_IMAGE } from '../container/session-runtime.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../flow/config.ts';
import { forgeKindOf } from '../forge/index.ts';
import { claudeCodeRuntime } from '../session/adapters/claude-code.ts';
import { readSettings, settingsPath, stateFolder } from '../setup/settings.ts';
import { forgeApi } from '../setup/steps/forge.ts';
import { LedgerPathError, ledgerPath } from '../store/db.ts';
import { git } from '../workspace/checkout.ts';
import type { WorkspaceConfig } from '../workspace/config.ts';
import { findOrphans, readLedgerSessions, type LedgerSession, type Orphan } from './orphans.ts';
import { doctorTranslator, type DoctorLevel, type DoctorLine } from './section.ts';

// The checks, in the order they are said; each line's id is one of these.
export const READY_CHECKS = ['docker', 'labels', 'images', 'pool', 'orphans', 'state', 'disk', 'settings', 'credentials', 'model', 'forge', 'repository', 'checkout'] as const;
export type ReadyCheck = (typeof READY_CHECKS)[number];

const GB = 1024 ** 3;
const DISK_FAIL = 5 * GB;
const DISK_LOW = 20 * GB;
const FREE_SUBNETS = 2;
const ORPHANS_SHOWN = 6;                   // names shown per orphans line; the rest are counted
const GITHUB_TIMEOUT_MS = 15_000;
const IMAGES = [SESSION_IMAGE, EGRESS_IMAGE] as const;
// A role that pushes a branch and opens a pull request.
const PUSHERS = ['admin', 'maintain', 'push'];

// What the checks reach outside themselves, given by the caller so that the
// tests give fakes.
export type ReadyProbes = {
  readonly docker: Docker;
  readonly fetch: typeof fetch;
  readonly statfs: (path: string) => { readonly bavail: number; readonly bsize: number };
  readonly interfaces: () => ReturnType<typeof networkInterfaces>;
  readonly daemonConfig: () => string | undefined;     // /etc/docker/daemon.json, when it can be read
  readonly uid?: () => number;
};

export function realProbes(): ReadyProbes {
  return {
    docker: new Docker(),
    fetch: (input, init) => fetch(input, init),
    statfs: (path) => statfsSync(path),
    interfaces: networkInterfaces,
    daemonConfig: () => { try { return readFileSync('/etc/docker/daemon.json', 'utf8'); } catch { return undefined; } },
  };
}

export const readyTranslator = (language: Language): Translate => doctorTranslator('ready', language);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);
const modeOf = (stats: Stats): string => (stats.mode & 0o777).toString(8);
const statOf = (path: string, follow = true): Stats | undefined => {
  try { return follow ? statSync(path) : lstatSync(path); } catch { return undefined; }
};

// "120 GB", "3,5 Go", "800 MB".
export function sizeOf(bytes: number, t: Translate): string {
  return bytes >= GB ? t('size_gb', { n: decimal(bytes / GB, t, 0, 1) }) : t('size_mb', { n: decimal(bytes / 1024 ** 2, t, 0, 0) });
}

export async function readyChecks(input: { readonly env: NodeJS.ProcessEnv; readonly language: Language; readonly probes?: ReadyProbes }): Promise<DoctorLine[]> {
  const { env } = input;
  const probes = input.probes ?? realProbes();
  const uid = probes.uid?.() ?? process.getuid?.() ?? 0;
  const t = readyTranslator(input.language);
  const lines: DoctorLine[] = [];
  const say = (id: ReadyCheck, level: DoctorLevel, key: string, values: Record<string, string | number> = {}, todo?: string) =>
    lines.push({ id, level, text: t(key, values), ...(todo ? { todo: t(todo, values) } : {}) });

  // Docker, then what needs it.
  let version: string | undefined;
  try {
    version = await probes.docker.version();
    say('docker', 'ok', 'docker_ok', { version });
  } catch (error) {
    say('docker', 'fail', 'docker_fail', { reason: reasonOf(error) }, 'docker_todo');
  }
  if (version === undefined) {
    for (const id of ['labels', 'images', 'pool', 'orphans'] as const) say(id, 'off', 'after_docker');
  } else {
    let filtered = false;
    try {
      say('labels', 'ok', 'labels_ok', { count: (await probes.docker.containers()).length });
      filtered = true;
    } catch (error) {
      if (error instanceof LabelRuleError) say('labels', 'fail', 'labels_fail', {}, 'labels_todo');
      else say('labels', 'fail', 'labels_error', { reason: reasonOf(error) }, 'labels_todo');
    }
    // Lists that ignore the filter would name what is not Cleared's: not run.
    if (!filtered) {
      for (const id of ['images', 'pool', 'orphans'] as const) say(id, 'off', 'after_labels');
    } else {
      try {
        const missing: string[] = [];
        for (const tag of IMAGES) if (!(await probes.docker.image(tag))) missing.push(tag);
        if (missing.length === 0) say('images', 'ok', 'images_ok', { images: IMAGES.join(', ') });
        else say('images', 'fail', 'images_fail', { images: missing.join(', ') }, 'images_todo');
      } catch (error) {
        say('images', 'fail', 'images_error', { reason: reasonOf(error) }, 'images_todo');
      }
      try {
        const daemon = probes.daemonConfig();
        const pools = (daemon === undefined ? undefined : poolsOfDaemon(daemon)) ?? [...DOCKER_DEFAULT_POOLS];
        const labelled = await probes.docker.networkSubnets();
        const { free } = poolUsage(pools, [...interfaceSubnets(probes.interfaces()), ...labelled.flatMap((network) => network.subnets)]);
        say('pool', free >= FREE_SUBNETS ? 'ok' : 'fail', free >= FREE_SUBNETS ? 'pool_ok' : 'pool_fail', { free }, free >= FREE_SUBNETS ? undefined : 'pool_todo');
      } catch (error) {
        say('pool', 'fail', 'pool_error', { reason: reasonOf(error) }, 'pool_todo');
      }
      await orphanChecks(env, probes.docker, t, say);
    }
  }

  // The state folder, its disk, the settings file and the files it names.
  let state: string | undefined;
  try { state = stateFolder(env); } catch (error) { if (!(error instanceof LedgerPathError)) throw error; }
  const folder = state === undefined ? undefined : statOf(state);
  if (state === undefined) say('state', 'fail', 'state_unset', {}, 'state_unset_todo');
  else if (!folder) say('state', 'fail', 'state_missing', { path: state }, 'state_missing_todo');
  else if (!folder.isDirectory()) say('state', 'fail', 'state_not_folder', { path: state }, 'state_missing_todo');
  else if (folder.uid !== uid) say('state', 'fail', 'state_owner', { path: state, owner: folder.uid, uid }, 'state_owner_todo');
  else if ((folder.mode & 0o022) !== 0) say('state', 'fail', 'state_open', { path: state, mode: modeOf(folder) }, 'state_open_todo');
  else if ((folder.mode & 0o055) !== 0) say('state', 'notice', 'state_readable', { path: state, mode: modeOf(folder) }, 'state_readable_todo');
  else say('state', 'ok', 'state_ok', { path: state });

  if (state === undefined || !folder?.isDirectory()) {
    say('disk', 'off', 'after_state');
    say('settings', 'off', 'after_state');
  } else {
    try {
      const disk = probes.statfs(state);
      const free = disk.bavail * disk.bsize;
      const values = { free: sizeOf(free, t) };
      if (free < DISK_FAIL) say('disk', 'fail', 'disk_fail', values, 'disk_todo');
      else if (free < DISK_LOW) say('disk', 'notice', 'disk_low', values, 'disk_todo');
      else say('disk', 'ok', 'disk_ok', values);
    } catch (error) {
      say('disk', 'fail', 'disk_error', { reason: reasonOf(error) }, 'disk_todo');
    }
    settingsChecks(state, uid, say);
  }

  // The model login: looked at, never opened.
  const login = claudeCodeRuntime(env).loginFile;
  const file = statOf(login);
  if (!file) say('model', 'fail', 'model_missing', { path: login }, 'model_todo');
  else if (!file.isFile()) say('model', 'fail', 'model_not_file', { path: login }, 'model_todo');
  else if (file.size === 0) say('model', 'fail', 'model_empty', { path: login }, 'model_todo');
  else if (file.uid !== uid) say('model', 'notice', 'model_owner', { path: login, owner: file.uid }, 'model_owner_todo');
  else if ((file.mode & 0o077) !== 0) say('model', 'notice', 'model_open', { path: login, mode: modeOf(file) }, 'model_open_todo');
  else say('model', 'ok', 'model_ok', { path: login });

  // The workspace, read as the service reads it.
  let workspace: WorkspaceConfig | undefined;
  let refused: string | undefined;
  try {
    const flow = loadFlowConfig(env);
    workspace = flow ? workspaceOf(flow) : undefined;
  } catch (error) {
    if (!(error instanceof FlowConfigError)) throw error;
    refused = reasonOf(error);
  }

  // The forge credential, and each GitHub repository of the workspace.
  const credential = (env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  let api: string | undefined;
  let accepted = false;
  if (credential === '') say('forge', 'fail', 'forge_none', {}, 'forge_none_todo');
  else {
    try { api = forgeApi(env); } catch (error) { say('forge', 'fail', 'forge_address', { reason: reasonOf(error) }, 'forge_address_todo'); }
    if (api !== undefined) {
      const answer = await githubRead(probes.fetch, `${api}/user`, credential);
      const values = { api, limit: lasted(GITHUB_TIMEOUT_MS, t), status: answer.status };
      if (answer.status === 0) say('forge', 'fail', 'forge_unreachable', values, 'forge_unreachable_todo');
      else if (answer.status === 401) say('forge', 'fail', 'forge_refused', values, 'forge_refused_todo');
      else if (answer.status === 403) say('forge', 'fail', 'forge_forbidden', values, 'forge_forbidden_todo');
      else if (answer.status < 200 || answer.status >= 300) say('forge', 'fail', 'forge_status', values, 'forge_status_todo');
      else { say('forge', 'ok', 'forge_ok'); accepted = true; }
    }
  }
  if (refused !== undefined) say('repository', 'off', 'after_workspace');
  else if (!workspace) say('repository', 'off', 'after_no_workspace');
  else if (!accepted || api === undefined) say('repository', 'off', 'after_forge');
  else {
    const repos = [...new Set(workspace.services.filter((service) => forgeKindOf(service) === 'github').map((service) => service.repo))];
    for (const repo of repos) {
      const answer = await githubRead(probes.fetch, `${api}/repos/${repo}`, credential);
      const values = { repo, api, limit: lasted(GITHUB_TIMEOUT_MS, t), status: answer.status };
      const permissions = (answer.body as { permissions?: Record<string, unknown> } | undefined)?.permissions;
      if (answer.status === 0) say('repository', 'fail', 'repository_unreachable', values, 'repository_unreachable_todo');
      else if (answer.status === 404) say('repository', 'fail', 'repository_missing', values, 'repository_missing_todo');
      else if (answer.status < 200 || answer.status >= 300) say('repository', 'fail', 'repository_refused', values, 'repository_refused_todo');
      else if (!permissions) say('repository', 'notice', 'repository_unsaid', values);
      else if (!PUSHERS.some((role) => permissions[role] === true)) say('repository', 'fail', 'repository_read_only', values, 'repository_read_only_todo');
      else say('repository', 'ok', 'repository_ok', values);
    }
  }

  // Each service's checkout, at its base.
  if (refused !== undefined) say('checkout', 'fail', 'workspace_refused', { reason: refused }, 'workspace_refused_todo');
  else if (!workspace) say('checkout', 'notice', 'workspace_none', {}, 'workspace_none_todo');
  else {
    const seen = new Set<string>();
    for (const service of workspace.services) {
      if (seen.has(service.dir)) continue;
      seen.add(service.dir);
      const values = { service: service.name, dir: service.dir, base: service.base, url: service.url };
      const found = statOf(service.dir);
      if (!found) { say('checkout', 'notice', 'checkout_absent', values); continue; }
      if (!found.isDirectory() || !statOf(join(service.dir, '.git'))) { say('checkout', 'fail', 'checkout_not_git', values, 'checkout_not_git_todo'); continue; }
      let origin: string;
      try { origin = (await git(service.dir, ['remote', 'get-url', 'origin'], env)).trim(); } catch { say('checkout', 'fail', 'checkout_not_git', values, 'checkout_not_git_todo'); continue; }
      if (origin !== service.url) { say('checkout', 'fail', 'checkout_other', values, 'checkout_other_todo'); continue; }
      try {
        await git(service.dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${service.base}^{commit}`], env);
        say('checkout', 'ok', 'checkout_ok', values);
      } catch {
        say('checkout', 'fail', 'checkout_no_base', values, 'checkout_no_base_todo');
      }
    }
  }

  // A second guard behind the first: no line holds the credential.
  if (credential === '') return lines;
  const scrub = (text: string) => text.split(credential).join('***');
  return lines.map((line) => ({ ...line, text: scrub(line.text), ...(line.todo === undefined ? {} : { todo: scrub(line.todo) }) }));
}

// The settings file, and each file it names for a variable ([env_files]):
// looked at as the settings' reader would accept it (a regular file of this
// account that no one else can read, not empty), never opened.
function settingsChecks(state: string, uid: number, say: (id: ReadyCheck, level: DoctorLevel, key: string, values?: Record<string, string | number>, todo?: string) => void): void {
  const path = settingsPath({ CLEARED_STATE_DIR: state }) ?? join(state, 'settings.conf');
  const own = statOf(path, false);
  if (!own) { say('settings', 'notice', 'settings_none', { path }, 'settings_none_todo'); return; }
  if (own.isSymbolicLink()) { say('settings', 'fail', 'settings_link', { path }, 'settings_link_todo'); return; }
  if ((own.mode & 0o077) !== 0) say('settings', 'notice', 'settings_open', { path, mode: modeOf(own) }, 'settings_open_todo');
  else say('settings', 'ok', 'settings_ok', { path });
  for (const [name, file] of Object.entries(readSettings(path).files)) {
    const stats = statOf(file, false);
    const accepted = stats !== undefined && stats.isFile() && stats.uid === uid && (stats.mode & 0o077) === 0 && stats.size > 0;
    if (accepted) say('credentials', 'ok', 'credentials_ok', { name });
    else say('credentials', 'fail', 'credentials_fail', { name, path: file }, 'credentials_todo');
  }
}

// One GET of GitHub's API: its status (0 when no answer came in time) and its body.
// The labelled networks and volumes no live session holds (src/doctor/orphans.ts),
// listed with what to do: notices only, nothing removed, the ledger read only.
async function orphanChecks(env: NodeJS.ProcessEnv, docker: Docker, t: Translate, say: (id: ReadyCheck, level: DoctorLevel, key: string, values?: Record<string, string | number>, todo?: string) => void): Promise<void> {
  let sessions: ReadonlyMap<string, LedgerSession> | undefined;
  try {
    let path: string | undefined;
    try { path = ledgerPath(env); } catch (error) { if (!(error instanceof LedgerPathError)) throw error; }
    sessions = path === undefined ? undefined : readLedgerSessions(path);
  } catch (error) {
    say('orphans', 'notice', 'orphans_ledger', { reason: reasonOf(error) }, 'orphans_ledger_todo');
    return;
  }
  let found;
  try {
    found = findOrphans({ containers: await docker.containers(), networks: await docker.networks(), volumes: await docker.volumes(), ...(sessions ? { sessions } : {}) });
  } catch (error) {
    say('orphans', 'notice', 'orphans_error', { reason: reasonOf(error) }, 'orphans_error_todo');
    return;
  }
  const listed = (orphans: readonly Orphan[]): string => {
    const names = orphans.slice(0, ORPHANS_SHOWN).map((o) => (o.ticket === undefined ? o.name : `${o.name} (${o.ticket})`)).join(', ');
    return orphans.length > ORPHANS_SHOWN ? t('orphans_more', { names, count: orphans.length - ORPHANS_SHOWN }) : names;
  };
  const groups = [['orphans_networks', found.networks], ['orphans_kept', found.kept], ['orphans_unknown', found.unknown]] as const;
  for (const [key, orphans] of groups) if (orphans.length > 0) say('orphans', 'notice', key, { count: orphans.length, names: listed(orphans) }, `${key}_todo`);
  if (groups.every(([, orphans]) => orphans.length === 0)) say('orphans', 'ok', 'orphans_ok');
}

async function githubRead(fetcher: typeof fetch, url: string, credential: string): Promise<{ readonly status: number; readonly body?: unknown }> {
  try {
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${credential}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'cleared-v2-doctor' },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    return { status: response.status, body };
  } catch {
    return { status: 0 };
  }
}
