// What a handover proposes as knowledge (docs/v2/milestone-2-plan.md,
// decision 27, lane 24): its lessons and its decisions, each at its level,
// one entry per top-level list item, read outside fenced code blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISION_HEADINGS, MAX_PROPOSAL, proposalsOf } from '../../src/knowledge/proposals.ts';
import { lessonsOf, sectionsOf } from '../../src/workspace/handover.ts';

const FIVE = ['## Done', 'The severity answer.', '## Tried and failed, and why', 'Nothing.', '## Left to do', 'The page.',
  '## Where the artifacts are (screenshots, logs, branches)', 'cleared/DEMO-8', '## Open questions', 'None.', ''].join('\n');

test('a handover with two lessons and one decision proposes three entries, each at its level', () => {
  const text = `${FIVE}## Lessons for the workspace\nRun every service's tests before a release.\n`
    + '## Lessons for the service\nKeep words.txt sorted.\n'
    + `${DECISION_HEADINGS.contract}\nPOST /check answers a severity with every refusal.\n`;
  assert.deepEqual(proposalsOf(text), [
    { kind: 'lesson', level: 'workspace', text: "Run every service's tests before a release." },
    { kind: 'lesson', level: 'service', text: 'Keep words.txt sorted.' },
    { kind: 'decision', level: 'contract', text: 'POST /check answers a severity with every refusal.' },
  ]);
  assert.deepEqual(DECISION_HEADINGS, { workspace: '## Decisions for the workspace', service: '## Decisions for the service', contract: '## Decisions for the contract' });
});

test('each top-level list item is an entry, with its continuation lines; a paragraph before the list is one too', () => {
  const text = `${FIVE}## Decisions for the service\nThe words are matched whole.\n\n- Words are lower-cased\n  before the match, accents kept.\n  - a nested item stays in its parent\n* The list is read once at start.\n1. A numbered item is an entry.\n`;
  assert.deepEqual(proposalsOf(text).map((p) => p.text), [
    'The words are matched whole.',
    'Words are lower-cased\n  before the match, accents kept.\n  - a nested item stays in its parent',
    'The list is read once at start.',
    'A numbered item is an entry.',
  ]);
});

test('no section, an empty one or the five headings alone propose nothing; another level-two heading ends a section', () => {
  assert.deepEqual(proposalsOf(FIVE), []);
  assert.deepEqual(proposalsOf(`${FIVE}## Lessons for the service\n\n## Decisions for the workspace\n   \n`), []);
  assert.deepEqual(proposalsOf(`${FIVE}## Lessons for the service\nKeep it short.\n## Notes\nNot a lesson.\n`).map((p) => p.text), ['Keep it short.']);
  // A heading counts as the whole line: a longer one is another section.
  assert.deepEqual(proposalsOf(`${FIVE}## Lessons for the service, maybe\nNot filed.\n`), []);
});

test('a heading inside a fenced block is text, whatever the fence (issue 206, item 6)', () => {
  // A longer fence holds a shorter one; a tilde fence does not close a backtick one; a fence may be indented up to three spaces.
  const text = `${FIVE}## Lessons for the service\nRun this:\n\n\`\`\`\`md\n\`\`\`\n## Decisions for the workspace\n\`\`\`\n\`\`\`\`\n`
    + '   ~~~\n## Lessons for the workspace\n```\n   ~~~\nAfter the fences.\n';
  const proposals = proposalsOf(text);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.level, 'service');
  assert.match(proposals[0]?.text ?? '', /## Decisions for the workspace[\s\S]*## Lessons for the workspace[\s\S]*After the fences\.$/);
  // The lessons the memory files (lane 19) read the fences the same way.
  assert.deepEqual(lessonsOf(text), { workspace: [], service: [proposals[0]?.text], contract: [] });
  // An unclosed fence runs to the end of the text.
  assert.deepEqual(sectionsOf('## A\n```\n## B\n').map((s) => s.heading), ['## A']);
  // Four spaces is code, not a fence.
  assert.deepEqual(sectionsOf('## A\n    ```\n## B\nb\n').map((s) => s.heading), ['## A', '## B']);
});

test('the same entry twice at one level is proposed once; at two levels, twice', () => {
  const text = `${FIVE}## Lessons for the service\n- Keep words.txt sorted.\n- Keep words.txt sorted.\n## Lessons for the workspace\nKeep words.txt sorted.\n`;
  assert.deepEqual(proposalsOf(text).map((p) => [p.level, p.text]), [['service', 'Keep words.txt sorted.'], ['workspace', 'Keep words.txt sorted.']]);
});

test('an entry longer than the limit is cut, and says so', () => {
  const long = 'word '.repeat(MAX_PROPOSAL);
  const [only] = proposalsOf(`${FIVE}## Lessons for the workspace\n${long}\n`);
  assert.ok(only);
  assert.ok(only.text.length <= MAX_PROPOSAL + 60);
  assert.match(only.text, /\[cut at 4000 characters\]$/);
  assert.equal(MAX_PROPOSAL, 4000);
});

test('line endings are normalised', () => {
  assert.deepEqual(proposalsOf(`${FIVE}## Lessons for the service\n- One.\n- Two.\n`.replace(/\n/g, '\r\n')).map((p) => p.text), ['One.', 'Two.']);
});
