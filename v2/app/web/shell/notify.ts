// The header's notifications button: this browser asks to be told when
// something waits for the person signed in. The page hands the browser's
// subscription to the app (session and anti-forgery token, like every
// write); what is sent, and when, is the service's decision, never the
// page's. On iPhone and iPad, web notifications exist only for the app
// added to the Home Screen: the menu says so instead of offering what
// cannot work. notifyView is pure, so the tests run it without a browser;
// shell/NotifyButton.tsx draws it and calls readNotify and toggleNotify.
import type { NotificationStatus } from '../../src/notifications.ts';
import type { Translate } from '../lib/i18n.ts';
import type { Me } from '../lib/screen.ts';

export type NotifyStatus = NotificationStatus;

// What this browser can do.
export type NotifyBrowser = {
  readonly supported: boolean;                             // service worker, PushManager and Notification
  readonly apple: boolean;                                 // an iPhone or iPad
  readonly installed: boolean;                             // opened from the Home Screen
  readonly permission: 'default' | 'granted' | 'denied';
};

export type NotifyView =
  | { readonly show: false }
  | {
    readonly show: true;
    readonly on: boolean;                                  // this device is subscribed
    readonly state: 'notify_on' | 'notify_off' | 'notify_unavailable';
    readonly devices: number | null;                       // the devices told, when the service says
    readonly action: 'on' | 'off' | null;                  // what the button does; null: no button
    readonly note: string | null;                          // a catalog sentence: why there is no button
  };

export function notifyView(status: NotifyStatus | null, browser: NotifyBrowser, subscribed: boolean): NotifyView {
  if (!status || status.reason === 'off') return { show: false };
  if (!status.available) return { show: true, on: false, state: 'notify_unavailable', devices: null, action: null, note: `notify_${status.reason ?? 'config'}` };
  const off = { show: true, on: false, state: 'notify_off', devices: status.devices } as const;
  if (!browser.supported) return { ...off, action: null, note: browser.apple && !browser.installed ? 'notify_ios' : 'notify_unsupported' };
  if (browser.permission === 'denied') return { ...off, action: null, note: 'notify_blocked' };
  return subscribed
    ? { show: true, on: true, state: 'notify_on', devices: status.devices, action: 'off', note: null }
    : { ...off, action: 'on', note: null };
}

// The service's public key (base64url) as the bytes subscribe() expects.
export function urlKey(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function post<T>(path: string, csrf: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(String(response.status));
  return await response.json() as T;
}

// What this browser can do, read when the menu draws.
export function readBrowser(): NotifyBrowser {
  return {
    supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    apple: /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    installed: matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    permission: 'Notification' in window ? Notification.permission : 'default',
  };
}

// The service's status, the worker (registered once Web Push is available
// and the browser can use it) and this device's subscription.
export type NotifyRead = { readonly status: NotifyStatus | null; readonly registration: ServiceWorkerRegistration | null; readonly subscription: PushSubscription | null };

export async function readNotify(registration: ServiceWorkerRegistration | null): Promise<NotifyRead> {
  let status: NotifyStatus | null;
  try {
    const response = await fetch('/api/notifications', { credentials: 'same-origin' });
    status = response.ok ? await response.json() as NotifyStatus : null;
  } catch {
    status = null;
  }
  if (status?.available && readBrowser().supported && !registration) {
    try { registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); }
    catch { registration = null; }
  }
  const subscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
  return { status, registration, subscription };
}

// Turns this device on or off; the catalog key of what failed, if anything.
export async function toggleNotify(read: NotifyRead, turningOn: boolean, me: Pick<Me, 'csrf'>, t: Translate, started: () => void): Promise<string | undefined> {
  const { registration, subscription, status } = read;
  try {
    if (!turningOn && subscription) {
      started();
      await post('/api/notifications/unsubscribe', me.csrf, { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    } else if (turningOn && registration && status?.publicKey) {
      // Asked first, while the click still counts as the person's gesture (Safari requires it).
      const permission = await Notification.requestPermission();
      started();
      if (permission === 'granted') {
        const made = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(status.publicKey) });
        try { await post('/api/notifications/subscribe', me.csrf, { subscription: made.toJSON() }); }
        catch (error) { await made.unsubscribe(); throw error; }
        // Shown by this device itself: permission and display work. The
        // service's own test is its notify command. Not showing it does
        // not undo the subscription.
        await registration.showNotification(t('notify_ready_title'), { body: t('notify_ready_body'), tag: 'cleared-ready', icon: '/icons/icon-192.png' }).catch(() => undefined);
      }
    }
    return undefined;
  } catch {
    return turningOn ? 'notify_failed' : 'notify_off_failed';
  }
}
