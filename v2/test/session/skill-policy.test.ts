// The daily skill ticket's write under .claude/ (O12, milestone 2 decision 27,
// replan question 6 (a)): a policy that carries `skillFile`, the one file the
// ticket asks for, allows an edit of exactly that file with the rule
// `edit.skill`, and nothing else under .claude/. Without it the folder stays
// locked, as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAFE_COMMANDS, evaluate, type Policy, type ToolRequest } from '../../src/session/policy.ts';

const SKILL = '.claude/skills/cleared-guestbook/SKILL.md';

const author = {
  role: 'author', base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: '/run/cleared/' + 'claude.token',
  safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
} satisfies Policy;
const forSkill = { ...author, skillFile: SKILL } as Policy;

const write = (path: string, tool = 'Write'): ToolRequest => ({ tool, input: { file_path: path, content: 'x', old_string: 'a', new_string: 'b' } });
const outcome = (request: ToolRequest, policy: Policy) => {
  const verdict = evaluate(request, policy);
  return [verdict.decision, verdict.rule];
};

test('the skill ticket writes its skill file without asking the owner', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    assert.deepEqual(outcome(write(`/workspace/${SKILL}`, tool), forSkill), ['allow', 'edit.skill'], tool);
  }
  assert.deepEqual(outcome(write(`/workspace/${SKILL}`), author), ['ask', 'default'], 'a ticket that is not the skill ticket still asks');
});

test('nothing else under .claude/ is written, whatever the skill ticket', () => {
  const refused = [
    '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/pre.sh', '.claude/commands/x.md', '.claude/agents/x.md',
    '.claude/skills/cleared-other/SKILL.md', '.claude/skills/cleared-guestbook/other.md', '.claude/skills/cleared-guestbook/scripts/run.sh',
    '.claude/skills/cleared-guestbook/SKILL.md.bak', '.claude/skills/cleared-guestbook/SKILL.md/x', '.claude/skills/SKILL.md',
    'sub/.claude/skills/cleared-guestbook/SKILL.md', '.claude/skills/cleared-guestbook/../../settings.json',
    '.claude/skills/cleared-guestbook/SKILL.md/../../../settings.json', '.claude/skills/./cleared-guestbook/../cleared-x/SKILL.md',
    '.claude/SKILL.md', '.claude', '.claude/', 'CLAUDE.md', '.cursor/cli.json', '.codex/config.toml', '.git/hooks/pre-commit',
  ];
  for (const path of refused) {
    for (const prefix of ['/workspace/', '']) {
      const [decision, rule] = outcome(write(prefix + path), forSkill);
      assert.deepEqual([decision, rule], ['ask', 'default'], `${prefix}${path}`);
    }
  }
  assert.deepEqual(outcome(write('/elsewhere/' + SKILL), forSkill)[0], 'ask', 'outside the workdir');
  assert.deepEqual(outcome(write('/workspace/../' + SKILL), forSkill)[0], 'ask', 'above the workdir');
});

test('the skill file is the only exception: the rest of the ticket is as before, and a shell writes nothing there', () => {
  assert.deepEqual(outcome(write('/workspace/src/app.ts'), forSkill), ['allow', 'edit.workdir']);
  const bash = (command: string): ToolRequest => ({ tool: 'Bash', input: { command } });
  for (const command of [`echo x > ${SKILL}`, `cat a >> ${SKILL}`, `cp a ${SKILL}`, `tee ${SKILL}`, `rm ${SKILL}`, 'echo x > .claude/settings.json'])
    assert.equal(evaluate(bash(command), forSkill).decision, 'ask', command);
  assert.equal(evaluate({ tool: 'NotebookEdit', input: { notebook_path: `/workspace/${SKILL}` } }, forSkill).decision, 'ask', 'a notebook edit is not the skill\'s');
});

test('only an author that is not held writes it: a reviewer, a reader and a plan awaiting its Go do not', () => {
  const request = write(`/workspace/${SKILL}`);
  assert.equal(evaluate(request, { ...forSkill, role: 'reviewer' }).decision, 'deny');
  assert.equal(evaluate(request, { ...forSkill, role: 'reader' }).decision, 'deny');
  assert.deepEqual(outcome(request, { ...forSkill, planning: true }), ['deny', 'plan.before_go']);
});
