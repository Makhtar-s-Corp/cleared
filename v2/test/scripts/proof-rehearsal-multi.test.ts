// The rehearsal of the multi-service proof (scripts/proof-rehearsal-multi.ts,
// docs/v2/milestone-2-plan.md, section 2.2, lane 29): the workspace file it
// writes, the scripted authors of each ticket and step, the guestbook's
// watch, and the stand-ins for the session's containers (docker) and for
// the human's shell, against what the service really sends them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY } from '../../src/container/preview.ts';
import { authorPrompt, stepPrompt } from '../../src/flow/prompts.ts';
import { parseRehearsalScript, type AuthorRule } from '../../src/session/adapters/index.ts';
import { END_TERMINAL, SHELL_COMMAND, giveCommand, readCommand, takeCommand, terminalCommand, writeCommand } from '../../src/terminal/container.ts';
import { loadWorkspace } from '../../src/workspace/config.ts';
import { MULTI_TICKETS, breaksHealth, dockerStub, multiScript, rehearsalWorkspace, shellAnswer, type StubContext } from '../../scripts/proof-rehearsal-multi.ts';

const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('the rehearsal\'s workspace file names its own repositories, folders and sockets, never the server\'s (lane 29)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleared-multi-test-'));
  const text = rehearsalWorkspace({ root, ports: { guestbook: 9711, 'filter-api': 9712 } });
  for (const forbidden of ['8793', '8795', '/run/user', '/var/lib', 'example-org']) assert.ok(!text.includes(forbidden), forbidden);
  const file = join(root, 'workspace.conf');
  writeFileSync(file, text);
  const workspace = loadWorkspace({ CLEARED_V2_WORKSPACE: file }, { authorModel: 'claude-opus-5-5', stateDir: join(root, 'state') });
  assert.equal(workspace?.id, 'guestbook');
  const [guestbook, filter] = workspace?.services ?? [];
  assert.equal(guestbook?.name, 'guestbook');
  assert.deepEqual(guestbook?.consumes, ['filter-api']);
  assert.equal(guestbook?.repo, 'rehearsal/guestbook');
  assert.equal(filter?.repo, 'rehearsal/filter-api');
  assert.equal(filter?.contract?.path, 'contract/openapi.yaml');
  assert.deepEqual([guestbook?.run?.port, filter?.run?.port], [9711, 9712]);
  for (const service of workspace?.services ?? []) {
    for (const path of [service.dir, service.url, service.brokerSocket, service.brokerState]) assert.ok(path?.startsWith(root), `${service.name}: ${path}`);
  }
  assert.notEqual(guestbook?.brokerState, filter?.brokerState, 'one state folder per broker');
  rmSync(root, { recursive: true, force: true });
});

// The prompt the engine gives a step's author (flow/engine.ts #launchStep).
const promptOf = (ticket: number, kind: 'contract' | 'service' | 'integration', service: string, position = 1, count = 4) => {
  const t = MULTI_TICKETS[ticket - 1] as (typeof MULTI_TICKETS)[number];
  return [authorPrompt({ id: `LOCAL-${ticket}`, title: t.title, body: t.body }, { plan: true, report: true }), stepPrompt({ kind, service, position, count, contract: { service: 'filter-api', path: 'contract/openapi.yaml' } })].join('\n\n');
};
const ruleFor = (rules: readonly AuthorRule[], prompt: string, service: string) => rules.find((r) => new RegExp(r.when, 's').test(prompt) && (r.service === undefined || r.service === service));

test('the scripted authors: the contract step changes the contract only, the second ticket breaks the guestbook\'s health, the third changes the contract alone (lane 29)', () => {
  const script = multiScript();
  assert.deepEqual(parseRehearsalScript(JSON.stringify(script)), script);
  const rules = script.authorRules ?? [];
  const contract = ruleFor(rules, promptOf(1, 'contract', 'filter-api'), 'filter-api');
  // Two changes of one file, its two answer examples: the contract file and nothing else.
  assert.deepEqual([...new Set(contract?.files.map((f) => f.path))], ['contract/openapi.yaml']);
  assert.ok(contract?.files[0]?.replace?.[1].includes('severity'), 'the contract gains severity');
  assert.equal(ruleFor(rules, promptOf(1, 'service', 'guestbook', 3), 'guestbook')?.service, 'guestbook');
  assert.ok(ruleFor(rules, promptOf(1, 'integration', 'guestbook', 4), 'guestbook'));
  // The second ticket's contract step changes nothing: no contract item.
  assert.deepEqual(ruleFor(rules, promptOf(2, 'contract', 'filter-api'), 'filter-api')?.files, []);
  const broken = ruleFor(rules, promptOf(2, 'service', 'guestbook', 3), 'guestbook');
  assert.deepEqual(broken?.files[0]?.replace, ['export const PROOF_BREAK_HEALTH: boolean = false;', 'export const PROOF_BREAK_HEALTH: boolean = true;']);
  const alone = ruleFor(rules, promptOf(3, 'service', 'filter-api', 1, 1), 'filter-api');
  assert.ok(alone?.files.some((f) => f.path === 'contract/openapi.yaml'), 'the third ticket changes the contract the guestbook consumes');
  // The fourth: a session that works until the owner takes it over, and reads the notice after Give back.
  const held = ruleFor(rules, promptOf(4, 'service', 'guestbook', 1, 1), 'guestbook');
  assert.ok(held?.files.some((f) => f.path === 'src/page.ts'));
  const afterGo = held?.steps.slice(held.steps.findIndex((s) => 'awaitMessage' in s) + 1) ?? [];
  assert.ok(afterGo.some((s) => 'awaitMessage' in s), 'its working turn waits: the session is live when Take over comes');
  assert.equal(script.reopenCommits, true, 'after Give back, the author commits what the human changed');
  // Each author proposes its plan with a high confidence: the proof gives each Go from the inbox.
  for (const rule of rules) assert.equal(rule.steps.flatMap((s) => ('hostCall' in s && s.hostCall.name === 'propose_session_plan' ? [(s.hostCall.input as { confidence: string }).confidence] : []))[0], 'high', rule.when);
});

