// How a passkey gets registered: the human runs `cleared app passkey` on the
// machine, under their own Unix account. That command asks the app, over a Unix
// socket, for a one-time registration grant. The app reads the caller's UID
// from the kernel (SO_PEERCRED) and gives a grant to the human's UID only: the
// agents' account, however it reaches the app, cannot obtain one. The grant is
// then redeemed once, from a signed-in browser session, to create the passkey
// on the phone.
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

// Node does not expose SO_PEERCRED; Python's standard library reads it from the accepted descriptor.
export function peerUid(socket: net.Socket) {
  const source = 'import socket,struct; s=socket.socket(fileno=3); print(struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1])';
  return Number(execFileSync('python3', ['-c', source], { stdio: ['ignore', 'pipe', 'pipe', (socket as unknown as { _handle: { fd: number } })._handle.fd], encoding: 'utf8', timeout: 2000 }).trim());
}

type Options = { path: string; humanUid: number | null | undefined; mint: () => object; peer?: (socket: net.Socket) => number; record?: (entry: { detail: string }) => void };
export function grantServer({ path, humanUid, mint, peer = peerUid, record = () => {} }: Options) {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100) throw new Error('[app] grant_socket must be a short absolute path');
  const parent = statSync(dirname(path));
  if (parent.uid !== process.getuid!() || (parent.mode & 0o022)) throw new Error('[app] grant_socket must sit in a directory owned by the app account and not writable by others');
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error('[app] grant_socket exists and is not a socket');
    unlinkSync(path);
  }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let uid: number;
    try { uid = peer(socket); } catch { socket.end('{"ok":false,"reason":"unknown caller"}\n'); return; }
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', () => {});
    socket.on('end', () => {
      if (humanUid === null || humanUid === undefined || uid !== humanUid) {
        record({ detail: JSON.stringify({ gesture: 'passkey_grant', result: 'refused_uid', uid }) });
        return socket.end('{"ok":false,"reason":"only the human account may register a passkey"}\n');
      }
      try { const grant = mint(); socket.end(`${JSON.stringify({ ok: true, ...grant })}\n`); }
      catch { socket.end('{"ok":false,"reason":"too many open grants, wait or use one"}\n'); }
    });
  });
  server.listen(path, () => chmodSync(path, 0o666));
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => { try { unlinkSync(path); } catch { /* already gone */ } return close(callback); };
  return server;
}

export function requestGrant(path: string) {
  return new Promise<{ ok: boolean; reason?: string; grant?: string; expiresAt?: number; origin?: string | null }>((resolve, reject) => {
    const socket = net.connect(path);
    let data = '';
    socket.setEncoding('utf8').setTimeout(5000, () => socket.destroy(new Error('no answer')));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('unreadable answer')); } });
    socket.end();
  });
}
