// The release train of a workspace of several services (docs/v2/milestone-2-plan.md,
// decision 21, lane 16), on the fake adapter with a fake lock per service:
// one pull request per service on the same branch, the review recorded and
// the approval asked on each service's own broker, the landing in order
// (providers first, the next one only after the last one's watch is
// healthy), the reverse rollback, and the card blocked before approval when
// a contract changes without its consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import type { MergeOutcome, ServiceLock } from '../../src/release/lock.ts';
import type { FlowEffects } from '../../src/flow/engine.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import type { ReleaseItem } from '../../src/api/types.ts';
import { TrainStore } from '../../src/release/store.ts';
import { ledgerRow, quickAuthor, releaseRow, setup, until, type Setup } from './support.ts';

const service = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: `/run/${name}/release.sock`, brokerState: `/state/${name}`, ...extra,
});

// The proof's workspace: the guestbook, first in the file, consumes the filter API.
const WORKSPACE: WorkspaceConfig = {
  id: 'guestbook', name: 'Guestbook and its filter', file: '/etc/cleared/workspace.conf',
  services: [service('guestbook', { consumes: ['filter-api'], brokerSocket: null, brokerState: null }), service('filter-api', { contract: { format: 'openapi', path: 'contract/openapi.yaml' } })],
};

const HEAD: Record<string, string> = { guestbook: 'a'.repeat(40), 'filter-api': 'b'.repeat(40) };

type Call = { readonly service: string; readonly what: string; readonly at: number; readonly detail?: unknown };

// A lock per service that records its calls, with the clock of the test.
// A merge writes merge-pr.sh's row and closes the ticket as merge-pr.sh does
// once every pull request its own record shows is merged: that service's one.
function locks(t: () => Setup, calls: Call[], options: { outcomes?: Record<string, MergeOutcome['outcome'][]>; drift?: string; rollback?: { ok: boolean; message: string } } = {}) {
  const made = new Map<string, ServiceLock>();
  return (svc: ServiceConfig): ServiceLock => {
    const known = made.get(svc.name);
    if (known) return known;
    const log = (what: string, detail?: unknown) => calls.push({ service: svc.name, what, at: t().clock.now, ...(detail === undefined ? {} : { detail }) });
    const lock: ServiceLock = {
      service: svc.name,
      async recordReview(review) { log('recordReview', { pr: review.pr, commit: review.commit, session: review.session, verdict: review.verdictPhrase }); },
      async ask(input) { log('ask', { pr: input.pr }); return { requestedAt: new Date(t().clock.now).toISOString() }; },
      check() { return options.drift === svc.name ? `the request to ${svc.name} was made again since` : undefined; },
      async sign(input) {
        if (options.drift === svc.name) throw new Error(`the request to ${svc.name} was made again since: review again`);
        log('sign', { heads: input.heads, by: input.by });
        await t().tickets.recordApproval(input.ticket, { kind: 'human', id: input.by });
      },
      async release(input) {
        const outcome = options.outcomes?.[svc.name]?.shift() ?? 'merged';
        log('release', { pr: input.pr, outcome });
        if (outcome === 'merged') {
          ledgerRow(t().store, { kind: 'merged_by_script', ticket: input.ticket, pr: input.pr, at: new Date(t().clock.now).toISOString() });
          await t().tickets.move(input.ticket, 'Done', { kind: 'agents', id: 'merge-pr' });
        }
        return { outcome, message: outcome === 'refused' ? 'the user has not agreed' : '' };
      },
      async rollback(input) { log('rollback', { ticket: input.ticket }); return options.rollback ?? { ok: true, message: 'reverted' }; },
    };
    made.set(svc.name, lock);
    return lock;
  };
}

const effects = (changed: Record<string, string[]>): Partial<FlowEffects> => ({
  async publish(input) {
    const name = input.service?.name ?? 'guestbook';
    // Both repositories number their pull request 7: the train keeps them apart by service.
    return { url: `https://example.invalid/${name}/pull/7`, number: 7, head: HEAD[name] as string, created: true };
  },
  async changes(input) {
    const files = changed[input.service?.name ?? 'guestbook'] ?? [];
    return { files, diff: files.map((file) => `diff --git a/${file} b/${file}\n`).join('') };
  },
});

