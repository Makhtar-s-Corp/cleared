// A ticket in steps (docs/v2/milestone-2-plan.md, decision 26, lane 23), on
// the fake adapter: the contract step on the providing service, its diff
// proposed in the inbox, sent back once and validated; the service steps in
// parallel, each with its siblings as the step's kind wants them; the
// integration on the consumer; then the review and one release card. And
// what goes wrong: a contract step that touched another file, a step that
// fails, a validated contract changed after its validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractItem, ReleaseItem, TicketStep } from '../../src/api/types.ts';
import { FlowEngine } from '../../src/flow/engine.ts';
import { describeFlowEvent } from '../../src/lead/prompts.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { finished, quickAuthor, setup, started, text, until, type Setup } from './support.ts';
import { contractRead, failing, planned, stepped, waiting } from './steps-harness.ts';

test('a two-service ticket: the contract step, sent back once and validated, the two service steps in parallel with a fake each, the integration with real siblings, then one release card', async () => {
  const { t, ticket, steps, states, contract, asked } = await stepped({ reads: { 'filter-api': [contractRead(1), contractRead(2), contractRead(2)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.settled();

  // The contract step ran alone, on the providing service, in its own checkout.
  assert.equal(t.startedSessions.length, 1);
  const first = t.startedSessions[0]!;
  assert.equal(first.input.service, 'filter-api');
  assert.equal(first.input.workdir, '/work/LOCAL-2/filter-api');
  assert.match(first.input.prompt, /contract step/i);
  assert.match(first.input.prompt, /contract\/openapi\.yaml/);
  assert.deepEqual((await states()), ['1 contract filter-api validating', '2 service filter-api waiting', '3 service guestbook waiting', '4 integration guestbook waiting']);
  assert.deepEqual((await steps())[0]?.after, []);
  assert.deepEqual((await steps())[3]?.after, [2, 3]);
  const item = contract() as ContractItem;
  assert.equal(item.service, 'filter-api');
  assert.equal(item.path, 'contract/openapi.yaml');
  assert.match(item.diff, /severity 1/);
  assert.equal(item.sessionId, first.id);
  assert.equal(item.step, (await steps())[0]?.id);
  assert.match(asked[0]?.snapshot ?? '', /^\/work\/LOCAL-2\/\.validated\//, 'the contract is kept as validated under the ticket\'s folder');

  // Sent back once: the step's session is reopened with the message, and proposes a new diff.
  await t.engine.sendBackContract(item.id, 'Add an example for a flagged entry.', 'u1');
  assert.equal(t.inbox.item(item.id)?.state, 'handled');
  assert.deepEqual((t.inbox.item(item.id) as ContractItem).outcome?.decision, 'send_back');
  await until(() => contract() !== undefined, 'the second contract item');
  assert.notEqual(contract()?.id, item.id);
  await t.engine.settled();
  assert.ok(t.store.events.after(first.id).some(({ event }) => JSON.stringify(event).includes('Add an example for a flagged entry.')), 'the message reached the step\'s session');
  assert.equal(t.startedSessions.length, 1, 'the same session, resumed');
  assert.match(contract()?.diff ?? '', /severity 2/);
  assert.equal((await states())[0], '1 contract filter-api validating');

  // Validated: the two service steps start at once, each with its siblings.
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => t.startedSessions.length === 3, 'the two service steps');
  await t.engine.settled();
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api running', '3 service guestbook running', '4 integration guestbook waiting']);
  const [filterStep, guestbookStep] = [t.startedSessions[1]!, t.startedSessions[2]!];
  assert.equal(filterStep.input.service, 'filter-api');
  assert.equal(guestbookStep.input.service, 'guestbook');
  assert.equal(guestbookStep.input.workdir, '/work/LOCAL-2/guestbook');
  const validated = '/work/LOCAL-2/.validated/contract-2/openapi.yaml';
  assert.deepEqual(guestbookStep.input.siblings, [
    { ...planned('LOCAL-2', 'guestbook')[0], env: { FILTER_URL: 'http://filter-api:8795' } },
    { name: 'filter-api', port: 8795, contract: validated },
  ], 'the guestbook step: its own service real, the filter API a fake of the validated contract');
  assert.deepEqual(filterStep.input.siblings, [planned('LOCAL-2', 'filter-api')[1]], 'the filter API step: its own service only');

  // Both end; the integration starts on the consumer with every sibling real.
  await t.engine.send(filterStep.id, 'Go on.', 'u1');
  await t.engine.send(guestbookStep.id, 'Go on.', 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  await t.engine.settled();
  const integration = t.startedSessions[3]!;
  assert.equal(integration.input.role, 'author');
  assert.equal(integration.input.service, 'guestbook');
  assert.match(integration.input.prompt, /integration step/i);
  assert.deepEqual(integration.input.siblings, [
    { ...planned('LOCAL-2', 'guestbook')[0], env: { FILTER_URL: 'http://filter-api:8795' } },
    { ...planned('LOCAL-2', 'guestbook')[1], contract: validated },
  ]);
  assert.equal(t.startedSessions[4]?.input.role, 'reviewer');
  // The reviewer, in the guestbook's checkout, gets the filter API's change and the contract as validated (owner decision of 2026-10-22 20:33).
  const review = t.startedSessions[4]!.input;
  assert.equal(review.service, 'guestbook');
  assert.match(review.prompt, /This ticket spans 2 services: guestbook \(your checkout\) and filter-api\./);
  assert.match(review.prompt, /The owner validated this change in the inbox/);
  assert.match(review.prompt, /--- BEGIN CONTRACT DIFF filter-api contract\/openapi\.yaml ---\n[^]*\+severity 2/);
  assert.match(review.prompt, /--- BEGIN DIFF filter-api ---\n[^]*\+answers a severity/);
  assert.doesNotMatch(review.prompt, /\+held for review/, 'the guestbook\'s own change is read in its checkout');
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api done', '3 service guestbook done', '4 integration guestbook done']);
  assert.ok((await steps()).every((s) => typeof s.costUsd === 'number'));
  assert.equal((await steps())[0]?.costUsd, 0.5, 'the contract step\'s session: its first turn and the turn after the send back');
  const releases = t.inbox.list().filter((i): i is ReleaseItem => i.kind === 'release' && i.ticket === ticket.id);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0]?.train?.services.map((s) => s.service), ['filter-api', 'guestbook']);
  assert.ok(releases[0]?.flags?.some((f) => f.kind === 'contract'), 'the contract file is flagged on the card (issue 205, item 1)');
  await t.engine.close();
});

test('a one-service ticket with steps on has one service step, done when its author is', async () => {
  const t = await setup({ scripts: { author: quickAuthor }, config: { steps: true } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  const steps = (await t.engine.ticketSteps(t.ticket.id)) as TicketStep[];
  assert.deepEqual(steps.map((s) => [s.kind, s.service, s.state, s.session]), [['service', 'guestbook', 'done', t.startedSessions[0]?.id]]);
  await t.engine.close();
});

test('a ticket without steps on answers no step; an unknown ticket is not found', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  assert.deepEqual(await t.engine.ticketSteps(t.ticket.id), []);
  assert.equal(await t.engine.ticketSteps('LOCAL-99'), undefined);
  await t.engine.close();
});

test('a contract step that changed another file than the contract puts the ticket back with a note naming it, and proposes nothing', async () => {
  const { t, ticket, states, contract } = await stepped({ reads: { 'filter-api': [contractRead(1, ['src/check.ts'])] } });
  await t.engine.start(ticket.id, 'u1');
  await until(async () => (await t.tickets.get(ticket.id))?.status === 'Todo', 'the put back');
  await t.engine.settled();
  assert.equal(contract(), undefined);
  assert.equal((await states())[0], '1 contract filter-api failed');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.equal(back?.type === 'ticket_put_back' && back.reason, 'step_failed');
  assert.match(back?.type === 'ticket_put_back' ? back.note : '', /src\/check\.ts/);
  await t.engine.close();
});

test('a contract step that left the contract as it was proposes nothing and the service steps start', async () => {
  const { t, ticket, states, contract } = await stepped({ reads: { 'filter-api': [{ files: [], contract: { path: 'contract/openapi.yaml', diff: '', blob: 'blob-0', snapshot: null } }] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 3, 'the service steps');
  await t.engine.settled();
  assert.equal(contract(), undefined);
  assert.deepEqual((await states()).slice(0, 3), ['1 contract filter-api done', '2 service filter-api running', '3 service guestbook running']);
  await t.engine.close();
});

test('a step that fails stops the ticket\'s other steps, keeps what is done, and tells the lead; started again, the ticket goes on from there', async () => {
  const { t, ticket, states, contract } = await stepped({ authors: [quickAuthor, failing, waiting('s2'), waiting('s3'), waiting('s4'), quickAuthor], reads: { 'filter-api': [contractRead(1)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(async () => (await t.tickets.get(ticket.id))?.status === 'Todo', 'the put back');
  await t.engine.settled();
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api failed', '3 service guestbook waiting', '4 integration guestbook waiting']);
  const guestbookStep = t.startedSessions[2]!;
  assert.equal(t.store.sessions.get(guestbookStep.id)?.status, 'stopped', 'the other running step was stopped');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.ok(back && back.type === 'ticket_put_back' && back.reason === 'step_failed');
  const line = describeFlowEvent(back) ?? '';
  assert.match(line, /step 2/i);
  assert.match(line, /filter-api/);

  // Started again: the contract is not asked again; the two service steps run.
  await t.engine.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 5, 'the service steps again');
  await t.engine.settled();
  assert.deepEqual(t.startedSessions.slice(3).map((s) => s.input.service), ['filter-api', 'guestbook']);
  assert.deepEqual((await states()), ['1 contract filter-api done', '2 service filter-api running', '3 service guestbook running', '4 integration guestbook waiting']);
  await t.engine.close();
});

// Lane j3-contract-notes (P160): lane 23 put the ticket back when a service
// step changed the validated contract; the change now reopens the contract
// step, with the owner's approval, and the ticket is not put back.
test('a service step that changed the validated contract reopens the contract step: a new contract item, the ticket not put back, the other running step held', async () => {
  const { t, ticket, states, contract, asked } = await stepped({ authors: [quickAuthor, quickAuthor, waiting('s2')], reads: { 'filter-api': [contractRead(1), contractRead(5)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  const first = contract() as ContractItem;
  await t.engine.approveContract(first.id, 'u1');
  await until(() => proposals(t, ticket.id) === 2, 'the reopened contract item');
  await t.engine.settled();
  const item = contract() as ContractItem;
  assert.notEqual(item.id, first.id);
  assert.equal(item.state, 'waiting');
  assert.equal(item.step, first.step, 'the contract step\'s own item');
  assert.equal(item.service, 'filter-api');
  assert.match(item.diff, /severity 5/);
  assert.equal((await t.tickets.get(ticket.id))?.status, 'In Progress', 'not put back');
  assert.equal(t.flowEvents.some((e) => e.type === 'ticket_put_back'), false);
  assert.deepEqual(await states(), ['1 contract filter-api validating', '2 service filter-api waiting', '3 service guestbook waiting', '4 integration guestbook waiting']);
  assert.equal(t.store.sessions.get(t.startedSessions[2]!.id)?.status, 'stopped', 'the other running step ran on the old contract: it is stopped');
  assert.match(asked.filter((a) => a.service === 'filter-api').at(-1)?.snapshot ?? '', /\.validated\/step-1-2$/, 'the new contract is kept under the next round of the contract step');
  await t.engine.close();
});

test('the reopened contract, approved, makes the steps that ran on the old one run again against the new one', async () => {
  const { t, ticket, states, contract } = await stepped({
    authors: [quickAuthor, [started, note('n1', OWN_NOTE), { awaitMessage: true }, finished(0.5)], quickAuthor, quickAuthor, quickAuthor, quickAuthor, quickAuthor],
    reads: { 'filter-api': [contractRead(1), contractRead(5), contractRead(5), contractRead(5)] },
  });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => t.startedSessions.length === 3, 'the two service steps');
  await until(async () => (await states())[2] === '3 service guestbook done', 'the guestbook step done on the old contract');
  await t.engine.send(t.startedSessions[1]!.id, 'Go on.', 'u1');
  await until(() => proposals(t, ticket.id) === 2, 'the reopened contract item');
  await t.engine.settled();
  assert.deepEqual(await states(), ['1 contract filter-api validating', '2 service filter-api waiting', '3 service guestbook done', '4 integration guestbook waiting']);
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  await t.engine.settled();
  const guestbook = t.startedSessions.filter((s) => s.input.service === 'guestbook' && /the step of/.test(s.input.prompt));
  assert.equal(guestbook.length, 2, 'the guestbook step ran again');
  assert.ok(guestbook[1]!.input.siblings?.some((s) => s.name === 'filter-api' && s.contract === '/work/LOCAL-2/.validated/contract-5/openapi.yaml'), 'against the contract as validated the second time');
  assert.deepEqual(await states(), ['1 contract filter-api done', '2 service filter-api done', '3 service guestbook done', '4 integration guestbook done']);
  const prompt = t.startedSessions.find((s) => s.input.service === 'filter-api' && /the step of/.test(s.input.prompt) && s.id !== t.startedSessions[1]!.id)?.input.prompt ?? '';
  assert.match(prompt, /changed the contract/, 'the step that asked for the change is told it was validated');
  assert.doesNotMatch(prompt, new RegExp(OWN_NOTE), 'a step\'s own earlier note is not handed back to it');
  assert.match(guestbook[1]!.input.prompt, new RegExp(OWN_NOTE), 'the other step is handed it');
  assert.ok((await t.tickets.comments(ticket.id)).some((c) => /changed the validated contract/.test(c.body)), 'a comment on the ticket says what happened');
  await t.engine.close();
});

test('a reopened contract sent back resumes the contract step\'s session with the owner\'s message', async () => {
  const { t, ticket, contract } = await stepped({ authors: [quickAuthor, quickAuthor, waiting('s2')], reads: { 'filter-api': [contractRead(1), contractRead(5), contractRead(6)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => proposals(t, ticket.id) === 2, 'the reopened contract item');
  await t.engine.settled();
  const item = contract() as ContractItem;
  await t.engine.sendBackContract(item.id, 'Name the field reason.', 'u1');
  await until(() => proposals(t, ticket.id) === 3, 'the third contract item');
  await t.engine.settled();
  assert.ok(t.store.events.after(t.startedSessions[0]!.id).some(({ event }) => JSON.stringify(event).includes('Name the field reason.')), 'the contract step\'s own session was told');
  assert.match(contract()?.diff ?? '', /severity 6/);
  await t.engine.close();
});

// Every contract item of the ticket, waiting or answered.
const proposals = (t: Setup, ticket: string): number => t.inbox.contracts({ ticket }).length + t.inbox.contracts({ ticket, state: 'handled' }).length;

const OWN_NOTE = 'Keep the severity a string.';
const note = (id: string, body: string): FakeStep => ({ hostCall: { toolCallId: id, name: 'leave_note', input: { text: body } } });
const noting = (body: string): readonly FakeStep[] => [started, note('n1', body), ...text('a1', 'Done.'), finished(0.3)];
const NOTE = 'The check answers a severity as a string, not a number.';

// Lane j3-contract-notes (P161): notes between the sessions of a ticket's steps.
test('a note a step\'s session leaves is journaled, cleaned, seen by the lead, and handed to every later step\'s session', async () => {
  const { t, ticket, contract } = await stepped({
    authors: [noting(`${NOTE} The key is sk-abcdef123456.`), quickAuthor, quickAuthor, quickAuthor],
    reads: { 'filter-api': [contractRead(1), contractRead(1), contractRead(1)] },
    clean: (value) => value.replace(/sk-[a-z0-9]+/g, '[redacted]'),
  });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  await t.engine.settled();
  const [contractStep, ...later] = t.startedSessions.slice(0, 4);
  const journaled = t.store.events.after(contractStep!.id).flatMap(({ event }) => (event.type === 'CUSTOM' && event.name === 'cleared.step_note' ? [event.value] : []));
  assert.equal(journaled.length, 1);
  assert.equal(journaled[0]?.text, `${NOTE} The key is [redacted].`);
  assert.equal(journaled[0]?.service, 'filter-api');
  assert.equal(journaled[0]?.step, 1);
  assert.doesNotMatch(contractStep!.input.prompt, /BEGIN NOTES/, 'the first step has none to read');
  assert.equal(later.length, 3);
  for (const next of later) {
    assert.match(next.input.prompt, /--- BEGIN NOTES FROM THE OTHER STEPS ---[^]*step 1[^]*the contract step of filter-api[^]*The check answers a severity as a string[^]*--- END NOTES ---/);
    assert.doesNotMatch(next.input.prompt, /sk-abcdef/);
    const read = t.store.events.after(next.id).flatMap(({ event }) => (event.type === 'CUSTOM' && event.name === 'cleared.step_notes_read' ? [event.value] : []));
    assert.equal(read.length, 1, 'what the session was handed is journaled on it');
  }
  const seen = t.flowEvents.filter((e) => e.type === 'step_note');
  assert.equal(seen.length, 1);
  const line = describeFlowEvent(seen[0] as never) ?? '';
  assert.match(line, /filter-api/);
  assert.match(line, /severity as a string/);
  await t.engine.close();
});

test('a step\'s own earlier notes are not handed back to it, and a note is handed once to a reopened session', async () => {
  const { t, ticket, contract } = await stepped({
    authors: [quickAuthor, noting('Check the empty entry.'), waiting('s2')],
    reads: { 'filter-api': [contractRead(1), contractRead(5), contractRead(6)] },
  });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => proposals(t, ticket.id) === 2, 'the reopened contract item');
  await t.engine.settled();
  await t.engine.sendBackContract((contract() as ContractItem).id, 'Name the field reason.', 'u1');
  await until(() => proposals(t, ticket.id) === 3, 'the third contract item');
  await t.engine.settled();
  const contractEvents = JSON.stringify(t.store.events.after(t.startedSessions[0]!.id).map((e) => e.event));
  assert.match(contractEvents, /BEGIN NOTES FROM THE OTHER STEPS/);
  assert.match(contractEvents, /Check the empty entry\./, 'the contract step\'s session, reopened, was handed the service step\'s note');
  assert.equal(contractEvents.split('Check the empty entry.').length - 1 >= 1, true);
  await t.engine.sendBackContract((contract() as ContractItem).id, 'And the type.', 'u1');
  await until(() => proposals(t, ticket.id) === 4, 'the fourth contract item');
  await t.engine.settled();
  const after = JSON.stringify(t.store.events.after(t.startedSessions[0]!.id).map((e) => e.event));
  assert.equal(after.split('BEGIN NOTES FROM THE OTHER STEPS').length - 1, 1, 'the note is handed once');
  await t.engine.close();
});

test('a note is refused when empty or too long, and a one-service ticket\'s session has no such tool', async () => {
  const { t, ticket } = await stepped({ authors: [[started, note('n1', '   '), note('n2', 'x'.repeat(5000)), ...text('a1', 'Done.'), finished(0.3)]], reads: { 'filter-api': [contractRead(1)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => proposals(t, ticket.id) === 1, 'the contract item');
  await t.engine.settled();
  const calls = t.store.events.after(t.startedSessions[0]!.id).flatMap(({ event }) => (event.type === 'CUSTOM' && event.name === 'cleared.host_call' ? [event.value.outcome] : []));
  assert.deepEqual(calls, ['refused', 'refused']);
  assert.equal(t.flowEvents.some((e) => e.type === 'step_note'), false);
  await t.engine.close();
  const one = await setup({ scripts: { author: quickAuthor }, config: { steps: true } });
  await one.engine.start(one.ticket.id, 'u1');
  await until(() => one.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  assert.equal(one.startedSessions[0]?.input.tools, undefined);
  await one.engine.close();
});

// Lane j3-contract-notes (P163): the handover of a step is filed in the
// memory of the contract the step builds against.
test('a step\'s handover names the contract its step builds against', async () => {
  const captured: { service?: string; contract?: string }[] = [];
  const { t, ticket, contract } = await stepped({
    authors: [quickAuthor, quickAuthor, quickAuthor, quickAuthor], reads: { 'filter-api': [contractRead(1), contractRead(1), contractRead(1)] },
    effects: { async captureHandover(input) { captured.push({ ...(input.contract ? { contract: input.contract } : {}), service: input.workdir.split('/').at(-1) as string }); return 'entry'; } },
  });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.ticket === ticket.id), 'the release item', 5000);
  await t.engine.settled();
  const byService = (name: string) => captured.filter((c) => c.service === name).map((c) => c.contract);
  // The contract step and the provider's service step: its own contract; the consumer's service step: the one it consumes; its integration step names none.
  assert.deepEqual(byService('filter-api'), ['filter-api', 'filter-api']);
  assert.deepEqual(byService('guestbook'), ['filter-api', undefined]);
  await t.engine.close();
});

test('a contract approved while its ticket is in Todo starts nothing; a contract item is answered once', async () => {
  const { t, ticket, states, contract } = await stepped({ reads: { 'filter-api': [contractRead(1)] } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.settled();
  await t.engine.close();
  // The service restarts: the new engine puts the ticket back, and the contract item still waits.
  const again = new FlowEngine(t.deps);
  await again.recover();
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Todo');
  const item = contract() as ContractItem;
  assert.equal(item.state, 'waiting');
  await again.approveContract(item.id, 'u1');
  await again.settled();
  assert.equal(t.startedSessions.length, 1, 'nothing started');
  assert.equal((await states())[0], '1 contract filter-api done');
  await assert.rejects(again.approveContract(item.id, 'u1'), /already/);
  // Started again, the ticket goes on from the service steps.
  await again.start(ticket.id, 'u1');
  await until(() => t.startedSessions.length === 3, 'the service steps');
  await again.settled();
  await again.close();
});

test('a service\'s [merge] guarded_paths reach the release card as the config flag (issue 205, item 1)', async () => {
  const t = await setup({
    scripts: { author: quickAuthor },
    effects: {
      async settings() { return { verdict: 'no blocking issues', safeCommands: [], hosts: [], services: [], scripts: ['test'], guardedPaths: ['deploy/'] }; },
      async changes() { return { files: ['deploy/run.sh'], diff: 'diff --git a/deploy/run.sh b/deploy/run.sh\n--- a/deploy/run.sh\n+++ b/deploy/run.sh\n@@ -1 +1 @@\n-a\n+b\n' }; },
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  const card = t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release');
  assert.deepEqual(card?.flags?.find((f) => f.kind === 'config')?.files, ['deploy/run.sh']);
  await t.engine.close();
});

// The Consumption screen's lane lever (O15): the plan allows two steps at
// once, the owner's cap of one lets the second wait until the first is done.
test('the lanes lever caps the steps that run at once: the second service step waits for the first', async () => {
  const levers = { model: null, maxLanes: 1, paused: false };
  const { t, ticket, states, contract } = await stepped({ reads: { 'filter-api': [contractRead(1), contractRead(1), contractRead(1)] }, levers: { read: () => levers } });
  await t.engine.start(ticket.id, 'u1');
  await until(() => contract() !== undefined, 'the contract item');
  await t.engine.approveContract((contract() as ContractItem).id, 'u1');
  await until(() => t.startedSessions.length === 2, 'the first service step');
  await t.engine.settled();
  assert.deepEqual(await states(), ['1 contract filter-api done', '2 service filter-api running', '3 service guestbook waiting', '4 integration guestbook waiting']);
  assert.equal(t.startedSessions.length, 2, 'only one service step runs under a cap of one');

  await t.engine.send(t.startedSessions[1]!.id, 'Go on.', 'u1');
  await until(() => t.startedSessions.length === 3, 'the second service step, once the first is done');
  assert.equal(t.startedSessions[2]?.input.service, 'guestbook');
  await t.engine.close();
});
