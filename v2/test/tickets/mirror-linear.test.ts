// The Linear tracker of the mirror (P229) against a fake of Linear's GraphQL
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

test('a move sets the state; a comment is written on the issue', async () => {
  clock.tick();
  const made = await tracker.create({ title: 'Move me', body: '', labels: [], status: 'Todo' });
  await tracker.move(made.id, 'Needs Approval');
  assert.equal(fake.stateOf(made.id), 'Needs Approval');
  await tracker.comment(made.id, 'Ready to Ship is given in Cleared.');
  assert.deepEqual(fake.issues.get(made.id)?.comments, [{ body: 'Ready to Ship is given in Cleared.', by: MIRROR.id }]);
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
