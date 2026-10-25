// The fixtures of a ticket with an author then a reviewer (lane 36): the
// fixtures source's LOCAL-152, its author done before the reviewer the tower
// shows; and the session fixture's LOCAL-161, whose reviewer a test starts
// while the author's view is open, the change stream saying so.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail, SessionFiles, SessionSummary } from '../../../src/api/types.ts';
import type { Ticket } from '../../../src/tickets/contract.ts';
import type { SessionEvent } from '../../../src/session/events.ts';
import { AUTHOR_ID, ENVELOPE_AUTHOR_ID, ENVELOPE_TICKET, REVIEWER_ID, TICKET_ID, sessionFixture, sessionSource, startReview } from '../../fixtures/session.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { applyAll, emptyModel, threadOf } from '../../web/screens/session/model.ts';
import { ticketSessions, ticketThread } from '../../web/screens/session/ticket.ts';
import { signedIn, startApp } from '../support.ts';

const parse = (text: string): SessionEvent[] => text.split('\n\n').map((frame) => /^data: (.*)$/m.exec(frame)?.[1]).filter((data): data is string => Boolean(data)).map((data) => JSON.parse(data) as SessionEvent);

test('the fixtures source\'s LOCAL-152: the author done, then the reviewer the tower shows, one thread with a handover row', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const get = async (path: string) => fetch(`${app.base}/api/service${path}`, { headers: { cookie } });
    const all = await (await get('/sessions')).json() as SessionSummary[];
    const sessions = ticketSessions(all, ENVELOPE_TICKET);
    assert.deepEqual(sessions.map((s) => [s.role, s.phase]), [['author', 'done'], ['reviewer', 'reviewing']]);
    assert.equal(sessions[0]?.id, ENVELOPE_AUTHOR_ID);
    const parts = await Promise.all(sessions.map(async (summary) => {
      const model = emptyModel();
      applyAll(model, parse(await (await get(`/sessions/${summary.id}/events?after=0`)).text()));
      return { summary, thread: threadOf(model) };
    }));
    const entries = ticketThread(parts, 'all');
    assert.ok(entries.some((e) => e.kind === 'handover'), 'a handover row');
    assert.ok(entries.some((e) => e.kind === 'row' && e.row.kind === 'edits'), 'two edits of the sheet in a row are one row');
    assert.equal(parts[1]?.thread.state?.status, 'Reading the diff of src/screens/Envelope.jsx', 'the reviewer says what the tower says');
    const files = await (await get(`/sessions/${ENVELOPE_AUTHOR_ID}/files`)).json() as SessionFiles;
    assert.deepEqual(files.files.map((f) => [f.path, f.added, f.removed]), [['src/screens/Envelope.jsx', 15, 2], ['test/envelope.test.mjs', 13, 0]]);
    assert.equal((await get('/sessions/fixture-2/files/src/screens/Envelope.jsx')).status, 200, 'the reviewer reads the ticket\'s branch');
    const ticket = await (await get(`/tickets/${ENVELOPE_TICKET}`)).json() as Ticket;
    assert.match(ticket.body, /- \[x\] The three months before this one/);
    const detail = await (await get(`/sessions/${ENVELOPE_AUTHOR_ID}`)).json() as SessionDetail;
    assert.equal(detail.state.phase, 'done');
  } finally {
    await app.close();
  }
});

test('the session fixture\'s review: the author done, then the reviewer started by a test, the change stream saying it', async () => {
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  assert.deepEqual(fixture.sessions.map((s) => [s.id, s.phase]), [[AUTHOR_ID, 'done']]);
  assert.ok(fixture.inbox.every((item) => item.state === 'handled'), 'the request was answered');
  const source = sessionSource(fixture);
  const app = await startApp({ source });
  try {
    const { cookie } = await signedIn(app);
    const stream = await fetch(`${app.base}/api/service/events`, { headers: { cookie } });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const reviewer = startReview(fixture);
    source.changed('session', reviewer.id);
    let text = '';
    while (!text.includes('event: change')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, new RegExp(`"kind":"session","id":"${REVIEWER_ID}"`));
    await reader.cancel();
    const all = await (await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } })).json() as SessionSummary[];
    assert.deepEqual(ticketSessions(all, TICKET_ID).map((s) => s.role), ['author', 'reviewer']);
  } finally {
    await app.close();
  }
  assert.deepEqual(sessionFixture(FIXTURE_NOW, { review: 'started' }).sessions.map((s) => s.role), ['author', 'reviewer']);
});
