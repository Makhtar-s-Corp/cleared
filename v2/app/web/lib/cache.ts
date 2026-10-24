// The page's shared cache (docs/v2/ui-overhaul-plan.md, 2.1.2 to 2.1.7 and
// U2, lane 34): one entry per resource of the service, read by every screen
// and by the shell, kept by TanStack Query's QueryClient.
//
// - A resource is a path of the service's API without a query string, named
//   by resourceOf(): '/sessions' is ['sessions'], '/sessions/<id>' is
//   ['session', id], and so on. Any other read (a file, a cursor read such
//   as '/lead/messages?after=4') goes to the network as before.
// - A read answers the cache's value at once when it has one; a stale value
//   is answered too, and refetched behind it (stale while revalidate).
// - While the change stream is open (lib/events.tsx), the resources it
//   covers (COVERED) are fresh until an event names them; the others, and
//   every resource while the stream is down, are stale after POLL_MS, the
//   polling interval of the screens before (the inbox after INBOX_POLL_MS). The poller refetches what a
//   mounted screen or the shell reads and is stale: with the stream open,
//   only the uncovered resources; with it down, all of them.
// - An event refetches the resources it names that the cache holds, and
//   nothing else; a reconnect refetches everything held, once.
// - A subscriber (a screen's live refresh, the shell's count) is called
//   when a resource it read has a new value, from a fetch or a gesture.
// - A gesture's write is optimistic where the list can say its outcome at
//   once (optimistic()): the cache moves first, and moves back if the
//   service refuses; then what the write touched is refetched.
//
// No React here: lib/query.tsx binds it to the components, and the node
// tests drive it with a stand-in fetch and clock.
import { QueryClient } from '@tanstack/react-query';
import type { ChangeEvent } from '../../../src/api/types.ts';

export type Key = readonly [string, ...string[]];
export type Read = (path: string) => Promise<unknown>;
export type Write = (path: string, init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown }) => Promise<unknown>;

export const POLL_MS = 10_000;
// The inbox, while the stream is down, sooner: an agent's question is on
// screen within 5 s of being asked (issue #269), a tick and a read included.
export const INBOX_POLL_MS = 3000;
const TICK_MS = 1000;

const NAMED: readonly (readonly [RegExp, (id: string) => Key])[] = [
  [/^\/sessions$/, () => ['sessions']],
  [/^\/sessions\/([^/]+)$/, (id) => ['session', id]],
  [/^\/tickets$/, () => ['tickets']],
  [/^\/tickets\/([^/]+)$/, (id) => ['ticket', id]],
  [/^\/tickets\/([^/]+)\/steps$/, (id) => ['steps', id]],
  [/^\/inbox$/, () => ['inbox']],
  [/^\/workspace$/, () => ['workspace']],
  [/^\/lead$/, () => ['lead']],
  [/^\/lead\/messages$/, () => ['lead-messages']],
  [/^\/lead\/memory$/, () => ['lead-memory']],
  [/^\/plans$/, () => ['plans']],
  [/^\/plans\/([^/]+)$/, (id) => ['plan', id]],
  [/^\/recipes$/, () => ['recipes']],
  [/^\/schedules$/, () => ['schedules']],
  [/^\/batches$/, () => ['batches']],
  [/^\/batches\/([^/]+)$/, (id) => ['batch', id]],
];

// The resources the change stream speaks for (the service's api/events.ts).
const COVERED = new Set(['sessions', 'session', 'tickets', 'ticket', 'steps', 'inbox']);

export function resourceOf(path: string): Key | undefined {
  if (path.includes('?') || path.includes('#')) return undefined;
  for (const [pattern, key] of NAMED) {
    const match = pattern.exec(path);
    if (!match) continue;
    try { return key(decodeURIComponent(match[1] ?? '')); }
    catch { return undefined; }
  }
  return undefined;
}

export const hashOf = (key: Key): string => JSON.stringify(key);

// The resources an event of the stream names.
export function keysOf(event: Pick<ChangeEvent, 'kind' | 'id'>): Key[] {
  const id = event.id ?? '';
  switch (event.kind) {
    case 'session': return [['session', id], ['sessions']];
    case 'ticket': return [['ticket', id], ['tickets'], ['steps', id], ['plans']];
    case 'inbox': return [['inbox']];
    case 'lead': return [['lead'], ['lead-messages'], ['plans']];
    case 'plan': return [['plan', id], ['plans']];
    default: return [];
  }
}

// What a write touches, refetched once it is accepted.
export function touchedBy(path: string): Key[] {
  const [, collection, raw = ''] = path.split('/');
  let id = raw;
  try { id = decodeURIComponent(raw); } catch { /* the raw segment */ }
  switch (collection) {
    case 'sessions': return [['session', id], ['sessions'], ['inbox']];
    case 'tickets': return id ? [['ticket', id], ['tickets'], ['steps', id], ['inbox']] : [['tickets']];
    case 'plans': return [['plan', id], ['plans'], ['inbox'], ['lead']];
    case 'contracts': case 'knowledge': return [['inbox']];
    case 'lead': return [['lead'], ['lead-messages'], ['plans']];
    case 'recipes': return [['plans'], ['lead-messages']];
    // A batch's tickets are created and some start (requirement C6).
    case 'batches': return [['batches'], ['tickets'], ['sessions']];
    default: return [];
  }
}

type Item = { readonly id: string; readonly kind: string; readonly state: string; readonly sessionId?: string; readonly requestId?: string; readonly planId?: string };
const handled = (item: Item): Item => ({ ...item, state: 'handled' });

