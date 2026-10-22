// The `service:path:line` a question names, and the lines around it that
// the reader's first turn holds (docs/v2/milestone-2-plan.md, decision 28).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCERPT_CONTEXT, ReaderError, excerpt, parseTarget } from '../../src/reader/target.ts';

const FILE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('a target is a service, a path inside it and a line from 1', () => {
  assert.deepEqual(parseTarget('guestbook:src/page.ts:12'), { service: 'guestbook', path: 'src/page.ts', line: 12 });
  assert.deepEqual(parseTarget('filter-api:contract/openapi.yaml:1'), { service: 'filter-api', path: 'contract/openapi.yaml', line: 1 });
  assert.deepEqual(parseTarget('guestbook:./src/page.ts:3'), { service: 'guestbook', path: 'src/page.ts', line: 3 });
  for (const bad of [
    '', 'guestbook', 'guestbook:src/page.ts', ':src/page.ts:1', 'Guest book:src/page.ts:1', 'guestbook::1',
    'guestbook:../secrets:1', 'guestbook:src/../../x:1', 'guestbook:/etc/hostname:1', 'guestbook:src/page.ts:0',
    'guestbook:src/page.ts:-1', 'guestbook:src/page.ts:1.5', 'guestbook:src/page.ts:12x', 'guestbook:src/page.ts:99999999',
    'guestbook:.:1', 'guestbook:src/\0x:1',
  ]) assert.throws(() => parseTarget(bad), ReaderError, JSON.stringify(bad));
});

test('the excerpt is the named line and ten on each side, numbered, cut at the file\'s ends', () => {
  assert.equal(EXCERPT_CONTEXT, 10);
  const middle = excerpt(FILE, 12);
  assert.equal(middle.from, 2);
  assert.equal(middle.to, 22);
  const lines = middle.text.split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines[0], '    2  line 2');
  assert.equal(lines[10], '>  12  line 12', 'the named line is marked');
  assert.equal(lines[20], '   22  line 22');

  assert.deepEqual([excerpt(FILE, 1).from, excerpt(FILE, 1).to], [1, 11]);
  assert.deepEqual([excerpt(FILE, 40).from, excerpt(FILE, 40).to], [30, 40]);
  assert.deepEqual([excerpt('one\ntwo', 2).from, excerpt('one\ntwo', 2).to], [1, 2], 'a file without a final newline');
  assert.throws(() => excerpt(FILE, 41), ReaderError, 'a line past the end of the file');
  assert.throws(() => excerpt('', 1), ReaderError, 'an empty file');
});
