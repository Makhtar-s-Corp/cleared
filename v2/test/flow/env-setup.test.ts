// The setup session (docs/v2/milestone-5-plan.md, section 13, decision 14,
// matrix C4): a ticket of the "Prepare the environment" template, whose
// author writes the service's .devcontainer. Before its reviewer, the flow
// builds the image of the ticket's branch with the prepared images' builder
// and runs the service's declared check inside it: a failure goes back to
// the author with the output cleaned and cut, a pass goes to the review.
// After its merge, the service's prepared image is built again. Against a
// fake `docker`, temporary repositories and the fake harness: no Docker, no
// network, no real session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Docker, LABEL, ROLE_LABEL, SESSION_LABEL } from '../../src/container/docker.ts';
import { parseServices } from '../../src/container/services.ts';
import { PreparedImages, readRecord, type PreparedSource } from '../../src/container/prepared.ts';
import {
  ENV_CHECK_ROUNDS, ENVIRONMENT_LABEL, EnvCheckStore, checkBranch, declaredCheck, envCheckComment, envCheckRequest, environmentAfterMerge, hasDevcontainer, isEnvironmentTicket, took,
  type EnvCheck,
} from '../../src/flow/env-setup.ts';
import type { FlowEffects } from '../../src/flow/engine.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import { openStore } from '../../src/store/db.ts';
import { typeLabel } from '../../src/tickets/templates.ts';
import { commit, gitIn, tempDir } from '../workspace/git.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { LOCK, fetched, land, project } from '../container/prepared-fixture.ts';
import { REPORT_PASS, finished, quickAuthor, reopenScript, reviewerScript, setup, started, text, until, type Setup } from './support.ts';
import { execFileSync } from 'node:child_process';

const BRANCH = 'cleared/LOCAL-1';
const REF = `refs/cleared/step/api/${BRANCH}`;
const DEVCONTAINER = '{ "build": { "dockerfile": "Dockerfile" } }\n';
const DOCKERFILE = 'FROM cleared-v2-session:latest\nRUN apt-get install -y sqlite3\n';

// The ticket's branch on the forge, as its author pushed it, fetched into
// the service's checkout under the ref the flow reads a branch from.
function branch(bare: string, source: PreparedSource, files: Record<string, string>): string {
  const work = join(tempDir('branch'), 'work');
  execFileSync('git', ['clone', '-q', bare, work]);
  gitIn(work, ['checkout', '-q', '-b', BRANCH]);
  const head = commit(work, files, 'the environment');
  gitIn(work, ['push', '-q', 'origin', BRANCH]);
  gitIn(source.dir, ['fetch', '-q', 'origin', `+refs/heads/${BRANCH}:${REF}`]);
  return head;
}

const builds = (fake: FakeDocker) => fake.calls.filter((call) => call.args[0] === 'build');
const valueOf = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];
const labelsOf = (args: readonly string[]): string[] => args.flatMap((arg, at) => (arg === '--label' ? [args[at + 1] as string] : []));

// What each build's context held while it ran: the Dockerfile and the files.
function recordBuilds(fake: FakeDocker): { dockerfile: string; files: Record<string, string> }[] {
  const seen: { dockerfile: string; files: Record<string, string> }[] = [];
  fake.intercept = (args) => {
    if (args[0] !== 'build') return undefined;
    const context = args[args.length - 1] as string;
    const file = valueOf(args, '--file') ?? join(context, 'Dockerfile');
    const files = Object.fromEntries(readdirSync(context).filter((n) => n !== 'Dockerfile' && n !== '.devcontainer').map((n) => [n, readFileSync(join(context, n), 'utf8')]));
    seen.push({ dockerfile: readFileSync(file, 'utf8'), files });
    return undefined;
  };
  return seen;
}

// ------------------------------------------------------------ the check

