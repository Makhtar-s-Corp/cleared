// What a token may do on one repository (issues #503 and #506). A token that can
// list a repository may still be unable to push to it, and that used to be found
// out at the publication, once the author and the reviewer were paid for.
//
// GitHub has no page that says a fine-grained token's own rights: the
// `permissions` of a repository's answer may be the account's (issue #506). So
// the rights are asked of the two requests Cleared needs, in a form that can
// never succeed: a branch at a commit that does not exist, and a pull request
// with no branch. GitHub checks who asks first, so 403 says the token may not,
// and 422 (409 for a repository with no commit yet) says it may and that the
// request itself is wrong. Nothing is written either way. Seen on GitHub on
// 2026-10-31 for a token that may write; the refusal is from GitHub's message
// for a fine-grained token, not from a run with one.
//
// What says nothing of the token (a rate limit, a failure of GitHub, no network)
// is `unknown`, never a refusal. The token travels in the header only.
const TIMEOUT_MS = 15_000;
const NO_COMMIT = '0'.repeat(40);
export const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type WriteRight = 'ok' | 'refused' | 'unknown';
export type WriteAccess = { readonly repository: string; readonly contents: WriteRight; readonly pullRequests: WriteRight };

async function rightOf(response: Response): Promise<WriteRight> {
  const { status } = response;
  if (status === 401 || status === 404) return 'refused';
  if (status === 403) {
    const limited = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
    const message = await response.json().then((body) => String((body as { message?: unknown } | null)?.message ?? ''), () => '');
    return limited || /rate limit/i.test(message) ? 'unknown' : 'refused';
  }
  return status === 409 || status === 422 || (status >= 200 && status < 300) ? 'ok' : 'unknown';
}

export async function checkWriteAccess(input: { readonly fetch: typeof fetch; readonly api: string; readonly token: string; readonly repository: string; readonly agent: string }): Promise<WriteAccess> {
  const { repository } = input;
  if (!REPOSITORY_NAME.test(repository)) throw new Error('the repository is not owner/name');
  const ask = async (path: string, body: unknown): Promise<WriteRight> => {
    try {
      return await rightOf(await input.fetch(`${input.api}/repos/${repository}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${input.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28', 'user-agent': input.agent },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }));
    } catch {
      return 'unknown';
    }
  };
  const contents = await ask('git/refs', { ref: 'refs/heads/cleared/write-check', sha: NO_COMMIT });
  const pullRequests = await ask('pulls', { title: '', head: '', base: '' });
  return { repository, contents, pullRequests };
}
