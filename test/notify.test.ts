import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.ts';
import { addEvent, openLedger, runStart } from '../lib/ledger.ts';
import { createAdapters, isQuiet, KINDS, notifySettings, render, sanitize, URGENT } from '../lib/notify/contract.ts';
import type { Adapter, NotifyMessage, NotifySettings, Occurrence, Transport } from '../lib/notify/contract.ts';
import { encrypt, newVapidKeys, pushHostAllowed, validSubscription, vapidHeader, vapidKeysFrom, webpushAdapter } from '../lib/notify/adapters/webpush.ts';
import type { Subscription } from '../lib/notify/adapters/webpush.ts';
import { ntfyAdapter } from '../lib/notify/adapters/ntfy.ts';
import { telegramAdapter } from '../lib/notify/adapters/telegram.ts';
import { emailAdapter, sendmailDefault } from '../lib/notify/adapters/email.ts';
import { notifyStore } from '../lib/notify/store.ts';
import { dispatch, EXPIRE_MS, sendTest } from '../lib/notify.ts';
import { scratch } from './support.ts';
import type { DatabaseSync } from 'node:sqlite';

// What a fake transport was given: the headers as the adapters write them, an object.
type Posted<Body> = { url: string; init: { headers: Record<string, string>; body: Body; redirect?: RequestInit['redirect']; signal?: AbortSignal } };

