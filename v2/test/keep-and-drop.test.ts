// B6.4 (issue #382): every removal of docs/v2/keep-and-drop.md is done. The
// page is read as it is: a `drop` row with M4 removes its path, an `adapt`
// file row with M4 removes the file once its kept behaviour is in Node, and
// an `adapt` directory row with M4 removes the children its reason names
// after "M4 removes" (the whole directory when it names none). What is still
// tracked of them is listed below with its reason (docs/v2/milestone-4-plan.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const page = readFileSync(new URL('docs/v2/keep-and-drop.md', `file://${root}`), 'utf8');

type Row = { readonly path: string; readonly verdict: string; readonly reason: string; readonly milestone: string };
const rows: Row[] = page.split('\n').flatMap((line) => {
  const cells = /^\| `([^`]+)` \| (keep|adapt|drop) \| (.*) \| (M4|-) \| (decided|proposed) \|$/.exec(line);
  return cells ? [{ path: cells[1]!, verdict: cells[2]!, reason: cells[3]!, milestone: cells[4]! }] : [];
});

// The paths milestone 4 removes, as the page names them.
function removed(): string[] {
  return rows.filter((row) => row.milestone === 'M4' && row.verdict !== 'keep').flatMap((row) => {
    if (row.verdict === 'drop' || !row.path.endsWith('/')) return [row.path];
    const named = /M4 removes (.*?)(?:Edited in place|$)/.exec(row.reason)?.[1] ?? '';
    const children = [...named.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    return children.length > 0 ? children.map((child) => row.path + child) : [row.path];
  });
}

// Still tracked, with why (each one is a step of the plan, or a question). None since the v1 passkeys went
// (issue #389, section 6 of the plan).
const STILL: ReadonlyMap<string, string> = new Map();

const under = (path: string) => (file: string) => (path.endsWith('/') ? file.startsWith(path) : file === path);

test('the page names the removals this test reads', () => {
  const paths = removed();
  for (const path of ['adapters/', 'flow-lanes.sh', 'merge-pr.sh', 'lib/common.sh', 'app/lib/webauthn.mjs', 'lib/tracker/adapters/linear.sh', 'prompts/events/', 'serve/serve-dashboard.mjs']) {
    assert.ok(paths.includes(path), path);
  }
  assert.ok(!paths.includes('app/lib/actions.ts'), 'an adapt directory row removes only the children it names');
});

test('nothing keep-and-drop.md removes in milestone 4 is tracked, but what the plan keeps for now', () => {
  const left = removed().flatMap((path) => tracked.filter(under(path))).filter((file) => !STILL.has(file));
  assert.deepEqual([...new Set(left)].sort(), []);
});

test('every file kept for now is still tracked, so the list says what is left', () => {
  assert.deepEqual([...STILL.keys()].filter((file) => !tracked.includes(file)), []);
});

// Issue #389: the page names the v1 passkey files as they were before step d (`.mjs`); their TypeScript names
// are checked here.
test('the v1 passkey files are gone, under either name', () => {
  const passkeys = ['app/lib/webauthn', 'app/lib/grant-socket', 'test/app-authenticator'].flatMap((name) => [`${name}.mjs`, `${name}.ts`]);
  assert.deepEqual(tracked.filter((file) => [...passkeys, 'app/public/register.html', 'app/public/register.js'].includes(file)), []);
});
