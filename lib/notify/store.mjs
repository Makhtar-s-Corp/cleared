// The service's notification secrets, in one private directory ([notify]
// secrets_dir, default ~/.config/cleared/notify of the service account):
//
//   vapid.json          the Web Push key pair, generated the first time it is needed
//   subscriptions.json  the browsers that asked for notifications, from a signed-in session of the app
//   credentials.json    what the optional adapters need, keyed by adapter: ntfy, telegram, email
//
// The directory is 0700 and its files 0600, owned by the service account,
// outside the project and the Cleared checkout: the agents' account can read
// none of it (serve/install.ts probes that). Every read refuses anything
// looser, a link, or a place inside a repository. Nothing here is ever written
// to the ledger, a log or an error message.
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ORCH_HOME } from '../conf.mjs';
import { newVapidKeys, validSubscription } from './adapters/webpush.mjs';

const inside = (path, root) => path === root || path.startsWith(`${root}/`);
export const MAX_SUBSCRIPTIONS = 10;

function privateDir(dir, { project, create }) {
  if (!isAbsolute(dir)) throw new Error('[notify] secrets_dir must be an absolute path');
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('The notification secrets directory must be a private directory (mode 0700) owned by the service account');
  const real = realpathSync(dir);
  for (const root of [project, ORCH_HOME]) if (root && inside(real, realpathSync(root))) throw new Error('The notification secrets directory must be outside the project and the Cleared checkout');
  return real;
}
function privateRead(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('A notification secret must be a private regular file (mode 0600) owned by the service account');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function privateWrite(path, value, { exclusive = false } = {}) {
  if (exclusive) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { fstatSync(fd); writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
    return;
  }
  const part = `${path}.part`;
  const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { fstatSync(fd); writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
  chmodSync(part, 0o600);
  renameSync(part, path);
}

// The subscriptions are read, changed and written by two processes (the app,
// the dispatcher that drops one the push service says is gone): each change
// holds subscriptions.lock with flock, as every lock of Cleared. Node has no
// flock: flock(1) takes it on a descriptor it inherits from this process, and
// the lock, which belongs to the open file, stays held until it is closed here.
export const LOCK_WAIT_SECONDS = 5;
function withLock(dir, change) {
  const fd = openSync(join(dir, 'subscriptions.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const held = spawnSync('flock', ['-x', '-w', String(LOCK_WAIT_SECONDS), '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: (LOCK_WAIT_SECONDS + 5) * 1000 });
    if (held.status !== 0) throw new Error('The notification subscriptions are being changed by another process: try again');
    return change();
  } finally { closeSync(fd); }
}

// create: make the directory and the keys when missing (the app, when the human asks for notifications).
export function notifyStore(dir, { project, create = false, now = () => Date.now() } = {}) {
  const root = () => privateDir(dir, { project, create });
  const file = (name) => join(root(), name);
  const missing = (error) => error?.code === 'ENOENT';
  return {
    // The key pair; made once, never replaced (a new one would void every subscription).
    vapid() {
      const path = file('vapid.json');
      try { return privateRead(path); }
      catch (error) { if (!missing(error) || !create) throw error; }
      try { privateWrite(path, newVapidKeys(), { exclusive: true }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return privateRead(path);
    },
    publicKey() { return this.vapid().publicKey; },
    subscriptions() {
      try {
        const list = privateRead(file('subscriptions.json'));
        return Array.isArray(list) ? list.filter((s) => validSubscription(s, null)) : [];
      } catch { return []; }
    },
    // One per browser (its endpoint); the oldest go beyond MAX_SUBSCRIPTIONS.
    subscribe(subscription, device = '') {
      return withLock(root(), () => {
        const kept = this.subscriptions().filter((s) => s.endpoint !== subscription.endpoint);
        kept.push({ ...subscription, device: String(device).slice(0, 40), at: new Date(now()).toISOString() });
        privateWrite(file('subscriptions.json'), kept.slice(-MAX_SUBSCRIPTIONS));
        return kept.length;
      });
    },
    forget(endpoint) {
      return withLock(root(), () => {
        const all = this.subscriptions();
        const kept = all.filter((s) => s.endpoint !== endpoint);
        if (kept.length !== all.length) privateWrite(file('subscriptions.json'), kept);
        return all.length - kept.length;
      });
    },
    // What one adapter needs, or undefined.
    credentials(adapter) {
      try { return privateRead(file('credentials.json'))?.[adapter]; } catch { return undefined; }
    },
  };
}
