// The Linear tracker of the mirror (P230) against a fake of Linear's GraphQL
// API, never a real account or key: a state is the team's workflow state of
// the same name, and who made each change is read from the issue's history.
import test, { after, before } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { LinearTracker } from '../../src/tickets/mirror-linear.ts';
import { TrackerError } from '../../src/tickets/mirror.ts';
import { Clock } from './mirror-support.ts';
import { FakeLinear } from './fakes/linear.ts';

const TOKEN = randomBytes(16).toString('hex');
const MIRROR = { id: 'user-mirror', name: 'Cleared' };
const JANE = { user: { id: 'user-jane', name: 'Jane' } };
const GITHUB_APP = { bot: { id: 'bot-github', name: 'GitHub' } };

const clock = new Clock();
const fake = new FakeLinear({ clock: () => clock.iso, accounts: { [TOKEN]: MIRROR } });
let api = '';
let tracker: LinearTracker;

before(async () => {
  api = await fake.listen();
  tracker = new LinearTracker({ api, token: TOKEN, team: 'ENG' });
});
after(() => fake.close());

test('its name is the team\'s, and it is on no one service', () => {
  assert.equal(tracker.name, 'linear:ENG');
  assert.equal(tracker.title, 'Linear');
  assert.equal(tracker.service, undefined);
});

test('an issue is created in the team, in the state of the same name, as the mirror\'s change', async () => {
  clock.tick();
  const made = await tracker.create({ title: 'Newest entry first', body: 'Sort the entries.', labels: ['ui'], status: 'In Progress' });
  assert.equal(fake.stateOf(made.id), 'In Progress');
  assert.equal(made.status, 'In Progress');
  assert.equal(made.key, 'ENG-1');
  assert.equal(made.body, 'Sort the entries.');
  assert.deepEqual(made.changes.map((c) => [c.status, c.actor]), [['In Progress', 'mirror']]);
  for (const operation of fake.operations) assert.equal(operation.auth, TOKEN);
});

test('a move sets the state; a comment is written on the issue, and its id is given back', async () => {
  clock.tick();
  const made = await tracker.create({ title: 'Move me', body: '', labels: [], status: 'Todo' });
  await tracker.move(made.id, 'Needs Approval');
  assert.equal(fake.stateOf(made.id), 'Needs Approval');
  const id = await tracker.comment(made.id, 'Ready to Ship is given in Cleared.');
  const [written] = fake.issues.get(made.id)?.comments ?? [];
  assert.deepEqual([written?.body, written?.user?.id, written?.id], ['Ready to Ship is given in Cleared.', MIRROR.id, id]);
});

test('the team\'s comments since a time, each with its issue, who wrote it and when', async () => {
  clock.tick(60);
  const made = await tracker.create({ title: 'Talked about', body: '', labels: [], status: 'Todo' });
  fake.comment(made.id, JANE, 'Too early');
  clock.tick();
  const since = clock.iso;
  clock.tick();
  fake.comment(made.id, JANE, 'Sort them by date, please.');
  clock.tick();
  fake.comment(made.id, GITHUB_APP, 'Linked to a pull request.');
  clock.tick();
  const own = await tracker.comment(made.id, 'Cleared: started.');
  const comments = await tracker.commentsSince(since);
  assert.deepEqual(comments.map((c) => [c.issue, c.body, c.actor, c.who]), [
    [made.id, 'Sort them by date, please.', 'person', 'Jane'],
    [made.id, 'Linked to a pull request.', 'agent', 'GitHub'],
    [made.id, 'Cleared: started.', 'mirror', 'Cleared'],
  ]);
  assert.equal(comments.at(-1)?.id, own);
  assert.ok(comments.every((c) => c.at >= since));
});

test('an edit writes the title and the description; the history says who changed each', async () => {
  clock.tick(60);
  const since = clock.iso;
  const made = await tracker.create({ title: 'Old title', body: 'Old body', labels: [], status: 'Todo' });
  clock.tick();
  await tracker.edit(made.id, { title: 'Newest entry first' });
  assert.equal(fake.issues.get(made.id)?.title, 'Newest entry first');
  clock.tick();
  fake.edit(made.id, JANE, { description: 'Jane\'s words.' });
  clock.tick();
  fake.edit(made.id, GITHUB_APP, { title: 'Newest entries first', description: 'The app\'s words.' });
  const issue = (await tracker.changed(since)).find((i) => i.id === made.id);
  assert.deepEqual([issue?.title, issue?.body], ['Newest entries first', 'The app\'s words.']);
  assert.deepEqual(issue?.edits.map((e) => [e.field, e.actor, e.who]), [
    ['title', 'mirror', 'Cleared'],
    ['body', 'person', 'Jane'],
    ['title', 'agent', 'GitHub'],
    ['body', 'agent', 'GitHub'],
  ]);
  assert.deepEqual(issue?.changes.map((c) => c.status), ['Todo'], 'an edit is not a change of state');
});

