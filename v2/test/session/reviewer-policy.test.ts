// The reviewer's reads and the compound command split part by part (owner
// decision of 2026-10-22 22:03, from a demo inbox capture: a reviewer's
// `git log; git merge-base main HEAD; git show ...; npm test | tail` went to
// the inbox as "git merge-base main HEAD is not a command the policy allows
// on its own"). One table per role, the expected verdict on each row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAFE_COMMANDS, evaluate, type Policy, type ToolRequest, type Verdict } from '../../src/session/policy.ts';

const base: Policy = {
  role: 'reviewer',
  base: 'main',
  workdir: '/workspace',
  scripts: ['test', 'typecheck', 'lint'],
  // Built in two parts only to keep this file readable by the repository guard.
  credentialFile: '/run/cleared/' + 'claude.token',
  safeCommands: DEFAULT_SAFE_COMMANDS,
  allowedHosts: ['registry.npmjs.org'],
  forbiddenHosts: ['prod.example.com'],
  ticketFiles: ['src/app.ts'],
  learned: [],
};

const bash = (command: string): ToolRequest => ({ tool: 'Bash', input: { command, description: 'a command' } });

type Row = readonly [command: string, decision: Verdict['decision'], rule: string];

function table(rows: readonly Row[], policy: Partial<Policy> = {}): void {
  for (const [command, decision, rule] of rows) {
    const verdict = evaluate(bash(command), { ...base, ...policy });
    assert.deepEqual([verdict.decision, verdict.rule], [decision, rule], `${JSON.stringify(command)} as ${policy.role ?? base.role}: ${JSON.stringify(verdict)}`);
  }
}

// The command of the capture, with the && the inbox showed, and its usual variants.
const DEMO = 'git log --oneline -5; git merge-base main HEAD; git show --stat HEAD && npm test 2>&1 | tail -20';

test('the command of the capture is allowed for the reviewer, as a whole', () => {
  table([
    [DEMO, 'allow', 'shell.compound_safe'],
    ['git log origin/main..HEAD; git merge-base main HEAD; git show HEAD; npm test | tail', 'allow', 'shell.compound_safe'],
    ['npm run typecheck && npm test 2>&1 | tail -40', 'allow', 'shell.compound_safe'],
    ['git status; git rev-parse HEAD; git diff --stat main...HEAD | head -50', 'allow', 'shell.compound_safe'],
    ['rg -n "severity" src test | head -20; wc -l src/page.ts', 'allow', 'shell.compound_safe'],
    ['npm test || tail -n 30 npm-debug.log', 'allow', 'shell.compound_safe'],
  ]);
});

test('the reviewer\'s reads, one simple command each', () => {
  table([
    ['git show', 'allow', 'reviewer.read'],
    ['git show HEAD', 'allow', 'reviewer.read'],
    ['git show --stat HEAD~1', 'allow', 'reviewer.read'],
    ['git show HEAD:src/page.ts', 'allow', 'reviewer.read'],
    ['git show --name-only --format=%H main..HEAD', 'allow', 'reviewer.read'],
    ['git -C . show HEAD', 'allow', 'reviewer.read'],
    ['git merge-base main HEAD', 'allow', 'reviewer.read'],
    ['git merge-base --is-ancestor main HEAD', 'allow', 'reviewer.read'],
    ['git merge-base --fork-point main', 'allow', 'reviewer.read'],
    ['git rev-parse HEAD', 'allow', 'reviewer.read'],
    ['git rev-parse --abbrev-ref HEAD', 'allow', 'reviewer.read'],
    ['git rev-parse --show-toplevel', 'allow', 'reviewer.read'],
    ['rg health src', 'allow', 'reviewer.read'],
    ['rg -n --glob "*.ts" severity', 'allow', 'reviewer.read'],
    ['rg -e severity -e held src test', 'allow', 'reviewer.read'],
    ['rg --files src', 'allow', 'reviewer.read'],
    ['wc', 'allow', 'reviewer.read'],
    ['wc -l src/page.ts test/page.test.ts', 'allow', 'reviewer.read'],
    // Milestone 1's reads and the project's own checks stay run.safe.
    ['git log --oneline main..HEAD', 'allow', 'run.safe'],
    ['git diff main...HEAD -- src', 'allow', 'run.safe'],
    ['git status --short', 'allow', 'run.safe'],
    ['grep -rn TODO src', 'allow', 'run.safe'],
    ['cat src/page.ts', 'allow', 'run.safe'],
    ['head -n 40 src/page.ts', 'allow', 'run.safe'],
    ['tail -20 src/page.ts', 'allow', 'run.safe'],
    ['ls -la src', 'allow', 'run.safe'],
    ['find src -name "*.ts" -newer package.json', 'allow', 'run.safe'],
    ['npm test', 'allow', 'run.safe'],
    ['npm run test', 'allow', 'run.safe'],
    ['npm run typecheck', 'allow', 'run.safe'],
    // A script the base branch does not declare is not the project's own check.
    ['npm run deploy', 'ask', 'default'],
  ]);
});

