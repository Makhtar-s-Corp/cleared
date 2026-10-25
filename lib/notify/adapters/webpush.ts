// Web Push to the app installed on the human's phone or computer, with no
// library: the message is encrypted for each browser (RFC 8291, aes128gcm)
// and signed by the service's own key (VAPID, RFC 8292). The push service
// (Google, Mozilla, Apple, Microsoft) carries bytes it cannot read.
//
// The keys are generated the first time they are needed and kept in the
// service's private notification directory (lib/notify/store.ts); the
// browsers' subscriptions live there too. Neither is ever written to the
// ledger, a log or an error.
import { createECDH, createHash, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto';
import type { ECDH } from 'node:crypto';
import type { Adapter, NotifyMessage, SendOptions, Transport } from '../contract.ts';

export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string }; device?: string; at?: string };
export type VapidKeys = { publicKey: string; privateKey: string };

const b64u = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac('sha256', key).update(data).digest();
// HKDF (RFC 5869) with one block of output: all Web Push needs.
const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

// The push services a browser may hand us, by host. Anything else is refused at
// subscription and again at sending: the service never posts to an address of
// someone's choosing. [notify] push_hosts adds to it (a self-hosted service).
export const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.push.apple.com', '*.notify.windows.com'];
export function pushHostAllowed(endpoint: string, extra: string[] = []): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return [...PUSH_HOSTS, ...extra].some((rule) => rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule);
}

// A subscription as the browser gives it: an https endpoint of a known push
// service and the browser's two keys. Returns the cleaned copy, or null.
// extra = null checks the shape only (the host is checked again at sending).
export function validSubscription(input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null } | null | undefined, extra: string[] | null = []): Subscription | null {
  const endpoint = input?.endpoint;
  const p256dh = input?.keys?.p256dh, auth = input?.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !/^https:\/\//.test(endpoint) || (extra !== null && !pushHostAllowed(endpoint, extra))) return null;
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return null;
  const key = Buffer.from(p256dh, 'base64url'), secret = Buffer.from(auth, 'base64url');
  if (key.length !== 65 || key[0] !== 4 || secret.length !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

// The private scalar on its 32 bytes: Node drops leading zero bytes (about one key in 256),
// which a JWK refuses; such a key, kept for good, would never sign.
const scalar = (bytes: Buffer) => Buffer.concat([Buffer.alloc(Math.max(0, 32 - bytes.length)), bytes]);
// The service's VAPID key pair: the raw public key (what the browser is given) and the private scalar.
export function vapidKeysFrom(ecdh: ECDH): VapidKeys {
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(scalar(ecdh.getPrivateKey())) };
}
export function newVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return vapidKeysFrom(ecdh);
}
const privateJwk = ({ publicKey, privateKey }: VapidKeys) => {
  const raw = Buffer.from(publicKey, 'base64url');
  return { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d: b64u(scalar(Buffer.from(privateKey, 'base64url'))) };
};

// RFC 8291: the message for one browser. `ephemeral` and `salt` are drawn here;
// a test may give its own to check the RFC's example.
export function encrypt(payload: Uint8Array | string, { p256dh, auth }: { p256dh: string; auth: string }, { ephemeral, salt = randomBytes(16) }: { ephemeral?: string; salt?: Uint8Array } = {}): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(Buffer.from(ephemeral, 'base64url')); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the text, then the delimiter of the last record (0x02), no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// RFC 8292: the Authorization header for one push service (its origin is the audience).
export function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const encoded = (value: unknown) => b64u(JSON.stringify(value));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${encoded({ typ: 'JWT', alg: 'ES256' })}.${encoded(claims)}`;
  const key = createPrivateKey({ key: privateJwk(keys), format: 'jwk' });
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${keys.publicKey}`;
}

// The adapter. `store` gives the keys and the subscriptions and drops one the
// push service says is gone; `transport` is fetch (a test gives its own). The
// browsers are told a few at a time (`parallel`), each call cut after
// `timeoutMs`, and none is started once `signal` (the dispatcher's deadline) is aborted.
export const PARALLEL = 4;
export type PushStore = { vapid(): VapidKeys; subscriptions(): Subscription[]; forget(endpoint: string): unknown };
export function webpushAdapter({ store, subject, extraHosts = [], transport = fetch, timeoutMs = 10000, parallel = PARALLEL }:
  { store: PushStore; subject: string; extraHosts?: string[]; transport?: Transport; timeoutMs?: number; parallel?: number }): Adapter {
  return {
    name: 'webpush',
    ready() {
      if (!/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject || '')) return 'no_subject';
      return store.subscriptions().length ? null : 'no_subscription';
    },
    async send(message: NotifyMessage, { signal }: SendOptions = {}) {
      let keys: VapidKeys;
      try { keys = store.vapid(); } catch { throw new Error('no keys'); }
      const payload = JSON.stringify({ title: message.title, body: message.body, url: message.url ?? null, tag: message.group });
      // A newer message for the same ticket replaces one the push service still holds.
      const topic = createHash('sha256').update(String(message.group)).digest('base64url').slice(0, 32);
      let delivered = 0, failed = 0;
      const one = async (subscription: Subscription) => {
        if (!pushHostAllowed(subscription.endpoint, extraHosts)) { failed += 1; return; }
        try {
          // A redirect is a failure: the request is never sent again to an address the service did not name.
          const response = await transport(subscription.endpoint, { method: 'POST', body: encrypt(payload, subscription.keys), redirect: 'error',
            headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: message.urgent ? 'high' : 'normal',
              topic, authorization: vapidHeader(subscription.endpoint, keys, subject) },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
          if (response.status === 404 || response.status === 410) { store.forget(subscription.endpoint); return; }
          if (response.ok) delivered += 1; else failed += 1;
        } catch { failed += 1; }
      };
      const queue = store.subscriptions();
      let next = 0;
      const worker = async () => { while (next < queue.length && !signal?.aborted) await one(queue[next++]!); };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, queue.length)) }, worker));
      // Said by a code only: never the endpoint, never what the push service answered.
      if (!delivered) throw new Error(failed ? 'push service refused' : 'no subscription left');
      return { delivered };
    },
  };
}
