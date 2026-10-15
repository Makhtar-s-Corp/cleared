import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { addEvent, openLedger, runStart } from '../lib/ledger.mjs';
import { createAdapters, isQuiet, KINDS, notifySettings, render, sanitize, URGENT } from '../lib/notify/contract.mjs';
import { encrypt, newVapidKeys, pushHostAllowed, validSubscription, vapidHeader, webpushAdapter } from '../lib/notify/adapters/webpush.mjs';
import { ntfyAdapter } from '../lib/notify/adapters/ntfy.mjs';
import { telegramAdapter } from '../lib/notify/adapters/telegram.mjs';
import { emailAdapter } from '../lib/notify/adapters/email.mjs';
import { notifyStore } from '../lib/notify/store.mjs';
import { dispatch, EXPIRE_MS } from '../lib/notify.mjs';
import { scratch } from './support.mjs';

// Values a notification must never carry, whatever a ticket says.
const SECRET_PATH = '/home/cleared/.config/cleared/human/credentials.json';
const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
const LEAKS = [/\/home\//, /credentials\.json/, /ghp_/, /0123456789abcdef/, /1\s?234/, /€/, /hunter2/, /owner@example\.org/, /192\.0\.2\.7/];
const clean = (text) => { for (const leak of LEAKS) assert.doesNotMatch(text, leak, `${leak} in ${JSON.stringify(text)}`); };

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const hkdf = (salt, ikm, info, length) => createHmac('sha256', createHmac('sha256', salt).update(ikm).digest()).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
// The browser's side of RFC 8291, written apart from the sender's: what a phone would read.
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const keys = { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) };
  const read = (body) => {
    const salt = body.subarray(0, 16), length = body[20], asPublic = body.subarray(21, 21 + length), sealed = body.subarray(21 + length);
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
const memoryStore = (subscriptions = [], credentials = {}) => {
  const keys = newVapidKeys();
  return { vapid: () => keys, subscriptions: () => subscriptions, forget(url) { const i = subscriptions.findIndex((s) => s.endpoint === url); if (i >= 0) subscriptions.splice(i, 1); }, credentials: (name) => credentials[name], keys };
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
  const [, token, k] = /^vapid t=([^,]+), k=(\S+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const body = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(body.aud, 'https://fcm.googleapis.com');
  assert.equal(body.sub, 'mailto:ops@example.org');
  assert.ok(body.exp > now / 1000 && body.exp <= now / 1000 + 24 * 3600, 'expires within a day');
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  assert.equal(Buffer.from(signature, 'base64url').length, 64, 'r and s, not DER');
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
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
  const posts = [];
  const transport = async (url, init) => { posts.push({ url, init }); return { ok: !url.includes('gone'), status: url.includes('gone') ? 410 : 201 }; };
  const adapter = webpushAdapter({ store, subject: 'https://cockpit.example.ts.net', transport });
  assert.equal(adapter.ready(), null);
  const message = render({ kind: 'approval', ticket: 'EX-12', title: 'Rename the save button' }, { linkBase: 'https://cockpit.example.ts.net' });
  await adapter.send(message);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].init.headers['content-encoding'], 'aes128gcm');
  assert.equal(posts[0].init.headers.urgency, 'normal');
  assert.match(posts[0].init.headers.topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.match(posts[0].init.headers.authorization, /^vapid t=/);
  assert.deepEqual(one.read(posts[0].init.body), { title: message.title, body: message.body, url: 'https://cockpit.example.ts.net/#ticket=EX-12', tag: 'EX-12' });
  assert.deepEqual(subscriptions.map((s) => s.endpoint), [endpoint], 'a 410 forgets that browser');
  const refusing = webpushAdapter({ store, subject: 'mailto:ops@example.org', transport: async () => ({ ok: false, status: 400 }) });
  await assert.rejects(refusing.send(message), (error) => !error.message.includes('googleapis') && /refused/.test(error.message));
  assert.equal(webpushAdapter({ store, subject: '', transport }).ready(), 'no_subject');
  assert.equal(webpushAdapter({ store: memoryStore([]), subject: 'mailto:a@b.org', transport }).ready(), 'no_subscription');
});

// ---- the other adapters, same contract ----------------------------------------------

const MESSAGE = render({ kind: 'rollback', ticket: 'EX-4', title: `Fix ${SECRET_PATH} with ${TOKEN}` }, { language: 'fr', linkBase: 'https://cockpit.example.ts.net' });