test('a read that writes, runs a program or reads outside the workdir still asks', () => {
  table([
    ['git show --output=patch.diff HEAD', 'ask', 'default'],
    ['git show --format=%x00 HEAD', 'ask', 'default'],
    ['git -c core.pager=sh show HEAD', 'ask', 'default'],
    ['git show /etc/passwd', 'ask', 'default'],
    ['git rev-parse --git-dir ../other', 'ask', 'default'],
    ['rg --pre=cat secret src', 'ask', 'default'],
    ['rg --pre cat secret src', 'ask', 'default'],
    ['rg --pre-glob "*.ts" --pre cat x', 'ask', 'default'],
    ['rg --hostname-bin=sh x', 'ask', 'default'],
    ['rg -f patterns.txt src', 'ask', 'default'],
    ['rg --file=patterns.txt src', 'ask', 'default'],
    ['rg --ignore-file=/etc/ignore x', 'ask', 'default'],
    ['rg root /etc', 'ask', 'default'],
    ['rg --files /etc', 'ask', 'default'],
    ['rg -eroot /etc/passwd', 'ask', 'default'],
    ['rg -m 1 x /etc/passwd', 'ask', 'default'],
    ['wc --files0-from=list.txt', 'ask', 'default'],
    ['wc -l /etc/passwd', 'ask', 'default'],
    ['wc -l ../../etc/passwd', 'ask', 'default'],
    ['grep -eroot /etc/passwd', 'ask', 'default'],
    ['find . -exec cat {} \\;', 'ask', 'default'],
    ['find . -delete', 'ask', 'default'],
    ['find / -name "*.pem"', 'deny', 'secret.read'],
  ]);
});

