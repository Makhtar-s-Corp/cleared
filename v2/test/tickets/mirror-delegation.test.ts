// A delegation in the mirror's pass (C3, P243, docs/v2/mirrors.md): a
// person hands an issue over on a tracker, the mirror makes it a ticket
// once, whatever its age, and hands that ticket to the lead's plans; an
// agent's delegation does nothing, and nothing is lost while the lead is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { TicketId } from '../../src/tickets/contract.ts';
import { Mirror, MirrorConfigError, loadMirrorConfig, type DelegationOutcome, type DelegationRequest } from '../../src/tickets/mirror.ts';
import { Clock, HUMAN, MemoryTracker, openStore } from './mirror-support.ts';

const PROJECT = 'guestbook';

// The plans as the mirror sees them: each request recorded, and the
// outcome a test gives, a plan by default.
function setup(options: { language?: 'fr' | 'en'; outcome?: (request: DelegationRequest, n: number) => DelegationOutcome | undefined; delegation?: boolean } = {}) {
  const clock = new Clock();
  const { db, store } = openStore(clock);
  const tracker = new MemoryTracker(clock);
  const requests: DelegationRequest[] = [];
  const logs: string[] = [];
  const outcome = options.outcome ?? ((_request, n) => ({ plan: `plan-${n}` }));
  const mirror = new Mirror({
    db, tickets: store, trackers: [tracker], project: PROJECT, services: [], language: options.language ?? 'fr', now: clock.now, log: (line) => logs.push(line),
    ...(options.delegation === false ? {} : { delegate: async (request: DelegationRequest) => { requests.push(request); return outcome(request, requests.length); } }),
  });
  return { clock, db, store, tracker, mirror, requests, logs };
}

function ticketOf(db: DatabaseSync, issue: string): TicketId {
  const row = db.prepare('SELECT ticket FROM mirror_links WHERE issue = ?').get(issue) as { ticket: string } | undefined;
  assert.ok(row, `${issue} is linked`);
  return row.ticket as TicketId;
}

test('an issue older than the first pass, handed over by a person after it, becomes a ticket and goes to the plans once; the issue says so', async () => {
  const s = setup();
  const issue = s.tracker.open({ title: 'Sort the entries', body: 'Newest first, please.', labels: ['ui'], status: 'Todo' });
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(await s.store.list(), [], 'an older issue, not handed over, stays out');

  s.clock.tick();
  s.tracker.delegate(issue.id, 'person', 'jane');
  s.clock.tick();
  await s.mirror.pass();
  const ticket = ticketOf(s.db, issue.id);
  const made = await s.store.get(ticket);
  assert.deepEqual([made?.title, made?.body, made?.labels, made?.status], ['Sort the entries', 'Newest first, please.', ['ui'], 'Todo']);
  assert.equal(s.requests.length, 1);
  assert.deepEqual({ ...s.requests[0], ticket: s.requests[0]?.ticket.id }, { ticket, tracker: 'Linear', key: issue.key, url: issue.url, who: 'jane' });
  const said = s.tracker.comments(issue.id);
  assert.equal(said.length, 1);
  assert.match(said[0] as string, new RegExp(`^jane a confié ce ticket à Cleared\\u00a0: c'est ${ticket}\\. Le plan plan-1 attend l'accord du propriétaire dans Cleared`));

  s.clock.tick(60);
  await s.mirror.pass();
  s.clock.tick(60);
  await s.mirror.pass();
  assert.equal(s.requests.length, 1, 'once');
  assert.equal(s.tracker.comments(issue.id).length, 1);
  assert.equal((await s.store.list()).length, 1);
  assert.deepEqual(await s.store.comments(ticket), [], 'the mirror\'s own comment does not come back');
});

test('a delegation made before the tracker\'s first pass is left alone', async () => {
  const s = setup();
  const issue = s.tracker.open({ title: 'Old hand-over', status: 'Todo' });
  s.tracker.delegate(issue.id);
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(await s.store.list(), []);
  assert.equal(s.requests.length, 0);
});

