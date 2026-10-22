// The trial environment of a session, as the Browser tab shows it
// (milestone 2 plan, decision 20): GET /api/sessions/:id/preview/:key/<path>
// answers what the session's own `run` sibling answers at <path>.
//
// The sibling sits on the session's internal network, which has no address
// on the host, and publishes nothing: the service reaches it through the
// session's egress container (Cleared's own image, on that network), with
// a one-shot `node` fetch run by `docker exec` on the id a labelled list
// returned, to the sibling's address on that network while it runs (never
// its name, which the egress container could resolve outside). The body
// comes back as base64, so bytes stay bytes. No request header of the app
// goes to the sibling: only the path and the query.
//
// Every answer carries `Content-Security-Policy: sandbox allow-scripts
// allow-forms` (a page the session wrote runs with an opaque origin) and no
// cookie: the sibling's Set-Cookie and its own policy are dropped. The route
// asks for the app's proof, as every route of the service does; the app's
// preview listener (lane 20) adds it, never anything of the owner. The key
// is the session's unguessable segment: an unknown session and a wrong key
// get the same 404.
import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { SERVICE_PROOF_HEADER } from '../api/types.ts';
import type { Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { DockerError, type Docker } from './docker.ts';
import { sessionNames, siblingAddress } from './session-runtime.ts';

export const PREVIEW_POLICY = 'sandbox allow-scripts allow-forms';
// The routes match a fixed number of segments: a path of the sibling has
// at most this many.
export const PREVIEW_DEPTH = 16;
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const PREVIEW_TIMEOUT_MS = 15_000;

// The session's preview: its key, and its own run sibling on its network.
export type PreviewTarget = { readonly session: string; readonly key: string; readonly alias: string; readonly port: number };

export type PreviewDeps = {
  readonly proof: () => string;
  readonly target: (session: string) => PreviewTarget | undefined;
  readonly docker: () => Docker;
};

// Run with `node -e <script> <url> <max bytes> <timeout ms>` in the egress
// container: one JSON line, the answer or the error's name.
export const RELAY = `const [u,max,ms]=process.argv.slice(1);(async()=>{try{
const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(+ms)});const c=[];let n=0;
for await(const b of r.body??[]){n+=b.length;if(n>+max){console.log(JSON.stringify({error:'too large'}));return}c.push(b)}
console.log(JSON.stringify({status:r.status,headers:[...r.headers],body:Buffer.concat(c).toString('base64')}))
}catch(e){console.log(JSON.stringify({error:String(e&&e.name||'error')}))}})()`;

// Not passed on: the cookies, the sibling's own policy, and what describes
// the relay's transfer rather than the body (fetch decoded it).
const DROPPED = new Set([
  'set-cookie', 'set-cookie2', 'content-security-policy', 'content-security-policy-report-only', 'content-length', 'content-encoding',
  'transfer-encoding', 'connection', 'keep-alive', 'strict-transport-security', 'cache-control', 'location',
]);

const FIXED = { 'content-security-policy': PREVIEW_POLICY, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { ...FIXED, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  response.end(text);
}

function sameKey(given: string, key: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Each segment as one segment of the sibling's path: a decoded slash stays
// encoded, and a segment of dots is never a step up.
const segment = (part: string): string => (/^\.{1,2}$/.test(part) ? part.replaceAll('.', '%2E') : encodeURIComponent(part));

type Relayed = { readonly status?: number; readonly headers?: readonly [string, string][]; readonly body?: string; readonly error?: string };

async function handle(deps: PreviewDeps, depth: number, { request, response, params }: RouteContext): Promise<void> {
  const proof = request.headers[SERVICE_PROOF_HEADER];
  if (!sameProof(Array.isArray(proof) ? proof[0] : proof, deps.proof())) return sendJson(response, 401, { error: 'unauthorized' });
  const target = deps.target(params.id ?? '');
  if (!target || !sameKey(params.key ?? '', target.key)) return sendJson(response, 404, { error: 'no preview' });
  const path = Array.from({ length: depth }, (_, i) => segment(params[`p${i}`] ?? '')).join('/');
  const at = (request.url ?? '').indexOf('?');
  const query = at < 0 ? '' : (request.url ?? '').slice(at);
  let relayed: Relayed;
  const docker = deps.docker();
  const address = await siblingAddress(docker, target.session, target.alias);
  if (address === undefined) return sendJson(response, 502, { error: 'the preview is not running' });
  const base = `http://${address}:${target.port}`;
  const url = `${base}/${path}${query}`;
  let parsed: URL | undefined;
  try { parsed = new URL(url); } catch { parsed = undefined; }
  if (parsed?.origin !== base) return sendJson(response, 400, { error: 'not a path of the preview' });
  try {
    const result = await docker.exec(target.session, sessionNames(target.session).egress, ['node', '-e', RELAY, url, String(PREVIEW_MAX_BYTES), String(PREVIEW_TIMEOUT_MS)], { timeoutMs: PREVIEW_TIMEOUT_MS + 10_000 });
    relayed = result.code === 0 ? JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Relayed : { error: 'exit' };
  } catch (error) {
    if (!(error instanceof DockerError) && !(error instanceof SyntaxError)) throw error;
    relayed = { error: 'not running' };
  }
  if (relayed.error !== undefined || typeof relayed.status !== 'number' || typeof relayed.body !== 'string')
    return sendJson(response, 502, { error: relayed.error === 'not running' ? 'the preview is not running' : 'the preview did not answer' });
  const body = Buffer.from(relayed.body, 'base64');
  const headers: Record<string, string> = {};
  for (const [name, value] of relayed.headers ?? []) {
    const key = name.toLowerCase();
    if (!DROPPED.has(key)) headers[key] = value;
    // A redirect to the sibling itself (its address, or its name on the
    // session network) is kept as its path, which the app's preview listener
    // maps; one that leaves the sibling is dropped.
    if (key === 'location') {
      let to: URL | undefined;
      try { to = new URL(value, base); } catch { to = undefined; }
      if (to && [base, `http://${target.alias}:${target.port}`].includes(to.origin)) headers.location = `${to.pathname}${to.search}`;
    }
  }
  response.writeHead(relayed.status, { ...headers, ...FIXED, 'content-length': String(body.length) });
  response.end(body);
}

// One route per depth, from the key alone (the sibling's root) to PREVIEW_DEPTH segments.
export function previewRoutes(deps: PreviewDeps): Route[] {
  return Array.from({ length: PREVIEW_DEPTH + 1 }, (_, depth) => ({
    method: 'GET' as const,
    path: ['/api/sessions/:id/preview/:key', ...Array.from({ length: depth }, (_, i) => `:p${i}`)].join('/'),
    handle: (context: RouteContext) => handle(deps, depth, context),
  }));
}
