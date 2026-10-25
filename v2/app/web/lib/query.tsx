// The shared cache in React (lib/cache.ts; docs/v2/ui-overhaul-plan.md,
// 2.1.2, lane 34): the page's one Cache, a screen's reads through it, and
// useLive, which redraws a screen when a resource it read has a new value,
// in place of each screen's own polling timer.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Cache, hashOf, resourceOf, type Subscriber } from './cache.ts';
import { useScreen } from './context.tsx';
import type { ScreenContext } from './screen.ts';

export const CacheContext = createContext<Cache | null>(null);

export function useCache(): Cache | null {
  return useContext(CacheContext);
}

// A reader of the cache: the resources it read, and what to call when one
// of them has a new value (once per turn, however many changed).
export type Reader = Subscriber & {
  readonly api: ScreenContext['api'];
  live(run: () => void): () => void;
};

export function reader(cache: Cache, raw: ScreenContext['api']): Reader {
  const keys = new Set<string>();
  const runs = new Set<() => void>();
  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const run of [...runs]) run();
    });
  };
  const api: ScreenContext['api'] = (path, init) => {
    if (init?.method === 'POST') return cache.write(path, init.body ?? null, (p, i) => raw(p, i));
    const key = resourceOf(path);
    if (key) keys.add(hashOf(key));
    return cache.read(path);
  };
  return {
    keys, notify, api,
    live(run) {
      runs.add(run);
      return () => { runs.delete(run); };
    },
  };
}

// A screen's reader, subscribed to the cache while the screen is mounted.
export function useReader(cache: Cache, raw: ScreenContext['api']): Reader {
  const made = useMemo(() => reader(cache, raw), [cache, raw]);
  useEffect(() => cache.subscribe(made), [cache, made]);
  return made;
}

// Calls `run` each time a resource the screen read has a new value: what
// the screens' REFRESH_MS timers did, now on the cache's word. Outside the
// shell (a component's test), it does nothing.
export function useLive(run: () => void): void {
  const context = useScreen();
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => context.live?.(() => latest.current()), [context]);
}

// A screen's last drawn state, kept for the page's life: a screen drawn
// again (a switch back to it) starts from what it showed, then its first
// read from the cache brings it up to date. No skeleton on a second visit.
// That first read usually finds what was kept, the same values gathered in
// a new object: it does not draw the screen again (lane j3-tab-perf).
const kept = new Map<string, unknown>();

export function sameFields(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) || Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function useKept<T>(name: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (kept.has(name) ? kept.get(name) as T : initial));
  const set = useCallback((next: T) => {
    setValue((current) => {
      const value = sameFields(current, next) ? current : next;
      kept.set(name, value);
      return value;
    });
  }, [name]);
  return [value, set];
}
