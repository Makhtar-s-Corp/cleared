// A ticket in variants (issue #271, requirement P75), end to end on the
// fakes: the engine, the scripted adapter, effects that record their calls,
// and the Docker wrapper on a fake docker CLI. 2 to 4 authors on the same
// ticket, each in its own checkout; at most the lanes at once; a variant
// that fails fails alone; the inbox compares the diffs; the owner's choice
// stops the others and releases their containers and networks at once,
// and the review and the publish run on the chosen checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { VariantsItem } from '../../src/api/types.ts';
import { Docker } from '../../src/container/docker.ts';
import { sessionNames } from '../../src/container/session-runtime.ts';
import { FlowEngine, FlowError, type FlowEffects } from '../../src/flow/engine.ts';
import { diffLines, variantFolder, variantPrompt, type VariantKey } from '../../src/flow/variants.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { CONFIG, finished, setup, started, text, until, type Setup } from './support.ts';

const done = (id: string, said: string, cost = 0.2): FakeStep[] => [started, ...text(id, said), finished(cost)];
const failing: FakeStep[] = [started, { emit: { type: 'RUN_ERROR', message: 'the runner died', code: 'runner' } }];
// A variant still at work: it waits for a message, then ends its turn.
const working = (id: string): FakeStep[] => [started, ...text(id, 'Still at it.'), { awaitMessage: true }, finished(0.1)];

const diffOf = (folder: string) => `diff --git a/src/${folder}.ts b/src/${folder}.ts\n--- a/src/${folder}.ts\n+++ b/src/${folder}.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line\n`;

type Prepared = { readonly role: string; readonly workdir: string; readonly variant: VariantKey | undefined };

// Effects whose checkouts are named as the real ones are, and whose
// variant reader answers each checkout's own diff.
function variantEffects(prepared: Prepared[], published: string[]): Partial<FlowEffects> {
  return {
    async prepareWorkdir({ ticket, role, variant }) {
      const workdir = `${CONFIG.workdirRoot}/${variant ? variantFolder(ticket.id, variant) : ticket.id}`;
      prepared.push({ role, workdir, variant });
      return { workdir, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
    },
    async variantChanges({ workdir }) {
      const folder = workdir.split('/').at(-1) as string;
      return { files: [`src/${folder}.ts`], diff: diffOf(folder) };
    },
    async publish(input) {
      published.push(input.workdir);
      return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true };
    },
  };
}

// What a session leaves in Docker: its labelled containers and networks.
function leftBehind(fake: FakeDocker, session: string): void {
  const names = sessionNames(session);
  const labels = { 'cleared.dev': 'v2', 'cleared.session': session };
  fake.containers.push({ id: `${session}-c1`, name: names.container, labels: { ...labels }, state: 'running' }, { id: `${session}-c2`, name: names.egress, labels: { ...labels }, state: 'running' });
  fake.networks.push({ id: `${session}-n1`, name: names.network, labels: { ...labels } });
  fake.volumes.push({ id: names.volume, name: names.volume, labels: { ...labels } });
}

const item = (t: Setup): VariantsItem | undefined => t.inbox.variants({ ticket: t.ticket.id }).at(-1) ?? t.inbox.variants({ ticket: t.ticket.id, state: 'handled' }).at(-1);

