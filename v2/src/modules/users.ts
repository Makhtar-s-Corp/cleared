// The users module (lane 6): the people who sign in to the app, in the
// users table of ledger.db, so that approvals and messages reference them
// by id. Passwords are kept as Argon2id hashes made with node:crypto. The
// app (v2/app) reads this table to sign people in; the service reads it
// through the users slot. `cleared-v2 user add <name>` (src/cli/user.ts)
// adds one.
//
// It also holds the proof the app shows the service on every forwarded
// request (SERVICE_PROOF_HEADER in api/types.ts): a random secret in a file
// beside the ledger, mode 0600, which both processes read under the same
// account and no session container mounts (plan, section 7).
import { argon2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { UserId } from '../session/contract.ts';
import type { Module, User, UserDirectory } from './registry.ts';

export const USERS_TABLE = `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at TEXT NOT NULL
)`;

export type PasswordParams = {
  readonly algorithm: 'argon2id';
  readonly memory: number;                   // KiB
  readonly passes: number;
  readonly parallelism: number;
  readonly saltLength: number;               // bytes
  readonly tagLength: number;                // bytes
};

// RFC 9106, section 4, the second recommended option: "Argon2id with t=3
// iterations, p=4 lanes, m=2^(16) (64 MiB of RAM), 128-bit salt, and
// 256-bit tag size". The first option needs 2 GiB per sign-in.
export const PASSWORD_DEFAULTS: PasswordParams = { algorithm: 'argon2id', memory: 65536, passes: 3, parallelism: 4, saltLength: 16, tagLength: 32 };

export class UserError extends Error {
  override name = 'UserError';
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, params: Omit<PasswordParams, 'saltLength'>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(params.algorithm, { message: password, nonce: salt, memory: params.memory, passes: params.passes, parallelism: params.parallelism, tagLength: params.tagLength },
      (error, key) => (error ? reject(error) : resolve(key)));
  });
}

// The PHC string format, as the Argon2 reference implementation writes it:
// $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>, base64 without padding.
export async function hashPassword(password: string, params: PasswordParams = PASSWORD_DEFAULTS): Promise<string> {
  const salt = randomBytes(params.saltLength);
  const hash = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,8}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{22,})$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = PHC.exec(stored);
  if (!match) return false;
  const [, memory, passes, parallelism, salt, hash] = match as unknown as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  try {
    const actual = await derive(password, Buffer.from(salt, 'base64'), { algorithm: 'argon2id', memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism), tagLength: expected.length });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// NIST SP 800-63B-4, "Password Verifiers": a password used as a single factor
// SHALL be at least 15 characters, and verifiers SHOULD permit at least 64.
// The maximum is the sign-in form's maxlength, so any password that can be
// set can also be typed there. Characters are counted, not bytes.
export const PASSWORD_LENGTH = { min: 15, max: 1024 } as const;

// A name typed at the sign-in page and shown in the header: letters,
// digits, dot, dash and underscore, 1 to 32 characters. The setup
// assistant's owner step checks it too (app/src/setup.ts).
export const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const NAME = USER_NAME;

type Row = Record<string, unknown>;
const user = (row: Row): User => ({ id: String(row.id), name: String(row.name) });

export class SqliteUsers implements UserDirectory {
  #params: PasswordParams;
  #now: () => Date;
  #insert: StatementSync;
  #byName: StatementSync;
  #byId: StatementSync;
  #all: StatementSync;
  #dummy: Promise<string> | undefined;

  constructor(db: DatabaseSync, options: { readonly params?: PasswordParams; readonly now?: () => Date } = {}) {
    this.#params = options.params ?? PASSWORD_DEFAULTS;
    this.#now = options.now ?? (() => new Date());
    this.#insert = db.prepare('INSERT INTO users (id, name, password, created_at) VALUES (?, ?, ?, ?)');
    this.#byName = db.prepare('SELECT id, name, password FROM users WHERE name = ?');
    this.#byId = db.prepare('SELECT id, name FROM users WHERE id = ?');
    this.#all = db.prepare('SELECT id, name FROM users ORDER BY created_at, name');
  }

