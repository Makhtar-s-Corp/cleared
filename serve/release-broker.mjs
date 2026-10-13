#!/usr/bin/env node
// Local release executor. The peer UID comes from Linux SO_PEERCRED, never JSON.
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, statSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConf, projectDir, stateDir } from '../lib/conf.mjs';
import { addEvent, openLedger } from '../lib/ledger.mjs';

const home = fileURLToPath(new URL('..', import.meta.url));
const conf = loadConf();
const state = stateDir();
const repo = projectDir();
const serviceUid = process.getuid();
const agentName = conf.sections.security?.agent_user || '';
const passwd = agentName ? execFileSync('getent', ['passwd', agentName], { encoding: 'utf8' }).trim().split(':') : null;
const agentUid = passwd ? Number(passwd[2]) : serviceUid;
if (!Number.isSafeInteger(agentUid) || agentUid < 0 || (agentName && agentUid === serviceUid)) throw new Error('Invalid [security] agent_user');
if (agentName && !conf.sections.security?.socket_path && !process.env.CLEARED_RELEASE_SOCKET) throw new Error('[security] socket_path is required when agent_user is configured');
const hash = createHash('sha256').update(repo).digest('hex').slice(0, 12);
export const socketPath = process.env.CLEARED_RELEASE_SOCKET || conf.sections.security?.socket_path || join(tmpdir(), `cleared-release-${serviceUid}-${hash}.sock`);
if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('Release socket path must be a short absolute path');
const socketParent = statSync(dirname(socketPath));
if (socketParent.uid !== serviceUid && !(socketParent.uid === 0 && (socketParent.mode & 0o1000))) throw new Error('Release socket parent must be owned by the service account or root with sticky bit');
const secretPath = join(state, 'release-broker.secret');
mkdirSync(state, { recursive: true, mode: 0o700 });
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
    child.stdout.on('data', (b) => { stdout += b; if (stdout.length > 100000) child.kill(); });
    child.stderr.on('data', (b) => { stderr += b; if (stderr.length > 100000) child.kill(); });
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}
function currentHead(pr) {
  try { const p = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd: repo, encoding: 'utf8', timeout: 10000 })); return p.headRefOid || null; }
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
  const permitted = uid === serviceUid || (agentName && uid === agentUid);
  const reject = (reason) => { event(validTicket ? ticket : null, validPr ? pr : null, uid, false, reason, commit, operation); return { ok: false, code: 6, reason, commit }; };
  if (!permitted) return reject('Caller UID is not an authorized agent or service account');
  if (validPr) commit = currentHead(pr);
  if (!['request_release', 'request_rollback', 'status'].includes(operation)) return reject('Unknown operation');
  if (!validTicket) return reject('Invalid ticket');
  if (operation === 'status') {
    const db = openLedger();
    try { const release = db.prepare('SELECT ticket,pr,merge_sha,status,last_health FROM releases WHERE ticket = ? ORDER BY id DESC LIMIT 1').get(ticket);
      return { ok: true, release: release || null, problem: agentName ? null : 'release lock is not a security boundary: agents run as the service account' }; }
    catch { return { ok: true, release: null, problem: agentName ? null : 'release lock is not a security boundary: agents run as the service account' }; }
    finally { db.close(); }
  }
  if (busy) return reject('Another release operation is running');
  if (operation === 'request_release') {
    if (!validPr || typeof input.announcement !== 'string' || input.announcement.length > 20000) return reject('Invalid PR or announcement');
    busy = true;
    try {
      if (typeof input.approval_request === 'string') {
        if (!input.approval_request.trim() || input.approval_request.length > 20000) return reject('Invalid approval request');
        const prs = Array.isArray(input.approval_prs) ? input.approval_prs : [pr];
        if (!prs.includes(pr) || prs.some((n) => !Number.isSafeInteger(n) || n <= 0)) return reject('Invalid approval PRs');
        const captures = input.captures || [];
        if (!Array.isArray(captures) || captures.length > 8 || captures.some((c) => typeof c?.path !== 'string' || typeof c?.caption !== 'string' || c.path.length > 1000 || c.caption.length > 200)) return reject('Invalid captures');
        const result = await command(join(home, 'ask-validation.sh'), [ticket, '-', ...prs.flatMap((n) => ['--pr', String(n)]), ...captures.flatMap((c) => ['--capture', c.path, c.caption])], input.approval_request);
        event(ticket, pr, uid, result.code === 0, result.stderr || result.stdout || `exit ${result.code}`, commit, operation);
        return { ok: result.code === 0, code: result.code, reason: result.stderr.trim(), output: result.stdout.trim(), commit };
      }
      const result = await command(join(home, 'merge-pr.sh'), [String(pr), ticket, '-'], input.announcement, input.from_queue && uid === serviceUid ? { ORCH_FROM_QUEUE: '1' } : {});
      event(ticket, pr, uid, result.code === 0 || result.code === 3, result.stderr || result.stdout || `exit ${result.code}`, commit, operation);
      return { ok: result.code === 0, code: result.code, reason: result.stderr.trim(), output: result.stdout.trim(), commit };
    } finally { busy = false; }
  }
  if (typeof input.approval_comment !== 'string' && input.approval_comment !== undefined) return reject('Invalid approval comment');
  if (input.force_with_migrations && uid !== serviceUid) return reject('Only the service account can force rollback with migrations');
  busy = true;
  try {
    // The tracker contract in release.mjs authenticates the owner's comment.
    // Agents cannot use the service-account whoAmI shortcut.
    const flags = ['--yes'];
    if (input.approval_comment) flags.push('--approval-comment', input.approval_comment);
    if (input.force_with_migrations) flags.push('--force-with-migrations');
    if (uid !== serviceUid && !input.approval_comment) return reject('An agent must supply a tracker approval comment for rollback');
    const result = await command(process.execPath, [join(home, 'lib/release.mjs'), 'rollback', ticket, ...flags], '', uid !== serviceUid ? { ORCH_BROKER_AGENT_REQUEST: '1' } : {});
    event(ticket, null, uid, result.code === 0, result.stderr || result.stdout || `exit ${result.code}`, null, operation);
    return { ok: result.code === 0, code: result.code, reason: result.stderr.trim(), output: result.stdout.trim() };
  } finally { busy = false; }
}
if (existsSync(socketPath)) {
  if (!lstatSync(socketPath).isSocket()) throw new Error('Release socket path already exists and is not a socket');
  unlinkSync(socketPath);
}
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  let uid;
  try { uid = peerUid(socket); } catch { socket.end(JSON.stringify({ ok: false, reason: 'Cannot identify peer UID' }) + '\n'); return; }
  let data = '';
  socket.on('data', (chunk) => { data += chunk; if (data.length > 25000) socket.destroy(); });
  socket.on('end', async () => {
    let reply;
    try { reply = await handle(JSON.parse(data), uid); }
    catch (error) {
      try { event(null, null, uid, false, error.message, null, 'invalid_request'); } catch {}
      reply = { ok: false, code: 1, reason: error.message };
    }
    socket.end(JSON.stringify(reply) + '\n');
  });
});
server.listen(socketPath, () => chmodSync(socketPath, 0o666));
process.on('SIGTERM', () => { server.close(); try { unlinkSync(socketPath); } catch {} });
