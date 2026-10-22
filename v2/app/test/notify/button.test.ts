// The header's notifications button, as pure functions: what it shows for a
// service status, a browser and this device's subscription.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../../public/i18n.ts';
import { notifyView, renderNotifyMenu, urlKey, type NotifyBrowser, type NotifyStatus } from '../../public/notify.ts';

const sentinel: Translate = (key, values) => `«${key}${Object.entries(values ?? {}).map(([name, value]) => ` ${name}=${value}`).join('')}»`;
const ready: NotifyStatus = { available: true, reason: null, publicKey: 'BKey', devices: 2 };
const chrome: NotifyBrowser = { supported: true, apple: false, installed: false, permission: 'default' };

test('nothing is shown when the status is unknown or the service sends no Web Push', () => {
  assert.deepEqual(notifyView(null, chrome, false), { show: false });
  assert.deepEqual(notifyView({ available: false, reason: 'off', publicKey: null, devices: 0 }, chrome, false), { show: false });
});

test('off on this device: the count of devices told, and the button that turns it on', () => {
  const view = notifyView(ready, chrome, false);
  assert.deepEqual(view, { show: true, on: false, state: 'notify_off', devices: 2, action: 'on', note: null });
  const html = renderNotifyMenu(view, sentinel);
  assert.match(html, /«notify_off»/);
  assert.match(html, /«notify_devices_other n=2»/);
  assert.match(html, /<button class="primary" id="notify-toggle" type="button" data-action="on">«notify_turn_on»<\/button>/);
});

test('on for this device: the count includes it, and the button turns it off', () => {
  const view = notifyView({ ...ready, devices: 1 }, chrome, true);
  assert.deepEqual(view, { show: true, on: true, state: 'notify_on', devices: 1, action: 'off', note: null });
  const html = renderNotifyMenu(view, sentinel);
  assert.match(html, /«notify_devices_one n=1»/);
  assert.match(html, /<button class="plain" id="notify-toggle" type="button" data-action="off">«notify_turn_off»<\/button>/);
});

test('an iPhone outside the Home Screen gets the note, and no button that cannot work', () => {
  const view = notifyView(ready, { supported: false, apple: true, installed: false, permission: 'default' }, false);
  assert.deepEqual(view, { show: true, on: false, state: 'notify_off', devices: 2, action: null, note: 'notify_ios' });
  assert.doesNotMatch(renderNotifyMenu(view, sentinel), /<button/);
  assert.equal((notifyView(ready, { supported: false, apple: false, installed: false, permission: 'default' }, false) as { note: string }).note, 'notify_unsupported');
  assert.equal((notifyView(ready, { supported: true, apple: true, installed: true, permission: 'default' }, false) as { action: string }).action, 'on', 'installed, it works');
});

test('a browser that blocks the notifications says so, whatever was subscribed', () => {
  for (const subscribed of [false, true]) {
    assert.deepEqual(notifyView(ready, { ...chrome, permission: 'denied' }, subscribed), { show: true, on: false, state: 'notify_off', devices: 2, action: null, note: 'notify_blocked' });
  }
});

test('a service that cannot send here says why, with no button', () => {
  for (const reason of ['insecure', 'no_subject', 'store', 'config'] as const) {
    const view = notifyView({ available: false, reason, publicKey: null, devices: 0 }, chrome, false);
    assert.deepEqual(view, { show: true, on: false, state: 'notify_unavailable', devices: null, action: null, note: `notify_${reason}` });
    const html = renderNotifyMenu(view, sentinel);
    assert.doesNotMatch(html, /<button|notify_devices/);
  }
});

test('every key the button names is in the shell\'s catalog, in both languages', () => {
  const keys = new Set<string>();
  const record: Translate = (key) => { keys.add(key); return key; };
  const browsers: NotifyBrowser[] = [chrome, { ...chrome, permission: 'denied' }, { supported: false, apple: true, installed: false, permission: 'default' }, { ...chrome, supported: false }];
  const statuses: NotifyStatus[] = [ready, { ...ready, devices: 1 }, { ...ready, devices: 0 }, ...(['insecure', 'no_subject', 'store', 'config'] as const).map((reason) => ({ available: false, reason, publicKey: null, devices: 0 }))];
  for (const status of statuses) for (const browser of browsers) for (const subscribed of [false, true]) renderNotifyMenu(notifyView(status, browser, subscribed), record);
  for (const key of ['notify_label', 'notify_label_on', 'notify_failed', 'notify_off_failed', 'notify_ready_title', 'notify_ready_body']) keys.add(key);
  for (const language of ['en', 'fr'] as const) {
    const t = translator(loadCatalog('shell', language));
    for (const key of keys) assert.doesNotThrow(() => t(key, { n: 1 }), `${language} ${key}`);
  }
});

test('the public key is turned into the bytes the browser expects', () => {
  assert.deepEqual([...urlKey('AQID_-8')], [1, 2, 3, 255, 239]);
});