  async add(name: string, password: string): Promise<User> {
    if (!NAME.test(name)) throw new UserError('a user name is 1 to 32 letters, digits, dots, dashes or underscores, starting with a letter or a digit');
    if (password === '') throw new UserError('the password is empty');
    const length = [...password].length;
    if (length < PASSWORD_LENGTH.min) throw new UserError(`a password is at least ${PASSWORD_LENGTH.min} characters`);
    if (length > PASSWORD_LENGTH.max) throw new UserError(`a password is at most ${PASSWORD_LENGTH.max} characters`);
    if (this.#byName.get(name)) throw new UserError(`a user named ${name} already exists`);
    const hash = await hashPassword(password, this.#params);
    const id: UserId = randomUUID();
    try {
      this.#insert.run(id, name, hash, this.#now().toISOString());
    } catch (error) {
      if (this.#byName.get(name)) throw new UserError(`a user named ${name} already exists`);
      throw error;
    }
    return { id, name };
  }

  // The user, when the name exists and the password is theirs. An unknown
  // name costs a hash too, so the time taken does not tell which names exist.
  async verify(name: string, password: string): Promise<User | undefined> {
    const row = NAME.test(name) ? this.#byName.get(name) as Row | undefined : undefined;
    if (!row) {
      this.#dummy ??= hashPassword('no user has this password', this.#params);
      await verifyPassword(password, await this.#dummy);
      return undefined;
    }
    return (await verifyPassword(password, String(row.password))) ? user(row) : undefined;
  }

  async get(id: UserId): Promise<User | undefined> {
    const row = this.#byId.get(id) as Row | undefined;
    return row ? user(row) : undefined;
  }

  async list(): Promise<User[]> {
    return (this.#all.all() as Row[]).map(user);
  }
}

// The app's proof, beside ledger.db. Whichever process starts first makes
// it: written whole in a file of its own, then linked to its name, which
// fails if another process got there first, so two starting at once agree
// and neither ever reads it empty or half written (issue #429). A file
// another account owns, a file others can read, or one that is not 64 hex
// characters is refused and left as it is.
export const PROOF_FILE = 'v2-app-proof';

// Why a proof cannot serve (issue #491), as the app tells the browser, which
// is not told the path: `starting` is a file another process has not filled
// yet, and passes by itself; the others stay until a person acts.
export type ProofReason = 'starting' | 'unmade' | 'unreadable' | 'foreign' | 'exposed' | 'malformed';
const STARTING_MS = 60_000;

export class ProofError extends Error {
  override name = 'ProofError';
  readonly reason: ProofReason;
  constructor(message: string, reason: ProofReason = 'starting') {
    super(message);
    this.reason = reason;
  }
}

export function proofPath(ledger: string): string {
  return join(dirname(ledger), PROOF_FILE);
}

// `what` names the file in a refusal: the app's proof, or the lanes' MCP token (mcp/http.ts), made the same way.
export function readOrCreateProof(path: string, what = 'the app\'s proof'): string {
  let fd: number;
  if (!existsSync(path)) {
    const draft = `${path}.${randomBytes(6).toString('hex')}.new`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      fd = openSync(draft, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, `${randomBytes(32).toString('hex')}\n`); }
      finally { closeSync(fd); }
      linkSync(draft, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ProofError(`cannot make ${what} at ${path}: ${(error as Error).message}`, 'unmade');
    } finally {
      rmSync(draft, { force: true });
    }
  }
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new ProofError(`cannot read ${what} at ${path}: ${(error as Error).message}`, 'unreadable');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ProofError(`${what} at ${path} is not a regular file`, 'unreadable');
    if (stat.uid !== process.getuid?.()) throw new ProofError(`${what} at ${path} belongs to another account`, 'foreign');
    if ((stat.mode & 0o077) !== 0) throw new ProofError(`${what} at ${path} can be read by others: chmod 600 it`, 'exposed');
    const proof = readFileSync(fd, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(proof)) throw new ProofError(`${what} at ${path} is not 64 hex characters`, proof === '' && Date.now() - stat.mtimeMs < STARTING_MS ? 'starting' : 'malformed');
    return proof;
  } finally {
    closeSync(fd);
  }
}

// The app's proof as its requests read it (issue #429): read when first
// needed and kept once whole; until then each call reads the file again,
// so an app that started before the service made it needs no restart.
// `forget` drops what was kept, for when the service refuses it.
export type ProofReader = (() => string) & { forget(): void };

export function proofReader(path: string, what?: string): ProofReader {
  let kept: string | undefined;
  return Object.assign(() => (kept ??= readOrCreateProof(path, what)), { forget: () => { kept = undefined; } });
}

// What the service's routes call on SERVICE_PROOF_HEADER (lanes 7 and 8),
// and the app on its anti-forgery token: a constant-time comparison.
export function sameProof(given: unknown, proof: string): boolean {
  if (typeof given !== 'string' || proof === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
}

const users: Module = {
  tables: [USERS_TABLE],
  routes: [],
  provide: ({ store }) => ({ users: new SqliteUsers(store.db) }),
};

export default users;
