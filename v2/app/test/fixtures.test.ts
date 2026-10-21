import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, SessionSummary } from '../../src/api/types.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { fixtureSource } from '../fixtures/source.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { signedIn, startApp } from './support.ts';

test('the fixture source answers the service\'s routes from lane 1\'s fake sessions', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const sessions = await (await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } })).json() as SessionSummary[];
    assert.equal(sessions.length, 4);
    assert.ok(sessions.every((s) => s.lastSeq > 0), 'each session has stored events');
    const inbox = await (await fetch(`${app.base}/api/service/inbox`, { headers: { cookie } })).json() as InboxItem[];
    assert.deepEqual(inbox.map((i) => i.kind), ['release', 'permission']);
    const first = sessions[0]!;
    const detail = await fetch(`${app.base}/api/service/sessions/${first.id}`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const events = await fetch(`${app.base}/api/service/sessions/${first.id}/events?after=0`, { headers: { cookie } });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const text = await events.text();
    assert.match(text, /^id: 1\nevent: STEP_STARTED\ndata: /);
    assert.equal((await fetch(`${app.base}/api/service/sessions/nope`, { headers: { cookie } })).status, 404);
  } finally {
    await app.close();
  }
});

test('creating a ticket works on the fixtures, in Todo, under the signed-in user', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie, csrf } = await signedIn(app);
    const created = await fetch(`${app.base}/api/service/tickets`, {
      method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'The guestbook shows the newest entry first', project: 'guestbook' }),
    });
    assert.equal(created.status, 201);
    const ticket = await created.json() as Ticket;
    assert.equal(ticket.status, 'Todo');
    assert.equal(ticket.title, 'The guestbook shows the newest entry first');
    const tickets = await (await fetch(`${app.base}/api/service/tickets`, { headers: { cookie } })).json() as Ticket[];
    assert.ok(tickets.some((t) => t.id === ticket.id));
    for (const body of ['{"title":"","project":"guestbook"}', '{"project":"guestbook"}', 'not json', JSON.stringify({ title: 'x'.repeat(201), project: 'guestbook' })]) {
      const refused = await fetch(`${app.base}/api/service/tickets`, { method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body });
      assert.equal(refused.status, 400, body);
    }
    assert.equal((await fetch(`${app.base}/api/service/tickets/${ticket.id}/approve`, { method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf } })).status, 404, 'the fixtures approve nothing');
  } finally {
    await app.close();
  }
});
