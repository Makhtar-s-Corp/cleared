import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checksOf, realEffects } from '../../src/flow/effects.ts';
import { LESSON_HEADINGS } from '../../src/workspace/handover.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
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
    verdict: 'no blocking issues', safeCommands: ['npm ci', 'npm test'], hosts: ['registry.npmjs.org'], services: [], scripts: ['test', 'typecheck'], testCommand: ['npm', 'test'],
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

// ---- the memory levels (decision 25, lane 19) ---------------------------------

const MEMORY_FILES = {
  'docs/project.md': '# Guestbook\nA page that lists and adds entries.\n',
  'docs/glossary.md': '## Entry\nOne message of a visitor.\n',
  '.cleared/prompts/author/lessons.md': 'Run the tests before you commit.\n',
};
const MEMORY_TICKET: Ticket = { id: 'LOCAL-1', title: 'Newest entry first', body: 'Sort the Entry list.', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' };

test('a one-service workspace briefs its session as milestone 1 did, byte for byte', async () => {
  // test/workspace/fixtures/briefing-m1.md is the CLAUDE.md the code of
  // origin/v2 at 596d085 wrote for this project and this ticket.
  const { config, flow } = await effects({ '.cleared/agents.conf': CONF, 'package.json': PACKAGE, ...MEMORY_FILES });
  const prepared = await flow.prepareWorkdir({ ticket: MEMORY_TICKET, role: 'author' });
  const expected = readFileSync(new URL('../workspace/fixtures/briefing-m1.md', import.meta.url), 'utf8');
  // Milestone 1's text is unchanged; the generated project page of the
  // service (issue #274, P104) follows it, as the one section added.
  const claude = readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8');
  assert.equal(claude.slice(0, expected.length), expected);
  assert.match(claude.slice(expected.length), /^\n## Generated page of the service guestbook\n--- BEGIN MEMORY DATA ---\n/);
  assert.equal(existsSync(join(config.workdirRoot, '..', 'state', 'services')), false, 'no service level read over the workspace\'s own checkout');
});

const HANDOVER = ['## Done', 'The severity.', '## Tried and failed, and why', 'Nothing.', '## Left to do', 'Nothing.',
  '## Where the artifacts are (screenshots, logs, branches)', 'cleared/LOCAL-2', '## Open questions', 'None.', ''].join('\n');

// The proof's workspace: the guestbook first, consuming the filter API,
// which provides the contract.
function twoServices() {
  const root = tempDir('flow-levels');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: join(root, 'state') };
  delete env.ORCH_LEDGER;
  const service = (name: string, files: Record<string, string>, more: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name, kind: 'repository', repo: `example-org/${name}`, url: remote(files), base: 'main', path: null, dir: join(root, 'services', name, 'checkout'),
    healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, ...more,
  });
  const guestbook = service('guestbook', { '.cleared/agents.conf': CONF, ...MEMORY_FILES }, { consumes: ['filter-api'] });
  const filter = service('filter-api', {
    '.cleared/agents.conf': CONF, 'docs/project.md': '# Filter API\nIt checks the words of an entry.\n',
    'contract/openapi.yaml': 'openapi: 3.0.3\n', 'contract/openapi.md': '# The check contract\nPOST /check answers a severity.\n',
  }, { contract: { format: 'openapi', path: 'contract/openapi.yaml' } });
  const workspace: WorkspaceConfig = { id: 'guestbook', name: 'Guestbook and filter API', services: [guestbook, filter], file: join(root, 'workspace.conf') };
  const config = { ...CONFIG, projectDir: guestbook.dir, repoUrl: guestbook.url, workdirRoot: join(root, 'work'), workspace };
  return { root, env, guestbook, filter, flow: realEffects(config, { env }) };
}

const ticketOn = (...names: string[]): Ticket => ({ ...MEMORY_TICKET, id: 'LOCAL-2', services: names.map((name) => ({ name, branch: 'cleared/LOCAL-2', pr: null, state: 'open' as const })) });

