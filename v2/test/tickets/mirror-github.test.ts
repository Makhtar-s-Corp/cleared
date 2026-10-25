// The GitHub Issues tracker of the mirror (P230) against a fake of GitHub's
// REST API: a state is one `status:<state>` label on an open issue, Done is
// the issue closed as completed; who made each change is read from the
// issue's events.
import test, { after, before } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { GitHubTracker } from '../../src/tickets/mirror-github.ts';
import { TrackerError } from '../../src/tickets/mirror.ts';
import { Clock } from './mirror-support.ts';
import { FakeGitHub, type FakeAccount } from './fakes/github.ts';

const REPO = 'org/guestbook';
const MIRROR: FakeAccount = { login: 'cleared-bot', type: 'User' };
const JANE: FakeAccount = { login: 'jane', type: 'User' };
const ACTIONS: FakeAccount = { login: 'github-actions[bot]', type: 'Bot' };
const TOKEN = randomBytes(16).toString('hex');

const clock = new Clock();
const fake = new FakeGitHub({ clock: () => clock.iso, accounts: { [TOKEN]: MIRROR, 'jane-token': JANE }, repos: [REPO] });
let api = '';
let tracker: GitHubTracker;

before(async () => {
  api = await fake.listen();
  tracker = new GitHubTracker({ api, token: TOKEN, repo: REPO, service: 'guestbook' });
});
after(() => fake.close());

test('its name and its service are the repository\'s', () => {
  assert.equal(tracker.name, 'github:org/guestbook');
  assert.equal(tracker.title, 'GitHub');
  assert.equal(tracker.service, 'guestbook');
});

test('an issue is created with its labels and one status label, closed when it is Done; the token goes in the header only', async () => {
  clock.tick();
  const made = await tracker.create({ title: 'Newest entry first', body: 'Sort the entries.', labels: ['ui'], status: 'In Progress' });
  const issue = fake.issue(REPO, Number(made.id));
  assert.deepEqual(issue.labels.map((l) => l.name), ['ui', 'status:In Progress']);
  assert.equal(made.key, 'org/guestbook#' + made.id);
  assert.equal(made.url, issue.html_url);
  assert.equal(made.status, 'In Progress');
  assert.deepEqual(made.labels, ['ui']);
  const done = await tracker.create({ title: 'Already shipped', body: '', labels: [], status: 'Done' });
  assert.equal(fake.issue(REPO, Number(done.id)).state, 'closed');
  assert.equal(fake.issue(REPO, Number(done.id)).state_reason, 'completed');
  for (const request of fake.requests) {
    assert.equal(request.auth, `Bearer ${TOKEN}`);
    assert.ok(!request.path.includes(TOKEN));
  }
});

test('a move puts the new status label on, takes the old one off, keeps the other labels, and closes or reopens for Done', async () => {
  clock.tick();
  const made = await tracker.create({ title: 'Move me', body: '', labels: ['ui'], status: 'Todo' });
  const number = Number(made.id);
  await tracker.move(made.id, 'In Review');
  assert.deepEqual(fake.issue(REPO, number).labels.map((l) => l.name), ['ui', 'status:In Review']);
  const events = fake.events(REPO, number).map((e) => `${e.event} ${e.label?.name ?? ''}`.trim());
  assert.deepEqual(events, ['labeled status:In Review', 'unlabeled status:Todo'], 'the new label first: the issue never reads as having none');
  await tracker.move(made.id, 'Done');
  assert.equal(fake.issue(REPO, number).state, 'closed');
  assert.deepEqual(fake.issue(REPO, number).labels.map((l) => l.name), ['ui', 'status:Done']);
  await tracker.move(made.id, 'Todo');
  assert.equal(fake.issue(REPO, number).state, 'open');
  assert.deepEqual(fake.issue(REPO, number).labels.map((l) => l.name), ['ui', 'status:Todo']);
});