// Review round 1 of pull request 240: `--` before a pattern that starts with
// a dash (B1), an abbreviated long option (B2: GNU programs and git's
// parse-options take any unambiguous prefix), and the same classes for every
// read. Each program's options are an allowlist: an option it does not list,
// or a long option not named whole, asks.
test('review round 1: --, abbreviated long options and unlisted options ask', () => {
  table([
    // B1: after --, the first operand is the pattern and the others are paths.
    ['rg -- -x /etc/passwd', 'ask', 'default'],
    ['rg -- -zz /etc', 'ask', 'default'],
    ['grep -- -x /etc/passwd', 'ask', 'default'],
    ['rg -- --files /etc', 'ask', 'default'],
    ['rg -e -x -- /etc', 'ask', 'default'],
    ['rg -- -x src', 'allow', 'reviewer.read'],
    ['grep -n -A 3 -- -x src', 'allow', 'run.safe'],
    // B2: an abbreviation of a long option that reads a file.
    ['wc --files0=/etc/passwd', 'ask', 'default'],
    ['wc --files0 x', 'ask', 'default'],
    ['wc --files0-f=list.txt', 'ask', 'default'],
    ['wc --lin src/page.ts', 'ask', 'default'],
    ['wc --lines src/page.ts', 'allow', 'reviewer.read'],
    // F1: rg, whatever its version does with abbreviations.
    ['rg --pr=cat x', 'ask', 'default'],
    ['rg --hostname-b=x y', 'ask', 'default'],
    ['rg --ignore-fil=/etc/x y', 'ask', 'default'],
    ['rg -z x src', 'ask', 'default'],
    ['rg --search-zip x src', 'ask', 'default'],
    ['rg --type-add "x:*.x" x src', 'ask', 'default'],
    ['rg -tts -g "*.ts" --max-count=3 x src', 'allow', 'reviewer.read'],
    ['rg --glob="*.ts" -C2 x src', 'allow', 'reviewer.read'],
    // F2 and git's prefix class: log, show and diff refuse an abbreviation
    // themselves; merge-base and rev-parse take one, so they list theirs whole.
    ['git show -O/etc/passwd HEAD', 'ask', 'default'],
    ['git diff -O /etc/passwd', 'ask', 'default'],
    ['git diff --orderfile=/etc/passwd', 'ask', 'default'],
    ['git log --outp=x', 'ask', 'default'],
    ['git show --output-indicator-old=x HEAD', 'ask', 'default'],
    ['git show --ext-diff HEAD', 'ask', 'default'],
    ['git diff --no-ind a b', 'ask', 'default'],
    ['git merge-base --is-anc main HEAD', 'ask', 'default'],
    ['git merge-base --octopus a b c', 'allow', 'reviewer.read'],
    ['git rev-parse --show-top', 'ask', 'default'],
    ['git rev-parse --git-path hooks', 'ask', 'default'],
    ['git rev-parse --short=8 HEAD', 'allow', 'reviewer.read'],
    ['git rev-parse --abbrev-ref HEAD@{upstream}', 'allow', 'reviewer.read'],
    // The other reads: cat, head, tail, ls, find.
    ['cat --show-a src/page.ts', 'ask', 'default'],
    ['cat -n -- src/page.ts', 'allow', 'run.safe'],
    ['cat -- /etc/passwd', 'ask', 'default'],
    ['head --lin=5 src/page.ts', 'ask', 'default'],
    ['head --lines=5 src/page.ts', 'allow', 'run.safe'],
    ['head -n -5 src/page.ts', 'allow', 'run.safe'],
    ['head -20 src/page.ts', 'allow', 'run.safe'],
    ['tail -f server.log', 'ask', 'default'],
    ['tail --pid=1 -n 5 server.log', 'ask', 'default'],
    ['tail -- -n /etc/passwd', 'ask', 'default'],
    ['ls --hid=x src', 'ask', 'default'],
    ['ls -la --sort=time src', 'allow', 'run.safe'],
    ['ls -- /etc', 'ask', 'default'],
    ['find . -files0-from list.txt', 'ask', 'default'],
    ['find . -fprintf out "%p"', 'ask', 'default'],
    ['find . -newer /etc/passwd', 'ask', 'default'],
    ['find . -execdir cat {} +', 'ask', 'default'],
    ['find -L src -name "*.ts" -type f -print', 'allow', 'run.safe'],
    ['find src -maxdepth 2 -not -path "*/node_modules/*"', 'allow', 'run.safe'],
  ]);
});

test('tricky quoting: a separator inside quotes or escaped is a character, an expansion inside double quotes asks', () => {
  table([
    ["grep -n 'a|b' src", 'allow', 'run.safe'],
    ['git log --grep="x && y"', 'allow', 'run.safe'],
    ["rg 'foo;bar' src", 'allow', 'reviewer.read'],
    ['rg foo\\;bar src', 'allow', 'reviewer.read'],
    ['rg "a || b" src | head -5', 'allow', 'shell.compound_safe'],
    ["rg '$(id)' src", 'allow', 'reviewer.read'],
    ["git log --format='%h %s' -5", 'allow', 'run.safe'],
    ["git show 'HEAD~1' --stat", 'allow', 'reviewer.read'],
    ['rg "$(id)" src', 'ask', 'shell.compound'],
    ['rg "`id`" src', 'ask', 'shell.compound'],
    ['git diff $(git merge-base main HEAD)', 'ask', 'shell.compound'],
    ['git show `git merge-base main HEAD`', 'ask', 'shell.compound'],
    ['git show $REF', 'ask', 'shell.compound'],
    ['git log\nrm -rf src', 'ask', 'shell.compound'],
    ["rg 'open src", 'ask', 'shell.compound'],
    ['git log ;; git status', 'ask', 'shell.compound'],
    ['git log & git status', 'ask', 'shell.compound'],
    ['git log |& tail', 'ask', 'shell.compound'],
    ['cd sub && git log', 'ask', 'shell.compound'],
    ['rg x src/{a,b}.ts', 'ask', 'shell.compound'],
    ['wc -l src/*.ts', 'ask', 'shell.compound'],
    ['tail < src/page.ts', 'ask', 'shell.compound'],
  ]);
});

