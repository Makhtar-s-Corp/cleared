// The mirror's pass (P229 to P231, docs/v2/mirrors.md) on the real ticket
// store, with a tracker kept in memory: what is created and moved each way,
// who wins a conflict, and what a tracker never does through the mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { UserId } from '../../src/session/contract.ts';
import type { TicketId } from '../../src/tickets/contract.ts';
import { FlowError } from '../../src/flow/engine.ts';
import { MIRROR_ACTOR, Mirror, MirrorConfigError, createMirror, loadMirrorConfig, type MirrorFlow } from '../../src/tickets/mirror.ts';
import { scratch } from '../approval/harness.ts';
import { AGENTS, Clock, HUMAN, MemoryTracker, openStore } from './mirror-support.ts';

const PROJECT = 'guestbook';

function setup(options: { language?: 'fr' | 'en'; trackers?: (clock: Clock) => MemoryTracker[]; services?: string[]; flow?: MirrorFlow } = {}) {
  const clock = new Clock();
  const { db, store } = openStore(clock);
  const trackers = options.trackers ? options.trackers(clock) : [new MemoryTracker(clock)];
  const logs: string[] = [];
  const mirror = new Mirror({
    db, tickets: store, trackers, project: PROJECT, services: options.services ?? [], language: options.language ?? 'fr',
    now: clock.now, log: (line) => logs.push(line), ...(options.flow ? { flow: () => options.flow } : {}),
  });
  return { clock, db, store, tracker: trackers[0] as MemoryTracker, trackers, mirror, logs };
}

// The tracker's issue linked to a ticket.
function issueOf(db: DatabaseSync, ticket: TicketId, tracker = 'memory:team'): string {
  const row = db.prepare('SELECT issue FROM mirror_links WHERE ticket = ? AND tracker = ?').get(ticket, tracker) as { issue: string } | undefined;
  assert.ok(row, `${ticket} is linked on ${tracker}`);
  return row.issue;
}

// A ticket created after the mirror's first pass and linked by a second.
async function linked(s: ReturnType<typeof setup>, title = 'Newest entry first') {
  await s.mirror.pass();
  s.clock.tick();
  const ticket = await s.store.create({ title, project: PROJECT }, HUMAN);
  s.clock.tick();
  await s.mirror.pass();
  return { ticket, issue: issueOf(s.db, ticket.id) };
}

test('the first pass starts the mirror: what existed before is left alone, what is created after is created on the other side', async () => {
  const s = setup();
  const before = await s.store.create({ title: 'Older ticket', project: PROJECT }, HUMAN);
  s.tracker.open({ title: 'Older issue', status: 'Todo' });
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(s.tracker.calls.filter((c) => c.startsWith('create')), []);
  assert.deepEqual((await s.store.list()).map((t) => t.title), ['Older ticket']);

  s.clock.tick();
  const after = await s.store.create({ title: 'Newest entry first', body: 'Sort the entries.', labels: ['ui'], project: PROJECT }, HUMAN);
  await s.store.move(after.id, 'In Progress', AGENTS);
  await s.store.create({ title: 'Another project', project: 'filter-api' }, HUMAN);
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(s.tracker.calls.filter((c) => c.startsWith('create')), ['create Newest entry first In Progress']);
  const issue = s.tracker.issues.get(issueOf(s.db, after.id))?.issue;
  assert.equal(issue?.body, 'Sort the entries.');
  assert.deepEqual(issue?.labels, ['ui']);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM mirror_links WHERE ticket = ?').get(before.id)?.n, 0);
});

test('an issue created on the tracker appears in the app in its state, written by the mirror as an agent, never as a signed person', async () => {
  const s = setup();
  await s.mirror.pass();
  s.clock.tick();
  s.tracker.open({ title: 'From the tracker', body: 'Asked by a person.', status: 'In Progress' });
  s.tracker.open({ title: 'Still in the backlog', status: null });
  s.clock.tick();
  await s.mirror.pass();
  const tickets = await s.store.list();
  assert.deepEqual(tickets.map((t) => [t.title, t.status, t.body, t.project]), [['From the tracker', 'In Progress', 'Asked by a person.', PROJECT]]);
  const id = (tickets[0] as { id: TicketId }).id;
  for (const change of await s.store.history(id)) assert.deepEqual(change.by, { kind: 'agents', id: MIRROR_ACTOR.id });
  const rows = s.db.prepare('SELECT actor_kind, proof FROM tracker_history').all();
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.deepEqual({ ...row }, { actor_kind: 'agents', proof: null });
  assert.deepEqual(s.tracker.calls.filter((c) => c.startsWith('move') || c.startsWith('create')), [], 'nothing written back');

  s.clock.tick();
  s.tracker.act('ISS-2', 'Todo');
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual((await s.store.list()).map((t) => t.title), ['From the tracker', 'Still in the backlog'], 'imported once it is in a state of the app');
});

