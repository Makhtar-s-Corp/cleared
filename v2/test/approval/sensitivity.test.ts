// The approver per service (docs/v2/milestone-2-plan.md, decision 24, lane
// 18): a `human:<user>` service is approved by that user only. The owner's
// approval answers 403 naming the user, before anything is held; that
// user's approval is held, then signed for that user, and the service's
// lock, which trusts that user ([tracker] owner_id of its agents.conf),
// reads it as agreed: v1's tracker.ts is the oracle. A ticket whose
// services name two different approvers cannot be approved in one gesture.
// A one-service workspace's lock is the one the service's environment
// names, so its owner_id must be that user, or the approval is refused as
// not set up, rather than signed for a move the lock would refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type ServiceSensitivity } from '../../src/api/types.ts';
import { createApprovalRoutes } from '../../src/approval/route.ts';
import { approverGate, approverOf, serviceLocks, TrainApprovals, type Environment } from '../../src/approval/service.ts';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { defaultRegistry, dispatch, type App } from '../../src/modules/registry.ts';
import { TrainStore, type Stop } from '../../src/release/store.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { OWNER, scratch } from './harness.ts';
import { PROOF, head, service } from './support.ts';

const svc = (name: string, state: string, sensitivity: ServiceSensitivity, consumes: string[] = []): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity, consumes, run: null, contract: null, brokerSocket: join(state, 'release.sock'), brokerState: state,
});

