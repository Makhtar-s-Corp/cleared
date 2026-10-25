#!/usr/bin/env node
// Local release executor. The peer UID comes from Linux SO_PEERCRED, never JSON.
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, statSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConf, projectDir, stateDir } from '../lib/conf.mjs';
import { addEvent, openLedger } from '../lib/ledger.mjs';
import { forgeGhEnv } from '../lib/forge.mjs';

const home = fileURLToPath(new URL('..', import.meta.url));
const conf = loadConf();
const state = stateDir();
const repo = projectDir();
const serviceUid = process.getuid();
const agentName = conf.sections.security?.agent_user || '';
const sharedUidSetting = conf.sections.security?.allow_shared_uid || '';
if (sharedUidSetting && !['true', 'false'].includes(sharedUidSetting)) throw new Error('[security] allow_shared_uid must be true or false');
const allowSharedUid = sharedUidSetting === 'true';
const passwd = agentName ? execFileSync('getent', ['passwd', agentName], { encoding: 'utf8' }).trim().split(':') : null;
const agentUid = passwd ? Number(passwd[2]) : serviceUid;
const humanName = conf.sections.security?.human_user || (conf.sections.tracker?.adapter === 'local' ? conf.sections.tracker?.owner_id : '');
const humanPasswd = humanName ? execFileSync('getent', ['passwd', humanName], { encoding: 'utf8' }).trim().split(':') : null;
const humanUid = humanPasswd ? Number(humanPasswd[2]) : !agentName && allowSharedUid ? serviceUid : null;
if (!Number.isSafeInteger(agentUid) || agentUid < 0 || (agentName && agentUid === serviceUid)) throw new Error('Invalid [security] agent_user');
if (humanUid !== null && (!Number.isSafeInteger(humanUid) || humanUid < 0 || (agentName && humanUid === agentUid))) throw new Error('Invalid [security] human_user: it must differ from agent_user');
if (agentName && !conf.sections.security?.socket_path && !process.env.CLEARED_RELEASE_SOCKET) throw new Error('[security] socket_path is required when agent_user is configured');
mkdirSync(state, { recursive: true, mode: 0o700 });
export const socketPath = process.env.CLEARED_RELEASE_SOCKET || conf.sections.security?.socket_path || join(state, 'release.sock');
if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('Release socket path must be a short absolute path');
const socketParent = statSync(dirname(socketPath));
if (socketParent.uid !== serviceUid || (socketParent.mode & 0o022)) throw new Error('Release socket parent must be service-owned and not group/world-writable');
const secretPath = join(state, 'release-broker.secret');
const stateStat = lstatSync(state);
if (stateStat.uid !== serviceUid || (stateStat.mode & 0o002) !== 0) throw new Error('State directory must be service-owned and not world-writable');
if (agentName) {
  const actual = execFileSync('sudo', ['-n', '-u', agentName, '--', 'id', '-u'], { encoding: 'utf8' }).trim();
  if (Number(actual) !== agentUid) throw new Error('Agent UID probe did not match [security] agent_user');
  try { execFileSync('sudo', ['-n', '-u', agentName, '--', 'test', '!', '-w', state]); }
  catch { throw new Error('Agent account can write Cleared state or cannot be verified'); }
  let writable = '';
  try { writable = execFileSync('sudo', ['-n', '-u', agentName, '--', 'find', state, '-writable', '-print', '-quit'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* No traversal means there is no reachable writable path. */ }
  if (writable) throw new Error(`Agent account can write Cleared state: ${writable}`);
  const serviceHome = execFileSync('getent', ['passwd', String(serviceUid)], { encoding: 'utf8' }).trim().split(':')[5];
  for (const protectedPath of [home, repo, process.env.ORCH_CONF || join(repo, '.cleared', 'agents.conf'), serviceHome,
    join(serviceHome, '.config', 'cleared'), join(serviceHome, '.local', 'bin')]) {
    if (!existsSync(protectedPath)) continue;
    try { execFileSync('sudo', ['-n', '-u', agentName, '--', 'test', '!', '-w', protectedPath]); }
    catch { throw new Error(`Agent account can write protected path or cannot be verified: ${protectedPath}`); }
  }
  try { execFileSync('sudo', ['-n', '-u', agentName, '--', 'test', '!', '-w', dirname(socketPath)]); }
  catch { throw new Error('Agent account can write the socket directory or cannot be verified'); }
}

writeFileSync(secretPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'w' });
chmodSync(secretPath, 0o600);
const secret = readFileSync(secretPath, 'utf8');

// Node's net.Socket does not expose SO_PEERCRED. Python's standard library
// reads it from the accepted fd; no identity field is accepted from a client.
function peerUid(socket) {
  const source = 'import socket,struct,sys; s=socket.socket(fileno=3); print(struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1])';
  return Number(execFileSync('python3', ['-c', source], { stdio: ['ignore', 'pipe', 'pipe', socket._handle.fd], encoding: 'utf8', timeout: 2000 }).trim());
}
function event(ticket, pr, uid, ok, reason, commit, operation) {
  const db = openLedger();
  try { addEvent(db, { kind: 'release_request', ticket, value: Number.isInteger(pr) ? pr : null,
    source: 'broker', detail: JSON.stringify({ operation, uid, accepted: ok, reason: String(reason).slice(0, 1000), commit: commit || null }) }); }
  finally { db.close(); }
}
function command(file, args, input = '', extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: repo, env: { ...process.env, ORCH_BROKER_SECRET: secret, ORCH_REPO: repo, ORCH_STATE_DIR: state, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { if (stdout.length < 100000) stdout += b; });
    child.stderr.on('data', (b) => { if (stderr.length < 100000) stderr += b; });
    child.on('error', (error) => resolve({ code: 69, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 69, stdout, stderr }));
    child.stdin.end(input);
  });
}
function currentHead(pr) {
  // The forge credential of the service (lib/forge.mjs): a token minted for this call when an app is configured.
  try { const p = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd: repo, encoding: 'utf8', timeout: 10000, env: forgeGhEnv(conf, { state }) })); return p.headRefOid || null; }
  catch { return null; }
}
let busy = false;
async function handle(input, uid) {
  const operation = input?.operation;
  const ticket = input?.ticket;
  const pr = input?.pr;
  const validTicket = typeof ticket === 'string' && /^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticket);
  const validPr = Number.isSafeInteger(pr) && pr > 0;
  let commit = null;
  const permitted = uid === serviceUid || (agentName && uid === agentUid) || uid === humanUid;
  const reject = (reason) => { event(validTicket ? ticket : null, validPr ? pr : null, uid, false, reason, commit, operation); return { ok: false, code: 1, definitive: true, reason, commit }; };
  if (!permitted) return reject('Caller UID is not an authorized agent or service account');
  if (!['request_release', 'request_rollback', 'status'].includes(operation)) return reject('Unknown operation');
  if (!validTicket) return reject('Invalid ticket');
  if (operation === 'status') {
    const db = openLedger();
    let release, error;
    try {
      release = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'releases'").get()
        ? db.prepare('SELECT ticket,pr,merge_sha,status,last_health FROM releases WHERE ticket = ? ORDER BY id DESC LIMIT 1').get(ticket) : null;
    }
    catch (caught) { error = caught; }
    finally { db.close(); }
    if (error) return reject(`Cannot read release status: ${error.message}`);
    event(ticket, null, uid, true, 'status read', release?.merge_sha || null, operation);
    return { ok: true, release: release || null, problem: agentName ? null : 'release lock is not a security boundary: agents run as the service account' };
  }
  if (!agentName && !allowSharedUid) return reject('Release lock requires [security] agent_user; create a separate agent account and run serve/install.sh, or explicitly set [security] allow_shared_uid = true to accept the shared-UID risk');
  if (busy) { event(ticket, validPr ? pr : null, uid, false, 'Another release operation is running', commit, operation);
    return { ok: false, code: 5, reason: 'Another release operation is running', commit }; }
  if (validPr) commit = currentHead(pr);
  if (operation === 'request_release') {
    if (!validPr || typeof input.announcement !== 'string' || input.announcement.length > 20000) return reject('Invalid PR or announcement');
    busy = true;
    try {
      if (typeof input.approval_request === 'string') {
        if (!input.approval_request.trim() || input.approval_request.length > 20000) return reject('Invalid approval request');
        const prs = Array.isArray(input.approval_prs) ? input.approval_prs : [pr];
        if (!prs.includes(pr) || prs.length > 8 || prs.some((n) => !Number.isSafeInteger(n) || n <= 0)) return reject('Invalid approval PRs');
        const captures = input.captures || [];
        if (!Array.isArray(captures) || captures.length > 8 || captures.some((c) => typeof c?.path !== 'string' || typeof c?.caption !== 'string' || c.path.length > 1000 || c.caption.length > 200)) return reject('Invalid captures');
        const result = await command(join(home, 'ask-validation.ts'), [ticket, '-', ...prs.flatMap((n) => ['--pr', String(n)]), ...captures.flatMap((c) => ['--capture', c.path, c.caption])], input.approval_request);
        event(ticket, pr, uid, result.code === 0, result.stderr || result.stdout || `exit ${result.code}`, commit, operation);
        return { ok: result.code === 0, code: result.code === 0 ? 0 : 69, reason: result.stderr.trim(), output: result.stdout.trim(), commit };
      }
      const result = await command(join(home, 'merge-pr.ts'), [String(pr), ticket, '-'], input.announcement, input.from_queue && uid === serviceUid ? { ORCH_FROM_QUEUE: '1' } : {});
      event(ticket, pr, uid, result.code === 0 || result.code === 3, result.stderr || result.stdout || `exit ${result.code}`, commit, operation);
      // Audited merge-pr.ts: only no() exits 6 for a definitive refusal.
      // die(), GitHub failures, lock failures and unhandled script errors exit 1
      // or another code and must remain retryable in the queue.
      const code = result.code === 6 ? 1 : result.code === 0 ? 0 : result.code === 3 || result.code === 5 ? 5 : 69;
      return { ok: result.code === 0, code, definitive: code === 1, reason: result.stderr.trim(), output: result.stdout.trim(), commit };
    } finally { busy = false; }
  }
  if (uid !== humanUid) return reject('Only the configured human account can request manual rollback');
  busy = true;
  try {
    const flags = ['--yes'];
    if (input.force_with_migrations) flags.push('--force-with-migrations');
    const release = openLedger();
    try { commit = release.prepare('SELECT merge_sha FROM releases WHERE ticket = ? ORDER BY id DESC LIMIT 1').get(ticket)?.merge_sha || null; }
    finally { release.close(); }
    const result = await command('flock', ['-x', '-w', '120', join(state, 'merge.lock'), process.execPath, join(home, 'lib/release.mjs'), 'rollback', ticket, ...flags]);
    event(ticket, null, uid, result.code === 0, result.stderr || result.stdout || `exit ${result.code}`, commit, operation);
    return { ok: result.code === 0, code: result.code === 0 ? 0 : 69, reason: result.stderr.trim(), output: result.stdout.trim() };
  } finally { busy = false; }
}
if (existsSync(socketPath)) {
  if (!lstatSync(socketPath).isSocket()) throw new Error('Release socket path already exists and is not a socket');
  unlinkSync(socketPath);
}
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.setEncoding('utf8');
  let uid;
  try { uid = peerUid(socket); } catch { socket.end(JSON.stringify({ ok: false, reason: 'Cannot identify peer UID' }) + '\n'); return; }
  let data = '';
  socket.setTimeout(5000, () => socket.destroy());
  socket.on('data', (chunk) => { data += chunk; if (data.length > 256000) socket.destroy(); });
  socket.on('end', async () => {
    socket.setTimeout(0);
    let reply;
    try { reply = await handle(JSON.parse(data), uid); }
    catch (error) {
      try { event(null, null, uid, false, error.message, null, 'invalid_request'); } catch {}
      reply = { ok: false, code: 69, reason: error.message };
    }
    socket.end(JSON.stringify(reply) + '\n');
  });
});
server.listen(socketPath, () => chmodSync(socketPath, 0o666));
process.on('SIGTERM', () => { server.close(); try { unlinkSync(socketPath); } catch {} });
