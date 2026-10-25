// Sessions of the app. After the access token is accepted, the browser gets a
// random session id in a cookie (HttpOnly, SameSite=Strict, Secure whenever the
// connection is private to the browser). The id is only a key into this
// process's memory: it holds no token, and a restart ends every session.
// A session also carries the anti-forgery token every write must repeat in a
// header, and a short name for the device, which the ledger records.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = (value: unknown) => createHash('sha256').update(String(value)).digest('hex');
const digest = (text: unknown) => createHash('sha256').update(String(text)).digest();
export const COOKIE = 'cleared_app';
export type Session = { encrypted: boolean; id: string; csrf: string; createdAt: number; expires: number; device: string };

export function deviceName(userAgent: unknown = '', id: unknown = '') {
  const text = String(userAgent);
  const kind = /iPhone|iPad/.test(text) ? 'iPhone' : /Android/.test(text) ? 'Android' : /Macintosh/.test(text) ? 'Mac' : /Windows/.test(text) ? 'Windows' : /Linux|X11/.test(text) ? 'Linux' : 'Browser';
  return `${kind} · ${String(id).slice(0, 4)}`;
}

export function sessionStore({ now = () => Date.now(), ttlMs = 7 * 24 * 3600 * 1000, max = 50 } = {}) {
  const live = new Map<string, Session>();
  const sweep = () => { for (const [key, value] of live) if (value.expires <= now()) live.delete(key); };
  return {
    create(userAgent: string | undefined, { encrypted = false } = {}) {
      sweep();
      while (live.size >= max) live.delete(live.keys().next().value!);
      const id = randomBytes(32).toString('hex');
      const entry: Omit<Session, 'device'> & { device?: string } = { encrypted, id: hash(id).slice(0, 16), csrf: randomBytes(32).toString('hex'), createdAt: now(), expires: now() + ttlMs };
      entry.device = deviceName(userAgent, entry.id);
      live.set(hash(id), entry as Session);
      return { id, entry, maxAge: Math.floor(ttlMs / 1000) };
    },
    get(id: string) {
      if (!id) return null;
      const entry = live.get(hash(id));
      if (!entry) return null;
      if (entry.expires <= now()) { live.delete(hash(id)); return null; }
      return entry;
    },
    revoke(id: string) { live.delete(hash(id)); },
    size: () => live.size,
  };
}

export function cookieValue(header: string | undefined, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
export const sameSecret = (given: unknown, expected: unknown) => Boolean(given) && Boolean(expected) && timingSafeEqual(digest(given), digest(expected));

// Failed sign-ins per peer: ten a minute, then a pause.
export function attempts({ now = () => Date.now(), limit = 10, windowMs = 60000 } = {}) {
  const seen = new Map<string | undefined, number[]>();
  return {
    blocked(peer: string | undefined) { const list = (seen.get(peer) ?? []).filter((at) => at > now() - windowMs); seen.set(peer, list); return list.length >= limit; },
    fail(peer: string | undefined) { const list = (seen.get(peer) ?? []).filter((at) => at > now() - windowMs); list.push(now()); seen.set(peer, list); if (seen.size > 500) seen.delete(seen.keys().next().value!); },
  };
}