test('the image is built from the ticket\'s branch, never the base, and the declared check runs in it with no network, then everything is removed by its label', async () => {
  const { bare, source } = project();
  branch(bare, source, { '.devcontainer/devcontainer.json': DEVCONTAINER, '.devcontainer/Dockerfile': DOCKERFILE, 'package-lock.json': LOCK('8.13.2') });
  const fake = new FakeDocker();
  const seen = recordBuilds(fake);
  let mounted: string[] = [];
  fake.execAnswer = (command) => {
    // The branch's files are mounted at /workspace while the check runs.
    const mount = fake.containers[0]?.args?.find((arg) => arg.startsWith('type=bind,')) ?? '';
    const from = /source=([^,]+)/.exec(mount)?.[1] ?? '';
    mounted = existsSync(from) ? readdirSync(join(from)).sort() : [];
    assert.deepEqual(command, ['npm', 'test']);
    return { code: 0, stdout: 'ok 1 - the entries\n# pass 1\n', stderr: '' };
  };
  const stateDir = tempDir('env-state');
  const check = await checkBranch({ docker: new Docker(fake.runner), stateDir, source, ref: REF, declared: { command: ['npm', 'test'], services: [] } });

  assert.equal(check.outcome, 'passed');
  assert.equal(check.command, 'npm test');
  assert.equal(check.devcontainer, 'dockerfile');
  assert.match(check.tail ?? '', /# pass 1/);
  assert.equal(typeof check.buildMs, 'number');

  // The branch's Dockerfile first, then Cleared's layer with the branch's lock file.
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.dockerfile, DOCKERFILE);
  assert.match(seen[1]?.dockerfile ?? '', /^FROM cleared-v2-check-api:[0-9a-f]{16}-devcontainer$/m);
  assert.equal(seen[1]?.files['package-lock.json'], LOCK('8.13.2'), 'the branch\'s lock file, not the base\'s');
  for (const build of builds(fake)) {
    const labels = labelsOf(build.args);
    assert.ok(labels.includes(LABEL));
    assert.ok(labels.some((label) => label.startsWith(`${SESSION_LABEL}=`)), 'the check\'s own session label, so that its removal finds them');
    assert.ok(!labels.some((label) => label.startsWith('cleared.service=') || label.startsWith('cleared.prepared=')), 'never counted as a prepared image of the service');
    assert.doesNotMatch(valueOf(build.args, '--tag') ?? '', /^cleared-v2-prep-/);
  }

  const create = fake.calls.find((call) => call.args[0] === 'create')?.args ?? [];
  assert.equal(valueOf(create, '--network'), 'name=none', 'the check reaches no network');
  assert.equal(valueOf(create, '--cap-drop'), 'ALL');
  assert.ok(create.includes('no-new-privileges'));
  assert.ok(labelsOf(create).includes(`${ROLE_LABEL}=env-check`));
  assert.equal(valueOf(create, '--workdir'), '/workspace');
  assert.equal(valueOf(create, '--entrypoint'), 'sleep', 'whatever ENTRYPOINT the project\'s image names, the container waits for the check');
  assert.match(create.find((arg) => arg.startsWith('type=bind,')) ?? '', /,target=\/workspace$/);
  assert.ok(mounted.includes('.devcontainer') && mounted.includes('package.json'), 'the branch\'s tree is mounted');

  assert.deepEqual(fake.withLabel('cleared.dev', 'v2'), [], 'the container and both images are removed');
  assert.deepEqual(existsSync(join(stateDir, 'env-check')) ? readdirSync(join(stateDir, 'env-check')) : [], [], 'the branch\'s files are removed');
  assert.equal(readRecord(stateDir, 'api'), undefined, 'the prepared image\'s record is not touched');
  // The base is unchanged: its image would still be built from its own files.
  assert.notEqual(gitIn(source.dir, ['rev-parse', 'refs/remotes/origin/main']), gitIn(source.dir, ['rev-parse', REF]));
});

test('the declared test services run first, as a session\'s, on an internal network that is the check\'s only one, with their variables; a service never ready stops the check', async () => {
  const { bare, source } = project();
  branch(bare, source, { '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n' });
  const fake = new FakeDocker();
  const execs: string[][] = [];
  let ready = 2;
  fake.execAnswer = (command) => {
    execs.push([...command]);
    if (command[0] === 'pg_isready') return { code: --ready > 0 ? 2 : 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '# pass 7\n', stderr: '' };
  };
  const services = parseServices('postgres:16');
  const check = await checkBranch({ docker: new Docker(fake.runner), stateDir: tempDir('env-state'), source, ref: REF, declared: { command: ['npm', 'test'], services } });
  assert.equal(check.outcome, 'passed');
  assert.deepEqual(execs.map((c) => c[0]), ['pg_isready', 'pg_isready', 'npm'], 'waited for the service, then the check');
  const network = fake.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create')?.args ?? [];
  assert.ok(network.includes('--internal') && network.includes('com.docker.network.bridge.gateway_mode_ipv4=isolated'), 'no way out of it');
  const creates = fake.calls.filter((c) => c.args[0] === 'create').map((c) => c.args);
  assert.equal(creates.length, 2);
  assert.match(valueOf(creates[0]!, '--network') ?? '', /^name=cleared-v2-[0-9a-f-]{36},alias=postgres$/);
  assert.equal(creates[0]!.at(creates[0]!.indexOf('--') + 1), 'postgres:16');
  assert.match(valueOf(creates[1]!, '--network') ?? '', /^name=cleared-v2-[0-9a-f-]{36}$/, 'the check is on that network, not on none');
  assert.ok(creates[1]!.includes('DATABASE_URL=postgres://postgres@postgres:5432/postgres'));
  assert.deepEqual(fake.withLabel('cleared.dev', 'v2'), [], 'the service, the network, the container and the image removed');

  const never = new FakeDocker();
  never.execAnswer = (command) => ({ code: command[0] === 'pg_isready' ? 2 : 0, stdout: '', stderr: '' });
  const { checkImage } = await import('../../src/flow/env-setup.ts');
  await assert.rejects(checkImage({ docker: new Docker(never.runner), session: '00000000-0000-4000-8000-000000000001', image: 'cleared-v2-check-api:1', tree: tempDir('tree'), workdir: '/workspace', command: ['npm', 'test'], services, readyTimeoutMs: 600 }),
    /the test service postgres did not become ready within 1 s/);
});