type Serve = (call: (path: string, body: unknown, user?: string) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>;

async function serve(app: App, run: Serve): Promise<void> {
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

// The lock's settings of a service that trusts `owner`: the box's, with its owner_id.
function trusting(s: Awaited<ReturnType<typeof service>>, owner: string): string {
  const file = join(s.box.dir, `agents-${owner}.conf`);
  writeFileSync(file, readFileSync(s.box.confFile, 'utf8').replace(`owner_id = ${OWNER}`, `owner_id = ${owner}`));
  return file;
}

// A train of two services, each with its own validations record, as lane 16's tests make it.
async function train(sensitivity: { guestbook: ServiceSensitivity; filter: ServiceSensitivity }) {
  const s = await service();
  const second = scratch('cleared-v2-sensitive-');
  const workspace: WorkspaceConfig = { id: 'guestbook', name: 'Guestbook', file: '/etc/ws.conf', services: [svc('guestbook', second, sensitivity.guestbook, ['filter-api']), svc('filter-api', s.box.state, sensitivity.filter)] };
  s.db.exec(INBOX_TABLE);
  const ticket = await s.waiting();
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
  const item = new InboxStore(s.db, s.now).addRelease({
    ticket: ticket.id, project: 'guestbook', title: ticket.title, announcement: 'Held for review', requestedAt: filterAt,
    pr: { number: 7, url: stops[0]!.pr.url, checks: 'passed' }, heads: stops.map((x) => ({ pr: 7, head: x.head })),
    captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
  });
  const trains = new TrainStore(s.db, s.now);
  trains.add({ item: item.id, ticket: ticket.id, project: 'guestbook', state: 'waiting', stops, compatibility: null, blocked: null, announcement: 'Held for review' });
  const environment: Environment = {
    ...s.parts, conf: { ownerId: OWNER, publicKey: s.box.keys.publicKey, states: s.store.states } as Environment['conf'],
    signer: ApprovalSigner.load(s.box.keyFile), stateDir: s.box.state, users: s.users, proof: PROOF,
  };
  const locks = serviceLocks(s.db, workspace, { env: s.box.env, environment, now: s.now });
  const approvals = new TrainApprovals({ db: s.db, workspace, locks, environment, env: s.box.env, timers: s.timers, now: s.now });
  // v1's oracle, with the lock's settings given: did the trusted human move this ticket to go, bound to this state folder's record?
  const moved = (state: string, conf: string) => s.box.run('tracker.ts', ['moved-by-owner', ticket.id, 'Ready to Ship'],
    { ORCH_STATE_DIR: state, CLEARED_STATE_DIR: state, ORCH_LEDGER: join(s.box.state, 'ledger.db'), ORCH_CONF: conf, CLEARED_CONF: conf }).status;
  const app: App = { registry: { ...defaultRegistry(), users: s.users, ticketStore: s.store, approvalWriter: s.writer }, tables: [], routes: createApprovalRoutes(() => approvals) };
  const shown = { requestedAt: filterAt, heads: [{ pr: 7, head: head('a') }, { pr: 7, head: head('b') }] };
  return { s, ticket, item, trains, workspace, second, guestbookAt, locks, moved, app, shown };
}

test('the approver of a service: the user its human sensitivity names, else the lock\'s owner', () => {
  assert.equal(approverOf({ sensitivity: 'human:alice' }, OWNER), 'alice');
  assert.equal(approverOf({ sensitivity: 'normal' }, OWNER), OWNER);
  assert.equal(approverOf({ sensitivity: 'full' }, OWNER), OWNER);
  assert.equal(approverOf({ sensitivity: 'reviewer:claude-opus-5-5' }, undefined), undefined);
});

test('a train of human:alice services: the owner\'s approval answers 403 naming alice, and holds nothing', async () => {
  const w = await train({ guestbook: 'human:alice', filter: 'human:alice' });
  await serve(w.app, async (call) => {
    const answer = await call(`/api/tickets/${w.ticket.id}/approve`, w.shown);
    assert.equal(answer.status, 403);
    assert.match(String(answer.body.error), /Only alice approves/);
    assert.match(String(answer.body.error), /human:alice/);
  });
  assert.equal(w.s.timers.pending.size, 0);
  assert.equal(w.trains.get(w.item.id)?.approver, null);
  assert.equal((await w.s.store.get(w.ticket.id))?.status, 'Needs Approval');
});

test('alice\'s approval of the train passes: each move is signed for alice, and each service\'s lock that trusts alice reads it', async () => {
  const w = await train({ guestbook: 'human:alice', filter: 'human:alice' });
  await serve(w.app, async (call) => {
    const answer = await call(`/api/tickets/${w.ticket.id}/approve`, w.shown, 'u-alice');
    assert.equal(answer.status, 202, JSON.stringify(answer.body));
    assert.equal(answer.body.by, 'u-alice');
  });
  assert.equal(w.trains.get(w.item.id)?.approver, 'u-alice');
  await w.s.timers.fire();
  assert.equal((await w.s.store.get(w.ticket.id))?.status, 'Ready to Ship');
  const alice = trusting(w.s, 'alice');
  assert.equal(w.moved(w.s.box.state, alice), 0, 'the filter API\'s lock, trusting alice, reads her move bound to its record');
  assert.equal(w.moved(w.s.box.state, w.s.box.confFile), 6, 'a lock that trusts the owner does not take it for the owner\'s');

  // The next service: the train signs for the approver it kept, bound to the guestbook's record.
  await w.s.store.move(w.ticket.id, 'Done', { kind: 'agents', id: 'cleared-v2' });
  await w.s.store.move(w.ticket.id, 'Needs Approval', { kind: 'agents', id: 'cleared-v2' });
  w.s.advance(1000);
  const guestbook = w.locks(w.workspace.services[0] as ServiceConfig);
  await guestbook.sign({ ticket: w.ticket.id, by: 'u-alice', requestedAt: w.guestbookAt, heads: [{ pr: 7, head: head('a') }] });
  assert.equal(w.moved(w.second, alice), 0, 'the guestbook\'s lock reads alice\'s move, bound to its record');
  await assert.rejects(guestbook.sign({ ticket: w.ticket.id, by: 'u-owner', requestedAt: w.guestbookAt, heads: [{ pr: 7, head: head('a') }] }), /owner/, 'never signed for anybody else');
});

test('Undo of alice\'s approval is alice\'s', async () => {
  const w = await train({ guestbook: 'human:alice', filter: 'human:alice' });
  await serve(w.app, async (call) => {
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, w.shown, 'u-alice')).status, 202);
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve/undo`, {}, 'u-owner')).status, 403);
    assert.deepEqual(await call(`/api/tickets/${w.ticket.id}/approve/undo`, {}, 'u-alice'), { status: 200, body: { undone: true } });
  });
  await w.s.timers.fire();
  assert.equal((await w.s.store.get(w.ticket.id))?.status, 'Needs Approval');
});

test('a train whose services name two approvers is refused for everyone, naming both', async () => {
  const w = await train({ guestbook: 'normal', filter: 'human:alice' });
  await serve(w.app, async (call) => {
    for (const user of ['u-owner', 'u-alice']) {
      const answer = await call(`/api/tickets/${w.ticket.id}/approve`, w.shown, user);
      assert.equal(answer.status, 409, user);
      assert.match(String(answer.body.error), /alice \(filter-api\)/);
      assert.match(String(answer.body.error), new RegExp(`${OWNER} \\(guestbook\\)`));
      assert.match(String(answer.body.error), /one approval cannot be both/);
    }
  });
  assert.equal(w.s.timers.pending.size, 0);
});

test('a train of normal services is the owner\'s, as before', async () => {
  const w = await train({ guestbook: 'full', filter: 'reviewer:claude-opus-5-5' });
  await serve(w.app, async (call) => {
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, w.shown, 'u-alice')).status, 403);
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, w.shown)).status, 202);
  });
});

// A one-service workspace: the registry's approval writer, the lock of the service's environment.
async function single(sensitivity: ServiceSensitivity, lockOwner: string) {
  const s = await service({ ownerId: lockOwner });
  const ticket = await s.waiting();
  const shown = s.ask([{ pr: 7, head: head('a') }]);
  const workspace: WorkspaceConfig = { id: 'guestbook', name: 'Guestbook', file: '/etc/ws.conf', services: [svc('guestbook', s.box.state, sensitivity)] };
  const app: App = {
    registry: { ...defaultRegistry(), users: s.users, ticketStore: s.store, approvalWriter: s.writer }, tables: [],
    routes: createApprovalRoutes(() => undefined, approverGate(() => ({ workspace, ownerId: lockOwner }))),
  };
  const moved = (conf: string) => s.box.run('tracker.ts', ['moved-by-owner', ticket.id, 'Ready to Ship'], { ORCH_LEDGER: join(s.box.state, 'ledger.db'), ORCH_CONF: conf, CLEARED_CONF: conf }).status;
  return { s, ticket, app, moved, body: { requestedAt: shown.requestedAt, heads: shown.heads } };
}

test('one service, human:alice, its lock trusting alice: the owner gets 403 naming alice, alice\'s approval passes', async () => {
  const w = await single('human:alice', 'alice');
  await serve(w.app, async (call) => {
    const refused = await call(`/api/tickets/${w.ticket.id}/approve`, w.body);
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /Only alice approves the release of guestbook/);
    assert.equal(w.s.timers.pending.size, 0);
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, w.body, 'u-alice')).status, 202);
  });
  await w.s.timers.fire();
  assert.equal(w.moved(trusting(w.s, 'alice')), 0, 'the lock reads alice\'s move');
});

test('one service, human:alice, its lock trusting someone else: refused as not set up, naming both, and nothing signed', async () => {
  const w = await single('human:alice', OWNER);
  await serve(w.app, async (call) => {
    for (const user of ['u-owner', 'u-alice']) {
      const answer = await call(`/api/tickets/${w.ticket.id}/approve`, w.body, user);
      assert.equal(answer.status, 503, user);
      assert.match(String(answer.body.error), /human:alice/);
      assert.match(String(answer.body.error), new RegExp(`owner_id = ${OWNER}`));
    }
  });
  assert.equal(w.s.timers.pending.size, 0);
});

test('one service that is not human: the gate changes nothing', async () => {
  const w = await single('full', OWNER);
  await serve(w.app, async (call) => {
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, w.body, 'u-alice')).status, 403);
    assert.equal((await call(`/api/tickets/${w.ticket.id}/approve`, w.body)).status, 202);
  });
});
