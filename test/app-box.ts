// Shared by the writer tests: a scratch project, state directory, credentials directory and signing key,
// a conf for the adapter under test, and the real writer process (app/human-write.ts) run against them.
import http from 'node:http';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { ORCH_HOME, parseConf } from '../lib/conf.ts';

export const HEAD = 'a'.repeat(40);
export const VERSIONS = [{ pr: 7, head: HEAD }];
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// What the writer answers: whether it wrote, and why not.
export type WriteResult = { ok: boolean; code?: string; verified?: boolean; [key: string]: unknown };

export function box(adapter: string, { owner = 'alice', ticket, extra = '' }: { owner?: string; ticket?: string; extra?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cleared-writer-')); dirs.push(root);
  const repo = join(root, 'repo'), state = join(root, 'state'), creds = join(root, 'creds');
  for (const d of [repo, state, creds, join(state, 'validations')]) mkdirSync(d, { recursive: true });
  for (const d of [state, creds]) chmodSync(d, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(creds, 'human-signing.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const publicB64 = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
  const conf = `[tracker]\nadapter = ${adapter}\nowner_id = ${owner}\nvalidate_state = Needs Approval\ngo_state = Ready to Ship\ndone_state = Done\nprogress_state = In Progress\nreview_state = In Review\ntodo_state = Todo\n`
    + `team = ENG\nrepository = o/r\napp_login = cleared[bot]\nagents_uid = 99999\nhuman_public_key = ${publicB64}\n[app]\nhuman_credentials_dir = ${creds}\n${extra}`;
  const confPath = join(root, 'agents.conf'); writeFileSync(confPath, conf);
  const env = { PATH: process.env.PATH, HOME: root, ORCH_CONF: confPath, ORCH_REPO: repo, ORCH_STATE_DIR: state, ORCH_LEDGER: join(state, 'ledger.db'), XDG_CONFIG_HOME: join(root, 'cfg') };
  const approvalRecord = (head = HEAD) => writeFileSync(join(state, 'validations', `${ticket}.json`), JSON.stringify({ ticket, at, pulls: [{ pr: 7, head }] }));
  const credentials = (token: string | object) => writeFileSync(join(creds, 'credentials.json'), JSON.stringify(token && typeof token === 'object' ? token : { [adapter]: token }), { mode: 0o600 });
  const write = (request: object, over: NodeJS.ProcessEnv = {}) => new Promise<WriteResult>((resolve) => {
    const child = spawn(process.execPath, [join(ORCH_HOME, 'app/human-write.ts')], { env: { ...env, ...over }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1)!)));
    child.stdin.end(JSON.stringify(request));
  });
  const at = '2026-10-13T09:00:00.000Z';
  return { at, root, repo, state, creds, env, ticket, conf: parseConf(conf), approvalRecord, credentials, write, confPath, publicB64 };
}


export const listen = (handler: RequestListener) => new Promise<Server>((resolve) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });
export const body = (request: IncomingMessage) => new Promise<string>((resolve) => { let d = ''; request.on('data', (c: Buffer) => { d += c; }); request.on('end', () => resolve(d)); });
export const bearer = (request: IncomingMessage) => /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
