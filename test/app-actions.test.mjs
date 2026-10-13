// The three gestures of the human in the app, and what stands between them and an agent.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { appServer, WRITES } from '../app/server.mjs';
import { demoSource, DEMO_HEAD, DEMO_HEAD_NEXT } from '../app/sources/demo.mjs';
import { createActions } from '../app/lib/actions.mjs';
import { grantServer, requestGrant } from '../app/lib/grant-socket.mjs';
import { Authenticator } from './app-authenticator.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'b'.repeat(64);
const HEAD_A = DEMO_HEAD;
const VERSIONS = [{ pr: 88, head: HEAD_A }];
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function rig({ origin = true, passkeys = true, run } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const demo = demoSource();
  const ran = [], records = [], timers = [];
  let store = [];
  const schedule = (fn, ms) => { const timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer; };
  const cancel = (timer) => { timer.cancelled = true; };
  const actions = createActions({ source: demo, origin: origin ? base : '', owner: 'alice', schedule, cancel,
    readPasskeys: () => store, writePasskeys: (list) => { store = list; },
    run: run ?? (async (request) => { ran.push(request); return { ok: true, author: 'alice', verified: true }; }), record: (entry) => records.push(JSON.parse(entry.detail)) });
  const server = appServer({ source: demo, token: TOKEN, ranges: ['127.0.0.0/8'], pollMs: 50, heartbeatMs: 80, actions, origin: origin ? base : '', owner: 'alice' });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const authenticator = new Authenticator({ origin: base, rpId: '127.0.0.1' });
  const rigged = { base, demo, ran, records, timers, actions, authenticator, close: () => new Promise((r) => { server.close(r); }), store: () => store };
  // A signed-in browser: a session cookie and the anti-forgery token that goes with it.
  rigged.browser = async () => {
    const signedIn = await fetch(`${base}/session`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'user-agent': 'Mozilla/5.0 (iPhone)' } });
    assert.equal(signedIn.status, 204);
    const cookie = signedIn.headers.get('set-cookie').split(';')[0];
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    const post = (path, body = {}, over = {}) => fetch(base + path, { method: 'POST', headers: { cookie, 'x-csrf-token': me.csrf, origin: base, 'content-type': 'application/json', ...over }, body: JSON.stringify(body) });
    const json = async (path, body, over) => { const r = await post(path, body, over); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    return { cookie, csrf: me.csrf, post, json, me };
  };
  // Registers the authenticator's passkey, the way the phone does after `cleared app passkey`.
  rigged.register = async (browser, authn = authenticator) => {
    const { grant } = actions.mintGrant();
    const options = await browser.json('/api/passkeys/options', { grant });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    const done = await browser.json('/api/passkeys/finish', { grant, credential: authn.create(options.body.publicKey) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  };
  rigged.confirmClear = async (browser, over = {}) => {
    const asked = await browser.json('/api/actions/challenge', { gesture: 'clear', ticket: 'EX-31', versions: VERSIONS });
    if (asked.status !== 200) return { asked };
    const confirmed = await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: authenticator.get(asked.body.publicKey), ...over });
    return { asked, confirmed };
  };
  return rigged;
}

