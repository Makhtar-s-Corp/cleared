// Sessions of the app. After the access token is accepted, the browser gets a
// random session id in a cookie (HttpOnly, SameSite=Strict, Secure whenever the
// connection is private to the browser). The id is only a key into this
// process's memory: it holds no token, and a restart ends every session.
// A session also carries the anti-forgery token every write must repeat in a
// header, and a short name for the device, which the ledger records.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const digest = (text) => createHash('sha256').update(String(text)).digest();
export const COOKIE = 'cleared_app';

export function deviceName(userAgent = '', id = '') {
  const text = String(userAgent);
  const kind = /iPhone|iPad/.test(text) ? 'iPhone' : /Android/.test(text) ? 'Android' : /Macintosh/.test(text) ? 'Mac' : /Windows/.test(text) ? 'Windows' : /Linux|X11/.test(text) ? 'Linux' : 'Browser';
  return `${kind} · ${String(id).slice(0, 4)}`;
}

export function sessionStore({ now = () => Date.now(), ttlMs = 7 * 24 * 3600 * 1000, max = 50 } = {}) {
  const live = new Map();
  const sweep = () => { for (const [key, value] of live) if (value.expires <= now()) live.delete(key); };
  return {
    create(userAgent, { encrypted = false } = {}) {
      sweep();
      while (live.size >= max) live.delete(live.keys().next().value);
      const id = randomBytes(32).toString('hex');
      const entry = { encrypted, id: hash(id).slice(0, 16), csrf: randomBytes(32).toString('hex'), createdAt: now(), expires: now() + ttlMs };
      entry.device = deviceName(userAgent, entry.id);
      live.set(hash(id), entry);
      return { id, entry, maxAge: Math.floor(ttlMs / 1000) };
    },
    get(id) {
      if (!id) return null;
      const entry = live.get(hash(id));
      if (!entry) return null;
      if (entry.expires <= now()) { live.delete(hash(id)); return null; }
      return entry;
    },
    revoke(id) { live.delete(hash(id)); },
    size: () => live.size,
  };
}

export function cookieValue(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
export const sameSecret = (given, expected) => Boolean(given) && Boolean(expected) && timingSafeEqual(digest(given), digest(expected));

// Failed sign-ins per peer: ten a minute, then a pause.
export function attempts({ now = () => Date.now(), limit = 10, windowMs = 60000 } = {}) {
  const seen = new Map();
  return {
    blocked(peer) { const list = (seen.get(peer) ?? []).filter((at) => at > now() - windowMs); seen.set(peer, list); return list.length >= limit; },
    fail(peer) { const list = (seen.get(peer) ?? []).filter((at) => at > now() - windowMs); list.push(now()); seen.set(peer, list); if (seen.size > 500) seen.delete(seen.keys().next().value); },
  };
}
