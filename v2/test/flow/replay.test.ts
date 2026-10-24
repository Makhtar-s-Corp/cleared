// Resume from here (issue #272, flow/replay.ts): the flow journals the tip
// of the author's branch at the start and after each tool call that moved
// it; POST /api/sessions/:id/replay stops the ticket's sessions, has the
// effect keep the old checkout and branch aside and make a new branch at the
// commit the step began from, and starts a new author there with the
// owner's corrected instruction. The old session keeps its events. The
// ticket's later sessions and its publish use the new branch, across a
// restart. The effect's git is tested on real repositories at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { realEffects } from '../../src/flow/effects.ts';
import { FlowEngine, type FlowEffects } from '../../src/flow/engine.ts';
import { MAX_REPLAY, ReplayStore, replayRoutes, stepCommit } from '../../src/flow/replay.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionId } from '../../src/session/contract.ts';
import { toolArgs, toolResult, type AgUiEvent, type SessionEvent, type ToolInput, type ToolOutput } from '../../src/session/events.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { BASE_REF, CheckoutError, readTip, replayBranch, ticketBranch, ticketCheckout } from '../../src/workspace/checkout.ts';
import { commit, gitIn, remote, tempDir } from '../workspace/git.ts';
import { CONFIG, finished, quickAuthor, started, setup, until, type Setup, type SetupOptions } from './support.ts';

const PROOF = 'e'.repeat(64);
const BASE = 'a'.repeat(40);
const C1 = 'b'.repeat(40);
const C2 = 'c'.repeat(40);

const call = (id: string, input: ToolInput, output: ToolOutput): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: input.kind === 'execute' ? 'Bash' : 'Edit' } },
  { emit: toolArgs(id, input) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: id } },
  { emit: toolResult(`${id}-result`, id, output) },
];

// Reads, waits; commits, waits; edits, waits: the test moves the branch's
// tip while the session waits, as the agent's commit would.
const wandering: readonly FakeStep[] = [
  started,
  ...call('read-1', { kind: 'read', path: 'src/entries.ts' }, { kind: 'read', path: 'src/entries.ts', bytes: 120 }),
  { awaitMessage: true },
  ...call('run-1', { kind: 'execute', command: 'git commit -qam "Sort by name"' }, { kind: 'execute', output: '', cut: 0, isError: false }),
  { awaitMessage: true },
  ...call('edit-1', { kind: 'edit', path: 'src/entries.ts', added: 3, removed: 1 }, { kind: 'edit', ok: true }),
  { awaitMessage: true },
  finished(0.4),
];

type Harness = Setup & {
  readonly base: string; readonly server: Server; readonly tip: { branch: string; commit: string };
  readonly replays: Parameters<NonNullable<FlowEffects['replay']>>[0][]; readonly branches: { readonly role: string; readonly branch: string | undefined }[];
  readonly published: string[];
  close(): Promise<void>;
};

async function harness(options: SetupOptions & { readonly replayFails?: boolean; readonly noHead?: boolean } = {}): Promise<Harness> {
  const tip = { branch: 'cleared/LOCAL-1', commit: BASE };
  const replays: Harness['replays'] = [];
  const branches: Harness['branches'] = [];
  const published: string[] = [];
  const effects: Partial<FlowEffects> = {
    async prepareWorkdir({ ticket, role, branch }) {
      branches.push({ role, branch });
      return { workdir: `/work/${ticket.id}`, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
    },
    async publish(input) { published.push(input.branch); return { url: 'https://example.invalid/pull/7', number: 7, head: C1, created: true }; },
    ...(options.noHead ? {} : { async head() { return { ...tip }; } }),
    async replay(input) {
      replays.push(input);
      if (options.replayFails) throw new Error(`the commit ${input.commit.slice(0, 12)} is not in the history of ${input.previous}`);
      // The new checkout is on the new branch, at the step's commit.
      tip.branch = input.branch;
      tip.commit = input.commit;
      return { previousHead: C2, aside: `/work/.${input.ticket}.before-r${input.n}` };
    },
    ...options.effects,
  };
  const t = await setup({ scripts: { authors: [wandering, quickAuthor] }, ...options, effects });
  t.users.users.set('u2', { id: 'u2', name: 'Second' });
  const app: App = { registry: t.engine.registry, tables: [], routes: replayRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...t, base, server, tip, replays, branches, published,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t.engine.close();
    },
  };
}

