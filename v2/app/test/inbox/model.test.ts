// The inbox's pieces that are not markup: the order, the times, what a
// gesture sends to the service and what it leaves on the screen, and how a
// refusal of the service reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, ReleaseItem } from '../../../src/api/types.ts';
import { RELEASE_HEAD, inboxFixture } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ApiError } from '../../web/lib/screen.ts';
import { since } from '../../web/lib/time.ts';
import { DEFAULT_STATES } from '../../../src/tickets/contract.ts';
import {
  TODO_STATE, answerRequest, answersFor, approve, approveBody, decisionFor, detailKey, failure, itemFromHash, ordered, sameOrigin, sendBack, undoApproval,
  type InboxView,
} from '../../web/screens/inbox/model.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fixture = inboxFixture(FIXTURE_NOW);
const release = fixture.items[0] as ReleaseItem;
const permission = fixture.items[1] as Extract<InboxItem, { kind: 'permission' }>;
const question = fixture.items[2] as Extract<InboxItem, { kind: 'question' }>;

type Sent = { path: string; method: string | undefined; body: unknown };
function fakeApi(answers: Record<string, unknown | Error> = {}) {
  const sent: Sent[] = [];
  const api = async <T>(path: string, init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {}): Promise<T> => {
    sent.push({ path, method: init.method, body: init.body });
    const answer = answers[path];
    if (answer instanceof Error) throw answer;
    return answer as T;
  };
  return { api, sent };
}

test('what waits comes first, releases then permissions then questions, each oldest first; then what was handled', () => {
  const older = { ...permission, id: 'permission:s:older', since: new Date(FIXTURE_NOW.getTime() - 9 * 60_000).toISOString() };
  const { waiting, handled } = ordered([question, permission, fixture.items[3] as InboxItem, release, older]);
  assert.deepEqual(waiting.map((i) => i.id), [release.id, older.id, permission.id, question.id]);
  assert.deepEqual(handled.map((i) => i.id), [(fixture.items[3] as InboxItem).id]);
});

test('elapsed time reads as the capture does, through the app\'s one formatter', () => {
  const at = (ms: number) => new Date(FIXTURE_NOW.getTime() - ms).toISOString();
  assert.equal(since(at(20_000), FIXTURE_NOW, en), 'just now');
  assert.equal(since(at(12 * 60_000), FIXTURE_NOW, en), '12 min');
  assert.equal(since(at(60 * 60_000), FIXTURE_NOW, en), '1h');
  assert.equal(since(at(195 * 60_000), FIXTURE_NOW, en), '3h 15m');
  assert.equal(since(at(50 * 3600_000), FIXTURE_NOW, en), '2d 2h');
  assert.equal(since(at(-60_000), FIXTURE_NOW, en), 'just now', 'a clock a little ahead of ours is not negative');
});

test('the address names the item shown, and a capture is shown only from this site', () => {
  assert.equal(itemFromHash(''), undefined);
  assert.equal(itemFromHash('#'), undefined);
  assert.equal(itemFromHash('#release%3ALOCAL-158%3A42'), 'release:LOCAL-158:42');
  assert.equal(itemFromHash('#permission:s:r'), 'permission:s:r');
  assert.equal(itemFromHash('#%E0%A4%A'), undefined, 'a broken escape names nothing');
  assert.equal(sameOrigin('/api/service/captures/a.svg'), '/api/service/captures/a.svg');
  for (const url of [null, '', '//elsewhere.invalid/a.png', 'https://elsewhere.invalid/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)', '/\\elsewhere'])
    assert.equal(sameOrigin(url), undefined, String(url));
});

test('an approval sends exactly the versions shown, and the click starts the grace the service holds', async () => {
  assert.deepEqual(approveBody(release), { requestedAt: release.requestedAt, heads: [{ pr: 42, head: RELEASE_HEAD }] });
  const dueAt = new Date(FIXTURE_NOW.getTime() + 60_000).toISOString();
  const { api, sent } = fakeApi({ '/tickets/LOCAL-158/approve': { accepted: true, by: 'user-demo', dueAt } });
  const local = await approve(api, release, FIXTURE_NOW);
  assert.deepEqual(local, { kind: 'grace', dueAt });
  assert.deepEqual(sent, [{ path: '/tickets/LOCAL-158/approve', method: 'POST', body: { requestedAt: release.requestedAt, heads: [{ pr: 42, head: RELEASE_HEAD }] } }]);
  const noDue = await approve(fakeApi({ '/tickets/LOCAL-158/approve': { accepted: true, by: 'user-demo' } }).api, release, FIXTURE_NOW);
  assert.deepEqual(noDue, { kind: 'grace', dueAt }, 'an answer without dueAt counts the service\'s 60 seconds from the click');
});

