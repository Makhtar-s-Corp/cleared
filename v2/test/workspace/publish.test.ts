import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublishRefused, publish, type PublishInput } from '../../src/workspace/publish.ts';
import { projectCheckout, ticketCheckout } from '../../src/workspace/checkout.ts';
import { commit, gitIn, plantedKey, remote, tempDir, writeFiles } from './git.ts';

const BRANCH = 'cleared/DEMO-7';
const PR_URL = 'https://github.com/example/guestbook/pull/7';

// A fake gh on PATH: it records each call (arguments, and the body file's
// text) and answers `pr list` with the open pull requests of a file, and
// `pr create` with a pull request address.
function fakeGh(root: string, open: unknown[] = []) {
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  writeFiles(bin, {
    gh: `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('--body-file');
const body = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, body, cwd: process.cwd() }) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(open))} + '\\n');
else if (args[0] === 'pr' && args[1] === 'create') process.stdout.write(${JSON.stringify(PR_URL)} + '\\n');
else process.exit(3);
`,
  });
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = (): { args: string[]; body: string | null; cwd: string }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, calls };
}

async function setup(open: unknown[] = []) {
  const root = tempDir('publish');
  const url = remote({ 'src/app.ts': 'export const order = "oldest";\n' });
  const project = await projectCheckout({ url, dir: join(root, 'project'), base: 'main' });
  const workdir = join(root, 'w');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: BRANCH });
  const gh = fakeGh(root, open);
  const input: PublishInput = { project: project.dir, workdir, base: 'main', branch: BRANCH, repo: 'example/guestbook', ticket: 'DEMO-7', gitEnv: process.env, ghEnv: gh.env };
  const remoteHead = () => { try { return gitIn(url, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]); } catch { return ''; } };
  return { root, url, workdir, input, gh, remoteHead };
}

test('a clean branch is pushed from the host and its pull request opened through gh', async () => {
  const { workdir, input, gh, remoteHead } = await setup();
  const head = commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, 'Show the newest entry first');
  const report = '## Done\nThe list is sorted, see /home/someone/project/src/app.ts for the query.\n';
  const result = await publish({ ...input, report });
  assert.deepEqual(result, { url: PR_URL, number: 7, head, created: true });
  assert.equal(remoteHead(), head);
  const calls = gh.calls();
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [['pr', 'list'], ['pr', 'create']]);
  const create = calls[1]!;
  const flag = (name: string) => create.args[create.args.indexOf(name) + 1];
  assert.equal(flag('--repo'), 'example/guestbook');
  assert.equal(flag('--base'), 'main');
  assert.equal(flag('--head'), BRANCH);
  assert.equal(flag('--title'), 'Show the newest entry first');
  assert.ok(!create.args.includes('--draft'), 'not a draft: merge-pr.sh refuses a draft');
  assert.ok(create.body?.includes('The list is sorted'), 'the report is in the body');
  assert.ok(!create.body?.includes('/home/someone'), 'no path of this machine in the body');
  assert.ok(create.body?.includes('- Show the newest entry first'), 'the commits are listed');
});

test('a diff the guard flags is refused: nothing is pushed and no pull request is opened', async () => {
  const { workdir, input, gh, remoteHead } = await setup();
  commit(workdir, { 'config/settings.ts': `export const apiKey = "${plantedKey}";\n` }, 'Add settings');
  await assert.rejects(publish(input), (error: unknown) => {
    assert.ok(error instanceof PublishRefused);
    assert.equal(error.code, 'guard');
    assert.match(error.message, /API key/);
    assert.ok(!error.message.includes(plantedKey), 'the value is never repeated');
    return true;
  });
  assert.equal(remoteHead(), '');
  assert.deepEqual(gh.calls(), []);
});

test('a commit message the guard flags is refused', async () => {
  const { workdir, input, remoteHead } = await setup();
  commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, `Use ${plantedKey}`);
  await assert.rejects(publish(input), (error: unknown) => error instanceof PublishRefused && error.code === 'guard');
  assert.equal(remoteHead(), '');
});

test('a branch that commits HANDOVER.md or CLAUDE.md is refused', async () => {
  for (const name of ['HANDOVER.md', 'CLAUDE.md']) {
    const { workdir, input, remoteHead } = await setup();
    writeFileSync(join(workdir, name), 'generated\n');
    gitIn(workdir, ['add', '-f', name]);
    gitIn(workdir, ['commit', '-q', '-m', `Add ${name}`]);
    gitIn(workdir, ['rm', '-q', '--cached', name]);
    gitIn(workdir, ['commit', '-q', '-m', `Remove ${name}`]);
    await assert.rejects(publish(input), (error: unknown) => error instanceof PublishRefused && error.code === 'generated', name);
    assert.equal(remoteHead(), '');
  }
});

test('the base branch is never published, and a branch with no commit of its own has nothing to publish', async () => {
  const { input } = await setup();
  await assert.rejects(publish({ ...input, branch: 'main' }), (error: unknown) => error instanceof PublishRefused && error.code === 'base');
  await assert.rejects(publish(input), (error: unknown) => error instanceof PublishRefused && error.code === 'empty');
});

test('an open pull request for the branch is reused after the push', async () => {
  const { workdir, input, gh, remoteHead } = await setup([{ number: 5, url: 'https://github.com/example/guestbook/pull/5' }]);
  const head = commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, 'Second round');
  assert.deepEqual(await publish(input), { url: 'https://github.com/example/guestbook/pull/5', number: 5, head, created: false });
  assert.equal(remoteHead(), head);
  assert.deepEqual(gh.calls().map((c) => c.args[1]), ['list']);
});

test('a report the guard flags is left out of the body, the pull request still opens', async () => {
  const { workdir, input, gh } = await setup();
  commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, 'Newest first');
  await publish({ ...input, report: `## Done\nUsed ${plantedKey} to test.\n` });
  const body = gh.calls()[1]?.body ?? '';
  assert.ok(!body.includes(plantedKey));
  assert.ok(body.includes('- Newest first'));
});

test('nothing the session wrote in its git folder runs on the host: no hook, no fsmonitor', async () => {
  const { root, workdir, input, remoteHead } = await setup();
  const marker = join(root, 'ran');
  const script = join(root, 'planted.sh');
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(script, 0o755);
  const head = commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, 'Newest first');
  for (const hook of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-commit', 'post-index-change', 'pre-receive', 'update', 'post-update']) {
    writeFileSync(join(workdir, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(workdir, '.git', 'hooks', hook), 0o755);
  }
  gitIn(workdir, ['config', 'core.fsmonitor', script]);
  gitIn(workdir, ['config', 'core.hooksPath', join(workdir, '.git', 'hooks')]);
  await publish(input);
  assert.equal(existsSync(marker), false);
  assert.equal(remoteHead(), head);
});

test('a checkout whose git folder points elsewhere is refused', async () => {
  const { root, workdir, input, gh } = await setup();
  commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, 'Newest first');
  const elsewhere = join(root, 'elsewhere.git');
  gitIn(root, ['clone', '-q', '--bare', join(workdir, '.git'), elsewhere]);
  rmSync(join(workdir, '.git'), { recursive: true });
  writeFileSync(join(workdir, '.git'), `gitdir: ${elsewhere}\n`);
  await assert.rejects(publish(input), (error: unknown) => error instanceof PublishRefused && error.code === 'unsafe');
  assert.deepEqual(gh.calls(), []);
});
