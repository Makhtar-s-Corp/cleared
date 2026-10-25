// A person's API tokens (docs/v2/milestone-5-plan.md, decision 11, C18):
// made in the app by a signed-in person, shown once, kept in the ledger as
// the SHA-256 of the value only, listed by name with the day each was made
// and last used, revocable by that person. A token acts as its person on
// the run routes (run/routes.ts) and nowhere else.
//
// A value is `clr_` and 32 random bytes in base64url: the prefix lets a
// scanner, or a person, tell what it is. It is looked up by its hash, so
// no comparison of the value itself ever runs. A revoked token keeps its
// row, with the moment it was revoked, and never finds its person again.
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UserId } from '../session/contract.ts';
import type { ApiToken, MadeApiToken } from './types.ts';

export const ACCESS_NAME_MAX = 60;
export const ACCESS_PER_PERSON = 20;
const PREFIX = 'clr_';
const VALUE = /^clr_[A-Za-z0-9_-]{43}$/;

export const ACCESS_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
)`,
];

export class AccessError extends Error {
  override name = 'AccessError';
}

export const accessHash = (value: string): string => createHash('sha256').update(value).digest('hex');

type Row = Record<string, unknown>;

const view = (row: Row): ApiToken => ({
  id: String(row.id), name: String(row.name), createdAt: String(row.created_at),
  lastUsedAt: typeof row.last_used_at === 'string' ? row.last_used_at : null,
});

export class ApiTokens {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    for (const table of ACCESS_TABLES) this.#db.exec(table);
  }

  // A name of 1 to 60 characters on one line, trimmed; 20 live tokens a person at most.
  make(user: UserId, name: string): MadeApiToken {
    const trimmed = name.trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) throw new AccessError('a token has a name of one line');
    if (trimmed.length > ACCESS_NAME_MAX) throw new AccessError(`a token's name has ${ACCESS_NAME_MAX} characters at most`);
    const live = Number((this.#db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user = ? AND revoked_at IS NULL').get(user) as Row).n);
    if (live >= ACCESS_PER_PERSON) throw new AccessError(`a person holds ${ACCESS_PER_PERSON} tokens at most: revoke one first`);
    const value = `${PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = randomBytes(6).toString('hex');
    const at = this.#now().toISOString();
    this.#db.prepare('INSERT INTO api_tokens (id, user, name, hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, user, trimmed, accessHash(value), at);
    return { token: { id, name: trimmed, createdAt: at, lastUsedAt: null }, value };
  }

  // The person's live tokens, newest first.
  list(user: UserId): ApiToken[] {
    return (this.#db.prepare('SELECT * FROM api_tokens WHERE user = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC').all(user) as Row[]).map(view);
  }

  // Revokes one of the person's own live tokens; false when there is none of that id.
  revoke(user: UserId, id: string): boolean {
    return this.#db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user = ? AND revoked_at IS NULL').run(this.#now().toISOString(), id, user).changes > 0;
  }

  // The person a value is a live token of, its last use written; undefined for anything else.
  verify(value: string): { readonly user: UserId; readonly id: string } | undefined {
    if (!VALUE.test(value)) return undefined;
    const row = this.#db.prepare('SELECT id, user FROM api_tokens WHERE hash = ? AND revoked_at IS NULL').get(accessHash(value)) as Row | undefined;
    if (!row) return undefined;
    this.#db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(this.#now().toISOString(), row.id as string);
    return { user: String(row.user) as UserId, id: String(row.id) };
  }
}
