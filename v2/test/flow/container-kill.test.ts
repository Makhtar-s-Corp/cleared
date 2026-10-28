// A running session's container killed (issue #453), end to end in one
// process: the flow engine, the real Claude Code adapter and the session
// runtime, on the fake docker CLI and a stand-in runner per attach. The
// test's only act is `docker kill` through the labelled wrapper, on the
// session container its own adapter made; the flow does the rest with no
// other call: the session resumes in a new container on the same checkout,
// or, killed past its recreations, fails with nothing of it left in Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker, SESSION_LABEL } from '../../src/container/docker.ts';
import { WORKDIR_MOUNT, sessionNames } from '../../src/container/session-runtime.ts';
import { CONTAINER_FAILED, CONTAINER_RECREATIONS } from '../../src/flow/engine.ts';
import { createClaudeCodeAdapter } from '../../src/session/adapters/claude-code.ts';
import { createCleaner } from '../../src/session/clean.ts';
import { CONTAINER_LOST, type SessionId } from '../../src/session/contract.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { FakeRunner } from '../session/claude-code/fake-runner.ts';
import { REPORT_PASS, setup, until } from './support.ts';

const DRAFT = 'export const draft = 1;\n';

// A runner that opens a turn for each message; unless `holds`, it answers
// and ends the turn, as the author or the reviewer it was started as.
function play(runner: FakeRunner, holds: boolean): void {
  let role = '';
  runner.listeners.add((line) => {
    if (line.type === 'start') role = String(line.role);
    if (line.type === 'stop') {
      runner.say({ type: 'exit', code: 0 });
      runner.exit(0);
    }
    if (line.type !== 'user') return;
    const uuid = String(line.uuid);
    runner.sdk({ type: 'command_lifecycle', state: 'started', command_uuid: uuid });
    if (holds) return;
    const text = role === 'reviewer' ? REPORT_PASS : 'Sorted, the draft kept.';
    runner.sdk({ type: 'assistant', uuid: `${uuid}-a`, message: { content: [{ type: 'text', text }] } });
    runner.sdk({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, usage: {}, modelUsage: {}, total_cost_usd: 0.3 });
  });
}

