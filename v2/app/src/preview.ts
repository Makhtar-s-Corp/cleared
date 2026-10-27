// The Browser tab's preview listener (docs/v2/milestone-2-plan.md, decision
// 20, lane 20): the trial environment of a session, a page the session
// wrote, shown from a loopback origin of its own, never the app's.
//
//   GET /preview/<session>/<key>/<path> answers what the service's preview
//   route (container/preview.ts, lane 15) answers for
//   /api/sessions/<session>/preview/<key>/<path>.
//
// It listens on 127.0.0.1:CLEARED_V2_PREVIEW_PORT (8794 by default). Its
// origin is CLEARED_V2_PREVIEW_ORIGIN when set (the https address of a proxy
// on this machine, for a browser on another device, as CLEARED_V2_APP_ORIGIN
// names the app's), else its loopback address, in which case the Browser
// tab works on this machine's browser only and says so.
//
// What keeps a page the session wrote from acting for the owner:
//   - another origin than the app's, and every answer sandboxed
//     (`sandbox allow-scripts allow-forms`, no allow-same-origin), so the
//     page runs with an opaque origin, in a sandboxed frame too;
//   - no session: the listener reads no cookie and holds no anti-forgery
//     token. The browser sends it the app's cookie (cookies do not tell
//     ports apart): it forwards it to no one, nor any other header of the
//     browser, and strips every Set-Cookie of the answer;
//   - the service is asked with the app's proof (the shared secret the app
//     already holds) and nothing of the owner;
//   - the per-session key the service issued, so a preview is not found by
//     guessing a session id;
//   - nothing but previews: any other path is a 404, a write a 405, another
//     Host a 421; and frame-ancestors names the app's origins only.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { DEFAULT_PORT as SERVICE_PORT, RESERVED_PORTS } from '../../src/config.ts';
import { SERVICE_PROOF_HEADER } from '../../src/api/types.ts';
import { currentProof, type ProofSource } from './proxy.ts';

export const DEFAULT_PREVIEW_PORT = 8794;
export const PREVIEW_POLICY = 'sandbox allow-scripts allow-forms';
const MAX_BYTES = 8 * 1024 * 1024 + 64 * 1024;     // the service relays 8 MB at most (container/preview.ts)
const DEPTH = 16;
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9_-]{32,128}$/;

export class PreviewConfigError extends Error {
  override name = 'PreviewConfigError';
}

export type PreviewConfig = {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly origin: string;                // what the page's frame loads, and frame-src names
  readonly loopback: boolean;             // the origin is this machine's: the Browser tab works here only
};

// CLEARED_V2_PREVIEW_PORT and CLEARED_V2_PREVIEW_ORIGIN; never a reserved
// port, nor the app's or the service's.
export function readPreviewConfig(env: NodeJS.ProcessEnv, taken: { readonly app: number; readonly service?: number }): PreviewConfig {
  const raw = env.CLEARED_V2_PREVIEW_PORT?.trim();
  let port = DEFAULT_PREVIEW_PORT;
  if (raw) {
    if (!/^[0-9]+$/.test(raw)) throw new PreviewConfigError(`CLEARED_V2_PREVIEW_PORT must be a whole number, got "${raw}"`);
    port = Number(raw);
  }
  if (port < 1 || port > 65535) throw new PreviewConfigError(`CLEARED_V2_PREVIEW_PORT must be between 1 and 65535, got ${port}`);
  if (RESERVED_PORTS.has(port)) throw new PreviewConfigError(`CLEARED_V2_PREVIEW_PORT ${port} is reserved (${[...RESERVED_PORTS].join(', ')}): choose a free port`);
  if (port === taken.app || port === (taken.service ?? SERVICE_PORT)) throw new PreviewConfigError(`CLEARED_V2_PREVIEW_PORT ${port} is the app's or the service's port: choose another one`);
  const given = env.CLEARED_V2_PREVIEW_ORIGIN?.trim();
  if (!given) return { host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}`, loopback: true };
  let origin: URL;
  try { origin = new URL(given); } catch { throw new PreviewConfigError(`CLEARED_V2_PREVIEW_ORIGIN must be an address such as https://host:8444, got "${given}"`); }
  return { host: '127.0.0.1', port, origin: origin.origin, loopback: LOOPBACK_HOSTS.has(origin.hostname) };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

// What the service answered for a preview, whole: the service already
// holds the sibling's answer in memory before it relays it.
export type PreviewAnswer = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Buffer };
export type PreviewUpstream = (path: string, method: 'GET' | 'HEAD') => Promise<PreviewAnswer>;

