import test from 'node:test';
import assert from 'node:assert/strict';
import { Socket, connect as netConnect, createServer, type AddressInfo, type Server } from 'node:net';
import { once } from 'node:events';
import { AllowListError, blockedReason, createProxy, decide, isAllowed, listenOn, parseAllowList, parseTarget, type LogLine } from '../../images/egress/proxy.ts';

// 203.0.113.0/24 is a documentation range the proxy does not block by itself;
// here it stands for the host's own public address, which it must block.
const HOST_ADDRESSES = new Set(['203.0.113.7', '2001:db8::7']);

test('the allow list takes host names, optional ports and leading wildcards, and comments', () => {
  const entries = parseAllowList('# models\napi.anthropic.com\n\n  registry.npmjs.org:443  \n*.example.org:8443 # a note\nAPI.Example.COM.\n');
  assert.deepEqual(entries, [
    { host: 'api.anthropic.com', port: 443, wildcard: false },
    { host: 'registry.npmjs.org', port: 443, wildcard: false },
    { host: 'example.org', port: 8443, wildcard: true },
    { host: 'api.example.com', port: 443, wildcard: false },
  ]);
  for (const line of ['http://x.org', 'x.org:0', 'x.org:65536', '*', '*.com.*', '10.0.0.1', '[::1]:443', 'a b', 'x_y.org', '-x.org', 'x.org/path']) {
    assert.throws(() => parseAllowList(line), AllowListError, line);
  }
});

test('a host matches only its own entry, a wildcard only strict subdomains, and only on the listed port', () => {
  const entries = parseAllowList('api.anthropic.com\n*.npmjs.org\n');
  assert.ok(isAllowed(entries, 'api.anthropic.com', 443));
  assert.ok(isAllowed(entries, 'API.anthropic.com.', 443));
  assert.ok(isAllowed(entries, 'registry.npmjs.org', 443));
  assert.ok(!isAllowed(entries, 'npmjs.org', 443));
  assert.ok(!isAllowed(entries, 'api.anthropic.com', 80));
  assert.ok(!isAllowed(entries, 'evilapi.anthropic.com', 443));
  assert.ok(!isAllowed(entries, 'api.anthropic.com.evil.org', 443));
  assert.ok(!isAllowed([], 'api.anthropic.com', 443));
});

test('private, loopback, link-local, shared, multicast and the host own addresses are blocked', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.88.177.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.17.0.1',
    '172.31.255.255', '192.168.1.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '239.1.2.3', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd7a:115c:a1e0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '64:ff9b::a00:1', '203.0.113.7', '2001:db8::7', 'not an address',
    // 6to4 and Teredo embed an IPv4 address, which could be a private one.
    '2002:a00:1::1', '2002:c0a8:101::', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ];
  for (const address of blocked) assert.ok(blockedReason(address, HOST_ADDRESSES), address);
  for (const address of ['160.79.104.10', '104.16.0.1', '2607:6bc0::10', '::ffff:160.79.104.10', '172.32.0.1', '100.128.0.1', '203.0.113.8']) {
    assert.equal(blockedReason(address, HOST_ADDRESSES), undefined, address);
  }
});

