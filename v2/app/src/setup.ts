// The app's part of the first start (docs/v2/milestone-5-plan.md, decision
// 5, lane v2-j5-assistant): before anyone is signed in, POST /setup/owner
// takes the setup code the service printed, a name and a password, and makes
// the owner's account (setup/code.ts, one transaction with the code's
// spending), then the approval key as `npm run setup` makes it
// (setup/approval-key.ts), and names the owner in the settings
// (CLEARED_V2_OWNER_ID). The server signs the new owner in. Everything after
// that is a signed-in page and the service's setup routes.
//
// Only app/main.ts turns this on (AppOptions.setup): an app made by a test
// with no user still sends to /login.
import { userInfo } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { hashPassword, PASSWORD_DEFAULTS, PASSWORD_LENGTH, USER_NAME, type PasswordParams } from '../../src/modules/users.ts';
import { ApprovalKeyError, approvalKeyPath, makeApprovalKey } from '../../src/setup/approval-key.ts';
import { createOwner, noUser } from '../../src/setup/code.ts';
import { SetupRecords } from '../../src/setup/records.ts';
import { settingsPath, writeSettings } from '../../src/setup/settings.ts';
import type { OwnerMade } from '../../src/setup/types.ts';
import type { LoginThrottle } from './users.ts';

export type SetupOptions = {
  readonly db: DatabaseSync;
  readonly env?: NodeJS.ProcessEnv;                  // default: process.env
  readonly params?: PasswordParams;                  // the tests' fast hash
  readonly now?: () => Date;
};

export type OwnerAnswer =
  | { readonly status: 201; readonly body: OwnerMade; readonly user: string }
  | { readonly status: 400 | 403 | 409 | 429; readonly body: { readonly error: string }; readonly wait?: number };

// The gate: open while the ledger has no account.
export const setupNeeded = (setup: SetupOptions | undefined): boolean => setup !== undefined && noUser(setup.db);

// The owner step's page was shown: the assistant's clock starts.
export const ownerShown = (setup: SetupOptions): void => new SetupRecords(setup.db, { now: setup.now }).shown('owner');

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function makeOwner(setup: SetupOptions, body: unknown, throttle: LoginThrottle, peer: string): Promise<OwnerAnswer> {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const code = text(fields.code);
  const name = text(fields.name).trim();
  const password = text(fields.password);
  if (!noUser(setup.db)) return { status: 409, body: { error: 'owner_exists' } };
  if (!USER_NAME.test(name)) return { status: 400, body: { error: 'name' } };
  if (name === userInfo().username) return { status: 400, body: { error: 'service_account' } };
  const length = [...password].length;
  if (length < PASSWORD_LENGTH.min || length > PASSWORD_LENGTH.max) return { status: 400, body: { error: 'password' } };
  // Counted before the code is checked, as a sign-in counts a password (users.ts).
  const attempt = throttle.start(peer, 'setup');
  if (attempt.succeeded === undefined) return { status: 429, body: { error: 'throttled' }, wait: attempt.wait };
  const passwordHash = await hashPassword(password, setup.params ?? PASSWORD_DEFAULTS);
  const now = setup.now?.() ?? new Date();
  const made = createOwner(setup.db, { code, name, passwordHash, now });
  if (!made.ok) {
    if (made.reason === 'taken') return { status: 409, body: { error: 'owner_exists' } };
    return { status: 403, body: { error: made.reason === 'expired' ? 'code_expired' : 'code_wrong' } };
  }
  attempt.succeeded();
  new SetupRecords(setup.db, { now: () => now }).done('owner');
  const env = setup.env ?? process.env;
  const settings = settingsPath(env);
  if (settings) writeSettings(settings, { env: { CLEARED_V2_OWNER_ID: name } });
  let key: { publicKey: string; existed: boolean } | undefined;
  try {
    key = makeApprovalKey(approvalKeyPath(env));
  } catch (error) {
    if (!(error instanceof ApprovalKeyError)) throw error;
    console.error(`cleared-v2-app: ${error.message}`);
  }
  return { status: 201, body: { name, publicKey: key?.publicKey ?? null, existed: key?.existed ?? false }, user: made.id };
}
