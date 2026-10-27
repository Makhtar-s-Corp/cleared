// The test secrets' key (docs/v2/milestone-5-plan.md, decision 12):
// <state>/secrets.key, 32 random bytes, mode 600, made at the first value
// and never replaced. The ledger is copied (backups, import-v1, proof runs)
// and this file is not, so a copied ledger holds values nobody can open.
//
// Each value is sealed with AES-256-GCM, a fresh 12-byte nonce at every
// write, and its service and name as associated data: a sealed value moved
// to another row of the ledger does not open.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_FILE = 'secrets.key';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export class KeyError extends Error {
  override name = 'KeyError';
}

export const keyFileOf = (stateDir: string): string => join(stateDir, KEY_FILE);

// The service's state folder, as container/prepared.ts's stateDirOf reads it
// (not imported: that file imports the session runtime, which reads the
// test values).
export const stateDirIn = (env: NodeJS.ProcessEnv): string =>
  env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');

// The key, or undefined when there is none yet. A link, a file of another
// account, one the group or others can read, or one not 32 bytes long is
// refused: nothing is sealed or opened with it.
export function readKey(file: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new KeyError(code === 'ELOOP' ? `${KEY_FILE} is a link` : `${KEY_FILE} cannot be read (${code ?? 'error'})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new KeyError(`${KEY_FILE} is not a plain file`);
    if (process.getuid && stat.uid !== process.getuid()) throw new KeyError(`${KEY_FILE} belongs to another account`);
    if ((stat.mode & 0o077) !== 0) throw new KeyError(`${KEY_FILE} can be read by others: its mode must be 600`);
    if (stat.size !== KEY_BYTES) throw new KeyError(`${KEY_FILE} is not ${KEY_BYTES} bytes`);
    const key = Buffer.alloc(KEY_BYTES);
    if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) throw new KeyError(`${KEY_FILE} could not be read whole`);
    return key;
  } finally {
    closeSync(fd);
  }
}

// The key, made when there is none: created alone (O_EXCL), so two
// processes never write two keys, and never through a link.
export function makeKey(file: string): Buffer {
  const found = readKey(file);
  if (found) return found;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Another process made it first: its key is the one.
    const theirs = code === 'EEXIST' ? readKey(file) : undefined;
    if (theirs) return theirs;
    throw new KeyError(`${KEY_FILE} cannot be made (${code ?? 'error'})`);
  }
  const key = randomBytes(KEY_BYTES);
  try {
    writeSync(fd, key);
  } finally {
    closeSync(fd);
  }
  return key;
}

export type Sealed = { readonly iv: Buffer; readonly tag: Buffer; readonly sealed: Buffer };

const associated = (service: string, name: string): Buffer => Buffer.from(`cleared-v2 test value\0${service}\0${name}`, 'utf8');

export function seal(key: Buffer, service: string, name: string, value: string): Sealed {
  const iv = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associated(service, name));
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), sealed };
}

// The value, or undefined when this key, this service and this name do not open it.
export function open(key: Buffer, service: string, name: string, row: Sealed): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, row.iv, { authTagLength: 16 });
    decipher.setAAD(associated(service, name));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.sealed), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
