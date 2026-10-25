// What a human types into the web terminal, cut into lines for the journal
// (docs/v2/milestone-2-plan.md, decision 32): a line at each Enter, the rest
// at the close, the line-editing keys applied, the escape sequences left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TypedLines } from '../../src/terminal/lines.ts';

test('a line ends at a carriage return, a line feed, or both once', () => {
  const lines = new TypedLines();
  assert.deepEqual(lines.feed('pwd\r'), ['pwd']);
  assert.deepEqual(lines.feed('git status\r\n'), ['git status']);
  assert.deepEqual(lines.feed('ls\nnpm test\n'), ['ls', 'npm test']);
  assert.equal(lines.rest(), undefined);
});

test('a line typed in several posts is one line, ended by the post that holds the Enter', () => {
  const lines = new TypedLines();
  assert.deepEqual(lines.feed('git '), []);
  assert.deepEqual(lines.feed('pu'), []);
  assert.deepEqual(lines.feed('sh\r'), ['git push']);
});

test('Backspace and Ctrl-U edit the line; arrows and other escapes are left out; Ctrl-C ends it', () => {
  const lines = new TypedLines();
  assert.deepEqual(lines.feed('gti\u007f\u007fit status\r'), ['git status']);
  assert.deepEqual(lines.feed('rm -rf x\u0015ls\r'), ['ls']);
  assert.deepEqual(lines.feed('\u001b[A\u001b[1;5Cecho \u001bOPhi\r'), ['echo hi']);
  assert.deepEqual(lines.feed('sleep 100\u0003'), ['sleep 100^C']);
});

test('what was not ended by an Enter is given at the close', () => {
  const lines = new TypedLines();
  lines.feed('cat notes');
  assert.equal(lines.rest(), 'cat notes');
  assert.equal(lines.rest(), undefined);
});
