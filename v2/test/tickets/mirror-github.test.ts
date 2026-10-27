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

test('a comment is written on the issue, and its id is given back', async () => {
  const made = await tracker.create({ title: 'Commented', body: '', labels: [], status: 'Todo' });
  const id = await tracker.comment(made.id, 'Ready to Ship is given in Cleared.');
  const [written] = fake.comments.get(Number(made.id)) ?? [];
  assert.deepEqual([written?.body, written?.user.login], ['Ready to Ship is given in Cleared.', 'cleared-bot']);
  assert.equal(id, String(written?.id));
});

test('the repository\'s comments since a time, each with its issue, who wrote it and when', async () => {
  clock.tick(60);
  const made = await tracker.create({ title: 'Talked about', body: '', labels: [], status: 'Todo' });
  clock.tick();
  const before = fake.comment(REPO, Number(made.id), JANE, 'Too early');
  clock.tick();
  const since = clock.iso;
  clock.tick();
  fake.comment(REPO, Number(made.id), JANE, 'Sort them by date, please.');
  clock.tick();
  fake.comment(REPO, Number(made.id), ACTIONS, 'The checks passed.');
  clock.tick();
  const own = await tracker.comment(made.id, 'Cleared: started.');
  const comments = await tracker.commentsSince(since);
  assert.deepEqual(comments.map((c) => [c.issue, c.body, c.actor, c.who]), [
    [made.id, 'Sort them by date, please.', 'person', 'jane'],
    [made.id, 'The checks passed.', 'agent', 'github-actions[bot]'],
    [made.id, 'Cleared: started.', 'mirror', 'cleared-bot'],
  ]);
  assert.equal(comments.at(-1)?.id, own);
  assert.ok(comments.every((c) => c.id !== String(before.id) && c.at >= since));
  assert.ok(fake.requests.some((r) => r.path.startsWith(`/repos/${REPO}/issues/comments?`) && r.path.includes('since=')), 'one list for the repository');
});

test('an edit writes the title and the body; who changed a title is its renamed event, a body\'s change names no one', async () => {
  clock.tick(60);
  const since = clock.iso;
  const made = await tracker.create({ title: 'Old title', body: 'Old body', labels: [], status: 'Todo' });
  await tracker.edit(made.id, { title: 'Newest entry first', body: 'Sort the entries, newest first.' });
  assert.deepEqual([fake.issue(REPO, Number(made.id)).title, fake.issue(REPO, Number(made.id)).body], ['Newest entry first', 'Sort the entries, newest first.']);
  await tracker.edit(made.id, { body: 'Only the body.' });
  assert.equal(fake.issue(REPO, Number(made.id)).title, 'Newest entry first');
  clock.tick();
  fake.edit(REPO, Number(made.id), JANE, { title: 'Newest entries first', body: 'Jane\'s words.' });
  const issue = (await tracker.changed(since)).find((i) => i.id === made.id);
  assert.deepEqual([issue?.title, issue?.body], ['Newest entries first', 'Jane\'s words.']);
  assert.deepEqual(issue?.edits.map((e) => [e.field, e.actor, e.who]), [['title', 'mirror', 'cleared-bot'], ['title', 'person', 'jane']]);
});

test('an answer GitHub refuses is a TrackerError that names the request, never the token', async () => {
  const unknown = randomBytes(16).toString('hex');
  const wrong = new GitHubTracker({ api, token: unknown, repo: REPO });
  await assert.rejects(wrong.changed(clock.iso), (error: unknown) =>
    error instanceof TrackerError && /401/.test(error.message) && /GET/.test(error.message) && !error.message.includes(unknown));
  const missing = new GitHubTracker({ api, token: TOKEN, repo: 'org/missing' });
  await assert.rejects(missing.create({ title: 'x', body: '', labels: [], status: 'Todo' }), (error: unknown) => error instanceof TrackerError && /404/.test(error.message));
});

// ---- a delegation (C3, P244) ----------------------------------------------

const delegationOf = async (since: string, number: number) => (await tracker.changed(since)).find((i) => i.id === String(number))?.delegation;

test('a delegation: the cleared label on an open issue, whatever its case, read with who put it on and when; gone with the label or once closed', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.open(REPO, JANE, { title: 'Hand it over', labels: ['bug'] });
  assert.equal(await delegationOf(since, issue.number), null, 'no label, no delegation');
  clock.tick();
  const at = clock.iso;
  fake.label(REPO, issue.number, JANE, 'Cleared');
  assert.deepEqual(await delegationOf(since, issue.number), { how: 'label', actor: 'person', who: 'jane', at });
  const read = (await tracker.changed(since)).find((i) => i.id === String(issue.number));
  assert.deepEqual(read?.labels, ['bug', 'Cleared'], 'the label stays a label of the ticket');
  assert.equal(read?.status, 'Todo');
  clock.tick();
  fake.unlabel(REPO, issue.number, JANE, 'Cleared');
  assert.equal(await delegationOf(since, issue.number), null);
  clock.tick();
  fake.label(REPO, issue.number, ACTIONS, 'cleared');
  assert.deepEqual(await delegationOf(since, issue.number), { how: 'label', actor: 'agent', who: 'github-actions[bot]', at: clock.iso }, 'a bot\'s label is an agent\'s');
  clock.tick();
  fake.close_(REPO, issue.number, JANE);
  assert.equal(await delegationOf(since, issue.number), null, 'a closed issue is not handed over');
});

test('a delegation: the issue assigned to the mirror\'s own account; assigned to anyone else, it is not one', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.open(REPO, JANE, { title: 'Assigned' });
  clock.tick();
  fake.assign(REPO, issue.number, JANE, JANE);
  assert.equal(await delegationOf(since, issue.number), null);
  clock.tick();
  const at = clock.iso;
  fake.assign(REPO, issue.number, JANE, MIRROR);
  assert.deepEqual(await delegationOf(since, issue.number), { how: 'assignee', actor: 'person', who: 'jane', at });
  clock.tick();
  fake.label(REPO, issue.number, JANE, 'cleared');
  assert.deepEqual(await delegationOf(since, issue.number), { how: 'label', actor: 'person', who: 'jane', at: clock.iso }, 'the latest of the two');
  clock.tick();
  fake.unlabel(REPO, issue.number, JANE, 'cleared');
  fake.unassign(REPO, issue.number, JANE, MIRROR);
  assert.equal(await delegationOf(since, issue.number), null);
});

test('an issue opened with the label and no event for it is handed over by its author, at its creation', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.open(REPO, JANE, { title: 'Born delegated', labels: ['cleared'] });
  assert.deepEqual(await delegationOf(since, issue.number), { how: 'label', actor: 'person', who: 'jane', at: issue.created_at });
});

test('another delegation label is read in its place', async () => {
  clock.tick(60);
  const since = clock.iso;
  const issue = fake.open(REPO, JANE, { title: 'Another label' });
  clock.tick();
  fake.label(REPO, issue.number, JANE, 'cleared');
  clock.tick();
  fake.label(REPO, issue.number, JANE, 'agent');
  const other = new GitHubTracker({ api, token: TOKEN, repo: REPO, delegationLabel: 'Agent' });
  const read = (await other.changed(since)).find((i) => i.id === String(issue.number));
  assert.deepEqual(read?.delegation, { how: 'label', actor: 'person', who: 'jane', at: clock.iso });
});
