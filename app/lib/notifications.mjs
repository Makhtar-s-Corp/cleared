// The app's part of the notifications: a browser of the human asks to be told.
//
//   status       the service's public key for Web Push, and whether it can be used here
//   challenge    a passkey challenge for turning this browser's notifications on or off
//   subscribe    keeps this browser's subscription (a known push service's https address and its keys)
//   unsubscribe  forgets one
//
// A session is not enough: the access token alone opens one, and an agent that
// holds the token must not be able to have every notification sent to a
// device of its own, nor to push the human's devices out. So subscribing and
// unsubscribing are confirmed with the human's passkey, by the same ceremony
// as Clear to land and Send back (app/lib/actions.mjs: a one-time challenge
// bound to the session, the purpose and a hash of the subscription, user
// verification required). No passkey registered, no subscription. The server
// also checks the session cookie, the anti-forgery token and the origin before
// calling these. The subscriptions are written to the service's private
// notification directory (lib/notify/store.mjs); the app sends nothing itself,
// the wake's dispatcher does (lib/notify.mjs). The ledger gets one app_gesture
// per attempt, with the device's short name and never the address.
import { validSubscription } from '../../lib/notify/adapters/webpush.mjs';
import { originInfo } from './actions.mjs';

const fail = (status, code) => Object.assign(new Error(code), { status, code });
// What the passkey confirms: the whole subscription, so a confirmed request cannot be swapped for another address or keys.
const subjectOf = (subscription) => JSON.stringify([subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
const endpointOf = (body) => {
  if (typeof body?.endpoint !== 'string' || !body.endpoint || body.endpoint.length > 1000) throw fail(400, 'subscription');
  return body.endpoint;
};

// confirm: the passkey ceremony of app/lib/actions.mjs ({ confirmable, challengeFor, verifyFor }). Without it nothing is accepted.
export function createNotifications({ settings, store, origin, confirm = null, record = () => {} }) {
  const where = originInfo(origin);
  const note = (session, result) => { try { record({ detail: JSON.stringify({ gesture: 'notifications', result, device: session.device }) }); } catch { /* the ledger being locked does not undo the choice */ } };
  const passkey = () => { try { return confirm ? confirm.confirmable() : 'no_passkey'; } catch { return 'no_passkey'; } };
  // Why Web Push cannot be offered here, or null.
  const reason = () => !settings.adapters.includes('webpush') ? 'off' : !where ? 'insecure' : !settings.subject ? 'no_subject' : passkey();
  const usable = () => {
    const why = reason();
    if (why) throw fail(409, why);
  };
  const subscriptionOf = (session, body) => {
    const subscription = validSubscription(body?.subscription, settings.pushHosts);
    if (!subscription) { note(session, 'refused_subscription'); throw fail(400, 'subscription'); }
    return subscription;
  };
  const verified = (session, body, purpose, subject) => {
    try { confirm.verifyFor(session, body, purpose, subject); }
    catch (error) { note(session, `refused_${error.code ?? 'passkey'}`); throw error.status ? error : fail(403, 'assertion'); }
  };
  return {
    status() {
      const why = reason();
      if (why) return { available: false, reason: why, publicKey: null, devices: 0 };
      // The key pair is made here the first time the human opens the app (first use), kept by the service.
      try { return { available: true, reason: null, publicKey: store.publicKey(), devices: store.subscriptions().length }; }
      catch { return { available: false, reason: 'store', publicKey: null, devices: 0 }; }
    },
    challenge(session, body) {
      usable();
      if (body?.op === 'subscribe') return confirm.challengeFor(session, 'notify_subscribe', subjectOf(subscriptionOf(session, body)));
      if (body?.op === 'unsubscribe') return confirm.challengeFor(session, 'notify_unsubscribe', endpointOf(body));
      throw fail(400, 'gesture');
    },
    subscribe(session, body) {
      usable();
      const subscription = subscriptionOf(session, body);
      verified(session, body, 'notify_subscribe', subjectOf(subscription));
      try { store.subscribe(subscription, session.device); } catch { throw fail(503, 'store'); }
      note(session, 'subscribed');
      return { ok: true, devices: store.subscriptions().length };
    },
    unsubscribe(session, body) {
      usable();
      const endpoint = endpointOf(body);
      verified(session, body, 'notify_unsubscribe', endpoint);
      let removed;
      try { removed = store.forget(endpoint); } catch { throw fail(503, 'store'); }
      note(session, 'unsubscribed');
      return { ok: true, removed: removed > 0, devices: store.subscriptions().length };
    },
  };
}