test('a check that fails keeps the last lines of its output, each cut; a build that fails keeps the build\'s last lines, and nothing is run', async () => {
  const { bare, source } = project();
  branch(bare, source, { '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n' });
  const fake = new FakeDocker();
  const lines = Array.from({ length: 40 }, (_, n) => `line ${n + 1}`);
  fake.execAnswer = () => ({ code: 1, stdout: `${lines.join('\n')}\n${'x'.repeat(2000)}\n`, stderr: 'npm ERR! Test failed.\n' });
  const failed = await checkBranch({ docker: new Docker(fake.runner), stateDir: tempDir('env-state'), source, ref: REF, declared: { command: ['npm', 'test'], services: [] } });
  assert.equal(failed.outcome, 'failed');
  const tail = (failed.tail ?? '').split('\n');
  assert.equal(tail.length, 15);
  assert.equal(tail.at(-1), 'npm ERR! Test failed.');
  assert.ok(tail.every((line) => line.length <= 301), 'a long line is cut');
  assert.ok(!tail.includes('line 1'));
  assert.deepEqual(fake.withLabel('cleared.dev', 'v2'), []);

  const broken = new FakeDocker();
  broken.intercept = (args) => (args[0] === 'build'
    ? { code: 1, stdout: '', stderr: '#0 building with "default" instance using docker driver\n#5 [2/3] RUN npm ci\n#5 ERROR: npm ERR! missing: pg@8.13.1\nERROR: failed to solve: process did not complete successfully: exit code: 1\n' }
    : undefined);
  const notBuilt = await checkBranch({ docker: new Docker(broken.runner), stateDir: tempDir('env-state'), source, ref: REF, declared: { command: ['npm', 'test'], services: [] } });
  assert.equal(notBuilt.outcome, 'build_failed');
  assert.match(notBuilt.tail ?? '', /npm ERR! missing: pg@8\.13\.1/, 'the build\'s own words, not its first line alone');
  assert.equal(notBuilt.checkMs, null);
  assert.ok(!broken.calls.some((call) => call.args[0] === 'create'), 'no container for an image that was not built');
});

test('a devcontainer file the builder cannot use is a failed build said to the author; with no declared check the image building is the whole check', async () => {
  const { bare, source } = project();
  branch(bare, source, { '.devcontainer/devcontainer.json': '{ "image": "node:24", "build": { "dockerfile": "Dockerfile" } }\n' });
  const fake = new FakeDocker();
  const unusable = await checkBranch({ docker: new Docker(fake.runner), stateDir: tempDir('env-state'), source, ref: REF, declared: { command: ['npm', 'test'], services: [] } });
  assert.equal(unusable.outcome, 'build_failed');
  assert.match(unusable.tail ?? '', /give either image or build\.dockerfile/);
  assert.equal(builds(fake).length, 0);

  const plain = project();
  branch(plain.bare, plain.source, { '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n' });
  const quiet = new FakeDocker();
  const none = await checkBranch({ docker: new Docker(quiet.runner), stateDir: tempDir('env-state'), source: plain.source, ref: REF, declared: undefined });
  assert.equal(none.outcome, 'no_check');
  assert.equal(none.command, null);
  assert.equal(builds(quiet).length, 1);
  assert.ok(!quiet.calls.some((call) => call.args[0] === 'create'), 'nothing to run');
  assert.deepEqual(quiet.withLabel('cleared.dev', 'v2'), []);
});