test('every write route refuses without a session, without the anti-forgery token, and from another origin; the access token alone writes nothing', async () => {
  const r = await rig();
  try {
    const browser = await r.browser();
    for (const route of WRITES.filter((w) => w !== 'POST /session')) {
      const path = route.slice(5);
      const body = JSON.stringify({});
      const common = { 'content-type': 'application/json' };
      assert.equal((await fetch(r.base + path, { method: 'POST', headers: { ...common, origin: r.base }, body })).status, 401, `no session: ${path}`);
      assert.equal((await fetch(r.base + path, { method: 'POST', headers: { ...common, origin: r.base, authorization: `Bearer ${TOKEN}`, 'x-csrf-token': browser.csrf }, body })).status, 401, `the token is not a session: ${path}`);
      assert.equal((await fetch(r.base + path, { method: 'POST', headers: { ...common, cookie: browser.cookie, origin: r.base }, body })).status, 403, `no anti-forgery token: ${path}`);
      assert.equal((await fetch(r.base + path, { method: 'POST', headers: { ...common, cookie: browser.cookie, origin: r.base, 'x-csrf-token': 'x'.repeat(64) }, body })).status, 403, `wrong anti-forgery token: ${path}`);
      assert.equal((await browser.post(path, {}, { origin: 'https://evil.example' })).status, 403, `another origin: ${path}`);
      assert.equal((await browser.post(path, {}, { origin: undefined })).status, 403, `no origin: ${path}`);
      assert.equal((await browser.post(path, {}, { 'sec-fetch-site': 'cross-site' })).status, 403, `cross-site: ${path}`);
      assert.equal((await browser.post(path, {}, { 'content-type': 'text/plain' })).status, 415, `not json: ${path}`);
    }
    assert.deepEqual(r.ran, [], 'nothing was written');
    // A restart ends sessions; a forged cookie is nothing.
    assert.equal((await fetch(`${r.base}/api/me`, { headers: { cookie: 'cleared_app=' + 'f'.repeat(64) } })).status, 401);
  } finally { await r.close(); }
});

test('the session cookie is HttpOnly and SameSite=Strict, Secure behind a TLS proxy on this machine, and sign-in is rate limited', async () => {
  const r = await rig();
  try {
    const plain = await fetch(`${r.base}/session`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    const cookie = plain.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /Secure/, 'plain http on this machine');
    assert.ok(!cookie.includes(TOKEN));
    const proxied = await fetch(`${r.base}/session`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-proto': 'https' } });
    assert.match(proxied.headers.get('set-cookie'), /; Secure/);
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${r.base}/session`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${r.base}/session`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 204, 'a good token still works');
    assert.equal((await fetch(`${r.base}/session`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 429, 'after ten failures, a pause for wrong tokens');
  } finally { await r.close(); }
});

test('without a registered passkey, or without a secure address, Clear to land and Send back are refused with their reason', async () => {
  let r = await rig();
  try {
    const browser = await r.browser();
    assert.equal(browser.me.actions.confirm, false);
    assert.equal(browser.me.actions.reason, 'no_passkey');
    assert.equal((await browser.json('/api/actions/challenge', { gesture: 'clear', ticket: 'EX-31', versions: VERSIONS })).body.error, 'no_passkey');
  } finally { await r.close(); }
  r = await rig({ origin: false });
  try {
    const browser = await r.browser();
    assert.equal(browser.me.actions.reason, 'insecure');
    assert.equal((await browser.json('/api/actions/challenge', { gesture: 'clear', ticket: 'EX-31', versions: VERSIONS })).body.error, 'insecure');
    assert.equal((await browser.json('/api/passkeys/options', { grant: 'x' })).body.error, 'insecure');
  } finally { await r.close(); }
});

test('a passkey is registered once per grant, from a signed-in session only, and a made-up or reused grant gives nothing', async () => {
  const r = await rig();
  try {
    const browser = await r.browser();
    const other = await r.browser();
    assert.equal((await browser.json('/api/passkeys/options', { grant: 'made-up' })).status, 403);
    const { grant } = r.actions.mintGrant();
    const options = await browser.json('/api/passkeys/options', { grant });
    assert.equal(options.status, 200);
    assert.equal(options.body.publicKey.authenticatorSelection.userVerification, 'required');
    assert.equal(options.body.publicKey.attestation, 'none');
    assert.equal((await other.json('/api/passkeys/options', { grant })).status, 403, 'a grant belongs to the session that redeemed it');
    assert.equal((await other.json('/api/passkeys/finish', { grant, credential: r.authenticator.create(options.body.publicKey) })).status, 403);
    // An authenticator that did not verify the user (no fingerprint, no PIN) is refused.
    const lazy = new Authenticator({ origin: r.base, rpId: '127.0.0.1', verified: false });
    assert.equal((await browser.json('/api/passkeys/finish', { grant, credential: lazy.create(options.body.publicKey) })).status, 403);
    assert.equal(r.store().length, 0);
    const second = r.actions.mintGrant();
    const again = await browser.json('/api/passkeys/options', { grant: second.grant });
    const wrongOrigin = r.authenticator.create(again.body.publicKey, { origin: 'https://evil.example' });
    assert.equal((await browser.json('/api/passkeys/finish', { grant: second.grant, credential: wrongOrigin })).status, 403, 'a ceremony from another origin');
    await r.register(browser);
    assert.equal(r.store().length, 1);
    assert.equal((await browser.json('/api/passkeys/finish', { grant, credential: r.authenticator.create(options.body.publicKey) })).status, 403, 'a grant is single use');
    assert.equal((await r.browser()).me.actions.confirm, true);
  } finally { await r.close(); }
});

test('a passkey confirmation is needed for Clear to land and Send back: no assertion, a wrong key, another challenge, a replay, another session all fail', async () => {
  const r = await rig();
  try {
    const browser = await r.browser();
    await r.register(browser);
    const ask = () => browser.json('/api/actions/challenge', { gesture: 'clear', ticket: 'EX-31', versions: VERSIONS });
    // No assertion at all.
    let asked = await ask();
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId })).status, 403);
    // Challenges are one try: that one is gone.
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: r.authenticator.get(asked.body.publicKey) })).status, 403);
    // A passkey the app does not know (an agent's own software key, say).
    const stranger = new Authenticator({ origin: r.base, rpId: '127.0.0.1' });
    asked = await ask();
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: stranger.get(asked.body.publicKey) })).status, 403);
    // The right key, but signing another challenge than the one issued.
    asked = await ask();
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: r.authenticator.get(asked.body.publicKey, { challenge: 'AAAA' }) })).status, 403);
    // The right key and challenge, but the user was not verified.
    asked = await ask();
    r.authenticator.verified = false;
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: r.authenticator.get(asked.body.publicKey) })).status, 403);
    r.authenticator.verified = true;
    // A challenge asked by one session cannot be answered by another.
    const other = await r.browser();
    asked = await ask();
    assert.equal((await other.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: r.authenticator.get(asked.body.publicKey) })).status, 403);
    // A replayed assertion (the counter does not advance) is refused.
    asked = await ask();
    const good = r.authenticator.get(asked.body.publicKey);
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: good })).status, 200);
    const replay = await ask();
    r.authenticator.counter -= 1;
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: replay.body.challengeId, assertion: r.authenticator.get(replay.body.publicKey) })).status, 403, 'a counter that did not advance');
    assert.deepEqual(r.ran, [], 'nothing was written: the grace delay of the one good confirmation is still running');
    // Send back: the same, and the text confirmed is the text written.
    const back = await browser.json('/api/actions/challenge', { gesture: 'sendback', ticket: 'EX-31', versions: VERSIONS, text: 'Round the figure' });
    assert.equal((await browser.json('/api/actions/confirm', { challengeId: back.body.challengeId, assertion: r.authenticator.get(back.body.publicKey), text: 'Something else entirely' })).body.error, 'text_changed');
    assert.equal((await browser.json('/api/actions/challenge', { gesture: 'sendback', ticket: 'EX-31', versions: VERSIONS, text: '   ' })).status, 400, 'the text is required');
    assert.deepEqual(r.ran, []);
  } finally { await r.close(); }
});

