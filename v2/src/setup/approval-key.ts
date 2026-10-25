// The service's approval key, as `npm run setup` (src/cli/setup.ts) and the
// assistant's owner step make it: written once, mode 0600, never over a key
// that exists and never printed. Written beside the final name and linked
// into place, which fails if a file is there, so a crash leaves no half key.
// The public key goes in the project's .cleared/agents.conf as
// [tracker] human_public_key; it is not a secret.
import { closeSync, constants, linkSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApprovalSigner, generateKeyPair } from '../approval/signer.ts';
import { stateFolder } from './settings.ts';

export class ApprovalKeyError extends Error {
  override name = 'ApprovalKeyError';
}

// Where the approval service reads it (approval/service.ts): CLEARED_V2_APPROVAL_KEY, else approval.key in the state folder.
export const approvalKeyPath = (env: NodeJS.ProcessEnv): string => env.CLEARED_V2_APPROVAL_KEY || join(stateFolder(env), 'approval.key');

// Makes the key, or, with `keep` (the assistant), gives the public key of the one there.
export function makeApprovalKey(path: string, options: { readonly keep?: boolean } = { keep: true }): { publicKey: string; existed: boolean } {
  const pair = generateKeyPair();
  const part = `${path}.part`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, pair.privatePem); } finally { closeSync(fd); }
    linkSync(part, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' && options.keep !== false) {
      try { return { publicKey: ApprovalSigner.load(path).publicKey, existed: true }; }
      catch (loading) { throw new ApprovalKeyError(`a key exists at ${path} but cannot be read: ${(loading as Error).message}`); }
    }
    throw new ApprovalKeyError(code === 'EEXIST' ? `a key already exists at ${path}: it is never overwritten. Remove it yourself to make another, and commit the new public key`
      : `cannot write the key at ${path}: ${code ?? (error as Error).message}`);
  } finally {
    rmSync(part, { force: true });
  }
  return { publicKey: pair.publicKey, existed: false };
}
