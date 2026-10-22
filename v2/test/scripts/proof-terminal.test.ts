// Step 11 of the multi-service proof types its lines in the Shell one at a
// time, each after the one before has answered (lane
// v2-j2-takeover-real-harness): the real run of 2026-10-22 typed `npm test`
// 1.5 s after `git status`, whose "On branch" the tests' output then
// scrolled out of the 21-row terminal before the step looked for it. A
// fresh ticket checkout has no node_modules, so `npm ci` comes before
// `npm test` (the guestbook's tests import pg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_LINES, testOutcome } from '../../scripts/proof-terminal.ts';
import { shellAnswer } from '../../scripts/proof-rehearsal-multi.ts';

test('the Shell\'s lines: git status, then npm ci, then npm test, each waited for before the next', () => {
  assert.deepEqual(SHELL_LINES.map((l) => l.line), ['git status', 'npm ci', 'npm test']);
  const [status, ci, tests] = SHELL_LINES;
  assert.ok(status!.required, 'git status must answer');
  assert.match('On branch cleared/LOCAL-14\nChanges not staged for commit:', status!.done);
  assert.doesNotMatch('fatal: not a git repository', status!.done);
  assert.match('added 14 packages, and audited 15 packages in 3s', ci!.done);
  assert.match('up to date, audited 15 packages in 1s', ci!.done);
  assert.match('npm error code E403', ci!.done);
  assert.match('ℹ tests 41\nℹ suites 0\nℹ pass 39\nℹ fail 2', tests!.done);
  assert.equal(ci!.required, false, 'a red install or test is the author\'s work in progress, not the proof\'s');
  assert.equal(tests!.required, false);
  for (const line of SHELL_LINES) assert.ok(line.timeoutMs >= 30_000);
});

test('what npm test said: the counts of node\'s summary, or that it gave none', () => {
  assert.equal(testOutcome('ℹ tests 41\nℹ pass 39\nℹ fail 2\nℹ cancelled 0'), 'pass 39, fail 2');
  assert.equal(testOutcome('ℹ pass 41\nℹ fail 0'), 'pass 41, fail 0');
  assert.equal(testOutcome('npm error Missing script: "test"'), 'no summary');
  assert.equal(testOutcome(String((shellAnswer('npm test') as { text: string }).text)), 'not run by the rehearsal\'s stand-in shell');
});

test('the rehearsal\'s stand-in shell answers each line in a way the step recognises', () => {
  for (const { line, done } of SHELL_LINES.slice(1)) {
    const answer = shellAnswer(line);
    assert.equal(answer.kind, 'text', line);
    assert.match((answer as { text: string }).text, done, line);
  }
});
