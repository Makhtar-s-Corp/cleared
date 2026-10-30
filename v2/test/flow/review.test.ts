import test from 'node:test';
import assert from 'node:assert/strict';
import { authorPrompt, parseVerdict, reviewPrompt, reviewRequestMessage } from '../../src/flow/prompts.ts';

const ticket = { id: 'LOCAL-1', title: 'Newest entry first', body: 'The guestbook lists entries newest first.\n\n- the test proves it' };

test('the author prompt carries the ticket and its criteria, and says what Cleared does after', () => {
  const text = authorPrompt(ticket);
  assert.match(text, /LOCAL-1/);
  assert.match(text, /Newest entry first/);
  assert.match(text, /the test proves it/);
  assert.match(text, /HANDOVER\.md/);
  assert.match(text, /never push/i);
  // The guard refuses a publish whose commit messages carry an address.
  assert.match(text, /no email address/i);
  // A question's declared answer, which its delay applies (issue #290).
  assert.match(text, /end the label of the one you would take with "\(Recommended\)"/);
});

test('the review prompt is the v1 one with the project verdict phrase and the base branch filled in', () => {
  const text = reviewPrompt({ ticket, base: 'main', verdict: 'no blocking issues' });
  assert.match(text, /You review a pull request you did not write/);
  assert.match(text, /git diff main\.\.\.HEAD/);
  assert.match(text, /“fix before merge” or “no blocking issues”/);
  assert.doesNotMatch(text, /@REVIEW_VERDICT@|<base>|\{owner_language\}/);
});

test('the review prompt tells a reviewer it cannot write files and that the final message is the report (issue 139)', () => {
  const text = reviewPrompt({ ticket, base: 'main', verdict: 'no blocking issues' });
  assert.match(text, /do not write HANDOVER\.md/i);
  assert.match(text, /final message must be the full report/i);
  assert.match(text, /if you are asked for HANDOVER\.md/i);
});

test('a pass needs the project phrase on the Verdict line and no "fix before merge"', () => {
  const report = 'Reviewed.\n\nVerdict: “no blocking issues”\nDefects: none\nTo verify: nothing\nQuestions for the user: None.';
  assert.deepEqual(parseVerdict(report, 'no blocking issues'), { verdict: 'pass' });
  assert.deepEqual(parseVerdict('Verdict: fix before merge\nDefects: a.ts:3 wrong', 'no blocking issues'), { verdict: 'changes_requested' });
  assert.deepEqual(parseVerdict('Verdict: No Blocking Issues', 'no blocking issues'), { verdict: 'pass' });
});

test('a verdict line that carries both phrases is not a pass', () => {
  assert.deepEqual(parseVerdict('Verdict: “fix before merge” or “no blocking issues”', 'no blocking issues'), { verdict: 'changes_requested' });
});

test('only the last Verdict line counts, and a phrase elsewhere in the report is not a verdict', () => {
  assert.deepEqual(parseVerdict('Verdict: no blocking issues\nlater thoughts\nVerdict: fix before merge', 'no blocking issues'), { verdict: 'changes_requested' });
  assert.equal(parseVerdict('I found no blocking issues but I forgot the line.', 'no blocking issues'), undefined);
  assert.equal(parseVerdict('', 'no blocking issues'), undefined);
});

test('the message that reopens the author carries the report and the round', () => {
  const text = reviewRequestMessage('Verdict: fix before merge\nDefects: a.ts:3', 1);
  assert.match(text, /round 1/);
  assert.match(text, /a\.ts:3/);
});

// Issue #496: a French interface read plans, reasons and steps in English.
test('the author writes what a person reads in the interface language, in French as in English', () => {
  const ticket = { id: 'LOCAL-1', title: 'A title', body: 'A body' };
  const french = authorPrompt(ticket, { plan: true, report: true }, 'fr');
  assert.match(french, /French/);
  assert.match(french, /plan/i);
  assert.match(french, /confidence/i);
  assert.match(french, /question/i);
  assert.match(french, /HANDOVER/);
  assert.match(authorPrompt(ticket, { plan: true, report: true }, 'en'), /in English/);
  assert.doesNotMatch(authorPrompt(ticket), /interface/, 'no language asked: the prompt as before');
});

test('the reviewer reports in the interface language and keeps the verdict phrase as written', () => {
  const ticket = { id: 'LOCAL-1', title: 'A title', body: '' };
  const french = reviewPrompt({ ticket, base: 'main', verdict: 'no blocking issues', language: 'fr' });
  assert.match(french, /Write in French/);
  assert.doesNotMatch(french, /Write in English/);
  assert.match(french, /“no blocking issues”/);
  assert.match(french, /word for word/);
  assert.match(reviewPrompt({ ticket, base: 'main', verdict: 'no blocking issues' }), /Write in English/);
});
