// The service's fake adapter behind CLEARED_V2_ADAPTER=fake, for the
// rehearsal of the milestone 2 proof (docs/v2/milestone-2-plan.md, lane 11):
// refused unless every state folder of the service is temporary; a lead
// that answers each turn by the first rule its text matches, with a context
// share that rises per turn and starts again at each generation; authors
// that leave a real commit in their checkout; reviewers that play their
// script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterSettingError, adapterSetting, createRehearsalAdapter, factoriesFor, parseRehearsalScript, type RehearsalScript } from '../../src/session/adapters/index.ts';
import type { HostTool, StartInput } from '../../src/session/contract.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import type { AgUiEvent } from '../../src/session/events.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'cleared-rehearsal-test-'));

test('the claude-code adapter is the default, and an unknown adapter is refused', () => {
  assert.deepEqual(adapterSetting({}), { kind: 'claude-code' });
  assert.deepEqual(adapterSetting({ CLEARED_V2_ADAPTER: 'claude-code' }), { kind: 'claude-code' });
  assert.throws(() => adapterSetting({ CLEARED_V2_ADAPTER: 'codex' }), AdapterSettingError);
});

test('the fake adapter needs its script file and a temporary state folder', () => {
  const state = temp();
  const script = join(state, 'script.json');
  const ok = { CLEARED_V2_ADAPTER: 'fake', CLEARED_STATE_DIR: state, CLEARED_V2_FAKE_SCRIPT: script };
  assert.deepEqual(adapterSetting(ok), { kind: 'fake', script });
  assert.throws(() => adapterSetting({ ...ok, CLEARED_V2_FAKE_SCRIPT: undefined }), /CLEARED_V2_FAKE_SCRIPT/);
  assert.throws(() => adapterSetting({ ...ok, CLEARED_V2_FAKE_SCRIPT: 'script.json' }), /absolute/);
  // The service's own ledger, or any of its folders outside the temporary one, refuses it.
  assert.throws(() => adapterSetting({ ...ok, CLEARED_STATE_DIR: join(homedir(), '.local', 'state', 'cleared-v2') }), /temporary/);
  assert.throws(() => adapterSetting({ ...ok, CLEARED_V2_STATE_DIR: join(homedir(), '.local', 'state', 'cleared-v2') }), /temporary/);
  assert.throws(() => adapterSetting({ ...ok, CLEARED_V2_WORKDIRS: '/srv/work' }), /temporary/);
  assert.throws(() => adapterSetting({ ...ok, CLEARED_V2_PROJECT_DIR: '/srv/guestbook' }), /temporary/);
  assert.throws(() => adapterSetting({ ...ok, ORCH_LEDGER: '/srv/ledger.db' }), /temporary/);
  // The temporary folder itself is not a state folder of its own.
  assert.throws(() => adapterSetting({ ...ok, CLEARED_STATE_DIR: tmpdir() }), /temporary/);
  // A path that climbs out of it is read as where it leads.
  assert.throws(() => adapterSetting({ ...ok, CLEARED_STATE_DIR: join(state, '..', '..', 'srv') }), /temporary/);
  // Without any state folder the ledger would be the project's default one.
  assert.throws(() => adapterSetting({ CLEARED_V2_ADAPTER: 'fake', CLEARED_V2_FAKE_SCRIPT: script }), /temporary|ledger/);
  rmSync(state, { recursive: true, force: true });
});

test('the factories put the fake adapter under the claude-code name, from the script file', () => {
  const state = temp();
  const file = join(state, 'script.json');
  writeFileSync(file, JSON.stringify(SCRIPT));
  const store = openStore(':memory:');
  const factories = factoriesFor({ CLEARED_V2_ADAPTER: 'fake', CLEARED_STATE_DIR: state, CLEARED_V2_FAKE_SCRIPT: file });
  assert.deepEqual(Object.keys(factories), ['claude-code']);
  const adapter = factories['claude-code']!({ log: store.events, cleaner: () => ({ clean: (event: AgUiEvent) => [event] }) as never });
  assert.equal(adapter.harness, 'claude-code');
  assert.deepEqual(Object.keys(factoriesFor({})), ['claude-code']);
  rmSync(state, { recursive: true, force: true });
});

