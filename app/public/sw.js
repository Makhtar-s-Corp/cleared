// The service worker of the Cockpit. It shows the notifications the service
// pushes (lib/notify.mjs) and, when one is touched, opens the ticket's
// porthole in the app. It caches nothing, answers no request and reads no
// page: the app stays live or says it is not.
const sameOrigin = (value) => {
  try { const url = new URL(value, self.location.origin); return url.origin === self.location.origin ? url.href : null; } catch { return null; }
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* unreadable: shown as a plain notification */ }
  const text = (value, max) => String(value ?? '').slice(0, max);
  event.waitUntil(self.registration.showNotification(text(data.title, 80) || 'Cleared', {
    body: text(data.body, 200), tag: text(data.tag, 64) || 'cleared', renotify: true,
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    // Only an address of this very app is ever opened.
    data: { url: sameOrigin(data.url) ?? '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOrigin(event.notification.data?.url) ?? '/';
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try { await client.focus(); await client.navigate(url); return; } catch { /* a page this worker does not control: open a new one */ }
    }
    await self.clients.openWindow(url);
  })());
});
