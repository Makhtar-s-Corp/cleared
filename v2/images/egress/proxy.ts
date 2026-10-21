// The egress proxy of a session (milestone 1 plan, decision 4). It runs in
// its own container, on the session's internal network (alias `egress`) and
// on the session's own bridge network, and is the session's only way out:
// an HTTP CONNECT proxy that opens a tunnel only to a host named in the
// allow list, on the listed port, and only when every address that name
// resolves to is public and none of them is the host's own. It dials the
// address it checked, never the name again. Anything else is refused and
// logged: one JSON line per decision on stdout, for the service to read.
//
// The allow list is a file the service rewrites (one `host[:port]` or
// `*.domain[:port]` per line, `#` comments, port 443 by default); it is read
// again for every CONNECT, so a change applies to the next tunnel.
//
// Settings (environment):
//   EGRESS_ALLOW_FILE      default /etc/cleared/egress/allow
//   EGRESS_LISTEN_HOST     default egress: the proxy listens only on the
//                          address this name has, the session network's
//   EGRESS_PORT            default 3128
//   EGRESS_DENY_ADDRESSES  the host's own addresses, comma separated
//   EGRESS_CONNECT_TIMEOUT_MS  default 10000, per address dialled
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, connect as netConnect, isIP, type Server as NetServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export type AllowEntry = { readonly host: string; readonly port: number; readonly wildcard: boolean };

export class AllowListError extends Error {
  override name = 'AllowListError';
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const DEFAULT_PORT = 443;

const normalHost = (host: string): string => host.toLowerCase().replace(/\.$/, '');

function parsePort(text: string | undefined, line: string): number {
  if (text === undefined) return DEFAULT_PORT;
  const port = Number(text);
  if (!/^[0-9]{1,5}$/.test(text) || port < 1 || port > 65535) throw new AllowListError(`allow list: bad port in ${JSON.stringify(line)}`);
  return port;
}

export function parseAllowList(text: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = (raw.split('#')[0] ?? '').trim();
    if (!line) continue;
    const match = /^(\*\.)?([^:\s]+)(?::([^:\s]*))?$/.exec(line);
    const host = normalHost(match?.[2] ?? '');
    const labels = host.split('.');
    if (!match || isIP(host) !== 0 || labels.length < 2 || !labels.every((label) => LABEL.test(label)))
      throw new AllowListError(`allow list: not a host name: ${JSON.stringify(line)}`);
    entries.push({ host, port: parsePort(match[3], line), wildcard: match[1] !== undefined });
  }
  return entries;
}

export function isAllowed(entries: readonly AllowEntry[], host: string, port: number): boolean {
  const name = normalHost(host);
  return entries.some((entry) => entry.port === port && (entry.wildcard ? name.endsWith(`.${entry.host}`) : name === entry.host));
}

// The eight 16-bit groups of an IPv6 address, an embedded dotted quad included.
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16));
}

// An address in one canonical form: IPv4 dotted, an IPv4-mapped IPv6
// address as its IPv4 address, any other IPv6 address fully expanded.
function canonical(address: string): { readonly family: 'ipv4' | 'ipv6'; readonly text: string } | undefined {
  const family = isIP(address);
  if (family === 4) return { family: 'ipv4', text: address };
  if (family !== 6) return undefined;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return { family: 'ipv4', text: [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.') };
  }
  return { family: 'ipv6', text: groups.map((g) => g.toString(16)).join(':') };
}

// Never reachable through the proxy: this host, its private networks (the
// Docker bridges among them), Tailscale's shared range, link-local (cloud
// metadata), multicast and reserved space, and the IPv6 forms that embed an
// IPv4 address (NAT64, 6to4, Teredo), which could carry a private one.
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], ['fe80::', 10], ['fc00::', 7], ['ff00::', 8], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv6');

export function blockedReason(address: string, hostAddresses: ReadonlySet<string>): string | undefined {
  const form = canonical(address);
  if (!form) return 'not an address';
  for (const own of hostAddresses) {
    if (canonical(own)?.text === form.text) return 'an address of the host';
  }
  return BLOCKED.check(form.text, form.family) ? 'a private or reserved range' : undefined;
}

