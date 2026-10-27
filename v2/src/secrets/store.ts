// The test secrets of each service (docs/v2/milestone-5-plan.md, section 12,
// decision 12, C16), kept in the ledger:
//   test_secrets         one row a service and a name: the value sealed
//                        (key.ts), who set it and when;
//   test_secret_changes  each set, replace and remove, with the name, who
//                        and when, never the value.
// The values the key opens are read once, at start, and kept in memory with
// every value this process saw since, replaced or removed ones included:
// the cleaner reads that list at each text it cleans (session/clean.ts),
// and a session started before a change still holds the old value. The
// key is made at the first value; reading needs none.
import type { DatabaseSync } from 'node:sqlite';
import { variableRefusal } from '../container/services.ts';
import type { UserId } from '../session/contract.ts';
import { KeyError, makeKey, open, readKey, seal } from './key.ts';
import { TEST_VALUE_MAX, TEST_VALUE_MIN, TEST_VALUES_PER_SERVICE, type TestValueKey, type TestValueRefusal } from './types.ts';

export const TEST_VALUE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS test_secrets (
  service TEXT NOT NULL, name TEXT NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, sealed BLOB NOT NULL,
  set_by TEXT NOT NULL, set_at TEXT NOT NULL,
  PRIMARY KEY (service, name)
)`,
  `CREATE TABLE IF NOT EXISTS test_secret_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, name TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('set', 'replaced', 'removed')), by TEXT NOT NULL, at TEXT NOT NULL
)`,
];

export class TestValueError extends Error {
  override name = 'TestValueError';
  readonly code: TestValueRefusal;
  constructor(code: TestValueRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

// A value as the store lists it: who set it is the person's id.
export type StoredValue = { readonly service: string; readonly name: string; readonly setAt: string; readonly setBy: UserId; readonly readable: boolean };
export type TestValueChange = { readonly service: string; readonly name: string; readonly change: 'set' | 'replaced' | 'removed'; readonly by: UserId; readonly at: string };

type Row = { service: string; name: string; iv: Uint8Array; tag: Uint8Array; sealed: Uint8Array; set_by: string; set_at: string };

// A value is one line, no control character, no space around it (a paste
// mistake), 8 to 4096 characters: the cleaner finds it whole.
function valueRefusal(value: string): TestValueError | undefined {
  if ([...value].length < TEST_VALUE_MIN) return new TestValueError('short', `a test value has ${TEST_VALUE_MIN} characters at least`);
  if (value.length > TEST_VALUE_MAX) return new TestValueError('long', `a test value has ${TEST_VALUE_MAX} characters at most`);
  if (/[\u0000-\u001f\u007f]/.test(value)) return new TestValueError('line', 'a test value is one line, with no control character');
  if (value.trim() !== value) return new TestValueError('space', 'a test value has no space at its start or its end');
  return undefined;
}

export class TestValues {
  #db: DatabaseSync;
  #keyFile: string;
  #now: () => Date;
  #key: Buffer | undefined;
  #state: TestValueKey;
  #open = new Map<string, Map<string, string>>();          // service -> name -> value, what the key opens
  #seen = new Set<string>();                                // every value this process held
  #known: readonly string[] = [];

  constructor(db: DatabaseSync, keyFile: string, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#keyFile = keyFile;
    this.#now = now;
    for (const table of TEST_VALUE_TABLES) this.#db.exec(table);
    try {
      this.#key = readKey(keyFile);
      this.#state = this.#key ? 'ready' : 'none';
    } catch (error) {
      if (!(error instanceof KeyError)) throw error;
      console.error(`cleared-v2: the test values' key is refused (${error.message}): no value is given or read`);
      this.#state = 'unusable';
    }
    for (const row of this.#rows()) {
      const value = this.#opened(row);
      if (value !== undefined) this.#hold(row.service, row.name, value);
    }
    this.#remember();
  }

  state(): TestValueKey {
    return this.#state;
  }

  // Every value by service then name, the key's or not.
  list(): StoredValue[] {
    return this.#rows().map((row) => ({ service: row.service, name: row.name, setAt: row.set_at, setBy: row.set_by as UserId, readable: this.#open.get(row.service)?.has(row.name) ?? false }));
  }

  // Sets or replaces a service's value; the key is made at the first one.
  set(service: string, name: string, value: string, by: UserId): { readonly value: StoredValue; readonly replaced: boolean } {
    const refusal = variableRefusal(name);
    if (refusal) throw new TestValueError(refusal, refusal === 'name' ? 'a test value is named in capitals, digits and _, a capital first, 64 characters at most' : `${name} is set by Cleared or the session's tools`);
    const bad = valueRefusal(value);
    if (bad) throw bad;
    const replaced = this.#db.prepare('SELECT 1 FROM test_secrets WHERE service = ? AND name = ?').get(service, name) !== undefined;
    if (!replaced && Number((this.#db.prepare('SELECT COUNT(*) AS n FROM test_secrets WHERE service = ?').get(service) as { n: number }).n) >= TEST_VALUES_PER_SERVICE)
      throw new TestValueError('count', `a service holds ${TEST_VALUES_PER_SERVICE} test values at most: remove one first`);
    const key = this.#keyForWrite();
    const sealed = seal(key, service, name, value);
    const at = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`INSERT INTO test_secrets (service, name, iv, tag, sealed, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (service, name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, sealed = excluded.sealed, set_by = excluded.set_by, set_at = excluded.set_at`)
        .run(service, name, sealed.iv, sealed.tag, sealed.sealed, by, at);
      this.#change(service, name, replaced ? 'replaced' : 'set', by, at);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#hold(service, name, value);
    this.#remember();
    return { value: { service, name, setAt: at, setBy: by, readable: true }, replaced };
  }

  // Removes a service's value; false when it has none of that name.
  remove(service: string, name: string, by: UserId): boolean {
    const at = this.#now().toISOString();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const gone = this.#db.prepare('DELETE FROM test_secrets WHERE service = ? AND name = ?').run(service, name).changes > 0;
      if (gone) this.#change(service, name, 'removed', by, at);
      this.#db.exec('COMMIT');
      if (gone) this.#open.get(service)?.delete(name);
      return gone;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // The values a session of this service is given, by name.
  variables(service: string): Record<string, string> {
    return Object.fromEntries(this.#open.get(service) ?? []);
  }

  // Every value this process held, for the cleaner: the same array until a change.
  known(): readonly string[] {
    return this.#known;
  }

  changes(): TestValueChange[] {
    return (this.#db.prepare('SELECT service, name, change, by, at FROM test_secret_changes ORDER BY id').all() as TestValueChange[]).map((row) => ({ ...row }));
  }

  #rows(): Row[] {
    return this.#db.prepare('SELECT * FROM test_secrets ORDER BY service, name').all() as Row[];
  }

  #opened(row: Row): string | undefined {
    return this.#key ? open(this.#key, row.service, row.name, { iv: Buffer.from(row.iv), tag: Buffer.from(row.tag), sealed: Buffer.from(row.sealed) }) : undefined;
  }

  #keyForWrite(): Buffer {
    if (this.#state === 'unusable') throw new TestValueError('key', 'the test values\' key file is refused: see the service\'s log');
    if (!this.#key) {
      try {
        this.#key = makeKey(this.#keyFile);
      } catch (error) {
        if (!(error instanceof KeyError)) throw error;
        console.error(`cleared-v2: the test values' key could not be made (${error.message})`);
        throw new TestValueError('key', 'the test values\' key could not be made: see the service\'s log');
      }
      this.#state = 'ready';
    }
    return this.#key;
  }

  #change(service: string, name: string, change: TestValueChange['change'], by: UserId, at: string): void {
    this.#db.prepare('INSERT INTO test_secret_changes (service, name, change, by, at) VALUES (?, ?, ?, ?, ?)').run(service, name, change, by, at);
  }

  #hold(service: string, name: string, value: string): void {
    const names = this.#open.get(service) ?? new Map<string, string>();
    names.set(name, value);
    this.#open.set(service, names);
    this.#seen.add(value);
  }

  #remember(): void {
    if (this.#seen.size !== this.#known.length) this.#known = [...this.#seen];
  }
}
