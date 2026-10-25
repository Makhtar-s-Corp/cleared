// The harness pick (issue #329, requirement P213), on the fakes: one
// variant per harness named (Claude Code, Codex, Cursor, each a scripted
// adapter, no real account), the variant kept automatically being the
// cheapest of those whose own last run of the declared test command passed;
// the others stopped and their containers released at once; the review on
// the kept checkout by another harness; the wins counted per ticket type
// for the Consumption screen. Real Codex and Cursor stay behind
// CLEARED_V2_PICK_HARNESSES, the owner's gate after the trials.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { VariantsItem } from '../../src/api/types.ts';
import { consumption } from '../../src/consumption/usage.ts';
import { NO_LEVERS } from '../../src/consumption/levers.ts';
import { QUOTA_TABLES } from '../../src/consumption/quota.ts';
import { Docker } from '../../src/container/docker.ts';
import { sessionNames } from '../../src/container/session-runtime.ts';
import { FlowConfigError } from '../../src/flow/config.ts';
import { CODEX_MODEL, FlowEngine, FlowError, type FlowEffects } from '../../src/flow/engine.ts';
import { PICK_DEFAULT, harnessWins, pickHarnessesOf, pickPrompt, pickWinner, ticketType } from '../../src/flow/harness-pick.ts';
import { variantFolder } from '../../src/flow/variants.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { Harness } from '../../src/session/contract.ts';
import { toolArgs, toolResult } from '../../src/session/events.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { CONFIG, fakeEffects, scriptedAdapter, setup, started, text, until, type Setup } from './support.ts';

// ---------------------------------------------------------------- the rules

test('CLEARED_V2_PICK_HARNESSES: Claude Code alone by default; Codex on its default model; Cursor only with a model named; nothing else', () => {
  assert.deepEqual(pickHarnessesOf(undefined), PICK_DEFAULT);
  assert.deepEqual(pickHarnessesOf(' '), PICK_DEFAULT);
  assert.deepEqual(PICK_DEFAULT, [{ harness: 'claude-code' }]);
  assert.deepEqual(pickHarnessesOf('claude-code, codex'), [{ harness: 'claude-code' }, { harness: 'codex' }]);
  assert.deepEqual(pickHarnessesOf('codex=gpt-6-sol,cursor=sonnet-4.5'), [{ harness: 'codex', model: 'gpt-6-sol' }, { harness: 'cursor', model: 'sonnet-4.5' }]);
  for (const bad of ['cursor', 'gemini', 'codex,codex', 'codex=', 'claude-code=a b'])
    assert.throws(() => pickHarnessesOf(bad), FlowConfigError, bad);
});

test('a ticket\'s type is its first label among Bug, Review, CI and Question, whatever the case; else other', () => {
  assert.equal(ticketType(['Bug']), 'bug');
  assert.equal(ticketType(['Quick', 'ci']), 'ci');
  assert.equal(ticketType(['Question', 'Bug']), 'question');
  assert.equal(ticketType(['REVIEW']), 'review');
  assert.equal(ticketType(['feature']), 'other');
  assert.equal(ticketType([]), 'other');
});

test('the pick: only a variant whose tests passed; the fewest tokens when every one of them reports tokens, else the shortest agent time', () => {
  const entry = (position: number, harness: Harness, green: boolean, tokens: number | null, workMs: number) => ({ position, harness, green, tokens, workMs });
  // The cheapest is red: the cheapest green wins.
  assert.deepEqual(pickWinner([entry(1, 'claude-code', true, 30_000, 9_000), entry(2, 'codex', true, 12_000, 20_000), entry(3, 'claude-code', false, 1_000, 1_000)]), { position: 2, measure: 'tokens' });
  // A green variant with no tokens (Cursor reports none): the time decides, for all of them.
  assert.deepEqual(pickWinner([entry(1, 'claude-code', true, 30_000, 9_000), entry(2, 'cursor', true, null, 4_000)]), { position: 2, measure: 'time' });
  // Same tokens: the time, then the position.
  assert.deepEqual(pickWinner([entry(1, 'claude-code', true, 5_000, 9_000), entry(2, 'codex', true, 5_000, 3_000)]), { position: 2, measure: 'tokens' });
  assert.deepEqual(pickWinner([entry(1, 'claude-code', true, 5_000, 3_000), entry(2, 'codex', true, 5_000, 3_000)]), { position: 1, measure: 'tokens' });
  // None green: no pick, the owner chooses.
  assert.equal(pickWinner([entry(1, 'claude-code', false, 10, 10), entry(2, 'codex', false, 10, 10)]), undefined);
  assert.equal(pickWinner([]), undefined);
});

