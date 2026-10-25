// The code a reader's answer cites (P215, issue #331): the mentions found
// in its text, each checked against the commit the reader read, and a
// GitHub link to that commit and those lines built by the service only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CITATIONS, citationsOf, githubLink, mentionsIn, type CiteDeps } from '../../src/reader/citations.ts';
import { ReaderError } from '../../src/reader/target.ts';

const COMMIT = '3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c';
const OTHER = 'a'.repeat(40);

test('a mention is service/path:line or service/path:from-to, for a service of the ask', () => {
  const found = mentionsIn([
    'guestbook/src/page.ts:12 builds the table; `guestbook/src/page.ts:20-24` escapes it.',
    'The filter answers in /workspace/filter-api/src/check.ts:7–9, and billing/src/a.ts:3 is not ours.',
    'Same again: guestbook/src/page.ts:12.',
  ].join('\n'), ['guestbook', 'filter-api']);
  assert.deepEqual(found.map(({ text, service, path, from, to }) => [text, service, path, from, to]), [
    ['guestbook/src/page.ts:12', 'guestbook', 'src/page.ts', 12, 12],
    ['guestbook/src/page.ts:20-24', 'guestbook', 'src/page.ts', 20, 24],
    ['/workspace/filter-api/src/check.ts:7–9', 'filter-api', 'src/check.ts', 7, 9],
  ], 'a service the ask does not read is no citation, and a mention written twice is one');
  assert.ok(found.every((mention) => !mention.bare));
});

test('a mention is not read inside another word, a path outside the service, nor a line 0', () => {
  assert.deepEqual(mentionsIn('see vendor/guestbook/src/page.ts:3, guestbook/../etc/passwd:1, guestbook/src/page.ts:0 and guestbook/src/:4', ['guestbook']), []);
});

test('a bare path:line counts only in an ask of one service, and is marked bare', () => {
  const one = mentionsIn('In src/page.ts:14, and at localhost:8080 nothing.', ['guestbook']);
  assert.deepEqual(one.map(({ text, service, path, from, bare }) => [text, service, path, from, bare]), [
    ['src/page.ts:14', 'guestbook', 'src/page.ts', 14, true],
    ['localhost:8080', 'guestbook', 'localhost', 8080, true],
  ]);
  assert.deepEqual(mentionsIn('In src/page.ts:14.', ['guestbook', 'filter-api']), [], 'which service it is in is a guess');
  assert.deepEqual(mentionsIn('At 10:30 the guestbook/src/page.ts:3 runs.', ['guestbook']).map((m) => m.text), ['guestbook/src/page.ts:3'], 'a time is no path');
});

test('the mentions of an answer are capped', () => {
  const answer = Array.from({ length: MAX_CITATIONS + 5 }, (_, i) => `guestbook/src/page.ts:${i + 1}`).join(' ');
  assert.equal(mentionsIn(answer, ['guestbook']).length, MAX_CITATIONS);
});

test('a GitHub link names the commit and the lines, each part of the path encoded, and only a real repository and commit', () => {
  assert.equal(githubLink({ repo: 'acme/guestbook', commit: COMMIT, path: 'src/page.ts', from: 12, to: 12 }),
    `https://github.com/acme/guestbook/blob/${COMMIT}/src/page.ts#L12`);
  assert.equal(githubLink({ repo: 'acme/mono', commit: COMMIT, path: 'filter api/src/a#b.ts', from: 3, to: 9 }),
    `https://github.com/acme/mono/blob/${COMMIT}/filter%20api/src/a%23b.ts#L3-L9`);
  for (const repo of ['', 'acme', 'acme/guestbook/extra', '../x', 'acme/..', 'https://evil.example/x', 'ac me/x'])
    assert.equal(githubLink({ repo, commit: COMMIT, path: 'a.ts', from: 1, to: 1 }), undefined, repo);
  for (const commit of ['main', 'HEAD', COMMIT.slice(0, 7), `${COMMIT}x`])
    assert.equal(githubLink({ repo: 'acme/guestbook', commit, path: 'a.ts', from: 1, to: 1 }), undefined, commit);
});