// The live service, on loopback, with the app's proof and nothing else.
export function servicePreview(options: { readonly url: string; readonly proof: ProofSource }): PreviewUpstream {
  const base = new URL(options.url);
  return (path, method) => new Promise((resolve, reject) => {
    const proof = currentProof(options.proof);
    if (proof === undefined) { resolve({ status: 503, headers: {}, body: Buffer.alloc(0) }); return; }
    const upstream = httpRequest({ protocol: base.protocol, hostname: base.hostname, port: base.port, method, path, headers: { [SERVICE_PROOF_HEADER]: proof } }, (answer) => {
      if (answer.statusCode === 401 && typeof options.proof !== 'string') options.proof.forget?.();
      const chunks: Buffer[] = [];
      let size = 0;
      answer.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) answer.destroy(new Error('too large'));
        else chunks.push(chunk);
      });
      answer.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(answer.headers)) if (typeof value === 'string') headers[name] = value;
        resolve({ status: answer.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
      });
      answer.on('error', reject);
    });
    upstream.on('error', reject);
    upstream.end();
  });
}

// Only these of the service's answer reach the browser; the policy and the
// rest are the listener's own.
const KEPT = ['content-type', 'last-modified', 'etag'] as const;

function plain(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), ...headers });
  response.end(text);
}

export function createPreviewHandler(options: { readonly upstream: PreviewUpstream; readonly origin: string; readonly appOrigins: readonly string[] }): (request: IncomingMessage, response: ServerResponse) => void {
  const policy = `${PREVIEW_POLICY}; frame-ancestors ${options.appOrigins.length ? options.appOrigins.join(' ') : "'none'"}`;
  const fixed = { 'content-security-policy': policy, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin' };
  const ownHost = new URL(options.origin).host;

  const hostAllowed = (request: IncomingMessage): boolean => {
    const host = request.headers.host?.toLowerCase();
    const port = request.socket.localPort;
    return host !== undefined && (host === ownHost || host === `127.0.0.1:${port}` || host === `localhost:${port}`);
  };

  // /preview/<session>/<key>[/<path>]: the service's path, or undefined.
  const upstreamPath = (url: string): { readonly path: string; readonly prefix: string } | undefined => {
    const at = url.indexOf('?');
    const pathname = at < 0 ? url : url.slice(0, at);
    const query = at < 0 ? '' : url.slice(at);
    const parts = pathname.split('/').slice(1);
    if (parts[0] !== 'preview' || parts.length < 3 || parts.length > DEPTH + 4) return undefined;
    const [, session = '', key = '', ...rest] = parts;
    if (!SESSION.test(session) || !KEY.test(key)) return undefined;
    if (rest.at(-1) === '') rest.pop();
    for (const part of rest) {
      let decoded: string;
      try { decoded = decodeURIComponent(part); } catch { return undefined; }
      if (decoded === '' || decoded === '.' || decoded === '..' || /[/\\\0]/.test(decoded)) return undefined;
    }
    if (rest.length > DEPTH) return undefined;
    const prefix = `/preview/${session}/${key}`;
    return { path: `/api/sessions/${session}/preview/${key}${rest.length ? `/${rest.join('/')}` : ''}${query}`, prefix };
  };

  return (request, response) => {
    for (const [name, value] of Object.entries(fixed)) response.setHeader(name, value);
    if (!hostAllowed(request)) return plain(response, 421, 'this listener does not answer for that host name');
    const method = request.method ?? 'GET';
    const target = upstreamPath(request.url ?? '/');
    if (!target) return plain(response, 404, 'this address shows a session\'s trial environment only');
    if (method !== 'GET' && method !== 'HEAD') return plain(response, 405, 'a preview is read only', { allow: 'GET, HEAD' });
    options.upstream(target.path, method).then((answer) => {
      const headers: Record<string, string> = {};
      for (const name of KEPT) {
        const value = answer.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      // The service keeps a redirect to the sibling itself as its path:
      // under the session's preview address here; anything else is dropped.
      const location = answer.headers.location;
      if (location?.startsWith('/') && !location.startsWith('//')) headers.location = `${target.prefix}${location}`;
      response.writeHead(answer.status, { ...headers, 'content-length': String(answer.body.length) });
      response.end(method === 'HEAD' ? undefined : answer.body);
    }, () => {
      if (!response.headersSent) plain(response, 502, 'the preview did not answer');
      else response.destroy();
    });
  };
}