test('the words: durations a person reads, the comment and the request to the author name the check, the round and what to change', () => {
  assert.equal(took(800), '1 s');
  assert.equal(took(34_000), '34 s');
  assert.equal(took(130_000), '2 min 10 s');
  assert.equal(took(120_000), '2 min');
  assert.equal(took(3_900_000), '1 h 05');
  const passed: EnvCheck = { outcome: 'passed', command: 'npm test', tail: '# pass 1', buildMs: 130_000, checkMs: 34_000, devcontainer: 'dockerfile' };
  assert.equal(envCheckComment(passed, 1), 'Environment check, round 1: the branch\'s image built in 2 min 10 s from the Dockerfile its .devcontainer names, and `npm test` passed in it in 34 s.');
  const none: EnvCheck = { outcome: 'no_check', command: null, tail: null, buildMs: 34_000, checkMs: null, devcontainer: 'image' };
  assert.match(envCheckComment(none, 2), /^Environment check, round 2: the branch's image built in 34 s from the image its \.devcontainer names\. The service declares no check/);
  const failed: EnvCheck = { outcome: 'failed', command: 'npm test', tail: 'not ok 1\n```\nboom', buildMs: 34_000, checkMs: 5_000, devcontainer: 'none' };
  const comment = envCheckComment(failed, 1);
  assert.match(comment, /`npm test` failed in it after 5 s\. The last lines of its output:\n\n```\nnot ok 1\n'''\nboom\n```$/, 'a fence in the output cannot close the block');
  const request = envCheckRequest(failed, 1, ENV_CHECK_ROUNDS);
  assert.match(request, /^The environment check failed \(attempt 1 of 3\)/);
  assert.match(request, /\.devcontainer\/devcontainer\.json/);
  assert.match(request, /runs again before the review/);
  assert.match(envCheckRequest({ ...failed, outcome: 'build_failed', checkMs: null, command: 'npm test' }, 2, 3), /the branch's image could not be built/);
  assert.equal(isEnvironmentTicket([typeLabel('environment')]), true);
  assert.equal(isEnvironmentTicket(['type:bug', 'Quick']), false);
  assert.equal(ENVIRONMENT_LABEL, 'type:environment');
});

test('the checks\' rows: each round kept, the failures counted per ticket', () => {
  const checks = new EnvCheckStore(openStore(':memory:').db);
  const failed: EnvCheck = { outcome: 'failed', command: 'npm test', tail: 'x', buildMs: 1, checkMs: 1, devcontainer: 'none' };
  assert.equal(checks.failures('LOCAL-1'), 0);
  assert.equal(checks.add('LOCAL-1', 'guestbook', failed, '2026-10-27T10:00:00.000Z'), 1);
  assert.equal(checks.add('LOCAL-1', 'guestbook', { ...failed, outcome: 'build_failed' }, '2026-10-27T10:05:00.000Z'), 2);
  assert.equal(checks.add('LOCAL-1', 'guestbook', { ...failed, outcome: 'passed' }, '2026-10-27T10:10:00.000Z'), 3);
  assert.equal(checks.add('LOCAL-2', 'guestbook', failed, '2026-10-27T10:10:00.000Z'), 1);
  assert.equal(checks.failures('LOCAL-1'), 2);
  assert.deepEqual(checks.list('LOCAL-1').map((row) => row.outcome), ['failed', 'build_failed', 'passed']);
});

test('the assistant reads, at the base only, whether a service has a .devcontainer and which check it declares', async () => {
  const plain = project();
  assert.equal(await hasDevcontainer(plain.source), false);
  assert.deepEqual(await declaredCheck(plain.source), { command: ['npm', 'test'], services: [] }, 'package.json\'s test script');
  branch(plain.bare, plain.source, { '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n' });
  assert.equal(await hasDevcontainer(plain.source), false, 'a branch is not the base');
  land(plain.bare, { '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n', '.cleared/agents.conf': '[merge]\nverdict = ok\n[session]\ntest_command = npm run check\n' });
  fetched(plain.source);
  assert.equal(await hasDevcontainer(plain.source), true);
  assert.deepEqual((await declaredCheck(plain.source))?.command, ['npm', 'run', 'check']);

  const folder = project({ 'web/package.json': '{}\n', 'web/.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n' }, 'web', 'web');
  assert.equal(await hasDevcontainer(folder.source), true, 'the folder\'s own');
  assert.equal(await hasDevcontainer({ ...plain.source, base: 'nowhere' }), null, 'a base not fetched');
  assert.equal(await declaredCheck({ ...plain.source, base: 'nowhere' }), undefined);
  const unset = project({ '.cleared/agents.conf': '[session]\ninstall_command = npm ci\n' });
  assert.equal(await declaredCheck(unset.source), undefined, 'settings the flow cannot read declare nothing here');
});

// ------------------------------------------------------------- the flow

type Checked = Parameters<NonNullable<FlowEffects['envCheck']>>[0];
const PASS: EnvCheck = { outcome: 'passed', command: 'npm test', tail: '# pass 3', buildMs: 61_000, checkMs: 4_000, devcontainer: 'dockerfile' };
const FAIL: EnvCheck = { outcome: 'failed', command: 'npm test', tail: 'not ok 2 - sqlite3 is missing\nSECRET-VALUE in /srv/guestbook', buildMs: 61_000, checkMs: 4_000, devcontainer: 'dockerfile' };

function checker(results: (EnvCheck | Error)[]) {
  const calls: Checked[] = [];
  const effect: FlowEffects['envCheck'] = async (input) => {
    calls.push(input);
    const next = results.shift() ?? PASS;
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, effect };
}

async function environmentTicket(t: Setup, labels = [ENVIRONMENT_LABEL]) {
  return t.tickets.create({ title: 'Prepare the environment of guestbook', body: 'Write .devcontainer/devcontainer.json.', project: 'guestbook', labels }, { kind: 'human', id: 'u1' });
}

const roles = (t: Setup) => t.startedSessions.map((s) => s.input.role);
const comments = async (t: Setup, id: string) => (await t.tickets.comments(id)).map((c) => c.body);
const putBack = (t: Setup) => t.flowEvents.filter((e): e is Extract<FlowEvent, { type: 'ticket_put_back' }> => e.type === 'ticket_put_back');

test('a ticket of another template, or of none, is never checked: no build, the review as before', async () => {
  const checked = checker([]);
  const t = await setup({ scripts: { author: quickAuthor }, effects: { envCheck: checked.effect } });
  const bug = await environmentTicket(t, [typeLabel('bug')]);
  for (const id of [t.ticket.id, bug.id]) {
    await t.engine.start(id, 'u1');
    await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === id), `the release of ${id}`, 5000);
  }
  await t.engine.settled();
  assert.deepEqual(checked.calls, []);
  await t.engine.close();
});

