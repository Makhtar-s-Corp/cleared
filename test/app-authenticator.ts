// A software authenticator for the tests: what a phone's secure enclave does when
// it makes a passkey and signs with it (ES256, "none" attestation, user verified).
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

// What CBOR is made of here: integers, byte strings, text, and maps (an object is the map of its entries).
type Cbor = number | string | Buffer | Map<Cbor, Cbor> | { [key: string]: Cbor };

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest();
export const b64u = (data: Buffer) => Buffer.from(data).toString('base64url');
const head = (major: number, n: number) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
export function cborEncode(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]): Buffer[] => [cborEncode(k), cborEncode(v)])]);
  return cborEncode(new Map(Object.entries(value)));
}

export class Authenticator {
  declare origin: string;
  declare rpId: string;
  declare verified: boolean;
  declare privateKey: KeyObject;
  declare jwk: JsonWebKey;
  declare id: Buffer;
  declare counter: number;
  constructor({ origin, rpId, verified = true }: { origin: string; rpId: string; verified?: boolean }) {
    Object.assign(this, { origin, rpId, verified });
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    this.jwk = pair.publicKey.export({ format: 'jwk' });
    this.id = randomBytes(32);
    this.counter = 0;
  }
  flags(extra = 0) { return 0x01 | (this.verified ? 0x04 : 0) | extra; }
  // navigator.credentials.create({ publicKey }) -> the answer the page posts.
  create(publicKey: { challenge: string }, { origin = this.origin } = {}) {
    const cose = new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x!, 'base64url')], [-3, Buffer.from(this.jwk.y!, 'base64url')]]);
    const id = Buffer.alloc(2); id.writeUInt16BE(this.id.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([this.flags(0x40)]), counter, Buffer.alloc(16), id, this.id, cborEncode(cose)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: publicKey.challenge, origin, crossOrigin: false }));
    return { id: b64u(this.id), response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cborEncode({ fmt: 'none', attStmt: new Map(), authData })) } };
  }
  // navigator.credentials.get({ publicKey }) -> the answer the page posts.
  get(publicKey: { challenge: string }, { origin = this.origin, challenge = publicKey.challenge } = {}) {
    this.counter += 1;
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([this.flags()]), count]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), this.privateKey);
    return { id: b64u(this.id), response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) } };
  }
}