function deps(over: Partial<CiteDeps> = {}): CiteDeps & { reads: string[] } {
  const reads: string[] = [];
  const files: Record<string, number> = { [`guestbook@${COMMIT}:src/page.ts`]: 40, [`filter-api@${OTHER}:src/check.ts`]: 9 };
  return {
    reads,
    services: [{ name: 'guestbook', repo: 'acme/guestbook', path: null }, { name: 'filter-api', repo: 'acme/mono', path: 'filter-api' }],
    commits: { guestbook: COMMIT, 'filter-api': OTHER },
    async linesAt(service, commit, path) {
      reads.push(`${service}@${commit}:${path}`);
      const lines = files[`${service}@${commit}:${path}`];
      if (lines === undefined) throw new ReaderError('invalid', `${path} is not a file of ${service}`);
      return lines;
    },
    ...over,
  };
}

test('each citation is checked at the commit the reader read: a link when the file holds the lines, a reason when not', async () => {
  const d = deps();
  const cited = await citationsOf([
    'guestbook/src/page.ts:12-14 builds it,',
    'filter-api/src/check.ts:9 answers,',
    'guestbook/src/page.ts:41 is past the end,',
    'guestbook/src/page.ts:30-20 runs backwards,',
    'guestbook/src/made-up.ts:3 does not exist.',
  ].join(' '), d);
  assert.deepEqual(cited.map(({ text, commit, url, problem }) => [text, commit, url, problem]), [
    ['guestbook/src/page.ts:12-14', COMMIT, `https://github.com/acme/guestbook/blob/${COMMIT}/src/page.ts#L12-L14`, null],
    ['filter-api/src/check.ts:9', OTHER, `https://github.com/acme/mono/blob/${OTHER}/filter-api/src/check.ts#L9`, null],
    ['guestbook/src/page.ts:41', COMMIT, null, 'no_line'],
    ['guestbook/src/page.ts:30-20', COMMIT, null, 'no_line'],
    ['guestbook/src/made-up.ts:3', COMMIT, null, 'no_file'],
  ]);
  assert.deepEqual(cited[0] && { service: cited[0].service, path: cited[0].path, from: cited[0].from, to: cited[0].to }, { service: 'guestbook', path: 'src/page.ts', from: 12, to: 14 });
  assert.equal(d.reads.filter((read) => read === `guestbook@${COMMIT}:src/page.ts`).length, 1, 'a file is read once per answer');
});

test('a bare path is kept only when the commit holds it: anything else may be no citation at all', async () => {
  const cited = await citationsOf('In src/page.ts:14, at localhost:8080, and src/page.ts:99.', { ...deps(), services: [{ name: 'guestbook', repo: 'acme/guestbook', path: null }] });
  assert.deepEqual(cited.map(({ text, url }) => [text, url]), [['src/page.ts:14', `https://github.com/acme/guestbook/blob/${COMMIT}/src/page.ts#L14`]]);
});

test('without a commit or a GitHub repository there is no link; a read that breaks says it was not checked', async () => {
  const noCommit = await citationsOf('guestbook/src/page.ts:3', deps({ commits: {} }));
  assert.deepEqual(noCommit.map(({ commit, url, problem }) => [commit, url, problem]), [[null, null, 'no_file']], 'the folder was not in the base the reader read');
  const noRepo = await citationsOf('guestbook/src/page.ts:3', deps({ services: [{ name: 'guestbook', repo: 'not a repository', path: null }] }));
  assert.deepEqual(noRepo.map(({ url, problem }) => [url, problem]), [[null, 'no_repository']]);
  const broken = await citationsOf('guestbook/src/page.ts:3', deps({ linesAt: async () => { throw new Error('git died'); } }));
  assert.deepEqual(broken.map(({ url, problem }) => [url, problem]), [[null, 'unchecked']]);
});

test('a link the model wrote is never taken: only the service builds one', async () => {
  const cited = await citationsOf('See https://github.com/evil/x/blob/main/a.ts#L1 and [guestbook/src/page.ts:5](https://evil.example/).', deps());
  assert.deepEqual(cited.map(({ text, url }) => [text, url]), [['guestbook/src/page.ts:5', `https://github.com/acme/guestbook/blob/${COMMIT}/src/page.ts#L5`]]);
});