test('every adapter has the same contract: a name, ready() with a reason when it cannot, send() of the rendered message', async () => {
  const transport = async () => ({ ok: true, status: 200 });
  const empty = memoryStore();
  const settings = notifySettings({ sections: { notify: { adapters: 'webpush, ntfy, email, telegram' }, app: { public_origin: 'https://cockpit.example.ts.net' } } });
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
  const posts = [];
  const credentials = { server: 'https://ntfy.example.org', topic: 'cleared-x7Rk2', token: 'tk_abcdefgh12345' };
  const adapter = ntfyAdapter({ credentials: () => credentials, transport: async (url, init) => { posts.push({ url, init }); return { ok: true, status: 200 }; } });
  assert.equal(adapter.ready(), null);
  await adapter.send(MESSAGE);
  assert.equal(posts[0].url, 'https://ntfy.example.org/');
  assert.equal(posts[0].init.headers.authorization, 'Bearer tk_abcdefgh12345');
  const sent = JSON.parse(posts[0].init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['click', 'message', 'priority', 'tags', 'title', 'topic']);
  assert.equal(sent.topic, 'cleared-x7Rk2');
  assert.equal(sent.priority, 5, 'a rollback is urgent');
  assert.equal(sent.click, 'https://cockpit.example.ts.net/#ticket=EX-4');
  clean(`${sent.title} ${sent.message}`);
  const down = ntfyAdapter({ credentials: () => credentials, transport: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(down.send(MESSAGE), (error) => error.message === 'ntfy refused (403)');
  for (const bad of [{ server: 'http://ntfy.example.org', topic: 'x' }, { server: 'https://a:b@ntfy.example.org', topic: 'x' }, { server: 'https://ntfy.example.org', topic: '../x' }])
    assert.equal(ntfyAdapter({ credentials: () => bad, transport: async () => ({ ok: true }) }).ready(), 'no_credentials', JSON.stringify(bad));
});

test('Telegram posts plain text to the bot; the bot token travels in the address only and no error repeats it', async () => {
  const token = '123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123';
  const posts = [];
  const adapter = telegramAdapter({ credentials: () => ({ bot_token: token, chat_id: '-1001234' }), transport: async (url, init) => { posts.push({ url, init }); return { ok: true, status: 200 }; } });
  await adapter.send(MESSAGE);
  assert.equal(posts[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
  const sent = JSON.parse(posts[0].init.body);
  assert.equal(sent.chat_id, '-1001234');
  assert.equal(sent.parse_mode, undefined, 'nothing is read as markup');
  assert.ok(sent.text.startsWith(MESSAGE.title));
  for (const fail of [async () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${token}`); }, async () => ({ ok: false, status: 401 })]) {
    const broken = telegramAdapter({ credentials: () => ({ bot_token: token, chat_id: '42' }), transport: fail });
    await assert.rejects(broken.send(MESSAGE), (error) => !error.message.includes(token) && !error.message.includes('AAH') && /^telegram (?:unreachable|refused \(401\))$/.test(error.message));
  }
});

test('e-mail goes through sendmail with the recipient as an argument; a title cannot add a header or a recipient', async () => {
  const calls = [];
  const adapter = emailAdapter({ credentials: () => ({ to: 'owner@example.org', from: 'cleared@example.org' }), sendmail: '/usr/sbin/sendmail', run: (file, args, input) => calls.push({ file, args, input }) });
  const evil = render({ kind: 'question', ticket: 'EX-9', title: 'Hi\r\nBcc: thief@example.net\r\n\r\nbody' }, { linkBase: 'https://cockpit.example.ts.net' });
  await adapter.send(evil);
  assert.equal(calls[0].file, '/usr/sbin/sendmail');
  assert.deepEqual(calls[0].args, ['-i', '-f', 'cleared@example.org', '--', 'owner@example.org']);
  const [head] = calls[0].input.split('\r\n\r\n');
  assert.deepEqual(head.split('\r\n').map((line) => line.split(':')[0]), ['From', 'To', 'Subject', 'Date', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'Auto-Submitted']);
  assert.doesNotMatch(calls[0].input, /thief|Bcc/i);
  assert.match(head, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  const failing = emailAdapter({ credentials: () => ({ to: 'owner@example.org' }), run: () => { throw new Error('/usr/sbin/sendmail: exit 75 owner@example.org'); } });
  await assert.rejects(failing.send(evil), (error) => error.message === 'sendmail failed');
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
    'Rename the save button': 'Rename the save button',
    'Login/logout wording, 3 screens': 'Login/logout wording, 3 screens',
    'Un écran « Réglages » à renommer': 'Un écran « Réglages » à renommer',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(sanitize(input), expected, input);
  assert.equal(sanitize('A\u202Egnp.exe\u200B title\nnext'), 'Agnp.exe title next', 'no direction change, invisible character or line break');
  assert.ok(sanitize('x'.repeat(300)).length <= 80);
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

test('each kind reads as a product sentence, in English and in French; health names a known code only', () => {
  const en = (o) => render(o, { language: 'en' }), fr = (o) => render(o, { language: 'fr' });
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

// ---- the dispatcher ------------------------------------------------------------

const T0 = Date.parse('2026-10-15T09:00:00Z');
const minute = 60000;
function setup({ notify = {}, snapshot = { schema: 1, tickets: [] } } = {}) {
  const db = openLedger(':memory:');
  const settings = notifySettings({ sections: { notify, owner: { language: 'en' }, app: { public_origin: 'https://cockpit.example.ts.net' } } });
  const sent = [];
  const fake = { name: 'fake', ready: () => null, send: async (message) => { sent.push(message); } };
  const box = { db, settings, snapshot, sent, adapters: [fake] };
  box.run = (at, extra = {}) => dispatch({ db, settings: box.settings, snapshot: box.snapshot, adapters: box.adapters, now: at, ...extra });
  box.rows = (kind) => db.prepare('SELECT ticket, detail, value, source FROM events WHERE kind = ? ORDER BY event_id').all(kind);
  return box;
}
const ready = (id, title, at) => ({ id, ref: id, title, kind: 'ready', waiting: true, since: at, approval: { at, versions: [{ pr: 7, head: 'a'.repeat(40) }] } });
const question = (id, title, at) => ({ id, ref: id, title, kind: 'question', waiting: true, since: at });

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
  assert.equal(box.sent.find((m) => m.kind === 'blocked').body, 'EX-6 has been blocked for 46 min.');
  const rows = box.rows('notification_sent');
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.source, 'notify');
    assert.deepEqual(Object.keys(JSON.parse(row.detail)), ['event', 'adapter']);
    assert.ok(Number.isFinite(row.value), 'seconds since what it tells happened');
  }
  assert.deepEqual(rows.map((r) => r.ticket ?? '').sort(), ['', 'EX-2', 'EX-3', 'EX-4', 'EX-6'], 'a health problem of no ticket has none');
  assert.equal(rows.find((r) => r.ticket === 'EX-2').value, 60);
  await box.run(T0 + 30 * minute);
  assert.equal(box.sent.length, 5, 'the same occurrence is never sent twice');
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

test('an agent cannot trigger a notification: the command takes no text, and what a team writes never reaches the message', () => {
  for (const args of [['dispatch', 'Your password is ...'], ['send', 'hello'], ['dispatch', '--title', 'x'], []]) {
    const run = spawnSync(process.execPath, [join(ORCH_HOME, 'lib', 'notify.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, CLEARED_CONF: join(ORCH_HOME, 'agents.example.conf') } });
    assert.notEqual(run.status, 0, args.join(' '));
    assert.match(run.stderr, /usage: notify\.mjs dispatch/);
  }
  const code = readFileSync(join(ORCH_HOME, 'lib', 'notify.mjs'), 'utf8');
  assert.doesNotMatch(code.replace(/\/\/.*$/gm, ''), /process\.env\.[A-Z_]*(?:TITLE|BODY|MESSAGE|TEXT)/, 'nothing read from the environment becomes text');
  // What a team asks is a lane_asks event: the dispatcher reads the board's Question card (title only), never the event.
  assert.doesNotMatch(code, /lane_asks/);
});

const iso = (ms) => new Date(ms).toISOString();

test('a real wake dispatches: the first one takes note, the next one tells ntfy about a rollback, with no secret in it', async (t) => {
  const { sandbox } = await import('./support.mjs');
  const { createServer } = await import('node:http');
  const { appendFileSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const box = sandbox();
  const posts = [];
  const server = createServer((request, response) => { let body = ''; request.on('data', (c) => { body += c; }); request.on('end', () => { posts.push({ url: request.url, auth: request.headers.authorization, body }); response.writeHead(200).end('{}'); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const secrets = join(scratch('cleared-notify-secrets-'), 'notify');
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, 'credentials.json'), JSON.stringify({ ntfy: { server: `http://127.0.0.1:${server.address().port}`, topic: 'cleared-test', token: 'tk_abcdefgh12345' } }), { mode: 0o600 });
  appendFileSync(join(box.home, 'agents.conf'), `\n[notify]\nadapters = ntfy\nsecrets_dir = ${secrets}\nlink_base = https://cockpit.example.ts.net\n`);
  const wake = () => new Promise((resolve) => {
    const child = spawn(join(box.home, 'wake.sh'), [], { env: box.env });
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
  assert.equal(posts[0].auth, 'Bearer tk_abcdefgh12345');
  const sent = JSON.parse(posts[0].body);
  assert.equal(sent.topic, 'cleared-test');
  assert.equal(sent.click, 'https://cockpit.example.ts.net/#ticket=X-4');
  clean(posts[0].body);
  const check = openLedger(join(box.state, 'ledger.db'));
  const row = check.prepare("SELECT ticket, detail FROM events WHERE kind = 'notification_sent'").get();
  check.close();
  assert.deepEqual({ ...row, detail: JSON.parse(row.detail) }, { ticket: 'X-4', detail: { event: 'rollback', adapter: 'ntfy' } });
  assert.doesNotMatch(second.stderr, /tk_abcdefgh|cleared-test|notify\//, 'nothing of the secrets on the wake output');
});