test('an agent\'s delegation does nothing: no ticket, no plan, no comment', async () => {
  const s = setup();
  const older = s.tracker.open({ title: 'Older, labelled by a rule', status: 'Todo' });
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick();
  const issue = s.tracker.open({ title: 'Labelled by a rule', status: 'Todo' });
  s.clock.tick();
  s.tracker.delegate(issue.id, 'agent', 'zapier');
  s.tracker.delegate(older.id, 'agent', 'zapier');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.tracker.comments(issue.id), []);
  assert.deepEqual((await s.store.list()).map((t) => t.title), ['Labelled by a rule'], 'the new issue comes in as any new issue does, the older one not');
});

test('an issue in a state the app does not have comes in Todo, and the mirror moves the tracker to Todo', async () => {
  const s = setup();
  await s.mirror.pass();
  s.clock.tick();
  const issue = s.tracker.open({ title: 'In the backlog', status: null });
  s.clock.tick();
  s.tracker.delegate(issue.id);
  s.clock.tick();
  await s.mirror.pass();
  const ticket = ticketOf(s.db, issue.id);
  assert.equal((await s.store.get(ticket))?.status, 'Todo');
  assert.equal(s.tracker.status(issue.id), 'Todo');
  assert.ok(s.tracker.calls.includes(`move ${issue.id} Todo`));
  assert.equal(s.requests.length, 1);

  // The app's later moves reach the tracker, as for any linked issue.
  s.clock.tick();
  await s.store.move(ticket, 'In Progress', { kind: 'agents', id: 'cleared-v2' });
  s.clock.tick();
  await s.mirror.pass();
  assert.equal(s.tracker.status(issue.id), 'In Progress');
});

test('a ticket already in hand gets no plan: the comment says where it is', async () => {
  const s = setup({ outcome: (request) => (request.ticket.status === 'Todo' ? { inPlan: 'plan-7' } : { inState: request.ticket.status }) });
  await s.mirror.pass();
  s.clock.tick();
  const ticket = await s.store.create({ title: 'Made in the app', project: PROJECT }, HUMAN);
  s.clock.tick();
  await s.mirror.pass();
  const issue = s.db.prepare('SELECT issue FROM mirror_links WHERE ticket = ?').get(ticket.id) as { issue: string };
  s.clock.tick();
  s.tracker.delegate(issue.issue);
  s.clock.tick();
  await s.mirror.pass();
  assert.match(s.tracker.comments(issue.issue).at(-1) as string, new RegExp(`${ticket.id} est déjà dans le plan plan-7\\u00a0: aucun nouveau plan n'est fait\\.$`));

  await s.store.move(ticket.id, 'In Progress', { kind: 'agents', id: 'cleared-v2' });
  s.clock.tick();
  await s.mirror.pass();
  s.tracker.undelegate(issue.issue);
  s.clock.tick();
  s.tracker.delegate(issue.issue);
  s.clock.tick();
  await s.mirror.pass();
  assert.match(s.tracker.comments(issue.issue).at(-1) as string, new RegExp(`${ticket.id} est déjà en «\\u00a0In Progress\\u00a0»\\u00a0: aucun nouveau plan n'est fait\\.$`));
  assert.equal(s.requests.length, 2, 'a delegation at a new time is a new one');
});

test('with no lead running, the delegation waits, and is handed over at the first pass after the lead starts', async () => {
  let running = false;
  const s = setup({ outcome: () => (running ? { plan: 'plan-1' } : undefined) });
  await s.mirror.pass();
  s.clock.tick();
  const issue = s.tracker.open({ title: 'While the lead is off', status: 'Todo' });
  s.tracker.delegate(issue.id);
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick(60);
  await s.mirror.pass();
  assert.equal((await s.store.list()).length, 1, 'the ticket is made at once');
  assert.deepEqual(s.tracker.comments(issue.id), []);
  running = true;
  s.clock.tick(60);
  await s.mirror.pass();
  s.clock.tick(60);
  await s.mirror.pass();
  assert.equal(s.tracker.comments(issue.id).length, 1);
  assert.equal(s.requests.filter((r) => r.ticket.title === 'While the lead is off').length, 3, 'asked at each pass until it is taken');
});

