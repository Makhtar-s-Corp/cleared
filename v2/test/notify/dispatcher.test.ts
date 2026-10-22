// The v2 dispatcher's rules (docs/v2/milestone-2-plan.md, section 6), with a
// sender that records what it is given: what is sent, when, with which kind
// and link, and what is held, folded or dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuiet } from '../../src/notify/dispatcher.ts';
import { reportHealth } from '../../src/notify/queue.ts';
import { setup } from './support.ts';

const brief = (m: { kind: string; ticket: string | null; link: string }) => `${m.kind} ${m.ticket ?? '-'} ${m.link}`;

test('the first run takes note of what waits and sends nothing; what comes after is sent', async () => {
  const t = setup();
  t.permission('LOCAL-1', 'r1');
  t.ledger('rollback_pushed', 'LOCAL-2');
  const first = await t.dispatcher.tick();
  assert.deepEqual(first.sent, []);
  assert.equal(t.sender.batches, 0, 'nothing is handed to the adapters on the first run');
  t.advance(1);
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent, [], 'what existed at the first run is never sent later');
  const id = t.permission('LOCAL-3', 'r1');
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map(brief), [`permission LOCAL-3 /inbox#${encodeURIComponent(id)}`]);
});

test('a permission waiting is sent once, with its inbox link; a second permission of the same ticket within 10 minutes sends nothing', async () => {
  const t = setup();
  await t.dispatcher.tick();
  const first = t.permission('LOCAL-1', 'r1');
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map(brief), [`permission LOCAL-1 /inbox#${encodeURIComponent(first)}`]);
  assert.equal(t.sender.sent[0]?.group, 'LOCAL-1');
  t.advance(1);
  await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 1, 'the same item is not sent again');

  t.advance(2);
  t.permission('LOCAL-1', 'r2');
  t.advance(6);
  const held = await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 1, 'one notification per ticket every 10 minutes');
  assert.equal(held.held.length, 1);
  // Another ticket is not held by this one.
  t.permission('LOCAL-2', 'r1');
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => m.ticket), ['LOCAL-1', 'LOCAL-2']);
  // Past the window, the second one still waits, so it is sent.
  t.advance(2);
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => m.ticket), ['LOCAL-1', 'LOCAL-2', 'LOCAL-1']);
});

test('an item handled before the tick is not sent', async () => {
  const t = setup();
  await t.dispatcher.tick();
  const id = t.permission('LOCAL-1', 'r1');
  t.inbox.handle(id, 'u1');
  const result = await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 0);
  assert.equal(result.dropped.length, 0, 'never queued: it no longer waits');
  // Held by the coalescing window, then answered: still not sent.
  t.permission('LOCAL-2', 'r1');
  await t.dispatcher.tick();
  const second = t.permission('LOCAL-2', 'r2');
  await t.dispatcher.tick();
  t.inbox.handle(second, 'u1');
  t.advance(11);
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => m.key), ['permission:s-LOCAL-2:r1']);
});

test('quiet hours: a rollback is sent at once, a release waiting for approval waits until they end', async () => {
  const t = setup({ quiet: { start: 22 * 60, end: 7 * 60 } });
  await t.dispatcher.tick();
  t.advance(3 * 60);                       // 23:00 UTC
  t.release('LOCAL-1', 'Show the newest entry first');
  t.store.db.prepare('INSERT INTO releases (ticket, pr, title) VALUES (?, ?, ?)').run('LOCAL-2', 8, 'Trim the names');
  t.ledger('rollback_pushed', 'LOCAL-2');
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => `${m.kind} ${m.ticket} ${m.link} ${m.title}`), ['rollback LOCAL-2 /inbox Trim the names']);
  t.advance(7 * 60);                       // 06:00
  await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 1, 'still quiet');
  t.advance(61);                           // 07:01
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => m.kind), ['rollback', 'approval']);
  assert.equal(t.sender.sent[1]?.title, 'Show the newest entry first');
  assert.match(t.sender.sent[1]?.link ?? '', /^\/inbox#release%3ALOCAL-1%3A7%3A/);
});

test('isQuiet reads the hours on the configured clock, across midnight or not', () => {
  const night = { quiet: { start: 22 * 60, end: 7 * 60 }, timezone: 'Europe/Paris' };
  assert.equal(isQuiet(night, Date.parse('2026-10-22T20:30:00Z')), true, '22:30 in Paris');
  assert.equal(isQuiet(night, Date.parse('2026-10-22T19:30:00Z')), false, '21:30 in Paris');
  assert.equal(isQuiet(night, Date.parse('2026-10-23T05:30:00Z')), false, '07:30 in Paris');
  const lunch = { quiet: { start: 12 * 60, end: 13 * 60 }, timezone: 'UTC' };
  assert.equal(isQuiet(lunch, Date.parse('2026-10-22T12:59:00Z')), true);
  assert.equal(isQuiet(lunch, Date.parse('2026-10-22T13:00:00Z')), false);
  assert.equal(isQuiet({ quiet: null, timezone: 'UTC' }, Date.parse('2026-10-22T23:00:00Z')), false);
});

