// The inbox against the app: the page, its catalog, stylesheet and script are
// served, and each gesture of the screen goes through lane 6's forwarding to
// the service's routes with the signed-in user. The service here is the
// fixture's stand-in, which holds an approval as lane 8's service does.
//
// The plan's proof for this lane: an approval click starts the grace period,
// Undo within it writes nothing, and after it the approval is written for
// the versions shown. Lane 8 holds the grace in the service (decisions log,
// lane 8, choice 3), so the click calls the approval route at once with the
// shown versions, and Undo is the service's Undo route.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, ReleaseItem } from '../../../src/api/types.ts';
import { GRACE_MS, RELEASE_HEAD, inboxFixture, inboxSource } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { ApiError, type ScreenContext } from '../../public/screen.ts';
import { answerRequest, approve, failure, sendBack, undoApproval } from '../../public/screens/inbox.ts';
import { signedIn, startApp, type Running } from '../support.ts';

// The shell's api() as the browser runs it: same origin, the cookie, and the
// anti-forgery token on a write.
function browserApi(app: Running, cookie: string, csrf: string): ScreenContext['api'] {
  return async <T>(path: string, init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {}): Promise<T> => {
    const write = init.method === 'POST';
    const headers: Record<string, string> = { cookie, accept: 'application/json', origin: app.origin, 'sec-fetch-site': 'same-origin' };
    if (write) Object.assign(headers, { 'x-csrf-token': csrf, 'content-type': 'application/json' });
    const response = await fetch(`${app.base}/api/service${path}`, { method: init.method ?? 'GET', headers, body: write ? JSON.stringify(init.body ?? null) : null });
    if (!response.ok) throw new ApiError(response.status, `${path}: ${response.status}`);
    return await response.json() as T;
  };
}

// Timers the test fires by hand, and a clock it moves.
function clock() {
  let now = FIXTURE_NOW.getTime();
  const due: { at: number; run: () => void }[] = [];
  return {
    now: () => new Date(now),
    later: (run: () => void, ms: number) => { due.push({ at: now + ms, run }); },
    advance(ms: number) {
      now += ms;
      for (const timer of due.filter((t) => t.at <= now)) { due.splice(due.indexOf(timer), 1); timer.run(); }
    },
  };
}

async function withApp(run: (context: { app: Running; api: ScreenContext['api']; source: ReturnType<typeof inboxSource>; time: ReturnType<typeof clock>; user: string }) => Promise<void>): Promise<void> {
  const time = clock();
  const source = inboxSource(inboxFixture(FIXTURE_NOW), { now: time.now, later: time.later });
  const app = await startApp({ source });
  try {
    const { cookie, csrf, id } = await signedIn(app);
    await run({ app, api: browserApi(app, cookie, csrf), source, time, user: id });
  } finally {
    await app.close();
  }
}

const releaseOf = async (api: ScreenContext['api']) => (await api<InboxItem[]>('/inbox')).find((i): i is ReleaseItem => i.kind === 'release') as ReleaseItem;

test('an approval click starts the grace, and Undo within it writes nothing', async () => {
  await withApp(async ({ api, source, time, user }) => {
    const release = await releaseOf(api);
    const local = await approve(api, release, time.now());
    assert.deepEqual(local, { kind: 'grace', dueAt: new Date(FIXTURE_NOW.getTime() + GRACE_MS).toISOString() });
    assert.deepEqual(source.calls[0], { method: 'POST', path: '/api/tickets/LOCAL-158/approve', user, body: { requestedAt: release.requestedAt, heads: [{ pr: 42, head: RELEASE_HEAD }] } });
    time.advance(GRACE_MS - 1000);
    await undoApproval(api, release);
    time.advance(5000);
    assert.deepEqual(source.writes, [], 'nothing is written');
    assert.equal((await releaseOf(api)).state, 'waiting', 'the release still waits');
  });
});

