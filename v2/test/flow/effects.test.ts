import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksOf, realEffects } from '../../src/flow/effects.ts';
import { CONFIG } from './support.ts';
import { remote, tempDir } from '../workspace/git.ts';

const CONF = '[merge]\nverdict = no blocking issues\n[session]\nsafe_commands = npm ci, npm test\nhosts = registry.npmjs.org\n[guard]\nterms = none\nallowed = none\n';
const PACKAGE = JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } });

async function effects(files: Record<string, string> = { '.cleared/agents.conf': CONF, 'package.json': PACKAGE }, extra: { releaseRequest?: string; requestTimeoutMs?: number; mergeTimeoutMs?: number } = {}) {
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
    verdict: 'no blocking issues', safeCommands: ['npm ci', 'npm test'], hosts: ['registry.npmjs.org'], services: [], scripts: ['test', 'typecheck'],
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

test('requestRelease answers the request time the lock recorded, which the approval is bound to', async () => {
  const root = tempDir('flow-lock');
  const stub = join(root, 'release-request.mjs');
  // As ask-validation.sh: the record, with its nanosecond time, in the state folder.
  writeFileSync(stub, `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const c of process.stdin) void c;
mkdirSync(process.env.CLEARED_STATE_DIR + '/validations', { recursive: true });
writeFileSync(process.env.CLEARED_STATE_DIR + '/validations/LOCAL-1.json', JSON.stringify({ ticket: 'LOCAL-1', at: '2026-10-21T22:26:42.242293461Z', pulls: [{ pr: 7, head: '${'a'.repeat(40)}' }] }));`);
  const { flow } = await effects(undefined, { releaseRequest: stub });
  assert.deepEqual(await flow.requestRelease({ ticket: 'LOCAL-1', pr: 7, announcement: 'x' }), { requestedAt: '2026-10-21T22:26:42.242293461Z' });
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

test('the checks of a pull request, as the release card says them, from the buckets gh pr checks gives', () => {
  assert.equal(checksOf([]), 'pending', 'no check reported yet');
  assert.equal(checksOf([{ bucket: 'pass' }, { bucket: 'skipping' }]), 'passed');
  assert.equal(checksOf([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending');
  assert.equal(checksOf([{ bucket: 'pending' }, { bucket: 'fail' }]), 'failed');
  assert.equal(checksOf([{ bucket: 'cancel' }]), 'failed');
});

// A stand-in for release-request.mjs that records what it was given and exits with `code`.
function lockStub(code: number, stderr = '', wait = false) {
  const root = tempDir('flow-merge');
  const out = join(root, 'out.json');
  const stub = join(root, 'release-request.mjs');
  writeFileSync(stub, `import { writeFileSync } from 'node:fs';
let input = ''; for await (const c of process.stdin) input += c;
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), input, repo: process.env.CLEARED_REPO, queue: process.env.ORCH_FROM_QUEUE }));
process.stderr.write(${JSON.stringify(stderr)});
${wait ? 'setTimeout(() => {}, 60000);' : `process.exit(${code});`}`);
  return { stub, out };
}

test('mergeRelease asks the lock to merge, without --ask, the announcement on stdin, as a retry of the queue', async () => {
  const { stub, out } = lockStub(0);
  const { config, flow } = await effects(undefined, { releaseRequest: stub });
  assert.deepEqual(await flow.mergeRelease({ ticket: 'LOCAL-1', pr: 7, announcement: 'Ticket LOCAL-1: Newest first' }), { outcome: 'merged', message: '' });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { args: ['request_release', 'LOCAL-1', '7'], input: 'Ticket LOCAL-1: Newest first', repo: config.projectDir, queue: '1' });
});

test('mergeRelease reads the client\'s exit: 5 queued, 1 refused for good, anything else unavailable, with the last line it said', async () => {
  const cases: [number, string][] = [[5, 'queued'], [1, 'refused'], [69, 'unavailable'], [64, 'unavailable'], [3, 'unavailable']];
  for (const [code, outcome] of cases) {
    const { stub } = lockStub(code, `merge-pr.sh: something\n#7 is not put live: exit ${code}\n`);
    const { flow } = await effects(undefined, { releaseRequest: stub });
    assert.deepEqual(await flow.mergeRelease({ ticket: 'LOCAL-1', pr: 7, announcement: 'x' }), { outcome, message: `#7 is not put live: exit ${code}` }, `exit ${code}`);
  }
});

test('mergeRelease that gets no answer in time is unavailable, and asked again later', async () => {
  const { stub } = lockStub(0, '', true);
  const { flow } = await effects(undefined, { releaseRequest: stub, mergeTimeoutMs: 200 });
  const merge = await flow.mergeRelease({ ticket: 'LOCAL-1', pr: 7, announcement: 'x' });
  assert.equal(merge.outcome, 'unavailable');
  assert.match(merge.message, /did not answer/);
});