test('a plan waiting sends `plan` with the lead link; a question of the lead sends `question` with the lead link', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.plan('p1', 'Make the guestbook ready for a small team');
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map(brief), ['plan - /lead']);
  assert.equal(t.sender.sent[0]?.title, 'Make the guestbook ready for a small team');
  assert.equal(t.sender.sent[0]?.group, 'lead');

  const u = setup();
  await u.dispatcher.tick();
  u.question('lead', 'q1', 'lead-session');
  const team = u.question('LOCAL-4', 'q1');
  await u.dispatcher.tick();
  assert.deepEqual(u.sender.sent.map((m) => `${brief(m)} ${m.from ?? 'team'}`).sort(), [`question - /lead lead`, `question LOCAL-4 /inbox#${encodeURIComponent(team)} team`]);
  // Nothing of the question's own text is handed on.
  assert.doesNotMatch(JSON.stringify(u.sender.sent), /tok_live|Which token/);
});

test('every send is a notification_sent event with the kind and the adapter; a failure is a notification_failed with a short code', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.sender.outcome = () => [{ adapter: 'webpush', result: 'sent' }, { adapter: 'ntfy', result: 'failed', reason: 'ntfy refused (403)' }];
  t.permission('LOCAL-1', 'r1');
  t.advance(2);
  await t.dispatcher.tick();
  assert.deepEqual(t.events().map((e) => [e.kind, e.ticket, e.detail]), [
    ['notification_sent', 'LOCAL-1', { event: 'permission', adapter: 'webpush' }],
    ['notification_failed', 'LOCAL-1', { event: 'permission', adapter: 'ntfy', reason: 'ntfy refused (403)' }],
  ]);
  assert.equal(t.events('notification_sent')[0]?.value, 120, 'the seconds between the wait and the send');
  // A plan has no ticket: its event has none either. A reason that is not a short code is not kept.
  t.sender.outcome = () => [{ adapter: 'webpush', result: 'sent' }, { adapter: 'ntfy', result: 'failed', reason: 'refused by https://ntfy.example.org/topic' }];
  t.plan('p1', 'A plan');
  await t.dispatcher.tick();
  assert.deepEqual(t.events().slice(2).map((e) => [e.kind, e.ticket, e.detail]), [
    ['notification_sent', null, { event: 'plan', adapter: 'webpush' }],
    ['notification_failed', null, { event: 'plan', adapter: 'ntfy', reason: 'failed' }],
  ]);
});

test('the most pressing kind of a ticket is sent, and what waits with it is folded into it', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.permission('LOCAL-1', 'r1');
  t.question('LOCAL-1', 'q1');
  t.release('LOCAL-1', 'Rename the save button');
  const result = await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => m.kind), ['approval']);
  assert.equal(result.dropped.length, 2);
  t.advance(11);
  await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 1, 'folded is final');
});

test('a rollback or a health problem waits only behind another one of those, never behind a request', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.permission('LOCAL-1', 'r1');
  await t.dispatcher.tick();
  t.advance(1);
  t.ledger('rollback_pushed', 'LOCAL-1');
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => m.kind), ['permission', 'rollback']);
  t.advance(1);
  t.ledger('release_health_failing', 'LOCAL-1', 'GET /health answered 500');
  await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 2, 'held behind the rollback sent a minute ago');
  t.advance(10);
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => `${m.kind} ${m.code ?? ''}`), ['permission ', 'rollback ', 'health release_health_failing']);
  assert.doesNotMatch(JSON.stringify(t.sender.sent), /answered 500/, 'a ledger detail is never handed on');
});

test('health: the release watch\'s failures by their code, an unknown one as other, and the health that other modules report', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.ledger('release_watch_failed', 'LOCAL-1');
  t.ledger('rollback_failed', 'LOCAL-2');
  t.ledger('app_gesture', 'LOCAL-3');
  reportHealth(t.store.db, { code: 'lead_start_failed', at: new Date(t.clock).toISOString() });
  reportHealth(t.store.db, { code: 'week_stop', at: new Date(t.clock).toISOString() });
  reportHealth(t.store.db, { code: 'made up', at: new Date(t.clock).toISOString() });
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => `${m.ticket ?? '-'} ${m.code} ${m.group} ${m.link}`).sort(), [
    '- lead_start_failed health:lead_start_failed /',
    '- other health:other /',
    '- week_stop health:week_stop /',
    'LOCAL-1 release_watch_failed LOCAL-1 /',
    'LOCAL-2 rollback_failed LOCAL-2 /',
  ]);
  // The same report a second time, at the same time, is the same occurrence.
  reportHealth(t.store.db, { code: 'week_stop', at: new Date(t.clock).toISOString() });
  t.advance(11);
  await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 5);
});