test('Clear to land: the grace delay is held on the server, and the agreement is written for the exact version shown', async () => {
  const r = await rig();
  try {
    const browser = await r.browser();
    await r.register(browser);
    const { confirmed } = await r.confirmClear(browser);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.graceMs, 60000);
    assert.equal(r.timers.length, 1);
    assert.equal(r.timers[0].ms, 60000, 'sixty seconds, on the server');
    assert.deepEqual(r.ran, [], 'nothing is written during the grace delay');
    assert.equal((await r.browser()).me.actions.pending.length, 0, 'another session does not see it');
    assert.equal((await fetch(`${r.base}/api/me`, { headers: { cookie: browser.cookie } }).then((x) => x.json())).actions.pending[0].state, 'waiting');
    await r.timers[0].fn();
    assert.deepEqual(r.ran, [{ op: 'approve', ticket: 'EX-31', versions: VERSIONS }]);
    const written = r.records.find((e) => e.result === 'written');
    assert.equal(written.gesture, 'clear');
    assert.deepEqual(written.version, ['88:a1b2c3d']);
    assert.match(written.device, /^iPhone · [0-9a-f]{4}$/);
    assert.deepEqual(r.records.filter((e) => e.gesture === 'clear').map((e) => e.result), ['confirmed', 'written']);
  } finally { await r.close(); }
});

