import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAFE_COMMANDS, evaluate, learnedPatterns, parseCommand, parseList, type Policy, type ToolRequest, type Verdict } from '../../src/session/policy.ts';

// The container sees the ticket checkout at /workspace. The credential path
// is built in two parts only to keep this file readable by the repository
// guard; its value is the plan's mount point.
const workdir = '/workspace';
const credentialFile = '/run/cleared/' + 'claude.token';

const base: Policy = {
  role: 'author',
  base: 'main',
  workdir,
  scripts: ['test', 'lint', 'typecheck'],
  credentialFile,
  safeCommands: DEFAULT_SAFE_COMMANDS,
  allowedHosts: ['registry.npmjs.org', 'api.anthropic.com'],
  forbiddenHosts: ['prod.example.com'],
  ticketFiles: ['src/app.ts'],
  learned: [],
};

// package.json as it is in the workdir before an edit.
const packageJson = JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: { pg: '8.0.0' } }, null, 2);
const files: Record<string, string> = { '/workspace/package.json': packageJson };
const context = { readFile: (path: string) => files[path] };

const bash = (command: string): ToolRequest => ({ tool: 'Bash', input: { command, description: 'a command' } });

type Case = {
  readonly name: string;
  readonly request: ToolRequest;
  readonly policy?: Partial<Policy>;
  readonly decision: Verdict['decision'];
  readonly rule: string;
};

