// The notifications button of the Cockpit: this browser asks to be told when
// something waits for the human. The page hands the browser's subscription to
// the server (session and anti-forgery token, like every write), confirming a
// challenge bound to that subscription: turning a device's notifications on or
// off is the human's, like Clear to land. What is sent, and when, is the
// service's decision, never the page's. On iPhone, web notifications exist
// only for the app added to the Home Screen: the button says so instead of
// offering what cannot work.

const key = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function initNotify({ t, $ }) {
  const button = $('notify'), hint = $('notify-hint');
  const apple = /iPhone|iPad/.test(navigator.userAgent);
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let me = null, status = null, registration = null, subscription = null;
  const say = (text) => { hint.textContent = text; hint.hidden = !text; };
  const show = (label, { title = '', disabled = false, pressed = null } = {}) => {
    button.hidden = false; button.textContent = label; button.title = title; button.disabled = disabled;
    if (pressed === null) button.removeAttribute('aria-pressed'); else button.setAttribute('aria-pressed', String(pressed));
  };
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': me?.csrf ?? '' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  };
  try {
    const [mine, notify] = await Promise.all([fetch('/api/me', { credentials: 'same-origin' }), fetch('/api/notifications', { credentials: 'same-origin' })]);
    if (mine.ok) me = await mine.json();
    if (notify.ok) status = await notify.json();
  } catch { /* the button stays hidden */ }
  // Not offered by this service (another adapter, no https address), or no session: nothing to show.
  if (!status?.available || !me) return;
  if (!supported) {
    if (apple && !installed) { show(t('app_notify_ios'), { title: t('app_notify_ios_hint') }); button.addEventListener('click', () => say(hint.hidden ? t('app_notify_ios_hint') : '')); }
    return;
  }
  try { registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return; }

  async function refresh() {
    subscription = await registration.pushManager.getSubscription().catch(() => null);
    if (Notification.permission === 'denied') return show(t('app_notify_blocked'), { title: t('app_notify_blocked_hint'), disabled: true });
    return subscription ? show(t('app_notify_on'), { title: t('app_notify_off_hint'), pressed: true }) : show(t('app_notify_enable'), { pressed: false });
  }
  // The server's challenge for this subscription, then the request that confirms it.
  const confirmed = async (path, body) => {
    const asked = await post('/api/notifications/challenge', body);
    return post(path, { ...body, challengeId: asked.challengeId });
  };
  button.addEventListener('click', async () => {
    say('');
    const turningOff = Boolean(subscription);
    try {
      if (subscription) {
        button.disabled = true;
        await confirmed('/api/notifications/unsubscribe', { op: 'unsubscribe', endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        return;
      }
      // Asked first, while the click still counts as the human's gesture (Safari requires it).
      const permission = await Notification.requestPermission();
      button.disabled = true;
      if (permission !== 'granted') return;
      const made = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(status.publicKey) });
      try { await confirmed('/api/notifications/subscribe', { op: 'subscribe', subscription: made.toJSON() }); }
      catch (error) { await made.unsubscribe(); throw error; }
      // Shown by this device itself: permission and display work. The service's own test is `notify.ts test`.
      await registration.showNotification(t('app_notify_ready_title'), { body: t('app_notify_ready_body'), tag: 'cleared-ready', icon: '/icons/icon-192.png' });
    } catch { say(t(turningOff ? 'app_notify_off_failed' : 'app_notify_failed')); }
    finally { await refresh(); }
  });
  await refresh();
}