// The gestures whose outcome the inbox can show before the service answers:
// an answer to a permission or a question, a session plan's Go, a plan's
// approval, a contract's or a knowledge item's decision. The item moves to
// what was handled; the service's own list replaces it after.
export function optimistic(path: string): ((items: readonly Item[]) => Item[]) | undefined {
  const parts = path.split('/').slice(1).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
  const [collection, id, sub, rid, last] = parts;
  const waiting = (match: (item: Item) => boolean) => (items: readonly Item[]) => items.map((item) => (item.state === 'waiting' && match(item) ? handled(item) : item));
  if (collection === 'sessions' && sub === 'requests' && last === 'answer') return waiting((i) => i.sessionId === id && i.requestId === rid);
  if (collection === 'sessions' && sub === 'plan' && rid === 'go' && parts.length === 4) return waiting((i) => i.kind === 'session_plan' && i.sessionId === id);
  if (collection === 'plans' && sub === 'approve' && parts.length === 3) return waiting((i) => i.kind === 'plan' && i.planId === id);
  if ((collection === 'contracts' || collection === 'knowledge') && parts.length === 3 && sub !== undefined) return waiting((i) => i.id === id);
  return undefined;
}

export type Subscriber = { readonly keys: Set<string>; notify(): void };

export class Cache {
  readonly client: QueryClient;
  readonly #read: Read;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #paths = new Map<string, string>();
  readonly #at = new Map<string, number>();                    // when each value arrived, on this cache's clock
  readonly #subscribers = new Set<Subscriber>();
  #live = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(read: Read, options: { readonly now?: () => number; readonly pollMs?: number } = {}) {
    this.#read = read;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 30 * 60_000, staleTime: Infinity, networkMode: 'always' } } });
    this.client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const hash = event.query.queryHash;
      this.#at.set(hash, this.#now());
      for (const subscriber of [...this.#subscribers]) if (subscriber.keys.has(hash)) subscriber.notify();
    });
  }

  // The change stream is open (true) or down (false).
  get live(): boolean {
    return this.#live;
  }

  setLive(live: boolean): void {
    this.#live = live;
  }

  // The value held for a path, without asking anything.
  peek<T>(path: string): T | undefined {
    const key = resourceOf(path);
    return key ? this.client.getQueryData<T>(key) : undefined;
  }

  stale(key: Key): boolean {
    const state = this.client.getQueryState(key);
    if (!state || state.data === undefined || state.isInvalidated) return true;
    if (this.#live && COVERED.has(key[0])) return false;
    const every = key[0] === 'inbox' ? Math.min(this.#pollMs, INBOX_POLL_MS) : this.#pollMs;
    return this.#now() - (this.#at.get(hashOf(key)) ?? -Infinity) >= every;
  }

  async read<T>(path: string): Promise<T> {
    const key = resourceOf(path);
    if (!key) return await this.#read(path) as T;
    this.#paths.set(hashOf(key), path);
    const held = this.client.getQueryData<T>(key);
    if (held !== undefined) {
      if (this.stale(key)) void this.refetch(key).catch(() => {});
      return held;
    }
    return await this.client.fetchQuery({ queryKey: key, queryFn: () => this.#read(path), staleTime: 0 }) as T;
  }

  // One request for a resource, however many ask at once.
  refetch(key: Key): Promise<unknown> {
    const path = this.#paths.get(hashOf(key));
    if (path === undefined) return Promise.resolve(undefined);
    return this.client.fetchQuery({ queryKey: key, queryFn: () => this.#read(path), staleTime: 0 });
  }

  held(key: Key): boolean {
    return this.client.getQueryData(key) !== undefined;
  }

  // An event of the change stream: what it names and the cache holds.
  changed(event: Pick<ChangeEvent, 'kind' | 'id'>): void {
    for (const key of keysOf(event)) if (this.held(key)) void this.refetch(key).catch(() => {});
  }

  // The stream is back after a drop: everything held, once.
  refetchAll(): void {
    for (const query of this.client.getQueryCache().getAll()) {
      if (query.state.data !== undefined) void this.refetch(query.queryKey as unknown as Key).catch(() => {});
    }
  }

  // What the mounted screens and the shell read and is stale, refetched.
  poll(): void {
    const used = new Set<string>();
    for (const subscriber of this.#subscribers) for (const hash of subscriber.keys) used.add(hash);
    for (const hash of used) {
      const key = JSON.parse(hash) as Key;
      if (this.stale(key)) void this.refetch(key).catch(() => {});
    }
  }

  start(): void {
    this.#timer ??= setInterval(() => this.poll(), TICK_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // Forgets everything held, with its timers (a sign out, a test's end).
  dispose(): void {
    this.stop();
    this.client.clear();
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => { this.#subscribers.delete(subscriber); };
  }

  // A write: the inbox moves first when the gesture's outcome is known,
  // and back if the service refuses; then what it touched is refetched.
  async write<T>(path: string, body: unknown, send: Write): Promise<T> {
    const patch = optimistic(path);
    // A read of the inbox already under way would land after the move and
    // put the item back for a moment: it is dropped, its value kept.
    if (patch) void this.client.cancelQueries({ queryKey: ['inbox'], exact: true }, { revert: false, silent: true });
    const before = patch ? this.client.getQueryData<Item[]>(['inbox']) : undefined;
    if (patch && before) this.client.setQueryData(['inbox'], patch(before));
    try {
      const answer = await send(path, { method: 'POST', body }) as T;
      for (const key of touchedBy(path)) if (this.held(key)) void this.refetch(key).catch(() => {});
      return answer;
    } catch (error) {
      if (patch && before) {
        this.client.setQueryData(['inbox'], before);
        void this.refetch(['inbox']).catch(() => {});
      }
      throw error;
    }
  }
}