test('the mirror\'s own label on an issue it makes is not a delegation; a later one by its account is a person\'s', async () => {
  const s = setup();
  await s.mirror.pass();
  s.clock.tick();
  const ticket = await s.store.create({ title: 'Labelled in the app', labels: ['cleared'], project: PROJECT }, HUMAN);
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick();
  await s.mirror.pass();
  assert.equal(s.requests.length, 0);
  const issue = (s.db.prepare('SELECT issue FROM mirror_links WHERE ticket = ?').get(ticket.id) as { issue: string }).issue;
  s.tracker.undelegate(issue);
  s.clock.tick(120);
  s.tracker.delegate(issue, 'mirror', 'cleared-bot');
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(s.requests.map((r) => [r.ticket.id, r.who]), [[ticket.id, 'cleared-bot']]);
});

test('the comment follows CLEARED_V2_APP_LANGUAGE', async () => {
  const s = setup({ language: 'en' });
  await s.mirror.pass();
  s.clock.tick();
  const issue = s.tracker.open({ title: 'In English', status: 'Todo' });
  s.tracker.delegate(issue.id, 'person', 'jane');
  s.clock.tick();
  await s.mirror.pass();
  const ticket = ticketOf(s.db, issue.id);
  assert.equal(s.tracker.comments(issue.id)[0], `jane handed this issue over to Cleared: it is ${ticket}. Plan plan-1 waits for the owner's approval in Cleared, and no work starts before it.`);
});

test('without the plans, a delegation is not read: an older issue stays out', async () => {
  const s = setup({ delegation: false });
  const issue = s.tracker.open({ title: 'Older', status: 'Todo' });
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick();
  s.tracker.delegate(issue.id);
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(await s.store.list(), []);
  assert.deepEqual(s.tracker.comments(issue.id), []);
});

test('the settings: the label is cleared by default, another can be named, a status label is refused, and the delegation can be turned off', () => {
  const env = { CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: '/nonexistent' };
  assert.throws(() => loadMirrorConfig(env), MirrorConfigError, 'the token file is read first, as before');
  const file = new URL('./mirror-delegation.test.ts', import.meta.url).pathname;
  const base = { CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: file };
  assert.deepEqual(loadMirrorConfig(base)?.delegation, { label: 'cleared' });
  assert.deepEqual(loadMirrorConfig({ ...base, CLEARED_V2_DELEGATION_LABEL: ' Agent ' })?.delegation, { label: 'Agent' });
  assert.throws(() => loadMirrorConfig({ ...base, CLEARED_V2_DELEGATION_LABEL: 'status:Todo' }), (error: unknown) => error instanceof MirrorConfigError && /CLEARED_V2_DELEGATION_LABEL/.test(error.message));
  assert.equal(loadMirrorConfig({ ...base, CLEARED_V2_DELEGATION: 'off' })?.delegation, undefined);
  assert.deepEqual(loadMirrorConfig({ ...base, CLEARED_V2_DELEGATION: 'on' })?.delegation, { label: 'cleared' });
  assert.throws(() => loadMirrorConfig({ ...base, CLEARED_V2_DELEGATION: 'maybe' }), (error: unknown) => error instanceof MirrorConfigError && /CLEARED_V2_DELEGATION /.test(`${error.message} `));
  assert.equal(loadMirrorConfig({ CLEARED_V2_DELEGATION_LABEL: 'cleared' }), undefined, 'no mirror, no delegation');
});

test('the tickets module hands a delegation to the lead\'s plans, and waits while no lead runs', async () => {
  const { delegationOf } = await import('../../src/modules/tickets.ts');
  const { defaultRegistry } = await import('../../src/modules/registry.ts');
  const registry = defaultRegistry();
  const ticket = await registry.ticketStore.create({ title: 'Delegated', project: PROJECT }, HUMAN);
  assert.equal(await delegationOf(registry)({ ticket, tracker: 'GitHub', key: 'org/guestbook#1', url: 'https://github.com/org/guestbook/issues/1', who: 'jane' }), undefined);
});