test('a green check goes to the review: the branch checked once, before the reviewer starts, and the ticket says so', async () => {
  const checked = checker([PASS]);
  let reviewersWhenChecked = -1;
  const t = await setup({
    scripts: { author: quickAuthor },
    effects: { envCheck: async (input) => { reviewersWhenChecked = roles(t).filter((r) => r === 'reviewer').length; return checked.effect!(input); } },
  });
  const ticket = await environmentTicket(t);
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  assert.deepEqual(checked.calls, [{ ticket: ticket.id, workdir: `/work/${ticket.id}` }]);
  assert.equal(reviewersWhenChecked, 0, 'checked before any reviewer');
  assert.deepEqual(roles(t), ['author', 'reviewer']);
  assert.ok((await comments(t, ticket.id)).includes(envCheckComment(PASS, 1)));
  await t.engine.close();
});

test('a red check goes back to the same author with the output cleaned and cut; its next turn is checked again, then reviewed', async () => {
  const checked = checker([FAIL, PASS]);
  const t = await setup({
    scripts: { author: [started, ...text('a1', 'I wrote the Dockerfile.'), finished(0.3)], reopen: reopenScript, reviewers: [reviewerScript(REPORT_PASS)] },
    effects: { envCheck: checked.effect },
    clean: (text) => text.replaceAll('SECRET-VALUE', '[secret]').replaceAll('/srv/guestbook', '<project>'),
  });
  const ticket = await environmentTicket(t);
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  assert.equal(checked.calls.length, 2, 'checked after each author turn');
  assert.deepEqual(roles(t), ['author', 'reviewer'], 'the author was resumed, not started again');
  const said = await comments(t, ticket.id);
  const first = said.find((c) => c.startsWith('Environment check, round 1'));
  assert.ok(first, said.join('\n---\n'));
  assert.match(first, /\[secret\] in <project>/, 'cleaned before it is written');
  assert.doesNotMatch(said.join('\n'), /SECRET-VALUE|\/srv\/guestbook/);
  assert.ok(said.some((c) => c.startsWith('Environment check, round 2') && c.includes('passed')));
  await t.engine.close();
});

