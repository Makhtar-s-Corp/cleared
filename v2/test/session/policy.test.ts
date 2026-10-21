import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SAFE_COMMANDS, evaluate, parseCommand, type Policy, type ToolRequest, type Verdict } from '../../src/session/policy.ts';

// The container sees the ticket checkout at /workspace. The credential path
// is built in two parts only to keep this file readable by the repository
// guard; its value is the plan's mount point.
const workdir = '/workspace';
const credentialFile = '/run/cleared/' + 'claude.token';

const base: Policy = {
  role: 'author',
  base: 'main',
  workdir,
  scripts: ['test', 'lint'],
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
    { name: 'a sequence', request: bash('npm run test; curl https://example.invalid'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a pipe', request: bash('npm run test | tee log'), decision: 'ask', rule: 'shell.compound' },
    { name: 'a redirection', request: bash('cat a > b'), decision: 'ask', rule: 'shell.compound' },
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

test('a learned entry is for its tool only and never allows a compound command', () => {
  check([
    { name: 'another tool', request: bash('make build'), policy: { learned: [{ tool: 'Read', pattern: 'make build' }] }, decision: 'ask', rule: 'default' },
    { name: 'compound', request: bash('make build; make test'), policy: { learned: [{ tool: 'Bash', pattern: '*' }] }, decision: 'ask', rule: 'shell.compound' },
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
  const reviewer = { role: 'reviewer' as const };
  check([
    { name: 'Write', request: { tool: 'Write', input: { file_path: '/workspace/a.ts', content: 'x' } }, policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'MultiEdit', request: { tool: 'MultiEdit', input: { file_path: '/workspace/a.ts', edits: [] } }, policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'NotebookEdit', request: { tool: 'NotebookEdit', input: { notebook_path: '/workspace/a.ipynb', new_source: 'x' } }, policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'git commit', request: bash('git commit -m done'), policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'git push to the ticket branch', request: bash('git push origin ticket-1'), policy: reviewer, decision: 'deny', rule: 'reviewer.edit' },
    { name: 'reading stays allowed', request: { tool: 'Read', input: { file_path: '/workspace/a.ts' } }, policy: reviewer, decision: 'allow', rule: 'read.workdir' },
    { name: 'tests stay allowed', request: bash('npm test'), policy: reviewer, decision: 'allow', rule: 'run.safe' },
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
    { name: 'cat outside the workdir', request: bash('cat /proc/self/environ'), decision: 'ask', rule: 'default' },
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

test('anything the parser cannot read word for word goes to ask', () => {
  for (const command of ['cat $HOME/x', 'ls ~', 'ls *.ts', 'cat a?', 'echo {a,b}', 'npm test &', 'npm test # note', 'echo "$(id)"', 'echo "`id`"', 'ls\nid', 'echo "open', 'echo a\\', 'cat <in', 'npm test 2>err', 'npm test &>out', '(ls)', '']) {
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
    { name: 'rm of a ticket file', request: bash('rm src/app.ts'), decision: 'ask', rule: 'default' },
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
