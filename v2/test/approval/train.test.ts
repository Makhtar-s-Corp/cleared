// The approval of a release train (docs/v2/milestone-2-plan.md, decision 21,
// lane 16): the route answers 409 with the proposal for a card the
// compatibility check blocked; otherwise every service's own validations
// record must still hold the head the card showed. The owner's move written
// after the grace is bound to the first service's record, and the move the
// train signs before the next service lands is bound to that service's: v1's
// tracker.ts, run with each service's state folder on the shared ledger, is
// the oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { createApprovalRoutes } from '../../src/approval/route.ts';
import { serviceLocks, TrainApprovals, type Environment } from '../../src/approval/service.ts';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { defaultRegistry, dispatch, type App } from '../../src/modules/registry.ts';
import { TrainStore, type Stop } from '../../src/release/store.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OWNER, scratch } from './harness.ts';
import { PROOF, head, service } from './support.ts';

const svc = (name: string, state: string, consumes: string[] = []): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes, run: null, contract: null, brokerSocket: join(state, 'release.sock'), brokerState: state,
});

async function world(options: { blocked?: boolean } = {}) {
  const s = await service();
  const second = scratch('cleared-v2-train-');
  const workspace: WorkspaceConfig = { id: 'guestbook', name: 'Guestbook', file: '/etc/ws.conf', services: [svc('guestbook', second, ['filter-api']), svc('filter-api', s.box.state)] };
  s.db.exec(INBOX_TABLE);
  const ticket = await s.waiting();
  // What each service's ask-validation.ts kept: the filter API's record in the first box, the guestbook's in the second.
  const record = (state: string, at: string, pulls: { pr: number; head: string }[]) => {
    mkdirSync(join(state, 'validations'), { recursive: true });
    writeFileSync(join(state, 'validations', `${ticket.id}.json`), JSON.stringify({ ticket: ticket.id, at, pulls }));
  };
  const filterAt = '2026-10-21T09:58:00.111111111Z';
  const guestbookAt = '2026-10-21T09:58:05.222222222Z';
  record(s.box.state, filterAt, [{ pr: 7, head: head('b') }]);
  record(second, guestbookAt, [{ pr: 7, head: head('a') }]);
  const stop = (name: string, sha: string, at: string): Stop => ({ service: name, pr: { number: 7, url: `https://example.invalid/${name}/pull/7` }, head: sha, requestedAt: at, state: 'waiting', at: null, note: null, signed: false, askedAt: null, mergedAt: null, next: null });
  const stops = [stop('filter-api', head('b'), filterAt), stop('guestbook', head('a'), guestbookAt)];
  const inbox = new InboxStore(s.db, s.now);
  const item = inbox.addRelease({
    ticket: ticket.id, project: 'guestbook', title: ticket.title, announcement: 'Held for review', requestedAt: filterAt,
    pr: { number: 7, url: stops[0]!.pr.url, checks: 'passed' }, heads: stops.map((x) => ({ pr: 7, head: x.head })),
    captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
  });
  const trains = new TrainStore(s.db, s.now);
  const blocked = options.blocked ? { reason: 'filter-api changes its contract (contract/openapi.yaml), and guestbook, which consumes it, is not changed in this ticket.', proposal: 'Extend the contract so that guestbook keeps working as it is, or keep the change backward compatible; or ask the lead to add a step on guestbook.' } : null;
  trains.add({ item: item.id, ticket: ticket.id, project: 'guestbook', state: blocked ? 'blocked' : 'waiting', stops, compatibility: 'guestbook consumes filter-api and is changed in this ticket.', blocked, announcement: 'Held for review' });
  const environment: Environment = {
    ...s.parts, conf: { ownerId: OWNER, publicKey: s.box.keys.publicKey, states: s.store.states } as Environment['conf'],
    signer: ApprovalSigner.load(s.box.keyFile), stateDir: s.box.state, users: s.users, proof: PROOF,
  };
  const locks = serviceLocks(s.db, workspace, { env: s.box.env, environment, now: s.now });
  const approvals = new TrainApprovals({ db: s.db, workspace, locks, environment, env: s.box.env, timers: s.timers, now: s.now });
  // v1's oracle: did the owner move this ticket to go, bound to this state folder's record?
  const movedByOwner = (state: string) => s.box.run('tracker.ts', ['moved-by-owner', ticket.id, 'Ready to Ship'], { ORCH_STATE_DIR: state, CLEARED_STATE_DIR: state, ORCH_LEDGER: join(s.box.state, 'ledger.db') }).status;
  return { s, ticket, item, trains, approvals, locks, workspace, second, stops, filterAt, guestbookAt, record, movedByOwner };
}