test('a kind turned off is never sent; an item older than a day is dropped unsent', async () => {
  const t = setup({ events: ['approval', 'question', 'plan', 'rollback', 'health'] });
  await t.dispatcher.tick();
  t.permission('LOCAL-1', 'r1');
  const result = await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent, []);
  assert.equal(result.dropped.length, 1);

  const u = setup({ quiet: { start: 0, end: 23 * 60 + 59 } });
  await u.dispatcher.tick();
  u.permission('LOCAL-1', 'r1');
  await u.dispatcher.tick();
  u.advance(25 * 60);
  u.sender.settingsValue = { ...u.sender.settingsValue, quiet: null };
  const late = await u.dispatcher.tick();
  assert.deepEqual(u.sender.sent, []);
  assert.deepEqual(late.dropped, ['permission:s-LOCAL-1:r1']);
});

test('with no adapter ready the occurrence is dropped as undelivered; three failed tries give it up', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.sender.outcome = () => [];
  t.permission('LOCAL-1', 'r1');
  const none = await t.dispatcher.tick();
  assert.deepEqual(none.dropped, ['permission:s-LOCAL-1:r1']);
  t.sender.outcome = () => [{ adapter: 'webpush', result: 'sent' }];
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent, [], 'not kept for later');

  const u = setup();
  await u.dispatcher.tick();
  let tries = 0;
  u.sender.outcome = () => { tries += 1; return [{ adapter: 'webpush', result: 'failed', reason: 'push service refused' }]; };
  u.permission('LOCAL-1', 'r1');
  for (let i = 0; i < 5; i += 1) { await u.dispatcher.tick(); u.advance(1); }
  assert.equal(tries, 3);
});

test('what the deadline cut is still pending, not a try, and is sent at the next tick', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.sender.outcome = () => undefined;
  t.permission('LOCAL-1', 'r1');
  const cut = await t.dispatcher.tick();
  assert.deepEqual(cut.held, ['permission:s-LOCAL-1:r1']);
  t.sender.outcome = (m) => (m.kind === 'permission' ? [{ adapter: 'webpush', result: 'abandoned' }] : undefined);
  await t.dispatcher.tick();
  t.sender.outcome = () => [{ adapter: 'webpush', result: 'sent' }];
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => m.kind), ['permission']);
  assert.equal(t.events('notification_failed').length, 0);
});

test('a restarted service sends nothing twice, and a tick never runs over another one', async () => {
  const t = setup();
  await t.dispatcher.tick();
  t.permission('LOCAL-1', 'r1');
  t.ledger('rollback_pushed', 'LOCAL-2');
  await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 2);
  const again = t.restart();
  t.advance(30);
  await again.tick();
  assert.equal(t.sender.sent.length, 2, 'the queue and its cursor are in the ledger');

  let release: () => void = () => {};
  let entered: () => void = () => {};
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  const slow = t.sender.send.bind(t.sender);
  t.sender.send = async (messages, deadline) => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return slow(messages, deadline); };
  t.permission('LOCAL-3', 'r1');
  const first = again.tick();
  await sending;
  const second = again.tick();
  assert.equal(first, second, 'a tick asked while one runs is that tick');
  release();
  await first;
  assert.deepEqual(t.sender.sent.map((m) => m.ticket), ['LOCAL-1', 'LOCAL-2', 'LOCAL-3']);
});

test('settings are read only when something is to be sent; settings that cannot be read hold it until they can', async () => {
  const t = setup();
  const good = t.sender.settings.bind(t.sender);
  let reads = 0, fail = true;
  t.sender.settings = async () => { reads += 1; if (fail) throw new Error('[notify] quiet_hours must read like 22:00-07:00'); return good(); };
  await t.dispatcher.tick();
  await t.dispatcher.tick();
  assert.equal(reads, 0, 'nothing waits: the settings are not read');
  t.permission('LOCAL-1', 'r1');
  await assert.rejects(t.dispatcher.tick(), /quiet_hours/);
  await assert.rejects(t.dispatcher.tick(), /quiet_hours/);
  fail = false;
  await t.dispatcher.tick();
  await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 1);
  assert.equal(reads, 3, 'read settings are kept for a while');
});
