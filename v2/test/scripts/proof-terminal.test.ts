// Step 11 of the multi-service proof types its lines in the Shell one at a
// time, each after the one before has answered (lane
// v2-j2-takeover-real-harness): the real run of 2026-10-22 typed `npm test`
// 1.5 s after `git status`, whose "On branch" the tests' output then
// scrolled out of the 21-row terminal before the step looked for it. A
// fresh ticket checkout has no node_modules, so `npm ci` comes before
// `npm test` (the guestbook's tests import pg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_LINES, atPrompt, lineOutcome } from '../../scripts/proof-terminal.ts';
import { shellAnswer } from '../../scripts/proof-rehearsal-multi.ts';

const PROMPT = 'node@5c3a6323c2d6:/workspace$';

test('the Shell\'s lines: git status, then npm ci, then npm test; only git status must answer, with "On branch"', () => {
  assert.deepEqual(SHELL_LINES.map((l) => l.line), ['git status', 'npm ci', 'npm test']);
  const [status, ci, tests] = SHELL_LINES;
  assert.ok(status!.required);
  assert.match('On branch cleared/LOCAL-14\nChanges not staged for commit:', status!.expect as RegExp);
  assert.doesNotMatch('fatal: not a git repository', status!.expect as RegExp);
  assert.equal(ci!.required, false, 'a red install or test is the author\'s work in progress, not the proof\'s');
  assert.equal(tests!.required, false);
  for (const line of SHELL_LINES) assert.ok(line.timeoutMs >= 30_000);
});

test('a line has answered once the prompt is back on the last row', () => {
  assert.equal(atPrompt(`${PROMPT} git status\nOn branch cleared/LOCAL-14\n${PROMPT} `), true);
  assert.equal(atPrompt(`On branch cleared/LOCAL-14\n${PROMPT} npm test`), false, 'just typed');
  assert.equal(atPrompt(`${PROMPT} npm test\n\n> test\n▶ test/server.test.ts\n`), false, 'running');
  assert.equal(atPrompt(`ℹ fail 2\n${PROMPT}\n\n\n`), true, 'empty rows under the prompt');
  assert.equal(atPrompt('rehearsal:/workspace$ '), true, 'the rehearsal\'s stand-in prompt');
});

test('what each line said', () => {
  assert.equal(lineOutcome('npm ci', `added 14 packages, and audited 15 packages in 3s\n${PROMPT}`), 'installed');
  assert.equal(lineOutcome('npm ci', `npm error code E403\n${PROMPT}`), 'failed');
  assert.equal(lineOutcome('npm test', `ℹ tests 41\nℹ pass 39\nℹ fail 2\n${PROMPT}`), 'pass 39, fail 2');
  assert.equal(lineOutcome('npm test', `✖ test/store.test.ts (72ms)\n  'test failed'\n${PROMPT}`), 'some tests failed (the summary scrolled out of the rows)');
  assert.equal(lineOutcome('npm test', PROMPT), 'no summary on the screen');
  for (const line of ['npm ci', 'npm test']) {
    const answer = shellAnswer(line) as { kind: string; text: string };
    assert.equal(answer.kind, 'text', line);
    assert.equal(lineOutcome(line, `${answer.text}\nrehearsal:/workspace$ `), 'not run by the rehearsal\'s stand-in shell', line);
  }
});
