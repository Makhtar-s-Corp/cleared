// The guestbook's heading as the multi-service proof reads it (lane 29, step 4):
// the matcher takes the example page's heading and the counted form, and the
// rehearsal's stand-in prints the counted form for an empty guestbook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GUESTBOOK_HEADING, guestbookHeading } from '../../scripts/proof-guestbook-heading.ts';

test('the matcher takes the bare heading and every counted form', () => {
  assert.ok(GUESTBOOK_HEADING.test('Guestbook'));
  assert.ok(GUESTBOOK_HEADING.test('Guestbook (0 entries)'));
  assert.ok(GUESTBOOK_HEADING.test('Guestbook (1 entry)'));
  assert.ok(GUESTBOOK_HEADING.test('Guestbook (3 entries)'));
});

test('the matcher refuses other headings and words that only start like the name', () => {
  assert.equal(GUESTBOOK_HEADING.test('Sign the guestbook'), false);
  assert.equal(GUESTBOOK_HEADING.test('Guestbookish'), false);
  assert.equal(GUESTBOOK_HEADING.test('The Guestbook'), false);
  assert.equal(GUESTBOOK_HEADING.test(''), false);
});

test('the counted heading reads "1 entry" for one and "entries" otherwise, and the matcher takes it', () => {
  assert.equal(guestbookHeading(0), 'Guestbook (0 entries)');
  assert.equal(guestbookHeading(1), 'Guestbook (1 entry)');
  assert.equal(guestbookHeading(3), 'Guestbook (3 entries)');
  for (const n of [0, 1, 3]) assert.ok(GUESTBOOK_HEADING.test(guestbookHeading(n)));
});