test('a script file that is not a rehearsal script is refused with what is wrong', () => {
  assert.throws(() => parseRehearsalScript('{'), AdapterSettingError);
  assert.throws(() => parseRehearsalScript(JSON.stringify({ ...SCRIPT, lead: { ...SCRIPT.lead, rules: [{ when: '(', acts: [] }] } })), /when/);
  assert.throws(() => parseRehearsalScript(JSON.stringify({ ...SCRIPT, author: { steps: [] } })), /author/);
  assert.throws(() => parseRehearsalScript(JSON.stringify({ ...SCRIPT, reviewer: undefined })), /reviewer/);
  assert.deepEqual(parseRehearsalScript(JSON.stringify(SCRIPT)), SCRIPT);
});

// ---------------------------------------------------------------- the lead

const SCRIPT: RehearsalScript = {
  lead: {
    rules: [
      { when: 'goal id: (goal-\\d+)', acts: [{ ask: [{ question: 'Pages or one list?', options: [{ label: 'Pages (Recommended)' }, { label: 'One list' }] }] }, { call: 'propose_plan', input: { goal: '$1', title: 'Plan' } }, { say: 'Here is the plan.' }] },
      { when: 'tell me how long', acts: [{ call: 'commit', input: { text: 'Say how long the first ticket took.' }, as: 'first' }, { say: 'I will.' }] },
      { when: 'is live', once: true, acts: [{ call: 'tell_owner', input: { text: 'The first ticket is live.' } }, { call: 'fulfil', input: { id: '${first}', note: 'told' } }] },
      { when: 'Write your handover now', acts: [{ call: 'handover', input: { summary: 'Where I am.' } }] },
    ],
    otherwise: [{ say: 'Noted.' }],
    context: { start: 2, perTurn: 1.5 },
    turnCostUsd: 0.05,
  },
  author: { steps: [{ emit: { type: 'RUN_STARTED', threadId: 't', runId: 'r' } }, { emit: { type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.3 } } }], file: { path: 'notes/{ticket}.md', text: 'The change of {ticket}: {title}.\n' } },
  reviewer: [{ emit: { type: 'RUN_STARTED', threadId: 't', runId: 'r' } }, { emit: { type: 'TEXT_MESSAGE_START', messageId: 'r1', role: 'assistant' } }, { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r1', delta: 'Verdict: “no blocking issues”' } }, { emit: { type: 'TEXT_MESSAGE_END', messageId: 'r1' } }, { emit: { type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.1 } } }],
};

function input(role: StartInput['role'], tools: HostTool[] = [], extra: Partial<StartInput> = {}): StartInput {
  return {
    project: 'guestbook', ticket: role === 'lead' ? 'lead' : 'LOCAL-1', role, harness: 'claude-code', model: 'claude-haiku-5-5', workdir: '/nowhere',
    briefing: { text: '', bytes: 0 } as never, policy: {} as never, prompt: 'Go.', services: [], tools, ...extra,
  } as StartInput;
}

type Call = { name: string; input: unknown };
function hostTools(calls: Call[]): HostTool[] {
  let commitments = 0;
  const tool = (name: string, answer: (input: unknown) => unknown = () => ({ ok: true })): HostTool => ({
    name, description: name, inputSchema: { type: 'object' } as never,
    async handle(input) { calls.push({ name, input }); return answer(input); },
  });
  return [tool('propose_plan'), tool('commit', () => ({ id: `c${++commitments}` })), tool('fulfil'), tool('tell_owner'), tool('handover')];
}

const events = (store: Store, id: string) => store.events.after(id, 0).map((e) => e.event);
const shares = (store: Store, id: string) => events(store, id).flatMap((e) => (e.type === 'CUSTOM' && e.name === 'cleared.context_usage' ? [(e.value as { percent: number }).percent] : []));
const texts = (store: Store, id: string) => events(store, id).flatMap((e) => (e.type === 'TEXT_MESSAGE_CONTENT' ? [e.delta] : []));

test('the lead answers each turn by the first rule its text matches, the goal id and a recorded id carried over', async () => {
  const store = openStore(':memory:');
  const calls: Call[] = [];
  const adapter = createRehearsalAdapter({ log: store.events, script: SCRIPT });
  const lead = await adapter.start(input('lead', hostTools(calls)));
  // Ready at its first measure, as a harness with no opening turn.
  assert.deepEqual(shares(store, lead.id), [2]);

  await lead.send({ text: 'The owner gives a goal (goal id: goal-7). Ask the one or two questions you need.', by: 'u1' });
  const asked = events(store, lead.id).find((e) => e.type === 'CUSTOM' && e.name === 'cleared.question');
  assert.ok(asked, 'the question waits for the owner');
  assert.deepEqual(calls, [], 'nothing more until the answer');
  const requestId = (asked as { value: { requestId: string } }).value.requestId;
  await lead.answer(requestId, { decision: { kind: 'answer', answers: { 'Pages or one list?': 'Pages (Recommended)' } }, by: 'u1' } as never);
  assert.deepEqual(calls, [{ name: 'propose_plan', input: { goal: 'goal-7', title: 'Plan' } }]);
  assert.ok(texts(store, lead.id).includes('Here is the plan.'));

  await lead.send({ text: 'When the first ticket lands, tell me how long it took.', by: 'u1' });
  await lead.send({ text: 'Cleared: what happened.\n- 03:10 LOCAL-1: pull request #101 is live (healthy).', by: 'cleared' });
  assert.deepEqual(calls.slice(1), [
    { name: 'commit', input: { text: 'Say how long the first ticket took.' } },
    { name: 'tell_owner', input: { text: 'The first ticket is live.' } },
    { name: 'fulfil', input: { id: 'c1', note: 'told' } },
  ]);
  // A rule marked once is not used again: the next landing gets the general answer.
  await lead.send({ text: '- 04:10 LOCAL-2: pull request #102 is live (healthy).', by: 'cleared' });
  assert.equal(calls.length, 4);
  assert.equal(texts(store, lead.id).at(-1), 'Noted.');
  // Each turn reports a share 1.5 points above the last, then ends with its cost.
  assert.deepEqual(shares(store, lead.id), [2, 3.5, 5, 6.5, 8]);
  const finished = events(store, lead.id).filter((e) => e.type === 'RUN_FINISHED');
  assert.equal(finished.length, 4);
  assert.deepEqual(finished.map((e) => (e as { result: { total_cost_usd: number } }).result.total_cost_usd), [0.05, 0.05, 0.05, 0.05]);
});

test('the next generation of the lead starts from the first share again and keeps what the last one recorded', async () => {
  const store = openStore(':memory:');
  const calls: Call[] = [];
  const adapter = createRehearsalAdapter({ log: store.events, script: SCRIPT });
  const first = await adapter.start(input('lead', hostTools(calls)));
  await first.send({ text: 'Please tell me how long the first one takes.', by: 'u1' });
  await first.send({ text: 'Cleared: your context is near its limit. Write your handover now with the handover tool.', by: 'cleared' });
  assert.deepEqual(calls.at(-1), { name: 'handover', input: { summary: 'Where I am.' } });
  await first.stop();
  const second = await adapter.start(input('lead', hostTools(calls)));
  assert.notEqual(second.id, first.id);
  assert.deepEqual(shares(store, second.id), [2]);
  await second.send({ text: '- LOCAL-1: pull request #101 is live (healthy).', by: 'cleared' });
  assert.deepEqual(calls.at(-1), { name: 'fulfil', input: { id: 'c1', note: 'told' } });
  // An interrupt ends the turn; the next message plays the next turn.
  await second.send({ text: 'Anything.', by: 'u1' });
  assert.equal(texts(store, second.id).at(-1), 'Noted.');
});

test('a lead act can play an event as the adapter would map it: the status of a login cut (review 1, F3)', async () => {
  const store = openStore(':memory:');
  const cut = { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/status', value: 'Waiting for a new login' }] } as const;
  const adapter = createRehearsalAdapter({ log: store.events, script: { ...SCRIPT, lead: { ...SCRIPT.lead, rules: [{ when: 'cut', acts: [{ emit: cut }, { say: 'Back.' }] }] } } });
  const lead = await adapter.start(input('lead', hostTools([])));
  await lead.send({ text: 'cut', by: 'u1' });
  const played = events(store, lead.id);
  assert.deepEqual(played.find((e) => e.type === 'STATE_DELTA' && JSON.stringify(e).includes('new login')), cut);
  assert.ok(!played.some((e) => e.type === 'CUSTOM' && e.name === 'cleared.host_call'), 'no host call is made for it');
});

// ------------------------------------------------------- authors, reviewers

function checkout(): string {
  const dir = temp();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: '' } });
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(dir, 'README.md'), 'guestbook\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'base');
  git('checkout', '--quiet', '-b', 'local-1');
  // The briefing the flow writes: never part of the commit.
  writeFileSync(join(dir, 'CLAUDE.md'), 'briefing\n');
  return dir;
}

