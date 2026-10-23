// Docker's address pools and what is left of them (issue 265): every
// session takes two networks, so a pool with fewer than two free subnets
// stops the next session. The doctor's `pool` section prints it.
//
// What is taken is read without listing anything Docker holds that is not
// labelled cleared.dev=v2: the subnets of the host's interfaces (docker0 and
// each bridge network's br-<id>), and the subnets of the labelled networks,
// which an internal network with an isolated gateway does not show on the
// host. An unlabelled internal network is not seen: the free count is then
// an upper bound, and the doctor says so.

// One pool: a base CIDR, cut into subnets of `size` bits.
export type Pool = { readonly base: string; readonly size: number };

// Docker's defaults when daemon.json sets no default-address-pools
// (libnetwork's ipamutils): 15 subnets of /16 in 172.17 to 172.31, and
// 16 subnets of /20 in 192.168: 31 in all.
export const DOCKER_DEFAULT_POOLS: readonly Pool[] = [
  { base: '172.17.0.0/16', size: 16 }, { base: '172.18.0.0/16', size: 16 }, { base: '172.19.0.0/16', size: 16 },
  { base: '172.20.0.0/14', size: 16 }, { base: '172.24.0.0/14', size: 16 }, { base: '172.28.0.0/14', size: 16 },
  { base: '192.168.0.0/16', size: 20 },
];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function toNumber(address: string): number | undefined {
  const match = IPV4.exec(address);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  return (((parts[0] as number) << 24) >>> 0) + ((parts[1] as number) << 16) + ((parts[2] as number) << 8) + (parts[3] as number);
}

const toAddress = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// A CIDR as its first address and its prefix length, or undefined.
export function parseCidr(cidr: string): { readonly start: number; readonly bits: number } | undefined {
  const [address, prefix] = cidr.split('/');
  const n = toNumber(address ?? '');
  const bits = Number(prefix);
  if (n === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { start: (n & mask) >>> 0, bits };
}

const span = (bits: number): number => 2 ** (32 - bits);

// The pools daemon.json names (`default-address-pools`), or undefined when
// it names none or cannot be read as JSON.
export function poolsOfDaemon(json: string): Pool[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const pools = (parsed as { 'default-address-pools'?: unknown })?.['default-address-pools'];
  if (!Array.isArray(pools) || pools.length === 0) return undefined;
  const out = pools.flatMap((p: { base?: unknown; size?: unknown }) => {
    const cidr = typeof p?.base === 'string' ? parseCidr(p.base) : undefined;
    const size = Number(p?.size);
    return cidr && Number.isInteger(size) && size >= cidr.bits && size <= 32 ? [{ base: String(p.base), size }] : [];
  });
  return out.length > 0 ? out : undefined;
}

// Each subnet the pools can give, as a CIDR.
export function subnetsOf(pools: readonly Pool[]): string[] {
  const out: string[] = [];
  for (const pool of pools) {
    const cidr = parseCidr(pool.base);
    if (!cidr) continue;
    for (let at = cidr.start; at < cidr.start + span(cidr.bits); at += span(pool.size)) out.push(`${toAddress(at)}/${pool.size}`);
  }
  return out;
}

// The host's IPv4 subnets, as os.networkInterfaces() gives them (cidr).
export function interfaceSubnets(interfaces: Readonly<Record<string, readonly { readonly family: string | number; readonly cidr: string | null; readonly internal: boolean }[] | undefined>>): string[] {
  return Object.values(interfaces).flatMap((list) => (list ?? []).filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal && a.cidr).map((a) => a.cidr as string));
}

const overlaps = (a: { start: number; bits: number }, b: { start: number; bits: number }): boolean =>
  a.start < b.start + span(b.bits) && b.start < a.start + span(a.bits);

// How many of the pools' subnets are taken by `taken` (CIDRs), and how many are free.
export function poolUsage(pools: readonly Pool[], taken: readonly string[]): { readonly total: number; readonly taken: number; readonly free: number } {
  const used = taken.map(parseCidr).filter((c): c is NonNullable<typeof c> => c !== undefined);
  const subnets = subnetsOf(pools).map((s) => parseCidr(s) as { start: number; bits: number });
  const busy = subnets.filter((s) => used.some((u) => overlaps(s, u))).length;
  return { total: subnets.length, taken: busy, free: subnets.length - busy };
}