test('three variants end to end: own checkouts, one fails alone, the diffs compared, the choice stops the others, releases their containers and reviews the chosen checkout', async () => {
  const prepared: Prepared[] = [];
  const published: string[] = [];
  const t = await setup({ scripts: { authors: [done('a1', 'Sorted with a query.', 0.3), failing, working('a3')] }, effects: variantEffects(prepared, published) });
  const fake = new FakeDocker();
  const engine = new FlowEngine({ ...t.deps, release: (sessions) => new Docker(fake.runner).releaseStopped(sessions) });

  await engine.start(t.ticket.id, 'u1', undefined, 3);
  assert.equal(t.startedSessions.length, 3);
  const [one, two, three] = t.startedSessions.map((s) => s.id) as [string, string, string];
  for (const id of [one, two, three]) leftBehind(fake, id);
  await until(() => (item(t)?.variants ?? []).filter((v) => v.state === 'done' || v.state === 'failed').length === 2, 'the first two variants to end');

  // Each variant has its own checkout, and its author is told it is one of three.
  assert.deepEqual(prepared.map((p) => p.workdir), ['/work/LOCAL-1.variant-1-1', '/work/LOCAL-1.variant-1-2', '/work/LOCAL-1.variant-1-3']);
  assert.deepEqual(t.startedSessions.map((s) => s.input.workdir), prepared.map((p) => p.workdir));
  for (const [i, s] of t.startedSessions.entries()) assert.ok(s.input.prompt.includes(variantPrompt(i + 1, 3)));

  // The second failed alone: the third still works, the ticket still runs.
  assert.equal(t.store.sessions.get(two)?.status, 'failed');
  assert.equal(t.store.sessions.get(three)?.status, 'working');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, t.tickets.states.progress);
  assert.ok(engine.isActive(t.ticket.id));

  // The inbox compares them: the first done with its diff, its lines and its cost.
  const shown = item(t) as VariantsItem;
  assert.equal(shown.state, 'waiting');
  assert.equal(shown.round, 1);
  assert.deepEqual(shown.variants.map((v) => v.state), ['done', 'failed', 'running']);
  const first = shown.variants[0];
  assert.deepEqual(first?.files, ['src/LOCAL-1.variant-1-1.ts']);
  assert.equal(first?.diff, diffOf('LOCAL-1.variant-1-1'));
  assert.deepEqual({ added: first?.added, removed: first?.removed }, { added: 2, removed: 1 });
  assert.equal(first?.costUsd, 0.3);
  assert.match(shown.variants[1]?.note ?? '', /^Variant 2 of 3 failed: The session failed: the runner died/);
  assert.equal((await engine.ticketVariants(t.ticket.id))?.length, 3);

  // A failed or running variant is not chosen.
  await assert.rejects(engine.chooseVariant(shown.id, 2, 'u1'), (e: unknown) => e instanceof FlowError && e.kind === 'conflict');
  await assert.rejects(engine.chooseVariant(shown.id, 3, 'u1'), (e: unknown) => e instanceof FlowError && e.kind === 'conflict');

  const { released } = await engine.chooseVariant(shown.id, 1, 'u1');
  // The running one is stopped, and the others' containers and networks are gone now, not at the next tick.
  assert.equal(t.store.sessions.get(three)?.status, 'stopped');
  const stop = t.store.events.after(three).filter(({ event }) => event.type === 'RUN_ERROR').at(-1)?.event;
  assert.equal(stop?.type === 'RUN_ERROR' ? stop.code : undefined, 'variant_dropped');
  assert.equal(released, 6);
  assert.deepEqual(fake.containers.map((c) => c.labels['cleared.session']), [one, one], 'only the chosen variant keeps its containers');
  assert.deepEqual(fake.networks.map((n) => n.labels['cleared.session']), [one]);
  assert.equal(fake.volumes.length, 3, 'the volumes stay');
  await assert.rejects(engine.chooseVariant(shown.id, 1, 'u1'), (e: unknown) => e instanceof FlowError && e.kind === 'conflict');

  // The review and the publish run on the chosen checkout.
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
  await engine.settled();
  const reviewer = t.startedSessions.find((s) => s.input.role === 'reviewer');
  assert.equal(reviewer?.input.workdir, '/work/LOCAL-1.variant-1-1');
  assert.deepEqual(prepared.filter((p) => p.role === 'reviewer').map((p) => p.variant), [{ round: 1, position: 1 }]);
  assert.deepEqual(published, ['/work/LOCAL-1.variant-1-1']);
  assert.ok(t.calls.includes('captureHandover:author'), 'the chosen variant hands over');

  const handled = item(t) as VariantsItem;
  assert.equal(handled.state, 'handled');
  assert.deepEqual(handled.outcome && { chosen: handled.outcome.chosen, by: handled.outcome.by }, { chosen: 1, by: 'u1' });
  assert.deepEqual(handled.variants.map((v) => v.state), ['chosen', 'failed', 'dropped']);
  const comments = (await t.tickets.comments(t.ticket.id)).map((c) => c.body);
  assert.ok(comments.includes('Started by u1 in 3 variants.'));
  assert.ok(comments.includes('Variant 1 of 3 chosen by u1 for review; variants 2, 3 stopped.'));
  await engine.close();
});