test('Undo during the grace delay writes nothing; too late is too late', async () => {
  const r = await rig();
  try {
    const browser = await r.browser();
    await r.register(browser);
    const { confirmed } = await r.confirmClear(browser);
    const other = await r.browser();
    assert.equal((await other.json('/api/actions/undo', { pendingId: confirmed.body.pendingId })).status, 404, 'another session cannot undo it');
    assert.equal((await browser.json('/api/actions/undo', { pendingId: confirmed.body.pendingId })).status, 200);
    assert.equal(r.timers[0].cancelled, true);
    await r.timers[0].fn();
    assert.deepEqual(r.ran, [], 'nothing was written');
    assert.deepEqual(r.records.filter((e) => e.gesture === 'clear').map((e) => e.result), ['confirmed', 'undone']);
    // A second gesture, left to run: Undo after the write answers "too late".
    const second = await r.confirmClear(browser);
    await r.timers[1].fn();
    assert.equal(r.ran.length, 1);
    assert.equal((await browser.json('/api/actions/undo', { pendingId: second.confirmed.body.pendingId })).status, 409);
  } finally { await r.close(); }
});

test('the agreement is for the version shown: a newer version makes it impossible, before the confirmation, during it, and during the grace delay', async () => {
  const r = await rig();
  try {
    const browser = await r.browser();
    await r.register(browser);
    // During the grace delay: a new commit, the request is made again for it, the old agreement is not written.
    const { confirmed } = await r.confirmClear(browser);
    assert.equal(confirmed.status, 200);
    r.demo.newVersion('EX-31');
    await r.timers[0].fn();
    assert.deepEqual(r.ran, [], 'the writer was never called for an old version');
    assert.equal(r.records.at(-1).result, 'refused_new_version');
    // The page still shows the old version: the challenge itself is refused.
    const stale = await browser.json('/api/actions/challenge', { gesture: 'clear', ticket: 'EX-31', versions: VERSIONS });
    assert.equal(stale.status, 409); assert.equal(stale.body.error, 'new_version');
    // Between the challenge and its confirmation: the board moved, the grace delay then refuses it.
    const fresh = [{ pr: 88, head: DEMO_HEAD_NEXT }];
    const asked = await browser.json('/api/actions/challenge', { gesture: 'clear', ticket: 'EX-31', versions: fresh });
    assert.equal(asked.status, 200, 'the page that shows the new version may ask for it');
    // A version made up by the page is refused as well.
    assert.equal((await browser.json('/api/actions/challenge', { gesture: 'clear', ticket: 'EX-31', versions: [{ pr: 88, head: 'c'.repeat(40) }] })).status, 409);
    assert.deepEqual(r.ran, []);
  } finally { await r.close(); }
});

test('Send back needs the text and the passkey, and writes the comment and the move for the human', async () => {
  const r = await rig();
  try {
    const browser = await r.browser();
    await r.register(browser);
    const asked = await browser.json('/api/actions/challenge', { gesture: 'sendback', ticket: 'EX-31', versions: VERSIONS, text: 'Round the figure to the cent.' });
    const done = await browser.json('/api/actions/confirm', { challengeId: asked.body.challengeId, assertion: r.authenticator.get(asked.body.publicKey), text: 'Round the figure to the cent.' });
    assert.equal(done.status, 200); assert.equal(done.body.ok, true);
    assert.deepEqual(r.ran, [{ op: 'sendback', ticket: 'EX-31', text: 'Round the figure to the cent.', versions: VERSIONS }]);
    assert.equal(r.records.at(-1).gesture, 'sendback');
    // Not offered on a card that is not waiting for an agreement.
    assert.equal((await browser.json('/api/actions/challenge', { gesture: 'sendback', ticket: 'EX-34', versions: VERSIONS, text: 'x' })).status, 409);
    assert.equal((await browser.json('/api/actions/challenge', { gesture: 'sendback', ticket: 'EX-39', versions: VERSIONS, text: 'x' })).status, 409, 'a question is answered, not sent back');
  } finally { await r.close(); }
});

