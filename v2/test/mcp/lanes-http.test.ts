// The lanes' MCP server over HTTP (P216): POST /mcp on the service, MCP's
// Streamable HTTP answered in plain JSON, behind a local token of its own
// (never the app's proof), for peers of this machine or the tailnet only,
// addressed to 127.0.0.1, localhost or the tailnet address they came in on
// (issue #347). Driven by a fake MCP client over loopback, port 0; no real
// Claude Code is configured. The tokens are made at run time. A request
// from an address of this machine outside loopback and the tailnet (issue
// #353) reaches the loopback listener with that address as its source: the
// listener never opens wider.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../../src/api/routes.ts';
import { MCP_PATH, MCP_ACCESS_FILE, lanesMcpRoutes, mcpTokenPath, privatePeer, readOrCreateMcpToken, type McpRouteDeps } from '../../src/mcp/http.ts';
import { createRedactor } from '../../src/mcp/redact.ts';
import { PROOF_FILE, proofPath, readOrCreateProof } from '../../src/modules/users.ts';
import { dispatch, type App, type Route } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { setup, type Setup } from '../flow/support.ts';

const TOKEN = randomBytes(32).toString('hex');
const PROOF = randomBytes(32).toString('hex');

type Served = { t: Setup; url: string; post: (body: unknown, headers?: Record<string, string>) => Promise<Response>; close: () => Promise<void> };
const open: Served[] = [];
after(async () => { for (const served of open) await served.close(); });

