// The names of the test secrets a repository shows it needs (the owner's
// request of 2026-10-30): the setup's secrets step prefills them, and with
// none it says so and skips itself. Read from the base branch with git, as the
// prepared images read it, and only names: an example file's values, a test's
// strings and a workflow's text are never kept or answered.
//
// Three places say a test needs a value: an example environment file, what the
// tests read from the environment, and what the workflows give from their
// secrets. A name counts when it looks like a secret; PORT or NODE_ENV do not.
import { CheckoutError, git } from '../workspace/checkout.ts';

export type ExpectedName = { readonly name: string; readonly from: string };

const ENV_FILES = /(^|\/)\.env\.(example|sample|test|ci|template|dist)$/;
const WORKFLOWS = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TESTS = /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]+|[^/]+_test)\.py$|_test\.go$|_spec\.rb$/;
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|DSN|PRIVATE|CERT/;
// What the platform gives by itself, or Cleared's own.
const NOT_ASKED = /^(GITHUB_|GH_|ACTIONS_|RUNNER_|CI_|CLEARED_|ORCH_|NPM_|NODE_|ANTHROPIC_|CLAUDE_)/;
const MAX_NAMES = 30;
const MAX_FILES = 400;

const NAME = '[A-Z][A-Z0-9_]{2,63}';
const READS = [
  new RegExp(`process\\.env\\.(${NAME})`, 'g'),
  new RegExp(`process\\.env\\[['"\`](${NAME})['"\`]\\]`, 'g'),
  new RegExp(`import\\.meta\\.env\\.(${NAME})`, 'g'),
  new RegExp(`(?:os\\.environ(?:\\.get)?[\\[(]|os\\.getenv\\(|getenv\\(|Getenv\\(|ENV\\[)['"](${NAME})['"]`, 'g'),
];
const ENV_LINE = new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*=`, 'gm');
const WORKFLOW_SECRET = new RegExp(`\\bsecrets\\.(${NAME})\\b`, 'g');

// The names a file shows, by what kind of file it is.
export function namesIn(path: string, text: string): string[] {
  const patterns = ENV_FILES.test(path) ? [ENV_LINE] : WORKFLOWS.test(path) ? [WORKFLOW_SECRET] : TESTS.test(path) ? READS : [];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] as string));
}

export const asked = (name: string): boolean => SECRET_LIKE.test(name) && !NOT_ASKED.test(name);

export async function expectedSecrets(source: { readonly dir: string; readonly base: string; readonly path?: string | null | undefined }): Promise<ExpectedName[]> {
  const at = `refs/remotes/origin/${source.base}`;
  let files: string[];
  try {
    files = (await git(source.dir, ['ls-tree', '-r', '-z', '--name-only', at, ...(source.path ? ['--', source.path] : [])])).split('\0').filter(Boolean);
  } catch (error) {
    if (error instanceof CheckoutError) return [];     // its base is not fetched yet: nothing to read
    throw error;
  }
  const found = new Map<string, string>();
  const wanted = files.filter((file) => ENV_FILES.test(file) || WORKFLOWS.test(file) || TESTS.test(file)).slice(0, MAX_FILES);
  for (const file of wanted) {
    let text: string;
    try { text = await git(source.dir, ['show', `${at}:${file}`]); }
    catch (error) {
      if (error instanceof CheckoutError) continue;
      throw error;
    }
    for (const name of namesIn(file, text)) if (asked(name) && !found.has(name)) found.set(name, file);
    if (found.size >= MAX_NAMES) break;
  }
  return [...found].map(([name, from]) => ({ name, from }));
}
