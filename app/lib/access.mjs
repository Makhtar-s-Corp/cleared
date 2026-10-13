// Who may talk to the app: the peer address (same ranges as the old dashboard),
// the Host header (against DNS rebinding) and a private access token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

export { allowed, TAILSCALE } from '../../serve/serve-dashboard.mjs';

const digest = (text) => createHash('sha256').update(String(text)).digest();
export const sameToken = (given, expected) => Boolean(given) && Boolean(expected)
  && timingSafeEqual(digest(given), digest(expected));

// The token lives outside the repository, in a regular file owned by this
// account, readable by nobody else. Anything looser is refused.
export function readToken(path, { project } = {}) {
  const info = lstatSync(path);
  const real = realpathSync(path);
  const root = project ? realpathSync(project) : null;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
    || (root && (real === root || real.startsWith(`${root}/`))))
    throw new Error('The app token must be a private regular file (mode 0600) outside the project, owned by this account');
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < 32) throw new Error('The app token is too short (32 characters at least)');
  return token;
}

// Creates the token file the first time; never overwrites one.
export function ensureToken(path, options) {
  try { return readToken(path, options); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeSync(fd, `${randomBytes(32).toString('hex')}\n`); fstatSync(fd); } finally { closeSync(fd); }
  return readToken(path, options);
}

// A Host the browser would use for this machine: an address, localhost, a
// Tailscale name or a name the owner listed. Anything else may be a rebinding.
export function hostAllowed(header, extra = []) {
  const host = String(header || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return Boolean(host) && (isIP(host) !== 0 || host === 'localhost' || host.endsWith('.ts.net') || extra.includes(host));
}

export function cookieToken(header) {
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'cleared_app') return rest.join('=');
  }
  return '';
}
export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  return match ? match[1] : '';
}

// The cookie never holds the token: it holds a value derived from it with a
// secret drawn at each start, so a cookie sent to another service on this
// machine cannot be used as the token, and a restart ends every session.
export const sessionSecret = () => randomBytes(32);
export const sessionValue = (token, secret) => createHmac('sha256', secret).update(`cleared-app-session:${token}`).digest('hex');

// A range must be written address/length. An entry without a length would
// match every address of its family: refused rather than guessed.
export function checkRanges(ranges) {
  for (const range of ranges) {
    const [network, length, extra] = range.split('/');
    const family = isIP(network);
    const bits = Number(length);
    if (!family || extra !== undefined || length === undefined || !/^\d{1,3}$/.test(length) || bits > (family === 4 ? 32 : 128))
      throw new Error(`[app] ranges: "${range}" must be an address and a prefix length, like 100.64.0.0/10`);
  }
  return ranges;
}
