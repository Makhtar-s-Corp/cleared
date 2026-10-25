// The policy at every evaluation (docs/v2/milestone-2-plan.md, decision 11):
// the engine's policyFor gives the adapter the learned rules and the files
// of the ticket as they are now, and the runtime passes it to the adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/flow/runtime.ts';
import { INBOX_TABLE } from '../../src/inbox/store.ts';
import { defaultRegistry } from '../../src/modules/registry.ts';
import type { AdapterDeps } from '../../src/session/adapters/index.ts';
import type { SessionAdapter, StartInput } from '../../src/session/contract.ts';
import { toolArgs, toolResult } from '../../src/session/events.ts';
import { evaluate } from '../../src/session/policy.ts';
import { openStore } from '../../src/store/db.ts';
import { fakeEffects, finished, permission, setup, started, until } from './support.ts';

const rm = (path: string) => ({ tool: 'Bash', input: { command: `rm ${path}` } });

test('after "Always in this project" the policy given for the next evaluation allows the same request, in the same session', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  await until(() => t.inbox.waitingFor(author.id) === 1);
  const request = { tool: 'Bash', input: { command: 'touch test/fixtures/entries.json' } };
  assert.equal(evaluate(request, t.engine.policyFor(author.input)).decision, 'ask');
  await t.engine.answer(author.id, 'request-1', { kind: 'allow_always', scope: 'project' }, 'u1');
  assert.deepEqual(evaluate(request, t.engine.policyFor(author.input)), { decision: 'allow', rule: 'learned' });
  // The session started with the policy of its start, which did not know it.
  assert.equal(evaluate(request, author.input.policy).decision, 'ask');
});

