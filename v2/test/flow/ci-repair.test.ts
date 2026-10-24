// The repair of a pull request's failed checks (issue #273), on the fake
// adapter with a simulated CI (support.ts simulatedCi): a failure on the
// card's head reopens the author on the ticket branch, the fix goes through
// the review and is published to the same pull request, never forced and
// never on the base branch; at most two attempts, each said on the card in
// the inbox, on the ticket and on the bus. Nothing reaches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseItem } from '../../src/api/types.ts';
import { FlowEngine } from '../../src/flow/engine.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import { failedChecks, jobOf, logTail, onBase, repairMessage } from '../../src/flow/ci-repair.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { quickAuthor, setup, simulatedCi, until, type Setup, type SetupOptions } from './support.ts';

const MINUTE = 61_000;

const releases = (t: Setup) => t.inbox.list().filter((i): i is ReleaseItem => i.kind === 'release').sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
const waitingCard = (t: Setup) => releases(t).find((i) => i.state === 'waiting');
const repairs = (t: Setup) => t.flowEvents.filter((e): e is Extract<FlowEvent, { type: 'ci_repair' }> => e.type === 'ci_repair');
const userTexts = (t: Setup, session: string) => t.store.events.after(session).flatMap(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT' && event.messageId.includes('-user-') ? [event.delta] : []);

async function released(results: Parameters<typeof simulatedCi>[0], options: SetupOptions & { stale?: number } = {}) {
  const ci = simulatedCi(results, options.stale === undefined ? {} : { stale: options.stale });
  const t = await setup({ scripts: { author: quickAuthor }, ...options, effects: { ...ci.effects, ...options.effects } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => waitingCard(t) !== undefined, 'the release card', 5000);
  await t.engine.settled();
  return { t, ci };
}

// One reading of the checks a minute later, and what it started.
async function minute(t: Setup, engine: FlowEngine = t.engine): Promise<void> {
  t.clock.now += MINUTE;
  await engine.tick();
  await engine.settled();
}

// The card a repair publishes, once its author and its review are done.
async function nextCard(t: Setup, after: number, engine: FlowEngine = t.engine): Promise<ReleaseItem> {
  await until(() => releases(t).filter((i) => i.state === 'waiting').length === 1 && releases(t).length > after, 'the next release card', 5000);
  await engine.settled();
  return waitingCard(t) as ReleaseItem;
}

test('a failed check reopens the author on the ticket branch; the fix is reviewed, published to the same pull request, and the card says it is repaired', async () => {
  const { t, ci } = await released(['failed', 'passed']);
  const first = waitingCard(t) as ReleaseItem;
  assert.equal(first.repair, undefined);
  const author = t.startedSessions[0]!.id;

  await minute(t);
  const handled = releases(t)[0] as ReleaseItem;
  assert.equal(handled.id, first.id);
  assert.equal(handled.state, 'handled', 'the red head can no longer be approved');
  assert.deepEqual({ ...handled.repair, at: undefined }, { attempt: 1, limit: 2, state: 'started', checks: ['test'], at: undefined });

  const card = await nextCard(t, 1);
  assert.notEqual(card.id, first.id);
  assert.deepEqual({ ...card.repair, at: undefined }, { attempt: 1, limit: 2, state: 'pushed', checks: ['test'], at: undefined });
  assert.equal(card.pr.checks, 'pending');
  assert.deepEqual(card.heads, [{ pr: 7, head: ci.heads[1] }], 'the approval is bound to the repair\'s commit');
  // The same author was resumed and told what failed, as data; a new reviewer read the fix.
  assert.deepEqual(t.startedSessions.map((s) => s.input.role), ['author', 'reviewer', 'reviewer']);
  const told = userTexts(t, author).at(-1) ?? '';
  assert.match(told, /checks of pull request #7 failed on the branch cleared\/LOCAL-1/);
  assert.match(told, /repair attempt 1 of 2/);
  assert.match(told, /do not skip, delete or weaken the failing check/);
  assert.match(told, /--- BEGIN FAILED CHECK: test ---\npush 1: expected 2 to equal 3\n--- END FAILED CHECK: test ---/);
  // Its review counts its own rounds: round 1, not the original flow's.
  assert.deepEqual(t.flowEvents.filter((e) => e.type === 'review_verdict').map((e) => (e as { round: number }).round), [1, 1]);
  // Pushed twice to the ticket branch, the pull request reused, never the base.
  assert.deepEqual(ci.pushes.map((p) => [p.branch, p.created]), [['cleared/LOCAL-1', true], ['cleared/LOCAL-1', false]]);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Needs Approval');

  await minute(t);
  const after = waitingCard(t) as ReleaseItem;
  assert.equal(after.id, card.id);
  assert.equal(after.pr.checks, 'passed');
  assert.equal(after.repair?.state, 'repaired');
  assert.deepEqual(repairs(t).map((e) => [e.state, e.attempt, e.limit, e.pr]), [['started', 1, 2, 7], ['pushed', 1, 2, 7], ['repaired', 1, 2, 7]]);
  const comments = (await t.tickets.comments(t.ticket.id)).map((c) => c.body);
  assert.ok(comments.includes('The checks of pull request #7 failed: test. Repair attempt 1 of 2 started on the ticket branch.'));
  assert.ok(comments.includes('The checks of pull request #7 pass after repair attempt 1 of 2.'));
  await t.engine.close();
});

test('at most two attempts: checks still red after the second, the card says so and nothing more starts; a job run again green says repaired', async () => {
  const results: ('failed' | 'passed')[] = ['failed', 'failed', 'failed'];
  const { t, ci } = await released(results);
  await minute(t);
  await nextCard(t, 1);
  await minute(t);
  const second = await nextCard(t, 2);
  assert.equal(second.repair?.attempt, 2);
  assert.equal(second.repair?.state, 'pushed');
  const author = t.startedSessions[0]!.id;
  assert.match(userTexts(t, author).at(-1) ?? '', /repair attempt 2 of 2[\s\S]*push 2: expected 2 to equal 3/);

  await minute(t);
  const card = waitingCard(t) as ReleaseItem;
  assert.equal(card.id, second.id, 'the last card stays for the owner');
  assert.equal(card.pr.checks, 'failed');
  assert.deepEqual({ ...card.repair, at: undefined }, { attempt: 2, limit: 2, state: 'gave_up', checks: ['test'], at: undefined });
  await minute(t);
  await minute(t);
  assert.equal(ci.pushes.length, 3, 'one push for the ticket, one per attempt');
  assert.equal(t.startedSessions.length, 4, 'no session after the second attempt');
  assert.deepEqual(repairs(t).map((e) => e.state), ['started', 'pushed', 'started', 'pushed', 'gave_up']);
  assert.ok((await t.tickets.comments(t.ticket.id)).some((c) => c.body === 'The checks of pull request #7 still fail after 2 repair attempts: test. Nothing more is tried: the owner decides.'));
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Needs Approval');
  // The owner runs the flaky job again on the forge: the same head turns green.
  results[2] = 'passed';
  await minute(t);
  assert.equal(waitingCard(t)?.pr.checks, 'passed');
  assert.deepEqual({ ...waitingCard(t)?.repair, at: undefined }, { attempt: 2, limit: 2, state: 'repaired', checks: ['test'], at: undefined });
  assert.equal(ci.pushes.length, 3);
  await t.engine.close();
});

test('a failure read on the last head, before the forge saw the push, starts nothing', async () => {
  const { t, ci } = await released(['failed', 'failed'], { stale: 1 });
  await minute(t);
  const card = await nextCard(t, 1);
  await minute(t);
  assert.equal(ci.reads.at(-1), ci.heads[0], 'the forge still reported the first head');
  assert.equal(waitingCard(t)?.id, card.id);
  assert.equal(waitingCard(t)?.repair?.state, 'pushed');
  assert.deepEqual(repairs(t).map((e) => e.state), ['started', 'pushed']);
  await minute(t);
  assert.equal(ci.reads.at(-1), ci.heads[1]);
  await nextCard(t, 2);
  assert.equal(waitingCard(t)?.repair?.attempt, 2);
  await t.engine.close();
});

test('the attempts hold across a restart: the card carries them, and a new author is told what failed', async () => {
  const { t, ci } = await released(['failed', 'failed', 'failed']);
  await minute(t);
  await nextCard(t, 1);
  await t.engine.close();
  const engine = new FlowEngine(t.deps);
  engine.subscribe((event) => { t.flowEvents.push(event); });
  await minute(t, engine);
  const card = await nextCard(t, 2, engine);
  assert.equal(card.repair?.attempt, 2);
  // The new engine cannot resume the old author: a new one is started, its prompt the ticket and the failure.
  const fresh = t.startedSessions.at(-2)!;
  assert.equal(fresh.input.role, 'author');
  assert.match(fresh.input.prompt, /Ticket LOCAL-1[\s\S]*repair attempt 2 of 2[\s\S]*push 2: expected 2 to equal 3/);
  await minute(t, engine);
  assert.equal(waitingCard(t)?.repair?.state, 'gave_up');
  assert.equal(ci.pushes.length, 3);
  await engine.close();
});

test('never on the base branch: a ticket branch that is the base is not repaired, said once', async () => {
  const { t, ci } = await released(['failed'], { config: { base: 'cleared/LOCAL-1' } });
  await minute(t);
  await minute(t);
  const card = waitingCard(t) as ReleaseItem;
  assert.equal(card.state, 'waiting');
  assert.deepEqual({ ...card.repair, at: undefined }, { attempt: 0, limit: 2, state: 'refused', checks: ['test'], at: undefined });
  assert.equal(t.startedSessions.length, 2, 'no session was started');
  assert.equal(ci.pushes.length, 1);
  assert.deepEqual(repairs(t).map((e) => e.state), ['refused']);
  assert.equal(onBase('main', 'v2'), true, 'main is never a repair\'s branch, whatever the base');
  assert.equal(onBase('cleared/LOCAL-1', 'main'), false);
  await t.engine.close();
});

test('green or pending checks start nothing, and a check that cannot be read waits for the next minute', async () => {
  const { t } = await released(['passed']);
  await minute(t);
  assert.equal(waitingCard(t)?.repair, undefined);
  let fails = true;
  const red = await released(['failed'], { effects: { async ciFailures() { if (fails) throw new Error('gh is down'); return { head: '1'.padStart(40, '0'), checks: [{ name: 'lint', url: null, log: null }] }; } } });
  await minute(red.t);
  assert.equal(waitingCard(red.t)?.repair, undefined);
  assert.equal(red.t.startedSessions.length, 2);
  fails = false;
  await minute(red.t);
  await nextCard(red.t, 1);
  assert.match(userTexts(red.t, red.t.startedSessions[0]!.id).at(-1) ?? '', /--- BEGIN FAILED CHECK: lint ---\n\(no log could be read\)/);
  await t.engine.close();
  await red.t.engine.close();
});

test('the logs reach the author cleaned', async () => {
  const { t } = await released(['failed'], {
    clean: (text) => text.replaceAll('ghp_secret', '[redacted]'),
    effects: { async ciFailures() { return { head: '1'.padStart(40, '0'), checks: [{ name: 'test', url: null, log: 'token ghp_secret leaked' }] }; } },
  });
  await minute(t);
  await nextCard(t, 1);
  const told = userTexts(t, t.startedSessions[0]!.id).at(-1) ?? '';
  assert.match(told, /token \[redacted\] leaked/);
  assert.doesNotMatch(told, /ghp_secret/);
  await t.engine.close();
});

// A workspace of two services: its release is a train, which is not repaired.
const service = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, ...extra,
});
const WORKSPACE: WorkspaceConfig = {
  id: 'guestbook', name: 'Guestbook and its filter', file: '/etc/cleared/workspace.conf',
  services: [service('guestbook', { consumes: ['filter-api'] }), service('filter-api')],
};

test('a train whose checks fail is not repaired', async () => {
  const t = await setup({
    scripts: { author: quickAuthor }, config: { workspace: WORKSPACE },
    effects: {
      async publish(input) { return { url: `https://example.invalid/${input.service?.name}/pull/7`, number: 7, head: 'a'.repeat(40), created: true }; },
      async prChecks() { return 'failed'; },
      async ciFailures() { return { head: 'a'.repeat(40), checks: [{ name: 'test', url: null, log: null }] }; },
    },
    locks: (svc) => ({
      service: svc.name, async recordReview() {}, async ask() { return { requestedAt: new Date(t.clock.now).toISOString() }; }, check() { return undefined; },
      async sign() {}, async release() { return { outcome: 'queued', message: '' }; }, async rollback() { return { ok: true, message: '' }; },
    }),
  });
  const ticket = await t.tickets.create({ title: 'Held for review', body: 'Both services.', project: 'guestbook', services: ['guestbook', 'filter-api'] }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => waitingCard(t) !== undefined, 'the train card', 5000);
  await t.engine.settled();
  await minute(t);
  await minute(t);
  const card = waitingCard(t) as ReleaseItem;
  assert.ok(card.train);
  assert.equal(card.pr.checks, 'failed');
  assert.equal(card.repair, undefined);
  assert.equal(repairs(t).length, 0);
  assert.equal(t.startedSessions.length, 2);
  await t.engine.close();
});

// The forge's answers, in the shapes gh gives them; no call is made.
test('the failed checks and their job are read from gh pr view, a shape gh does not give is an error', () => {
  const head = 'c'.repeat(40);
  const read = failedChecks({
    headRefOid: head,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/11/job/22' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/11/job/23' },
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: '' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'ERROR', targetUrl: 'https://example.invalid/preview' },
    ],
  });
  assert.equal(read.head, head);
  assert.deepEqual(read.checks.map((c) => [c.name, c.url]), [['test', 'https://github.com/o/r/actions/runs/11/job/22'], ['build', null], ['deploy/preview', 'https://example.invalid/preview']]);
  assert.equal(jobOf(read.checks[0]!.url), '22');
  assert.equal(jobOf('https://example.invalid/preview'), undefined);
  assert.equal(jobOf(null), undefined);
  assert.throws(() => failedChecks({ statusCheckRollup: [] }), /no head/);
  assert.throws(() => failedChecks({ headRefOid: head }), /no head/);
  assert.throws(() => failedChecks(null), /no head/);
});

test('a log is cut to its end, and the message says when the forge named no check', () => {
  const log = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\r\n');
  const tail = logTail(log, 3);
  assert.equal(tail, 'line 98\nline 99\nline 100');
  assert.equal(logTail('x'.repeat(500), 5, 10), `${'x'.repeat(10)}…`);
  const message = repairMessage({ repair: { attempt: 1, limit: 2, state: 'started', checks: [], at: '' }, pr: 7, branch: 'cleared/LOCAL-1' });
  assert.match(message, /did not say which checks failed/);
  assert.doesNotMatch(message, /BEGIN FAILED CHECK/);
});