test('Answer needs the session only, only on a question, and writes the text as given', async () => {
  const r = await rig({ passkeys: false });
  try {
    const browser = await r.browser();
    assert.equal(browser.me.actions.confirm, false, 'no passkey registered, and the answer still goes');
    const done = await browser.json('/api/actions/answer', { ticket: 'EX-39', text: 'Yes, take the charges out first' });
    assert.equal(done.status, 200); assert.equal(done.body.ok, true);
    assert.deepEqual(r.ran, [{ op: 'answer', ticket: 'EX-39', text: 'Yes, take the charges out first' }]);
    assert.equal((await browser.json('/api/actions/answer', { ticket: 'EX-31', text: 'ok' })).status, 409, 'a ready-to-land card is not a question');
    assert.equal((await browser.json('/api/actions/answer', { ticket: 'EX-39', text: '' })).status, 400);
    assert.equal((await browser.json('/api/actions/answer', { ticket: 'EX-39', text: 'x'.repeat(4001) })).status, 400);
    assert.equal((await browser.json('/api/actions/answer', { ticket: '../etc', text: 'x' })).status, 400);
    assert.equal(r.ran.length, 1);
    assert.equal(r.records.at(-1).gesture, 'answer');
    // The demo question carries the team's options for the buttons.
    const board = await (await fetch(`${r.base}/api/snapshot`, { headers: { cookie: browser.cookie } })).json();
    assert.deepEqual(board.tickets.find((t) => t.id === 'EX-39').options, ['Yes, take the charges out first', 'No, count the full amount']);
  } finally { await r.close(); }
});

test('a writer that fails, or that is refused by the tracker, is reported and recorded; the page is never told it worked', async () => {
  const r = await rig({ run: async () => ({ ok: false, code: 'identity', message: 'The tracker does not see this access as the human' }) });
  try {
    const browser = await r.browser();
    const done = await browser.json('/api/actions/answer', { ticket: 'EX-39', text: 'Yes' });
    assert.equal(done.body.ok, false); assert.equal(done.body.code, 'identity');
    assert.equal(r.records.at(-1).result, 'failed_identity');
    await r.register(browser);
    const { confirmed } = await r.confirmClear(browser);
    await r.timers[0].fn();
    assert.equal(r.records.at(-1).result, 'failed_identity');
    const pending = (await (await fetch(`${r.base}/api/me`, { headers: { cookie: browser.cookie } })).json()).actions.pending.find((p) => p.id === confirmed.body.pendingId);
    assert.equal(pending.state, 'failed');
  } finally { await r.close(); }
});

test('the registration socket gives a grant to the human account and to nobody else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-grant-')); dirs.push(dir);
  const path = join(dir, 'app.sock');
  let minted = 0; const seen = [];
  const human = 1234;
  const server = grantServer({ path, humanUid: human, mint: () => { minted += 1; return { grant: 'g', expiresAt: 1, origin: 'https://x' }; }, peer: () => peerNow, record: (e) => seen.push(JSON.parse(e.detail)) });
  let peerNow = 5555; // an agent's UID
  await new Promise((resolve) => server.on('listening', resolve));
  try {
    const refused = await requestGrant(path);
    assert.equal(refused.ok, false);
    assert.equal(minted, 0, 'no grant for another account');
    assert.deepEqual(seen.map((e) => e.result), ['refused_uid']);
    peerNow = human;
    assert.equal((await requestGrant(path)).ok, true);
    assert.equal(minted, 1);
    const none = grantServer.length; void none;
  } finally { await new Promise((r) => server.close(r)); }
  const orphan = grantServer({ path: join(dir, 'b.sock'), humanUid: null, mint: () => { minted += 1; return {}; }, peer: () => 0 });
  await new Promise((resolve) => orphan.on('listening', resolve));
  try { assert.equal((await requestGrant(join(dir, 'b.sock'))).ok, false, 'with no human account configured, nobody gets a grant'); } finally { await new Promise((r) => orphan.close(r)); }
  assert.equal(minted, 1);
});