test('changed issues: pull requests left out, the state read from the labels, and who made each change from the events', async () => {
  clock.tick(60);
  const since = clock.iso;
  clock.tick();
  const fresh = fake.open(REPO, JANE, { title: 'A person\'s new issue', body: 'Please' });
  fake.open(REPO, JANE, { title: 'A pull request', pullRequest: true });
  const two = fake.open(REPO, JANE, { title: 'Two states', labels: ['status:Todo', 'status:Done'] });
  const moved = fake.open(REPO, JANE, { title: 'Moved around', labels: ['bug'] });
  clock.tick();
  fake.status(REPO, moved.number, JANE, 'In Progress');
  clock.tick();
  fake.status(REPO, moved.number, ACTIONS, 'In Review');
  clock.tick();
  fake.status(REPO, moved.number, MIRROR, 'Needs Approval');
  const dropped = fake.open(REPO, JANE, { title: 'Not planned' });
  fake.close_(REPO, dropped.number, JANE, 'not_planned');
  const closed = fake.open(REPO, JANE, { title: 'Closed by a person' });
  clock.tick();
  fake.close_(REPO, closed.number, JANE);

  const issues = await tracker.changed(since);
  const by = new Map(issues.map((i) => [i.title, i]));
  assert.equal(by.has('A pull request'), false);
  assert.equal(by.get('A person\'s new issue')?.status, 'Todo', 'an open issue with no status label is in Todo');
  assert.equal(by.get('A person\'s new issue')?.body, 'Please');
  assert.equal(by.get('A person\'s new issue')?.id, String(fresh.number));
  assert.equal(by.get('Two states')?.status, null);
  assert.equal(two.labels.length, 2);
  assert.equal(by.get('Not planned')?.status, null);
  assert.equal(by.get('Closed by a person')?.status, 'Done');
  assert.deepEqual(by.get('Closed by a person')?.changes.map((c) => [c.status, c.actor, c.who]), [['Done', 'person', 'jane']]);
  const changes = by.get('Moved around')?.changes.map((c) => [c.status, c.actor, c.who]);
  assert.deepEqual(changes, [
    ['In Progress', 'person', 'jane'],
    ['In Review', 'agent', 'github-actions[bot]'],
    ['Needs Approval', 'mirror', 'cleared-bot'],
  ]);
  assert.deepEqual(by.get('Moved around')?.labels, ['bug']);
  assert.equal(by.get('Moved around')?.status, 'Needs Approval');
});

test('every page of a long list is read', async () => {
  const many = new FakeGitHub({ clock: () => clock.iso, accounts: { [TOKEN]: MIRROR }, repos: [REPO] });
  const address = await many.listen();
  try {
    const since = clock.iso;
    for (let i = 0; i < 130; i++) many.open(REPO, JANE, { title: `Issue ${i}` });
    const issues = await new GitHubTracker({ api: address, token: TOKEN, repo: REPO }).changed(since);
    assert.equal(issues.length, 130);
  } finally {
    await many.close();
  }
});

test('a comment is written on the issue', async () => {
  const made = await tracker.create({ title: 'Commented', body: '', labels: [], status: 'Todo' });
  await tracker.comment(made.id, 'Ready to Ship is given in Cleared.');
  assert.deepEqual(fake.comments.get(Number(made.id)), [{ body: 'Ready to Ship is given in Cleared.', user: 'cleared-bot' }]);
});

test('an answer GitHub refuses is a TrackerError that names the request, never the token', async () => {
  const unknown = randomBytes(16).toString('hex');
  const wrong = new GitHubTracker({ api, token: unknown, repo: REPO });
  await assert.rejects(wrong.changed(clock.iso), (error: unknown) =>
    error instanceof TrackerError && /401/.test(error.message) && /GET/.test(error.message) && !error.message.includes(unknown));
  const missing = new GitHubTracker({ api, token: TOKEN, repo: 'org/missing' });
  await assert.rejects(missing.create({ title: 'x', body: '', labels: [], status: 'Todo' }), (error: unknown) => error instanceof TrackerError && /404/.test(error.message));
});
