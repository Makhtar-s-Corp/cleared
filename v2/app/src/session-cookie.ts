// The app's sign-in sessions: a random id in a cookie (HttpOnly, Secure,
// SameSite=Strict, 30 days), kept in ledger.db so that a restart signs
// nobody out. The table holds the SHA-256 of the id, never the id, and the
// session's anti-forgery token, which the page reads from /api/me and sends
// back in X-CSRF-Token on every write (docs/app.md, Access, as in v1).
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { UserId } from '../../src/session/contract.ts';

export const COOKIE_NAME = 'cleared_v2_session';
export const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const SESSION_TABLES = [
  `CREATE TABLE IF NOT EXISTS app_sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at)',
];

export type CookieSession = { readonly userId: UserId; readonly csrf: string };

const token = () => randomBytes(32).toString('base64url');
const digest = (id: string) => createHash('sha256').update(id).digest('hex');

export class CookieSessions {
  #now: () => number;
  #insert: StatementSync;
  #select: StatementSync;
  #delete: StatementSync;
  #purge: StatementSync;

  constructor(db: DatabaseSync, options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#insert = db.prepare('INSERT INTO app_sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
    this.#select = db.prepare('SELECT user_id, csrf, expires_at FROM app_sessions WHERE id_hash = ?');
    this.#delete = db.prepare('DELETE FROM app_sessions WHERE id_hash = ?');
    this.#purge = db.prepare('DELETE FROM app_sessions WHERE expires_at <= ?');
  }

  create(userId: UserId): { readonly id: string; readonly csrf: string } {
    const now = this.#now();
    this.#purge.run(now);
    const id = token();
    const csrf = token();
    this.#insert.run(digest(id), userId, csrf, new Date(now).toISOString(), now + MAX_AGE_SECONDS * 1000);
    return { id, csrf };
  }

  get(id: string | undefined): CookieSession | undefined {
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    const row = this.#select.get(digest(id)) as { user_id: string; csrf: string; expires_at: number } | undefined;
    if (!row || Number(row.expires_at) <= this.#now()) return undefined;
    return { userId: row.user_id, csrf: row.csrf };
  }

  revoke(id: string | undefined): void {
    if (id) this.#delete.run(digest(id));
  }
}

export function sessionCookie(id: string): string {
  return `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// The value of the session cookie in a Cookie header, if there is one.
export function readCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE_NAME) return part.slice(at + 1).trim();
  }
  return undefined;
}
