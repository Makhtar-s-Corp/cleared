import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FakeBroker, head, service, settle } from './support.ts';
import { OWNER } from './harness.ts';

const oracle = new URL('./oracle.ts', import.meta.url).pathname;
const v1 = (s: Awaited<ReturnType<typeof service>>, command: string, ticket = 'LOCAL-1') =>
  JSON.parse(execFileSync(process.execPath, [oracle, join(s.box.state, 'ledger.db'), s.box.confFile, command, ticket], { encoding: 'utf8', env: { ...process.env, ORCH_STATE_DIR: s.box.state } }));
const moved = (s: Awaited<ReturnType<typeof service>>, args: string[] = []) => s.box.tracker('moved-by-owner', 'LOCAL-1', 'Ready to Ship', ...args).status;

test('an approval is held for 60 seconds, then the human\'s signed move is written, bound to the request and the shown heads', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  const begun = await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  assert.equal(begun.dueAt, '2026-10-21T10:01:00.000Z');
  assert.equal([...s.timers.pending.values()][0]?.ms, 60_000);
  assert.equal((await s.store.get(ticket.id))?.status, 'Needs Approval', 'nothing is written during the grace');
  assert.equal(s.broker?.requests.length, 0);

  s.advance(60_000);
  await s.timers.fire();
  assert.equal((await s.store.get(ticket.id))?.status, 'Ready to Ship');
  const history = v1(s, 'history');
  assert.deepEqual(history.at(-1).by, { kind: 'human', id: OWNER }, 'the lock\'s own tracker verifies the signature');
  assert.match(history.at(-1).approvalContext, /^[0-9a-f]{64}$/);
  assert.equal(moved(s, [asked.requestedAt]), 0, 'moved-by-owner: the human moved it, after the request, for these versions');
  assert.deepEqual(s.events().map((e) => [e.detail.gesture, e.detail.result, e.detail.user]), [['approve', 'started', 'u-owner'], ['approve', 'written', 'u-owner']]);
  assert.deepEqual(s.events()[1]?.detail.version, asked.heads);
  assert.equal(s.events()[0]?.source, 'app');
});

test('after the write the broker is asked for the release, once per shown pull request, with an announcement', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }, { pr: 9, head: head('b') }]);
  await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  await s.timers.fire();
  assert.deepEqual(s.broker?.requests.map((r) => [r.ticket, r.pr]), [['LOCAL-1', 7], ['LOCAL-1', 9]]);
  assert.match(s.broker?.requests[0]?.announcement ?? '', /Newest entry first/);
  assert.match(s.broker?.requests[0]?.announcement ?? '', /demo/);
  assert.equal(s.events().at(-1)?.detail.result, 'written');
});

test('a broker refusal is recorded and the signed move stays: the human did approve', async () => {
  const broker = new FakeBroker();
  broker.answer = { ok: false, output: '', reason: 'merge-pr.ts: #7 is not put live: no check ran on it' };
  const s = await service({ broker });
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  await s.timers.fire();
  assert.equal((await s.store.get(ticket.id))?.status, 'Ready to Ship');
  const last = s.events().at(-1);
  assert.equal(last?.detail.result, 'release_refused');
  assert.match(String(last?.detail.reason), /no check ran on it/);
});

test('with no broker (the real proof) the move is written and nothing is asked of the lock', async () => {
  const s = await service({ broker: null });
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  await s.timers.fire();
  assert.equal((await s.store.get(ticket.id))?.status, 'Ready to Ship');
  assert.deepEqual(s.events().map((e) => e.detail.result), ['started', 'written']);
});

test('Undo within the grace writes nothing, and the timer is gone', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  assert.deepEqual(await s.writer.undo(ticket.id, 'u-owner'), { undone: true });
  assert.equal(s.timers.pending.size, 0);
  await s.timers.fire();
  assert.equal((await s.store.get(ticket.id))?.status, 'Needs Approval');
  assert.equal((await s.store.history(ticket.id)).length, 2);
  assert.equal(s.broker?.requests.length, 0);
  assert.deepEqual(s.events().map((e) => e.detail.result), ['started', 'undone']);
  assert.deepEqual(await s.writer.undo(ticket.id, 'u-owner'), { undone: false }, 'nothing is left to undo');
  // and the same approval can be started again afterwards
  await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  await s.timers.fire();
  assert.equal((await s.store.get(ticket.id))?.status, 'Ready to Ship');
});

test('Undo after the write is too late and says so', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  await s.timers.fire();
  assert.deepEqual(await s.writer.undo(ticket.id, 'u-owner'), { undone: false });
  assert.equal((await s.store.get(ticket.id))?.status, 'Ready to Ship');
});