async function serve(overrides: Partial<McpRouteDeps> = {}, extra: Route[] = []): Promise<Served> {
  const t = await setup();
  const routes = [...lanesMcpRoutes({
    engine: () => t.engine, store: () => t.store, token: () => TOKEN, language: 'en',
    redactor: createRedactor({ env: {}, paths: [] }), ...overrides,
  }), ...extra];
  const app: App = { registry: t.engine.registry, tables: [], routes };
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `${base}${MCP_PATH}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const served: Served = {
    t, url, post,
    close: async () => {
      await t.engine.settled();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  open.push(served);
  return served;
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-client', version: '0' } } };

test('the route is POST /mcp, and the token is a file of its own beside the ledger', () => {
  assert.equal(MCP_PATH, '/mcp');
  const routes = lanesMcpRoutes({ engine: () => undefined, store: () => undefined, token: () => undefined, language: 'en', redactor: createRedactor({ env: {}, paths: [] }) });
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ['POST /mcp']);
  assert.equal(mcpTokenPath('/state/ledger.db'), `/state/${MCP_ACCESS_FILE}`);
  assert.notEqual(MCP_ACCESS_FILE, PROOF_FILE);
});

test('the token is made once, 64 hex characters that only this account reads, and is not the app\'s proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-token-'));
  const path = mcpTokenPath(join(dir, 'ledger.db'));
  const token = readOrCreateMcpToken(path);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readOrCreateMcpToken(path), token, 'read again, not made again');
  assert.equal(readFileSync(path, 'utf8').trim(), token);
  assert.notEqual(readOrCreateProof(proofPath(join(dir, 'ledger.db'))), token);
  chmodSync(path, 0o640);
  assert.throws(() => readOrCreateMcpToken(path), /MCP token .* can be read by others/);
  const bad = join(dir, 'bad-token');
  writeFileSync(bad, 'short\n', { mode: 0o600 });
  assert.throws(() => readOrCreateMcpToken(bad), /MCP token .* 64 hex/);
});

test('a client initializes, is told the notification was taken (202, no body), lists the tools and calls one, in plain JSON', async () => {
  const s = await serve();
  const init = await s.post(initialize);
  assert.equal(init.status, 200);
  assert.match(init.headers.get('content-type') ?? '', /^application\/json/);
  const body = await init.json() as { id: number; result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.equal(body.result.serverInfo.name, 'cleared-lanes');
  const note = await s.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': '2025-06-18' });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  const list = await (await s.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' })).json() as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['list_lanes', 'list_tickets', 'locked_files']);
  const call = await (await s.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'locked_files', arguments: { path: 'src/entries.ts' } } })).json() as { result: { structuredContent: unknown } };
  assert.deepEqual(call.result.structuredContent, { locked: false, files: [] });
  const accepted = await s.post({ jsonrpc: '2.0', id: 'from-the-client', result: {} });
  assert.equal(accepted.status, 202, 'a response the client sends is taken');
});

test('no token, a wrong token or the app\'s proof is 401; the token opens no route of the app', async () => {
  const api = createApiRoutes({ engine: () => undefined, proof: () => PROOF }).filter((route) => route.path === '/api/sessions');
  const s = await serve({}, api);
  const without = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initialize) });
  assert.equal(without.status, 401);
  assert.match(without.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.equal((await s.post(initialize, { authorization: `Bearer ${randomBytes(32).toString('hex')}` })).status, 401);
  assert.equal((await s.post(initialize, { authorization: `Bearer ${PROOF}` })).status, 401);
  assert.equal((await s.post(initialize, { authorization: TOKEN })).status, 401, 'the Bearer scheme is required');
  assert.equal((await s.post(initialize, { authorization: '', 'x-cleared-proof': TOKEN })).status, 401);
  const app = await fetch(s.url.replace(MCP_PATH, '/api/sessions'), { headers: { 'x-cleared-proof': TOKEN, authorization: `Bearer ${TOKEN}` } });
  assert.equal(app.status, 401, 'the MCP token is not the app\'s proof');
});

test('a browser\'s request (an Origin) is 403, and the other methods are 405', async () => {
  const s = await serve();
  assert.equal((await s.post(initialize, { origin: 'http://127.0.0.1:5173' })).status, 403);
  assert.equal((await s.post(initialize, { origin: 'null' })).status, 403);
  const get = await fetch(s.url, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await fetch(s.url, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
});

test('an unknown protocol version, another content type, a body too large, a line that is not JSON or a batch is refused', async () => {
  const s = await serve();
  assert.equal((await s.post(initialize, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  assert.equal((await s.post(initialize, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await s.post({ ...initialize, params: { pad: 'x'.repeat(70 * 1024) } })).status, 413);
  const parse = await s.post('{not json');
  assert.equal(parse.status, 400);
  assert.equal((await parse.json() as { error: { code: number } }).error.code, -32700);
  const batch = await s.post([initialize]);
  assert.equal(batch.status, 400);
  assert.equal((await batch.json() as { error: { code: number } }).error.code, -32600);
  const method = await (await s.post({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).json() as { error: { code: number } };
  assert.equal(method.error.code, -32601);
});

test('no token to check (it could not be made) or no flow: 503, the reason said without a value', async () => {
  const noToken = await serve({ token: () => undefined });
  assert.equal((await noToken.post(initialize)).status, 503);
  const noFlow = await serve({ engine: () => undefined });
  const answer = await noFlow.post(initialize);
  assert.equal(answer.status, 503);
  assert.match(await answer.text(), /CLEARED_V2_PROJECT/);
});

test('only this machine and the tailnet: loopback, 100.64.0.0/10 and fd7a:115c:a1e0::/48; not a Docker bridge nor another private range', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.127.255.254', '::ffff:100.101.102.103', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12::42'])
    assert.equal(privatePeer(address), true, address);
  for (const address of ['8.8.8.8', '172.17.0.2', '172.16.0.1', '10.1.2.3', '192.168.1.20', 'fc00::5', 'fd7a:115c:a1e1::1', '100.128.0.1', '100.63.255.255', '2001:db8::1', '::ffff:8.8.8.8', '::ffff:172.17.0.2', 'fe80::1', '', undefined, 'not an address'])
    assert.equal(privatePeer(address), false, String(address));
});

// The route called with a request made here, for what a socket of this machine cannot be: a peer on a Docker
// bridge, a request that came in on a tailnet address, a request with no Host. Counts the token's reads.
async function direct(socket: { remoteAddress: string; localAddress: string }, host: string | undefined): Promise<{ status: number; sent: string; reads: number }> {
  const t = await setup();
  let reads = 0;
  const route = lanesMcpRoutes({ engine: () => t.engine, store: () => t.store, token: () => { reads += 1; return TOKEN; }, language: 'en', redactor: createRedactor({ env: {}, paths: [] }) })[0] as Route;
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(initialize))]), {
    method: 'POST', url: MCP_PATH, socket,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(host === undefined ? {} : { host }) },
  }) as unknown as IncomingMessage;
  let status = 0;
  let sent = '';
  const response = {
    headersSent: false,
    writeHead(code: number) { status = code; return this; },
    end(text?: string) { sent = text ?? ''; },
  } as unknown as ServerResponse;
  await route.handle({ request, response, params: {}, registry: t.engine.registry });
  await t.engine.settled();
  return { status, sent, reads };
}

test('a peer outside this machine and the tailnet, a session\'s container on a Docker bridge, is 403 before the token is read', async () => {
  const answer = await direct({ remoteAddress: '172.17.0.2', localAddress: '172.17.0.1' }, '172.17.0.1:8791');
  assert.equal(answer.status, 403);
  assert.equal(answer.reads, 0, 'the token is not read');
  assert.doesNotMatch(answer.sent, new RegExp(TOKEN));
});

type Raw = { status: number; body: string };
// One POST of initialize through node:http, which lets the Host header and the source address be set.
function rawPost(url: string, options: { host?: string; localAddress?: string } = {}): Promise<Raw> {
  const target = new URL(url);
  const body = JSON.stringify(initialize);
  return new Promise((resolve, reject) => {
    const sent = httpRequest({
      host: target.hostname, port: target.port, path: target.pathname, method: 'POST',
      ...(options.localAddress ? { localAddress: options.localAddress } : {}),
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${TOKEN}`,
        ...(options.host === undefined ? {} : { host: options.host }),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    sent.on('error', reject);
    sent.end(body);
  });
}

