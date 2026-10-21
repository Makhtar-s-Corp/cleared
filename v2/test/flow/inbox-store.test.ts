import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/store/db.ts';
import { INBOX_TABLE, InboxStore } from '../../src/inbox/store.ts';

function make() {
  const store = openStore(':memory:');
  store.db.exec(INBOX_TABLE);
  let clock = Date.parse('2026-10-21T10:00:00.000Z');
  const inbox = new InboxStore(store.db, () => new Date(clock));
  return { store, inbox, advance: (ms: number) => { clock += ms; } };
}

const permission = { ticket: 'LOCAL-1', project: 'guestbook', sessionId: 's1', requestId: 'r1', tool: 'Bash', input: { kind: 'execute', command: 'touch x' } as const, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule' } as const };

test('a permission item waits, with its session, request and the policy suggestion', () => {
  const { inbox } = make();
  const item = inbox.addPermission(permission);
  assert.equal(item.kind, 'permission');
  assert.equal(item.state, 'waiting');
  assert.equal(item.since, '2026-10-21T10:00:00.000Z');
  assert.deepEqual(inbox.list(), [item]);
  assert.equal(inbox.waitingFor('s1'), 1);
});

test('the same request added twice is one item', () => {
  const { inbox } = make();
  inbox.addPermission(permission);
  inbox.addPermission(permission);
  assert.equal(inbox.list().length, 1);
});

test('a question item keeps its questions; a release item keeps the pull request and the heads it shows', () => {
  const { inbox } = make();
  const question = inbox.addQuestion({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 's1', requestId: 'q1', questions: [{ question: 'Which date format?', options: [{ label: 'ISO' }] }] });
  assert.equal(question.kind, 'question');
  const release = inbox.addRelease({
    ticket: 'LOCAL-1', project: 'guestbook', title: 'Newest first', announcement: 'It sorts.', requestedAt: '2026-10-21T10:05:00.000Z',
    pr: { number: 7, url: 'https://example.invalid/pull/7', checks: 'pending' }, heads: [{ pr: 7, head: 'abc123' }],
    captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 12 }],
  });
  assert.equal(release.kind, 'release');
  assert.deepEqual(release.heads, [{ pr: 7, head: 'abc123' }]);
  // Its checks follow the pull request; nothing else of it changes.
  inbox.setReleaseChecks(release.id, 'passed');
  const after = inbox.list().find((i) => i.kind === 'release') as typeof release;
  assert.deepEqual(after, { ...release, pr: { ...release.pr, checks: 'passed' } });
  assert.equal(inbox.list().length, 2);
});

test('handling an item records who and when, and it stays listed as handled for a day', () => {
  const { inbox, advance } = make();
  const item = inbox.addPermission(permission);
  advance(60_000);
  assert.equal(inbox.handle(item.id, 'u1'), true);
  assert.equal(inbox.handle(item.id, 'u2'), false, 'handled once only');
  const [handled] = inbox.list();
  assert.equal(handled?.state, 'handled');
  assert.equal(inbox.waitingFor('s1'), 0);
  advance(25 * 3600_000);
  assert.deepEqual(inbox.list(), []);
});

test('waiting items come first, oldest first; find locates a request of a session', () => {
  const { inbox, advance } = make();
  const first = inbox.addPermission(permission);
  advance(1000);
  const second = inbox.addPermission({ ...permission, requestId: 'r2' });
  inbox.handle(first.id, 'policy');
  assert.deepEqual(inbox.list().map((i) => i.id), [second.id, first.id]);
  assert.equal(inbox.find('s1', 'r2')?.id, second.id);
  assert.equal(inbox.find('s1', 'nope'), undefined);
});

test('items survive reopening the ledger', () => {
  const { store, inbox } = make();
  inbox.addPermission(permission);
  const again = new InboxStore(store.db, () => new Date());
  assert.equal(again.list().length, 1);
});

test('closing a session handles what it still holds, and a release is found by its ticket', () => {
  const { inbox } = make();
  inbox.addPermission(permission);
  inbox.addPermission({ ...permission, requestId: 'r2' });
  inbox.handleSession('s1', 'policy');
  assert.equal(inbox.waitingFor('s1'), 0);
  const release = inbox.addRelease({ ticket: 'LOCAL-2', project: 'guestbook', title: 't', announcement: 'a', requestedAt: 'x', pr: { number: 1, url: 'u', checks: 'pending' }, heads: [], captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [] });
  assert.equal(inbox.waitingRelease('LOCAL-2')?.id, release.id);
  assert.equal(inbox.waitingRelease('LOCAL-3'), undefined);
});

test('a release remembers the session its approval step runs on', () => {
  const { inbox } = make();
  const release = inbox.addRelease({
    ticket: 'LOCAL-1', project: 'guestbook', title: 't', announcement: 'a', requestedAt: 'x', pr: { number: 1, url: 'u', checks: 'pending' }, heads: [],
    captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
  }, 'reviewer-session');
  assert.equal(inbox.releaseSession(release.id), 'reviewer-session');
  assert.equal(inbox.waitingFor('reviewer-session'), 0, 'it is not a request of that session');
  assert.equal(inbox.releaseSession('nope'), undefined);
});
