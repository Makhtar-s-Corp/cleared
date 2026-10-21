import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realEffects } from '../../src/flow/effects.ts';
import { CONFIG } from './support.ts';
import { remote, tempDir } from '../workspace/git.ts';

const CONF = '[merge]\nverdict = no blocking issues\n[session]\nsafe_commands = npm ci, npm test\nhosts = registry.npmjs.org\n[guard]\nterms = none\nallowed = none\n';
const PACKAGE = JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } });

async function effects(files: Record<string, string> = { '.cleared/agents.conf': CONF, 'package.json': PACKAGE }, extra: { releaseRequest?: string; requestTimeoutMs?: number } = {}) {
  const root = tempDir('flow-effects');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: join(root, 'state') };
  delete env.ORCH_LEDGER;
  const config = { ...CONFIG, projectDir: join(root, 'project'), repoUrl: remote(files), workdirRoot: join(root, 'work') };
  return { root, config, flow: realEffects(config, { env, ...extra }) };
}

test('prepareWorkdir for the author clones the project, makes the ticket checkout on its branch and writes CLAUDE.md', async () => {
  const { config, flow } = await effects();
  const prepared = await flow.prepareWorkdir({ ticket: { id: 'LOCAL-1', title: 'Newest first', body: 'Sort.', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' }, role: 'author' });
  assert.equal(prepared.workdir, join(config.workdirRoot, 'LOCAL-1'));
  assert.equal(readFileSync(join(prepared.workdir, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/cleared/LOCAL-1');
  assert.match(readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8'), /Project memory/);
  // The reviewer works in the same checkout, with its own briefing.
  const again = await flow.prepareWorkdir({ ticket: { id: 'LOCAL-1', title: 'Newest first', body: 'Sort.', labels: [], project: 'guestbook', status: 'In Review', createdAt: 'x', updatedAt: 'x' }, role: 'reviewer' });
  assert.equal(again.workdir, prepared.workdir);
});

test('settings reads the verdict phrase, the lists and the package scripts at the base branch of the project checkout', async () => {
  const { flow } = await effects();
  await flow.refreshProject();
  assert.deepEqual(await flow.settings(), {
    verdict: 'no blocking issues', safeCommands: ['npm ci', 'npm test'], hosts: ['registry.npmjs.org'], scripts: ['test', 'typecheck'],
  });
});

test('settings refuses a project without a verdict phrase, and a base with no package.json has no scripts', async () => {
  const none = await effects({ '.cleared/agents.conf': '[guard]\nterms = none\nallowed = none\n' });
  await none.flow.refreshProject();
  await assert.rejects(none.flow.settings(), /verdict/);
  const bare = await effects({ '.cleared/agents.conf': CONF });
  await bare.flow.refreshProject();
  assert.deepEqual((await bare.flow.settings()).scripts, []);
});

test('requestRelease runs the lock\'s client with request_release, the ticket, the pull request and --ask, the announcement on stdin', async () => {
  const root = tempDir('flow-lock');
  const out = join(root, 'out.json');
  const stub = join(root, 'release-request.mjs');
  writeFileSync(stub, `import { writeFileSync } from 'node:fs';
let input = ''; for await (const c of process.stdin) input += c;
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), input, repo: process.env.CLEARED_REPO }));`);
  const { config, flow } = await effects(undefined, { releaseRequest: stub });
  await flow.requestRelease({ ticket: 'LOCAL-1', pr: 7, announcement: 'Ticket LOCAL-1: Newest first' });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { args: ['request_release', 'LOCAL-1', '7', '--ask'], input: 'Ticket LOCAL-1: Newest first', repo: config.projectDir });
});

test('requestRelease rejects with the lock\'s message when the client fails', async () => {
  const root = tempDir('flow-lock');
  const stub = join(root, 'release-request.mjs');
  writeFileSync(stub, "process.stderr.write('release broker is not running'); process.exit(69);");
  const { flow } = await effects(undefined, { releaseRequest: stub });
  await assert.rejects(flow.requestRelease({ ticket: 'LOCAL-1', pr: 7, announcement: 'x' }), /exit 69.*release broker is not running/);
});

test('requestRelease gives up when the client does not answer', async () => {
  const root = tempDir('flow-lock');
  const stub = join(root, 'release-request.mjs');
  writeFileSync(stub, 'setTimeout(() => {}, 60000);');
  const { flow } = await effects(undefined, { releaseRequest: stub, requestTimeoutMs: 200 });
  await assert.rejects(flow.requestRelease({ ticket: 'LOCAL-1', pr: 7, announcement: 'x' }), /did not answer the release request within 0 seconds/);
});

test('settings clones the project itself: the first ticket of a fresh service has no checkout yet', async () => {
  const { config, flow } = await effects();
  assert.equal(existsSync(config.projectDir), false);
  assert.equal((await flow.settings()).verdict, 'no blocking issues');
  assert.equal(existsSync(config.projectDir), true);
});
