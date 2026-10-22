// The service's skill (docs/v2/milestone-2-plan.md, decision 27, lane 24):
// `.claude/skills/cleared-<service>/SKILL.md` in the standard skill format,
// written whole by a fast-lane ticket from the knowledge the owner approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSkill, renderSkill, skillName, skillOfTicket, skillPath, skillTicket, type SkillEntry } from '../../src/knowledge/skill.ts';

const ENTRIES: SkillEntry[] = [
  { kind: 'lesson', level: 'service', service: 'filter-api', text: 'Keep words.txt sorted.' },
  { kind: 'decision', level: 'contract', service: 'filter-api', text: 'POST /check answers a severity with every refusal.' },
  { kind: 'decision', level: 'workspace', service: null, text: 'Every service answers /health.' },
  { kind: 'lesson', level: 'workspace', service: null, text: "Run every service's tests before a release." },
  { kind: 'decision', level: 'service', service: 'filter-api', text: 'The words are matched whole.' },
];

test('the skill is named and placed after its service', () => {
  assert.equal(skillName('filter-api'), 'cleared-filter-api');
  assert.equal(skillPath('filter-api'), '.claude/skills/cleared-filter-api/SKILL.md');
  assert.throws(() => skillName('../up'), /not a service name/);
});

test('the skill file has the standard front matter, its sections by level, and the check accepts it', () => {
  const text = renderSkill({ service: 'filter-api', workspace: 'Guestbook', entries: ENTRIES });
  assert.deepEqual(checkSkill(text, 'filter-api'), []);
  const lines = text.split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines[1], 'name: cleared-filter-api');
  assert.match(lines[2] ?? '', /^description: .*Guestbook.*filter-api/);
  assert.equal(lines[3], '---');
  // The levels in order (the workspace, the service, its contracts), decisions before lessons.
  const headings = lines.filter((line) => line.startsWith('#'));
  assert.deepEqual(headings, [
    '# Approved knowledge for filter-api',
    '## The workspace', '### Decisions', '### Lessons',
    '## The service filter-api', '### Decisions', '### Lessons',
    '## The contract of filter-api', '### Decisions',
  ]);
  assert.ok(text.indexOf('- Every service answers /health.') < text.indexOf("- Run every service's tests before a release."));
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
});

test('a level with no entry has no section; no entry at all still makes a valid file', () => {
  const text = renderSkill({ service: 'guestbook', workspace: 'Guestbook', entries: [] });
  assert.deepEqual(checkSkill(text, 'guestbook'), []);
  assert.doesNotMatch(text, /^## /m);
});

test('an entry of several lines stays one list item: a heading or a fence line in it opens nothing', () => {
  const text = renderSkill({ service: 'filter-api', workspace: 'Guestbook', entries: [
    { kind: 'lesson', level: 'service', service: 'filter-api', text: 'Run it twice:\n## Not a section\n---\nthen check.' },
  ] });
  assert.match(text, /^- Run it twice:\n {2}## Not a section\n {2}---\n {2}then check\.$/m);
  assert.deepEqual(checkSkill(text, 'filter-api'), []);
  assert.equal(text.split('\n').filter((line) => line.startsWith('## ')).length, 1);
});

test('the check refuses what the standard format refuses', () => {
  const good = renderSkill({ service: 'filter-api', workspace: 'Guestbook', entries: ENTRIES });
  const swap = (from: string, to: string) => good.replace(from, to);
  assert.match(checkSkill('# no front matter\n', 'filter-api').join(' '), /front matter/);
  assert.match(checkSkill(swap('name: cleared-filter-api', 'name: cleared-guestbook'), 'filter-api').join(' '), /name/);
  assert.match(checkSkill(swap('name: cleared-filter-api', 'name: Cleared_Filter'), 'filter-api').join(' '), /name/);
  assert.match(checkSkill(good.replace(/^description: .*$/m, 'description: '), 'filter-api').join(' '), /description/);
  assert.match(checkSkill(good.replace(/^description: .*$/m, `description: ${'x'.repeat(1025)}`), 'filter-api').join(' '), /description/);
  assert.match(checkSkill(good.replace(/^description: .*$/m, 'description: an <b>xml</b> tag'), 'filter-api').join(' '), /description/);
  assert.match(checkSkill(swap('name: cleared-filter-api\n', 'name: cleared-filter-api\nallowed-tools: Bash\n'), 'filter-api').join(' '), /front matter/);
  assert.match(checkSkill(swap('name: cleared-filter-api\n', 'name: cleared-filter-api\nname: again\n'), 'filter-api').join(' '), /front matter/);
  assert.match(checkSkill(good.split('---\n').slice(0, 2).join('---\n') + '---\n', 'filter-api').join(' '), /body/);
});

test('the ticket asks for the whole file at its path, in a fence longer than any in it', () => {
  const entries: SkillEntry[] = [...ENTRIES, { kind: 'lesson', level: 'service', service: 'filter-api', text: 'Quote it:\n```\nnpm test\n```' }];
  const ticket = skillTicket({ service: 'filter-api', workspace: 'Guestbook', entries, added: 2 });
  assert.equal(ticket.title, 'Update the skill cleared-filter-api (2 new approved entries)');
  assert.match(ticket.body, /`\.claude\/skills\/cleared-filter-api\/SKILL\.md`/);
  assert.match(ticket.body, /Change no other file/);
  assert.match(ticket.body, /^````markdown$/m);
  const file = skillOfTicket(ticket.body);
  assert.equal(file, renderSkill({ service: 'filter-api', workspace: 'Guestbook', entries }));
  assert.deepEqual(checkSkill(file ?? '', 'filter-api'), []);
  assert.equal(skillOfTicket('no file here'), undefined);
  assert.equal(skillTicket({ service: 'filter-api', workspace: 'Guestbook', entries, added: 1 }).title, 'Update the skill cleared-filter-api (1 new approved entry)');
});