test('a CONNECT target is a host and a port, nothing else', () => {
  assert.deepEqual(parseTarget('api.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 });
  assert.deepEqual(parseTarget('[::1]:443'), { host: '::1', port: 443 });
  for (const target of ['api.anthropic.com', 'api.anthropic.com:', ':443', 'a:b', 'a:70000', 'http://a:443', 'a/b:443', 'a b:443']) {
    assert.equal(parseTarget(target), undefined, target);
  }
});

const ALLOW = parseAllowList('api.anthropic.com\nrebind.example.org\nsplit.example.org\ndual.example.org\n');
const DNS: Record<string, string[]> = {
  'api.anthropic.com': ['160.79.104.10'],
  'dual.example.org': ['2607:6bc0::10', '160.79.104.12'],
  'rebind.example.org': ['127.0.0.1'],
  'split.example.org': ['160.79.104.11', '10.0.0.5'],
};
const resolve = async (host: string): Promise<string[]> => {
  const found = DNS[host];
  if (!found) throw new Error(`ENOTFOUND ${host}`);
  return found;
};

test('the decision allows a listed public host and refuses everything else with a reason', async () => {
  const context = { allow: ALLOW, resolve, hostAddresses: HOST_ADDRESSES };
  assert.deepEqual(await decide('api.anthropic.com:443', context), { ok: true, host: 'api.anthropic.com', port: 443, addresses: ['160.79.104.10'] });
  // Docker bridges have no IPv6 by default: IPv4 addresses are dialled first.
  assert.deepEqual(await decide('dual.example.org:443', context), { ok: true, host: 'dual.example.org', port: 443, addresses: ['160.79.104.12', '2607:6bc0::10'] });
  const refusals: [string, string][] = [
    ['example.com:443', 'not_allowed'],
    ['api.anthropic.com:22', 'not_allowed'],
    ['160.79.104.10:443', 'ip_literal'],
    ['[::1]:443', 'ip_literal'],
    ['100.88.177.1:9119', 'ip_literal'],
    ['rebind.example.org:443', 'blocked_address'],
    ['split.example.org:443', 'blocked_address'],
    ['nonsense', 'bad_target'],
  ];
  for (const [target, reason] of refusals) {
    const decision = await decide(target, context);
    assert.equal(decision.ok, false, target);
    if (!decision.ok) assert.equal(decision.reason, reason, target);
  }
  const unresolved = await decide('api.anthropic.com:443', { ...context, resolve: async () => { throw new Error('ENOTFOUND'); } });
  assert.deepEqual(unresolved, { ok: false, host: 'api.anthropic.com', port: 443, reason: 'unresolved' });
});

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

// Sends raw bytes to the proxy and returns the first response chunk and the socket.
async function rawRequest(port: number, text: string): Promise<{ head: string; socket: Socket }> {
  const socket = netConnect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(text);
  const [chunk] = (await once(socket, 'data')) as [Buffer];
  return { head: chunk.toString('latin1'), socket };
}

test('the proxy tunnels an allowed CONNECT, refuses the rest, and logs one line per decision', async (t) => {
  const echo = createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const dialled: string[] = [];
  const lines: LogLine[] = [];
  let allowText = 'api.anthropic.com\n';
  const proxy = createProxy({
    readAllowList: () => allowText,
    resolve,
    hostAddresses: HOST_ADDRESSES,
    // The upstream is the local echo server, whatever the decision named.
    connect: (port, address) => { dialled.push(`${address}:${port}`); return netConnect(echoPort, '127.0.0.1'); },
    log: (line) => lines.push(line),
  });
  const proxyPort = await listen(proxy);
  t.after(() => { proxy.close(); echo.close(); });

  const allowed = await rawRequest(proxyPort, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
  assert.match(allowed.head, /^HTTP\/1\.1 200 /);
  allowed.socket.write('ping');
  const [echoed] = (await once(allowed.socket, 'data')) as [Buffer];
  assert.equal(echoed.toString(), 'ping');
  allowed.socket.destroy();
  assert.deepEqual(dialled, ['160.79.104.10:443'], 'the proxy dials the address it checked, not the name');

  const refused = await rawRequest(proxyPort, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  assert.match(refused.head, /^HTTP\/1\.1 403 /);
  refused.socket.destroy();

  const plain = await rawRequest(proxyPort, 'GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n');
  assert.match(plain.head, /^HTTP\/1\.1 405 /);
  plain.socket.destroy();

  // The service rewrites the allow list; the next CONNECT reads the new one.
  allowText = '# nothing\n';
  const removed = await rawRequest(proxyPort, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n');
  assert.match(removed.head, /^HTTP\/1\.1 403 /);
  removed.socket.destroy();

  allowText = 'not a host\n';
  const broken = await rawRequest(proxyPort, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n');
  assert.match(broken.head, /^HTTP\/1\.1 403 /);
  broken.socket.destroy();

  assert.deepEqual(lines.map((line) => [line.verdict, line.host, line.port, line.reason]), [
    ['allowed', 'api.anthropic.com', 443, undefined],
    ['refused', 'example.com', 443, 'not_allowed'],
    ['refused', 'api.anthropic.com', undefined, 'method'],
    ['refused', 'api.anthropic.com', 443, 'not_allowed'],
    ['refused', 'api.anthropic.com', 443, 'allow_list_invalid'],
  ]);
  for (const line of lines) assert.match(line.at, /^\d{4}-\d{2}-\d{2}T/);
});

// A socket that fails as soon as it is used, like a dial to an unreachable address.
function failing(): Socket {
  const socket = new Socket();
  process.nextTick(() => socket.destroy(new Error('ENETUNREACH')));
  return socket;
}

test('the proxy tries each checked address in turn, and gives up on one that never answers', async (t) => {
  const echo = createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const dialled: string[] = [];
  const lines: LogLine[] = [];
  const proxy = createProxy({
    readAllowList: () => 'dual.example.org\napi.anthropic.com\n',
    resolve,
    hostAddresses: HOST_ADDRESSES,
    connect: (port, address) => {
      dialled.push(`${address}:${port}`);
      if (address === '160.79.104.12') return failing();
      // An address that never answers: a socket that is never connected.
      if (address === '160.79.104.10') return new Socket();
      return netConnect(echoPort, '127.0.0.1');
    },
    log: (line) => lines.push(line),
    connectTimeoutMs: 50,
  });
  const proxyPort = await listen(proxy);
  t.after(() => { proxy.close(); echo.close(); });

  const fallback = await rawRequest(proxyPort, 'CONNECT dual.example.org:443 HTTP/1.1\r\n\r\n');
  assert.match(fallback.head, /^HTTP\/1\.1 200 /);
  fallback.socket.write('ping');
  const [echoed] = (await once(fallback.socket, 'data')) as [Buffer];
  assert.equal(echoed.toString(), 'ping');
  fallback.socket.destroy();
  assert.deepEqual(dialled, ['160.79.104.12:443', '2607:6bc0::10:443']);

  const silent = await rawRequest(proxyPort, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n');
  assert.match(silent.head, /^HTTP\/1\.1 502 /);
  silent.socket.destroy();
  assert.deepEqual(lines.map((line) => [line.verdict, line.host, line.reason]), [
    ['allowed', 'dual.example.org', undefined],
    ['refused', 'api.anthropic.com', 'upstream_error'],
  ]);
});

test('a listen address that does not resolve is logged and exits 1', async () => {
  const lines: object[] = [];
  const exits: number[] = [];
  const server = createServer();
  await listenOn(server, 'egress', 3128, {
    resolve: async () => { throw new Error('getaddrinfo EAI_AGAIN egress'); },
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
  });
  assert.deepEqual(exits, [1]);
  assert.equal(lines.length, 1);
  assert.match(JSON.stringify(lines[0]), /"error":"cannot resolve egress: getaddrinfo EAI_AGAIN egress"/);
  assert.equal(server.listening, false);
});