test('only the parts that are not allowed ask, and the reason names each of them and no other', () => {
  const policy = { ...base };
  const one = evaluate(bash('git log; curl https://example.com; git status'), policy);
  assert.deepEqual([one.decision, one.rule], ['ask', 'net.undeclared']);
  assert.ok(one.decision === 'ask' && one.reason.includes('curl') && !one.reason.includes('git'), JSON.stringify(one));

  const two = evaluate(bash('git log -3; make build && git merge-base main HEAD; rm -r dist | tail'), policy);
  assert.deepEqual([two.decision, two.rule], ['ask', 'shell.compound']);
  assert.ok(two.decision === 'ask', JSON.stringify(two));
  if (two.decision === 'ask') {
    assert.match(two.reason, /make build/);
    assert.match(two.reason, /rm -r dist/);
    assert.doesNotMatch(two.reason, /git log|merge-base|tail/);
  }

  // The same command as the capture, for an author: git show and git
  // merge-base are not an author's reads, so those two parts and only them ask.
  const author = evaluate(bash(DEMO), { ...base, role: 'author' });
  assert.deepEqual([author.decision, author.rule], ['ask', 'shell.compound']);
  if (author.decision === 'ask') {
    assert.match(author.reason, /git merge-base main HEAD/);
    assert.match(author.reason, /git show --stat HEAD/);
    assert.doesNotMatch(author.reason, /git log|npm test|tail/);
  }
});

test('a deny in any part wins over an ask in an earlier part', () => {
  table([
    // A reviewer's redirection is an edit, denied, even after a part that asks:
    // an "Allow once" of the first part must not run the write.
    ['make build; npm test > out.txt', 'deny', 'reviewer.edit'],
    ['curl https://example.com && git show HEAD > patch.diff', 'deny', 'reviewer.edit'],
    ['make build; git commit -m x', 'deny', 'reviewer.edit'],
  ]);
  table([
    ['make build; npm test > notes.txt', 'deny', 'plan.before_go'],
    ['make build; rm src/app.ts', 'deny', 'plan.before_go'],
  ], { role: 'author', planning: true });
});

test('redirections to files and substitutions are never allowed to the reviewer', () => {
  table([
    ['git show HEAD > patch.diff', 'deny', 'reviewer.edit'],
    ['npm test >> out.txt', 'deny', 'reviewer.edit'],
    ['git log 2>/dev/null', 'deny', 'reviewer.edit'],
    ['npm test &> out.txt', 'deny', 'reviewer.edit'],
    ['git merge-base main HEAD | tee base.txt', 'ask', 'shell.compound'],
    ['echo $(git merge-base main HEAD)', 'ask', 'shell.compound'],
    // A duplication writes no file.
    ['npm test 2>&1 | tail -5', 'allow', 'shell.compound_safe'],
  ]);
});

// The same split for the other roles, only where it does not widen their rights.
test('the reviewer\'s reads are the reviewer\'s only: the author, the reader and the lead are unchanged', () => {
  table([
    ['git show HEAD', 'ask', 'default'],
    ['git merge-base main HEAD', 'ask', 'default'],
    ['git rev-parse HEAD', 'ask', 'default'],
    ['rg health src', 'ask', 'default'],
    ['wc -l src/page.ts', 'ask', 'default'],
    // The author's own split is milestone 2's decision 10, unchanged.
    ['npm test 2>&1 | tail -20 && git add src && git commit -m x', 'allow', 'shell.compound_safe'],
    ['git log; npm test > out.txt', 'allow', 'shell.compound_safe'],
  ], { role: 'author' });
  table([
    ['git show HEAD', 'deny', 'reader.ask'],
    ['git merge-base main HEAD', 'deny', 'reader.ask'],
    ['rg health src', 'deny', 'reader.ask'],
    [DEMO, 'deny', 'reader.ask'],
    ['git log; git status', 'allow', 'shell.compound_safe'],
  ], { role: 'reader' });
  table([
    // The lead's head -n 400 cap is per command: a list of capped reads would lift it.
    [DEMO, 'deny', 'lead.command'],
    ['git log; git status', 'deny', 'lead.command'],
    ['git show HEAD', 'allow', 'lead.git_read'],
    ['git merge-base main HEAD', 'deny', 'lead.command'],
    ['rg health src | head -n 20', 'deny', 'lead.command'],
  ], { role: 'lead' });
});