test('a move in the app is written on the tracker, and a person\'s move on the tracker in the app', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  s.clock.tick();
  await s.store.move(ticket.id, 'In Progress', AGENTS);
  s.clock.tick();
  await s.mirror.pass();
  assert.equal(s.tracker.status(issue), 'In Progress');

  s.clock.tick();
  s.tracker.act(issue, 'Done');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Done');
  const last = (await s.store.history(ticket.id)).at(-1);
  assert.deepEqual(last?.by, { kind: 'agents', id: MIRROR_ACTOR.id });
  const applied = s.db.prepare('SELECT status, kind, who, tracker FROM mirror_applied WHERE ticket = ? ORDER BY rowid DESC').get(ticket.id);
  assert.deepEqual({ ...applied }, { status: 'Done', kind: 'human', who: 'jane', tracker: 'memory:team' });
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(s.tracker.calls.filter((c) => c.startsWith('move')), [`move ${issue} In Progress`], 'nothing written back after');
});

test('a person\'s move on the tracker beats an agent\'s move in the app made after it, between two passes', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  await s.store.move(ticket.id, 'In Progress', AGENTS);
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick();
  s.tracker.act(issue, 'Todo');
  s.clock.tick(5);
  await s.store.move(ticket.id, 'In Review', AGENTS);
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Todo');
  assert.equal(s.tracker.status(issue), 'Todo');
});

test('the owner\'s move in the app beats an integration\'s move on the tracker made after it', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  s.clock.tick();
  await s.store.move(ticket.id, 'Done', HUMAN);
  s.clock.tick(5);
  s.tracker.act(issue, 'In Review', 'agent');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Done');
  assert.equal(s.tracker.status(issue), 'Done');
});

test('a guest\'s move in the app is not the owner\'s: a person on the tracker beats it', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  s.clock.tick();
  s.tracker.act(issue, 'Done');
  s.clock.tick(5);
  await s.store.move(ticket.id, 'In Review', { kind: 'human', id: 'user-uuid-2' as UserId });
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Done');
});

test('between two people, the later move wins', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  s.clock.tick();
  await s.store.move(ticket.id, 'In Review', HUMAN);
  s.clock.tick(5);
  s.tracker.act(issue, 'Done');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Done');

  s.clock.tick();
  s.tracker.act(issue, 'In Progress');
  s.clock.tick(5);
  await s.store.move(ticket.id, 'Todo', HUMAN);
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Todo');
  assert.equal(s.tracker.status(issue), 'Todo');
});

test('a stale read of the mirror\'s own earlier write is not a change on the tracker', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  const held = s.tracker.issues.get(issue);
  assert.ok(held);
  const stale = held.issue;                           // Todo, as the mirror created it
  s.clock.tick();
  await s.store.move(ticket.id, 'In Progress', AGENTS);
  s.clock.tick();
  await s.mirror.pass();
  assert.equal(s.tracker.status(issue), 'In Progress');
  s.clock.tick();
  held.issue = { ...stale, updatedAt: s.clock.iso }; // the tracker answers with its old copy
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'In Progress');
  assert.deepEqual((await s.store.history(ticket.id)).map((h) => h.status), ['Todo', 'In Progress']);
});

test('a move by the mirror\'s own account that the mirror did not write is a person\'s (an account shared with the owner)', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  s.clock.tick(120);
  s.tracker.act(issue, 'Done', 'mirror', 'cleared-bot');
  s.clock.tick(5);
  await s.store.move(ticket.id, 'In Progress', AGENTS);
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Done');
});

test('a move to the go state on the tracker is not an approval: the tracker is put back, with a comment in the project\'s language', async () => {
  for (const language of ['fr', 'en'] as const) {
    const s = setup({ language });
    const { ticket, issue } = await linked(s);
    await s.store.move(ticket.id, 'Needs Approval', AGENTS);
    s.clock.tick();
    await s.mirror.pass();
    s.clock.tick();
    s.tracker.act(issue, 'Ready to Ship');
    s.clock.tick();
    await s.mirror.pass();
    assert.equal((await s.store.get(ticket.id))?.status, 'Needs Approval');
    assert.equal(s.tracker.status(issue), 'Needs Approval');
    const [comment] = s.tracker.comments(issue);
    assert.ok(comment, language);
    if (language === 'fr') assert.match(comment, /«\sReady to Ship\s».*Cleared.*«\sNeeds Approval\s»/s);
    else assert.match(comment, /“Ready to Ship”.*Cleared.*“Needs Approval”/s);
    s.clock.tick();
    await s.mirror.pass();
    assert.equal(s.tracker.comments(issue).length, 1, 'said once');
  }
});

