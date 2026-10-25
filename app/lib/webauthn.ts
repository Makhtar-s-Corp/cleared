// WebAuthn (passkeys), the part the app needs and nothing more: ES256 keys,
// "none" attestation, user presence AND user verification (fingerprint, Face ID
// or the device PIN) required on every use. No dependency: a small CBOR reader
// and Node's own crypto.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();
export const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
export const challenge = () => b64u(randomBytes(32));

// CBOR (RFC 8949), definite lengths only, which is all an authenticator sends.
export function cbor(bytes: Buffer, start = 0, depth = 0): { value: unknown; end: number } {
  if (depth > 8) throw new Error('cbor: too deep');
  let at = start;
  const head = bytes[at++];
  if (head === undefined) throw new Error('cbor: truncated');
  const major = head >> 5;
  let extra = head & 31;
  const need = (n: number) => { if (at + n > bytes.length) throw new Error('cbor: truncated'); };
  const take = (n: number) => { need(n); const out = Buffer.from(bytes.subarray(at, at + n)); at += n; return out; };
  if (major === 7) {
    if (extra === 20) return { value: false, end: at };
    if (extra === 21) return { value: true, end: at };
    if (extra === 22) return { value: null, end: at };
    throw new Error('cbor: unsupported simple value');
  }
  let length: number;
  if (extra < 24) length = extra;
  else if (extra === 24) length = take(1).readUInt8();
  else if (extra === 25) length = take(2).readUInt16BE();
  else if (extra === 26) length = take(4).readUInt32BE();
  else throw new Error('cbor: unsupported length');
  if (major === 0) return { value: length, end: at };
  if (major === 1) return { value: -1 - length, end: at };
  if (major === 2) return { value: take(length), end: at };
  if (major === 3) return { value: take(length).toString('utf8'), end: at };
  if (major === 4 || major === 5) {
    if (length > 64) throw new Error('cbor: too long');
    const items = major === 4 ? [] : new Map();
    for (let i = 0; i < length; i++) {
      const first = cbor(bytes, at, depth + 1); at = first.end;
      if (major === 4) { (items as unknown[]).push(first.value); continue; }
      const second = cbor(bytes, at, depth + 1); at = second.end;
      (items as Map<unknown, unknown>).set(first.value, second.value);
    }
    return { value: items, end: at };
  }
  throw new Error('cbor: unsupported type');
}

const FLAG = { up: 0x01, uv: 0x04, at: 0x40 };
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

type Expected = { expectedChallenge: string; origin: string; rpId: string };
function clientData(raw: string, { type, expectedChallenge, origin }: { type: string; expectedChallenge: string; origin: string }) {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw new Error('client data unreadable'); }
  if (data.type !== type) throw new Error('wrong ceremony');
  if (typeof data.challenge !== 'string' || !same(Buffer.from(data.challenge), Buffer.from(expectedChallenge))) throw new Error('challenge mismatch');
  if (data.origin !== origin) throw new Error('origin mismatch');
  if (data.crossOrigin === true) throw new Error('cross-origin ceremony');
  return Buffer.from(raw, 'base64url');
}
function authenticatorData(bytes: Buffer, rpId: string) {
  if (bytes.length < 37) throw new Error('authenticator data too short');
  if (!same(bytes.subarray(0, 32), sha256(rpId))) throw new Error('relying party mismatch');
  const flags = bytes[32]!;
  if (!(flags & FLAG.up)) throw new Error('user presence missing');
  if (!(flags & FLAG.uv)) throw new Error('user verification missing');
  return { flags, signCount: bytes.readUInt32BE(33) };
}

// The browser's create() answer: { id, response: { clientDataJSON, attestationObject } }, all base64url.
export function verifyRegistration(answer: { id?: unknown; clientDataJSON: string; attestationObject: string }, { expectedChallenge, origin, rpId }: Expected) {
  const raw = clientData(answer.clientDataJSON, { type: 'webauthn.create', expectedChallenge, origin });
  void raw;
  const object = cbor(Buffer.from(answer.attestationObject, 'base64url')).value;
  if (!(object instanceof Map) || object.get('fmt') !== 'none') throw new Error('attestation format not accepted');
  const auth = object.get('authData');
  if (!Buffer.isBuffer(auth)) throw new Error('authenticator data missing');
  const { flags, signCount } = authenticatorData(auth, rpId);
  if (!(flags & FLAG.at) || auth.length < 55) throw new Error('no credential in the answer');
  const idLength = auth.readUInt16BE(53);
  if (idLength < 16 || idLength > 128 || auth.length < 55 + idLength) throw new Error('credential id invalid');
  const id = auth.subarray(55, 55 + idLength);
  const key = cbor(auth, 55 + idLength).value;
  if (!(key instanceof Map) || key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1) throw new Error('only ES256 keys are accepted');
  const [x, y] = [key.get(-2), key.get(-3)];
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('key invalid');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' });
  if (answer.id !== b64u(id)) throw new Error('credential id mismatch');
  return { id: b64u(id), publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signCount };
}

// The browser's get() answer: { id, response: { clientDataJSON, authenticatorData, signature } }.
export function verifyAssertion(answer: { id?: unknown; clientDataJSON: string; authenticatorData: string; signature: string }, credential: { publicKey: string; signCount: number }, { expectedChallenge, origin, rpId }: Expected) {
  const raw = clientData(answer.clientDataJSON, { type: 'webauthn.get', expectedChallenge, origin });
  const auth = Buffer.from(answer.authenticatorData, 'base64url');
  const { signCount } = authenticatorData(auth, rpId);
  const key = createPublicKey({ key: Buffer.from(credential.publicKey, 'base64'), format: 'der', type: 'spki' });
  const good = verify('sha256', Buffer.concat([auth, sha256(raw)]), key, Buffer.from(answer.signature, 'base64url'));
  if (!good) throw new Error('signature invalid');
  // A counter that does not move forward means a copied key (authenticators that keep none send 0 every time).
  if ((signCount !== 0 || credential.signCount !== 0) && signCount <= credential.signCount) throw new Error('counter did not advance');
  return { signCount };
}
