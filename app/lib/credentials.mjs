// The human's own accesses to the tracker, and the passkeys that confirm a
// gesture. They live in one private directory, outside the project and the
// Cleared checkout, owned by the app's service account and closed to every
// other account (mode 0700, files 0600). The agents' account must never be
// able to read them: serve/install.ts probes that, and every read below
// refuses anything looser than that.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ORCH_HOME } from '../../lib/conf.mjs';

export const defaultDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cleared', 'human');

const inside = (path, root) => path === root || path.startsWith(`${root}/`);

// A private directory owned by this account, away from anything a repository holds.
export function privateDir(dir, { project, create = false } = {}) {
  if (!isAbsolute(dir)) throw new Error('[app] human_credentials_dir must be an absolute path');
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('The human credentials directory must be a private directory (mode 0700) owned by the app account');
  const real = realpathSync(dir);
  for (const root of [project, ORCH_HOME]) if (root && inside(real, realpathSync(root))) throw new Error('The human credentials directory must be outside the project and the Cleared checkout');
  return real;
}

// A regular file, not a link, owned by this account, readable by it alone.
export function privateFile(path, { project } = {}) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error(`${path} must be a private regular file (mode 0600) owned by the app account`);
  const real = realpathSync(path);
  for (const root of [project, ORCH_HOME]) if (root && inside(real, realpathSync(root))) throw new Error(`${path} must be outside the project and the Cleared checkout`);
  return readFileSync(path, 'utf8');
}

// credentials.json: {"<adapter>": "<the human's user token>"}, only the adapter in use is needed (the local
// tracker has none: it signs with human-signing.key).
export function readCredentials(dir, { project, adapter } = {}) {
  const root = privateDir(dir, { project });
  let data;
  try { data = JSON.parse(privateFile(join(root, 'credentials.json'), { project })); }
  catch (error) {
    if (adapter !== 'local') throw new Error(`No usable human credentials in ${root}: ${error.code === 'ENOENT' ? 'credentials.json is missing' : error.message}`);
    data = {};
  }
  const token = data?.[adapter];
  if (adapter !== 'local' && (typeof token !== 'string' || token.length < 20)) throw new Error(`credentials.json has no user token for the “${adapter}” adapter`);
  return { token: typeof token === 'string' ? token : undefined, signingKey: join(root, 'human-signing.key') };
}

export function readPasskeys(dir, { project } = {}) {
  try {
    const root = privateDir(dir, { project });
    const list = JSON.parse(privateFile(join(root, 'passkeys.json'), { project }));
    return Array.isArray(list) ? list.filter((key) => typeof key.id === 'string' && typeof key.publicKey === 'string' && Number.isSafeInteger(key.signCount)) : [];
  } catch { return []; }
}
export function writePasskeys(dir, list, { project } = {}) {
  const root = privateDir(dir, { project, create: true });
  const path = join(root, 'passkeys.json');
  const part = `${path}.part`;
  const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { fstatSync(fd); writeFileSync(fd, JSON.stringify(list)); } finally { closeSync(fd); }
  chmodSync(part, 0o600);
  renameSync(part, path);
}