test('the author is told the request: the resumed session receives the failed check with its output, cleaned', async () => {
  const checked = checker([FAIL, PASS]);
  const received: string[] = [];
  const t = await setup({ scripts: { author: quickAuthor, reopen: reopenScript }, effects: { envCheck: checked.effect }, clean: (text) => text.replaceAll('SECRET-VALUE', '[secret]') });
  const adapter = t.registry.sessionAdapters['claude-code']!;
  const resume = adapter.resume.bind(adapter);
  adapter.resume = async (id) => {
    const handle = await resume(id);
    return { ...handle, send: async (message) => { received.push(message.text); await handle.send(message); } };
  };
  const ticket = await environmentTicket(t);
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  assert.equal(received.length, 1);
  assert.match(received[0]!, /^The environment check failed \(attempt 1 of 3\)/);
  assert.match(received[0]!, /not ok 2 - sqlite3 is missing\n\[secret\]/);
  await t.engine.close();
});

test('a check still red after the last round puts the ticket back in Todo, with no review; a check that cannot run does too', async () => {
  const checked = checker(Array.from({ length: ENV_CHECK_ROUNDS }, () => FAIL));
  const t = await setup({ scripts: { author: quickAuthor, reopen: reopenScript }, effects: { envCheck: checked.effect } });
  const ticket = await environmentTicket(t);
  await t.engine.start(ticket.id, 'u1');
  await until(() => putBack(t).length > 0, 'the ticket put back', 5000);
  await t.engine.settled();
  assert.equal(checked.calls.length, ENV_CHECK_ROUNDS);
  assert.ok(!roles(t).includes('reviewer'));
  assert.equal(putBack(t)[0]?.reason, 'env_check_failed');
  assert.match(putBack(t)[0]?.note ?? '', /still failed after 3 rounds/);
  assert.equal((await t.tickets.get(ticket.id))?.status, t.tickets.states.todo);

  const broken = checker([new Error('docker build failed (1): Cannot connect to the Docker daemon')]);
  const u = await setup({ scripts: { author: quickAuthor }, effects: { envCheck: broken.effect } });
  const other = await environmentTicket(u);
  await u.engine.start(other.id, 'u1');
  await until(() => putBack(u).length > 0, 'the ticket put back', 5000);
  assert.equal(putBack(u)[0]?.reason, 'env_check_failed');
  assert.match(putBack(u)[0]?.note ?? '', /^The environment check could not run: docker build failed/);
  assert.ok(!roles(u).includes('reviewer'));
  await t.engine.close();
  await u.engine.close();
});

// ---------------------------------------------------------- after the merge

test('after the merge of an environment ticket, the service\'s prepared image is built, even for a service never prepared', async () => {
  const { bare, source } = project();
  const fake = new FakeDocker();
  const stateDir = tempDir('env-state');
  const images = new PreparedImages({ docker: new Docker(fake.runner), stateDir });
  const labels: Record<string, string[]> = { 'LOCAL-1': [ENVIRONMENT_LABEL], 'LOCAL-2': ['type:bug'] };
  const fetches: string[] = [];
  const listener = environmentAfterMerge({
    images, services: () => [source], labels: async (ticket) => labels[ticket] ?? [],
    fetch: async (s) => { fetches.push(s.service); fetched(s); },
  });
  const merged = (ticket: string): FlowEvent => ({ type: 'release_merged', at: '2026-10-27T10:00:00.000Z', project: 'guestbook', ticket, pr: 7 });

  await listener(merged('LOCAL-2'));
  assert.equal(builds(fake).length, 0, 'another ticket\'s merge builds nothing here');

  land(bare, { '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n' });
  await listener(merged('LOCAL-1'));
  assert.deepEqual(fetches, ['api'], 'fetched first, so the merge is in the base');
  assert.equal(builds(fake).length, 1);
  assert.equal(readRecord(stateDir, 'api')?.state, 'ready');

  // A service with a record is the prepared images' own listener's (preparedAfterMerge).
  await listener(merged('LOCAL-1'));
  assert.equal(builds(fake).length, 1);
  assert.deepEqual(fetches, ['api']);
  await listener({ type: 'release_requested', at: '2026-10-27T10:00:00.000Z', project: 'guestbook', ticket: 'LOCAL-1', session: 's', item: 'i', pr: 7, url: 'https://example.invalid/pull/7' });
  assert.equal(builds(fake).length, 1);
});
