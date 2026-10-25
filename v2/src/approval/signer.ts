// The service's Ed25519 key: the one thing that makes a move to the go state
// the human's (docs/v2/milestone-1-plan.md, decision 6). The service process
// holds it alone: a file it owns, mode 0600, outside the project, which no
// session container mounts. The signature is the one lib/tracker/adapters/
// local.ts verifies, so merge-pr.ts and tracker.ts read it unchanged.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export class SigningKeyError extends Error {
  override name = 'SigningKeyError';
}

// What local.ts signs for a status change: the ticket number (not LOCAL-n),
// the status, the time exactly as stored, the actor, the approval context and
// the content hash. Any other order or form verifies as someone else.
export function approvalPayload(ticket: number, status: string, at: string, actor: string, approvalContext: string | null, contentHash: string | null): string {
  return JSON.stringify([ticket, status, at, actor, approvalContext, contentHash]);
}

// What local.ts signs for a comment.
export function commentPayload(ticket: number, body: string, images: string, at: string, actor: string): string {
  return JSON.stringify(['comment', ticket, body, images, at, actor]);
}

const b64 = (pem: string) => Buffer.from(pem).toString('base64');

export function generateKeyPair(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey: b64(publicKey.export({ type: 'spki', format: 'pem' }) as string),
  };
}

export class ApprovalSigner {
  readonly #key: KeyObject;
  // The public half as [tracker] human_public_key holds it: base64 of the PEM.
  readonly publicKey: string;

  private constructor(key: KeyObject) {
    this.#key = key;
    this.publicKey = b64(createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string);
  }

  // Reads the key the way local.ts reads its own: a regular file owned by
  // this account that nobody else can read. A link is not followed.
  static load(path: string): ApprovalSigner {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new SigningKeyError(`cannot read the signing key at ${path}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new SigningKeyError(`the signing key at ${path} is not a regular file`);
      if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new SigningKeyError(`the signing key at ${path} must be owned by this account and readable only by it (mode 600)`);
      let key: KeyObject;
      try {
        key = createPrivateKey(readFileSync(fd));
      } catch {
        throw new SigningKeyError(`the signing key at ${path} is not a PEM private key`);
      }
      if (key.asymmetricKeyType !== 'ed25519') throw new SigningKeyError(`the signing key at ${path} is not an Ed25519 key`);
      return new ApprovalSigner(key);
    } finally {
      closeSync(fd);
    }
  }

  sign(payload: string): string {
    return sign(null, Buffer.from(payload), this.#key).toString('base64');
  }
}