test('a session on a service of several is briefed with the workspace, its service and the contract it provides, in that order', async () => {
  const { flow, filter } = twoServices();
  const prepared = await flow.prepareWorkdir({ ticket: ticketOn('filter-api'), role: 'author', service: filter });
  const text = readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8');
  const at = ['A page that lists and adds entries.', '## Memory of the service filter-api', 'It checks the words of an entry.', '## Memory of the contract of filter-api', 'POST /check answers a severity.']
    .map((piece) => text.indexOf(piece));
  assert.ok(at.every((n, i) => n > 0 && (i === 0 || n > (at[i - 1] as number))), `in order: ${at.join(', ')}`);
  assert.match(text, /`## Lessons for the service`[^\n]*memory of the service filter-api/);
  // What the engine is given keeps the contract's five fields, the workspace's page first.
  assert.match(prepared.briefing.projectPage, /A page that lists/);
});

test('a session on the consuming service is briefed with the contract it calls, the provider cloned for it', async () => {
  const { flow, guestbook, filter } = twoServices();
  const prepared = await flow.prepareWorkdir({ ticket: ticketOn('guestbook'), role: 'author', service: guestbook });
  const text = readFileSync(join(prepared.workdir, 'CLAUDE.md'), 'utf8');
  assert.ok(!text.includes('## Memory of the service guestbook'), 'the guestbook\'s checkout is the workspace\'s: its page is not briefed twice');
  assert.ok(!text.includes('It checks the words of an entry.'), 'the provider\'s own page is not the contract\'s');
  assert.match(text, /## Memory of the contract of filter-api\n### Page\n--- BEGIN MEMORY DATA ---\n {4}\| # The check contract/);
  assert.equal(existsSync(join(filter.dir, 'contract', 'openapi.md')), true);
});

test('the handover of a session on a service files its lessons in that service\'s memory and in its contract\'s', async () => {
  const { env, flow, filter } = twoServices();
  const { workdir } = await flow.prepareWorkdir({ ticket: ticketOn('filter-api'), role: 'author', service: filter });
  writeFileSync(join(workdir, 'HANDOVER.md'), `${HANDOVER}${LESSON_HEADINGS.service}\nKeep words.txt sorted.\n${LESSON_HEADINGS.contract}\nA severity is low or high.\n`);
  await flow.captureHandover({ workdir, role: 'author', model: 'claude-opus-5-5', ticket: 'LOCAL-2', sessionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' });
  const lessons = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare("SELECT content FROM memory_entries WHERE type = 'lesson' AND source_who LIKE 'agent:%'").all().map((row) => row.content); }
    finally { db.close(); }
  };
  const state = env.CLEARED_STATE_DIR as string;
  assert.deepEqual(lessons(join(state, 'services', 'filter-api', 'memory', 'ledger.db')), ['Keep words.txt sorted.']);
  assert.deepEqual(lessons(join(state, 'contracts', 'filter-api', 'memory', 'ledger.db')), ['A severity is low or high.']);
  assert.deepEqual(lessons(join(state, 'ledger.db')), []);
});

test('a session on the service whose checkout is the workspace\'s files its service lessons in the workspace\'s memory, which its briefing reads', async () => {
  const { env, flow, guestbook } = twoServices();
  const { workdir } = await flow.prepareWorkdir({ ticket: ticketOn('guestbook'), role: 'author', service: guestbook });
  assert.match(readFileSync(join(workdir, 'CLAUDE.md'), 'utf8'), /`## Lessons for the service` \(filed in the workspace's memory, which is this service's\)/);
  writeFileSync(join(workdir, 'HANDOVER.md'), `${HANDOVER}${LESSON_HEADINGS.service}\nThe guestbook renders on the server.\n`);
  await flow.captureHandover({ workdir, role: 'author', model: 'claude-opus-5-5', ticket: 'LOCAL-2', sessionId: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a' });
  const db = new DatabaseSync(join(env.CLEARED_STATE_DIR as string, 'ledger.db'), { readOnly: true });
  const filed = db.prepare("SELECT content FROM memory_entries WHERE type = 'lesson' AND source_who LIKE 'agent:%'").all().map((row) => row.content);
  db.close();
  assert.deepEqual(filed, ['The guestbook renders on the server.']);
  assert.equal(existsSync(join(env.CLEARED_STATE_DIR as string, 'services', 'guestbook')), false);
});