async function train(options: { services?: string[]; changed?: Record<string, string[]>; outcomes?: Record<string, MergeOutcome['outcome'][]>; drift?: string; rollback?: { ok: boolean; message: string }; pages?: string[]; extra?: Partial<FlowEffects>; workdirRoot?: string } = {}) {
  const calls: Call[] = [];
  let t: Setup | undefined;
  const pages = options.pages;
  t = await setup({
    scripts: { author: quickAuthor }, config: { workspace: WORKSPACE, ...(options.workdirRoot ? { workdirRoot: options.workdirRoot } : {}) },
    effects: { ...effects(options.changed ?? { guestbook: ['src/page.ts'], 'filter-api': ['src/check.ts'] }), ...options.extra, ...(pages ? { async updateProjectPages(input: { ticket: string; pr: number }) { pages.push(`${input.ticket}:${input.pr}`); } } : {}) },
    locks: locks(() => t as Setup, calls, options),
  });
  const ticket = await t.tickets.create({ title: 'Held for review', body: 'An entry the filter flags is held for review instead of refused.', project: 'guestbook', services: options.services ?? ['guestbook', 'filter-api'] }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  await t.engine.settled();
  const item = () => t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release' && i.ticket === ticket.id) as ReleaseItem;
  const trains = new TrainStore(t.store.db);
  // What the approval route does for a train (approval/route.ts): the
  // approver is kept with the train, then the grace writes the owner's move.
  const approve = async () => {
    trains.setApprover(item().id, 'u1');
    t.clock.now += 60_000;
    await t.tickets.recordApproval(ticket.id, { kind: 'human', id: 'u1' });
    await tick(t, 1000);
  };
  return { t: t as Setup, ticket, calls, item, approve, trains };
}

async function tick(t: Setup, ms: number): Promise<void> {
  t.clock.now += ms;
  await t.engine.tick();
  await t.engine.settled();
}

const of = <K extends FlowEvent['type']>(t: Setup, type: K) => t.flowEvents.filter((e): e is Extract<FlowEvent, { type: K }> => e.type === type);
const iso = (ms: number) => new Date(ms).toISOString();
const healthy = (t: Setup, ticket: string, at: number) => {
  releaseRow(t.store, { ticket, pr: 7, status: 'complete', mergedAt: iso(at - 300_000), endedAt: iso(at), lastHealth: 'HTTP 200' });
  ledgerRow(t.store, { kind: 'release_watch_complete', ticket, pr: 7, at: iso(at), detail: 'HTTP 200' });
};

test('one pull request per service on the same branch, each recorded and asked on its own lock, providers first; the card is the train', async () => {
  const { t, ticket, calls, item } = await train();
  assert.deepEqual(calls.filter((c) => c.what === 'recordReview').map((c) => c.service), ['filter-api', 'guestbook']);
  const reviewed = calls.filter((c) => c.what === 'recordReview').map((c) => c.detail as { pr: number; commit: string; session: string; verdict: string });
  assert.deepEqual(reviewed.map((r) => [r.pr, r.commit, r.verdict]), [[7, HEAD['filter-api'], 'no blocking issues'], [7, HEAD.guestbook, 'no blocking issues']]);
  assert.notEqual(reviewed[0]?.session, reviewed[1]?.session, 'two pull requests #7 of two repositories get two review runs');
  assert.ok(reviewed.every((r) => /^[A-Za-z0-9_-]{1,64}$/.test(r.session)));
  assert.deepEqual(calls.filter((c) => c.what === 'ask').map((c) => c.service), ['filter-api', 'guestbook']);
  const card = item();
  assert.equal(card.state, 'waiting');
  assert.equal(card.pr.number, 7);
  assert.deepEqual(card.heads, [{ pr: 7, head: HEAD['filter-api'] }, { pr: 7, head: HEAD.guestbook }]);
  assert.equal(card.train?.state, 'waiting');
  assert.deepEqual(card.train?.services.map((s) => [s.service, s.pr?.url, s.head, s.state]), [
    ['filter-api', 'https://example.invalid/filter-api/pull/7', HEAD['filter-api'], 'waiting'],
    ['guestbook', 'https://example.invalid/guestbook/pull/7', HEAD.guestbook, 'waiting'],
  ]);
  assert.equal(card.train?.compatibility, 'guestbook consumes filter-api and is changed in this ticket.');
  assert.equal(card.train?.blocked, null);
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Needs Approval');
  assert.equal(t.calls.filter((c) => c.startsWith('requestRelease') || c.startsWith('mergeRelease')).length, 0, 'the one-service lock is never asked for a train');
  await t.engine.close();
});

test('a two-service ticket lands in order: the provider first, the consumer only once the provider\'s watch is healthy, each on its own lock', async () => {
  const { t, ticket, calls, item, approve } = await train();
  await approve();
  const approvedAt = t.clock.now;
  const releases = () => calls.filter((c) => c.what === 'release');
  assert.deepEqual(releases().map((c) => c.service), ['filter-api'], 'the provider is landed first');
  assert.equal(calls.filter((c) => c.what === 'sign').length, 0, 'the provider lands on the owner\'s own signed move');
  assert.equal(item().train?.state, 'landing');
  assert.equal(item().train?.services[0]?.state, 'merged');

  // Merged, the watch still runs: the consumer waits, and the ticket is not Done between the two landings.
  await tick(t, 60_000);
  await tick(t, 60_000);
  assert.deepEqual(releases().map((c) => c.service), ['filter-api']);
  assert.notEqual((await t.tickets.get(ticket.id))?.status, 'Done', 'not Done while a service is still to land');

  const providerHealthy = approvedAt + 400_000;
  healthy(t, ticket.id, providerHealthy);
  t.clock.now = providerHealthy;
  await tick(t, 30_000);
  await tick(t, 30_000);
  assert.deepEqual(releases().map((c) => c.service), ['filter-api', 'guestbook']);
  const consumer = releases()[1] as Call;
  assert.ok(consumer.at >= providerHealthy, 'the consumer is asked only after the provider\'s healthy verdict');
  const sign = calls.find((c) => c.what === 'sign') as Call;
  assert.equal(sign.service, 'guestbook');
  assert.deepEqual((sign.detail as { heads: unknown }).heads, [{ pr: 7, head: HEAD.guestbook }], 'the consumer\'s move is bound to exactly the head the card showed');
  assert.equal((sign.detail as { by: string }).by, 'u1');
  assert.ok(sign.at <= consumer.at);
  assert.deepEqual(item().train?.services.map((s) => s.state), ['healthy', 'merged']);

  const consumerHealthy = t.clock.now + 400_000;
  healthy(t, ticket.id, consumerHealthy);
  t.clock.now = consumerHealthy;
  await tick(t, 30_000);
  assert.equal(item().train?.state, 'landed');
  assert.deepEqual(item().train?.services.map((s) => [s.service, s.state]), [['filter-api', 'healthy'], ['guestbook', 'healthy']]);
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Done');
  assert.deepEqual(of(t, 'release_merged').map((e) => e.service), ['filter-api', 'guestbook']);
  assert.equal(of(t, 'release_landed').length, 1, 'the train lands once');
  assert.deepEqual(of(t, 'release_landed')[0]?.services, ['filter-api', 'guestbook']);
  const gap = Date.parse(item().train?.services[1]?.at as string) - Date.parse(item().train?.services[0]?.at as string);
  assert.ok(gap > 0, 'the consumer is healthy after the provider');

  const before = calls.length;
  await tick(t, 600_000);
  assert.equal(calls.length, before, 'a landed train asks nothing more');
  await t.engine.close();
});

test('each merge of a train makes the project pages again (issue #274, P103)', async () => {
  const pages: string[] = [];
  const { t, ticket, approve } = await train({ pages });
  await approve();
  await t.engine.settled();
  assert.equal(pages.length, of(t, 'release_merged').length, 'one call for each service merged');
  assert.ok(pages.length >= 1 && pages.every((p) => p.startsWith(`${ticket.id}:`)));
  await t.engine.close();
});

test('a merge a lock queues is asked again after the retry interval, on that lock only', async () => {
  const { t, calls, approve } = await train({ outcomes: { 'filter-api': ['queued', 'merged'] } });
  await approve();
  assert.deepEqual(calls.filter((c) => c.what === 'release').map((c) => (c.detail as { outcome: string }).outcome), ['queued']);
  await tick(t, 30_000);
  assert.equal(calls.filter((c) => c.what === 'release').length, 1, 'not before the interval');
  await tick(t, 30_000);
  assert.deepEqual(calls.filter((c) => c.what === 'release').map((c) => [c.service, (c.detail as { outcome: string }).outcome]), [['filter-api', 'queued'], ['filter-api', 'merged']]);
  await t.engine.close();
});

test('a failing watch on the consumer: its own rollback is read, then the provider is rolled back, newest first; the ticket is back in Todo, rolled_back said once', async () => {
  const { t, ticket, calls, item, approve } = await train();
  await approve();
  healthy(t, ticket.id, t.clock.now + 400_000);
  t.clock.now += 400_000;
  await tick(t, 30_000);
  await tick(t, 30_000);
  assert.deepEqual(calls.filter((c) => c.what === 'release').map((c) => c.service), ['filter-api', 'guestbook']);

  // The guestbook's watch fails twice and its auto rollback reverts its merge.
  const failing = t.clock.now + 60_000;
  ledgerRow(t.store, { kind: 'release_health_failing', ticket: ticket.id, pr: 7, at: iso(failing), detail: 'HTTP 500' });
  ledgerRow(t.store, { kind: 'rollback_pushed', ticket: ticket.id, pr: 7, at: iso(failing + 60_000), detail: 'reverted at abc1234' });
  t.clock.now = failing + 60_000;
  await tick(t, 30_000);
  assert.deepEqual(calls.filter((c) => c.what === 'rollback').map((c) => c.service), ['filter-api'], 'the train asks the provider\'s lock only: the consumer reverted itself');
  const card = item().train;
  assert.equal(card?.state, 'rolled_back');
  assert.deepEqual(card?.services.map((s) => [s.service, s.state]), [['filter-api', 'reverted'], ['guestbook', 'reverted']]);
  assert.ok(Date.parse(card?.services[1]?.at as string) <= Date.parse(card?.services[0]?.at as string), 'the consumer was reverted before the provider');
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Todo');
  const notes = (await t.tickets.comments(ticket.id)).map((c) => c.body);
  assert.ok(notes.some((n) => /rolled back/.test(n) && /guestbook/.test(n) && /filter-api/.test(n)), notes.join('\n'));
  assert.equal(of(t, 'rolled_back').length, 1, 'once for the train');
  assert.equal(of(t, 'rolled_back')[0]?.service, 'guestbook');
  assert.deepEqual(of(t, 'ticket_put_back').map((e) => e.reason), ['rolled_back']);
  await tick(t, 600_000);
  assert.equal(calls.filter((c) => c.what === 'rollback').length, 1);
  assert.equal(of(t, 'rolled_back').length, 1);
  await t.engine.close();
});

test('a provider the lock refuses to roll back stays live and the card says so; the train still ends rolled back', async () => {
  const { t, ticket, item, approve } = await train({ rollback: { ok: false, message: 'This release was already rolled back' } });
  await approve();
  healthy(t, ticket.id, t.clock.now + 400_000);
  t.clock.now += 400_000;
  await tick(t, 30_000);
  await tick(t, 30_000);
  ledgerRow(t.store, { kind: 'rollback_pushed', ticket: ticket.id, pr: 7, at: iso(t.clock.now + 60_000), detail: 'reverted' });
  t.clock.now += 60_000;
  await tick(t, 30_000);
  const stops = item().train?.services ?? [];
  assert.equal(item().train?.state, 'rolled_back');
  assert.deepEqual(stops.map((s) => s.state), ['healthy', 'reverted']);
  assert.match(stops[0]?.note ?? '', /could not be rolled back: This release was already rolled back/);
  const notes = (await t.tickets.comments(ticket.id)).map((c) => c.body).join('\n');
  assert.match(notes, /filter-api is still live/);
  await t.engine.close();
});

test('a contract changed with no step on its consumer blocks the card before approval, with the proposal; nothing lands', async () => {
  const { t, ticket, calls, item } = await train({ services: ['filter-api'], changed: { 'filter-api': ['contract/openapi.yaml', 'src/check.ts'] } });
  const card = item();
  assert.equal(card.train?.state, 'blocked');
  assert.match(card.train?.blocked?.reason ?? '', /guestbook, which consumes it, is not changed/);
  assert.match(card.train?.blocked?.proposal ?? '', /Extend the contract/);
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Needs Approval', 'asked, so the owner sees it and can send it back');
  // Even a move to go written by hand lands nothing while the train is blocked.
  await t.tickets.recordApproval(ticket.id, { kind: 'human', id: 'u1' });
  await tick(t, 120_000);
  assert.equal(calls.filter((c) => c.what === 'release').length, 0);
  await t.engine.close();
});

test('a head that changed on a later service since the card was shown: nothing is signed for it, the train halts, the ticket is put back with the reason', async () => {
  const { t, ticket, calls, item, approve } = await train({ drift: 'guestbook' });
  await approve();
  healthy(t, ticket.id, t.clock.now + 400_000);
  t.clock.now += 400_000;
  await tick(t, 30_000);
  await tick(t, 30_000);
  assert.equal(calls.filter((c) => c.what === 'sign').length, 0);
  assert.deepEqual(calls.filter((c) => c.what === 'release').map((c) => c.service), ['filter-api']);
  assert.equal(item().train?.state, 'halted');
  assert.match(item().train?.services[1]?.note ?? '', /made again since/);
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Todo');
  assert.deepEqual(of(t, 'ticket_put_back').map((e) => e.reason), ['train_halted']);
  assert.match(of(t, 'ticket_put_back')[0]?.note ?? '', /filter-api is live/);
  await t.engine.close();
});

test('a ticket of the workspace that names no service is on its first service, alone in its train', async () => {
  const { t, calls, item } = await train({ services: [], changed: { guestbook: ['src/page.ts'] } });
  assert.deepEqual(item().train?.services.map((s) => s.service), ['guestbook']);
  assert.deepEqual(calls.filter((c) => c.what === 'ask').map((c) => c.service), ['guestbook']);
  await t.engine.close();
});

test('the author works in the checkout of its first service, and every service of the ticket gets its checkout under <workdirs>/<ticket>/<service>', async () => {
  const prepared: { role: string; service?: string }[] = [];
  const calls: Call[] = [];
  let t: Setup | undefined;
  t = await setup({
    scripts: { author: quickAuthor }, config: { workspace: WORKSPACE },
    effects: {
      ...effects({ guestbook: ['src/page.ts'], 'filter-api': ['src/check.ts'] }),
      async prepareWorkdir({ ticket, role, service: svc }) {
        prepared.push({ role, ...(svc ? { service: svc.name } : {}) });
        return { workdir: `/work/${ticket.id}${svc ? `/${svc.name}` : ''}`, briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
    },
    locks: locks(() => t as Setup, calls),
  });
  const ticket = await t.tickets.create({ title: 'Held', body: 'b', project: 'guestbook', services: ['guestbook', 'filter-api'] }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t!.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  assert.deepEqual(prepared.filter((p) => p.role === 'author'), [{ role: 'author', service: 'guestbook' }, { role: 'author', service: 'filter-api' }]);
  assert.equal(t.startedSessions[0]?.input.workdir, `/work/${ticket.id}/guestbook`);
  await t.engine.close();
});

test('a merge its lock made while the last process stopped is read from the ledger: the lock is not asked again', async () => {
  const { t, ticket, calls, item, approve, trains } = await train({ outcomes: { 'filter-api': ['queued'] } });
  await approve();
  assert.deepEqual(calls.filter((c) => c.what === 'release').map((c) => c.service), ['filter-api']);
  // The lock merged it in the meantime (the call that queued it went on, or a process died during the call).
  ledgerRow(t.store, { kind: 'merged_by_script', ticket: ticket.id, pr: 7, at: iso(t.clock.now + 5_000) });
  await tick(t, 60_000);
  assert.equal(calls.filter((c) => c.what === 'release').length, 1, 'not asked again');
  assert.equal(item().train?.services[0]?.state, 'merged');
  assert.equal(trains.get(item().id)?.stops[0]?.mergedAt, iso(t.clock.now - 60_000 + 5_000));
  assert.deepEqual(of(t, 'release_merged').map((e) => e.service), ['filter-api']);
  await t.engine.close();
});

test('what a provider with an untouched consumer changes cannot be read: the card is blocked, not taken as compatible', async () => {
  const calls: Call[] = [];
  let t: Setup | undefined;
  t = await setup({
    scripts: { author: quickAuthor }, config: { workspace: WORKSPACE },
    effects: { ...effects({}), async changes() { throw new Error('git diff failed'); } },
    locks: locks(() => t as Setup, calls),
  });
  const ticket = await t.tickets.create({ title: 'Held', body: 'b', project: 'guestbook', services: ['filter-api'] }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t!.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  const card = t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release' && i.ticket === ticket.id) as ReleaseItem;
  assert.equal(card.train?.state, 'blocked');
  assert.match(card.train?.blocked?.reason ?? '', /on filter-api could not be read/);
  await t.engine.close();
});

test('a train ticket\'s sessions name their service, and the session JSON answers the service and the preview key its row holds', async () => {
  const { t } = await train();
  const author = t.startedSessions.find((s) => s.input.role === 'author');
  const reviewer = t.startedSessions.find((s) => s.input.role === 'reviewer');
  assert.equal(author?.input.service, 'guestbook', 'the first service the ticket names');
  assert.equal(reviewer?.input.service, 'guestbook');
  // What lane 15's runtime stores when the session's containers start.
  const row = t.store.sessions.get(author!.id)!;
  t.store.sessions.put({ ...row, service: 'guestbook', previewKey: 'k'.repeat(43) });
  const detail = t.engine.sessionDetail(author!.id);
  assert.equal(detail?.service, 'guestbook');
  assert.equal(detail?.previewKey, 'k'.repeat(43));
  await t.engine.close();
});

test('a one-service ticket\'s session names no service of its own, and its JSON has no service or preview key while its row holds none', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  assert.equal('service' in author.input, false);
  const detail = t.engine.sessionDetail(author.id);
  assert.equal(detail && 'service' in detail, false);
  assert.equal(detail && 'previewKey' in detail, false);
  await t.engine.close();
});

test('a ticket published again halts its older train: one approval never lands two trains', async () => {
  const { t, ticket, calls, item, trains } = await train();
  const first = item();
  // Sent back from the inbox and started again before any tick saw it out of the validate state.
  await t.tickets.move(ticket.id, 'Todo', { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  t.clock.now += 1000;
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id && i.id !== first.id && i.state === 'waiting'), 'the second release item', 5000);
  await t.engine.settled();
  assert.equal(trains.get(first.id)?.state, 'halted', 'the older train is over');
  const second = item();
  trains.setApprover(second.id, 'u1');
  t.clock.now += 60_000;
  await t.tickets.recordApproval(ticket.id, { kind: 'human', id: 'u1' });
  await tick(t, 1000);
  await tick(t, 1000);
  assert.deepEqual(calls.filter((c) => c.what === 'release').map((c) => c.service), ['filter-api'], 'the new train alone lands');
  await t.engine.close();
});

test('a Close closes the pull request of each service of the train, each on its own repository, and the ticket is closed even if one fails', async () => {
  const seen: string[] = [];
  const { t, ticket } = await train({
    extra: {
      async closePullRequest(request) {
        seen.push(`${request.service?.name}#${request.pr}:${request.reason}`);
        if (request.service?.name === 'guestbook') throw new Error('gh pr close failed');
        return 'closed';
      },
    },
  });
  await t.engine.closeTicket(ticket.id, 'Not needed any more.', 'u1');
  assert.deepEqual(seen.sort(), ['filter-api#7:Not needed any more.', 'guestbook#7:Not needed any more.']);
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Todo');
  const last = (await t.tickets.comments(ticket.id)).at(-1)?.body ?? '';
  assert.match(last, /guestbook/);
  assert.match(last, /not closed on GitHub/);
});

test('a landed train: the production page of each service that configures one is captured once the last watch is healthy (P218)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleared-v2-train-production-'));
  const captured: { url: string; dir: string; at: number }[] = [];
  const PAGES: Record<string, string> = { guestbook: 'https://guestbook.example.invalid/', 'filter-api': 'https://filter.example.invalid/status' };
  try {
    const { t, ticket, approve } = await train({
      workdirRoot: root,
      extra: {
        async settings(svc) { return { verdict: 'no blocking issues', safeCommands: [], hosts: [], services: [], scripts: [], productionUrl: PAGES[svc?.name ?? 'guestbook'] as string }; },
        async captureProduction(input) { captured.push({ ...input, at: t.clock.now }); return { file: 'production.png' }; },
      },
    });
    await approve();
    const providerHealthy = t.clock.now + 400_000;
    healthy(t, ticket.id, providerHealthy);
    t.clock.now = providerHealthy;
    await tick(t, 30_000);
    await tick(t, 30_000);
    assert.deepEqual(captured, [], 'nothing before the train has landed');
    const consumerHealthy = t.clock.now + 400_000;
    healthy(t, ticket.id, consumerHealthy);
    t.clock.now = consumerHealthy;
    await tick(t, 30_000);
    assert.equal((await t.tickets.get(ticket.id))?.status, 'Done');
    assert.deepEqual(captured.map((c) => [c.url, c.dir]).sort(), [
      [PAGES['filter-api'], join(root, '.proof', ticket.id, 'filter-api')],
      [PAGES.guestbook, join(root, '.proof', ticket.id, 'guestbook')],
    ]);
    assert.deepEqual((await t.engine.productionChecks(ticket.id)).map((c) => [c.service, c.url, c.file]), [
      ['guestbook', 'https://guestbook.example.invalid/', 'production.png'],
      ['filter-api', 'https://filter.example.invalid/status', 'production.png'],
    ], 'in the workspace\'s order');
    await tick(t, 600_000);
    assert.equal(captured.length, 2);
    await t.engine.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