test('four variants run three at once, the fourth when a lane is free; the lanes lever lowers the limit', async () => {
  const t = await setup({ scripts: { authors: [working('a1'), working('a2'), working('a3'), done('a4', 'Done.')] }, effects: variantEffects([], []) });
  await t.engine.start(t.ticket.id, 'u1', undefined, 4);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(t.startedSessions.length, 3);
  assert.deepEqual((await t.engine.ticketVariants(t.ticket.id))?.map((v) => v.state), ['running', 'running', 'running', 'waiting']);

  await t.engine.send(t.startedSessions[0]?.id as string, 'Finish now.', 'u1');
  await until(() => t.startedSessions.length === 4, 'the fourth variant');
  await until(async () => (await t.engine.ticketVariants(t.ticket.id))?.[3]?.state === 'done', 'the fourth to end');
  assert.deepEqual((await t.engine.ticketVariants(t.ticket.id))?.map((v) => v.state), ['done', 'running', 'running', 'done']);
  await t.engine.close();

  const levers = { model: null, maxLanes: 1, paused: false };
  const one = await setup({ scripts: { authors: [working('b1'), done('b2', 'Done.')] }, effects: variantEffects([], []), levers: { read: () => levers } });
  await one.engine.start(one.ticket.id, 'u1', undefined, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(one.startedSessions.length, 1, 'one lane: one variant at a time');
  await one.engine.close();
});

test('every variant failing puts the ticket back with each one\'s reason, and no choice is shown', async () => {
  const t = await setup({ scripts: { authors: [failing, failing] }, effects: variantEffects([], []) });
  await t.engine.start(t.ticket.id, 'u1', undefined, 2);
  await until(() => t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the put back');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.equal(back?.type === 'ticket_put_back' && back.reason, 'variants_failed');
  assert.match(back?.type === 'ticket_put_back' ? back.note : '', /Variant 1 of 2 failed[\s\S]*Variant 2 of 2 failed/);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, t.tickets.states.todo);
  assert.equal(item(t), undefined);
  assert.deepEqual((await t.engine.ticketVariants(t.ticket.id))?.map((v) => v.state), ['failed', 'failed']);
});

test('variants are refused out of 2 to 4 and on a workspace of several services; one is a plain start', async () => {
  const t = await setup({ effects: variantEffects([], []) });
  for (const count of [0, 5, 2.5]) await assert.rejects(t.engine.start(t.ticket.id, 'u1', undefined, count), (e: unknown) => e instanceof FlowError && e.kind === 'invalid');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, t.tickets.states.todo, 'a refusal moves nothing');
  assert.equal(t.engine.variantsRefusal(4), undefined);
  assert.equal(t.engine.variantsRefusal(1), 'variants is a whole number from 2 to 4');

  const several = await setup({
    config: {
      workspace: {
        id: 'shop', services: [
          { name: 'web', kind: 'repo', dir: '/srv/web', repoUrl: 'https://example.invalid/web.git', repo: 'example-org/web', base: 'main', consumes: [] },
          { name: 'api', kind: 'repo', dir: '/srv/api', repoUrl: 'https://example.invalid/api.git', repo: 'example-org/api', base: 'main', consumes: [] },
        ],
      } as never,
    },
  });
  assert.match(several.engine.variantsRefusal(2) ?? '', /^variants run on a workspace of one service, and shop has 2$/);

  await t.engine.start(t.ticket.id, 'u1', undefined, 1);
  assert.equal(t.startedSessions.length, 1);
  assert.equal(t.startedSessions[0]?.input.workdir, '/work/LOCAL-1');
  assert.deepEqual(await t.engine.ticketVariants(t.ticket.id), []);
  await t.engine.close();
});

test('a restart while the owner has not chosen puts the ticket back and settles its variants item', async () => {
  const t = await setup({ scripts: { authors: [done('a1', 'Done.'), working('a2')] }, effects: variantEffects([], []) });
  await t.engine.start(t.ticket.id, 'u1', undefined, 2);
  await until(() => item(t)?.variants[0]?.state === 'done', 'the first variant');
  await t.engine.close();

  const engine = new FlowEngine(t.deps);
  await engine.recover();
  assert.equal((await t.tickets.get(t.ticket.id))?.status, t.tickets.states.todo);
  assert.equal(item(t)?.state, 'handled');
  assert.equal(item(t)?.outcome, null);
  assert.deepEqual((await engine.ticketVariants(t.ticket.id))?.map((v) => v.state), ['dropped', 'dropped']);
  await assert.rejects(engine.chooseVariant(item(t)?.id as string, 1, 'u1'), (e: unknown) => e instanceof FlowError && e.kind === 'conflict');
});

test('the lines of a diff leave its file headers out', () => {
  assert.deepEqual(diffLines(diffOf('x')), { added: 2, removed: 1 });
  assert.deepEqual(diffLines(''), { added: 0, removed: 0 });
  assert.equal(variantFolder('T-9', { round: 2, position: 4 }), 'T-9.variant-2-4');
  assert.throws(() => variantFolder('T-9', { round: 1, position: 5 }), FlowError);
});
