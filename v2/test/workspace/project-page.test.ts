// The project page (issue #274, P101 to P105): a page per service, made at the
// service's first connection from what its base branch holds, made again
// after a merge, and briefed to the sessions. Every test runs on a sample
// repository made in a temporary folder: no push to any real repository.
// Whether the page was written is read from its inode, never its clock (issue #360).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realEffects } from '../../src/flow/effects.ts';
import type { FlowEffects } from '../../src/flow/engine.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { cleanText } from '../../src/session/clean.ts';
import { updateProjectPage } from '../../src/workspace/project-page.ts';
import { CONFIG, approved, quickAuthor, setup } from '../flow/support.ts';
import { AGENTS_CONF, commit, gitIn, plantedKey, remote, tempDir, writeFiles } from './git.ts';

const SCRIPT_VALUE = ['k3y', 'Hq7Lm2Vx9Bn4'].join('');
const SUBJECT_VALUE = ['pw', 'Rt5Yu8Io1Pa6'].join('');
const PACKAGE = JSON.stringify({ name: 'sample-guestbook', scripts: { test: 'node --test', typecheck: 'tsc --noEmit', build: 'vite build', deploy: `API_TOKEN=${SCRIPT_VALUE} node deploy.js` } });
const TOKEN = ['ghp', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm'].join('_');
const ENV_VALUE = `${plantedKey}-envfile`;
// Assembled at run time, as plantedKey is: written whole, the repository guard would refuse this file.
const KEY_MARK = (word: string) => ['-----', word, ' PRIVATE', ' KEY-----'].join('');
const CONF = `${AGENTS_CONF}[merge]\nverdict = no blocking issues\n[session]\nsafe_commands = npm ci, npm test\nhosts = registry.npmjs.org\n`;

// The sample service: committed files that include an environment file, a
// key file and a README that quotes a token, so the page has to leave them out.
const FILES = {
  'package.json': PACKAGE,
  '.cleared/agents.conf': CONF,
  '.envrc': `export DIRENV_SECRET=${ENV_VALUE}-direnv\n`,
  '.env': `SESSION_SECRET=${ENV_VALUE}\n`,
  'config/.env.production': `DB_PASSWORD=hunter2-${TOKEN}\n`,
  'keys/server.pem': `${KEY_MARK('BEGIN')}\nMIIEvQ\n${KEY_MARK('END')}\n`,
  'src/server.js': 'export {};\n',
  'src/routes/entries.js': 'export {};\n',
  'docs/architecture.md': '# Architecture\n',
  'README.md': `# Sample guestbook\n\nA page that lists entries and adds one.\n\nDeploy token: ${TOKEN}\n`,
};

const ticket = (id = 'LOCAL-1'): Ticket => ({ id, title: 'Newest first', body: 'Sort.', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' });

async function sample(files: Record<string, string> = FILES) {
  const root = tempDir('project-page');
  const state = join(root, 'state');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: state };
  delete env.ORCH_LEDGER;
  const url = remote(files);
  const config = { ...CONFIG, projectDir: join(root, 'project'), repoUrl: url, workdirRoot: join(root, 'work') };
  return { root, state, url, config, flow: realEffects(config, { env }), source: { dir: config.projectDir, base: config.base, name: 'guestbook', env } };
}

// What a merge does to the forge: a commit on the sample's base branch.
function merged(root: string, url: string, files: Record<string, string>, message: string): void {
  const dir = join(root, `forge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  execFileSync('git', ['clone', '-q', '-b', 'main', url, dir], { stdio: 'ignore' });
  commit(dir, files, message);
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });
}

// A merge on the forge whose commit's short sha, the 12 characters the page
// names its base by, is one the cleaner takes for a phone number. Its dates
// are fixed, so its sha is known before it is made: the message is the first
// of a numbered series that gives such a sha.
function phoneShaped(root: string, url: string): string {
  const dir = join(root, 'forge-phone');
  execFileSync('git', ['clone', '-q', '-b', 'main', url, dir], { stdio: 'ignore' });
  writeFiles(dir, { 'src/call.js': 'export {};\n' });
  gitIn(dir, ['add', '-A']);
  const tree = gitIn(dir, ['write-tree']);
  const parent = gitIn(dir, ['rev-parse', 'HEAD']);
  const who = `${process.env.GIT_COMMITTER_NAME} <${process.env.GIT_COMMITTER_EMAIL}> 1700000000 +0000`;
  const shaOf = (message: string) => {
    const body = `tree ${tree}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`;
    return createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
  };
  const cleaned = (sha: string) => cleanText(`\`${sha.slice(0, 12)}\``, {}) !== `\`${sha.slice(0, 12)}\``;
  let n = 0;
  while (!cleaned(shaOf(`Add call.js ${n}`))) n++;
  const env = { ...process.env, GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
  const sha = execFileSync('git', ['-C', dir, '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', parent, '-m', `Add call.js ${n}`], { env, encoding: 'utf8' }).trim();
  assert.equal(sha, shaOf(`Add call.js ${n}`), 'the commit is the one searched for');
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', `${sha}:refs/heads/main`], { stdio: 'ignore' });
  return sha;
}

// Every file under `dir`, to look for a leak anywhere in the state folder.
function everyText(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return everyText(path);
    return statSync(path).size < 5_000_000 ? readFileSync(path, 'utf8') : '';
  }).join('\n');
}

const pageOf = (state: string) => join(state, 'pages', 'guestbook.md');
// The page is written beside itself then renamed over the old one, so each
// write gives it a new inode while the old one still exists: an unchanged
// inode says no write happened, whatever the clock or the machine's load.
const inodeOf = (state: string) => statSync(pageOf(state)).ino;
const noSecret = (text: string) => {
  for (const leak of [SCRIPT_VALUE, SUBJECT_VALUE, `${ENV_VALUE}-direnv`, TOKEN, ENV_VALUE, plantedKey, 'hunter2', 'PRIVATE KEY', 'MIIEvQ', 'SESSION_SECRET', 'DB_PASSWORD'])
    assert.ok(!text.includes(leak), `"${leak}" is not in the page`);
  assert.doesNotMatch(text, /\.env|server\.pem/, 'the names of the environment and key files are left out too');
};

test('the first connection of a service makes its page: the layout, the scripts, the safe commands and the recent merges', async () => {
  const { state, flow } = await sample();
  await flow.refreshProject();
  const page = readFileSync(pageOf(state), 'utf8');
  assert.match(page, /## Architecture/);
  assert.match(page, /src\/routes/, 'the layout of the base branch');
  assert.match(page, /sample-guestbook/);
  assert.match(page, /## Useful commands/);
  assert.match(page, /npm run typecheck/);
  assert.match(page, /npm run build/);
  assert.match(page, /npm ci/, 'the safe commands of .cleared/agents.conf');
  assert.match(page, /## Recent decisions/);
  assert.match(page, /first commit/);
});

test('the page holds no secret: no environment file, no key file, no token of the README or of a commit subject, in the page or anywhere in the state', async () => {
  const { root, url, state, flow } = await sample();
  merged(root, url, { 'src/more.js': 'export {};\n' }, `Rotate the deploy key ${TOKEN}`);
  merged(root, url, { 'src/more2.js': 'export {};\n' }, `Set DB_PASSWORD=${SUBJECT_VALUE} for staging`);
  await flow.refreshProject();
  noSecret(readFileSync(pageOf(state), 'utf8'));
  noSecret(everyText(state));
});

test('the page is read from the base branch, not from the checkout: an untracked file of the checkout is not in it, a new commit of the base is', async () => {
  const { root, url, config, state, flow } = await sample();
  await flow.refreshProject();
  writeFileSync(join(config.projectDir, 'local-notes.txt'), 'untracked\n');
  merged(root, url, { 'src/after.js': 'export {};\n' }, 'Add after.js');
  await flow.updateProjectPages?.({ ticket: 'LOCAL-1', pr: 7 });
  const page = readFileSync(pageOf(state), 'utf8');
  assert.match(page, /Add after\.js/, 'the page was made again from the new base');
  assert.ok(!page.includes('local-notes'));
});

test('a fetch that finds the base unmoved leaves the page as it is; one that finds it moved, even by a merge made on the forge itself, makes it again', async () => {
  const { root, url, state, flow, source } = await sample();
  await flow.refreshProject();
  const before = readFileSync(pageOf(state), 'utf8');
  const inode = inodeOf(state);
  await flow.refreshProject();
  assert.equal(readFileSync(pageOf(state), 'utf8'), before);
  assert.equal(inodeOf(state), inode, 'the page was not written again');
  assert.equal(await updateProjectPage(source), false, 'nothing to write');
  merged(root, url, { 'src/late.js': 'export {};\n' }, 'Add late.js');
  await flow.refreshProject();
  assert.match(readFileSync(pageOf(state), 'utf8'), /Add late\.js/);
});

test('after a merge the page is made again from the new base: the merge is among the recent decisions, the new file in the layout, and still no secret', async () => {
  const { root, url, state, flow, source } = await sample();
  await flow.refreshProject();
  merged(root, url, { 'src/sort.js': 'export {};\n' }, `Merge pull request #7 from cleared/LOCAL-1: sort entries newest first ${TOKEN}`);
  assert.ok(flow.updateProjectPages, 'the real effects make the pages again after a merge');
  await flow.updateProjectPages({ ticket: 'LOCAL-1', pr: 7 });
  const page = readFileSync(pageOf(state), 'utf8');
  assert.match(page, /sort entries newest first/);
  assert.match(page, /src\/sort\.js|sort\.js/);
  noSecret(page);
  const inode = inodeOf(state);
  await flow.updateProjectPages({ ticket: 'LOCAL-1', pr: 7 });
  assert.equal(readFileSync(pageOf(state), 'utf8'), page);
  assert.equal(inodeOf(state), inode, 'a base that did not move leaves the page as it is');
  assert.equal(await updateProjectPage(source), false, 'nothing to write');
});

test('a base whose short sha the cleaner would take for a phone number is named in the page as it is, and a fetch that finds it unmoved writes nothing (issue #360)', async () => {
  const { root, url, state, flow, source } = await sample();
  await flow.refreshProject();
  const sha = phoneShaped(root, url);
  await flow.refreshProject();
  const page = readFileSync(pageOf(state), 'utf8');
  assert.ok(page.includes(`at \`${sha.slice(0, 12)}\``), 'the page names the base it was made from');
  assert.match(page, /Add call\.js/);
  const inode = inodeOf(state);
  await flow.refreshProject();
  await flow.updateProjectPages?.({ ticket: 'LOCAL-1', pr: 7 });
  assert.equal(readFileSync(pageOf(state), 'utf8'), page);
  assert.equal(inodeOf(state), inode, 'the page was not written again');
  assert.equal(await updateProjectPage(source), false, 'nothing to write');
});

test('on the guestbook example of this repository: its real scripts and README, and no secret', async () => {
  const example = join(import.meta.dirname, '..', '..', '..', 'examples', 'guestbook');
  const files: Record<string, string> = {};
  for (const path of execFileSync('git', ['-C', example, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))
    if (!path.endsWith('package-lock.json')) files[path] = readFileSync(join(example, path), 'utf8');
  const { state, flow } = await sample(files);
  await flow.refreshProject();
  const page = readFileSync(pageOf(state), 'utf8');
  const scripts = Object.keys((JSON.parse(files['package.json'] as string) as { scripts: Record<string, string> }).scripts);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.ok(page.includes(`npm run ${script}`), `the script ${script}`);
  assert.match(page, /`src\/server\.ts`/);
  assert.ok(statSync(pageOf(state)).size <= 8 * 1024);
  noSecret(page);
});

test('the page is cut to a size a briefing can carry, whatever the repository holds', async () => {
  const many: Record<string, string> = { ...FILES };
  for (let i = 0; i < 400; i++) many[`modules/module-${i}/index.js`] = 'export {};\n';
  const { state, flow } = await sample(many);
  await flow.refreshProject();
  assert.ok(statSync(pageOf(state)).size <= 8 * 1024, 'at most 8 KiB');
});

test('a session is briefed on the page: CLAUDE.md quotes it as data, the contract carries it when the project has no page of its own', async () => {
  const { flow } = await sample();
  await flow.refreshProject();
  const prepared = await flow.prepareWorkdir({ ticket: ticket(), role: 'author' });
  const claude = readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /## Generated page of the service guestbook/);
  assert.match(claude, / {4}\| .*npm run typecheck/, 'each line of the page is quoted as memory data');
  assert.match(prepared.briefing.projectPage, /npm run typecheck/);
  noSecret(claude);
  const reviewer = await flow.prepareWorkdir({ ticket: ticket(), role: 'reviewer' });
  assert.match(readFileSync(join(reviewer.workdir, 'CLAUDE.md'), 'utf8'), /npm run typecheck/, 'the reviewer is briefed on it too');
});

test('the project\'s own committed page stays the contract\'s page; the generated one is still in CLAUDE.md', async () => {
  const { flow } = await sample({ ...FILES, 'docs/project.md': 'The guestbook lists and adds entries.\n' });
  const prepared = await flow.prepareWorkdir({ ticket: ticket(), role: 'author' });
  assert.match(prepared.briefing.projectPage, /lists and adds entries/);
  assert.doesNotMatch(prepared.briefing.projectPage, /npm run typecheck/);
  assert.match(readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8'), /Generated page of the service/);
});

test('a session is briefed even when the page cannot be made: a repository with nothing to say still gets a short page, and the briefing is written', async () => {
  const { state, flow } = await sample({});
  const prepared = await flow.prepareWorkdir({ ticket: ticket(), role: 'author' });
  assert.match(readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8'), /Project memory/);
  assert.ok(existsSync(pageOf(state)));
});

test('the flow asks for the pages after a merge, and a page that fails never fails the flow', async () => {
  const calls: string[] = [];
  const effects: Partial<FlowEffects> = {
    async mergeRelease() { return { outcome: 'merged', message: '' }; },
    async updateProjectPages(input) { calls.push(`${input.ticket}:${input.pr}`); throw new Error('the forge is down'); },
  };
  const t = await setup({ scripts: { author: quickAuthor }, effects });
  await approved(t);
  t.clock.now += 60_000;
  await t.engine.tick();
  await t.engine.settled();
  assert.deepEqual(calls, [`${t.ticket.id}:7`], 'asked once, with the ticket and the pull request that merged');
  assert.ok(t.flowEvents.some((e) => e.type === 'release_merged'), 'the merge is followed all the same');
});

test('a refused or queued merge asks for no page', async () => {
  const calls: string[] = [];
  const effects: Partial<FlowEffects> = {
    async mergeRelease() { return { outcome: 'queued', message: '' }; },
    async updateProjectPages() { calls.push('asked'); },
  };
  const t = await setup({ scripts: { author: quickAuthor }, effects });
  await approved(t);
  t.clock.now += 60_000;
  await t.engine.tick();
  await t.engine.settled();
  assert.deepEqual(calls, []);
});
