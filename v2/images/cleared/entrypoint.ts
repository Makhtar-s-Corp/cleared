// The entrypoint of Cleared's own image (docs/v2/milestone-5-plan.md,
// section 4): `node entrypoint.ts <role> [arguments]`, the role being
// compose.yaml's command for each container.
//
//   service  the core (v2/src/main.ts), with the Docker socket's group
//   app      the web app (v2/app/main.ts)
//   broker   the release lock (serve/release-broker.ts), once a project is
//            named: until then it says so and idles
//   install  the one command (v2/src/cli/install.ts), which stays root to
//            give the state folder to the owner of the clone
//   cleared  any `cleared <command>` (v2/src/cli/cleared.ts)
//
// Every role but the install runs as the owner of the state folder, never
// as root: the container starts as root, the entrypoint takes that owner's
// uid and gid, adds the socket's group for the service and the cleared
// command, then loads the role's program in the same process. A state folder that is not there,
// that is root's (Docker made it for the mount, the install never ran) or
// that others may write stops the role with exit 78. HOME is a folder of
// the state folder: no home of the machine is mounted.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cliTranslator, languageOf } from '../../src/cli/cleared.ts';

export const ROOT = new URL('../../../', import.meta.url).pathname;
export const ROLES = {
  service: 'v2/src/main.ts',
  app: 'v2/app/main.ts',
  broker: 'serve/release-broker.ts',
  install: 'v2/src/cli/install.ts',
  cleared: 'v2/src/cli/cleared.ts',
} as const;
export type Role = keyof typeof ROLES;
const SOCKET = '/var/run/docker.sock';

export class EntryError extends Error {
  override name = 'EntryError';
}

export function roleFile(role: string, root: string = ROOT): string | undefined {
  return Object.hasOwn(ROLES, role) ? join(root, ROLES[role as Role]) : undefined;
}

type Seen = { readonly uid: number; readonly gid: number; readonly mode: number; readonly directory: boolean };
const look = (path: string): Seen => { const stats = statSync(path); return { uid: stats.uid, gid: stats.gid, mode: stats.mode, directory: stats.isDirectory() }; };

// The account every role runs as. The error's message is its catalog key.
export function stateOwner(path: string, seen: (path: string) => Seen = look): { readonly uid: number; readonly gid: number } {
  let stats: Seen;
  try { stats = seen(path); } catch { throw new EntryError('state_missing'); }
  if (!stats.directory) throw new EntryError('state_missing');
  if (stats.uid === 0) throw new EntryError('state_root');
  if ((stats.mode & 0o022) !== 0) throw new EntryError('state_open');
  return { uid: stats.uid, gid: stats.gid };
}

// The service alone talks to Docker (D10): the socket's group is its own,
// and the cleared command's, run in the service's container for `cleared
// doctor` (issue #430). Only that container mounts the socket, so the app's
// and the broker's never find one.
const DOCKER_ROLES: readonly Role[] = ['service', 'cleared'];

export function groupsOf(role: Role, owner: { readonly uid: number; readonly gid: number }, socketGid: number | undefined): number[] {
  return DOCKER_ROLES.includes(role) && socketGid !== undefined && socketGid !== owner.gid ? [owner.gid, socketGid] : [owner.gid];
}

// The checkout the broker locks: the service's, with its configuration.
export function brokerProject(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.CLEARED_V2_PROJECT_DIR?.trim() || env.CLEARED_REPO?.trim();
  return dir && existsSync(join(dir, '.cleared', 'agents.conf')) ? dir : undefined;
}

if (import.meta.main) {
  const t = cliTranslator('cleared', languageOf(process.env));
  const [role = '', ...args] = process.argv.slice(2);
  const file = roleFile(role);
  if (file === undefined) {
    process.stderr.write(`${t('entry_roles')}\n`);
    process.exit(64);
  }
  const state = process.env.CLEARED_V2_STATE_DIR?.trim() || process.env.CLEARED_STATE_DIR?.trim() || '/var/lib/cleared-v2';
  if (role === 'install') {
    const { install, HOST } = await import(file) as typeof import('../../src/cli/install.ts');
    process.exit(await install(process.env, HOST));
  }
  let owner: { readonly uid: number; readonly gid: number };
  try { owner = stateOwner(state); }
  catch (error) {
    if (!(error instanceof EntryError)) throw error;
    process.stderr.write(`${t(error.message, { path: state })}\n`);
    process.exit(78);
  }
  if (process.getuid?.() === 0) {
    const socketGid = existsSync(SOCKET) ? statSync(SOCKET).gid : undefined;
    process.setgroups?.(groupsOf(role as Role, owner, socketGid));
    process.setgid?.(owner.gid);
    process.setuid?.(owner.uid);
  } else if (process.getuid?.() !== owner.uid) {
    process.stderr.write(`${t('not_owner', { uid: String(process.getuid?.()), path: state, owner: String(owner.uid) })}\n`);
    process.exit(78);
  }
  const home = join(state, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  if (role === 'cleared') {
    process.exit(spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' }).status ?? 1);
  }
  if (role === 'broker') {
    const project = brokerProject(process.env);
    if (project === undefined) {
      process.stdout.write(`${t('broker_waiting')}\n`);
      const idle = setInterval(() => {}, 2 ** 30);
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(idle); process.exit(0); });
    } else {
      process.env.CLEARED_REPO = project;
      await import(file);
    }
  } else await import(file);
}