// Values a notification must never carry, whatever a ticket says.
const SECRET_PATH = '/home/cleared/.config/cleared/human/credentials.json';
const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
const LEAKS = [/\/home\//, /credentials\.json/, /ghp_/, /0123456789abcdef/, /1\s?234/, /€/, /hunter2/, /owner@example\.org/, /192\.0\.2\.7/];
const clean = (text: string) => { for (const leak of LEAKS) assert.doesNotMatch(text, leak, `${leak} in ${JSON.stringify(text)}`); };

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) => createHmac('sha256', createHmac('sha256', salt).update(ikm).digest()).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
// The browser's side of RFC 8291, written apart from the sender's: what a phone would read.
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const keys = { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) };
  const read = (body: Buffer) => {
    const salt = body.subarray(0, 16), length = body[20]!, asPublic = body.subarray(21, 21 + length), sealed = body.subarray(21 + length);
    assert.equal(body.readUInt32BE(16), 4096);
    const ikm = hkdf(auth, ecdh.computeSecret(asPublic), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32);
    const decipher = createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
    decipher.setAuthTag(sealed.subarray(-16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, 'one record, the last');
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { keys, read };
}
const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
const memoryStore = (subscriptions: Subscription[] = [], credentials: Record<string, unknown> = {}) => {
  const keys = newVapidKeys();
  return { vapid: () => keys, subscriptions: () => subscriptions, forget(url: string) { const i = subscriptions.findIndex((s) => s.endpoint === url); if (i >= 0) subscriptions.splice(i, 1); }, credentials: (name: string) => credentials[name], keys };
};

// ---- Web Push --------------------------------------------------------------------

test('Web Push encryption gives the very bytes of RFC 8291, section 5, from its keys and salt', () => {
  const body = encrypt(Buffer.from('When I grow up, I want to be a watermelon'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { ephemeral: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') });
  assert.equal(b64u(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('the VAPID header is an ES256 token for the push service, signed by the service key and checkable with its public key (RFC 8292)', () => {
  const keys = newVapidKeys();
  const now = Date.parse('2026-10-15T08:00:00Z');
  const header = vapidHeader(endpoint, keys, 'mailto:ops@example.org', now);
  const [, token, k] = /^vapid t=([^,]+), k=(\S+)$/.exec(header)!;
  assert.equal(k, keys.publicKey);
  const [head, claims, signature] = token!.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head!, 'base64url') as unknown as string), { typ: 'JWT', alg: 'ES256' });
  const body = JSON.parse(Buffer.from(claims!, 'base64url') as unknown as string);
  assert.equal(body.aud, 'https://fcm.googleapis.com');
  assert.equal(body.sub, 'mailto:ops@example.org');
  assert.ok(body.exp > now / 1000 && body.exp <= now / 1000 + 24 * 3600, 'expires within a day');
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  assert.equal(Buffer.from(signature!, 'base64url').length, 64, 'r and s, not DER');
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')));
});

test('a VAPID key whose private scalar starts with a zero byte is kept on 32 bytes and still signs', () => {
  const ecdh = createECDH('prime256v1');
  for (;;) { try { ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(1), randomBytes(31)])); break; } catch { /* not a valid scalar, draw again */ } }
  assert.equal(ecdh.getPrivateKey().length, 31, 'Node drops the leading zero: the case is exercised');
  const keys = vapidKeysFrom(ecdh);
  assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  // Kept on 32 bytes, or kept short by an earlier version: both sign.
  for (const privateKey of [keys.privateKey, b64u(ecdh.getPrivateKey())]) {
    const [, token] = /^vapid t=([^,]+),/.exec(vapidHeader(endpoint, { ...keys, privateKey }, 'mailto:ops@example.org'))!;
    const [head, claims, signature] = token!.split('.');
    assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')));
  }
});

test('only an https endpoint of a known push service, with the browser keys, is a subscription', () => {
  const { keys } = browser();
  for (const ok of [endpoint, 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QOk', 'https://db5p.notify.windows.com/w/?token=x'])
    assert.ok(validSubscription({ endpoint: ok, keys }), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x', 'https://127.0.0.1/x', 'https://localhost/x', 'file:///etc/passwd', 'https://notify.windows.com.evil/x'])
    assert.equal(validSubscription({ endpoint: bad, keys }), null, bad);
  assert.equal(validSubscription({ endpoint, keys: { p256dh: keys.p256dh, auth: 'short' } }), null);
  assert.equal(validSubscription({ endpoint, keys: { p256dh: 'A'.repeat(87), auth: keys.auth } }), null, 'not a P-256 point');
  assert.ok(pushHostAllowed('https://push.example.org/x', ['push.example.org']), '[notify] push_hosts adds a self-hosted service');
});

test('the Web Push adapter sends what the phone can read, drops a subscription the service says is gone, and never says the endpoint', async () => {
  const one = browser(), two = browser();
  const subscriptions = [{ endpoint, keys: one.keys }, { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gone', keys: two.keys }];
  const store = memoryStore(subscriptions);
  const posts: Posted<Buffer>[] = [];
  const transport = async (url: string, init: RequestInit) => { posts.push({ url, init } as Posted<Buffer>); return { ok: !url.includes('gone'), status: url.includes('gone') ? 410 : 201 }; };
  const adapter = webpushAdapter({ store, subject: 'https://cockpit.example.ts.net', transport });
  assert.equal(adapter.ready(), null);
  const message = render({ kind: 'approval', ticket: 'EX-12', title: 'Rename the save button' }, { linkBase: 'https://cockpit.example.ts.net' });
  await adapter.send(message);
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.init.headers['content-encoding'], 'aes128gcm');
  assert.equal(posts[0]!.init.headers.urgency, 'normal');
  assert.match(posts[0]!.init.headers.topic!, /^[A-Za-z0-9_-]{1,32}$/);
  assert.match(posts[0]!.init.headers.authorization!, /^vapid t=/);
  assert.deepEqual(one.read(posts[0]!.init.body), { title: message.title, body: message.body, url: 'https://cockpit.example.ts.net/#ticket=EX-12', tag: 'EX-12' });
  assert.deepEqual(subscriptions.map((s) => s.endpoint), [endpoint], 'a 410 forgets that browser');
  const refusing = webpushAdapter({ store, subject: 'mailto:ops@example.org', transport: async () => ({ ok: false, status: 400 }) });
  await assert.rejects(refusing.send(message), (error: Error) => !error.message.includes('googleapis') && /refused/.test(error.message));
  assert.equal(webpushAdapter({ store, subject: '', transport }).ready(), 'no_subject');
  assert.equal(webpushAdapter({ store: memoryStore([]), subject: 'mailto:a@b.org', transport }).ready(), 'no_subscription');
});

// ---- the other adapters, same contract ----------------------------------------------

// The service's own settings come from its environment, never from agents.conf.
const LINK_ENV = { CLEARED_NOTIFY_LINK_BASE: 'https://cockpit.example.ts.net' };
const MESSAGE = render({ kind: 'rollback', ticket: 'EX-4', title: `Fix ${SECRET_PATH} with ${TOKEN}` }, { language: 'fr', linkBase: 'https://cockpit.example.ts.net' });

test('every adapter has the same contract: a name, ready() with a reason when it cannot, send() of the rendered message', async () => {
  const transport = async () => ({ ok: true, status: 200 });
  const empty = memoryStore();
  const settings = notifySettings({ sections: { notify: { adapters: 'webpush, ntfy, email, telegram' } } }, LINK_ENV);
  const adapters = createAdapters(settings, { store: empty, transport, run: () => {} });
  assert.deepEqual(adapters.map((a) => a.name), ['webpush', 'ntfy', 'email', 'telegram']);
  for (const adapter of adapters) {
    assert.equal(typeof adapter.send, 'function');
    assert.match(String(adapter.ready()), /^no_/, `${adapter.name} is not ready without its secrets`);
    await assert.rejects(adapter.send(MESSAGE), `${adapter.name} refuses to send without its secrets`);
  }
  assert.throws(() => notifySettings({ sections: { notify: { adapters: 'pager' } } }), /unknown adapter/);
});

test('ntfy gets one JSON post on its topic, with the token as a bearer; its errors name no server, topic or token', async () => {
  const posts: Posted<string>[] = [];
  const credentials = { server: 'https://ntfy.example.org', topic: 'cleared-x7Rk2', token: 'tk_abcdefgh12345' };
  const adapter = ntfyAdapter({ credentials: () => credentials, transport: async (url, init) => { posts.push({ url, init } as Posted<string>); return { ok: true, status: 200 }; } });
  assert.equal(adapter.ready(), null);
  await adapter.send(MESSAGE);
  assert.equal(posts[0]!.url, 'https://ntfy.example.org/');
  assert.equal(posts[0]!.init.headers.authorization, 'Bearer tk_abcdefgh12345');
  const sent = JSON.parse(posts[0]!.init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['click', 'message', 'priority', 'tags', 'title', 'topic']);
  assert.equal(sent.topic, 'cleared-x7Rk2');
  assert.equal(sent.priority, 5, 'a rollback is urgent');
  assert.equal(sent.click, 'https://cockpit.example.ts.net/#ticket=EX-4');
  clean(`${sent.title} ${sent.message}`);
  const down = ntfyAdapter({ credentials: () => credentials, transport: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(down.send(MESSAGE), (error: Error) => error.message === 'ntfy refused (403)');
  for (const bad of [{ server: 'http://ntfy.example.org', topic: 'x' }, { server: 'https://a:b@ntfy.example.org', topic: 'x' }, { server: 'https://ntfy.example.org', topic: '../x' }])
    assert.equal(ntfyAdapter({ credentials: () => bad, transport: (async () => ({ ok: true })) as unknown as Transport }).ready(), 'no_credentials', JSON.stringify(bad));
});

test('Telegram posts plain text to the bot; the bot token travels in the address only and no error repeats it', async () => {
  const token = '123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123';
  const posts: Posted<string>[] = [];
  const adapter = telegramAdapter({ credentials: () => ({ bot_token: token, chat_id: '-1001234' }), transport: async (url, init) => { posts.push({ url, init } as Posted<string>); return { ok: true, status: 200 }; } });
  await adapter.send(MESSAGE);
  assert.equal(posts[0]!.url, `https://api.telegram.org/bot${token}/sendMessage`);
  const sent = JSON.parse(posts[0]!.init.body);
  assert.equal(sent.chat_id, '-1001234');
  assert.equal(sent.parse_mode, undefined, 'nothing is read as markup');
  assert.ok(sent.text.startsWith(MESSAGE.title));
  for (const fail of [async () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${token}`); }, async () => ({ ok: false, status: 401 })]) {
    const broken = telegramAdapter({ credentials: () => ({ bot_token: token, chat_id: '42' }), transport: fail });
    await assert.rejects(broken.send(MESSAGE), (error: Error) => !error.message.includes(token) && !error.message.includes('AAH') && /^telegram (?:unreachable|refused \(401\))$/.test(error.message));
  }
});

test('every adapter refuses a redirect: the request says so, and a redirect answer is a failure with a code only', async () => {
  const seen: (RequestInit['redirect'] | undefined)[] = [];
  const redirected = async (url: string, init: RequestInit) => { seen.push(init.redirect); return { ok: false, status: 302, headers: new Map([['location', 'https://elsewhere.example/x']]) }; };
  const subscriptions = [{ endpoint, keys: browser().keys }];
  const adapters: [Adapter, RegExp][] = [
    [webpushAdapter({ store: memoryStore(subscriptions), subject: 'mailto:ops@example.org', transport: redirected }), /^push service refused$/],
    [ntfyAdapter({ credentials: () => ({ server: 'https://ntfy.example.org', topic: 'cleared-x7Rk2' }), transport: redirected }), /^ntfy refused \(302\)$/],
    [telegramAdapter({ credentials: () => ({ bot_token: '123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123', chat_id: '42' }), transport: redirected }), /^telegram refused \(302\)$/],
  ];
  for (const [adapter, code] of adapters) await assert.rejects(adapter.send(MESSAGE), (error: Error) => code.test(error.message) && !/elsewhere/.test(error.message), adapter.name);
  assert.deepEqual(seen, ['error', 'error', 'error'], 'fetch is told to refuse a redirect, in each adapter');
  // What fetch does with redirect: 'error' is to reject: the adapter says it is unreachable, not that it was sent.
  const refused = ntfyAdapter({ credentials: () => ({ server: 'https://ntfy.example.org', topic: 'cleared-x7Rk2' }), transport: async (url, init) => { if (init.redirect === 'error') throw new TypeError('redirect mode is set to error'); return { ok: true, status: 200 }; } });
  await assert.rejects(refused.send(MESSAGE), (error: Error) => error.message === 'ntfy unreachable');
});

test('a long e-mail subject is folded into encoded words of 75 characters at most, each a whole UTF-8 text', async () => {
  const calls: string[] = [];
  const adapter = emailAdapter({ credentials: () => ({ to: 'owner@example.org' }), sendmail: '/usr/sbin/sendmail', run: (file, args, input) => calls.push(input) });
  const title = 'Déployer la nouvelle façade « Réglages » sur le téléphone de l\'équipe, en français, avec des accents partout ✓🙂 '.repeat(4).trim();
  await adapter.send({ kind: 'approval', title, body: 'x', url: null, urgent: false, group: 'EX-1' } as NotifyMessage);
  const lines = calls[0]!.split('\r\n');
  const start = lines.findIndex((line) => line.startsWith('Subject: '));
  const folded = [lines[start]!];
  for (let i = start + 1; lines[i]!.startsWith(' '); i += 1) folded.push(lines[i]!);
  assert.ok(folded.length > 1, 'a long subject is folded');
  for (const line of folded) assert.ok(line.replace(/^(Subject: | )/, '').length <= 75 && line.length <= 81, line);
  const words = folded.map((line) => line.replace(/^Subject: /, '').trim()).map((word) => /^=\?UTF-8\?B\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(word));
  assert.ok(words.every(Boolean), 'each word is one encoded word');
  const decoded = words.map((m) => Buffer.from(m![1]!, 'base64'));
  for (const bytes of decoded) assert.ok(!bytes.toString('utf8').includes('\uFFFD'), 'no character is cut in two');
  assert.equal(Buffer.concat(decoded).toString('utf8'), title, 'the words, read back in order, are the subject');
  const short = emailAdapter({ credentials: () => ({ to: 'owner@example.org' }), sendmail: '/usr/sbin/sendmail', run: (f, a, input) => calls.push(input) });
  await short.send({ kind: 'test', title: 'Test', body: 'x', url: null, urgent: false, group: 'test' } as NotifyMessage);
  assert.match(calls.at(-1)!, /^Subject: =\?UTF-8\?B\?VGVzdA==\?=\r$/m, 'a short subject is one word, as before');
});

test('e-mail goes through sendmail with the recipient as an argument; a title cannot add a header or a recipient', async () => {
  const calls: { file: string; args: string[]; input: string }[] = [];
  const adapter = emailAdapter({ credentials: () => ({ to: 'owner@example.org', from: 'cleared@example.org' }), sendmail: '/usr/sbin/sendmail', run: (file, args, input) => calls.push({ file, args, input }) });
  const evil = render({ kind: 'question', ticket: 'EX-9', title: 'Hi\r\nBcc: thief@example.net\r\n\r\nbody' }, { linkBase: 'https://cockpit.example.ts.net' });
  await adapter.send(evil);
  assert.equal(calls[0]!.file, '/usr/sbin/sendmail');
  assert.deepEqual(calls[0]!.args, ['-i', '-f', 'cleared@example.org', '--', 'owner@example.org']);
  const [head] = calls[0]!.input.split('\r\n\r\n');
  assert.deepEqual(head!.split('\r\n').map((line) => line.split(':')[0]), ['From', 'To', 'Subject', 'Date', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'Auto-Submitted']);
  assert.doesNotMatch(calls[0]!.input, /thief|Bcc/i);
  assert.match(head!, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  const failing = emailAdapter({ credentials: () => ({ to: 'owner@example.org' }), run: () => { throw new Error('/usr/sbin/sendmail: exit 75 owner@example.org'); } });
  await assert.rejects(failing.send(evil), (error: Error) => error.message === 'sendmail failed');
  assert.equal(emailAdapter({ credentials: () => ({ to: 'owner@example.org\nBcc: x@y.z' }) }).ready(), 'no_credentials');
});

// ---- what a notification may say ------------------------------------------------

test('the filter strips paths, links, tokens, keys, passwords, e-mails, addresses, amounts and long numbers from a title', () => {
  const cases = {
    [`Leak ${SECRET_PATH}`]: 'Leak [path]',
    'Read ~/.ssh/id_ed25519 and $HOME/.env': 'Read [path] and [path]',
    'C:\\Users\\owner\\secrets.txt': '[path]',
    'Edit .cleared/agents.conf': 'Edit [path]',
    'Open https://internal.example/admin?key=1': 'Open [link]',
    [`Use ${TOKEN}`]: 'Use [secret]',
    'Bearer abc.def.ghi please': '[secret] please',
    'password: hunter2 and token=abc': '[secret] and [secret]',
    'Mail owner@example.org': 'Mail [email]',
    'Host 192.0.2.7 down': 'Host [address] down',
    'Refund €1 234,56 to customer': 'Refund [amount] to customer',
    'Paiement de 1 234,56 € reçu': 'Paiement de [amount] reçu',
    'Charge 1234.50 now': 'Charge [number] now',
    'Account 12345678901': 'Account [number]',
    'Hash 9f86d081884c7d659a2feaa0c55ad015': 'Hash [secret]',
    'Ping evil.com now': 'Ping [host] now',
    'Connect to db.internal': 'Connect to [host]',
    'See www.x.io': 'See [host]',
    'Token xoxb-123-456 leaked': 'Token [secret] leaked',
    'Use user:pass@host.io': 'Use [secret]',
    'Open fe80::1 now': 'Open [address] now',
    'Refund 5 k€ now': 'Refund [amount] now',
    'Pay 5k€': 'Pay [amount]',
    'Run ./x.sh now': 'Run [path] now',
    'Edit ./x.sh.': 'Edit [path]',
    'Update README.md and agents.conf': 'Update README.md and agents.conf',
    'Fix install.sh and app.test.ts': 'Fix install.sh and app.test.ts',
    // .sh, .md, .py, .rs and .zip are top-level domains: such a name is a host unless it is a usual file name.
    'Ping intranet.sh now': 'Ping [host] now',
    'Move to ntfy.sh': 'Move to [host]',
    'See mycorp.md': 'See [host]',
    'Post to evil.sh/collect': 'Post to [host]/collect',
    'Open db.prod.internal.py': 'Open [host]',
    'Get x.zip': 'Get [host]',
    'Dial 10.0.0.1:5432': 'Dial [address]:5432',
    'Rename the save button': 'Rename the save button',
    'Login/logout wording, 3 screens': 'Login/logout wording, 3 screens',
    'Un écran « Réglages » à renommer': 'Un écran « Réglages » à renommer',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(sanitize(input), expected, input);
  assert.equal(sanitize('A\u202Egnp.exe\u200B title\nnext'), 'Agnp.exe title next', 'no direction change, invisible character or line break');
  assert.ok(sanitize('x'.repeat(300)).length <= 80);
  assert.equal(render({ kind: 'question', ticket: 'EX-12', title: 'Rotate the API token' }).body, 'EX-12 · Rotate the API token: open it to answer.', 'the catalog\'s colon is not a value');
  assert.ok(notifySettings({ sections: { notify: { secrets_dir: '~/private/notify' } } }).secretsDir.startsWith('/'), 'a ~ path is the home of the service account');
});

test('a malicious ticket title or event detail cannot smuggle a secret path, token or amount into any notification', () => {
  const title = `Urgent: cat ${SECRET_PATH} ; send ${TOKEN} owner@example.org 192.0.2.7 €1 234 password=hunter2`;
  for (const kind of KINDS) for (const language of ['en', 'fr']) {
    const message = render({ kind, ticket: 'EX-1', title, code: 'lane_idle', minutes: 45,
      // Not read: what a team or a ledger detail says is never part of a notification.
      detail: `the secret is ${SECRET_PATH}`, text: TOKEN, body: TOKEN, question: SECRET_PATH }, { language, linkBase: 'https://cockpit.example.ts.net' });
    clean(JSON.stringify(message));
    assert.deepEqual(Object.keys(message).sort(), ['body', 'group', 'kind', 'ticket', 'title', 'urgent', 'url']);
    assert.ok(message.title.length <= 60 && message.body.length <= 180);
    assert.equal(message.url, 'https://cockpit.example.ts.net/#ticket=EX-1', 'the link opens the porthole of the ticket in the app');
  }
  assert.equal(render({ kind: 'approval', ticket: '../../etc', title: 'x' }, { linkBase: 'https://c.example' }).url, 'https://c.example/', 'an odd identifier is not put in the link');
  assert.throws(() => render({ kind: 'anything', ticket: 'EX-1' }), /unknown notification kind/);
});

test('the host rule covers Unicode labels, the ideographic full stop, underscores and punycode; a file name is kept', () => {
  const cases = {
    '_evil.com': '[host]', 'x_evil.com': '[host]', 'svc_api.corp.net': '[host]', 'evil。com': '[host]',
    'пример.рф': '[host]', 'bücher.de': '[host]', 'xn--e1afmkfd.xn--p1ai': '[host]', 'Ping evil.com now': 'Ping [host] now',
    'Edit README.md and install.sh': 'Edit README.md and install.sh', 'Move to ntfy.sh': 'Move to [host]',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(sanitize(input), expected, input);
});

test('IPv6 is masked whole, not as its tail; a time of day is not an address', () => {
  assert.equal(sanitize('2001:db8::1'), '[address]');
  assert.equal(sanitize('fe80::1 down'), '[address] down');
  assert.equal(sanitize('2001:0db8:0000:0000:0000:ff00:0042:8329'), '[address]');
  assert.equal(sanitize('Open 12:30 now'), 'Open 12:30 now');
});

test('French amounts, secrets written with a separator or none, hyphenated card and SSN numbers and 0x hex are masked', () => {
  const cases = {
    "5 millions d'euros": '[amount]', '5 millions de euros': '[amount]', '5 US$': '[amount]', '500 yen': '[amount]', '5usd': '[amount]',
    'mdp=abc': '[secret]', 'mot de passe: abc': '[secret]', 'clé: abc': '[secret]', 'pw=x': '[secret]', 'password hunter2': '[secret]',
    'password reset flow': 'password reset flow',
    '4111-1111-1111-1111': '[number]', '123-45-6789': '[number]', '0xdeadBEEF': '[secret]', 'Release 2026-10-15': 'Release 2026-10-15',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(sanitize(input), expected, input);
});

test('a title of many kilobytes is cut before the patterns run: it returns in time and never shows past 500 characters', () => {
  const started = performance.now();
  const out = sanitize('1 '.repeat(10000));
  assert.ok(performance.now() - started < 500, 'bounded time');
  assert.ok(out.length <= 80);
  assert.equal(sanitize('w '.repeat(300) + 'TAILWORD', 2000).includes('TAILWORD'), false, 'past 500 characters is not read');
});

test('the deadline of the dispatcher is capped at 50 seconds, below the 60 that wake.ts allows', () => {
  assert.equal(notifySettings({ sections: {} }, { CLEARED_NOTIFY_DEADLINE_SECONDS: '50' }).deadlineMs, 50000);
  assert.throws(() => notifySettings({ sections: {} }, { CLEARED_NOTIFY_DEADLINE_SECONDS: '51' }), /DEADLINE_SECONDS/);
});

test('the dispatcher does not inherit the wake lock: a child that outlives the kill cannot hold it', () => {
  const wake = readFileSync(join(ORCH_HOME, 'wake.ts'), 'utf8');
  const dispatch = wake.split('\n').filter((line) => line.includes("'notify.ts'), 'dispatch'"));
  assert.equal(dispatch.length, 1, 'one dispatcher call');
  assert.match(dispatch[0]!, /spawnSync\('timeout', \['-k', '5', '60', /, 'stopped after 60 seconds, killed 5 seconds later');
  // The lock is a descriptor of the wake that flock(1) took, and Node opens it close-on-exec: a child started while
  // the wake holds it, and still running once the wake let it go, does not keep it.
  const dir = scratch('cleared-wake-lock-');
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { lockFile } = await import(${JSON.stringify(new URL('../lib/script.ts', import.meta.url).href)});
    const { spawn, spawnSync } = await import('node:child_process');
    const held = lockFile(${JSON.stringify(join(dir, 'lock'))}, 0);
    const busy = spawnSync('flock', ['-n', ${JSON.stringify(join(dir, 'lock'))}, 'true']).status;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    held.release();
    const free = spawnSync('flock', ['-n', ${JSON.stringify(join(dir, 'lock'))}, 'true']).status;
    child.kill();
    process.stdout.write(busy + ' ' + free);`], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '1 0', `${probe.stderr}: held by the wake, and free once it lets go though its child still runs`);
});

test('serve/install.ts warns when CLEARED_NOTIFY_LINK_BASE is not set, and is silent when it is', () => {
  const install = readFileSync(join(ORCH_HOME, 'serve', 'install.ts'), 'utf8');
  const line = install.split('\n').find((l) => l.includes('WARNING: CLEARED_NOTIFY_LINK_BASE is not set'));
  assert.ok(line, 'the check is in the installer');
  assert.match(line, /^\s*if \(!process\.env\.CLEARED_NOTIFY_LINK_BASE\) say\('WARNING: CLEARED_NOTIFY_LINK_BASE is not set/, 'said only when the shell has no link');
});

test('each kind reads as a product sentence, in English and in French; health names a known code only', () => {
  const en = (o: Occurrence) => render(o, { language: 'en' }), fr = (o: Occurrence) => render(o, { language: 'fr' });
  assert.deepEqual([en({ kind: 'approval', ticket: 'EX-1', title: 'Rename' }).title, en({ kind: 'approval', ticket: 'EX-1', title: 'Rename' }).body], ['Ready to land', 'EX-1 · Rename waits for your agreement.']);
  assert.equal(fr({ kind: 'question', ticket: 'EX-1', title: 'Renommer' }).body, 'EX-1 · Renommer : ouvrez-le pour répondre.');
  assert.equal(fr({ kind: 'blocked', ticket: 'EX-1', title: 'Renommer', minutes: 42 }).body, 'EX-1 · Renommer est bloqué depuis 42 min.');
  assert.equal(en({ kind: 'health', code: 'lane_idle' }).body, 'Cleared: a team has not moved for a while.');
  assert.equal(en({ kind: 'health', code: '/etc/shadow' }).body, 'Cleared: a health problem was detected.');
  assert.equal(fr({ kind: 'rollback', ticket: 'EX-3', title: 'Paiement' }).title, 'Retour arrière');
  assert.deepEqual(URGENT, ['rollback', 'health']);
  for (const kind of KINDS) assert.ok(en({ kind, ticket: 'EX-1' }).title && fr({ kind, ticket: 'EX-1' }).title);
});

test('quiet hours are read on the configured clock, across midnight, and a malformed range is refused', () => {
  const settings = notifySettings({ sections: { notify: { quiet_hours: '22:00-07:00', timezone: 'Europe/Paris' } } });
  assert.equal(isQuiet(settings, Date.parse('2026-10-15T21:30:00Z')), true, '23:30 in Paris');
  assert.equal(isQuiet(settings, Date.parse('2026-10-15T04:59:00Z')), true, '06:59 in Paris');
  assert.equal(isQuiet(settings, Date.parse('2026-10-15T05:00:00Z')), false, '07:00 in Paris');
  assert.equal(isQuiet(notifySettings({ sections: {} }), Date.parse('2026-10-15T02:00:00Z')), false, 'none by default');
  for (const bad of ['22-07', '22:00', '25:00-07:00', '07:00-07:00']) assert.throws(() => notifySettings({ sections: { notify: { quiet_hours: bad } } }), /quiet_hours/, bad);
});

// ---- the secrets ---------------------------------------------------------------

test('the service settings a project must not choose (sendmail, push_hosts, link_base) come from the environment only', () => {
  const hostile = { sections: { notify: { sendmail: '/tmp/evil-sendmail', push_hosts: 'push.evil.example', link_base: 'https://phish.example' }, app: { public_origin: 'https://phish.example' } } };
  const settings = notifySettings(hostile, {});
  assert.equal(settings.sendmail, sendmailDefault(), 'agents.conf names no mail program');
  assert.deepEqual(settings.pushHosts, [], 'agents.conf adds no push host');
  assert.equal(settings.linkBase, '', 'agents.conf sets no link, not even through [app] public_origin');
  assert.equal(settings.subject, '', 'nor a contact');
  const service = notifySettings(hostile, { CLEARED_NOTIFY_SENDMAIL: '/opt/msmtp/bin/sendmail', CLEARED_NOTIFY_PUSH_HOSTS: 'Push.Example.org, relay.example',
    CLEARED_NOTIFY_LINK_BASE: 'https://cockpit.example.ts.net/' });
  assert.equal(service.sendmail, '/opt/msmtp/bin/sendmail');
  assert.deepEqual(service.pushHosts, ['push.example.org', 'relay.example']);
  assert.equal(service.linkBase, 'https://cockpit.example.ts.net');
  assert.equal(notifySettings({ sections: {} }, { ORCH_NOTIFY_LINK_BASE: 'https://old.example.ts.net' }).linkBase, 'https://old.example.ts.net', 'the ORCH_ name is read too, as the Telegram address');
  assert.throws(() => notifySettings({ sections: {} }, { CLEARED_NOTIFY_SENDMAIL: 'sendmail' }), /CLEARED_NOTIFY_SENDMAIL must be an absolute path/);
});

test('the default mail program is the first well-known path that is a file no one else can write', () => {
  const root = scratch('cleared-sendmail-');
  const open = join(root, 'open-sendmail'), mine = join(root, 'sendmail'), absent = join(root, 'absent');
  writeFileSync(open, '#!/bin/sh\n');
  writeFileSync(mine, '#!/bin/sh\n');
  chmodSync(open, 0o777);
  chmodSync(mine, 0o755);
  assert.equal(sendmailDefault([absent, open, mine]), mine, 'a world-writable file is skipped');
  assert.equal(sendmailDefault([absent, root]), null, 'a directory or a missing file is not a mail program');
  assert.equal(emailAdapter({ credentials: () => ({ to: 'owner@example.org' }), sendmail: null }).ready(), 'no_sendmail');
  assert.equal(notifySettings({ sections: {} }, {}).sendmail, sendmailDefault(), 'the settings use the same default');
});

test('the secrets directory is private: keys made once (0600), subscriptions capped, anything looser or inside the project refused', () => {
  const root = scratch('cleared-notify-');
  const dir = join(root, 'notify');
  const store = notifyStore(dir, { create: true });
  const keys = store.vapid();
  assert.deepEqual(store.vapid(), keys, 'never replaced');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'vapid.json')).mode & 0o777, 0o600);
  for (let i = 0; i < 12; i += 1) store.subscribe({ endpoint: `${endpoint}${i}`, keys: browser().keys }, 'iPhone · 3fa1');
  assert.equal(store.subscriptions().length, 10);
  assert.equal(statSync(join(dir, 'subscriptions.json')).mode & 0o777, 0o600);
  assert.equal(store.forget(`${endpoint}11`), 1);
  assert.equal(notifyStore(join(root, 'absent')).subscriptions().length, 0, 'nothing yet is no subscription');
  assert.throws(() => notifyStore(join(root, 'absent')).vapid(), 'keys are made only when asked for');
  chmodSync(dir, 0o750);
  assert.throws(() => notifyStore(dir).vapid(), /private directory/);
  assert.deepEqual(notifyStore(dir).subscriptions(), [], 'a loose directory is not read');
  chmodSync(dir, 0o700);
  chmodSync(join(dir, 'vapid.json'), 0o644);
  assert.throws(() => notifyStore(dir).vapid(), /private regular file/);
  const project = scratch('cleared-project-');
  mkdirSync(join(project, 'notify'), { mode: 0o700 });
  assert.throws(() => notifyStore(join(project, 'notify'), { project }).vapid(), /outside the project/);
  assert.throws(() => notifyStore('relative/notify').vapid(), /absolute/);
});

test('subscriptions are changed under a lock (flock): the app and the dispatcher changing them at once lose nothing', async () => {
  const dir = join(scratch('cleared-notify-lock-'), 'notify');
  const store = notifyStore(dir, { create: true });
  store.forget('none');
  const lock = join(dir, 'subscriptions.lock');
  assert.equal(statSync(lock).mode & 0o777, 0o600);
  // Two processes adding four devices each, at the same time.
  const child = (from: number) => new Promise((resolve) => {
    const code = `const { notifyStore } = await import(${JSON.stringify(join(ORCH_HOME, 'lib', 'notify', 'store.ts'))});
      const { createECDH } = await import('node:crypto');
      const s = notifyStore(${JSON.stringify(dir)});
      for (let i = ${from}; i < ${from} + 4; i += 1) { const e = createECDH('prime256v1'); e.generateKeys();
        s.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/p' + i, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: Buffer.from('0123456789abcdef').toString('base64url') } }, 'dev'); }`;
    spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' }).on('close', resolve);
  });
  assert.deepEqual(await Promise.all([child(0), child(100)]), [0, 0]);
  assert.equal(store.subscriptions().length, 8, 'every device of both processes is kept');
  // While another process holds the lock, a change waits for it.
  const holder = spawn('flock', ['-x', lock, 'sleep', '0.6'], { stdio: 'ignore' });
  while (spawnSync('flock', ['-n', lock, 'true']).status === 0) await new Promise((r) => { setTimeout(r, 10); });
  const started = Date.now();
  assert.equal(store.forget('https://fcm.googleapis.com/fcm/send/p0'), 1);
  assert.ok(Date.now() - started >= 300, 'the change waited for the lock');
  await new Promise((r) => { holder.on('close', r); });
  assert.equal(store.subscriptions().length, 7);
});

// ---- the dispatcher ------------------------------------------------------------

const T0 = Date.parse('2026-10-15T09:00:00Z');
const minute = 60000;
type Ticket = ReturnType<typeof ready> | ReturnType<typeof question>;
type Snap = { schema: number; tickets: Ticket[] };
type Done = Awaited<ReturnType<typeof dispatch>>;
type EventRow = { ticket: string | null; detail: string; value: number; source: string };
type Box = {
  db: DatabaseSync; settings: NotifySettings; snapshot: Snap; sent: NotifyMessage[]; adapters: Adapter[];
  run: (at: number, extra?: { deadlineMs?: number }) => Promise<Done>; rows: (kind: string) => EventRow[];
};
// snapshot: null is the test of no snapshot yet, which sets one before it reads its tickets.
function setup({ notify = {}, snapshot = { schema: 1, tickets: [] } }: { notify?: Record<string, string>; snapshot?: Snap | null } = {}) {
  const db = openLedger(':memory:');
  const settings = notifySettings({ sections: { notify, owner: { language: 'en' } } }, LINK_ENV);
  const sent: NotifyMessage[] = [];
  const fake = { name: 'fake', ready: () => null, send: async (message: NotifyMessage) => { sent.push(message); } };
  const box = { db, settings, snapshot: snapshot as Snap, sent, adapters: [fake] } as Box;
  box.run = (at, extra = {}) => dispatch({ db, settings: box.settings, snapshot: box.snapshot, adapters: box.adapters, now: at, ...extra });
  box.rows = (kind) => db.prepare('SELECT ticket, detail, value, source FROM events WHERE kind = ? ORDER BY event_id').all(kind) as EventRow[];
  return box;
}
const ready = (id: string, title: string, at: string) => ({ id, ref: id, title, kind: 'ready', waiting: true, since: at, approval: { at, versions: [{ pr: 7, head: 'a'.repeat(40) }] } });
const question = (id: string, title: string, at: string) => ({ id, ref: id, title, kind: 'question', waiting: true, since: at });

test('the first dispatch sends nothing (no backlog), then every kind of event is sent once, and each send is a ledger row', async () => {
  const box = setup();
  box.snapshot.tickets = [ready('EX-1', 'Old request', iso(T0 - 60 * minute))];
  addEvent(box.db, { kind: 'rollback_pushed', ticket: 'EX-0', at: iso(T0 - 90 * minute) });
  await box.run(T0);
  assert.equal(box.sent.length, 0, 'what existed before notifications were on is not sent');

  box.snapshot.tickets = [ready('EX-1', 'Old request', iso(T0 - 60 * minute)), ready('EX-2', 'Rename the save button', iso(T0)), question('EX-3', 'Pick a colour', iso(T0))];
  addEvent(box.db, { kind: 'rollback_pushed', ticket: 'EX-4', at: iso(T0), detail: `${'a'.repeat(40)} reverted by ${'b'.repeat(40)}` });
  addEvent(box.db, { kind: 'heartbeat_problem', at: iso(T0), detail: `lane_idle:dev/EX-5 ${SECRET_PATH}` });
  runStart(box.db, { runId: 'r6', ticket: 'EX-6', role: 'dev', startedAt: iso(T0 - 120 * minute) });
  addEvent(box.db, { kind: 'lane_stuck', ticket: 'EX-6', at: iso(T0 - 45 * minute), detail: `the lane of EX-6 ... ${TOKEN}` });
  const done = await box.run(T0 + minute);
  assert.deepEqual(box.sent.map((m) => `${m.kind} ${m.ticket ?? m.group}`).sort(), ['approval EX-2', 'blocked EX-6', 'health health:lane_idle', 'question EX-3', 'rollback EX-4']);
  assert.equal(done.sent.length, 5);
  for (const message of box.sent) clean(JSON.stringify(message));
  assert.equal(box.sent.find((m) => m.kind === 'blocked')!.body, 'EX-6 has been blocked for 46 min.');
  const rows = box.rows('notification_sent');
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.source, 'notify');
    assert.deepEqual(Object.keys(JSON.parse(row.detail)), ['event', 'adapter']);
    assert.ok(Number.isFinite(row.value), 'seconds since what it tells happened');
  }
  assert.deepEqual(rows.map((r) => r.ticket ?? '').sort(), ['', 'EX-2', 'EX-3', 'EX-4', 'EX-6'], 'a health problem of no ticket has none');
  assert.equal(rows.find((r) => r.ticket === 'EX-2')!.value, 60);
  await box.run(T0 + 30 * minute);
  assert.equal(box.sent.length, 5, 'the same occurrence is never sent twice');
});

test('no snapshot yet: the first dispatch initialises nothing, so cards that already exist when it appears are noted, not sent as a backlog', async () => {
  const box = setup({ snapshot: null });
  await box.run(T0);
  assert.equal(box.db.prepare("SELECT value FROM notify_state WHERE key = 'cursor'").get(), undefined, 'no cursor while the snapshot is missing');
  assert.equal((box.db.prepare('SELECT COUNT(*) n FROM notify_queue').get() as { n: number }).n, 0, 'no seen state either');
  box.snapshot = { schema: 1, tickets: [ready('EX-1', 'Old request', iso(T0 - 60 * minute)), question('EX-3', 'Pick a colour', iso(T0 - 30 * minute))] };
  await box.run(T0 + minute);
  assert.equal(box.sent.length, 0, 'the cards that existed before the snapshot is read are not sent');
  box.snapshot.tickets.push(ready('EX-2', 'Rename the save button', iso(T0 + 2 * minute)));
  await box.run(T0 + 3 * minute);
  assert.deepEqual(box.sent.map((m) => m.ticket), ['EX-2'], 'only the request that is new since the first dispatch');
});

test('a rollback with no valid ticket has its own group: it is not held behind a health problem of no ticket', async () => {
  const box = setup();
  await box.run(T0);
  addEvent(box.db, { kind: 'rollback_pushed', ticket: null, at: iso(T0), detail: `${'c'.repeat(40)} reverted` });
  addEvent(box.db, { kind: 'heartbeat_problem', at: iso(T0), detail: 'an_unknown_code' });
  await box.run(T0 + minute);
  assert.deepEqual(box.sent.map((m) => m.kind).sort(), ['health', 'rollback'], 'both are sent');
  assert.deepEqual(box.sent.map((m) => m.group).sort(), ['health:other', 'rollback:none']);
});

test('at most one notification per ticket every ten minutes: a second event waits, then goes; two at once are folded into one', async () => {
  const box = setup();
  await box.run(T0);
  box.snapshot.tickets = [question('EX-3', 'Pick a colour', iso(T0))];
  await box.run(T0 + minute);
  assert.equal(box.sent.length, 1);
  box.snapshot.tickets = [ready('EX-3', 'Pick a colour', iso(T0 + 3 * minute))];
  const held = await box.run(T0 + 4 * minute);
  assert.equal(box.sent.length, 1, 'held: the ticket was told about four minutes ago');
  assert.equal(held.held.length, 1);
  await box.run(T0 + 10 * minute);
  assert.equal(box.sent.length, 1);
  await box.run(T0 + 11 * minute);
  assert.deepEqual(box.sent.map((m) => m.kind), ['question', 'approval'], 'sent once the ten minutes are over');
  box.snapshot.tickets = [ready('EX-8', 'A', iso(T0 + 30 * minute)), question('EX-8', 'A', iso(T0 + 30 * minute))];
  addEvent(box.db, { kind: 'release_health_failing', ticket: 'EX-8', at: iso(T0 + 30 * minute) });
  await box.run(T0 + 31 * minute);
  assert.deepEqual(box.sent.slice(2).map((m) => m.kind), ['health'], 'three at once for one ticket: one notification, the most pressing');
  box.snapshot.tickets = [ready('EX-9', 'B', iso(T0 + 40 * minute))];
  await box.run(T0 + 41 * minute);
  addEvent(box.db, { kind: 'rollback_pushed', ticket: 'EX-9', at: iso(T0 + 42 * minute) });
  await box.run(T0 + 43 * minute);
  assert.deepEqual(box.sent.slice(3).map((m) => `${m.kind} ${m.ticket}`), ['approval EX-9', 'rollback EX-9'], 'a rollback is not held behind a request told two minutes before');
  const configured = setup({ notify: { coalesce_minutes: '2' } });
  await configured.run(T0);
  configured.snapshot.tickets = [question('EX-3', 'Pick', iso(T0))];
  await configured.run(T0 + minute);
  configured.snapshot.tickets = [ready('EX-3', 'Pick', iso(T0 + 2 * minute))];
  await configured.run(T0 + 3 * minute + 1);
  assert.equal(configured.sent.length, 2, '[notify] coalesce_minutes sets the window');
});

test('quiet hours hold approval, question and blocked until they end, but never a rollback or a health problem', async () => {
  const box = setup({ notify: { quiet_hours: '22:00-07:00', timezone: 'UTC' } });
  const night = Date.parse('2026-10-15T23:00:00Z');
  await box.run(night);
  box.snapshot.tickets = [ready('EX-2', 'Rename', iso(night)), question('EX-3', 'Pick', iso(night))];
  addEvent(box.db, { kind: 'rollback_pushed', ticket: 'EX-4', at: iso(night) });
  addEvent(box.db, { kind: 'heartbeat_problem', at: iso(night), detail: 'wake_failed:wake' });
  addEvent(box.db, { kind: 'rollback_health_still_failing', ticket: 'EX-4', at: iso(night) });
  await box.run(night + minute);
  assert.deepEqual(box.sent.map((m) => m.kind).sort(), ['health', 'rollback'], 'rollback and health go through the night');
  await box.run(Date.parse('2026-10-16T06:59:00Z'));
  assert.equal(box.sent.length, 2);
  box.snapshot.tickets = [ready('EX-2', 'Rename', iso(night))]; // the question was answered during the night
  await box.run(Date.parse('2026-10-16T07:00:00Z'));
  assert.deepEqual(box.sent.map((m) => m.kind).sort(), ['approval', 'health', 'rollback'], 'what still waits is told at the end of the quiet hours; what was settled is not');
});

test('a kind turned off is never sent; a card that stops waiting is dropped; an old occurrence expires; the blocked threshold is configurable', async () => {
  const box = setup({ notify: { events: 'approval, rollback, health', blocked_minutes: '60' } });
  await box.run(T0);
  box.snapshot.tickets = [question('EX-3', 'Pick', iso(T0))];
  runStart(box.db, { runId: 'r6', ticket: 'EX-6', role: 'dev', startedAt: iso(T0 - 120 * minute) });
  addEvent(box.db, { kind: 'lane_limit_reached', ticket: 'EX-7', at: iso(T0 - 40 * minute) });
  await box.run(T0 + minute);
  assert.equal(box.sent.length, 0, 'question is off; EX-7 has waited 41 minutes for a place, under the hour');
  box.settings = { ...box.settings, events: [...box.settings.events, 'blocked'] };
  await box.run(T0 + 21 * minute);
  assert.deepEqual(box.sent.map((m) => `${m.kind} ${m.ticket}`), ['blocked EX-7']);
  // A team that opened again is no longer blocked.
  addEvent(box.db, { kind: 'lane_limit_reached', ticket: 'EX-9', at: iso(T0) });
  runStart(box.db, { runId: 'r9', ticket: 'EX-9', role: 'dev', startedAt: iso(T0 + 30 * minute) });
  await box.run(T0 + 80 * minute);
  assert.equal(box.sent.length, 1);
  // Held by the quiet hours longer than a day: no longer news.
  const quiet = setup({ notify: { quiet_hours: '00:00-23:59', timezone: 'UTC' } });
  await quiet.run(T0);
  quiet.snapshot.tickets = [ready('EX-2', 'Rename', iso(T0))];
  await quiet.run(T0 + minute);
  quiet.settings = { ...quiet.settings, quiet: null };
  await quiet.run(T0 + minute + EXPIRE_MS + 1);
  assert.equal(quiet.sent.length, 0, 'expired');
});

test('no adapter ready: nothing waits to be sent later; a failing adapter is tried three times and each failure says a code only', async () => {
  const box = setup();
  box.adapters = [{ name: 'webpush', ready: () => 'no_subscription', send: async () => assert.fail('not ready') }];
  await box.run(T0);
  box.snapshot.tickets = [ready('EX-2', 'Rename', iso(T0))];
  await box.run(T0 + minute);
  box.adapters = [{ name: 'fake', ready: () => null, send: async (m) => box.sent.push(m) }];
  await box.run(T0 + 2 * minute);
  assert.equal(box.sent.length, 0, 'subscribing later brings no backlog');
  box.snapshot.tickets = [ready('EX-5', 'Rename', iso(T0 + 3 * minute))];
  box.adapters = [{ name: 'ntfy', ready: () => null, send: async () => { throw new Error(`connect to ${SECRET_PATH} with ${TOKEN}`); } }];
  for (let i = 0; i < 5; i += 1) await box.run(T0 + (4 + i) * minute);
  const failures = box.rows('notification_failed');
  assert.equal(failures.length, 3);
  for (const row of failures) assert.deepEqual(JSON.parse(row.detail), { event: 'approval', adapter: 'ntfy', reason: 'failed' });
  assert.equal(box.rows('notification_sent').length, 0);
});

test('the dispatcher keeps to its deadline: a send that hangs is given up, waits for the next wake (not a try, not sent) and goes then', async () => {
  const box = setup();
  await box.run(T0);
  box.snapshot.tickets = [ready('EX-7', 'Rename', iso(T0)), question('EX-8', 'Pick a colour', iso(T0))];
  let calls = 0;
  // A carrier that never answers and ignores the abort.
  box.adapters = [{ name: 'webpush', ready: () => null, send: () => { calls += 1; return new Promise(() => {}); } }];
  const started = Date.now();
  const done = await box.run(T0 + minute, { deadlineMs: 100 });
  assert.ok(Date.now() - started < 2000, 'the dispatch returns at its deadline');
  assert.equal(calls, 1, 'nothing more is started once the deadline is past');
  assert.deepEqual([done.sent.length, done.failed.length, done.held.length], [0, 0, 2]);
  assert.deepEqual(box.db.prepare("SELECT state, attempts FROM notify_queue WHERE state != 'seen' ORDER BY key").all().map((r) => ({ ...r })), [{ state: 'pending', attempts: 0 }, { state: 'pending', attempts: 0 }]);
  assert.equal(box.rows('notification_sent').length + box.rows('notification_failed').length, 0, 'neither sent nor failed');
  box.adapters = [{ name: 'fake', ready: () => null, send: async (m) => box.sent.push(m) }];
  await box.run(T0 + 2 * minute);
  assert.deepEqual(box.sent.map((m) => m.ticket).sort(), ['EX-7', 'EX-8']);
  // The service's environment sets it, never agents.conf.
  assert.equal(notifySettings({ sections: {} }, {}).deadlineMs, 30000);
  assert.equal(notifySettings({ sections: { notify: { deadline_seconds: '900' } } }, { CLEARED_NOTIFY_DEADLINE_SECONDS: '5' }).deadlineMs, 5000);
  assert.throws(() => notifySettings({ sections: {} }, { CLEARED_NOTIFY_DEADLINE_SECONDS: '0' }), /DEADLINE_SECONDS/);
  assert.throws(() => notifySettings({ sections: {} }, { CLEARED_NOTIFY_DEADLINE_SECONDS: 'soon' }), /DEADLINE_SECONDS/);
});

test('Web Push tells a few browsers at a time, and starts none once the deadline aborts', async () => {
  const subscriptions = Array.from({ length: 9 }, (_, i) => ({ endpoint: `${endpoint}${i}`, keys: browser().keys }));
  let open = 0, most = 0, calls = 0;
  const quick = webpushAdapter({ store: memoryStore(subscriptions), subject: 'mailto:ops@example.org', transport: async () => {
    calls += 1; open += 1; most = Math.max(most, open);
    await new Promise((r) => { setTimeout(r, 20); });
    open -= 1;
    return { ok: true, status: 201 };
  } });
  assert.deepEqual(await quick.send(render({ kind: 'approval', ticket: 'EX-1', title: 'Rename' })), { delivered: 9 });
  assert.equal(calls, 9);
  assert.ok(most > 1 && most <= 4, `at most four at once (${most})`);
  calls = 0;
  const hanging = webpushAdapter({ store: memoryStore(subscriptions), subject: 'mailto:ops@example.org',
    transport: (_url, init) => { calls += 1; return new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error('aborted'))); }); } });
  const box = setup();
  await box.run(T0);
  box.snapshot.tickets = [ready('EX-9', 'Rename', iso(T0))];
  box.adapters = [hanging];
  const done = await box.run(T0 + minute, { deadlineMs: 100 });
  assert.equal(calls, 4, 'the first four, then nothing new');
  assert.equal(done.held.length, 1);
});

test('a notification delivered is not sent again when the ledger cannot record it: the failure is said on the log, by its kind only', async (t) => {
  const box = setup();
  await box.run(T0);
  box.snapshot.tickets = [ready('EX-10', `Leak ${SECRET_PATH}`, iso(T0))];
  // The ledger refuses the notification events (full, locked): the queue itself still works.
  box.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON events WHEN NEW.kind LIKE 'notification%' BEGIN SELECT RAISE(ABORT, 'ledger refuses'); END");
  const said: string[] = [];
  t.mock.method(console, 'error', (line: unknown) => said.push(String(line)));
  const done = await box.run(T0 + minute);
  assert.equal(done.sent.length, 1);
  assert.deepEqual(done.failed, []);
  assert.deepEqual(said, ['cleared: notifications: a notification_sent event could not be written to the ledger']);
  box.db.exec('DROP TRIGGER refuse');
  await box.run(T0 + 30 * minute);
  assert.equal(box.sent.length, 1, 'sent once');
  assert.equal((box.db.prepare("SELECT state FROM notify_queue WHERE key LIKE 'approval:EX-10:%'").get() as { state: string }).state, 'sent');
});

test('an agent cannot trigger a notification: the command takes no text, and what a team writes never reaches the message', () => {
  for (const args of [['dispatch', 'Your password is ...'], ['send', 'hello'], ['dispatch', '--title', 'x'], ['test', 'Your password is ...'], []]) {
    const run = spawnSync(process.execPath, [join(ORCH_HOME, 'lib', 'notify.ts'), ...args], { encoding: 'utf8', env: { ...process.env, CLEARED_CONF: join(ORCH_HOME, 'agents.example.conf') } });
    assert.notEqual(run.status, 0, args.join(' '));
    assert.match(run.stderr, /usage: notify\.ts dispatch/);
  }
  const code = readFileSync(join(ORCH_HOME, 'lib', 'notify.ts'), 'utf8');
  assert.doesNotMatch(code.replace(/\/\/.*$/gm, ''), /process\.env\.[A-Z_]*(?:TITLE|BODY|MESSAGE|TEXT)/, 'nothing read from the environment becomes text');
  // What a team asks is a lane_asks event: the dispatcher reads the board's Question card (title only), never the event.
  assert.doesNotMatch(code, /lane_asks/);
});

const iso = (ms: number) => new Date(ms).toISOString();

test('notify.ts test sends the fixed test message to each adapter and says, per adapter, sent, not ready or failed by a code', async () => {
  const box = setup();
  const got: NotifyMessage[] = [];
  const lines = await sendTest({ db: box.db, settings: box.settings, now: T0, adapters: [
    { name: 'webpush', ready: () => 'no_subscription', send: async () => assert.fail('not ready') },
    { name: 'ntfy', ready: () => null, send: async (m) => got.push(m) },
    { name: 'telegram', ready: () => null, send: async () => { throw new Error(`bot ${TOKEN} at ${SECRET_PATH}`); } },
  ] });
  assert.deepEqual(lines, ['webpush: not ready (no_subscription)', 'ntfy: sent', 'telegram: failed (failed)']);
  assert.deepEqual(got, [{ kind: 'test', ticket: null, group: 'test', urgent: false, title: 'Notifications are on', body: 'This device will be told when something waits for you.', url: 'https://cockpit.example.ts.net/' }]);
  assert.deepEqual(box.rows('notification_sent').map((r) => JSON.parse(r.detail)), [{ event: 'test', adapter: 'ntfy' }]);
});

test('a real wake dispatches: the first one takes note, the next one tells ntfy about a rollback, with no secret in it', async (t) => {
  const { sandbox } = await import('./support.ts');
  const { createServer } = await import('node:http');
  const { appendFileSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const box = sandbox();
  const posts: { url: string | undefined; auth: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => { let body = ''; request.on('data', (c) => { body += c; }); request.on('end', () => { posts.push({ url: request.url, auth: request.headers.authorization, body }); response.writeHead(200).end('{}'); }); }) as Omit<ReturnType<typeof createServer>, 'address'> & { address(): AddressInfo };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const secrets = join(scratch('cleared-notify-secrets-'), 'notify');
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, 'credentials.json'), JSON.stringify({ ntfy: { server: `http://127.0.0.1:${server.address().port}`, topic: 'cleared-test', token: 'tk_abcdefgh12345' } }), { mode: 0o600 });
  appendFileSync(join(box.home, 'agents.conf'), `\n[notify]\nadapters = ntfy\nsecrets_dir = ${secrets}\n`);
  const wake = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(join(box.home, 'wake.ts'), [], { env: { ...box.env, ...LINK_ENV } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal((await wake()).code, 0);
  assert.equal(posts.length, 0, 'the first wake takes note');
  const db = openLedger(join(box.state, 'ledger.db'));
  addEvent(db, { kind: 'rollback_pushed', ticket: 'X-4', detail: `${'a'.repeat(40)} reverted; see ${SECRET_PATH}` });
  db.close();
  const second = await wake();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.auth, 'Bearer tk_abcdefgh12345');
  const sent = JSON.parse(posts[0]!.body);
  assert.equal(sent.topic, 'cleared-test');
  assert.equal(sent.click, 'https://cockpit.example.ts.net/#ticket=X-4');
  clean(posts[0]!.body);
  const check = openLedger(join(box.state, 'ledger.db'));
  const row = check.prepare("SELECT ticket, detail FROM events WHERE kind = 'notification_sent'").get() as { ticket: string | null; detail: string };
  check.close();
  assert.deepEqual({ ...row, detail: JSON.parse(row.detail) }, { ticket: 'X-4', detail: { event: 'rollback', adapter: 'ntfy' } });
  assert.doesNotMatch(second.stderr, /tk_abcdefgh|cleared-test|notify\//, 'nothing of the secrets on the wake output');
});

test('a failed schedule run has its own health line, in English and in French (P34), not the unknown-code sentence', () => {
  const en = render({ kind: 'health', code: 'schedule_failed' }, { language: 'en' });
  const fr = render({ kind: 'health', code: 'schedule_failed' }, { language: 'fr' });
  assert.equal(en.body, 'Cleared: a scheduled run failed.');
  assert.equal(fr.body, 'Cleared : une exécution planifiée a échoué.');
  assert.notEqual(en.body, render({ kind: 'health', code: 'unknown' }, { language: 'en' }).body);
  assert.notEqual(fr.body, render({ kind: 'health', code: 'unknown' }, { language: 'fr' }).body);
});