export function parseTarget(target: string): { host: string; port: number } | undefined {
  const match = /^\[([0-9a-fA-F:.]+)\]:([0-9]{1,5})$/.exec(target) ?? /^([A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(target);
  const port = Number(match?.[2]);
  if (!match?.[1] || port < 1 || port > 65535) return undefined;
  return { host: match[1], port };
}

// addresses: every address the name resolved to, all checked, IPv4 first
// (Docker bridge networks have no IPv6 unless it is turned on).
export type Decision =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly host?: string; readonly port?: number; readonly reason: string };

export type DecideContext = {
  readonly allow: readonly AllowEntry[];
  readonly resolve: (host: string) => Promise<string[]>;
  readonly hostAddresses: ReadonlySet<string>;
};

export async function decide(target: string, context: DecideContext): Promise<Decision> {
  const parsed = parseTarget(target);
  if (!parsed) return { ok: false, reason: 'bad_target' };
  const { host, port } = parsed;
  if (isIP(host) !== 0) return { ok: false, host, port, reason: 'ip_literal' };
  if (!isAllowed(context.allow, host, port)) return { ok: false, host, port, reason: 'not_allowed' };
  let addresses: string[];
  try {
    addresses = await context.resolve(host);
  } catch {
    return { ok: false, host, port, reason: 'unresolved' };
  }
  if (addresses.length === 0) return { ok: false, host, port, reason: 'unresolved' };
  if (addresses.some((address) => blockedReason(address, context.hostAddresses) !== undefined)) return { ok: false, host, port, reason: 'blocked_address' };
  const ordered = [...addresses.filter((a) => isIP(a) === 4), ...addresses.filter((a) => isIP(a) !== 4)];
  return { ok: true, host, port, addresses: ordered };
}

export type LogLine = {
  readonly at: string;
  readonly verdict: 'allowed' | 'refused';
  readonly host?: string;
  readonly port?: number;
  readonly reason?: string;
};

export type ProxyOptions = {
  readonly readAllowList: () => string;
  readonly resolve: (host: string) => Promise<string[]>;
  readonly connect: (port: number, address: string) => Socket;
  readonly hostAddresses: ReadonlySet<string>;
  readonly log: (line: LogLine) => void;
  // How long one address may take to accept, before the next one is tried.
  readonly connectTimeoutMs?: number;
};

function urlHost(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? '').hostname || undefined;
  } catch {
    return undefined;
  }
}

export function createProxy(options: ProxyOptions): Server {
  const record = (verdict: LogLine['verdict'], fields: Omit<LogLine, 'at' | 'verdict'>): void =>
    options.log({ at: new Date().toISOString(), verdict, ...fields });

  // Plain HTTP proxying is not offered: every request that is not a CONNECT is refused.
  const server = createServer((request, response) => {
    record('refused', { host: urlHost(request.url), reason: 'method' });
    response.writeHead(405, { allow: 'CONNECT', connection: 'close', 'content-length': '0' });
    response.end();
  });

  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    const refuse = (status: string, fields: Omit<LogLine, 'at' | 'verdict'>): void => {
      record('refused', fields);
      client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    client.on('error', () => client.destroy());
    const target = request.url ?? '';
    let allow: AllowEntry[];
    try {
      allow = parseAllowList(options.readAllowList());
    } catch {
      const parsed = parseTarget(target);
      refuse('403 Forbidden', { host: parsed?.host, port: parsed?.port, reason: 'allow_list_invalid' });
      return;
    }
    void decide(target, { allow, resolve: options.resolve, hostAddresses: options.hostAddresses }).then((decision) => {
      if (!decision.ok) {
        refuse('403 Forbidden', { host: decision.host, port: decision.port, reason: decision.reason });
        return;
      }
      // Each checked address in turn, until one accepts within the timeout.
      const dial = (index: number): void => {
        const address = decision.addresses[index];
        if (address === undefined || client.destroyed) {
          refuse('502 Bad Gateway', { host: decision.host, port: decision.port, reason: 'upstream_error' });
          return;
        }
        const upstream = options.connect(decision.port, address);
        let open = false;
        const timer = setTimeout(() => upstream.destroy(new Error('connect timeout')), options.connectTimeoutMs ?? 10_000);
        upstream.once('connect', () => {
          clearTimeout(timer);
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          open = true;
          record('allowed', { host: decision.host, port: decision.port });
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
          client.on('close', () => upstream.destroy());
        });
        upstream.on('error', () => {
          clearTimeout(timer);
          if (open) client.destroy();
          else dial(index + 1);
        });
      };
      dial(0);
    });
  });
  return server;
}

// Listens on the address `host` resolves to (the session network's, for the
// egress alias). A name that does not resolve is logged, and the process exits.
export async function listenOn(
  server: NetServer, host: string, port: number,
  deps: { readonly resolve: (host: string) => Promise<string>; readonly log: (line: object) => void; readonly exit: (code: number) => void },
): Promise<void> {
  let address: string;
  try {
    address = await deps.resolve(host);
  } catch (error) {
    deps.log({ at: new Date().toISOString(), error: `cannot resolve ${host}: ${(error as Error).message}` });
    deps.exit(1);
    return;
  }
  server.listen(port, address, () => deps.log({ at: new Date().toISOString(), listening: `${address}:${port}` }));
}

function main(): void {
  const allowFile = process.env.EGRESS_ALLOW_FILE || '/etc/cleared/egress/allow';
  const listenHost = process.env.EGRESS_LISTEN_HOST || 'egress';
  const port = Number(process.env.EGRESS_PORT || 3128);
  const hostAddresses = new Set((process.env.EGRESS_DENY_ADDRESSES ?? '').split(',').map((a) => a.trim()).filter(Boolean));
  const server = createProxy({
    readAllowList: () => readFileSync(allowFile, 'utf8'),
    resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
    connect: (upstreamPort, address) => netConnect({ port: upstreamPort, host: address }),
    hostAddresses,
    log: (line) => console.log(JSON.stringify(line)),
    connectTimeoutMs: Number(process.env.EGRESS_CONNECT_TIMEOUT_MS || 10_000),
  });
  void listenOn(server, listenHost, port, {
    resolve: async (host) => (await lookup(host)).address,
    log: (line) => console.log(JSON.stringify(line)),
    exit: (code) => process.exit(code),
  });
}

if (import.meta.main) main();