test('the guestbook\'s watch in the rehearsal fails when the merged config turns PROOF_BREAK_HEALTH on, as /health would (lane 29)', () => {
  assert.equal(breaksHealth('export const PROOF_BREAK_HEALTH: boolean = false;\n'), false);
  assert.equal(breaksHealth('// PROOF_BREAK_HEALTH 1 turns it on\nexport const PROOF_BREAK_HEALTH: boolean = true;\n'), true);
  assert.equal(breaksHealth(''), false);
});

const ctx = (over: Partial<StubContext> = {}): StubContext => ({
  session: (id) => (id === SESSION ? { ticket: 'LOCAL-4', checkout: '/tmp/rehearsal/work/LOCAL-4/guestbook' } : undefined),
  services: ['guestbook', 'filter-api'],
  trialPort: 9720,
  pidFile: (id) => `/tmp/rehearsal/terminal-${id}.pid`,
  ...over,
});
const names = (rows: string) => rows.trim().split('\n').map((line) => (JSON.parse(line) as { Names: string }).Names);

test('the docker stand-in lists a session\'s containers only through the label filter, with the label on every row (lane 29)', () => {
  const listed = dockerStub(['ps', '--all', '--no-trunc', '--filter', 'label=cleared.dev=v2', '--filter', `label=cleared.session=${SESSION}`, '--format', '{{json .}}'], ctx());
  assert.equal(listed.kind, 'answer');
  const out = listed.kind === 'answer' ? listed.stdout : '';
  assert.deepEqual(names(out), [`cleared-v2-${SESSION}-session`, `cleared-v2-${SESSION}-egress`, `cleared-v2-${SESSION}-sib-guestbook`, `cleared-v2-${SESSION}-sib-filter-api`]);
  for (const line of out.trim().split('\n')) assert.match((JSON.parse(line) as { Labels: string }).Labels, /cleared\.dev=v2/);
  // No session filter (the restart's sweep): nothing. An unknown session: nothing. No label filter: refused.
  assert.deepEqual(dockerStub(['ps', '--all', '--no-trunc', '--filter', 'label=cleared.dev=v2', '--format', '{{json .}}'], ctx()), { kind: 'answer', code: 0, stdout: '' });
  assert.deepEqual(dockerStub(['ps', '--all', '--no-trunc', '--filter', 'label=cleared.dev=v2', '--filter', 'label=cleared.session=1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '--format', '{{json .}}'], ctx()), { kind: 'answer', code: 0, stdout: '' });
  assert.equal(dockerStub(['ps', '--all', '--format', '{{json .}}'], ctx()).kind, 'refuse');
});

test('the docker stand-in inspects a sibling as running on the session\'s network (lane 29)', () => {
  const answer = dockerStub(['inspect', '--type', 'container', '--', `stub-${SESSION}-sib-guestbook`], ctx());
  assert.equal(answer.kind, 'answer');
  const [inspected] = JSON.parse(answer.kind === 'answer' ? answer.stdout : '[]') as { State: { Running: boolean }; NetworkSettings: { Networks: Record<string, { IPAddress: string }> }; Config: { User: string } }[];
  assert.equal(inspected?.State.Running, true);
  assert.match(inspected?.NetworkSettings.Networks[`cleared-v2-${SESSION}`]?.IPAddress ?? '', /^10\.89\.0\.\d+$/);
  assert.equal(dockerStub(['inspect', '--type', 'container', '--', 'stub-other-session'], ctx()).kind, 'refuse');
});

test('the docker stand-in runs the service\'s own programs on the session\'s checkout, the relay to the trial stand-in, the human\'s shell, and nothing else (lane 29)', () => {
  const exec = (id: string, ...command: string[]) => dockerStub(['exec', '--interactive', '--', `stub-${SESSION}-${id}`, ...command], ctx());
  const checkout = '/tmp/rehearsal/work/LOCAL-4/guestbook';
  for (const command of [readCommand('src/page.ts'), writeCommand('src/page.ts', 'a'.repeat(64)), takeCommand(), giveCommand('b'.repeat(40))]) {
    const answer = exec('session', ...command);
    assert.equal(answer.kind, 'program');
    if (answer.kind === 'program') {
      assert.equal(answer.args[0], '-e');
      assert.equal(answer.args[1], command[2], 'the program as the service wrote it');
      assert.equal(answer.args[3], checkout, 'the mount point is the session\'s checkout');
      assert.deepEqual(answer.args.slice(4), command.slice(5));
    }
  }
  // The relay of the preview, from the egress, to the trial stand-in: the sibling's address becomes the stand-in's.
  const relay = dockerStub(['exec', '--', `stub-${SESSION}-egress`, 'node', '-e', RELAY, 'http://10.89.0.2:9711/entries?x=1', '8388608', '15000'], ctx());
  assert.equal(relay.kind, 'program');
  if (relay.kind === 'program') assert.deepEqual(relay.args, ['-e', RELAY, `http://127.0.0.1:9720/__session/${SESSION}/guestbook/entries?x=1`, '8388608', '15000']);
  const fake = dockerStub(['exec', '--', `stub-${SESSION}-egress`, 'node', '-e', RELAY, 'http://10.89.0.3:9712/__fake/calls', '1000', '1000'], ctx());
  if (fake.kind === 'program') assert.equal(fake.args[2], `http://127.0.0.1:9720/__session/${SESSION}/filter-api/__fake/calls`);
  // The human's shell, and its end.
  const tty = (...command: string[]) => dockerStub(['exec', '--interactive', '--tty', '--env', 'TERM=xterm-256color', '--user', 'node', '--workdir', '/workspace', '--', `stub-${SESSION}-session`, ...command], ctx());
  assert.deepEqual(tty(...terminalCommand(SHELL_COMMAND)), { kind: 'shell', cwd: checkout, session: SESSION, pidFile: `/tmp/rehearsal/terminal-${SESSION}.pid` });
  // A harness resumed in the terminal (pull request 230) is never run here: the fake adapter has none.
  assert.equal(tty(...terminalCommand(['sh', '-c', 'exec claude --resume "$1"', 'claude', SESSION])).kind, 'refuse');
  assert.deepEqual(exec('session', ...END_TERMINAL), { kind: 'end', pidFile: `/tmp/rehearsal/terminal-${SESSION}.pid` });
  // Anything else is refused: another program, a program in another container, a create, a build, a run, a push.
  for (const args of [
    ['exec', '--', `stub-${SESSION}-session`, 'bash', '-c', 'id'],
    ['exec', '--', `stub-${SESSION}-session`, 'node', '-e', 'process.exit(0)', '--', '/workspace'],
    ['exec', '--', `stub-${SESSION}-sib-guestbook`, ...readCommand('src/page.ts')],
    ['exec', '--', `stub-${SESSION}-egress`, 'node', '-e', RELAY, 'http://169.254.169.254/latest', '1', '1'],
    ['run', '--rm', 'alpine'], ['build', '--label', 'cleared.dev=v2', '--tag', 'x', '--', '.'], ['create', '--name', 'x'], ['push', 'x'], ['login'],
  ]) assert.equal(dockerStub(args, ctx()).kind, 'refuse', args.join(' ').slice(0, 80));
  // Stopping and removing what the labelled list returned does nothing: there is no container.
  assert.deepEqual(dockerStub(['stop', '--time', '10', '--', `stub-${SESSION}-session`], ctx()), { kind: 'answer', code: 0, stdout: '' });
  assert.deepEqual(dockerStub(['network', 'ls', '--no-trunc', '--filter', 'label=cleared.dev=v2', '--format', '{{json .}}'], ctx()), { kind: 'answer', code: 0, stdout: '' });
});

test('the human\'s stand-in shell answers the lines the proof types, runs git status on the checkout, and refuses a push (lane 29)', () => {
  assert.deepEqual(shellAnswer('pwd'), { kind: 'text', text: '/workspace' });
  assert.deepEqual(shellAnswer('  git status  '), { kind: 'git-status' });
  assert.equal(shellAnswer('npm test').kind, 'text');
  assert.match((shellAnswer('git push') as { text: string }).text, /credential/);
  assert.deepEqual(shellAnswer('exit'), { kind: 'exit' });
  assert.deepEqual(shellAnswer(''), { kind: 'text', text: '' });
  assert.match((shellAnswer('curl http://x') as { text: string }).text, /not part of/);
});