const as = (user: string) => ({ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: user, 'content-type': 'application/json' });

async function post(h: Harness, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h.base}${path}`, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const eventsOf = (h: Harness, id: SessionId): SessionEvent[] => h.store.events.after(id);
const checkpoints = (h: Harness, id: SessionId) => eventsOf(h, id).flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.checkpoint' ? [e.event.value] : []));
const resulted = (h: Harness, id: SessionId, call: string) => eventsOf(h, id).some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.toolCallId === call);
const startOf = (h: Harness, id: SessionId, call: string) => (eventsOf(h, id).find((e) => e.event.type === 'TOOL_CALL_START' && e.event.toolCallId === call) as SessionEvent).seq;

// The author reads, commits C1, edits and commits C2, then waits.
async function wandered(h: Harness): Promise<SessionId> {
  await h.engine.start(h.ticket.id, 'u1');
  await until(() => h.startedSessions.length === 1 && resulted(h, h.startedSessions[0]!.id, 'read-1'), 'the read');
  const author = h.startedSessions[0]!.id;
  h.tip.commit = C1;
  await h.engine.send(author, 'Go on.', 'u1');
  await until(() => checkpoints(h, author).length === 2, 'the commit\'s checkpoint');
  h.tip.commit = C2;
  await h.engine.send(author, 'Go on.', 'u1');
  await until(() => checkpoints(h, author).length === 3, 'the edit\'s checkpoint');
  await h.engine.settled();
  return author;
}

test('the author\'s branch is journaled when the session starts and after each tool call that moved it, and a step begins from the last one before it', async () => {
  const h = await harness();
  try {
    const author = await wandered(h);
    assert.deepEqual(checkpoints(h, author), [
      { branch: 'cleared/LOCAL-1', commit: BASE }, { branch: 'cleared/LOCAL-1', commit: C1 }, { branch: 'cleared/LOCAL-1', commit: C2 },
    ], 'the start, then each move once: the read moved nothing');
    const events = eventsOf(h, author);
    assert.equal(stepCommit(events, startOf(h, author, 'read-1'))?.commit, BASE);
    assert.equal(stepCommit(events, startOf(h, author, 'run-1'))?.commit, BASE, 'the commit\'s own step began before it');
    assert.equal(stepCommit(events, startOf(h, author, 'edit-1'))?.commit, C1);
    assert.equal(stepCommit(events, 1)?.commit, BASE, 'an event before the first checkpoint: the branch as the session found it');
    assert.equal(stepCommit(events, 10_000), undefined, 'no such event');
    assert.equal(stepCommit(events.filter((e) => !(e.event.type === 'CUSTOM' && e.event.name === 'cleared.checkpoint')), 1), undefined, 'no checkpoint');
  } finally {
    await h.close();
  }
});

test('Resume from here stops the author, keeps its thread, makes the new branch at the step\'s commit, and a new author goes on there with the corrected instruction', async () => {
  const h = await harness();
  try {
    const author = await wandered(h);
    const before = eventsOf(h, author);
    const step = startOf(h, author, 'edit-1');
    const answer = await post(h, `/api/sessions/${author}/replay`, as('u1'), { seq: step, message: '  Keep the entries in the order they came, newest first.  ' });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    await until(() => h.startedSessions.length >= 2, 'the new author');
    const resumed = h.startedSessions[1]!;
    assert.deepEqual(answer.json, { accepted: true, session: resumed.id, branch: 'cleared/LOCAL-1.r1', commit: C1 });
    assert.deepEqual(h.replays, [{ ticket: 'LOCAL-1', n: 1, commit: C1, branch: 'cleared/LOCAL-1.r1', previous: 'cleared/LOCAL-1' }]);

    // The old session: stopped, every event it had kept, then why it stopped and where the ticket went on.
    assert.equal(h.store.sessions.get(author)?.status, 'stopped');
    const after = eventsOf(h, author);
    assert.deepEqual(after.slice(0, before.length), before, 'the old continuation is untouched');
    const added = after.slice(before.length).map((e) => e.event);
    assert.ok(added.some((e) => e.type === 'RUN_ERROR' && e.code === 'replayed'), 'the stop is said on its thread');
    const marker = (events: readonly AgUiEvent[]) => events.find((e): e is Extract<AgUiEvent, { type: 'CUSTOM'; name: 'cleared.replay' }> => e.type === 'CUSTOM' && e.name === 'cleared.replay')?.value;
    const value = { from: author, to: resumed.id, seq: step, commit: C1, branch: 'cleared/LOCAL-1.r1', previous: 'cleared/LOCAL-1', by: 'u1', message: 'Keep the entries in the order they came, newest first.' };
    assert.deepEqual(marker(added), value);
    assert.deepEqual(marker(eventsOf(h, resumed.id).map((e) => e.event)), value, 'the same on the new session');

    // The new author: on the new branch, told where it stands and what to do instead.
    assert.equal(resumed.input.role, 'author');
    assert.match(resumed.input.prompt, /^Ticket LOCAL-1: Newest entry first/);
    assert.ok(resumed.input.prompt.includes(`Your checkout is on a new branch, cleared/LOCAL-1.r1, at commit ${C1}`));
    assert.ok(resumed.input.prompt.endsWith('\n\nKeep the entries in the order they came, newest first.'));
    assert.deepEqual(checkpoints(h, resumed.id)[0], { branch: 'cleared/LOCAL-1.r1', commit: C1 }, 'its first checkpoint is the new branch');
    const replay = new ReplayStore(h.store.db).latest('LOCAL-1');
    assert.equal(replay?.resumed, resumed.id);
    assert.equal(replay?.previousHead, C2);
    assert.ok((await h.tickets.comments('LOCAL-1')).some((c) => /^Resumed by u1 from a step of session .+: a new author works on cleared\/LOCAL-1\.r1, from commit bbbbbbbbbbbb\. The branch cleared\/LOCAL-1 is kept as it was, at cccccccccccc\.$/.test(c.body)));
    assert.ok(h.flowEvents.some((e) => e.type === 'ticket_started' && e.session === resumed.id));

    // It finishes: the review reads the same checkout, and the publish pushes the new branch.
    await until(() => h.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
    assert.deepEqual(h.branches.map((b) => `${b.role} ${b.branch}`), ['author cleared/LOCAL-1', 'author cleared/LOCAL-1.r1', 'reviewer cleared/LOCAL-1.r1']);
    assert.deepEqual(h.published, ['cleared/LOCAL-1.r1']);
  } finally {
    await h.close();
  }
});

test('a restart keeps the resume branch: the next start of the ticket prepares it', async () => {
  const h = await harness();
  try {
    const author = await wandered(h);
    assert.equal((await post(h, `/api/sessions/${author}/replay`, as('u1'), { seq: startOf(h, author, 'edit-1'), message: 'Stable order.' })).status, 200);
    await until(() => h.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
    await h.engine.setAside('LOCAL-1', 'u1');
    await h.engine.close();
    const again = new FlowEngine(h.deps);
    try {
      h.branches.length = 0;
      await again.start('LOCAL-1', 'u1');
      assert.deepEqual(h.branches, [{ role: 'author', branch: 'cleared/LOCAL-1.r1' }]);
    } finally {
      await again.close();
    }
  } finally {
    await h.close();
  }
});

test('the route asks for the proof, a known user, the owner, a step and an instruction', async () => {
  const h = await harness();
  try {
    const author = await wandered(h);
    const path = `/api/sessions/${author}/replay`;
    const body = { seq: startOf(h, author, 'edit-1'), message: 'Stable order.' };
    assert.equal((await post(h, path, { [SERVICE_USER_HEADER]: 'u1' }, body)).status, 401);
    assert.equal((await post(h, path, { [SERVICE_PROOF_HEADER]: PROOF }, body)).status, 403);
    const second = await post(h, path, as('u2'), body);
    assert.equal(second.status, 403);
    assert.match(String(second.json.error), /owner account's alone/);
    for (const bad of [{ message: 'x' }, { seq: 0, message: 'x' }, { seq: 1.5, message: 'x' }, { seq: body.seq }, { seq: body.seq, message: '  ' }, { seq: body.seq, message: 'x'.repeat(MAX_REPLAY + 1) }])
      assert.equal((await post(h, path, as('u1'), bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal((await post(h, '/api/sessions/nobody/replay', as('u1'), body)).status, 404);
    const missing = await post(h, path, as('u1'), { seq: 10_000, message: 'x' });
    assert.equal(missing.status, 400);
    assert.match(String(missing.json.error), /no commit of session .+ is known at its event 10000/);
    assert.equal(h.replays.length, 0, 'nothing was resumed');
    assert.equal(h.store.sessions.get(author)?.status, 'working', 'the author still works');
  } finally {
    await h.close();
  }
});

test('a reviewer\'s session, a session taken over, a done ticket and a workspace of several services are refused, the ticket left as it was', async () => {
  const h = await harness();
  try {
    const author = await wandered(h);
    const body = { seq: startOf(h, author, 'edit-1'), message: 'Stable order.' };
    await h.engine.takeOver(author, 'u1');
    const taken = await post(h, `/api/sessions/${author}/replay`, as('u1'), body);
    assert.equal(taken.status, 409);
    assert.match(String(taken.json.error), /taken over: give it back first/);
    // Given back, the author ends its turn (support.ts reopenScript).
    await h.engine.giveBack(author);
    await until(() => h.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
    const reviewer = h.startedSessions.find((s) => s.input.role === 'reviewer')!.id;
    assert.equal((await post(h, `/api/sessions/${reviewer}/replay`, as('u1'), { seq: 1, message: 'x' })).status, 400);
    await h.tickets.move('LOCAL-1', h.tickets.states.done, { kind: 'human', id: 'u1' });
    const done = await post(h, `/api/sessions/${author}/replay`, as('u1'), body);
    assert.equal(done.status, 409);
    assert.match(String(done.json.error), /is in “Done”/);
    assert.equal(h.replays.length, 0);
  } finally {
    await h.close();
  }
  const several = await harness({ config: { workspace: {
    id: 'guestbook', name: 'guestbook', file: null,
    services: ['guestbook', 'filter-api'].map((name) => ({ name, kind: 'repository' as const, repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`, healthUrl: null, sensitivity: 'normal' as const, consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null })),
  } } });
  try {
    const at = new Date().toISOString();
    several.store.sessions.put({ id: 'author-1', project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'done', createdAt: at, updatedAt: at });
    several.store.events.append({ at, sessionId: 'author-1', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.checkpoint', value: { branch: 'cleared/LOCAL-1', commit: BASE } } });
    const refused = await post(several, '/api/sessions/author-1/replay', as('u1'), { seq: 1, message: 'x' });
    assert.equal(refused.status, 409);
    assert.match(String(refused.json.error), /only a ticket of one service is resumed from a step/);
  } finally {
    await several.close();
  }
});

