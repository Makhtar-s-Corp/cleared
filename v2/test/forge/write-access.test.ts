// What a token may do on one repository (issues #503 and #506), asked of GitHub
// with requests it refuses in every case: one too invalid to create anything,
// so that the answer says the token's right and nothing is written. Against a
// fake fetch; the granted answers (422) were seen on GitHub on 2026-10-31.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWriteAccess } from '../../src/forge/write-access.ts';

const TOKEN = ['token', 'of', 'the', 'test'].join('-');
type Seen = { url: string; method: string | undefined; body: Record<string, unknown>; auth: string | null };

function answering(refs: () => Response, pulls: () => Response = refs) {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, method: init?.method, body: JSON.parse(String(init?.body ?? '{}')), auth: new Headers(init?.headers).get('authorization') });
    return /\/pulls$/.test(url) ? pulls() : refs();
  };
  return { seen, ask: () => checkWriteAccess({ fetch: fake, api: 'https://api.example', token: TOKEN, repository: 'exemple-org/livre-or', agent: 'cleared-v2-test' }) };
}
const status = (code: number, headers: Record<string, string> = {}, message = 'said') => () => Response.json({ message }, { status: code, headers });

test('a token with both rights: GitHub refuses the requests for what they hold, not for who asks', async () => {
  const { seen, ask } = answering(status(422));
  assert.deepEqual(await ask(), { repository: 'exemple-org/livre-or', contents: 'ok', pullRequests: 'ok' });
  assert.deepEqual(seen.map((one) => [one.method, one.url]), [['POST', 'https://api.example/repos/exemple-org/livre-or/git/refs'], ['POST', 'https://api.example/repos/exemple-org/livre-or/pulls']]);
});

test('nothing can be created: the branch points at no commit, and the pull request names no branch', async () => {
  const { seen, ask } = answering(status(422));
  await ask();
  assert.equal(seen[0]?.body.sha, '0'.repeat(40));
  assert.equal(seen[1]?.body.head, '');
  assert.equal(seen[1]?.body.base, '');
  assert.ok(seen.every((one) => one.auth === `Bearer ${TOKEN}`), 'the token travels in the header');
  assert.ok(seen.every((one) => !JSON.stringify(one.body).includes(TOKEN) && !one.url.includes(TOKEN)), 'and nowhere else');
});

test('each right is said on its own', async () => {
  assert.deepEqual(await answering(status(403), status(422)).ask(), { repository: 'exemple-org/livre-or', contents: 'refused', pullRequests: 'ok' });
  assert.deepEqual(await answering(status(422), status(403)).ask(), { repository: 'exemple-org/livre-or', contents: 'ok', pullRequests: 'refused' });
});

test('a repository the token does not reach, or a token GitHub does not know, is refused', async () => {
  for (const code of [401, 404]) assert.equal((await answering(status(code)).ask()).contents, 'refused', String(code));
});

test('an empty repository answers 409 on its branches: the right is there', async () => {
  assert.equal((await answering(status(409), status(422)).ask()).contents, 'ok');
});

test('what says nothing of the token is never called a refusal: a rate limit, a failure of GitHub, no network', async () => {
  for (const answer of [status(403, { 'x-ratelimit-remaining': '0' }), status(403, { 'retry-after': '60' }), status(403, {}, 'You have exceeded a secondary rate limit'), status(429), status(500), status(502)]) {
    const { contents, pullRequests } = await answering(answer).ask();
    assert.deepEqual([contents, pullRequests], ['unknown', 'unknown']);
  }
  const lost = await checkWriteAccess({ fetch: async () => { throw new Error('no network'); }, api: 'https://api.example', token: TOKEN, repository: 'exemple-org/livre-or', agent: 'cleared-v2-test' });
  assert.deepEqual([lost.contents, lost.pullRequests], ['unknown', 'unknown']);
});

test('a name that is not owner/name is never put in an address', async () => {
  const { seen } = answering(status(422));
  const fake: typeof fetch = async (input) => { seen.push({ url: String(input), method: 'POST', body: {}, auth: null }); return status(422)(); };
  await assert.rejects(checkWriteAccess({ fetch: fake, api: 'https://api.example', token: TOKEN, repository: '../../user', agent: 'cleared-v2-test' }));
  assert.equal(seen.length, 0);
});