test('after the grace the approval is written for the versions shown, by the signed-in user', async () => {
  await withApp(async ({ api, source, time, user }) => {
    const release = await releaseOf(api);
    await approve(api, release, time.now());
    time.advance(GRACE_MS - 1);
    assert.deepEqual(source.writes, [], 'not before the end of the grace');
    time.advance(1);
    assert.deepEqual(source.writes, [{ ticket: 'LOCAL-158', by: user, requestedAt: release.requestedAt, heads: [{ pr: 42, head: RELEASE_HEAD }] }]);
    const late = await undoApproval(api, release).then(() => undefined, (error: unknown) => error);
    assert.deepEqual(failure(late, 'undo'), { key: 'undo_late', settled: false }, 'an Undo after the write is refused, and says it came too late');
  });
});

test('an approval of a version that is no longer the one asked for is refused', async () => {
  await withApp(async ({ api, source, time }) => {
    const release = await releaseOf(api);
    const moved: ReleaseItem = { ...release, heads: [{ pr: 42, head: 'f'.repeat(40) }] };
    const error = await approve(api, moved, time.now()).then(() => undefined, (e: unknown) => e);
    assert.deepEqual(failure(error, 'approve'), { key: 'approve_conflict', settled: false });
    time.advance(GRACE_MS * 2);
    assert.deepEqual(source.writes, []);
  });
});

test('Send back moves the ticket to Todo and the release no longer waits', async () => {
  await withApp(async ({ api, source, user }) => {
    const release = await releaseOf(api);
    await sendBack(api, release);
    assert.deepEqual(source.calls.at(-1), { method: 'POST', path: '/api/tickets/LOCAL-158/move', user, body: { status: 'Todo' } });
    assert.equal((await releaseOf(api)).state, 'handled');
  });
});

test('a permission and a question are answered through the session\'s request route', async () => {
  await withApp(async ({ api, source, user }) => {
    const items = await api<InboxItem[]>('/inbox');
    const permission = items.find((i) => i.kind === 'permission' && i.state === 'waiting') as Extract<InboxItem, { kind: 'permission' }>;
    const question = items.find((i) => i.kind === 'question') as Extract<InboxItem, { kind: 'question' }>;
    await answerRequest(api, permission, { kind: 'reject_once', message: 'use what we have' });
    await answerRequest(api, question, { kind: 'answer', answers: { [question.questions[0]?.question ?? '']: 'Refuse the entry' } });
    assert.deepEqual(source.calls.map((c) => [c.path, c.user]), [
      ['/api/sessions/fixture-author/requests/request-161/answer', user],
      ['/api/sessions/fixture-164/requests/question-164/answer', user],
    ]);
    assert.ok((await api<InboxItem[]>('/inbox')).every((i) => i.kind === 'release' || i.state === 'handled'));
  });
});

test('a request settled without the person, then answered from the inbox, reads as settled (issue 145, item 4)', async () => {
  await withApp(async ({ api, source }) => {
    const permission = (await api<InboxItem[]>('/inbox')).find((i) => i.kind === 'permission' && i.state === 'waiting') as Extract<InboxItem, { kind: 'permission' }>;
    source.settle(permission.id);                     // the turn was interrupted: the policy cancelled the request
    const error = await answerRequest(api, permission, { kind: 'allow_once' }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError && error.status === 404);
    assert.deepEqual(failure(error, 'answer'), { key: 'answer_settled', settled: true });
  });
});

test('the app serves the inbox page, its catalog, its stylesheet and its script', async () => {
  await withApp(async ({ app }) => {
    const { cookie } = await signedIn(app);
    const get = (path: string) => fetch(`${app.base}${path}`, { headers: { cookie } });
    const page = await get('/inbox');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-screen="inbox"/);
    const catalog = await (await get('/messages/inbox.json')).json() as Record<string, string>;
    assert.equal(catalog.approve, 'Approve the release');
    const css = await get('/screens/inbox.css');
    assert.equal(css.status, 200);
    assert.doesNotMatch(await css.text(), /gradient|prefers-color-scheme/i);
    assert.match(await (await get('/screens/inbox.ts')).text(), /export function mount\(/);
    const shot = await get('/api/service/captures/after-desktop.svg');
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/svg+xml');
  });
});