test('changed issues: a state the app does not have reads as none, and each change says who made it, oldest first', async () => {
  clock.tick(60);
  const since = clock.iso;
  clock.tick();
  const backlog = fake.create(JANE, { title: 'In the backlog', state: 'Backlog' });
  const moved = fake.create(JANE, { title: 'Moved around', description: 'Asked by Jane', state: 'Todo' });
  clock.tick();
  fake.move(moved.id, JANE, 'In Progress');
  clock.tick();
  fake.move(moved.id, GITHUB_APP, 'In Review');
  clock.tick();
  fake.move(moved.id, { user: MIRROR }, 'Needs Approval');
  const issues = await tracker.changed(since);
  const by = new Map(issues.map((i) => [i.title, i]));
  assert.equal(by.get('In the backlog')?.status, null);
  assert.equal(by.get('In the backlog')?.id, backlog.id);
  const issue = by.get('Moved around');
  assert.equal(issue?.status, 'Needs Approval');
  assert.equal(issue?.body, 'Asked by Jane');
  assert.deepEqual(issue?.changes.map((c) => [c.status, c.actor, c.who]), [
    ['In Progress', 'person', 'Jane'],
    ['In Review', 'agent', 'GitHub'],
    ['Needs Approval', 'mirror', 'Cleared'],
  ]);
  assert.equal(issues.some((i) => i.title === 'Move me'), false, 'not changed since');
});

test('every page of a long list is read', async () => {
  clock.tick();
  const since = clock.iso;
  clock.tick();
  for (let i = 0; i < 120; i++) fake.create(JANE, { title: `Issue ${i}`, state: 'Todo' });
  assert.equal((await tracker.changed(since)).length, 120);
});

test('a key Linear refuses, and a team it does not have, are TrackerErrors that never hold the key', async () => {
  const unknown = randomBytes(16).toString('hex');
  const wrong = new LinearTracker({ api, token: unknown, team: 'ENG' });
  await assert.rejects(wrong.changed(clock.iso), (error: unknown) =>
    error instanceof TrackerError && /401|Authentication/.test(error.message) && !error.message.includes(unknown));
  const other = new LinearTracker({ api, token: TOKEN, team: 'OPS' });
  await assert.rejects(other.changed(clock.iso), (error: unknown) => error instanceof TrackerError && /OPS/.test(error.message));
});

// ---- a delegation (C3, P243) ----------------------------------------------

const delegationOf = async (since: string, id: string) => (await tracker.changed(since)).find((i) => i.id === id)?.delegation;
const BOT = { bot: { id: 'bot-zap', name: 'Zapier' } };

test('a delegation: the cleared label on an issue, read from its history, even in Backlog; gone with the label, or once Done or Canceled', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.create(JANE, { title: 'Hand it over', state: 'Backlog' });
  assert.equal(await delegationOf(since, issue.id), null);
  clock.tick();
  const at = clock.iso;
  fake.label(issue.id, JANE, 'Cleared');
  const read = (await tracker.changed(since)).find((i) => i.id === issue.id);
  assert.deepEqual(read?.delegation, { how: 'label', actor: 'person', who: 'Jane', at });
  assert.equal(read?.status, null, 'Backlog is a state the app does not have');
  clock.tick();
  fake.unlabel(issue.id, 'Cleared');
  assert.equal(await delegationOf(since, issue.id), null);
  clock.tick();
  fake.label(issue.id, BOT, 'Cleared');
  assert.deepEqual(await delegationOf(since, issue.id), { how: 'label', actor: 'agent', who: 'Zapier', at: clock.iso }, 'an integration\'s label is an agent\'s');
  for (const state of ['Done', 'Canceled']) {
    clock.tick();
    fake.move(issue.id, JANE, state);
    assert.equal(await delegationOf(since, issue.id), null, state);
  }
});

test('a delegation: the issue assigned to the key\'s own user; assigned to anyone else, it is not one', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.create(JANE, { title: 'Assigned', state: 'Todo' });
  clock.tick();
  fake.assign(issue.id, JANE, 'user-jane');
  assert.equal(await delegationOf(since, issue.id), null);
  clock.tick();
  const at = clock.iso;
  fake.assign(issue.id, JANE, MIRROR.id);
  assert.deepEqual(await delegationOf(since, issue.id), { how: 'assignee', actor: 'person', who: 'Jane', at });
  clock.tick();
  fake.assign(issue.id, JANE, null);
  assert.equal(await delegationOf(since, issue.id), null);
});

test('an issue created with the label, which no history entry names, is handed over by its creator at its creation', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.create(JANE, { title: 'Born delegated', state: 'Backlog', labels: ['cleared'] });
  assert.deepEqual(await delegationOf(since, issue.id), { how: 'label', actor: 'person', who: 'Jane', at: issue.createdAt });
});

test('another delegation label is read in its place', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.create(JANE, { title: 'Another label', state: 'Todo' });
  clock.tick();
  fake.label(issue.id, JANE, 'cleared');
  clock.tick();
  fake.label(issue.id, JANE, 'agent');
  const other = new LinearTracker({ api, token: TOKEN, team: 'ENG', delegationLabel: 'Agent' });
  const read = (await other.changed(since)).find((i) => i.id === issue.id);
  assert.deepEqual(read?.delegation, { how: 'label', actor: 'person', who: 'Jane', at: clock.iso });
});
