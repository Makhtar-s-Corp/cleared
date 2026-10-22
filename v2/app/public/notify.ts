// The header's notifications button: this browser asks to be told when
// something waits for the person signed in. The page hands the browser's
// subscription to the app (session and anti-forgery token, like every
// write); what is sent, and when, is the service's decision, never the
// page's. On iPhone and iPad, web notifications exist only for the app
// added to the Home Screen: the menu says so instead of offering what
// cannot work. notifyView and renderNotifyMenu are pure, so the tests run
// them without a browser; initNotify wires them to the page.
import type { NotificationStatus } from '../src/notifications.ts';
import { esc } from './html.ts';
import type { Translate } from './i18n.ts';
import type { Me } from './screen.ts';

export type NotifyStatus = NotificationStatus;

// What this browser can do, read once by initNotify.
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

export function renderNotifyMenu(view: NotifyView, t: Translate): string {
  if (!view.show) return '';
  const devices = view.devices === null ? ''
    : `<p class="faint">${esc(view.devices === 0 ? t('notify_devices_none') : t(view.devices === 1 ? 'notify_devices_one' : 'notify_devices_other', { n: view.devices }))}</p>`;
  const button = view.action === null ? ''
    : `<button class="${view.action === 'on' ? 'primary' : 'plain'}" id="notify-toggle" type="button" data-action="${view.action}">${esc(t(view.action === 'on' ? 'notify_turn_on' : 'notify_turn_off'))}</button>`;
  const note = view.note === null ? '' : `<p class="note">${esc(t(view.note))}</p>`;
  return `<p class="notify-state">${esc(t(view.state))}</p>${devices}${note}${button}<p class="notify-error" id="notify-error" role="alert" hidden></p>`;
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

export async function initNotify(t: Translate, me: Me): Promise<void> {
  const details = document.getElementById('notify') as HTMLDetailsElement | null;
  const summary = document.getElementById('notify-summary');
  const menu = document.getElementById('notify-menu');
  if (!details || !summary || !menu) return;
  const browser = (): NotifyBrowser => ({
    supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    apple: /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    installed: matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    permission: 'Notification' in window ? Notification.permission : 'default',
  });

  let status: NotifyStatus | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  let subscription: PushSubscription | null = null;

  const draw = (error?: string) => {
    const view = notifyView(status, browser(), subscription !== null);
    details.hidden = !view.show;
    if (!view.show) return;
    details.classList.toggle('on', view.on);
    summary.setAttribute('aria-label', t(view.on ? 'notify_label_on' : 'notify_label'));
    menu.innerHTML = renderNotifyMenu(view, t);
    const shown = menu.querySelector<HTMLElement>('#notify-error')!;
    if (error) {
      shown.textContent = error;
      shown.hidden = false;
    }
    menu.querySelector<HTMLButtonElement>('#notify-toggle')?.addEventListener('click', (event) => void toggle(event.currentTarget as HTMLButtonElement));
  };

  const refresh = async () => {
    try {
      const response = await fetch('/api/notifications', { credentials: 'same-origin' });
      status = response.ok ? await response.json() as NotifyStatus : null;
    } catch {
      status = null;
    }
    if (status?.available && browser().supported && !registration) {
      try { registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); }
      catch { registration = null; }
    }
    subscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
  };

  async function toggle(button: HTMLButtonElement): Promise<void> {
    const turningOn = button.dataset.action === 'on';
    let failed: string | undefined;
    try {
      if (!turningOn && subscription) {
        button.disabled = true;
        await post('/api/notifications/unsubscribe', me.csrf, { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      } else if (turningOn && registration && status?.publicKey) {
        // Asked first, while the click still counts as the person's gesture (Safari requires it).
        const permission = await Notification.requestPermission();
        button.disabled = true;
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
    } catch {
      failed = t(turningOn ? 'notify_failed' : 'notify_off_failed');
    }
    await refresh();
    draw(failed);
    menu?.querySelector<HTMLButtonElement>('#notify-toggle')?.focus();
  }

  await refresh();
  draw();
}
