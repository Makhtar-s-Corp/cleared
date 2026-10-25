// The app's part of the notifications (milestone 2 plan, section 6): a
// browser of a signed-in person asks to be told when something waits.
//
//   status       whether Web Push can be offered here, the service's public
//                key and how many devices are told
//   subscribe    keeps this browser's subscription: an https address of a
//                known push service and its two keys
//   unsubscribe  forgets one
//
// The server (server.ts) checks the session cookie, the anti-forgery token
// and the origin before a write; there is no passkey in v2 (decisions log,
// "app login by password, no passkeys"). The subscriptions go to the
// service's private notification directory through lib/notify/store.mjs,
// the one v1 used: 0700, refused when looser, at most ten devices, the
// oldest pushed out. The app sends nothing; the service's dispatcher does.
//
// The settings are v1's: [notify] adapters, secrets_dir and vapid_subject
// in the project's agents.conf (CLEARED_CONF, else
// <CLEARED_REPO>/.cleared/agents.conf), and the service's environment for
// CLEARED_NOTIFY_LINK_BASE and CLEARED_NOTIFY_PUSH_HOSTS. lib/notify is
// loaded on the first call, not when the app starts: lib/conf.mjs copies
// every CLEARED_* variable to ORCH_* when it is imported, and an app that
// nobody asks for notifications has no reason to touch the directory.
import { readFileSync } from 'node:fs';
import { confFile, parseSections } from '../../src/approval/conf.ts';

export type NotifyReason = 'off' | 'insecure' | 'no_subject' | 'config' | 'store';

export type NotificationStatus = {
  readonly available: boolean;
  readonly reason: NotifyReason | null;
  readonly publicKey: string | null;
  readonly devices: number;
};

export class NotifyError extends Error {
  override name = 'NotifyError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export type Notifications = {
  status(origin: string): Promise<NotificationStatus>;
  subscribe(origin: string, body: unknown, device: string): Promise<{ readonly ok: true; readonly devices: number }>;
  unsubscribe(origin: string, body: unknown): Promise<{ readonly ok: true; readonly removed: boolean; readonly devices: number }>;
};

// What the app uses of lib/notify (JavaScript, loaded by address).
type Subscription = { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } };
type Settings = { readonly adapters: readonly string[]; readonly subject: string; readonly pushHosts: readonly string[]; readonly secretsDir: string };
type Store = {
  publicKey(): string;
  subscriptions(): readonly unknown[];
  subscribe(subscription: Subscription, device: string): number;
  forget(endpoint: string): number;
};
type NotifyLib = {
  readonly settings: Settings;
  readonly store: Store;
  readonly valid: (input: unknown, extra: readonly string[]) => Subscription | null;
};

const LIB = new URL('../../../lib/notify/', import.meta.url).href;

// Web Push needs a secure origin: https, or http on this machine.
export function secureOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

// What the store keeps beside a subscription: who and on what, never the
// full user agent.
export function deviceName(user: string, userAgent: string | undefined): string {
  const agent = userAgent ?? '';
  const platform = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android'
    : /Macintosh|Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux|X11/.test(agent) ? 'Linux' : 'browser';
  const suffix = ` · ${platform}`;
  return `${user.slice(0, 40 - suffix.length)}${suffix}`;
}

// The notifications as the environment sets them. Nothing is read before
// the first call; a setting that cannot be read answers 'config' each time.
export function notificationsFrom(env: NodeJS.ProcessEnv): Notifications {
  let loading: Promise<NotifyLib | NotifyReason> | undefined;
  const load = () => loading ??= (async (): Promise<NotifyLib | NotifyReason> => {
    try {
      const file = confFile(env);
      let sections: Record<string, Record<string, string>> = {};
      if (file) {
        try { sections = parseSections(readFileSync(file, 'utf8')); }
        catch { /* no settings file: the defaults */ }
      }
      const contract = await import(`${LIB}contract.mjs`) as { notifySettings(conf: unknown, env: NodeJS.ProcessEnv): Settings };
      const settings = contract.notifySettings({ sections }, env);
      const { notifyStore } = await import(`${LIB}store.mjs`) as { notifyStore(dir: string, options: { project?: string; create: boolean }): Store };
      const { validSubscription } = await import(`${LIB}adapters/webpush.mjs`) as { validSubscription: NotifyLib['valid'] };
      const project = env.CLEARED_REPO || env.ORCH_REPO;
      const store = notifyStore(settings.secretsDir, { ...(project ? { project } : {}), create: true });
      return { settings, store, valid: validSubscription };
    } catch {
      return 'config';
    }
  })();

  // Why Web Push cannot be offered from this origin, or the library.
  const usable = async (origin: string): Promise<NotifyLib | NotifyReason> => {
    const lib = await load();
    if (typeof lib === 'string') return lib;
    if (!lib.settings.adapters.includes('webpush')) return 'off';
    if (!secureOrigin(origin)) return 'insecure';
    if (!lib.settings.subject) return 'no_subject';
    return lib;
  };
  const orThrow = async (origin: string): Promise<NotifyLib> => {
    const lib = await usable(origin);
    if (typeof lib === 'string') throw new NotifyError(409, lib);
    return lib;
  };
  const withStore = <T>(change: () => T): T => {
    try { return change(); }
    catch { throw new NotifyError(503, 'store'); }
  };
  const unavailable = (reason: NotifyReason): NotificationStatus => ({ available: false, reason, publicKey: null, devices: 0 });

  return {
    async status(origin) {
      const lib = await usable(origin);
      if (typeof lib === 'string') return unavailable(lib);
      // The key pair is made here the first time a signed-in page asks
      // (every page does, to draw the bell), and kept by the store for good.
      try { return { available: true, reason: null, publicKey: lib.store.publicKey(), devices: lib.store.subscriptions().length }; }
      catch { return unavailable('store'); }
    },
    async subscribe(origin, body, device) {
      const lib = await orThrow(origin);
      const subscription = lib.valid((body as { subscription?: unknown } | null)?.subscription, lib.settings.pushHosts);
      if (!subscription) throw new NotifyError(400, 'subscription');
      const devices = withStore(() => {
        lib.store.subscribe(subscription, device);
        return lib.store.subscriptions().length;
      });
      return { ok: true, devices };
    },
    async unsubscribe(origin, body) {
      const lib = await orThrow(origin);
      const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
      if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1000) throw new NotifyError(400, 'subscription');
      return withStore(() => {
        const removed = lib.store.forget(endpoint);
        return { ok: true as const, removed: removed > 0, devices: lib.store.subscriptions().length };
      });
    },
  };
}