const log = (dir: string) => execFileSync('git', ['log', '--format=%s|%an', '--name-only', 'main..HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

test('an author leaves a commit of its ticket file only, then plays its steps; a second start commits nothing twice', async () => {
  const store = openStore(':memory:');
  const dir = checkout();
  const adapter = createRehearsalAdapter({ log: store.events, script: SCRIPT });
  const author = await adapter.start(input('author', [], { workdir: dir, ticket: 'LOCAL-1', prompt: 'Ticket LOCAL-1: Entries as JSON\n\nbody' }));
  assert.equal(readFileSync(join(dir, 'notes', 'LOCAL-1.md'), 'utf8'), 'The change of LOCAL-1: Entries as JSON.\n');
  assert.equal(log(dir), 'LOCAL-1: Entries as JSON|Cleared\n\nnotes/LOCAL-1.md');
  assert.deepEqual(events(store, author.id).map((e) => e.type), ['RUN_STARTED', 'RUN_FINISHED']);
  await adapter.start(input('author', [], { workdir: dir, ticket: 'LOCAL-1', prompt: 'Ticket LOCAL-1: Entries as JSON' }));
  assert.equal(log(dir).split('\n')[0], 'LOCAL-1: Entries as JSON|Cleared');
  assert.equal(log(dir).split('\n').filter((line) => line.includes('|')).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('authors take the per-start scripts first, reviewers theirs, and a reopened author resumes under its id', async () => {
  const store = openStore(':memory:');
  const dir = checkout();
  mkdirSync(join(dir, 'notes'));
  const asks = { permission: { requestId: 'p1', toolCallId: 'x', tool: 'Bash', input: { kind: 'execute', command: 'npm view x' }, suggestion: { decision: 'ask', rule: 'default', reason: 'r' } } } as const;
  const adapter = createRehearsalAdapter({ log: store.events, script: { ...SCRIPT, authors: [[asks]], reopen: [{ awaitMessage: true }, { emit: { type: 'RUN_STARTED', threadId: 't', runId: 'again' } }] } });
  const first = await adapter.start(input('author', [], { workdir: dir, ticket: 'LOCAL-1', prompt: 'Ticket LOCAL-1: A' }));
  assert.equal(events(store, first.id).at(-1)?.type, 'CUSTOM');
  const reviewer = await adapter.start(input('reviewer', [], { workdir: dir }));
  assert.ok(texts(store, reviewer.id).some((t) => t.includes('no blocking issues')));
  const reopened = await adapter.resume(first.id);
  assert.equal(reopened.id, first.id);
  await reopened.send({ text: 'Fix this.', by: 'cleared' });
  assert.equal(events(store, first.id).at(-1)?.type, 'RUN_STARTED');
  await assert.rejects(adapter.resume('unknown'), /unknown/);
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------- lane 29: the replanned milestone 2

const go = 'Go: your session plan is approved by the owner.\nCarry it out now.';
const plannedSteps = (files: string[]): RehearsalScript['author']['steps'] => [
  { emit: { type: 'RUN_STARTED', threadId: 't', runId: 'plan' } },
  { hostCall: { toolCallId: 'p1', name: 'propose_session_plan', input: { steps: ['Do it'], files, confidence: 'high', reason: 'Small.' } } },
  { emit: { type: 'RUN_FINISHED', threadId: 't', runId: 'plan', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.1 } } },
  { awaitMessage: true },
  { emit: { type: 'RUN_STARTED', threadId: 't', runId: 'work' } },
  { emit: { type: 'RUN_FINISHED', threadId: 't', runId: 'work', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.2 } } },
];

test('an author that proposes its session plan commits only at the Go, not before (lane 29)', async () => {
  const store = openStore(':memory:');
  const dir = checkout();
  // The owner asks for a change: the author proposes again, then waits for the Go.
  const steps = [...plannedSteps(['notes/LOCAL-1.md']).slice(0, 4), ...plannedSteps(['notes/LOCAL-1.md'])];
  const adapter = createRehearsalAdapter({ log: store.events, script: { ...SCRIPT, author: { ...SCRIPT.author, steps } } });
  const author = await adapter.start(input('author', [], { workdir: dir, ticket: 'LOCAL-1', prompt: 'Ticket LOCAL-1: Entries as JSON' }));
  assert.equal(log(dir), '', 'nothing is committed while the plan waits for its Go');
  await author.send({ text: 'The owner asks for a change to your session plan.', by: 'u1' });
  assert.equal(log(dir), '', 'a Change is not a Go');
  await author.send({ text: go, by: 'cleared' });
  assert.equal(log(dir), 'LOCAL-1: Entries as JSON|Cleared\n\nnotes/LOCAL-1.md');
  rmSync(dir, { recursive: true, force: true });
});

test('the author rules: the first whose prompt and service match gives the files, a change of a line, the steps and a handover (lane 29)', async () => {
  const store = openStore(':memory:');
  const dir = checkout();
  writeFileSync(join(dir, 'config.ts'), 'export const PROOF_BREAK_HEALTH: boolean = false;\n');
  execFileSync('git', ['add', 'config.ts'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=', 'commit', '--quiet', '-m', 'config'], { cwd: dir });
  const handover = '## Done\nx\n## Tried and failed, and why\nx\n## Left to do\nx\n## Where the artifacts are (screenshots, logs, branches)\nx\n## Open questions\nx\n## Lessons for the workspace\nThe page reads the entries once.\n';
  const script: RehearsalScript = {
    ...SCRIPT,
    authorRules: [
      { when: 'the contract step', service: 'filter-api', files: [], steps: plannedSteps([]) },
      { when: '^Ticket \\S+: Casino', service: 'guestbook', files: [{ path: 'config.ts', replace: ['boolean = false;', 'boolean = true;'] }, { path: 'notes/{ticket}.md', text: '{title}\n' }], steps: plannedSteps(['config.ts']), handover },
    ],
  };
  assert.deepEqual(parseRehearsalScript(JSON.stringify(script)), script);
  const adapter = createRehearsalAdapter({ log: store.events, script });
  // The contract rule names another service: not this one. The second matches.
  const author = await adapter.start(input('author', [], { workdir: dir, ticket: 'LOCAL-2', service: 'guestbook', prompt: 'Ticket LOCAL-2: Casino\n\nYou do step 3, the step of guestbook.' }));
  await author.send({ text: go, by: 'cleared' });
  assert.equal(readFileSync(join(dir, 'config.ts'), 'utf8'), 'export const PROOF_BREAK_HEALTH: boolean = true;\n');
  // The newest commit is the rule's (the one below it set the test up).
  assert.ok(log(dir).startsWith('LOCAL-2: Casino|Cleared\n\nconfig.ts\nnotes/LOCAL-2.md\n'), log(dir));
  // The handover is left in the checkout for the flow to capture, never committed.
  assert.equal(readFileSync(join(dir, 'HANDOVER.md'), 'utf8'), handover);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'HANDOVER.md'], { cwd: dir, encoding: 'utf8' }).trim(), '?? HANDOVER.md');
  // A rule whose line is not in the file is an error of the script, said at the Go.
  const wrong = createRehearsalAdapter({ log: store.events, script: { ...script, authorRules: [{ when: 'Casino', files: [{ path: 'config.ts', replace: ['nowhere', 'somewhere else'] }], steps: plannedSteps([]) }] } });
  const second = await wrong.start(input('author', [], { workdir: dir, ticket: 'LOCAL-2', prompt: 'Ticket LOCAL-2: Casino' }));
  await assert.rejects(second.send({ text: go, by: 'cleared' }), /nowhere/);
  // A rule's path stays inside the checkout.
  assert.throws(() => parseRehearsalScript(JSON.stringify({ ...script, authorRules: [{ when: 'x', files: [{ path: '../out', text: 'x' }], steps: [] }] })), /inside the checkout/);
  assert.throws(() => parseRehearsalScript(JSON.stringify({ ...script, authorRules: [{ when: '(', files: [], steps: [] }] })), /when/);
  rmSync(dir, { recursive: true, force: true });
});

test('a reopened author commits what the human changed in its checkout when the script says so (lane 29)', async () => {
  const store = openStore(':memory:');
  const dir = checkout();
  const adapter = createRehearsalAdapter({ log: store.events, script: { ...SCRIPT, reopenCommits: true, reopen: [{ awaitMessage: true }, { emit: { type: 'RUN_STARTED', threadId: 't', runId: 'again' } }] } });
  const first = await adapter.start(input('author', [], { workdir: dir, ticket: 'LOCAL-4', prompt: 'Ticket LOCAL-4: The count' }));
  writeFileSync(join(dir, 'README.md'), 'guestbook, changed by the owner\n');
  const reopened = await adapter.resume(first.id);
  await reopened.send({ text: 'owner changed these files: README.md (+1, -1). Read them again before editing them.', by: 'cleared' });
  assert.equal(log(dir).split('\n').filter((line) => line.includes('|'))[0], 'LOCAL-4: the changes the owner made|Cleared');
  assert.match(log(dir), /README\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test('a workspace file whose checkouts or brokers are outside the temporary folder refuses the fake adapter (lane 29)', () => {
  const state = temp();
  const script = join(state, 'script.json');
  const file = join(state, 'workspace.conf');
  const ok = { CLEARED_V2_ADAPTER: 'fake', CLEARED_STATE_DIR: state, CLEARED_V2_FAKE_SCRIPT: script, CLEARED_V2_WORKSPACE: file };
  const conf = (dir: string, brokerState: string, socket: string) => `[workspace]\nid = guestbook\nname = W\n[service guestbook]\nkind = repository\nrepository = rehearsal/guestbook\nurl = ${state}/origin.git\nbase = main\ndir = ${dir}\nbroker_socket = ${socket}\nbroker_state = ${brokerState}\n`;
  writeFileSync(file, conf(join(state, 'gb'), join(state, 'broker'), join(state, 'broker', 'b.sock')));
  assert.deepEqual(adapterSetting(ok), { kind: 'fake', script });
  writeFileSync(file, conf('/srv/guestbook', join(state, 'broker'), join(state, 'broker', 'b.sock')));
  assert.throws(() => adapterSetting(ok), /dir.*temporary|temporary.*\/srv\/guestbook/);
  writeFileSync(file, conf(join(state, 'gb'), '/var/lib/cleared-v2/brokers/guestbook', join(state, 'b.sock')));
  assert.throws(() => adapterSetting(ok), /temporary/);
  writeFileSync(file, conf(join(state, 'gb'), join(state, 'broker'), '/run/user/1000/cleared-v2/guestbook/broker.sock'));
  assert.throws(() => adapterSetting(ok), /temporary/);
  // The file itself outside: refused too.
  assert.throws(() => adapterSetting({ ...ok, CLEARED_V2_WORKSPACE: '/etc/cleared/workspace.conf' }), /temporary/);
  rmSync(state, { recursive: true, force: true });
});