test('a second approval for the ticket while one is held is refused', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  const request = { ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads };
  await s.writer.begin(request);
  await assert.rejects(s.writer.begin(request), (error: Error & { code?: string }) => error.code === 'pending');
  assert.equal(s.timers.pending.size, 1);
});

test('everything is checked before the grace starts, and nothing is signed when a check fails', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  const request = { ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads };
  const refused = async (change: Partial<typeof request>, code: string) => {
    await assert.rejects(s.writer.begin({ ...request, ...change }), (error: Error & { code?: string }) => error.code === code, JSON.stringify(change));
    assert.equal(s.timers.pending.size, 0, 'no grace was started');
  };
  await refused({ by: 'u-guest' }, 'owner');
  await refused({ by: 'nobody' }, 'user');
  await refused({ ticket: 'LOCAL-9' }, 'ticket');
  await refused({ ticket: 'nonsense' }, 'ticket');
  await refused({ requestedAt: '2026-10-21T09:58:00.000Z' }, 'version');
  await refused({ heads: [{ pr: 7, head: head('b') }] }, 'version');
  await refused({ heads: [] }, 'version');
  await s.store.move(ticket.id, 'In Review', { kind: 'agents', id: 'cleared-v2' });
  await refused({}, 'state');
  assert.equal((await s.store.history(ticket.id)).at(-1)?.status, 'In Review');
});

test('a ticket with no request kept for it is refused', async () => {
  const s = await service();
  const ticket = await s.waiting();
  await assert.rejects(s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: '2026-10-21T09:59:00.000Z', heads: [{ pr: 7, head: head('a') }] }), (error: Error & { code?: string }) => error.code === 'version');
});

test('the checks are made again when the grace ends: a new request, a new head or a card moved back writes nothing', async () => {
  for (const [name, change] of [
    ['a new request landed', (s: Awaited<ReturnType<typeof service>>) => { s.ask([{ pr: 7, head: head('a') }], '2026-10-21T10:00:30.000000000Z'); }],
    ['the branch moved and the request was made again', (s: Awaited<ReturnType<typeof service>>) => { s.ask([{ pr: 7, head: head('c') }]); }],
    ['the card was moved back', (s: Awaited<ReturnType<typeof service>>) => s.store.move('LOCAL-1', 'In Progress', { kind: 'agents', id: 'cleared-v2' })],
  ] as const) {
    const s = await service();
    const ticket = await s.waiting();
    const asked = s.ask([{ pr: 7, head: head('a') }]);
    await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
    await change(s);
    await s.timers.fire();
    const status = (await s.store.get(ticket.id))?.status;
    assert.notEqual(status, 'Ready to Ship', name);
    assert.equal(s.broker?.requests.length, 0, name);
    assert.equal(s.events().at(-1)?.detail.result, 'refused', name);
    assert.equal(moved(s), 5, `${name}: the lock sees no move to the go state`);
  }
});

test('without a signing key the approval is refused up front', async () => {
  const s = await service({ withKey: false });
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await assert.rejects(s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads }), (error: Error & { code?: string }) => error.code === 'setup');
});

test('moved-by-owner refuses an approval signed for another request time or other heads, and a row the key never signed', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await s.writer.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: asked.requestedAt, heads: asked.heads });
  await s.timers.fire();
  assert.equal(moved(s), 0);
  // A new request is made (other time, other heads): the old approval answers another request.
  s.ask([{ pr: 7, head: head('c') }], '2026-10-21T10:30:00.000000000Z');
  assert.equal(moved(s), 8, 'the signed context no longer matches the request kept');
  s.ask([{ pr: 7, head: head('a') }], asked.requestedAt);
  assert.equal(moved(s), 0, 'and matches again when the very same request is kept');
  assert.equal(moved(s, ['2026-10-21T11:00:00.000000000Z']), 8, 'the move is older than a later request');
  // A process without the key writes the same row: it verifies as someone else.
  s.db.exec("UPDATE tracker_history SET proof = 'AAAA' WHERE status = 'Ready to Ship'");
  assert.equal(moved(s), 6);
  assert.deepEqual((await s.store.history(ticket.id)).at(-1)?.by.kind, 'other');
});

test('the lock sees the service as the agents\' application: tracker.ts identity answers app', async () => {
  const s = await service();
  assert.equal(s.box.tracker('identity').stdout.trim(), 'app');
});

test('a tool of the agents cannot move the card to the go state through tracker.ts', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const result = s.box.tracker('move', ticket.id, 'Ready to Ship');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot move a ticket to Ready to Ship/);
  await settle();
});
