// The lanes' MCP server over HTTP (P216): POST /mcp on the service, so a
// local Claude Code reads the lanes the service runs (lanes.ts) before it
// edits. MCP's Streamable HTTP transport, the answer always one JSON body:
// no event stream, no session id. GET and DELETE are 405, which the
// transport allows for a server with no stream.
//
// Three checks, in this order, before a message is read:
//   1. the peer: this machine or the tailnet (100.64.0.0/10 and its IPv6
//      fd7a:115c:a1e0::/48), as B3.2 says; anyone else is 403, whatever
//      address the service was told to listen on. Not the other private
//      ranges: a session's container reaches the host from a Docker bridge
//      (172.17.0.0/16 and the like), and a container is never trusted;
//   2. no Origin: a request from a web page is 403, so a page the person
//      opens cannot reach the server through their browser;
//   3. the token: Authorization: Bearer <the v2-mcp-token file beside
//      ledger.db>, compared in constant time. It is a file of its own, made
//      as the app's proof is (64 hex characters, mode 600, this account's),
//      and never the app's proof: the proof with a user id opens every
//      route that writes, this token opens POST /mcp only, and no other
//      route takes it.
// A message the client answers or a notification is 202 with no body. A
// body that is not JSON or not one JSON-RPC message (a batch) is 400 with
// the JSON-RPC error. The words are the lanes' catalog's.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { dirname, join } from 'node:path';
import type { Language } from '../../app/src/catalog.ts';
import { translator } from '../../app/web/lib/i18n.ts';
import type { FlowEngine } from '../flow/engine.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { readOrCreateProof, sameProof } from '../modules/users.ts';
import type { Store } from '../store/db.ts';
import { createLanesServer, lanesCatalog } from './lanes.ts';
import type { Redactor } from './redact.ts';
import { PROTOCOL_VERSIONS, type ToolServer } from './rpc.ts';

export const MCP_PATH = '/mcp';
export const MCP_ACCESS_FILE = 'v2-mcp-token';
const MAX_BODY = 64 * 1024;

export function mcpTokenPath(ledger: string): string {
  return join(dirname(ledger), MCP_ACCESS_FILE);
}

export function readOrCreateMcpToken(path: string): string {
  return readOrCreateProof(path, 'the MCP token');
}

const PRIVATE = new BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

// Whether a peer's address is this machine's or the tailnet's.
export function privatePeer(address: string | undefined): boolean {
  if (!address) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip);
  if (family === 0) return false;
  return PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export type McpRouteDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly store: () => Store | undefined;
  // The token, or undefined when it could not be made or read (said in the service's log).
  readonly token: () => string | undefined;
  // Read when a request comes, so the service's start decides them, not its import.
  readonly language: () => Language;
  readonly redactor: () => Redactor;
  readonly log?: (line: string) => void;
};

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    response.writeHead(status, { 'cache-control': 'no-store', ...headers });
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', ...headers });
  response.end(text);
}

// The body, or undefined once it passed MAX_BODY: what is left is not read.
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function lanesMcpRoutes(deps: McpRouteDeps): Route[] {
  const refuse = (context: RouteContext, status: number, key: string, values?: Record<string, string | number>, headers?: Record<string, string>) =>
    send(context.response, status, { error: translator(lanesCatalog(deps.language()))(key, values) }, headers);
  // One tool server per engine, made again when the language or the cleaner changed (a new start).
  const servers = new WeakMap<FlowEngine, { server: ToolServer; language: Language; redactor: Redactor }>();
  const serverOf = (engine: FlowEngine): ToolServer => {
    const language = deps.language();
    const redactor = deps.redactor();
    const known = servers.get(engine);
    if (known && known.language === language && known.redactor === redactor) return known.server;
    const server = createLanesServer({ engine, store: deps.store(), redactor, language, ...(deps.log ? { log: deps.log } : {}) });
    servers.set(engine, { server, language, redactor });
    return server;
  };

  async function handle(context: RouteContext): Promise<void> {
    const { request, response } = context;
    if (!privatePeer(request.socket.remoteAddress)) return refuse(context, 403, 'http_peer');
    if (request.headers.origin !== undefined) return refuse(context, 403, 'http_origin');
    const token = deps.token();
    if (token === undefined) return refuse(context, 503, 'http_unreadable');
    const given = /^Bearer ([^\s]+)$/.exec(header(request, 'authorization') ?? '')?.[1];
    if (!sameProof(given, token)) return refuse(context, 401, 'http_unauthorized', undefined, { 'www-authenticate': 'Bearer realm="cleared-lanes"' });
    const engine = deps.engine(context.registry);
    if (!engine || !deps.store()) return refuse(context, 503, 'error_no_flow');
    const version = header(request, 'mcp-protocol-version');
    if (version !== undefined && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) return refuse(context, 400, 'http_version');
    if (!/^application\/json\s*(;|$)/i.test(header(request, 'content-type') ?? '')) return refuse(context, 415, 'http_content_type');
    const body = await readBody(request);
    if (body === undefined) return refuse(context, 413, 'http_too_large', { max: MAX_BODY / 1024 });
    const server = serverOf(engine);
    let message: unknown;
    try { message = JSON.parse(body); } catch { return send(response, 400, server.unparsable()); }
    // A client's answer to the server: there is nothing to answer back.
    if (isRecord(message) && !('method' in message) && ('result' in message || 'error' in message)) return send(response, 202, undefined);
    const answer = await server.handle(message);
    if (answer === undefined) return send(response, 202, undefined);
    send(response, answer.error && answer.id === null ? 400 : 200, answer);
  }

  return [{ method: 'POST', path: MCP_PATH, handle }];
}