test('the pick\'s prompt names the declared test command, and says nothing of it when none is declared', () => {
  assert.match(pickPrompt(['npm', 'test']), /`npm test`/);
  assert.match(pickPrompt(['npm', 'test']), /alone/);
  assert.doesNotMatch(pickPrompt(undefined), /`/);
});

// ---------------------------------------------------------------- the flow

const NPM_TEST = ['npm', 'test'];

// One run of the declared command and its result, as the cleaner stores them.
const testRun = (id: string, passed: boolean): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Bash' } },
  { emit: toolArgs(id, { kind: 'execute', command: 'npm test' }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: id } },
  { emit: toolResult(`${id}-result`, id, { kind: 'execute', output: passed ? '# pass 4' : '# fail 1', cut: 0, isError: !passed }) },
];
// A turn's end with its tokens (none: Cursor's, which reports the model only) and its dollars.
const end = (tokens: number | null, cost: number | null): FakeStep => ({
  emit: { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run', outcome: { type: 'success' }, usage: tokens === null ? [{ model: 'sonnet-4.5' }] : [{ inputTokens: tokens, outputTokens: 0 }], result: { stopReason: 'end_turn', total_cost_usd: cost } },
});
const variant = (id: string, passed: boolean | null, tokens: number | null, cost: number | null = null): FakeStep[] =>
  [started, ...text(id, 'Done.'), ...(passed === null ? [] : testRun(`${id}-t`, passed)), end(tokens, cost)];
// A variant still at work: it waits for a message, then ends its turn.
const working = (id: string): FakeStep[] => [started, ...text(id, 'Still at it.'), { awaitMessage: true }, end(1_000, null)];

type Prepared = { readonly role: string; readonly workdir: string };

// `testCommand` null: the service declares none.
function pickEffects(prepared: Prepared[], published: string[], testCommand: readonly string[] | null = NPM_TEST): Partial<FlowEffects> {
  const base = fakeEffects([]);
  return {
    async settings(service) { return { ...(await base.settings(service)), ...(testCommand ? { testCommand } : {}) }; },
    async prepareWorkdir({ ticket, role, variant: key }) {
      const workdir = `${CONFIG.workdirRoot}/${key ? variantFolder(ticket.id, key) : ticket.id}`;
      prepared.push({ role, workdir });
      return { workdir, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
    },
    async variantChanges({ workdir }) {
      const folder = workdir.split('/').at(-1) as string;
      return { files: [`src/${folder}.ts`], diff: `--- a/src/${folder}.ts\n+++ b/src/${folder}.ts\n@@ -1 +1 @@\n-old\n+new\n` };
    },
    async publish(input) {
      published.push(input.workdir);
      return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true };
    },
  };
}

// A scripted adapter under another harness's name: its own authors' scripts, the same list of started sessions.
function otherHarness(t: Setup, harness: Harness, authors: FakeStep[][]): void {
  const adapter = scriptedAdapter(t.store, { authors }, t.startedSessions);
  (t.registry.sessionAdapters as Record<string, unknown>)[harness] = { ...adapter, harness };
}

function leftBehind(fake: FakeDocker, session: string): void {
  const names = sessionNames(session);
  const labels = { 'cleared.dev': 'v2', 'cleared.session': session };
  fake.containers.push({ id: `${session}-c1`, name: names.container, labels: { ...labels }, state: 'running' });
  fake.networks.push({ id: `${session}-n1`, name: names.network, labels: { ...labels } });
}

const item = (t: Setup, ticket: string): VariantsItem | undefined =>
  t.inbox.variants({ ticket }).at(-1) ?? t.inbox.variants({ ticket, state: 'handled' }).at(-1);

const ALL: readonly Harness[] = ['claude-code', 'codex', 'cursor'];
const ENABLED = { pickHarnesses: [{ harness: 'claude-code' as const }, { harness: 'codex' as const }, { harness: 'cursor' as const, model: 'sonnet-4.5' }] };

async function bug(t: Setup): Promise<Ticket> {
  return t.tickets.create({ title: 'Entries lost on reload', body: 'The guestbook forgets the last entry.', project: 'guestbook', labels: ['Bug'] }, { kind: 'human', id: 'u1' });
}

test('three harnesses: the cheapest variant whose tests passed is kept by itself, the others stopped and released, the review by another harness, the win counted', async () => {
  const prepared: Prepared[] = [];
  const published: string[] = [];
  const t = await setup({ config: ENABLED, scripts: { authors: [variant('a1', true, 30_000, 0.9)] }, effects: pickEffects(prepared, published) });
  otherHarness(t, 'codex', [variant('a2', true, 12_000)]);
  otherHarness(t, 'cursor', [variant('a3', false, null)]);
  t.store.db.exec(QUOTA_TABLES.join(';'));
  const fake = new FakeDocker();
  const engine = new FlowEngine({ ...t.deps, release: (sessions) => new Docker(fake.runner).releaseStopped(sessions) });
  const ticket = await bug(t);

  await engine.start(ticket.id, 'u1', undefined, ALL);
  assert.equal(t.startedSessions.length, 3);
  for (const s of t.startedSessions) leftBehind(fake, s.id);
  const [one, two, three] = t.startedSessions as [typeof t.startedSessions[number], typeof t.startedSessions[number], typeof t.startedSessions[number]];
  // Each variant on its harness and model, in its own checkout, told how the pick keeps one.
  assert.deepEqual(t.startedSessions.map((s) => [s.input.harness, s.input.model]), [['claude-code', 'claude-opus-5-5'], ['codex', CODEX_MODEL], ['cursor', 'sonnet-4.5']]);
  assert.deepEqual(prepared.map((p) => p.workdir), ['/work/LOCAL-2.variant-1-1', '/work/LOCAL-2.variant-1-2', '/work/LOCAL-2.variant-1-3']);
  for (const s of t.startedSessions) assert.ok(s.input.prompt.includes(pickPrompt(NPM_TEST)), 'each author is told the rule');

  await until(() => item(t, ticket.id)?.state === 'handled', 'the pick');
  const handled = item(t, ticket.id) as VariantsItem;
  assert.equal(handled.pick, true);
  assert.deepEqual(handled.outcome && { chosen: handled.outcome.chosen, by: handled.outcome.by, measure: handled.outcome.measure }, { chosen: 2, by: 'cleared-v2', measure: 'tokens' });
  assert.deepEqual(handled.variants.map((v) => [v.harness, v.state, v.tests, v.tokens]), [
    ['claude-code', 'dropped', 'passed', 30_000], ['codex', 'chosen', 'passed', 12_000], ['cursor', 'dropped', 'failed', null],
  ]);
  // The others are stopped and their containers and networks released at once.
  assert.deepEqual(fake.containers.map((c) => c.labels['cleared.session']), [two.id]);
  assert.deepEqual(fake.networks.map((n) => n.labels['cleared.session']), [two.id]);

  // The review and the publish on the kept checkout; Codex wrote it, so Claude Code reviews it.
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
  await engine.settled();
  const reviewer = t.startedSessions.find((s) => s.input.role === 'reviewer');
  assert.equal(reviewer?.input.workdir, '/work/LOCAL-2.variant-1-2');
  assert.equal(reviewer?.input.harness, 'claude-code');
  assert.deepEqual(published, ['/work/LOCAL-2.variant-1-2']);
  const comments = (await t.tickets.comments(ticket.id)).map((c) => c.body);
  assert.ok(comments.includes('Started by u1 in 3 variants, one per harness: claude-code, codex, cursor.'), comments.join('\n'));
  assert.ok(comments.some((c) => c.startsWith('Variant 2 of 3 (codex) kept by the harness pick: its `npm test` passed, and it used the fewest tokens of the 2 that passed; variants 1, 3 stopped.')), comments.join('\n'));
  assert.notEqual(one.id, three.id);

  // The wins per ticket type, for the Consumption screen.
  const wins = [
    { type: 'bug', harness: 'claude-code', runs: 1, green: 1, wins: 0 },
    { type: 'bug', harness: 'codex', runs: 1, green: 1, wins: 1 },
    { type: 'bug', harness: 'cursor', runs: 1, green: 0, wins: 0 },
  ];
  assert.deepEqual(harnessWins(t.store.db, 'guestbook'), wins);
  const read = consumption(t.store.db, { project: 'guestbook', now: new Date(), levers: NO_LEVERS, config: { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' } });
  assert.deepEqual(read.wins, wins);
  await engine.close();
});

test('Cursor\'s variant kept: a cheaper one whose tests failed loses, the time decides as Cursor reports no tokens, and Claude Code reviews, not Codex', async () => {
  const t = await setup({ config: ENABLED, scripts: { authors: [variant('a1', false, 2_000)] }, effects: pickEffects([], []) });
  otherHarness(t, 'cursor', [variant('a2', true, null)]);
  const ticket = await bug(t);
  await t.engine.start(ticket.id, 'u1', undefined, ['claude-code', 'cursor']);
  await until(() => item(t, ticket.id)?.state === 'handled', 'the pick');
  const handled = item(t, ticket.id) as VariantsItem;
  assert.deepEqual(handled.outcome && { chosen: handled.outcome.chosen, measure: handled.outcome.measure }, { chosen: 2, measure: 'time' });
  await until(() => t.startedSessions.some((s) => s.input.role === 'reviewer'), 'the reviewer');
  assert.equal(t.startedSessions.find((s) => s.input.role === 'reviewer')?.input.harness, 'claude-code');
  await t.engine.settled();
  await t.engine.close();
});

test('no variant passed its tests: nothing is kept by itself, the owner chooses, and the run counts with no win', async () => {
  const t = await setup({ config: ENABLED, scripts: { authors: [variant('a1', false, 2_000), variant('a2', null, 3_000)] }, effects: pickEffects([], []) });
  const ticket = await bug(t);
  await t.engine.start(ticket.id, 'u1', undefined, ['claude-code', 'claude-code']);
  await until(() => (item(t, ticket.id)?.variants ?? []).every((v) => v.state === 'done'), 'both variants');
  await until(async () => (await t.tickets.comments(ticket.id)).some((c) => c.body.startsWith('No variant')), 'the comment');
  await t.engine.settled();
  const waiting = item(t, ticket.id) as VariantsItem;
  assert.equal(waiting.state, 'waiting');
  assert.deepEqual(waiting.variants.map((v) => v.tests), ['failed', 'not_run']);
  const comments = (await t.tickets.comments(ticket.id)).map((c) => c.body);
  assert.ok(comments.includes('No variant committed a change and passed `npm test` in its own session: the harness pick keeps none, and the owner chooses in the inbox.'), comments.join('\n'));
  assert.deepEqual(harnessWins(t.store.db, 'guestbook'), [{ type: 'bug', harness: 'claude-code', runs: 2, green: 0, wins: 0 }]);
  // The owner's choice is not a win of the pick.
  await t.engine.chooseVariant(waiting.id, 1, 'u1');
  assert.deepEqual(harnessWins(t.store.db, 'guestbook'), [{ type: 'bug', harness: 'claude-code', runs: 2, green: 0, wins: 0 }]);
  await t.engine.settled();
  await t.engine.close();
});

test('a variant that commits nothing is not green, however little it spent: the one with a change is kept', async () => {
  const effects = pickEffects([], []);
  const t = await setup({ config: ENABLED, scripts: { authors: [variant('a1', true, 500)] }, effects: {
    ...effects,
    async variantChanges(input) { return input.workdir.endsWith('-1') ? { files: [], diff: '' } : (effects.variantChanges as NonNullable<FlowEffects['variantChanges']>)(input); },
  } });
  otherHarness(t, 'codex', [variant('a2', true, 20_000)]);
  const ticket = await bug(t);
  await t.engine.start(ticket.id, 'u1', undefined, ['claude-code', 'codex']);
  await until(() => item(t, ticket.id)?.state === 'handled', 'the pick');
  assert.equal(item(t, ticket.id)?.outcome?.chosen, 2);
  const comments = (await t.tickets.comments(ticket.id)).map((c) => c.body);
  assert.ok(comments.some((c) => c.startsWith('Variant 2 of 2 (codex) kept by the harness pick: its `npm test` passed, and it was the only one to pass; variant 1 stopped.')), comments.join('\n'));
  await t.engine.settled();
  await t.engine.close();
});

test('no test command declared: nothing can be green, the owner chooses, and the comment says why', async () => {
  const t = await setup({ scripts: { authors: [variant('a1', null, 2_000), variant('a2', null, 3_000)] }, effects: pickEffects([], [], null) });
  const ticket = await bug(t);
  await t.engine.start(ticket.id, 'u1', undefined, ['claude-code', 'claude-code']);
  for (const s of t.startedSessions) assert.ok(s.input.prompt.includes(pickPrompt(undefined)));
  await until(async () => (await t.tickets.comments(ticket.id)).some((c) => c.body.startsWith('The service declares')), 'the comment');
  assert.equal(item(t, ticket.id)?.state, 'waiting');
  await t.engine.settled();
  await t.engine.close();
});

test('the owner chose before every variant ended: the pick keeps nothing afterwards', async () => {
  const t = await setup({ config: ENABLED, scripts: { authors: [variant('a1', true, 9_000), working('a2')] }, effects: pickEffects([], []) });
  const ticket = await bug(t);
  await t.engine.start(ticket.id, 'u1', undefined, ['claude-code', 'claude-code']);
  await until(() => item(t, ticket.id)?.variants[0]?.state === 'done', 'the first variant');
  await t.engine.chooseVariant((item(t, ticket.id) as VariantsItem).id, 1, 'u1');
  const handled = item(t, ticket.id) as VariantsItem;
  assert.deepEqual(handled.outcome && { by: handled.outcome.by, measure: handled.outcome.measure }, { by: 'u1', measure: undefined });
  assert.deepEqual(harnessWins(t.store.db, 'guestbook'), [{ type: 'bug', harness: 'claude-code', runs: 2, green: 1, wins: 0 }]);
  await t.engine.settled();
  await t.engine.close();
});

test('the quota stop: a variant whose harness is at the week stop does not start, the others go on and the pick keeps one of them', async () => {
  const t = await setup({ config: ENABLED, scripts: { authors: [variant('a1', true, 9_000)] }, effects: pickEffects([], []) });
  otherHarness(t, 'codex', [variant('a2', true, 1_000)]);
  t.store.db.exec(QUOTA_TABLES.join(';'));
  const resets = new Date(Date.parse('2026-10-21T10:00:00.000Z') + 3 * 24 * 3_600_000).toISOString();
  t.store.db.prepare("INSERT INTO quota_readings (project, harness, source, at, ok, \"window\", used_percent, resets_at) VALUES ('guestbook', 'codex', 'codex usage', ?, 1, 'seven_day', 91, ?)")
    .run('2026-10-21T09:00:00.000Z', resets);
  const ticket = await bug(t);
  await t.engine.start(ticket.id, 'u1', undefined, ['claude-code', 'codex']);
  assert.deepEqual(t.startedSessions.map((s) => s.input.harness), ['claude-code'], 'Codex never starts above the stop');
  await until(() => item(t, ticket.id)?.state === 'handled', 'the pick');
  const handled = item(t, ticket.id) as VariantsItem;
  assert.equal(handled.outcome?.chosen, 1);
  assert.equal(handled.variants[1]?.state, 'failed');
  assert.match(handled.variants[1]?.note ?? '', /not started: the seven-day window of codex is at 91 %, at or above the stop of 85 %/);
  // A harness that never ran is not counted.
  assert.deepEqual(harnessWins(t.store.db, 'guestbook'), [{ type: 'bug', harness: 'claude-code', runs: 1, green: 1, wins: 1 }]);
  await t.engine.settled();
  await t.engine.close();
});

test('every harness at the stop: no variant starts, and the ticket goes back to Todo', async () => {
  const t = await setup({ scripts: { authors: [] }, effects: pickEffects([], []), });
  t.store.db.exec(QUOTA_TABLES.join(';'));
  const resets = new Date(Date.parse('2026-10-21T10:00:00.000Z') + 3 * 3_600_000).toISOString();
  t.store.db.prepare("INSERT INTO quota_readings (project, harness, source, at, ok, \"window\", used_percent, resets_at) VALUES ('guestbook', 'claude-code', 'claude-code usage', ?, 1, 'five_hour', 97, ?)")
    .run('2026-10-21T09:30:00.000Z', resets);
  const ticket = await bug(t);
  await t.engine.start(ticket.id, 'u1', undefined, ['claude-code', 'claude-code']);
  assert.equal(t.startedSessions.length, 0);
  await until(async () => (await t.tickets.get(ticket.id))?.status === t.tickets.states.todo, 'the ticket put back');
  await t.engine.close();
});

test('the refusals: a harness the owner has not enabled, one with no adapter, a count out of range; plain variants stay as they were', async () => {
  const t = await setup({ effects: pickEffects([], []) });
  assert.match(t.engine.variantsRefusal(['claude-code', 'codex']) ?? '', /codex is not enabled for the harness pick: CLEARED_V2_PICK_HARNESSES names claude-code/);
  assert.match(t.engine.variantsRefusal(['claude-code']) ?? '', /2 to 4 harnesses/);
  assert.match(t.engine.variantsRefusal(['claude-code', 'claude-code', 'claude-code', 'claude-code', 'claude-code']) ?? '', /2 to 4 harnesses/);
  assert.match(t.engine.variantsRefusal(['claude-code', 'gemini' as Harness]) ?? '', /gemini/);
  assert.equal(t.engine.variantsRefusal(['claude-code', 'claude-code']), undefined);
  assert.equal(t.engine.variantsRefusal(3), undefined);
  const enabled = await setup({ config: ENABLED, effects: pickEffects([], []) });
  assert.match(enabled.engine.variantsRefusal(['claude-code', 'codex']) ?? '', /no adapter for codex is registered/);
  await assert.rejects(enabled.engine.start(enabled.ticket.id, 'u1', undefined, ['claude-code', 'codex']), (e: unknown) => e instanceof FlowError && e.kind === 'invalid');
  await t.engine.close();
  await enabled.engine.close();
});
