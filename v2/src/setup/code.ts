// The setup code of the first start (docs/v2/milestone-5-plan.md, decision
// 5). On a ledger with no user the service makes a one-time code at start,
// keeps its SHA-256 and its end in v2_setup_code, and prints it in one line
// (SETUP_CODE_LINE), which the one command shows. The app's /setup/owner
// takes the code back: the right one, within 24 hours, while no user exists,
// creates the owner's account and spends the code in one transaction, so two
// posts at once make one owner. A restart makes a new code; the old one stops.
//
// Eight characters from 32 that a person cannot misread (no 0, O, 1 or I),
// in two groups: 40 bits, behind the app's throttle and a 24-hour life. The
// address may be reachable by another account of the machine; the code
// proves the person at the browser is the one who ran the command.
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SETUP_CODE_HOURS = 24;
export const SETUP_CODE_TABLE = `CREATE TABLE IF NOT EXISTS v2_setup_code (
  id INTEGER PRIMARY KEY CHECK (id = 1), hash TEXT NOT NULL, expires_at TEXT NOT NULL
)`;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// The line the service prints; the one command reads the code from it with SETUP_CODE_LINE.
export const SETUP_CODE_LINE = /^cleared-v2: setup code ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\b/;
export const setupCodeLine = (code: string, expiresAt: string): string =>
  `cleared-v2: setup code ${code}, valid until ${expiresAt}: open the app's address at /setup and type it to create the owner's account`;

// As a person types it: any case, spaces, with or without its dash.
export const normalizeCode = (input: string): string => input.toUpperCase().replace(/[\s-]+/g, '');

const hashOf = (normalized: string): string => createHash('sha256').update(normalized).digest('hex');

export function noUser(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() === undefined;
}

export function issueSetupCode(db: DatabaseSync, now: Date = new Date()): { code: string; expiresAt: string } {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)] as string).join('');
  const expiresAt = new Date(now.getTime() + SETUP_CODE_HOURS * 3_600_000).toISOString();
  db.prepare('INSERT INTO v2_setup_code (id, hash, expires_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at').run(hashOf(chars), expiresAt);
  return { code: `${chars.slice(0, 4)}-${chars.slice(4)}`, expiresAt };
}

export type OwnerResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: 'wrong' | 'expired' | 'taken' };

// The owner's account, from a name and a password hash already checked and
// made (users.ts), in one transaction with the code's check and its spending.
export function createOwner(db: DatabaseSync, input: { readonly code: string; readonly name: string; readonly passwordHash: string; readonly now?: Date }): OwnerResult {
  const now = input.now ?? new Date();
  db.exec('BEGIN IMMEDIATE');
  try {
    let result: OwnerResult;
    const row = db.prepare('SELECT hash, expires_at FROM v2_setup_code WHERE id = 1').get() as { hash: string; expires_at: string } | undefined;
    const given = Buffer.from(hashOf(normalizeCode(input.code)));
    if (!noUser(db)) result = { ok: false, reason: 'taken' };
    else if (!row || !timingSafeEqual(given, Buffer.from(row.hash))) result = { ok: false, reason: 'wrong' };
    else if (Date.parse(row.expires_at) <= now.getTime()) result = { ok: false, reason: 'expired' };
    else {
      const id = randomUUID();
      db.prepare('INSERT INTO users (id, name, password, created_at) VALUES (?, ?, ?, ?)').run(id, input.name, input.passwordHash, now.toISOString());
      db.prepare('DELETE FROM v2_setup_code').run();
      result = { ok: true, id };
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