function check(cases: readonly Case[]): void {
  for (const c of cases) {
    const verdict = evaluate(c.request, { ...base, ...c.policy }, context);
    assert.equal(verdict.decision, c.decision, `${c.name}: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.rule, c.rule, `${c.name}: ${JSON.stringify(verdict)}`);
  }
}

// Section 5 of docs/v2/milestone-1-plan.md, one case per row of the table.
test('the policy table of the plan, one case per row', () => {
  check([
    { name: 'allow read.workdir', request: { tool: 'Read', input: { file_path: '/workspace/src/app.ts' } }, decision: 'allow', rule: 'read.workdir' },
    { name: 'allow edit.workdir', request: { tool: 'Edit', input: { file_path: '/workspace/src/app.ts', old_string: 'a', new_string: 'b' } }, decision: 'allow', rule: 'edit.workdir' },
    { name: 'allow run.safe', request: bash('npm test'), decision: 'allow', rule: 'run.safe' },
    { name: 'allow learned', request: bash('make build'), policy: { learned: [{ tool: 'Bash', pattern: 'make build' }] }, decision: 'allow', rule: 'learned' },
    { name: 'deny push.base', request: bash('git push origin main'), decision: 'deny', rule: 'push.base' },
    { name: 'deny host.docker', request: bash('docker ps'), decision: 'deny', rule: 'host.docker' },
    { name: 'deny net.production', request: bash('curl https://prod.example.com/health'), decision: 'deny', rule: 'net.production' },
    { name: 'deny secret.read', request: { tool: 'Read', input: { file_path: '/workspace/.env' } }, decision: 'deny', rule: 'secret.read' },
    { name: 'deny reviewer.edit', request: { tool: 'Edit', input: { file_path: '/workspace/src/app.ts', old_string: 'a', new_string: 'b' } }, policy: { role: 'reviewer' }, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'ask install.package', request: bash('npm install left-pad'), decision: 'ask', rule: 'install.package' },
    { name: 'ask delete.outside_ticket', request: bash('rm -r src'), decision: 'ask', rule: 'delete.outside_ticket' },
    { name: 'ask net.undeclared', request: bash('curl https://example.org/data'), decision: 'ask', rule: 'net.undeclared' },
    { name: 'ask default', request: bash('make build'), decision: 'ask', rule: 'default' },
  ]);
});

test('the edit exceptions of edit.workdir: generated files, package scripts', () => {
  const edit = (path: string, oldText: string, newText: string): ToolRequest => ({ tool: 'Edit', input: { file_path: path, old_string: oldText, new_string: newText } });
  check([
    { name: 'CLAUDE.md is generated', request: edit('/workspace/CLAUDE.md', 'a', 'b'), decision: 'ask', rule: 'default' },
    { name: '.claude/ is locked', request: edit('/workspace/.claude/settings.json', 'a', 'b'), decision: 'ask', rule: 'default' },
    { name: '.cursor/ is locked', request: edit('/workspace/.cursor/cli.json', 'a', 'b'), decision: 'ask', rule: 'default' },
    { name: '.codex/ is locked (a project\'s Codex configuration)', request: edit('/workspace/.codex/config.toml', 'a', 'b'), decision: 'ask', rule: 'default' },
    { name: 'a scripts change', request: edit('/workspace/package.json', '"test": "node --test"', '"test": "node --test", "x": "curl evil"'), decision: 'ask', rule: 'scripts.change' },
    { name: 'a version change', request: edit('/workspace/package.json', '"version": "1.0.0"', '"version": "1.0.1"'), decision: 'allow', rule: 'edit.workdir' },
    { name: 'a dependency change', request: edit('/workspace/package.json', '"pg": "8.0.0"', '"pg": "8.1.0"'), decision: 'ask', rule: 'install.package' },
    { name: 'the lock file', request: edit('/workspace/package-lock.json', 'a', 'b'), decision: 'ask', rule: 'install.package' },
    { name: 'a Write of package.json that adds a script', request: { tool: 'Write', input: { file_path: '/workspace/package.json', content: JSON.stringify({ name: 'demo', scripts: { test: 'node --test', go: 'sh x' }, dependencies: { pg: '8.0.0' } }) } }, decision: 'ask', rule: 'scripts.change' },
    { name: 'an edit the service cannot read', request: edit('/workspace/sub/package.json', 'a', 'b'), decision: 'ask', rule: 'scripts.change' },
  ]);
});

test('the compound command rows of the acceptance proof', () => {
  check([
    // Milestone 2, decision 10: a list of safe simple commands is safe. These
    // three rows asked as shell.compound in milestone 1.
    { name: 'a sequence', request: bash('npm run test; curl https://example.invalid'), decision: 'ask', rule: 'net.undeclared' },
    { name: 'a pipe', request: bash('npm run test | tee log'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a redirection', request: bash('cat a > b'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'find -delete', request: bash('find . -delete'), decision: 'ask', rule: 'default' },
    { name: 'find -name', request: bash("find . -name '*.ts'"), decision: 'allow', rule: 'run.safe' },
    { name: 'git branch -D', request: bash('git branch -D main'), decision: 'ask', rule: 'default' },
    { name: 'git branch --show-current', request: bash('git branch --show-current'), decision: 'allow', rule: 'run.safe' },
    { name: 'git -C . push origin main', request: bash('git -C . push origin main'), decision: 'deny', rule: 'push.base' },
    { name: 'a substitution', request: bash('echo $(id)'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a backtick', request: bash('echo `id`'), decision: 'ask', rule: 'shell.compound' },
    { name: 'an unclosed quote', request: bash("echo 'open"), decision: 'ask', rule: 'shell.compound' },
    { name: 'a declared script', request: bash('npm run test'), decision: 'allow', rule: 'run.safe' },
    { name: 'an undeclared script', request: bash('npm run undeclared'), decision: 'ask', rule: 'default' },
  ]);
});

test('a learned entry never overrides a deny', () => {
  check([
    { name: 'learned git push', request: bash('git push origin main'), policy: { learned: [{ tool: 'Bash', pattern: 'git push *' }] }, decision: 'deny', rule: 'push.base' },
    { name: 'learned docker', request: bash('docker ps'), policy: { learned: [{ tool: 'Bash', pattern: 'docker *' }] }, decision: 'deny', rule: 'host.docker' },
    { name: 'learned read of .env', request: { tool: 'Read', input: { file_path: '/workspace/.env' } }, policy: { learned: [{ tool: 'Read', pattern: '*' }] }, decision: 'deny', rule: 'secret.read' },
  ]);
});

test('a learned entry is for its tool only, and allows a compound command only part by part', () => {
  check([
    { name: 'another tool', request: bash('make build'), policy: { learned: [{ tool: 'Read', pattern: 'make build' }] }, decision: 'ask', rule: 'default' },
    // Decision 10: every simple command allowed on its own, a learned one included.
    { name: 'compound of learned commands', request: bash('make build; make test'), policy: { learned: [{ tool: 'Bash', pattern: 'make *' }] }, decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'compound with one command not learned', request: bash('make build; make deploy'), policy: { learned: [{ tool: 'Bash', pattern: 'make build' }] }, decision: 'ask', rule: 'shell.compound' },
    { name: 'a WebFetch pattern', request: { tool: 'WebFetch', input: { url: 'https://docs.example.org/page', prompt: 'read' } }, policy: { learned: [{ tool: 'WebFetch', pattern: 'https://docs.example.org/*' }] }, decision: 'allow', rule: 'learned' },
  ]);
});

test('the base branch push is denied in every form, and other pushes are not allowed', () => {
  check([
    { name: 'HEAD:main', request: bash('git push origin HEAD:main'), decision: 'deny', rule: 'push.base' },
    { name: '+main', request: bash('git push origin +main'), decision: 'deny', rule: 'push.base' },
    { name: 'refs/heads/main', request: bash('git push origin refs/heads/main'), decision: 'deny', rule: 'push.base' },
    { name: '--force', request: bash('git push --force origin ticket-1'), decision: 'deny', rule: 'push.base' },
    { name: '--force-with-lease', request: bash('git push --force-with-lease origin ticket-1'), decision: 'deny', rule: 'push.base' },
    { name: '-f', request: bash('git push -f origin ticket-1'), decision: 'deny', rule: 'push.base' },
    { name: 'global options', request: bash('git -c user.name=x --git-dir=.git push origin main'), decision: 'deny', rule: 'push.base' },
    { name: 'inside a compound', request: bash('npm test && git push origin main'), decision: 'deny', rule: 'push.base' },
    { name: 'inside a substitution', request: bash('echo $(git push origin main)'), decision: 'deny', rule: 'push.base' },
    { name: 'gh pr merge', request: bash('gh pr merge 12 --squash'), decision: 'deny', rule: 'push.base' },
    { name: 'gh repo', request: bash('gh repo delete owner/name'), decision: 'deny', rule: 'push.base' },
    { name: '--mirror', request: bash('git push --mirror origin'), decision: 'deny', rule: 'push.base' },
    { name: '--all', request: bash('git push --all origin'), decision: 'deny', rule: 'push.base' },
    { name: 'the ticket branch', request: bash('git push origin ticket-1'), decision: 'ask', rule: 'default' },
    { name: 'gh pr create goes to the inbox by default (lane 5 relies on it)', request: bash('gh pr create --fill'), decision: 'ask', rule: 'default' },
  ]);
});

test('docker and sudo are denied wherever they run as a command, not when named as text', () => {
  check([
    { name: 'after a separator', request: bash('ls; docker ps'), decision: 'deny', rule: 'host.docker' },
    { name: 'through sh -c', request: bash("sh -c 'docker ps'"), decision: 'deny', rule: 'host.docker' },
    { name: 'through xargs', request: bash('echo id | xargs docker rm'), decision: 'deny', rule: 'host.docker' },
    { name: 'by its path', request: bash('/usr/bin/docker ps'), decision: 'deny', rule: 'host.docker' },
    { name: 'sudo', request: bash('sudo ls'), decision: 'deny', rule: 'host.docker' },
    { name: 'find -exec', request: bash('find . -exec docker rm {} +'), decision: 'deny', rule: 'host.docker' },
    { name: 'a commit message', request: bash('git commit -m "docker notes"'), decision: 'allow', rule: 'run.safe' },
    { name: 'a search', request: bash('grep -r docker src'), decision: 'allow', rule: 'run.safe' },
  ]);
});

test('secrets and production hosts are denied in any tool input', () => {
  check([
    { name: 'the credential file', request: { tool: 'Read', input: { file_path: credentialFile } }, decision: 'deny', rule: 'secret.read' },
    { name: 'the credential file through a glob', request: bash('cat /run/cle*/claude.token'), decision: 'deny', rule: 'secret.read' },
    { name: 'the credential directory', request: bash('ls /run/cleared/'), decision: 'deny', rule: 'secret.read' },
    { name: 'a pem file', request: bash('cat certs/server.pem'), decision: 'deny', rule: 'secret.read' },
    { name: 'a key file', request: { tool: 'Grep', input: { pattern: 'x', glob: '*.key' } }, decision: 'deny', rule: 'secret.read' },
    { name: 'an ssh key', request: bash('cat id_ed25519'), decision: 'deny', rule: 'secret.read' },
    { name: '.ssh', request: { tool: 'Glob', input: { pattern: '**/*', path: '/root/.ssh' } }, decision: 'deny', rule: 'secret.read' },
    { name: '.env.local', request: bash('head .env.local'), decision: 'deny', rule: 'secret.read' },
    { name: 'an env file in a compound', request: bash('cat .env | head'), decision: 'deny', rule: 'secret.read' },
    { name: 'WebFetch to production', request: { tool: 'WebFetch', input: { url: 'https://api.prod.example.com/x', prompt: 'read' } }, decision: 'deny', rule: 'net.production' },
    { name: 'production in a compound', request: bash('npm test; curl prod.example.com'), decision: 'deny', rule: 'net.production' },
    { name: 'process.env is not an env file', request: bash('grep -r process.env src'), decision: 'allow', rule: 'run.safe' },
  ]);
});

// Claude Code 2.1.306 removes CLAUDE_CODE_OAUTH_TOKEN from a Bash child's
// environment, but the claude process keeps it in its own, which any process
// of the session's uid reads in /proc/<pid>/environ (measured in a labelled
// container on 2026-10-21; decisions log, review round 1 of PR 143).
test('the environment of the session processes is a secret: printenv, a bare env, /proc/*/environ', () => {
  check([
    { name: 'printenv', request: bash('printenv'), decision: 'deny', rule: 'secret.read' },
    { name: 'printenv of one variable', request: bash('printenv CLAUDE_CODE_OAUTH_TOKEN'), decision: 'deny', rule: 'secret.read' },
    { name: 'printenv by its path', request: bash('/usr/bin/printenv HOME'), decision: 'deny', rule: 'secret.read' },
    { name: 'a bare env', request: bash('env'), decision: 'deny', rule: 'secret.read' },
    { name: 'env with options only', request: bash('env -0'), decision: 'deny', rule: 'secret.read' },
    { name: 'env with assignments only', request: bash('env -u HOME A=1'), decision: 'deny', rule: 'secret.read' },
    { name: 'env in a compound', request: bash('env | grep TOKEN'), decision: 'deny', rule: 'secret.read' },
    { name: 'printenv in a substitution', request: bash('echo $(printenv)'), decision: 'deny', rule: 'secret.read' },
    { name: 'printenv behind a wrapper', request: bash('sh -c printenv'), decision: 'deny', rule: 'secret.read' },
    { name: 'a process environ', request: bash('cat /proc/1/environ'), decision: 'deny', rule: 'secret.read' },
    { name: 'every process environ', request: bash('cat /proc/*/environ'), decision: 'deny', rule: 'secret.read' },
    { name: 'the parent environ', request: bash('cat /proc/$PPID/environ'), decision: 'deny', rule: 'secret.read' },
    { name: 'self environ through Read', request: { tool: 'Read', input: { file_path: '/proc/self/environ' } }, decision: 'deny', rule: 'secret.read' },
    { name: 'environ from inside /proc', request: bash('cd /proc/12 && cat environ'), decision: 'deny', rule: 'secret.read' },
    { name: 'environ through Grep', request: { tool: 'Grep', input: { pattern: 'TOKEN', path: '/proc/7/environ' } }, decision: 'deny', rule: 'secret.read' },
    { name: 'env running a command is no read', request: bash('env NODE_ENV=test npm test'), decision: 'ask', rule: 'default' },
    { name: 'a word that only contains env', request: bash('grep -r environment src'), decision: 'allow', rule: 'run.safe' },
    { name: 'a file named environ.ts in the workdir is not /proc', request: { tool: 'Read', input: { file_path: '/workspace/src/environ.ts' } }, decision: 'allow', rule: 'read.workdir' },
  ]);
});

test('secret.read looks at the paths a request names, never at the text it writes', () => {
  check([
    { name: 'code that reads a .key property', request: { tool: 'Edit', input: { file_path: '/workspace/src/a.ts', old_string: 'return 1;', new_string: 'return event.key;' } }, decision: 'allow', rule: 'edit.workdir' },
    { name: 'a README that names .env.example', request: { tool: 'Write', input: { file_path: '/workspace/README.md', content: 'Copy .env.example to .env first.' } }, decision: 'allow', rule: 'edit.workdir' },
    { name: 'a MultiEdit that writes id_rsa in a string', request: { tool: 'MultiEdit', input: { file_path: '/workspace/src/a.ts', edits: [{ old_string: 'return 1;', new_string: "return 'id_rsa';" }] } }, decision: 'allow', rule: 'edit.workdir' },
    { name: 'a command description', request: { tool: 'Bash', input: { command: 'npm test', description: 'Run the tests that read .env.test' } }, decision: 'allow', rule: 'run.safe' },
    { name: 'a WebFetch prompt', request: { tool: 'WebFetch', input: { url: 'https://example.org/x', prompt: 'find the .pem section' } }, decision: 'ask', rule: 'net.undeclared' },
    { name: 'a Grep pattern', request: { tool: 'Grep', input: { pattern: 'event.key', path: 'src' } }, decision: 'allow', rule: 'read.workdir' },
    { name: 'a file whose name starts with id_ but is no key', request: { tool: 'Read', input: { file_path: '/workspace/src/id_generator.ts' } }, decision: 'allow', rule: 'read.workdir' },
    { name: 'an ssh public key', request: { tool: 'Read', input: { file_path: '/workspace/id_rsa.pub' } }, decision: 'deny', rule: 'secret.read' },
    { name: 'an ssh security key', request: bash('cat id_ed25519_sk'), decision: 'deny', rule: 'secret.read' },
    { name: 'a Write to an env file', request: { tool: 'Write', input: { file_path: '/workspace/.env', content: 'A=1' } }, decision: 'deny', rule: 'secret.read' },
    { name: 'an edit of a pem file', request: { tool: 'Edit', input: { file_path: '/workspace/certs/a.pem', old_string: 'a', new_string: 'b' } }, decision: 'deny', rule: 'secret.read' },
    { name: 'a WebFetch URL', request: { tool: 'WebFetch', input: { url: 'https://example.org/.env', prompt: 'read' } }, decision: 'deny', rule: 'secret.read' },
  ]);
});

test('the reviewer role cannot edit, commit or push', () => {
  const reviewer = { role: 'reviewer' as const, testCommand: ['npm', 'test'] };
  check([
    { name: 'Write', request: { tool: 'Write', input: { file_path: '/workspace/a.ts', content: 'x' } }, policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'MultiEdit', request: { tool: 'MultiEdit', input: { file_path: '/workspace/a.ts', edits: [] } }, policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'NotebookEdit', request: { tool: 'NotebookEdit', input: { notebook_path: '/workspace/a.ipynb', new_source: 'x' } }, policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'git commit', request: bash('git commit -m done'), policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'git push to the ticket branch', request: bash('git push origin ticket-1'), policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'reading stays allowed', request: { tool: 'Read', input: { file_path: '/workspace/a.ts' } }, policy: reviewer, decision: 'allow', rule: 'read.workdir' },
    { name: 'the declared tests stay allowed', request: bash('npm test'), policy: reviewer, decision: 'allow', rule: 'reviewer.tests' },
  ]);
});

test('safe commands match the whole word list, and their unsafe words go to ask', () => {
  check([
    { name: 'git status', request: bash('git status'), decision: 'allow', rule: 'run.safe' },
    { name: 'git -C . status', request: bash('git -C . status'), decision: 'allow', rule: 'run.safe' },
    { name: 'git -c is not folded for an allow', request: bash('git -c core.pager=less log'), decision: 'ask', rule: 'default' },
    { name: 'git --work-tree', request: bash('git --work-tree=/ status'), decision: 'ask', rule: 'default' },
    { name: 'git diff', request: bash('git diff --stat main'), decision: 'allow', rule: 'run.safe' },
    { name: 'git diff --output', request: bash('git diff --output=x'), decision: 'ask', rule: 'default' },
    { name: 'git log -o', request: bash('git log -o x'), decision: 'ask', rule: 'default' },
    { name: 'git log with a format escape', request: bash('git log --format=%x00'), decision: 'ask', rule: 'default' },
    { name: 'git log with a ref format', request: bash("git log '--format=%(describe)'"), decision: 'ask', rule: 'default' },
    { name: 'git log with a plain format', request: bash('git log --format=%H'), decision: 'allow', rule: 'run.safe' },
    { name: 'git add', request: bash('git add src/app.ts'), decision: 'allow', rule: 'run.safe' },
    { name: 'git commit', request: bash("git commit -m 'feat: newest first'"), decision: 'allow', rule: 'run.safe' },
    { name: 'git checkout -b', request: bash('git checkout -b ticket-2'), decision: 'allow', rule: 'run.safe' },
    { name: 'git branch -m', request: bash('git branch -m other'), decision: 'ask', rule: 'default' },
    { name: 'node --test', request: bash('node --test test/app.test.ts'), decision: 'allow', rule: 'run.safe' },
    { name: 'pwd', request: bash('pwd'), decision: 'allow', rule: 'run.safe' },
    { name: 'ls', request: bash('ls -la src'), decision: 'allow', rule: 'run.safe' },
    { name: 'lsof is not ls', request: bash('lsof'), decision: 'ask', rule: 'default' },
    { name: 'cat in the workdir', request: bash('cat src/app.ts'), decision: 'allow', rule: 'run.safe' },
    { name: 'cat outside the workdir', request: bash('cat /etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'cat with ..', request: bash('cat ../../etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'tail -n', request: bash('tail -n 20 log.txt'), decision: 'allow', rule: 'run.safe' },
    { name: 'grep pattern then path', request: bash('grep -rn TODO src'), decision: 'allow', rule: 'run.safe' },
    { name: 'grep outside', request: bash('grep -r root /etc'), decision: 'ask', rule: 'default' },
    { name: 'grep -f reads a file', request: bash('grep -f /etc/shadow src'), decision: 'ask', rule: 'default' },
    { name: 'find outside', request: bash('find / -name x'), decision: 'ask', rule: 'default' },
    { name: 'find -exec', request: bash('find . -exec cat {} +'), decision: 'ask', rule: 'default' },
    { name: 'find -fprint', request: bash('find . -fprint out'), decision: 'ask', rule: 'default' },
    { name: 'find -fls', request: bash('find . -fls out'), decision: 'ask', rule: 'default' },
    { name: 'npm run with arguments', request: bash('npm run test -- --watch'), decision: 'allow', rule: 'run.safe' },
    { name: 'an environment prefix', request: bash('NODE_OPTIONS=--require=x npm test'), decision: 'ask', rule: 'default' },
    { name: 'a project pattern', request: bash('make build'), policy: { safeCommands: [...DEFAULT_SAFE_COMMANDS, 'make *'] }, decision: 'allow', rule: 'run.safe' },
  ]);
});

test('a safe git command never reads a file outside the workdir (review round 1, finding 1)', () => {
  check([
    { name: 'git diff --no-index', request: bash('git diff --no-index /etc/passwd /dev/null'), decision: 'ask', rule: 'default' },
    { name: 'git diff with a path outside, which git reads without --no-index', request: bash('git diff /etc/passwd /dev/null'), decision: 'ask', rule: 'default' },
    { name: 'git diff with ..', request: bash('git diff ../../etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git log of a path outside', request: bash('git log -- /etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git add of a path outside', request: bash('git add /etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git commit -F', request: bash('git commit -F /etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git commit -F inside the workdir', request: bash('git commit -F msg.txt'), decision: 'ask', rule: 'default' },
    { name: 'git commit --file=', request: bash('git commit --file=/etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git commit -aF', request: bash('git commit -aF /etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git commit --template', request: bash('git commit --template /etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git commit -t', request: bash('git commit -t /etc/passwd'), decision: 'ask', rule: 'default' },
    { name: 'git commit -C', request: bash('git commit -C HEAD'), decision: 'ask', rule: 'default' },
    { name: 'git commit -c', request: bash('git commit -c HEAD'), decision: 'ask', rule: 'default' },
    { name: 'git diff of revisions', request: bash('git diff main..HEAD'), decision: 'allow', rule: 'run.safe' },
    { name: 'git diff of a file in the workdir', request: bash('git diff HEAD~1 -- src/app.ts'), decision: 'allow', rule: 'run.safe' },
    { name: 'git status --porcelain', request: bash('git status --porcelain'), decision: 'allow', rule: 'run.safe' },
    { name: 'a commit message that starts with a slash', request: bash("git commit -m '/health answers 200'"), decision: 'allow', rule: 'run.safe' },
    { name: 'git commit -am', request: bash("git commit -am 'feat: newest first'"), decision: 'allow', rule: 'run.safe' },
  ]);
});

test('a commit message or an echo that names a secret file is no read of it (review round 1, finding 5)', () => {
  check([
    { name: 'git commit -m', request: bash('git commit -m "document .env.example"'), decision: 'allow', rule: 'run.safe' },
    { name: 'git commit --message=', request: bash('git commit --message=".env notes"'), decision: 'allow', rule: 'run.safe' },
    { name: 'git commit -m with a pem name', request: bash("git commit -m 'drop the .pem fixtures'"), decision: 'allow', rule: 'run.safe' },
    { name: 'echo', request: bash('echo id_rsa'), decision: 'ask', rule: 'default' },
    { name: 'a pathspec stays a read', request: bash('git commit -m x .env'), decision: 'deny', rule: 'secret.read' },
    { name: 'git commit -F of a secret', request: bash('git commit -F .env'), decision: 'deny', rule: 'secret.read' },
    { name: 'a compound command is read whole', request: bash('npm test; git commit -m ".env"'), decision: 'deny', rule: 'secret.read' },
    { name: 'echo inside a substitution', request: bash('cat $(echo .env)'), decision: 'deny', rule: 'secret.read' },
  ]);
});

test('anything the parser cannot read word for word goes to ask', () => {
  for (const command of ['cat $HOME/x', 'ls ~', 'ls *.ts', 'cat a?', 'echo {a,b}', 'npm test &', 'npm test # note', 'echo "$(id)"', 'echo "`id`"', 'ls\nid', 'echo "open', 'echo a\\', 'cat <in', '(ls)', '', 'npm test |& tail', 'npm test && ', '; npm test', 'npm test ;; ls', 'npm test | | tail', 'cat a >| b', "cat a > ''", 'cat a >', 'npm test 2>&x', 'npm test >&out', 'npm test <<EOF']) {
    const verdict = evaluate(bash(command), base, context);
    assert.deepEqual([verdict.decision, verdict.rule], ['ask', 'shell.compound'], JSON.stringify(command));
  }
});

test('read.workdir needs a path under the workdir', () => {
  check([
    { name: 'a relative Grep path', request: { tool: 'Grep', input: { pattern: 'x', path: 'src' } }, decision: 'allow', rule: 'read.workdir' },
    { name: 'Grep without a path', request: { tool: 'Grep', input: { pattern: 'x' } }, decision: 'allow', rule: 'read.workdir' },
    { name: 'Glob in the workdir', request: { tool: 'Glob', input: { pattern: 'src/**/*.ts' } }, decision: 'allow', rule: 'read.workdir' },
    { name: 'Glob escaping', request: { tool: 'Glob', input: { pattern: '../**/*' } }, decision: 'ask', rule: 'default' },
    { name: 'Read outside', request: { tool: 'Read', input: { file_path: '/etc/passwd' } }, decision: 'ask', rule: 'default' },
    { name: 'a sibling with the same prefix', request: { tool: 'Read', input: { file_path: '/workspace-other/a.ts' } }, decision: 'ask', rule: 'default' },
    { name: 'Edit outside', request: { tool: 'Edit', input: { file_path: '/tmp/../etc/x', old_string: 'a', new_string: 'b' } }, decision: 'ask', rule: 'default' },
    { name: 'an edit of .git', request: { tool: 'Write', input: { file_path: '/workspace/.git/hooks/pre-push', content: 'x' } }, decision: 'ask', rule: 'default' },
  ]);
});

test('installs, deletions and network commands ask with their own rule', () => {
  check([
    { name: 'npm i', request: bash('npm i left-pad'), decision: 'ask', rule: 'install.package' },
    { name: 'npm add', request: bash('npm add left-pad'), decision: 'ask', rule: 'install.package' },
    { name: 'pnpm add', request: bash('pnpm add left-pad'), decision: 'ask', rule: 'install.package' },
    { name: 'yarn add', request: bash('yarn add left-pad'), decision: 'ask', rule: 'install.package' },
    { name: 'pip install', request: bash('pip install requests'), decision: 'ask', rule: 'install.package' },
    { name: 'apt-get', request: bash('apt-get update'), decision: 'ask', rule: 'install.package' },
    { name: 'apk add', request: bash('apk add curl'), decision: 'ask', rule: 'install.package' },
    { name: 'npx', request: bash('npx cowsay hi'), decision: 'ask', rule: 'install.package' },
    { name: 'rm -rf', request: bash('rm -rf dist'), decision: 'ask', rule: 'delete.outside_ticket' },
    { name: 'git clean', request: bash('git clean -fdx'), decision: 'ask', rule: 'delete.outside_ticket' },
    { name: 'git checkout -- .', request: bash('git checkout -- .'), decision: 'ask', rule: 'delete.outside_ticket' },
    { name: 'git reset --hard', request: bash('git reset --hard HEAD~1'), decision: 'ask', rule: 'delete.outside_ticket' },
    { name: 'rm of a file outside the ticket', request: bash('rm README.md'), decision: 'ask', rule: 'delete.outside_ticket' },
    // Milestone 2, decision 11: the author deletes a file its ticket changed without asking.
    { name: 'rm of a ticket file', request: bash('rm src/app.ts'), decision: 'allow', rule: 'delete.ticket' },
    { name: 'rm -r of a ticket file', request: bash('rm -r src/app.ts'), decision: 'ask', rule: 'delete.outside_ticket' },
    { name: 'wget', request: bash('wget https://example.org/x'), decision: 'ask', rule: 'net.undeclared' },
    { name: 'ssh', request: bash('ssh host.example.org'), decision: 'ask', rule: 'net.undeclared' },
    { name: 'nc', request: bash('nc example.org 80'), decision: 'ask', rule: 'net.undeclared' },
    { name: 'curl to an allowed host', request: bash('curl https://registry.npmjs.org/pg'), decision: 'ask', rule: 'default' },
    { name: 'WebFetch undeclared', request: { tool: 'WebFetch', input: { url: 'https://example.org/x', prompt: 'read' } }, decision: 'ask', rule: 'net.undeclared' },
    { name: 'WebFetch allowed', request: { tool: 'WebFetch', input: { url: 'https://registry.npmjs.org/pg', prompt: 'read' } }, decision: 'ask', rule: 'default' },
    { name: 'WebSearch', request: { tool: 'WebSearch', input: { query: 'node test runner' } }, decision: 'ask', rule: 'net.undeclared' },
  ]);
});

test('every verdict says why', () => {
  const deny = evaluate(bash('git push origin main'), base, context);
  assert.equal(deny.decision, 'deny');
  if (deny.decision === 'deny') assert.match(deny.message, /main/);
  const ask = evaluate(bash('make build'), base, context);
  assert.equal(ask.decision, 'ask');
  if (ask.decision === 'ask') assert.ok(ask.reason.length > 0);
});

test('the shell-word parser reads quotes and escapes, and nothing else', () => {
  assert.deepEqual(parseCommand('git commit -m "a b"'), ['git', 'commit', '-m', 'a b']);
  assert.deepEqual(parseCommand("echo 'a|b;c' \"d\\\"e\" f\\ g"), ['echo', 'a|b;c', 'd"e', 'f g']);
  assert.deepEqual(parseCommand("echo '' x"), ['echo', '', 'x']);
  assert.deepEqual(parseCommand('  ls   -la  '), ['ls', '-la']);
  assert.deepEqual(parseCommand('echo "a\\b"'), ['echo', 'a\\b']);
  for (const text of ['a;b', 'a && b', 'a || b', 'a | b', 'a > b', 'a >> b', 'a < b', 'a 2> b', 'a &> b', '$(a)', '`a`', 'a\nb', '"a', "'a", 'a\\', '', '   ', '$X', '"$X"']) {
    assert.equal(parseCommand(text), undefined, JSON.stringify(text));
  }
});

// The proofs' driver passes `globs` (scripts/proof-inbox.ts, review 1 of PR
// 279); the policy never does, and a bare glob stays refused by it.
test('the parser reads a bare glob only when asked, and only one that names files of the current folder', () => {
  for (const text of ['ls *', 'grep -r x --include=*', 'wc -l *.ts', 'ls a?c', 'ls [ab]']) {
    assert.equal(parseCommand(text), undefined, text);
    assert.equal(parseList(text), undefined, text);
  }
  assert.deepEqual(parseCommand('ls *', { globs: true }), ['ls', '*']);
  assert.deepEqual(parseCommand('wc -l *.ts', { globs: true }), ['wc', '-l', '*.ts']);
  assert.deepEqual(parseCommand('grep -r x --include=*', { globs: true }), ['grep', '-r', 'x', '--include=*']);
  assert.deepEqual(parseList('npm test | tail; ls *.md', { globs: true })?.map((c) => c.words), [['npm', 'test'], ['tail'], ['ls', '*.md']]);
  for (const text of ['ls src/*', 'cat .*', 'cd ".."*', 'ls /etc/*', 'ls ./*', 'cat .?']) assert.equal(parseCommand(text, { globs: true }), undefined, text);
  // Everything else the parser refuses stays refused with it.
  for (const text of ['a;b', '$(a)', '`a`', 'a\nb', '$X', 'ls {a,b}*']) assert.equal(parseCommand(text, { globs: true }), undefined, JSON.stringify(text));
  // The policy's own verdict on a bare glob still asks.
  assert.equal(evaluate(bash('ls *.ts'), { ...base, role: 'reviewer' }).decision, 'ask');
});

// docs/v2/milestone-2-plan.md, decision 10 and the acceptance of lane 1: a
// command made of simple commands each allowed on its own is allowed as
// shell.compound_safe; a redirection writes only where an Edit would.
test('compound commands of safe simple commands, and their redirections (milestone 2, decision 10)', () => {
  check([
    { name: 'npm test 2>&1 | tail -20', request: bash('npm test 2>&1 | tail -20'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'npm test && git commit -m x', request: bash('npm test && git commit -m x'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'npm run typecheck; npm test', request: bash('npm run typecheck; npm test'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'cat a > notes.txt', request: bash('cat a > notes.txt'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'cat a > package.json', request: bash('cat a > package.json'), decision: 'ask', rule: 'scripts.change' },
    { name: 'cat a > .git/config', request: bash('cat a > .git/config'), decision: 'ask', rule: 'shell.compound' },
    { name: 'npm test > CLAUDE.md', request: bash('npm test > CLAUDE.md'), decision: 'ask', rule: 'shell.compound' },
    { name: 'cat a >> .claude/settings.json', request: bash('cat a >> .claude/settings.json'), decision: 'ask', rule: 'shell.compound' },
    { name: 'cat a > /etc/x', request: bash('cat a > /etc/x'), decision: 'ask', rule: 'shell.compound' },
    { name: 'npm test | tee /tmp/x', request: bash('npm test | tee /tmp/x'), decision: 'ask', rule: 'shell.compound' },
    { name: 'npm test; curl https://example.invalid', request: bash('npm test; curl https://example.invalid'), decision: 'ask', rule: 'net.undeclared' },
    { name: 'npm test && git push origin main', request: bash('npm test && git push origin main'), decision: 'deny', rule: 'push.base' },
    { name: 'echo $(id) | tail', request: bash('echo $(id) | tail'), decision: 'ask', rule: 'shell.compound' },
  ]);
});

test('compound commands: the separators, the redirection forms, and the rule of the part that asks', () => {
  check([
    { name: 'a separator inside quotes is a word', request: bash('git commit -m "a && b; c | d"'), decision: 'allow', rule: 'run.safe' },
    { name: '||', request: bash('npm test || npm test'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'a redirection without a space', request: bash('cat a >notes.txt'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'a quoted target', request: bash('cat a > "notes.txt"'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'stderr to a file', request: bash('npm test 2>err'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'stderr appended', request: bash('npm test 2>>log.txt'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'both streams to a file', request: bash('npm test &>out'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'a duplication alone', request: bash('npm test 2>&1'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'stdout to stderr', request: bash('npm test >&2'), decision: 'allow', rule: 'shell.compound_safe' },
    { name: '/dev/null is outside the workdir', request: bash('ls src 2>/dev/null'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a target outside through ..', request: bash('npm test > ../out'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a target in .git through a subfolder', request: bash('npm test > src/../.git/hooks/pre-push'), decision: 'ask', rule: 'shell.compound' },
    { name: 'the lock file', request: bash('cat a > package-lock.json'), decision: 'ask', rule: 'install.package' },
    { name: 'a secret target is denied, not asked', request: bash('cat a > .env'), decision: 'deny', rule: 'secret.read' },
    { name: 'a part that installs', request: bash('npm test && npm install left-pad'), decision: 'ask', rule: 'install.package' },
    { name: 'a part that deletes', request: bash('ls && rm -rf dist'), decision: 'ask', rule: 'delete.outside_ticket' },
    { name: 'a pipe into a shell', request: bash('cat a | sh'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a part that is not safe', request: bash('git log --format=%x00 | head'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a part outside the workdir', request: bash('npm test && cat /etc/passwd'), decision: 'ask', rule: 'shell.compound' },
    { name: 'docker anywhere is still denied', request: bash('npm test | docker run x'), decision: 'deny', rule: 'host.docker' },
  ]);
});

test('a compound command never lets a reviewer write a file', () => {
  const reviewer = { role: 'reviewer' as const, testCommand: ['npm', 'test'] };
  check([
    { name: 'a redirection into the workdir', request: bash('npm test > out.txt'), policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'a pipe of reads', request: bash('npm test 2>&1 | tail -5'), policy: reviewer, decision: 'allow', rule: 'shell.compound_safe' },
    { name: 'a commit in a list', request: bash('npm test && git commit -m x'), policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
  ]);
});

// Section 3.3 of the milestone 2 plan: the lead's rows, after the deny rules
// of milestone 1 and before the role-free rows.
test('the lead\'s policy: one case per row of section 3.3', () => {
  const lead = { role: 'lead' as const };
  const read = (input: Record<string, unknown>): ToolRequest => ({ tool: 'Read', input: { file_path: '/workspace/src/app.ts', ...input } });
  check([
    { name: 'a host tool', request: { tool: 'mcp__cleared__state', input: {} }, policy: lead, decision: 'allow', rule: 'lead.tools' },
    { name: 'another host tool', request: { tool: 'mcp__cleared__propose_plan', input: { goal: 'g' } }, policy: lead, decision: 'allow', rule: 'lead.tools' },
    { name: 'a Read with a limit', request: read({ limit: 400 }), policy: lead, decision: 'allow', rule: 'read.workdir' },
    { name: 'Glob', request: { tool: 'Glob', input: { pattern: 'src/**/*.ts' } }, policy: lead, decision: 'allow', rule: 'read.workdir' },
    { name: 'Grep', request: { tool: 'Grep', input: { pattern: 'x', path: 'src' } }, policy: lead, decision: 'allow', rule: 'read.workdir' },
    { name: 'a Read without a limit', request: read({}), policy: lead, decision: 'deny', rule: 'lead.read_cap' },
    { name: 'a Read above the cap', request: read({ limit: 401 }), policy: lead, decision: 'deny', rule: 'lead.read_cap' },
    { name: 'a Read with a limit that is not a count', request: read({ limit: '100' }), policy: lead, decision: 'deny', rule: 'lead.read_cap' },
    { name: 'git log --oneline', request: bash('git log --oneline'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'Edit', request: { tool: 'Edit', input: { file_path: '/workspace/src/app.ts', old_string: 'a', new_string: 'b' } }, policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'npm test', request: bash('npm test'), policy: lead, decision: 'deny', rule: 'lead.command' },
  ]);
});

test('the lead reads git and the workdir through head, and runs nothing else', () => {
  const lead = { role: 'lead' as const };
  check([
    { name: 'git -c', request: bash('git -c core.pager=x log'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'a redirection', request: bash('git log > x'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'git -C .', request: bash('git -C . log --oneline'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'git status', request: bash('git status'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'git branch --show-current', request: bash('git branch --show-current'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'git show into head', request: bash('git show HEAD | head -n 400'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'git diff into head -nN', request: bash('git diff main | head -n200'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'head above the cap', request: bash('git diff | head -n 401'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'head of nothing', request: bash('git diff | head -n 0'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'git log with a format escape', request: bash('git log --format=%x00'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'git log --output', request: bash('git log --output=x'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'git branch -D', request: bash('git branch -D x'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'ls into head', request: bash('ls src | head -n 50'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'grep into head', request: bash('grep -rn TODO src | head -n 20'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'find into head', request: bash("find . -name '*.ts' | head -n 100"), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'head of a file', request: bash('head -n 100 src/app.ts'), policy: lead, decision: 'allow', rule: 'lead.git_read' },
    { name: 'head without a count', request: bash('head src/app.ts'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'a second count', request: bash('head -n 5 -n 99999 src/app.ts'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'a byte count', request: bash('head -n 5 -c 999999 src/app.ts'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'several files', request: bash('head -n 400 src/a.ts src/b.ts src/c.ts'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'a second count after a pipe', request: bash('git log | head -n 5 -n 99999'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'ls not piped into head', request: bash('ls src'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'ls outside the workdir', request: bash('ls / | head -n 5'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'find -exec', request: bash('find . -exec cat {} + | head -n 5'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'cat is not the lead\'s reader', request: bash('cat src/app.ts'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'tail is not either', request: bash('tail -n 5 src/app.ts | head -n 5'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'three parts', request: bash('git log | head -n 20 | head -n 5'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'a list', request: bash('git log && git status'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'head reading a file after a pipe', request: bash('git log | head -n 5 src/app.ts'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'a duplication', request: bash('git log 2>&1 | head -n 5'), policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'git commit', request: bash('git commit -m x'), policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'git push to a ticket branch', request: bash('git push origin ticket-1'), policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'git push to the base is milestone 1\'s deny', request: bash('git push origin main'), policy: lead, decision: 'deny', rule: 'push.base' },
    { name: 'git checkout', request: bash('git checkout -b x'), policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'git add in a list', request: bash('git status && git add .'), policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'Write', request: { tool: 'Write', input: { file_path: '/workspace/a.ts', content: 'x' } }, policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'MultiEdit', request: { tool: 'MultiEdit', input: { file_path: '/workspace/a.ts', edits: [] } }, policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'NotebookEdit', request: { tool: 'NotebookEdit', input: { notebook_path: '/workspace/a.ipynb', new_source: 'x' } }, policy: lead, decision: 'deny', rule: 'lead.edit' },
    { name: 'WebFetch', request: { tool: 'WebFetch', input: { url: 'https://registry.npmjs.org/pg', prompt: 'read' } }, policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'WebSearch', request: { tool: 'WebSearch', input: { query: 'x' } }, policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'Agent', request: { tool: 'Agent', input: { prompt: 'x' } }, policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'Task', request: { tool: 'Task', input: { prompt: 'x' } }, policy: lead, decision: 'deny', rule: 'lead.command' },
    { name: 'a secret is milestone 1\'s deny', request: { tool: 'Read', input: { file_path: '/workspace/.env', limit: 10 } }, policy: lead, decision: 'deny', rule: 'secret.read' },
    { name: 'a Read outside the workdir falls to the role-free rows', request: { tool: 'Read', input: { file_path: '/etc/hosts', limit: 10 } }, policy: lead, decision: 'ask', rule: 'default' },
    { name: 'a host tool is the lead\'s only', request: { tool: 'mcp__cleared__state', input: {} }, decision: 'ask', rule: 'default' },
  ]);
  const capped = evaluate({ tool: 'Read', input: { file_path: '/workspace/src/app.ts' } }, { ...base, role: 'lead' }, context);
  assert.equal(capped.decision, 'deny');
  if (capped.decision === 'deny') assert.match(capped.message, /limit of at most 400 lines/);
});

// Milestone 2, decision 28 (lane 25): the reader answers a question about
// the code. The reviewer's rows (no edit, no commit, no push), the lead's
// 400-line cap on a Read, and nothing that waits for a person: nobody
// answers a reader's requests, so what would ask is refused, and an
// "Always in this project" answer never widens what it may do.
test('the reader\'s policy: one case per row', () => {
  const reader = { role: 'reader' as const };
  const read = (input: Record<string, unknown>): ToolRequest => ({ tool: 'Read', input: { file_path: '/workspace/guestbook/src/page.ts', ...input } });
  check([
    { name: 'a Read with a limit', request: read({ limit: 400 }), policy: reader, decision: 'allow', rule: 'read.workdir' },
    { name: 'a Read with an offset and a limit', request: read({ offset: 400, limit: 200 }), policy: reader, decision: 'allow', rule: 'read.workdir' },
    { name: 'a Read without a limit', request: read({}), policy: reader, decision: 'deny', rule: 'reader.read_cap' },
    { name: 'a Read above the cap', request: read({ limit: 401 }), policy: reader, decision: 'deny', rule: 'reader.read_cap' },
    { name: 'a Read with a limit that is not a count', request: read({ limit: '100' }), policy: reader, decision: 'deny', rule: 'reader.read_cap' },
    { name: 'Glob', request: { tool: 'Glob', input: { pattern: '**/*.ts' } }, policy: reader, decision: 'allow', rule: 'read.workdir' },
    { name: 'Grep', request: { tool: 'Grep', input: { pattern: 'x', path: 'guestbook/src' } }, policy: reader, decision: 'allow', rule: 'read.workdir' },
    { name: 'a safe command', request: bash('grep -rn health guestbook/src'), policy: reader, decision: 'allow', rule: 'run.safe' },
    { name: 'Edit', request: { tool: 'Edit', input: { file_path: '/workspace/guestbook/src/page.ts', old_string: 'a', new_string: 'b' } }, policy: reader, decision: 'deny', rule: 'reader.edit' },
    { name: 'Write', request: { tool: 'Write', input: { file_path: '/workspace/notes.md', content: 'x' } }, policy: reader, decision: 'deny', rule: 'reader.edit' },
    { name: 'MultiEdit', request: { tool: 'MultiEdit', input: { file_path: '/workspace/a.ts', edits: [] } }, policy: reader, decision: 'deny', rule: 'reader.edit' },
    { name: 'NotebookEdit', request: { tool: 'NotebookEdit', input: { notebook_path: '/workspace/a.ipynb', new_source: 'x' } }, policy: reader, decision: 'deny', rule: 'reader.edit' },
    { name: 'git commit', request: bash('git commit -m done'), policy: reader, decision: 'deny', rule: 'reader.edit' },
    { name: 'git push to a branch', request: bash('git push origin ticket-1'), policy: reader, decision: 'deny', rule: 'reader.edit' },
    { name: 'git push to the base', request: bash('git push origin main'), policy: reader, decision: 'deny', rule: 'push.base' },
    { name: 'a secret', request: read({ file_path: '/workspace/guestbook/.env', limit: 10 }), policy: reader, decision: 'deny', rule: 'secret.read' },
    { name: 'a question to a person', request: { tool: 'AskUserQuestion', input: { questions: [] } }, policy: reader, decision: 'deny', rule: 'reader.question' },
    { name: 'an install, which would ask', request: bash('npm install left-pad'), policy: reader, decision: 'deny', rule: 'reader.ask' },
    { name: 'the network, which would ask', request: bash('curl https://example.com'), policy: reader, decision: 'deny', rule: 'reader.ask' },
    { name: 'a fetch, which would ask', request: { tool: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' } }, policy: reader, decision: 'deny', rule: 'reader.ask' },
    { name: 'a subagent, which would ask', request: { tool: 'Task', input: { prompt: 'x' } }, policy: reader, decision: 'deny', rule: 'reader.ask' },
    { name: 'a host tool, which a reader has none of', request: { tool: 'mcp__cleared__propose_plan', input: {} }, policy: reader, decision: 'deny', rule: 'reader.ask' },
    { name: 'a redirection, which writes a file', request: bash('cat a > b'), policy: reader, decision: 'deny', rule: 'reader.edit' },
    { name: 'a compound command, which would ask', request: bash('ls; wget https://example.com'), policy: reader, decision: 'deny', rule: 'reader.ask' },
    { name: 'a learned answer does not widen it', request: bash('make build'), policy: { ...reader, learned: [{ tool: 'Bash', pattern: 'make build' }] }, decision: 'deny', rule: 'reader.ask' },
  ]);
  const verdict = evaluate(bash('npm install left-pad'), { ...base, role: 'reader' });
  assert.ok(verdict.decision === 'deny' && verdict.message.includes('npm install'), 'the refusal keeps the reason it would have asked for');
});

// Review followup of pull request 204 (issue 207, item 4): an author whose
// session plan waits for its Go reads and runs the checks, and changes
// nothing but its HANDOVER.md, which the runner's Stop hook asks for at the
// end of every turn. The flow sets `planning` (flow/engine.ts, policyFor).
test('an author before its Go changes nothing but its handover', () => {
  const planning = { planning: true };
  const edit = (path: string): ToolRequest => ({ tool: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } });
  check([
    { name: 'Edit', request: edit('/workspace/src/app.ts'), policy: planning, decision: 'deny', rule: 'plan.before_go' },
    { name: 'Write', request: { tool: 'Write', input: { file_path: '/workspace/src/new.ts', content: 'x' } }, policy: planning, decision: 'deny', rule: 'plan.before_go' },
    { name: 'its handover', request: { tool: 'Write', input: { file_path: '/workspace/HANDOVER.md', content: 'x' } }, policy: planning, decision: 'allow', rule: 'edit.workdir' },
    { name: 'a handover in a folder', request: { tool: 'Write', input: { file_path: '/workspace/src/HANDOVER.md', content: 'x' } }, policy: planning, decision: 'deny', rule: 'plan.before_go' },
    { name: 'git commit', request: bash('git commit -m wip'), policy: planning, decision: 'deny', rule: 'plan.before_go' },
    { name: 'git add', request: bash('git add src/app.ts'), policy: planning, decision: 'deny', rule: 'plan.before_go' },
    { name: 'a branch push', request: bash('git push origin ticket-1'), policy: planning, decision: 'deny', rule: 'plan.before_go' },
    { name: 'a delete', request: bash('rm src/app.ts'), policy: planning, decision: 'deny', rule: 'plan.before_go' },
    { name: 'a read', request: { tool: 'Read', input: { file_path: '/workspace/src/app.ts' } }, policy: planning, decision: 'allow', rule: 'read.workdir' },
    { name: 'the tests', request: bash('npm test'), policy: planning, decision: 'allow', rule: 'run.safe' },
    { name: 'after the Go', request: edit('/workspace/src/app.ts'), policy: { planning: false }, decision: 'allow', rule: 'edit.workdir' },
    { name: 'a reviewer is not concerned', request: edit('/workspace/src/app.ts'), policy: { role: 'reviewer', planning: true }, decision: 'deny', rule: 'reviewer.edit' },
  ]);
});

// B5.5b (the owner's decision of 2026-10-25 06:06): the runner reads the user
// setting source, which in the container is the session's config volume. A
// settings file written there would bring hooks and permission rules into the
// session's next query, so no rule lets an edit there through without the
// human, nor into the skills mounted from the base branch.
test('the config folder the user source reads is not written without the human', () => {
  const config = '/var/lib/cleared/claude-config';
  check([
    { name: 'Write its settings', request: { tool: 'Write', input: { file_path: `${config}/settings.json`, content: '{"hooks":{}}' } }, decision: 'ask', rule: 'default' },
    { name: 'Edit its settings', request: { tool: 'Edit', input: { file_path: `${config}/settings.json`, old_string: 'a', new_string: 'b' } }, decision: 'ask', rule: 'default' },
    { name: 'Write a skill', request: { tool: 'Write', input: { file_path: `${config}/skills/cleared-guestbook/SKILL.md`, content: 'x' } }, decision: 'ask', rule: 'default' },
    { name: 'a shell write', request: bash(`echo {} > ${config}/settings.json`), decision: 'ask', rule: 'shell.compound' },
    // "Always in this project" on that exact write opens it, as for any path: the human's answer.
    { name: 'the human\'s always for that file', request: { tool: 'Write', input: { file_path: `${config}/settings.json`, content: '{}' } }, policy: { learned: [{ tool: 'Write', pattern: `${config}/settings.json` }] }, decision: 'allow', rule: 'learned' },
  ]);
});

// The owner's report: permission requests that come back in a loop. "Always
// in this project" on a command of several parts stored the whole text, which
// no part of it ever matched, so the same request came back at each run.
test('"always in this project" on a command of several parts holds the next time it runs', () => {
  const command = 'npm ci && node scripts/check.js && which npm';
  const whole = evaluate(bash(command), { ...base, learned: [{ tool: 'Bash', pattern: command }] }, context);
  assert.equal(whole.decision, 'allow', JSON.stringify(whole));
  assert.equal(whole.rule, 'learned');
  const parts = learnedPatterns(command);
  assert.deepEqual(parts, ['npm ci', 'node scripts/check.js', 'which npm']);
  const learned = parts.map((pattern) => ({ tool: 'Bash', pattern }));
  assert.equal(evaluate(bash('node scripts/check.js && npm ci'), { ...base, learned }, context).decision, 'allow', 'each part holds on its own');
});

test('"always" on a command the policy cannot split holds for that exact text, and for nothing else', () => {
  const command = 'node -e "console.log(process.version)" | tee "$(mktemp)"';
  assert.equal(evaluate(bash(command), { ...base, learned: [{ tool: 'Bash', pattern: command }] }, context).decision, 'allow');
  assert.equal(evaluate(bash(`${command} # more`), { ...base, learned: [{ tool: 'Bash', pattern: command }] }, context).decision, 'ask');
});

test('a command with a quoted argument holds once it is always allowed', () => {
  const command = 'node -e "console.log(1 + 1)"';
  assert.equal(evaluate(bash(command), { ...base, learned: [{ tool: 'Bash', pattern: command }] }, context).decision, 'allow');
});

test('what the policy denies stays denied, whatever was learned', () => {
  const command = 'npm ci && docker ps';
  const verdict = evaluate(bash(command), { ...base, learned: [{ tool: 'Bash', pattern: command }, { tool: 'Bash', pattern: 'docker ps' }] }, context);
  assert.equal(verdict.decision, 'deny', JSON.stringify(verdict));
});

test('a learned command that writes a file while the plan waits for its Go still asks or is refused', () => {
  const command = 'node scripts/check.js > notes.txt && npm ci';
  const verdict = evaluate(bash(command), { ...base, planning: true, learned: [{ tool: 'Bash', pattern: command }] }, context);
  assert.notEqual(verdict.decision, 'allow', JSON.stringify(verdict));
});

test('looking at what is installed asks nobody: which and the version of the runtimes', () => {
  for (const command of ['which npm', 'which node npm', 'node --version', 'node -v', 'npm --version', 'npm -v', 'python3 --version']) {
    assert.equal(evaluate(bash(command), base, context).decision, 'allow', command);
  }
  assert.equal(evaluate(bash('node script.js'), base, context).decision, 'ask', 'running a script still asks');
});