test('an issue created on the tracker in the go state comes in Todo, and the tracker is put back with a comment', async () => {
  const s = setup();
  await s.mirror.pass();
  s.clock.tick();
  const issue = s.tracker.open({ title: 'Ship it now', status: 'Ready to Ship' });
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual((await s.store.list()).map((t) => t.status), ['Todo']);
  assert.equal(s.tracker.status(issue.id), 'Todo');
  assert.equal(s.tracker.comments(issue.id).length, 1);
});

test('a ticket the owner approved does not move from the tracker', async () => {
  const s = setup();
  const { ticket, issue } = await linked(s);
  // The approval writer's row (LocalTicketStore.recordApproval), as the lock reads it.
  const number = Number(ticket.id.slice('LOCAL-'.length));
  s.clock.tick();
  s.db.prepare('UPDATE tracker_tickets SET status = ? WHERE id = ?').run('Ready to Ship', number);
  s.db.prepare("INSERT INTO tracker_history(ticket, status, actor_kind, actor_id, at) VALUES (?, 'Ready to Ship', 'human', 'demo', ?)").run(number, s.clock.iso);
  s.clock.tick();
  await s.mirror.pass();
  assert.equal(s.tracker.status(issue), 'Ready to Ship');
  s.clock.tick();
  s.tracker.act(issue, 'Todo');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Ready to Ship');
  assert.equal(s.tracker.status(issue), 'Ready to Ship');
  assert.equal(s.tracker.comments(issue).length, 1);
});

test('a person\'s move of a ticket the flow works on sets it aside first, and a move to Todo starts nothing', async () => {
  const calls: string[] = [];
  let active = true;
  let store: ReturnType<typeof setup>['store'] | undefined;
  const flow: MirrorFlow = {
    isActive: (id) => { calls.push(`isActive ${id}`); return active; },
    setAside: async (id, by, words) => {
      calls.push(`setAside ${id} ${by}`);
      calls.push(words.note, words.message);
      active = false;
      await store?.move(id, 'Todo', AGENTS);
      return { sessions: 1, items: 0 };
    },
  };
  const s = setup({ flow });
  store = s.store;
  const { ticket, issue } = await linked(s);
  await s.store.move(ticket.id, 'In Progress', AGENTS);
  s.clock.tick();
  await s.mirror.pass();
  calls.length = 0;
  s.clock.tick();
  s.tracker.act(issue, 'Todo');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Todo');
  assert.equal(calls[0], `isActive ${ticket.id}`);
  assert.equal(calls[1], `setAside ${ticket.id} ${MIRROR_ACTOR.id}`);
  assert.match(calls[2] as string, /jane.*Linear.*«\sTodo\s»/s, 'the note, in French');
  assert.match(calls[3] as string, /jane.*Linear/s, 'the session\'s message');
  assert.equal(calls.length, 4, 'nothing else: no session is started');
  const last = (await s.store.history(ticket.id)).at(-1);
  assert.deepEqual(last?.by, { kind: 'agents', id: MIRROR_ACTOR.id }, 'the person\'s state is the mirror\'s row, after the flow\'s');
});

test('a ticket the flow cannot set aside (its release is landing) does not move: the tracker is put back', async () => {
  const flow: MirrorFlow = {
    isActive: () => true,
    setAside: async () => { throw new FlowError('conflict', 'the train of LOCAL-1 is landing: it is not set aside'); },
  };
  const s = setup({ flow, language: 'en' });
  const { ticket, issue } = await linked(s);
  await s.store.move(ticket.id, 'In Review', AGENTS);
  s.clock.tick();
  await s.mirror.pass();
  s.clock.tick();
  s.tracker.act(issue, 'Todo');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'In Review');
  assert.equal(s.tracker.status(issue), 'In Review');
  assert.match(s.tracker.comments(issue)[0] ?? '', /being released/);
});

test('a person\'s move on one tracker reaches the other as a person\'s, and beats an integration there', async () => {
  const s = setup({ trackers: (clock) => [new MemoryTracker(clock), new MemoryTracker(clock, { name: 'memory:other', title: 'GitHub' })] });
  const other = s.trackers[1] as MemoryTracker;
  const { ticket, issue } = await linked(s);
  const otherIssue = issueOf(s.db, ticket.id, 'memory:other');
  s.clock.tick();
  s.tracker.act(issue, 'Done');
  s.clock.tick(5);
  other.act(otherIssue, 'In Review', 'agent');
  s.clock.tick();
  await s.mirror.pass();
  assert.equal((await s.store.get(ticket.id))?.status, 'Done');
  assert.equal(other.status(otherIssue), 'Done');
});