test('without the branch\'s checkpoints no step is resumed from, and a failed resume puts the ticket back on its own branch', async () => {
  const blind = await harness({ noHead: true });
  try {
    await blind.engine.start(blind.ticket.id, 'u1');
    await until(() => blind.startedSessions.length === 1 && resulted(blind, blind.startedSessions[0]!.id, 'read-1'), 'the read');
    const author = blind.startedSessions[0]!.id;
    assert.equal(checkpoints(blind, author).length, 0);
    assert.equal((await post(blind, `/api/sessions/${author}/replay`, as('u1'), { seq: startOf(blind, author, 'read-1'), message: 'x' })).status, 400);
  } finally {
    await blind.close();
  }
  const h = await harness({ replayFails: true });
  try {
    const author = await wandered(h);
    const failed = await post(h, `/api/sessions/${author}/replay`, as('u1'), { seq: startOf(h, author, 'edit-1'), message: 'Stable order.' });
    assert.equal(failed.status, 409);
    assert.match(String(failed.json.error), /could not be resumed from that step: the commit bbbbbbbbbbbb is not in the history of cleared\/LOCAL-1/);
    assert.equal((await h.tickets.get('LOCAL-1'))?.status, h.tickets.states.todo);
    assert.equal(new ReplayStore(h.store.db).latest('LOCAL-1'), undefined, 'no resume is kept');
    h.branches.length = 0;
    await h.engine.start('LOCAL-1', 'u1');
    assert.deepEqual(h.branches, [{ role: 'author', branch: 'cleared/LOCAL-1' }], 'the ticket starts again on its own branch');
  } finally {
    await h.close();
  }
});