async function killable(holds: (index: number) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-kill-'));
  const workdir = join(dir, 'work');
  mkdirSync(workdir);
  const fake = new FakeDocker();
  const runners: FakeRunner[] = [];
  const docker = new Docker(fake.runner, (args) => {
    fake.calls.push({ args: [...args], options: {}, result: { code: 0, stdout: '', stderr: '' } });
    const attached = fake.containers.find((c) => c.id === args.at(-1));
    if (attached) attached.state = 'running';
    const runner = new FakeRunner();
    play(runner, holds(runners.length));
    runners.push(runner);
    return runner.process;
  });
  // A killed session container ends its attached runner with 137 and no exit line.
  fake.onKill = () => { runners.at(-1)?.exit(137); };
  const prepared: string[] = [];
  const t = await setup({
    config: { recreateBackoffMs: 1 },
    effects: {
      async prepareWorkdir({ role }) {
        prepared.push(role);
        return { workdir, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
    },
    forget: (id) => docker.removeVolumes(id),
  });
  t.registry.sessionAdapters['claude-code'] = createClaudeCodeAdapter({
    log: t.store.events, cleaner: () => createCleaner(), docker,
    runtime: { stateDir: join(dir, 'state'), loginFile: join(dir, 'claude.token'), hostAddresses: ['192.0.2.10'], user: '1000:1000', stopTimeoutMs: 200 },
  });
  const author = (): SessionId => t.store.sessions.list({ ticket: t.ticket.id }).find((row) => row.role === 'author')?.id ?? '';
  // Waits until the runner of this attach has been sent a message, so a turn is open.
  const working = (index: number) => until(() => runners[index]?.received.some((line) => line.type === 'user') === true, `runner ${index} at work`);
  const kill = (id: SessionId) => docker.kill(id, sessionNames(id).container);
  return { ...t, dir, workdir, fake, runners, prepared, author, working, kill, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a running session whose container is killed resumes in a new container on the same checkout, with no other act, and the ticket goes on', async () => {
  const t = await killable((index) => index === 0);
  try {
    await t.engine.start(t.ticket.id, 'u1');
    await t.working(0);
    const id = t.author();
    writeFileSync(join(t.workdir, 'draft.ts'), DRAFT);
    await t.kill(id);

    await until(() => t.calls.some((c) => c.startsWith('requestRelease')), 'the release asked after the review', 10_000);
    await t.engine.settled();
    const second = t.runners[1] as FakeRunner;
    assert.deepEqual(second.received.find((line) => line.type === 'start'), { type: 'start', sessionId: id, model: 'claude-opus-5-5', resume: true, role: 'author' });
    assert.match(String(second.received.find((line) => line.type === 'user')?.text), /recreated on the same checkout/);
    const sessionCreates = t.fake.calls.filter((c) => c.args[0] === 'create' && c.args.includes('cleared.role=session') && c.args.includes(`${SESSION_LABEL}=${id}`));
    assert.equal(sessionCreates.length, 2, 'the session container, then the recreated one');
    for (const create of sessionCreates) assert.ok(create.args.includes(`type=bind,source=${t.workdir},target=${WORKDIR_MOUNT}`), 'the same checkout');
    assert.equal(readFileSync(join(t.workdir, 'draft.ts'), 'utf8'), DRAFT, 'the uncommitted file is kept');
    assert.deepEqual(t.prepared.filter((role) => role === 'author'), ['author'], 'the checkout is not prepared again');
    assert.equal(t.fake.volumes.filter((v) => v.labels[SESSION_LABEL] === id).length, 1, 'one config volume, the same');
    const events = t.store.events.after(id).map(({ event }) => event);
    assert.deepEqual(events.flatMap((e) => (e.type === 'RUN_ERROR' ? [e.code] : [])), [CONTAINER_LOST]);
    assert.deepEqual(events.flatMap((e) => (e.type === 'CUSTOM' && e.name === 'cleared.container_recreated' ? [e.value.attempt] : [])), [1]);
    assert.equal(t.flowEvents.some((e) => e.type === 'ticket_put_back'), false);
    // The kill named the id a list filtered on the label and the session returned.
    const kill = t.fake.calls.findIndex((c) => c.args[0] === 'kill');
    assert.ok(t.fake.calls[kill - 1]?.args.includes('label=cleared.dev=v2') && t.fake.calls[kill - 1]?.args.includes(`label=${SESSION_LABEL}=${id}`));
  } finally { t.cleanup(); }
});

test('a session killed once more than it is recreated fails with its reason, and Docker holds nothing of it', async () => {
  const t = await killable(() => true);
  try {
    await t.engine.start(t.ticket.id, 'u1');
    for (let index = 0; index <= CONTAINER_RECREATIONS; index++) {
      await t.working(index);
      await t.kill(t.author());
    }
    await until(() => t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the ticket put back', 10_000);
    await t.engine.settled();
    const id = t.author();
    assert.equal(t.runners.length, CONTAINER_RECREATIONS + 1, 'no fourth recreation');
    const codes = t.store.events.after(id).flatMap(({ event }) => (event.type === 'RUN_ERROR' ? [event.code] : []));
    assert.deepEqual(codes, [CONTAINER_LOST, CONTAINER_LOST, CONTAINER_LOST, CONTAINER_LOST, CONTAINER_FAILED]);
    assert.deepEqual(t.fake.withLabel(SESSION_LABEL, id), [], 'no container, network, volume or image of the session is left');
    assert.equal(t.store.sessions.get(id)?.status, 'failed');
  } finally { t.cleanup(); }
});