test('a ticket goes to the tracker of its first service, else of the workspace\'s first; an issue of a service\'s tracker comes on that service', async () => {
  const s = setup({
    services: ['guestbook', 'filter-api'],
    trackers: (clock) => [
      new MemoryTracker(clock, { name: 'github:org/guestbook', title: 'GitHub', service: 'guestbook' }),
      new MemoryTracker(clock, { name: 'github:org/filter-api', title: 'GitHub', service: 'filter-api' }),
    ],
  });
  const [guestbook, filter] = s.trackers as [MemoryTracker, MemoryTracker];
  await s.mirror.pass();
  s.clock.tick();
  await s.store.create({ title: 'Filter the words', project: PROJECT, services: ['filter-api', 'guestbook'] }, HUMAN);
  await s.store.create({ title: 'No service named', project: PROJECT }, HUMAN);
  filter.open({ title: 'From the filter repository', status: 'Todo' });
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(filter.calls.filter((c) => c.startsWith('create')), ['create Filter the words Todo']);
  assert.deepEqual(guestbook.calls.filter((c) => c.startsWith('create')), ['create No service named Todo']);
  const imported = (await s.store.list()).find((t) => t.title === 'From the filter repository');
  assert.deepEqual(imported?.services?.map((x) => x.name), ['filter-api']);
});

test('a tracker that fails is said in one line, and the other trackers go on', async () => {
  const s = setup({ trackers: (clock) => [new MemoryTracker(clock), new MemoryTracker(clock, { name: 'memory:other' })] });
  const other = s.trackers[1] as MemoryTracker;
  await s.mirror.pass();
  s.clock.tick();
  s.tracker.failing = true;
  await s.store.create({ title: 'Newest entry first', project: PROJECT }, HUMAN);
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(other.calls.filter((c) => c.startsWith('create')), ['create Newest entry first Todo']);
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0] as string, /memory:team/);
  s.tracker.failing = false;
  s.clock.tick();
  await s.mirror.pass();
  assert.deepEqual(s.tracker.calls.filter((c) => c.startsWith('create')), ['create Newest entry first Todo'], 'created at the next pass');
});

test('the timer runs passes one at a time until close', async () => {
  const s = setup();
  s.mirror.start(10);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await s.mirror.close();
  const seen = s.tracker.calls.length;
  assert.ok(seen >= 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(s.tracker.calls.length, seen);
});

test('the settings: nothing configured is no mirror; tokens come from files; an address other than the trackers\' own must be on loopback', () => {
  const dir = scratch('cleared-mirror-conf-');
  const file = join(dir, 'token');
  writeFileSync(file, 'test-token-value\n', { mode: 0o600 });
  assert.equal(loadMirrorConfig({}), undefined);
  const github = loadMirrorConfig({ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: file });
  assert.deepEqual(github, { pollMs: 60_000, language: 'fr', github: { api: 'https://api.github.com', token: 'test-token-value' } });
  const linear = loadMirrorConfig({
    CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE: file, CLEARED_V2_MIRROR_LINEAR_TEAM: 'ENG', CLEARED_V2_MIRROR_LINEAR_API: 'http://127.0.0.1:4567/graphql',
    CLEARED_V2_MIRROR_POLL_SECONDS: '30', CLEARED_V2_APP_LANGUAGE: 'en',
  });
  assert.deepEqual(linear, { pollMs: 30_000, language: 'en', linear: { api: 'http://127.0.0.1:4567/graphql', token: 'test-token-value', team: 'ENG' } });
  const refused: [Record<string, string>, RegExp][] = [
    [{ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: join(dir, 'missing') }, /CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE/],
    [{ CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE: file }, /CLEARED_V2_MIRROR_LINEAR_TEAM/],
    [{ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: file, CLEARED_V2_MIRROR_GITHUB_API: 'http://example.com' }, /loopback/],
    [{ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: file, CLEARED_V2_MIRROR_GITHUB_API: 'https://tracker.example.com' }, /loopback/],
    [{ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: file, CLEARED_V2_MIRROR_POLL_SECONDS: '5' }, /15/],
  ];
  for (const [env, message] of refused) {
    assert.throws(() => loadMirrorConfig(env), (error: unknown) => error instanceof MirrorConfigError && message.test(error.message) && !error.message.includes('test-token-value'));
  }
});

test('the mirror is made from the settings: one GitHub tracker per service repository, one Linear tracker for the team', () => {
  const clock = new Clock();
  const { db, store } = openStore(clock);
  const deps = { db, tickets: store, project: PROJECT, services: [{ name: 'guestbook', repo: 'org/guestbook' }, { name: 'filter-api', repo: 'org/filter-api' }] };
  assert.equal(createMirror(undefined, deps), undefined);
  const mirror = createMirror({ pollMs: 60_000, language: 'fr', github: { api: 'https://api.github.com', token: 't' }, linear: { api: 'https://api.linear.app/graphql', token: 't', team: 'ENG' } }, deps);
  assert.deepEqual(mirror?.trackerNames, ['github:org/guestbook', 'github:org/filter-api', 'linear:ENG']);
});
