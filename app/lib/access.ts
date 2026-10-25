// Who may talk to the app: the peer address (the ranges of the Tailscale
// network by default), the Host header (against DNS rebinding) and a private
// access token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

// The ranges Tailscale hands out to the machines of a network.
export const TAILSCALE = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

const bits = (address: string) => {
  if (isIP(address) === 4) return address.split('.').map((part) => Number(part).toString(2).padStart(8, '0')).join('');
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((group) => parseInt(group, 16).toString(2).padStart(16, '0')).join('');
};

// Listening on the Tailscale address is not enough: a container on the host
// reaches that address too. So every connection is checked: a peer whose
// address is outside the allowed ranges is refused, whatever it asks for.
export function allowed(peer: string | undefined, ranges: string[]) {
  // An IPv4 peer met on an IPv6 socket is written ::ffff:a.b.c.d.
  const address = (peer || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').replace(/%.*$/, '');
  if (!isIP(address)) return false;
  return ranges.some((range) => {
    const [network, length] = range.split('/');
    return isIP(network!) === isIP(address) && bits(address).startsWith(bits(network!).slice(0, Number(length)));
  });
}

const digest = (text: unknown) => createHash('sha256').update(String(text)).digest();
export const sameToken = (given: unknown, expected: unknown) => Boolean(given) && Boolean(expected)
  && timingSafeEqual(digest(given), digest(expected));

// The token lives outside the repository, in a regular file owned by this
// account, readable by nobody else. Anything looser is refused.
export function readToken(path: string, { project }: { project?: string } = {}) {
  const info = lstatSync(path);
  const real = realpathSync(path);
  const root = project ? realpathSync(project) : null;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0
    || (root && (real === root || real.startsWith(`${root}/`))))
    throw new Error('The app token must be a private regular file (mode 0600) outside the project, owned by this account');
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < 32) throw new Error('The app token is too short (32 characters at least)');
  return token;
}

// Creates the token file the first time; never overwrites one.
export function ensureToken(path: string, options?: { project?: string }) {
  try { return readToken(path, options); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeSync(fd, `${randomBytes(32).toString('hex')}\n`); fstatSync(fd); } finally { closeSync(fd); }
  return readToken(path, options);
}

// A Host the browser would use for this machine: an address, localhost, a
// Tailscale name or a name the owner listed. Anything else may be a rebinding.
export function hostAllowed(header: string | undefined, extra: string[] = []) {
  const host = String(header || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return Boolean(host) && (isIP(host) !== 0 || host === 'localhost' || host.endsWith('.ts.net') || extra.includes(host));
}

export function cookieToken(header: string | undefined) {
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'cleared_app') return rest.join('=');
  }
  return '';
}
export function bearerToken(header: string | undefined) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  return match ? match[1]! : '';
}

// The cookie never holds the token: it holds a value derived from it with a
// secret drawn at each start, so a cookie sent to another service on this
// machine cannot be used as the token, and a restart ends every session.
export const sessionSecret = () => randomBytes(32);
export const sessionValue = (token: string, secret: Buffer) => createHmac('sha256', secret).update(`cleared-app-session:${token}`).digest('hex');

// A range must be written address/length. An entry without a length would
// match every address of its family: refused rather than guessed.
export function checkRanges(ranges: string[]) {
  for (const range of ranges) {
    const [network, length, extra] = range.split('/');
    const family = isIP(network!);
    const bits = Number(length);
    if (!family || extra !== undefined || length === undefined || !/^\d{1,3}$/.test(length) || bits > (family === 4 ? 32 : 128))
      throw new Error(`[app] ranges: "${range}" must be an address and a prefix length, like 100.64.0.0/10`);
  }
  return ranges;
}
