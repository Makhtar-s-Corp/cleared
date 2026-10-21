// Signing in: the throttle on wrong passwords. Attempts are counted per
// peer address and per user name over a 15 minute window; five of either
// lock that peer or that name until the window has passed, and during that
// time even the right password is refused (429), so a guess that happens
// to be right tells nothing. An attempt counts from the moment it starts,
// before its password is checked, so a burst sent at once is limited as
// if it came one by one; a right password then takes its own attempt
// back. The counts live in memory: a restart clears them, which only an
// account on this machine can cause.
export const THROTTLE = { failures: 5, windowSeconds: 15 * 60 } as const;

export type Attempt =
  | { readonly wait: number; succeeded?: undefined }          // blocked: seconds until the next try
  | { readonly wait: 0; succeeded(): void };                   // under way: call succeeded() on a right password

type Mark = { readonly at: number };

export class LoginThrottle {
  #now: () => number;
  #marks = new Map<string, Mark[]>();

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #recent(key: string): Mark[] {
    const since = this.#now() - THROTTLE.windowSeconds * 1000;
    const kept = (this.#marks.get(key) ?? []).filter((mark) => mark.at > since);
    if (kept.length === 0) this.#marks.delete(key);
    else this.#marks.set(key, kept);
    return kept;
  }

  // Starts an attempt, or says how long to wait. Synchronous, so two
  // requests can never both see the count before either is recorded.
  start(peer: string, name: string): Attempt {
    const keys = [`peer:${peer}`, `name:${name.toLowerCase()}`];
    let wait = 0;
    for (const key of keys) {
      const recent = this.#recent(key);
      if (recent.length < THROTTLE.failures) continue;
      const oldest = (recent[recent.length - THROTTLE.failures] as Mark).at;
      wait = Math.max(wait, Math.max(1, Math.ceil((oldest + THROTTLE.windowSeconds * 1000 - this.#now()) / 1000)));
    }
    if (wait > 0) return { wait };
    const mark: Mark = { at: this.#now() };
    for (const key of keys) this.#marks.set(key, [...this.#recent(key), mark]);
    return {
      wait: 0,
      succeeded: () => {
        for (const key of keys) {
          const left = (this.#marks.get(key) ?? []).filter((m) => m !== mark);
          if (left.length === 0) this.#marks.delete(key);
          else this.#marks.set(key, left);
        }
      },
    };
  }
}
