// Resume from here in the session model (issue #272): each row keeps the
// stored event that began it, the author's checkpoints are kept, a step's
// commit is the one the service resumes from (src/flow/replay.ts
// stepCommit, the same rule on the same events), and a resume is a row on
// the session left and on the new one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stepCommit as serviceCommit } from '../../../src/flow/replay.ts';
import { AUTHOR_COMMIT, AUTHOR_ID, BASE_COMMIT, sessionFixture, sessionSource } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { applyAll, emptyModel, stepCommit, threadOf, type Row } from '../../web/screens/session/model.ts';

test('each row keeps its first event, and its step begins from the commit the service resumes from', () => {
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  const events = fixture.store.events.after(AUTHOR_ID);
  const model = emptyModel();
  applyAll(model, events);
  const thread = threadOf(model);
  assert.deepEqual(thread.checkpoints.map((c) => c.commit), [BASE_COMMIT, AUTHOR_COMMIT]);
  assert.ok(thread.rows.length > 5);
  for (const row of thread.rows) {
    assert.equal(typeof row.seq, 'number', `${row.kind} has its first event`);
    assert.equal(stepCommit(thread.checkpoints, row.seq as number)?.commit, serviceCommit(events, row.seq as number)?.commit, `${row.kind} at ${row.seq}`);
  }
  const start = (id: string) => events.find((e) => e.event.type === 'TOOL_CALL_START' && e.event.toolCallId === id)!.seq;
  const run = (id: string) => thread.rows.find((row) => row.seq === start(id)) as Row;
  assert.equal(run('run-1').kind, 'tool');
  assert.equal(stepCommit(thread.checkpoints, start('run-4'))?.commit, BASE_COMMIT, 'the commit\'s own step began before it');
  const after = thread.rows.findLast((row) => row.kind === 'message') as Row;
  assert.equal(stepCommit(thread.checkpoints, after.seq as number)?.commit, AUTHOR_COMMIT, 'the step after the commit begins from it');
  // Merged reads keep the first one's event.
  const read = thread.rows.find((row) => row.kind === 'read');
  assert.equal(read?.seq, start('read-1'));
  assert.equal(stepCommit([], 3), undefined, 'no checkpoint, no commit');
});

test('a resume is a row on the session left and on the new one, each knowing its side', async () => {
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  const source = sessionSource(fixture);
  const seq = fixture.store.events.after(AUTHOR_ID).find((e) => e.event.type === 'TOOL_CALL_START' && e.event.toolCallId === 'run-1')!.seq;
  const response = await post(source, `/api/sessions/${AUTHOR_ID}/replay`, { seq, message: 'Group by ISO week.' });
  assert.deepEqual(response, { status: 200, body: { accepted: true, session: `${AUTHOR_ID}-r1`, branch: 'cleared/LOCAL-161.r1', commit: BASE_COMMIT } });
  const rowsOf = (id: string) => { const model = emptyModel(); applyAll(model, fixture.store.events.after(id)); return threadOf(model).rows.filter((row) => row.kind === 'replay'); };
  const [left] = rowsOf(AUTHOR_ID);
  const [resumed] = rowsOf(`${AUTHOR_ID}-r1`);
  assert.equal(left?.kind === 'replay' && left.side, 'left');
  assert.equal(resumed?.kind === 'replay' && resumed.side, 'resumed');
  assert.equal(resumed?.kind === 'replay' && resumed.message, 'Group by ISO week.');
  assert.equal((await post(source, `/api/sessions/${AUTHOR_ID}/replay`, { seq, message: ' ' })).status, 400);
  assert.equal((await post(source, `/api/sessions/${AUTHOR_ID}/replay`, { seq: 100_000, message: 'x' })).status, 400);
});

// The fixture's route, as the app's proxy forwards it, over loopback.
async function post(source: ReturnType<typeof sessionSource>, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const server = createServer((request, response) => source.forward(request, response, { method: request.method ?? 'GET', path: request.url ?? '/', user: { id: 'owner', name: 'Owner' } }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
