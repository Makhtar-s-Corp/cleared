// Close (issue #249, P53): the model side of the Close action on a release
// card and on a ticket: the reason is mandatory, what the call sends, how a
// refusal reads, and what a closed card says in the history, in English and
// in French.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseItem } from '../../../src/api/types.ts';
import { CLOSE_REASON_MAX as SERVICE_MAX } from '../../../src/flow/engine.ts';
import { inboxFixture } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { CLOSE_REASON_MAX, closeReason, closeTicket } from '../../web/lib/close.ts';
import { ApiError, type ScreenContext } from '../../web/lib/screen.ts';
import { failure, outcomeLine, type InboxView } from '../../web/screens/inbox/model.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });
const ME = 'user-demo';
const fixture = inboxFixture(FIXTURE_NOW);
const release = fixture.items[0] as ReleaseItem;
const view: InboxView = { items: [], tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false, me: { id: ME, name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop' };

test('a Close says why: some text, at most the service\'s length', () => {
  assert.equal(CLOSE_REASON_MAX, SERVICE_MAX);
  assert.deepEqual(closeReason('  A rehearsal ticket.  '), { reason: 'A rehearsal ticket.' });
  assert.deepEqual(closeReason(' \n '), { error: 'close_empty' });
  assert.deepEqual(closeReason('x'.repeat(CLOSE_REASON_MAX + 1)), { error: 'close_long' });
});

test('Close calls the ticket\'s close route with the trimmed reason, and refuses an empty one before the call', async () => {
  const sent: { path: string; body: unknown }[] = [];
  const api = (async (path: string, init: { body?: unknown } = {}) => { sent.push({ path, body: init.body }); return { sessions: 0, items: 1 }; }) as ScreenContext['api'];
  assert.deepEqual(await closeTicket(api, 'LOCAL-12', '  Never ships.  ', FIXTURE_NOW), { kind: 'closed', at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(sent, [{ path: '/tickets/LOCAL-12/close', body: { reason: 'Never ships.' } }]);
  await assert.rejects(closeTicket(api, 'LOCAL-12', ' ', FIXTURE_NOW), /close_empty/);
  assert.equal(sent.length, 1);
});

test('a refusal of a Close reads as what it means', () => {
  const error = (status: number) => new ApiError(status, String(status));
  assert.deepEqual(failure(error(409), 'close'), { key: 'close_conflict', settled: false });
  assert.deepEqual(failure(error(404), 'close'), { key: 'close_conflict', settled: false });
  assert.deepEqual(failure(error(400), 'close'), { key: 'close_invalid', settled: false });
  assert.deepEqual(failure(error(403), 'close'), { key: 'decided_user', settled: false });
  assert.deepEqual(failure(error(500), 'close'), { key: 'close_failed', settled: false });
  for (const key of ['close', 'close_field', 'close_send', 'close_keep', 'close_empty', 'close_long', 'close_conflict', 'close_invalid', 'close_failed', 'close_rule', 'closed_done']) {
    assert.ok(en(key, { n: CLOSE_REASON_MAX, time: '09:12' }) !== key && fr(key, { n: CLOSE_REASON_MAX, time: '09:12' }) !== key, key);
  }
});

test('a closed release card stays in the history and says who closed it, when, and why', () => {
  const at = new Date(2026, 9, 21, 9, 12).toISOString();
  const closed = (by: string): ReleaseItem => ({ ...release, state: 'handled', outcome: { decision: 'close', reason: 'A rehearsal ticket.', by, at } });
  assert.equal(outcomeLine(closed(ME), view, en), 'Closed by you at 09:12: “A rehearsal ticket.”');
  assert.equal(outcomeLine(closed(ME), view, fr), 'Fermé par vous à 09:12 : « A rehearsal ticket. »');
  assert.equal(outcomeLine(closed('user-other'), view, en), 'Closed by user-other at 09:12: “A rehearsal ticket.”');
  assert.equal(outcomeLine({ ...release, state: 'handled' }, view, en), en('handled_note'), 'a release handled without a close keeps the plain note');
});
