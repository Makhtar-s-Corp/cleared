// The app's part of the notifications: a signed-in browser asks to be told.
//
//   status       the service's public key for Web Push, and whether it can be used here
//   subscribe    keeps this browser's subscription (a known push service's https address and its keys)
//   unsubscribe  forgets one
//
// Only a session of the human reaches these (the server checks the session
// cookie, the anti-forgery token and the origin before calling them): the
// access token alone, or an agent on the machine, cannot subscribe. The
// subscriptions are written to the service's private notification directory
// (lib/notify/store.mjs); the app sends nothing itself, the wake's dispatcher
// does (lib/notify.mjs). The ledger gets one app_gesture per change, with the
// device's short name and never the address.
import { validSubscription } from '../../lib/notify/adapters/webpush.mjs';
import { originInfo } from './actions.mjs';

const fail = (status, code) => Object.assign(new Error(code), { status, code });

export function createNotifications({ settings, store, origin, record = () => {} }) {
  const where = originInfo(origin);
  const note = (session, result) => { try { record({ detail: JSON.stringify({ gesture: 'notifications', result, device: session.device }) }); } catch { /* the ledger being locked does not undo the choice */ } };
  // Why Web Push cannot be offered here, or null.
  const reason = () => !settings.adapters.includes('webpush') ? 'off' : !where ? 'insecure' : !settings.subject ? 'no_subject' : null;
  const usable = () => {
    const why = reason();
    if (why) throw fail(409, why);
  };
  return {
    status() {
      const why = reason();
      if (why) return { available: false, reason: why, publicKey: null, devices: 0 };
      // The key pair is made here the first time the human opens the app (first use), kept by the service.
      try { return { available: true, reason: null, publicKey: store.publicKey(), devices: store.subscriptions().length }; }
      catch { return { available: false, reason: 'store', publicKey: null, devices: 0 }; }
    },
    subscribe(session, body) {
      usable();
      const subscription = validSubscription(body?.subscription, settings.pushHosts);
      if (!subscription) { note(session, 'refused_subscription'); throw fail(400, 'subscription'); }
      try { store.subscribe(subscription, session.device); } catch { throw fail(503, 'store'); }
      note(session, 'subscribed');
      return { ok: true, devices: store.subscriptions().length };
    },
    unsubscribe(session, body) {
      usable();
      if (typeof body?.endpoint !== 'string' || body.endpoint.length > 1000) throw fail(400, 'subscription');
      let removed;
      try { removed = store.forget(body.endpoint); } catch { throw fail(503, 'store'); }
      note(session, 'unsubscribed');
      return { ok: true, removed: removed > 0, devices: store.subscriptions().length };
    },
  };
}
