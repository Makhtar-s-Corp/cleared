// The change stream in the page (docs/v2/ui-overhaul-plan.md, 2.1.3 and U3,
// lane 34): an EventSource on /api/service/events, which the app's server
// forwards to the service's GET /api/events with the session cookie checked.
// Each "change" event refetches what it names (Cache.changed). While the
// stream is open the cache trusts it (Cache.setLive(true)); once it drops,
// the cache falls back to the polling intervals of before. The EventSource
// reconnects by itself after a drop; a stream the server refused or closed
// for good (a 404 from an older service, a sign out) is opened again after
// RETRY_MS, doubling up to RETRY_MAX_MS. A reconnect refetches everything
// the cache holds, once: what changed while it was down is not replayed.
import type { ChangeEvent } from '../../../src/api/types.ts';
import type { Cache } from './cache.ts';

export const EVENTS_URL = '/api/service/events';
export const RETRY_MS = 5000;
export const RETRY_MAX_MS = 60_000;

// The part of EventSource the stream uses, so a test can stand in for it.
export type SourceLike = {
  readonly readyState: number;
  addEventListener(name: 'open' | 'error' | 'change', listener: (event: { data?: string }) => void): void;
  close(): void;
};
export const CLOSED = 2;

export type StreamOptions = {
  readonly open: (url: string) => SourceLike;
  readonly later: (run: () => void, ms: number) => () => void;
};

export class ChangeStream {
  readonly #cache: Cache;
  readonly #options: StreamOptions;
  #source: SourceLike | undefined;
  #opened = false;
  #wait = RETRY_MS;
  #cancel: (() => void) | undefined;
  #stopped = true;

  constructor(cache: Cache, options: StreamOptions) {
    this.#cache = cache;
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#source?.close();
    this.#source = undefined;
    this.#cache.setLive(false);
  }

  #connect(): void {
    const source = this.#options.open(EVENTS_URL);
    this.#source = source;
    source.addEventListener('open', () => {
      if (source !== this.#source) return;
      this.#wait = RETRY_MS;
      this.#cache.setLive(true);
      if (this.#opened) this.#cache.refetchAll();
      this.#opened = true;
    });
    source.addEventListener('change', ({ data }) => {
      if (source !== this.#source || data === undefined) return;
      let event: ChangeEvent;
      try { event = JSON.parse(data) as ChangeEvent; }
      catch { return; }
      if (event && typeof event.kind === 'string') this.#cache.changed(event);
    });
    source.addEventListener('error', () => {
      if (source !== this.#source) return;
      this.#cache.setLive(false);
      if (source.readyState !== CLOSED || this.#stopped) return;
      source.close();
      const wait = this.#wait;
      this.#wait = Math.min(this.#wait * 2, RETRY_MAX_MS);
      this.#cancel = this.#options.later(() => {
        this.#cancel = undefined;
        if (!this.#stopped) this.#connect();
      }, wait);
    });
  }
}