test('ticketFiles holds the files the ticket\'s sessions edited, not an edit that failed, so the deletion rule does not ask for them', async () => {
  const t = await setup({
    scripts: {
      author: [
        started,
        { emit: toolArgs('e1', { kind: 'edit', path: 'src/entries.ts', added: 3, removed: 1 }) },
        { emit: toolResult('e1-r', 'e1', { kind: 'edit', ok: true }) },
        // The real adapter names a file outside its mount by its full path.
        { emit: toolArgs('e2', { kind: 'edit', path: '/workspace/test/new.test.ts', added: 9, removed: 0 }) },
        { emit: toolResult('e2-r', 'e2', { kind: 'edit', ok: true }) },
        // Refused by the policy, or failed: the ticket did not change it.
        { emit: toolArgs('e3', { kind: 'edit', path: 'package.json', added: 1, removed: 0 }) },
        { emit: toolResult('e3-r', 'e3', { kind: 'edit', ok: false, error: 'refused' }) },
        { emit: toolArgs('e4', { kind: 'edit', path: '/etc/hosts', added: 1, removed: 0 }) },
        { emit: toolResult('e4-r', 'e4', { kind: 'edit', ok: true }) },
        { awaitMessage: true },
        // Later edits are seen by the next evaluation.
        { emit: toolArgs('e5', { kind: 'edit', path: './src/page.ts', added: 1, removed: 0 }) },
        { emit: toolResult('e5-r', 'e5', { kind: 'edit', ok: true }) },
        { awaitMessage: true },
      ],
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  await until(() => t.store.events.after(author.id).some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.toolCallId === 'e4'));
  assert.deepEqual(t.engine.policyFor(author.input).ticketFiles, ['src/entries.ts', 'test/new.test.ts']);
  const policy = t.engine.policyFor(author.input);
  const allowed = { decision: 'allow', rule: 'delete.ticket' };
  assert.deepEqual(evaluate(rm('src/entries.ts'), policy), allowed);
  assert.deepEqual(evaluate(rm('/workspace/src/entries.ts'), policy), allowed);
  assert.deepEqual(evaluate(rm('-f test/new.test.ts'), policy), allowed);
  assert.deepEqual(evaluate(rm('-- src/entries.ts test/new.test.ts'), policy), allowed);
  // Everything else still asks: a file the ticket did not change (or whose edit failed), one of
  // them among ticket files, a recursive or other option, a path outside the workdir, a glob.
  for (const args of ['package.json', 'src/entries.ts package.json', '-r src/entries.ts', '-rf src/entries.ts', '-i src/entries.ts', '../src/entries.ts', '/etc/hosts', 'src/*.ts']) {
    assert.equal(evaluate(rm(args), policy).decision, 'ask', `rm ${args}`);
  }
  assert.equal(evaluate(rm('src/entries.ts'), author.input.policy).rule, 'delete.outside_ticket', 'the policy of the start knew no file');
  // A reviewer never deletes, even a file of the ticket.
  assert.notEqual(evaluate(rm('src/entries.ts'), { ...policy, role: 'reviewer' }).decision, 'allow');

  await t.engine.send(author.id, 'go on', 'u1');
  await until(() => t.store.events.after(author.id).some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.toolCallId === 'e5'));
  assert.deepEqual(t.engine.policyFor(author.input).ticketFiles, ['src/entries.ts', 'test/new.test.ts', 'src/page.ts']);
});

test('a reopened or new author of the same ticket keeps the files the earlier sessions edited; another ticket does not see them', async () => {
  const t = await setup({ scripts: { author: [started, { emit: toolArgs('e1', { kind: 'edit', path: 'src/entries.ts', added: 1, removed: 0 }) }, { emit: toolResult('e1-r', 'e1', { kind: 'edit', ok: true }) }, permission, { awaitMessage: true }, finished(0.1)] } });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!;
  await until(() => t.inbox.waitingFor(author.id) === 1);
  const later: StartInput = { ...author.input, prompt: 'again' };
  assert.deepEqual(t.engine.policyFor(later).ticketFiles, ['src/entries.ts']);
  assert.deepEqual(t.engine.policyFor({ ...author.input, ticket: 'LOCAL-99' }).ticketFiles, []);
});

test('the lead\'s policy is given as it started: the lead engine owns it', async () => {
  const t = await setup();
  await t.store.policyRules.learn({ project: 'guestbook', tool: 'Bash', pattern: 'npm test', by: 'u1', at: 'x' });
  const lead: StartInput = {
    project: 'guestbook', ticket: 'lead', role: 'lead', harness: 'claude-code', model: 'claude-opus-5-5', workdir: '/work/lead', prompt: '',
    briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
    policy: { role: 'lead', base: 'main', workdir: '/workspace', scripts: [], credentialFile: '/c', safeCommands: [], allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
  };
  assert.equal(t.engine.policyFor(lead), lead.policy);
});

test('the runtime gives every adapter a policy that asks the engine once it exists, and the start policy before', async () => {
  const store = openStore(':memory:');
  store.db.exec(INBOX_TABLE);
  const env = {
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git',
    CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state',
  };
  let deps: AdapterDeps | undefined;
  const runtime = createRuntime({ env, effects: () => fakeEffects([]), factories: { 'claude-code': (d) => { deps = d; return { harness: 'claude-code' } as SessionAdapter; } } });
  runtime.attach({ store });
  runtime.adapters();
  assert.ok(deps?.policy, 'the adapter is given a policy function');
  const t = await setup();
  const input: StartInput = {
    project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'm', workdir: '/w', prompt: '',
    briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
    policy: { ...(await (async () => { await t.engine.start(t.ticket.id, 'u1'); return t.startedSessions[0]!.input.policy; })()) },
  };
  assert.equal(deps.policy(input), input.policy, 'no engine yet: the policy of the start');
  store.policyRules.learn({ project: 'guestbook', tool: 'Bash', pattern: 'npm ci', by: 'u1', at: 'x' });
  runtime.engine(defaultRegistry());
  assert.deepEqual(deps.policy(input).learned, [{ tool: 'Bash', pattern: 'npm ci' }]);
  await runtime.engine(defaultRegistry())?.close();
});
