// cleared-v2 setup: makes the service's approval key and says what the
// project's settings must hold for the lock to read the service's approvals.
//   node src/cli/setup.ts --owner <app user name> [--key <file>]    (npm run setup -- --owner demo)
// The private key is written once, mode 0600, never over a key that exists,
// and is never printed (setup/approval-key.ts, which the browser setup
// assistant's owner step shares). The public key is printed to commit as [tracker]
// human_public_key. The other keys depend on this machine and are for the
// service's own settings file (CLEARED_CONF), not for the project's.
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { stateDirectory } from '../approval/service.ts';
import { ApprovalKeyError, makeApprovalKey } from '../setup/approval-key.ts';
import { LedgerPathError } from '../store/db.ts';

const USAGE = 'usage: cleared-v2 setup --owner <name of the app user who approves> [--key <file>]';

function fail(message: string, code: number): never {
  console.error(`cleared-v2: ${message}`);
  process.exit(code);
}

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value. ${USAGE}`, 64);
  return value;
}

const args = process.argv.slice(2);
const owner = option(args, '--owner');
if (!owner) fail(USAGE, 64);
const account = userInfo().username;
if (owner === account) fail(`owner_id must differ from the service account's own name (${account}): the tracker refuses to run when both are the same, and it could not tell the owner from the agents. Use the name of the app user (cleared-v2 user add <name>)`, 64);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(owner)) fail('the owner is the name of an app user: 1 to 32 letters, digits, dots, dashes or underscores', 64);

let key = option(args, '--key');
if (!key) {
  try { key = join(stateDirectory(), 'approval.key'); } catch (error) {
    if (error instanceof LedgerPathError) fail(`${error.message}, or pass --key <file>`, 64);
    throw error;
  }
}

// The key's writing is the assistant's owner step's too (setup/approval-key.ts).
let publicKey: string;
try {
  publicKey = makeApprovalKey(key, { keep: false }).publicKey;
} catch (error) {
  if (error instanceof ApprovalKeyError) fail(error.message, 1);
  throw error;
}
console.log(`cleared-v2: the approval key is at ${key} (mode 600, read by the service only).

Put this in the project's .cleared/agents.conf and commit it (the public key is not a secret):

[tracker]
human_public_key = ${publicKey}

Put this in the settings file the service and the lock read on this machine (CLEARED_CONF), which is not committed:

[tracker]
agents_uid = ${process.getuid?.()}
owner_id = ${owner}
human_private_key = ${key}
[security]
human_user = ${account}
allow_shared_uid = true

owner_id is the app user who approves (cleared-v2 user add ${owner}). human_user is this account, so the broker accepts the service's requests. allow_shared_uid is the milestone 1 setting of the plan (decision 7): agents run in containers. Leave out a line the project's file already has: a repeated key is reported as a duplicate.

v1 also requires [tracker] team, [lanes] root, base, push_roles, busy_states, closed_states and archives, and [lead] report_on, which the example's file does not carry yet: add them to the same machine file.`);