async function serve(w: Awaited<ReturnType<typeof world>>, run: (call: (path: string, body: unknown, user?: string) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>) {
  const app: App = { registry: { ...defaultRegistry(), users: w.s.users, ticketStore: w.s.store, approvalWriter: w.s.writer }, tables: [], routes: createApprovalRoutes(() => w.approvals) };
  const server: Server = createServer((request, response) => dispatch(app, request, response, (_req, res) => { res.writeHead(404); res.end(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, user = 'u-owner') => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: user }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  };
  try { await run(call); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); }
}

const shown = (w: Awaited<ReturnType<typeof world>>) => ({ requestedAt: w.filterAt, heads: [{ pr: 7, head: head('a') }, { pr: 7, head: head('b') }] });

test('a card the compatibility check blocked answers 409 with the proposal, and nothing is held or signed', async () => {
  const w = await world({ blocked: true });
  await serve(w, async (call) => {
    const answer = await call(`/api/tickets/${w.ticket.id}/approve`, shown(w));
    assert.equal(answer.status, 409);
    assert.match(String(answer.body.error), /guestbook, which consumes it, is not changed/);
    assert.match(String(answer.body.proposal), /Extend the contract/);
  });
  assert.equal(w.s.timers.pending.size, 0);
  assert.equal(w.trains.get(w.item.id)?.approver, null);
  assert.equal((await w.s.store.get(w.ticket.id))?.status, 'Needs Approval');
});

test('the heads the owner approves must be every service\'s, as the card showed them, at the card\'s request time', async () => {
  const w = await world();
  await serve(w, async (call) => {
    const path = `/api/tickets/${w.ticket.id}/approve`;
    assert.equal((await call(path, { requestedAt: w.filterAt, heads: [{ pr: 7, head: head('b') }] })).status, 409, 'one service only');
    assert.equal((await call(path, { requestedAt: w.filterAt, heads: [{ pr: 7, head: head('a') }, { pr: 7, head: head('c') }] })).status, 409, 'another head');
    assert.equal((await call(path, { ...shown(w), requestedAt: w.guestbookAt })).status, 409, 'another request time');
  });
  assert.equal(w.s.timers.pending.size, 0);
});

test('a later service whose record changed since the card was shown refuses the approval, naming it', async () => {
  const w = await world();
  w.record(w.second, '2026-10-21T09:59:30.000000000Z', [{ pr: 7, head: head('c') }]);
  await serve(w, async (call) => {
    const answer = await call(`/api/tickets/${w.ticket.id}/approve`, shown(w));
    assert.equal(answer.status, 409);
    assert.match(String(answer.body.error), /guestbook/);
  });
  assert.equal(w.s.timers.pending.size, 0);
});

test('only the owner approves a train', async () => {
  const w = await world();
  await serve(w, async (call) => {
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, shown(w), 'u-guest')).status, 403);
  });
  assert.equal(w.s.timers.pending.size, 0);
});

test('one gesture: the owner\'s move after the grace is bound to the first service\'s record, then the train\'s move to the next one\'s; v1 reads each as the owner\'s', async () => {
  const w = await world();
  await serve(w, async (call) => {
    const answer = await call(`/api/tickets/${w.ticket.id}/approve`, shown(w));
    assert.equal(answer.status, 202, JSON.stringify(answer.body));
    assert.equal(typeof answer.body.dueAt, 'string');
  });
  assert.equal(w.trains.get(w.item.id)?.approver, 'u-owner', 'the approver is kept with the train');
  assert.notEqual(w.movedByOwner(w.s.box.state), 0, 'nothing is written during the grace');
  await w.s.timers.fire();
  assert.equal((await w.s.store.get(w.ticket.id))?.status, 'Ready to Ship');
  assert.equal(w.movedByOwner(w.s.box.state), 0, 'the filter API\'s merge-pr.ts reads the owner\'s move, bound to its record');
  assert.equal(w.movedByOwner(w.second), 8, 'the guestbook\'s does not: its record is another request');

  // The filter API landed (merge-pr.ts closed the ticket on its own record); the train puts it back to validate and signs for the guestbook.
  await w.s.store.move(w.ticket.id, 'Done', { kind: 'agents', id: 'cleared-v2' });
  await w.s.store.move(w.ticket.id, 'Needs Approval', { kind: 'agents', id: 'cleared-v2' });
  w.s.advance(1000);
  const guestbook = w.locks(w.workspace.services[0] as ServiceConfig);
  assert.equal(guestbook.check({ ticket: w.ticket.id, requestedAt: w.guestbookAt, head: { pr: 7, head: head('a') } }), undefined);
  await guestbook.sign({ ticket: w.ticket.id, by: 'u-owner', requestedAt: w.guestbookAt, heads: [{ pr: 7, head: head('a') }] });
  assert.equal(w.movedByOwner(w.second), 0, 'the guestbook\'s merge-pr.ts reads the owner\'s move, bound to its record');
  await assert.rejects(guestbook.sign({ ticket: w.ticket.id, by: 'u-guest', requestedAt: w.guestbookAt, heads: [{ pr: 7, head: head('a') }] }), /owner/, 'signed for the owner only');
});

test('Undo of a train during the grace writes nothing and forgets the approver', async () => {
  const w = await world();
  await serve(w, async (call) => {
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, shown(w))).status, 202);
    const undone = await call(`/api/tickets/${w.ticket.id}/approve/undo`, {});
    assert.deepEqual(undone, { status: 200, body: { undone: true } });
  });
  assert.equal(w.trains.get(w.item.id)?.approver, null);
  await w.s.timers.fire();
  assert.equal((await w.s.store.get(w.ticket.id))?.status, 'Needs Approval');
});

test('two services on one broker state folder or one socket are refused', () => {
  const state = scratch('cleared-v2-one-');
  const same: WorkspaceConfig = { id: 'w', name: 'w', file: null, services: [svc('one', state), { ...svc('two', state), brokerSocket: join(state, 'other.sock') }] };
  assert.throws(() => serviceLocks(null as never, same, { env: {} }), /one and two name the same broker state folder/);
  const socket: WorkspaceConfig = { id: 'w', name: 'w', file: null, services: [svc('one', state), { ...svc('two', scratch('cleared-v2-two-')), brokerSocket: join(state, 'release.sock') }] };
  assert.throws(() => serviceLocks(null as never, socket, { env: {} }), /one and two name the same broker socket/);
});