test('a Host that is not 127.0.0.1, localhost or [::1] is 403 before the token is read, beside the Origin\'s 403 (issue #347)', async () => {
  let reads = 0;
  const s = await serve({ token: () => { reads += 1; return TOKEN; } });
  const port = new URL(s.url).port;
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LocalHost:${port}`, `[::1]:${port}`, '127.0.0.1', 'localhost']) {
    const answer = await rawPost(s.url, { host });
    assert.equal(answer.status, 200, host);
  }
  const accepted = reads;
  assert.ok(accepted > 0);
  // A name that resolves to this machine (DNS rebinding), another spelling of loopback, a tailnet address the request did not come in on.
  for (const host of [`evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.:${port}`, `127.1:${port}`, `0.0.0.0:${port}`, `[::ffff:127.0.0.1]:${port}`,
    `user@127.0.0.1:${port}`, `localhost:${port}:1`, 'localhost:abc', `100.101.102.103:${port}`, `[fd7a:115c:a1e0::1]:${port}`]) {
    const answer = await rawPost(s.url, { host });
    assert.equal(answer.status, 403, host);
    assert.match(answer.body, /127\.0\.0\.1, localhost/, host);
    assert.doesNotMatch(answer.body, /evil|nip\.io|user@/, 'the Host received is not repeated');
  }
  assert.equal(reads, accepted, 'a refused Host never reads the token');
  assert.equal((await s.post(initialize, { origin: `http://127.0.0.1:${port}` })).status, 403, 'an Origin is refused with a good Host too');
  const none = await direct({ remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' }, undefined);
  assert.equal(none.status, 403, 'no Host');
  assert.equal(none.reads, 0);
});

test('the tailnet address the request came in on is a Host the route takes, and no other one', async () => {
  const v4 = { remoteAddress: '100.101.102.103', localAddress: '100.70.0.1' };
  assert.equal((await direct(v4, '100.70.0.1:8791')).status, 200);
  assert.equal((await direct(v4, '100.70.0.1')).status, 200);
  assert.equal((await direct({ remoteAddress: '::ffff:100.101.102.103', localAddress: '::ffff:100.70.0.1' }, '100.70.0.1:8791')).status, 200);
  const v6 = { remoteAddress: 'fd7a:115c:a1e0::2', localAddress: 'fd7a:115c:a1e0::eb2c:1' };
  assert.equal((await direct(v6, '[fd7a:115c:a1e0::eb2c:1]:8791')).status, 200);
  assert.equal((await direct(v6, '[fd7a:115c:a1e0:0:0:0:eb2c:1]:8791')).status, 200, 'the same address written whole');
  for (const [socket, host] of [[v4, '100.70.0.2:8791'], [v4, '100.70.0.1.example:8791'], [v6, '[fd7a:115c:a1e0::eb2c:2]:8791'],
    [{ remoteAddress: '100.101.102.103', localAddress: '172.17.0.1' }, '172.17.0.1:8791']] as const) {
    const answer = await direct(socket, host);
    assert.equal(answer.status, 403, host);
    assert.equal(answer.reads, 0, host);
  }
});

// An address of this machine that is neither loopback nor the tailnet's: its LAN, its public address, a Docker bridge.
function outsideAddress(): string | undefined {
  return Object.values(networkInterfaces()).flat()
    .find((entry) => entry !== undefined && !entry.internal && entry.family === 'IPv4' && !privatePeer(entry.address))?.address;
}

test('a request from an address of this machine outside loopback and the tailnet, on a real socket, is 403 before the token is read (issue #353)', async (context) => {
  const source = outsideAddress();
  if (!source) return context.skip('this machine has no IPv4 address outside loopback and the tailnet');
  let reads = 0;
  const s = await serve({ token: () => { reads += 1; return TOKEN; } });
  let answer: Raw;
  try {
    answer = await rawPost(s.url, { localAddress: source });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (['EADDRNOTAVAIL', 'EINVAL', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return context.skip(`the loopback listener cannot be reached from that address here (${code})`);
    throw error;
  }
  assert.equal(answer.status, 403);
  assert.match(answer.body, /this machine and the tailnet only/);
  assert.equal(reads, 0, 'the token is not read');
  const control = await rawPost(s.url);
  assert.equal(control.status, 200, 'the same server answers a loopback peer');
  assert.equal(reads, 1);
});
