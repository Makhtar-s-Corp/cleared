// Signing in: the throttle on wrong passwords. Failures are counted per
// peer address and per user name over a 15 minute window; five of either
// lock that peer or that name until the window has passed, and during that
// time even the right password is refused (429), so a guess that happens
// to be right tells nothing. The counts live in memory: a restart clears
// them, which only an account on this machine can cause.
export const THROTTLE = { failures: 5, windowSeconds: 15 * 60 } as const;

export class LoginThrottle {
  #now: () => number;
  #failures = new Map<string, number[]>();

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #recent(key: string): number[] {
    const since = this.#now() - THROTTLE.windowSeconds * 1000;
    const kept = (this.#failures.get(key) ?? []).filter((at) => at > since);
    if (kept.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, kept);
    return kept;
  }

  // Seconds until this peer and this name may try again; 0 when they may now.
  blocked(peer: string, name: string): number {
    let wait = 0;
    for (const key of [`peer:${peer}`, `name:${name.toLowerCase()}`]) {
      const recent = this.#recent(key);
      if (recent.length < THROTTLE.failures) continue;
      const oldest = recent[recent.length - THROTTLE.failures] as number;
      wait = Math.max(wait, Math.ceil((oldest + THROTTLE.windowSeconds * 1000 - this.#now()) / 1000));
    }
    return wait;
  }

  failed(peer: string, name: string): void {
    const at = this.#now();
    for (const key of [`peer:${peer}`, `name:${name.toLowerCase()}`]) this.#failures.set(key, [...this.#recent(key), at]);
  }
}