test('the state a release is sent back to is the ticket store\'s Todo', () => {
  assert.equal(TODO_STATE, DEFAULT_STATES.todo);
});

test('Undo calls the service\'s Undo for the ticket, and Send back moves the ticket to Todo', async () => {
  const { api, sent } = fakeApi({ '/tickets/LOCAL-158/approve/undo': { undone: true } });
  await undoApproval(api, release);
  await sendBack(api, release);
  assert.deepEqual(sent.map((s) => [s.path, s.method, s.body]), [
    ['/tickets/LOCAL-158/approve/undo', 'POST', null],
    ['/tickets/LOCAL-158/move', 'POST', { status: 'Todo' }],
  ]);
});

test('an answer goes to the session\'s request, and a deny carries the reason typed or the default one', async () => {
  assert.deepEqual(decisionFor('allow_once', '', en), { kind: 'allow_once' });
  assert.deepEqual(decisionFor('allow_always', 'ignored', en), { kind: 'allow_always', scope: 'project' });
  assert.deepEqual(decisionFor('reject_once', '  use what we have  ', en), { kind: 'reject_once', message: 'use what we have' });
  assert.deepEqual(decisionFor('reject_once', '   ', en), { kind: 'reject_once', message: 'Denied from the inbox. Find another way, or ask in a message.' });
  const { api, sent } = fakeApi();
  const local = await answerRequest(api, permission, { kind: 'allow_once' });
  assert.deepEqual(local, { kind: 'answered', decision: 'allow_once' });
  assert.deepEqual(sent, [{ path: '/sessions/fixture-author/requests/request-161/answer', method: 'POST', body: { decision: { kind: 'allow_once' } } }]);
});

test('a question\'s answers are keyed by the question, a free answer wins, and every question needs one', () => {
  const two = [question.questions[0] as NonNullable<typeof question.questions[0]>, { question: 'Which colours?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] }];
  assert.deepEqual(answersFor(two, [['Refuse the entry'], ['Red', 'Blue']], ['', '']), { answers: { [two[0]!.question]: 'Refuse the entry', 'Which colours?': 'Red, Blue' } });
  assert.deepEqual(answersFor(two, [['Refuse the entry'], []], ['', '  only green  ']), { answers: { [two[0]!.question]: 'Refuse the entry', 'Which colours?': 'only green' } });
  assert.deepEqual(answersFor(two, [['Refuse the entry'], []], ['', '']), { missing: 1 });
  assert.deepEqual(answersFor(two, [['Show “Anonymous” (Recommended)'], ['Red']], ['', '']).answers?.[two[0]!.question], 'Show “Anonymous” (Recommended)', 'the label goes back as the harness wrote it');
});

test('a refusal of the service reads as a sentence, and an answer to a request no longer waiting is settled (issue 145, item 4)', () => {
  assert.deepEqual(failure(new ApiError(404, 'x'), 'answer'), { key: 'answer_settled', settled: true });
  assert.deepEqual(failure(new ApiError(409, 'x'), 'answer'), { key: 'answer_settled', settled: true });
  assert.deepEqual(failure(new ApiError(400, 'x'), 'answer'), { key: 'answer_failed', settled: false });
  assert.deepEqual(failure(new ApiError(403, 'x'), 'approve'), { key: 'approve_owner', settled: false });
  assert.deepEqual(failure(new ApiError(409, 'x'), 'approve'), { key: 'approve_conflict', settled: false });
  assert.deepEqual(failure(new ApiError(503, 'x'), 'approve'), { key: 'approve_setup', settled: false });
  assert.deepEqual(failure(new ApiError(409, 'x'), 'undo'), { key: 'undo_late', settled: false });
  assert.deepEqual(failure(new ApiError(409, 'x'), 'send_back'), { key: 'send_back_conflict', settled: false });
  assert.deepEqual(failure(new TypeError('network'), 'approve'), { key: 'approve_failed', settled: false });
  for (const key of ['answer_settled', 'answer_failed', 'approve_owner', 'approve_conflict', 'approve_setup', 'approve_failed', 'undo_late', 'undo_failed', 'send_back_conflict', 'send_back_failed'])
    assert.ok(en(key).length > 0, key);
});

test('the detail is drawn again when the shown release\'s checks change, and not for a change it does not show', () => {
  const view = (items: readonly InboxItem[]): InboxView => ({
    items, tickets: fixture.tickets, sessions: fixture.sessions, selected: release.id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop',
  });
  const running = { ...release, pr: { ...release.pr, checks: 'pending' as const } };
  const green = { ...release, pr: { ...release.pr, checks: 'passed' as const } };
  assert.notEqual(detailKey(view([running, permission])), detailKey(view([green, permission])), 'the owner waits for green before approving');
  assert.equal(detailKey(view([green, permission])), detailKey(view([green, { ...permission, since: 'later' }])));
});
