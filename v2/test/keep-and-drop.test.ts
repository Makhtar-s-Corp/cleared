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

// Still tracked, with why (each one is a step of the plan, or a question).
const STILL: ReadonlyMap<string, string> = new Map([
  // Step c: the rest of the kept bash.
  ['wake.sh', 'step c'],
  ['lib/ports.sh', 'step c'],
  ['serve/install.sh', 'step c'],
  ['lib/common.sh', 'step c'],
  // Question 1 of the plan, default (a): the passkey files stay with the v1 app (B5.9d).
  ['app/lib/webauthn.mjs', 'passkeys'],
  ['app/lib/grant-socket.mjs', 'passkeys'],
  ['app/public/register.html', 'passkeys'],
  ['app/public/register.js', 'passkeys'],
  ['test/app-authenticator.mjs', 'passkeys'],
]);

const under = (path: string) => (file: string) => (path.endsWith('/') ? file.startsWith(path) : file === path);

test('the page names the removals this test reads', () => {
  const paths = removed();
  for (const path of ['adapters/', 'flow-lanes.sh', 'merge-pr.sh', 'lib/common.sh', 'app/lib/webauthn.mjs', 'lib/tracker/adapters/linear.sh', 'prompts/events/', 'serve/serve-dashboard.mjs']) {
    assert.ok(paths.includes(path), path);
  }
  assert.ok(!paths.includes('app/lib/actions.mjs'), 'an adapt directory row removes only the children it names');
});

test('nothing keep-and-drop.md removes in milestone 4 is tracked, but what the plan keeps for now', () => {
  const left = removed().flatMap((path) => tracked.filter(under(path))).filter((file) => !STILL.has(file));
  assert.deepEqual([...new Set(left)].sort(), []);
});

test('every file kept for now is still tracked, so the list says what is left', () => {
  assert.deepEqual([...STILL.keys()].filter((file) => !tracked.includes(file)), []);
});