// ---- the effect's git, on real repositories ----------------------------------

const CONF = '[merge]\nverdict = no blocking issues\n[guard]\nterms = none\nallowed = none\n';
const TICKET: Ticket = { id: 'LOCAL-1', title: 'Newest first', body: 'Sort.', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' };

test('a resume branch is cleared/<ticket>.r<n>, which no ticket\'s own branch can be', () => {
  assert.equal(replayBranch('LOCAL-1', 1), 'cleared/LOCAL-1.r1');
  assert.equal(replayBranch('LOCAL-1', 12), 'cleared/LOCAL-1.r12');
  assert.throws(() => ticketBranch('LOCAL-1.r1'), CheckoutError);
  for (const n of [0, -1, 1.5]) assert.throws(() => replayBranch('LOCAL-1', n), CheckoutError);
  assert.throws(() => replayBranch('../x', 1), CheckoutError);
});

test('the tip is read from the checkout\'s files, loose or packed, and the resume keeps the old branch aside and starts the new one at the step\'s commit alone', async () => {
  const root = tempDir('replay');
  const config = { ...CONFIG, projectDir: join(root, 'project'), repoUrl: remote({ '.cleared/agents.conf': CONF, 'src/entries.ts': 'export const order = "none";\n' }), workdirRoot: join(root, 'work') };
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: join(root, 'state') };
  const flow = realEffects(config, { env });
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author' });
  const base = gitIn(workdir, ['rev-parse', 'HEAD']);
  assert.deepEqual(await flow.head?.({ workdir }), { branch: 'cleared/LOCAL-1', commit: base });
  const c1 = commit(workdir, { 'src/entries.ts': 'export const order = "newest";\n' }, 'Sort newest first');
  const c2 = commit(workdir, { 'src/entries.ts': 'export const order = "name";\n' }, 'Sort by name');
  assert.deepEqual(readTip(workdir), { branch: 'cleared/LOCAL-1', commit: c2 });
  gitIn(workdir, ['pack-refs', '--all']);
  assert.equal(existsSync(join(workdir, '.git', 'refs', 'heads', 'cleared', 'LOCAL-1')), false, 'packed');
  assert.deepEqual(readTip(workdir), { branch: 'cleared/LOCAL-1', commit: c2 }, 'read from packed-refs');

  const made = await flow.replay?.({ ticket: 'LOCAL-1', n: 1, commit: c1, branch: 'cleared/LOCAL-1.r1', previous: 'cleared/LOCAL-1' });
  assert.deepEqual(made, { previousHead: c2, aside: join(config.workdirRoot, '.LOCAL-1.before-r1') });
  // The old checkout, aside, as the session left it.
  assert.equal(gitIn(made!.aside, ['rev-parse', 'HEAD']), c2);
  assert.equal(gitIn(made!.aside, ['branch', '--show-current']), 'cleared/LOCAL-1');
  // Kept in the service's checkout too.
  assert.equal(gitIn(config.projectDir, ['rev-parse', 'refs/cleared/replay/LOCAL-1/1/previous']), c2);
  // The new checkout: the new branch at the step's commit, its base the service's, nothing of what came after.
  assert.deepEqual(readTip(workdir), { branch: 'cleared/LOCAL-1.r1', commit: c1 });
  assert.equal(readFileSync(join(workdir, 'src/entries.ts'), 'utf8'), 'export const order = "newest";\n');
  assert.equal(gitIn(workdir, ['rev-parse', BASE_REF]), base);
  assert.throws(() => gitIn(workdir, ['cat-file', '-e', `${c2}^{commit}`]), 'the later commit is not in the new checkout');
  assert.equal(gitIn(workdir, ['for-each-ref', '--format=%(refname)', 'refs/cleared']), BASE_REF, 'no ref of the resume is left in it');
  assert.equal(gitIn(workdir, ['status', '--porcelain']), '');

  // The author's checkout is the new one; prepared on the ticket's own branch, it is refused.
  await assert.rejects(flow.prepareWorkdir({ ticket: TICKET, role: 'reviewer' }), /is on cleared\/LOCAL-1\.r1, not on cleared\/LOCAL-1/);
  const again = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', branch: 'cleared/LOCAL-1.r1' });
  assert.equal(again.workdir, workdir);
  assert.ok(existsSync(join(workdir, 'CLAUDE.md')));

  // A commit that is not in the branch's history is refused, and the checkout stays.
  const stranger = commit(made!.aside, { 'NOTES.md': 'aside\n' }, 'Not on the new branch');
  gitIn(made!.aside, ['reset', '-q', '--hard', c2]);
  await assert.rejects(flow.replay!({ ticket: 'LOCAL-1', n: 2, commit: stranger, branch: 'cleared/LOCAL-1.r2', previous: 'cleared/LOCAL-1.r1' }), /is not in the history of cleared\/LOCAL-1\.r1/);
  assert.deepEqual(readTip(workdir), { branch: 'cleared/LOCAL-1.r1', commit: c1 });
  assert.equal(existsSync(join(config.workdirRoot, '.LOCAL-1.before-r2')), false);

  // A second resume, from the first resume's branch.
  const c3 = commit(workdir, { 'src/entries.ts': 'export const order = "date";\n' }, 'Sort by date');
  const second = await flow.replay!({ ticket: 'LOCAL-1', n: 2, commit: c1, branch: 'cleared/LOCAL-1.r2', previous: 'cleared/LOCAL-1.r1' });
  assert.equal(second.previousHead, c3);
  assert.deepEqual(readTip(workdir), { branch: 'cleared/LOCAL-1.r2', commit: c1 });
  assert.equal(gitIn(join(config.workdirRoot, '.LOCAL-1.before-r1'), ['rev-parse', 'HEAD']), c2, 'the first one stays aside');
});

test('a new ticket checkout starts at a ref of the project checkout when one is given', async () => {
  const root = tempDir('replay-start');
  const url = remote({ 'a.txt': 'one\n' });
  const project = join(root, 'project');
  gitIn(root, ['clone', '-q', url, project]);
  const first = await ticketCheckout({ project, workdir: join(root, 'w1'), base: 'main', branch: 'cleared/DEMO-1' });
  const step = commit(first.workdir, { 'a.txt': 'two\n' }, 'Two');
  gitIn(project, ['fetch', '-q', join(first.workdir, '.git'), `+refs/heads/cleared/DEMO-1:refs/cleared/replay/DEMO-1/1/start`]);
  const second = await ticketCheckout({ project, workdir: join(root, 'w2'), base: 'main', branch: 'cleared/DEMO-1.r1', start: 'refs/cleared/replay/DEMO-1/1/start' });
  assert.equal(second.reused, false);
  assert.equal(gitIn(second.workdir, ['rev-parse', 'HEAD']), step);
  assert.equal(gitIn(second.workdir, ['rev-parse', BASE_REF]), gitIn(project, ['rev-parse', 'origin/main']));
});
