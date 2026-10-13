// The three gestures of the human, and the passkey ceremony that confirms them.
//
//   clear     passkey, then a 60 s grace delay held HERE (never in the browser),
//             then the agreement is written for the exact version that was shown
//   sendback  passkey, then a comment and the move back
//   answer    session only, then a comment
//
// Nothing in this module talks to the release service: giving an agreement is
// all it does, the lock does the rest. Every attempt, refused or not, is one
// `app_gesture` event in the ledger.
import { createHash, randomBytes } from 'node:crypto';
import { b64u, challenge as newChallenge, verifyAssertion, verifyRegistration } from './webauthn.mjs';
import { sameVersions } from '../../lib/validation-record.mjs';
import { validText } from './text.mjs';

const REF = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const id = () => randomBytes(18).toString('base64url');
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
const fail = (status, code) => Object.assign(new Error(code), { status, code });

export function originInfo(origin) {
  try {
    const url = new URL(origin);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.origin === 'null' || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return null;
    return { origin: url.origin, rpId: url.hostname, secure: url.protocol === 'https:' };
  } catch { return null; }
}

export function createActions({ source, origin, readPasskeys, writePasskeys, run, record = () => {}, now = () => Date.now(), graceMs = 60000,
  owner = 'owner', schedule = setTimeout, cancel = clearTimeout }) {
  const where = originInfo(origin);
  const challenges = new Map(); // one-time challenges, by id
  const pending = new Map(); // clear-to-land waiting out its grace delay (or finished, kept for the page to read)
  const grants = new Map(); // one-time registration grants, by hash
  const sweep = () => {
    for (const [key, value] of challenges) if (value.expires <= now()) challenges.delete(key);
    for (const [key, value] of grants) if (value.expires <= now()) grants.delete(key);
    for (const [key, value] of pending) if (value.finishedAt && value.finishedAt + 600000 <= now()) pending.delete(key);
  };
  const stored = () => readPasskeys();
  const note = (entry) => { try { record(entry); } catch { /* the ledger being full or locked must not undo a gesture; the result is still returned */ } };

  const card = async (ticket) => {
    const board = await source.snapshot();
    return (board.tickets ?? []).find((c) => c.ref === ticket) ?? null;
  };

  function status(session) {
    const keys = stored();
    const reason = !where ? 'insecure' : keys.length ? null : 'no_passkey';
    return { confirm: reason === null, reason, passkeys: keys.length, graceMs, rpId: where?.rpId ?? null,
      pending: [...pending.values()].filter((p) => p.session === session.id).map(view) };
  }
  const view = (p) => ({ id: p.id, ticket: p.ticket, versions: p.versions, state: p.state, dueAt: p.dueAt, result: p.result ?? null });

  // ---- confirmation ---------------------------------------------------------------
  async function begin(session, body) {
    sweep();
    if (!where) throw fail(409, 'insecure');
    const keys = stored();
    if (!keys.length) throw fail(409, 'no_passkey');
    const gesture = body?.gesture;
    if (!['clear', 'sendback'].includes(gesture)) throw fail(400, 'gesture');
    if (!REF.test(String(body.ticket))) throw fail(400, 'ticket');
    const c = await card(body.ticket);
    if (!c || c.kind !== 'ready' || !c.approval) throw fail(409, 'not_waiting');
    // The version on screen must still be the one that was asked for. If not, the page must show the new version first.
    if (!sameVersions(c.approval.versions, body.versions)) throw fail(409, 'new_version');
    if (gesture === 'sendback' && !validText(body.text)) throw fail(400, 'text');
    if ([...challenges.values()].filter((x) => x.session === session.id).length >= 20) throw fail(429, 'busy');
    const entry = { id: id(), challenge: newChallenge(), session: session.id, gesture, ticket: body.ticket, versions: c.approval.versions,
      textHash: gesture === 'sendback' ? hash(body.text) : null, expires: now() + 120000 };
    challenges.set(entry.id, entry);
    return { challengeId: entry.id, publicKey: { challenge: entry.challenge, rpId: where.rpId, timeout: 60000, userVerification: 'required',
      allowCredentials: keys.map((k) => ({ type: 'public-key', id: k.id })) } };
  }

  function check(session, body) {
    sweep();
    const entry = challenges.get(body?.challengeId);
    // One try per challenge, whatever happens next.
    challenges.delete(body?.challengeId);
    if (!entry || entry.session !== session.id) throw fail(403, 'challenge');
    const keys = stored();
    const key = keys.find((k) => k.id === body.assertion?.id);
    if (!key) throw fail(403, 'unknown_key');
    let result;
    try { result = verifyAssertion({ ...body.assertion.response, id: body.assertion.id }, key, { expectedChallenge: entry.challenge, origin: where.origin, rpId: where.rpId }); }
    catch { throw fail(403, 'assertion'); }
    key.signCount = result.signCount;
    writePasskeys(keys);
    return entry;
  }

  const log = (session, gesture, ticket, versions, result, extra = {}) => note({ ticket, detail: JSON.stringify({ gesture, result, device: session.device, version: versions ? versions.map((v) => `${v.pr}:${v.head.slice(0, 7)}`) : null, ...extra }) });

  async function confirm(session, body) {
    const entry = check(session, body);
    if (entry.gesture === 'sendback') {
      if (hash(body.text) !== entry.textHash) throw fail(403, 'text_changed');
      return write(session, entry.gesture, { op: 'sendback', ticket: entry.ticket, text: body.text, versions: entry.versions });
    }
    const p = { id: id(), ticket: entry.ticket, versions: entry.versions, session: session.id, device: session.device, state: 'waiting', dueAt: now() + graceMs, timer: null };
    p.timer = schedule(() => finalize(p, session), graceMs);
    p.timer.unref?.();
    pending.set(p.id, p);
    log(session, 'clear', p.ticket, p.versions, 'confirmed', { pending: p.id, dueAt: new Date(p.dueAt).toISOString() });
    return { pendingId: p.id, dueAt: p.dueAt, graceMs };
  }

  function undo(session, body) {
    const p = pending.get(body?.pendingId);
    if (!p || p.session !== session.id) throw fail(404, 'pending');
    if (p.state !== 'waiting') throw fail(409, 'too_late');
    cancel(p.timer);
    p.state = 'undone'; p.finishedAt = now(); p.result = { ok: false, code: 'undone' };
    log(session, 'clear', p.ticket, p.versions, 'undone', { pending: p.id });
    return { ok: true };
  }

  async function finalize(p, session) {
    if (p.state !== 'waiting') return;
    p.state = 'writing';
    try {
      // The board is read again now: a newer version, or a ticket no longer waiting, ends it here.
      const c = await card(p.ticket);
      if (!c || c.kind !== 'ready' || !c.approval || !sameVersions(c.approval.versions, p.versions)) {
        p.result = { ok: false, code: 'new_version' };
        log(session, 'clear', p.ticket, p.versions, 'refused_new_version', { pending: p.id });
      } else {
        p.result = await run({ op: 'approve', ticket: p.ticket, versions: p.versions });
        log(session, 'clear', p.ticket, p.versions, p.result.ok ? 'written' : `failed_${p.result.code}`, { pending: p.id, author: p.result.author ?? null });
      }
    } catch (error) {
      p.result = { ok: false, code: 'failed', message: String(error.message).slice(0, 200) };
      log(session, 'clear', p.ticket, p.versions, 'failed', { pending: p.id });
    }
    p.state = p.result.ok ? 'written' : 'failed';
    p.finishedAt = now();
  }

  async function write(session, gesture, request) {
    let result;
    try { result = await run(request); } catch (error) { result = { ok: false, code: 'failed', message: String(error.message).slice(0, 200) }; }
    log(session, gesture, request.ticket, request.versions ?? null, result.ok ? 'written' : `failed_${result.code}`, { author: result.author ?? null });
    return { ok: Boolean(result.ok), code: result.ok ? undefined : result.code ?? 'failed', message: result.ok ? undefined : result.message };
  }

  async function answer(session, body) {
    sweep();
    if (!REF.test(String(body?.ticket))) throw fail(400, 'ticket');
    if (!validText(body.text)) throw fail(400, 'text');
    const c = await card(body.ticket);
    if (!c || c.kind !== 'question') throw fail(409, 'not_waiting');
    return write(session, 'answer', { op: 'answer', ticket: body.ticket, text: body.text });
  }

  // ---- passkey registration -------------------------------------------------------
  // A grant is minted only for the human's own Unix account (see grant-socket.mjs),
  // is single use, lasts ten minutes, and is redeemed from a signed-in session.
  function mintGrant() {
    sweep();
    if (grants.size >= 3) throw fail(429, 'busy');
    const grant = randomBytes(24).toString('base64url');
    grants.set(hash(grant), { expires: now() + 600000, session: null, challenge: null });
    return { grant, expiresAt: now() + 600000, origin: where?.origin ?? null };
  }
  function registerOptions(session, body) {
    sweep();
    if (!where) throw fail(409, 'insecure');
    const g = grants.get(hash(body?.grant));
    if (!g || (g.session && g.session !== session.id)) throw fail(403, 'grant');
    g.session = session.id; g.challenge = newChallenge();
    return { publicKey: { challenge: g.challenge, rp: { id: where.rpId, name: 'Cleared' }, user: { id: b64u(createHash('sha256').update(`cleared:${owner}`).digest()), name: owner, displayName: owner },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000, attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: stored().map((k) => ({ type: 'public-key', id: k.id })) } };
  }
  function registerFinish(session, body) {
    sweep();
    const key = hash(body?.grant);
    const g = grants.get(key);
    if (!g || g.session !== session.id || !g.challenge) throw fail(403, 'grant');
    grants.delete(key);
    let made;
    try { made = verifyRegistration({ ...body.credential.response, id: body.credential.id }, { expectedChallenge: g.challenge, origin: where.origin, rpId: where.rpId }); }
    catch { throw fail(403, 'registration'); }
    const keys = stored();
    if (keys.some((k) => k.id === made.id)) throw fail(409, 'known');
    if (keys.length >= 5) throw fail(409, 'too_many');
    keys.push({ ...made, name: String(body.name || session.device).slice(0, 40), createdAt: new Date(now()).toISOString() });
    writePasskeys(keys);
    log(session, 'passkey_registered', null, null, 'written', { key: made.id.slice(0, 8) });
    return { ok: true, passkeys: keys.length };
  }

  const stop = () => { for (const p of pending.values()) if (p.state === 'waiting') cancel(p.timer); };
  return { status, begin, confirm, undo, answer, mintGrant, registerOptions, registerFinish, stop, pendingOf: (session) => [...pending.values()].filter((p) => p.session === session.id).map(view) };
}
