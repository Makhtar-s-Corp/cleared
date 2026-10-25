// A batch of tickets (requirement C6, lane j3-batch-sessions), end to end on
// the fakes: the engine, the scripted adapter and effects that record their
// calls. Several tickets are launched at once, each its own session; at most
// the Consumption screen's lanes run at once (3 when it sets none), counting
// every ticket in progress or in review, not only the batch's; nothing new
// starts at the stop of a subscription window (85 % by default); the tickets
// beyond wait in a queue, in order, and start as a lane frees or the figure
// falls. One that fails fails alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_MAX, BATCH_MIN } from '../../src/api/types.ts';
import type { Levers } from '../../src/consumption/levers.ts';
import { QUOTA_TABLES } from '../../src/consumption/quota.ts';
import { BatchError, BatchRunner, BATCH_TABLES } from '../../src/flow/batch.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { applyTables } from '../../src/store/db.ts';
import { finished, quickAuthor, setup, started, text, until, type SetupOptions } from './support.ts';

// An author still at work: it waits for a message, so its ticket stays in progress.
const working = (id: string): FakeStep[] => [started, ...text(id, 'Still at it.'), { awaitMessage: true }, finished(0.1)];
const still = (n: number): FakeStep[][] => Array.from({ length: n }, (_, i) => working(`a${i + 1}`));
const iso = (ms: number): string => new Date(ms).toISOString();

type Options = SetupOptions & { readonly lanes?: number | null; readonly weekStop?: number };

async function batches(options: Options = {}) {
  const t = await setup(options);
  applyTables(t.store.db, [...BATCH_TABLES, ...QUOTA_TABLES]);
  const lanes = { value: options.lanes === undefined ? null : options.lanes };
  const levers = { read: (): Levers => ({ model: null, maxLanes: lanes.value, paused: false }) };
  const make = () => new BatchRunner({
    db: t.store.db, tickets: t.tickets, flow: t.engine, project: 'guestbook', levers, weekStopPercent: options.weekStop ?? 85, now: () => new Date(t.clock.now),
  });
  const runner = make();
  runner.listen();
  const authors = () => t.startedSessions.filter((s) => s.input.role === 'author');
  const report = (window: 'seven_day' | 'five_hour', usedPercent: number, at = t.clock.now) =>
    t.store.events.append({ at: iso(at), sessionId: 'author-old', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window, usedPercent, resetsAt: null } } });
  return { ...t, runner, make, lanes, authors, report };
}

const titles = (n: number, prefix = 'Ticket'): { title: string }[] => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}` }));

test('five tickets with two lanes: two start, three wait in order, each ticket its own session, labelled with the batch', async () => {
  const t = await batches({ lanes: 2, scripts: { authors: still(5) } });
  const batch = await t.runner.create({ tickets: titles(5) }, 'u1');
  await t.engine.settled();

  assert.match(batch.id, /^batch-\d+$/);
  assert.deepEqual(batch.items.map((i) => i.state), ['started', 'started', 'queued', 'queued', 'queued']);
  assert.deepEqual(batch.items.map((i) => i.position), [1, 2, 3, 4, 5]);
  assert.deepEqual(batch.hold, { reason: 'lanes', running: 2, lanes: 2 });
  assert.equal(t.authors().length, 2);
  assert.deepEqual(t.authors().map((s) => s.input.ticket), batch.items.slice(0, 2).map((i) => i.ticket), 'in the order of the batch');
  assert.equal(new Set(t.authors().map((s) => s.id)).size, 2, 'one session each');

  // The queued tickets exist, in Todo, and carry the batch's label.
  for (const item of batch.items) {
    const ticket = await t.tickets.get(item.ticket);
    assert.deepEqual(ticket?.labels, [`batch:${batch.id}`]);
    assert.equal(ticket?.title, item.title);
    assert.equal(ticket?.status, item.position <= 2 ? t.tickets.states.progress : t.tickets.states.todo);
  }
});

test('a lane that frees starts the next ticket of the queue, without a tick', async () => {
  // The first author ends at once: its change is reviewed and its release waits for approval, which frees the lane.
  const t = await batches({ lanes: 2, scripts: { authors: [quickAuthor, ...still(4)] } });
  const batch = await t.runner.create({ tickets: titles(4) }, 'u1');
  await until(() => t.authors().length === 3, 'the third ticket to start once the first one waits for approval');
  await t.engine.settled();
  await t.runner.settled();

  assert.deepEqual(t.authors().map((s) => s.input.ticket), batch.items.slice(0, 3).map((i) => i.ticket));
  const now = await t.runner.get(batch.id);
  assert.deepEqual(now.items.map((i) => i.state), ['started', 'started', 'started', 'queued']);
  assert.deepEqual(now.hold, { reason: 'lanes', running: 2, lanes: 2 });
});

test('the lanes default to three, and the Consumption screen\'s lever sets them', async () => {
  const t = await batches({ scripts: { authors: still(6) } });
  const batch = await t.runner.create({ tickets: titles(5) }, 'u1');
  await t.engine.settled();
  assert.equal(t.authors().length, 3);
  assert.deepEqual(batch.hold, { reason: 'lanes', running: 3, lanes: 3 });

  t.lanes.value = 4;
  await t.runner.tick();
  await t.engine.settled();
  assert.equal(t.authors().length, 4, 'the lever raised, the next ticket starts at the tick');
  t.lanes.value = 1;
  await t.runner.tick();
  await t.engine.settled();
  assert.equal(t.authors().length, 4, 'a lever lowered stops nothing that runs and starts nothing');
});

test('a ticket that runs outside the batch holds a lane too', async () => {
  const t = await batches({ lanes: 2, scripts: { authors: still(4) } });
  await t.engine.start(t.ticket.id, 'u1');   // the ticket of the setup, not in the batch
  const batch = await t.runner.create({ tickets: titles(3) }, 'u1');
  await t.engine.settled();
  assert.equal(t.authors().length, 2, 'one lane left for the batch');
  assert.deepEqual(batch.items.map((i) => i.state), ['started', 'queued', 'queued']);
  assert.deepEqual(batch.hold, { reason: 'lanes', running: 2, lanes: 2 });
});

test('the quota stop: at 85 % of the seven-day window nothing starts, the queue says why, and it starts once the figure falls', async () => {
  const t = await batches({ lanes: 8, scripts: { authors: still(3) } });
  t.report('seven_day', 86);
  const batch = await t.runner.create({ tickets: titles(3) }, 'u1');
  await t.runner.tick();
  await t.engine.settled();

  assert.equal(t.authors().length, 0);
  assert.deepEqual(batch.items.map((i) => i.state), ['queued', 'queued', 'queued']);
  assert.deepEqual(batch.hold, { reason: 'quota', window: 'seven_day', percent: 86, stop: 85 });
  for (const item of batch.items) assert.equal((await t.tickets.get(item.ticket))?.status, t.tickets.states.todo);

  t.report('seven_day', 10, t.clock.now + 1000);
  await t.runner.tick();
  await t.engine.settled();
  assert.equal(t.authors().length, 3);
  const now = await t.runner.get(batch.id);
  assert.deepEqual(now.items.map((i) => i.state), ['started', 'started', 'started']);
  assert.equal(now.hold, null);
});

test('the stop is reached at 85 exactly, the five-hour window stops too, and the stop is the setting\'s', async () => {
  const t = await batches({ lanes: 8, scripts: { authors: still(4) } });
  t.report('five_hour', 85);
  const batch = await t.runner.create({ tickets: titles(2) }, 'u1');
  assert.deepEqual(batch.hold, { reason: 'quota', window: 'five_hour', percent: 85, stop: 85 });
  t.report('five_hour', 84, t.clock.now + 1000);
  await t.runner.tick();
  await t.engine.settled();
  assert.equal(t.authors().length, 2, 'at 84 the batch starts');

  const lower = await batches({ lanes: 8, weekStop: 60, scripts: { authors: still(2) } });
  lower.report('seven_day', 61);
  const held = await lower.runner.create({ tickets: titles(2) }, 'u1');
  assert.deepEqual(held.hold, { reason: 'quota', window: 'seven_day', percent: 61, stop: 60 });
});

test('a figure whose window has reset does not stop the batch, and the quota wins over the lanes in what the queue says', async () => {
  const t = await batches({ lanes: 1, scripts: { authors: still(4) } });
  t.store.events.append({ at: iso(t.clock.now - 7_200_000), sessionId: 'author-old', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent: 90, resetsAt: iso(t.clock.now - 3_600_000) } } });
  const first = await t.runner.create({ tickets: titles(2) }, 'u1');
  await t.engine.settled();
  assert.equal(t.authors().length, 1, 'the old figure is no stop');
  assert.equal(first.hold?.reason, 'lanes');

  t.report('seven_day', 95, t.clock.now + 1000);
  assert.equal((await t.runner.get(first.id)).hold?.reason, 'quota');
});

test('one ticket that cannot start fails alone, says why, and frees its lane for the next', async () => {
  const t = await batches({
    lanes: 1, scripts: { authors: still(3) },
    effects: { async prepareWorkdir({ ticket }) { if (ticket.title === 'Broken') throw new Error('the clone of Broken failed'); return { workdir: `/work/${ticket.id}`, briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null } }; } },
  });
  const batch = await t.runner.create({ tickets: [{ title: 'Broken' }, { title: 'Fine' }, { title: 'Also fine' }] }, 'u1');
  await until(() => t.authors().length === 1, 'the next ticket to start in the lane the broken one freed');
  await t.engine.settled();
  await t.runner.settled();

  const now = await t.runner.get(batch.id);
  assert.deepEqual(now.items.map((i) => i.state), ['failed', 'started', 'queued']);
  assert.match(now.items[0]?.note ?? '', /clone of Broken failed/);
  assert.equal((await t.tickets.get(batch.items[0]!.ticket))?.status, t.tickets.states.todo, 'put back by the flow');
  assert.equal(t.authors()[0]?.input.ticket, batch.items[1]!.ticket);
});

test('a queued ticket that a person moved out of Todo is not started, and the item says so', async () => {
  const t = await batches({ lanes: 1, scripts: { authors: still(3) } });
  const batch = await t.runner.create({ tickets: titles(3) }, 'u1');
  await t.engine.settled();
  await t.tickets.move(batch.items[1]!.ticket, t.tickets.states.done, { kind: 'human', id: 'u1' });
  t.lanes.value = 3;
  await t.runner.tick();
  await t.engine.settled();

  const now = await t.runner.get(batch.id);
  assert.deepEqual(now.items.map((i) => i.state), ['started', 'failed', 'started']);
  assert.match(now.items[1]?.note ?? '', /no longer in Todo/);
  assert.equal(t.authors().length, 2);
});

test('ticks and events that overlap start a ticket once', async () => {
  const t = await batches({ lanes: 2, scripts: { authors: still(6) } });
  const batch = await t.runner.create({ tickets: titles(4) }, 'u1');
  await Promise.all([t.runner.tick(), t.runner.tick(), t.runner.tick()]);
  await t.engine.settled();
  assert.equal(t.authors().length, 2);
  assert.equal(new Set(t.authors().map((s) => s.input.ticket)).size, 2);
  assert.deepEqual((await t.runner.get(batch.id)).items.map((i) => i.state), ['started', 'started', 'queued', 'queued']);
});

test('the queue is kept: a runner built over the same ledger finishes the batch', async () => {
  const t = await batches({ lanes: 1, scripts: { authors: still(3) } });
  const batch = await t.runner.create({ tickets: titles(3) }, 'u1');
  await t.engine.settled();
  await t.runner.close();

  const again = t.make();
  assert.deepEqual((await again.get(batch.id)).items.map((i) => i.state), ['started', 'queued', 'queued']);
  assert.deepEqual((await again.list()).map((b) => b.id), [batch.id]);
  t.lanes.value = 3;
  await again.tick();
  await t.engine.settled();
  assert.equal(t.authors().length, 3);
  assert.deepEqual((await again.get(batch.id)).items.map((i) => i.state), ['started', 'started', 'started']);
  await again.close();
});

test('batches are numbered, listed newest first, and the second one queues behind the first one\'s lanes', async () => {
  const t = await batches({ lanes: 2, scripts: { authors: still(6) } });
  const one = await t.runner.create({ tickets: titles(2, 'First') }, 'u1');
  const two = await t.runner.create({ tickets: titles(2, 'Second') }, 'u1');
  await t.engine.settled();
  assert.notEqual(one.id, two.id);
  assert.deepEqual((await t.runner.list()).map((b) => b.id), [two.id, one.id]);
  assert.equal(t.authors().length, 2, 'two lanes, taken by the first batch');
  assert.deepEqual((await t.runner.get(two.id)).items.map((i) => i.state), ['queued', 'queued']);
  assert.equal((await t.runner.get(one.id)).by, 'u1');
});

test('a batch is refused whole, before any ticket exists', async () => {
  const t = await batches({ lanes: 2 });
  const before = (await t.tickets.list({ project: 'guestbook' })).length;
  const refused: [string, unknown][] = [
    ['one ticket is no batch', [{ title: 'Alone' }]],
    ['too many', titles(BATCH_MAX + 1)],
    ['not a list', 'Ticket 1'],
    ['a blank title', [{ title: 'Fine' }, { title: '   ' }]],
    ['a title that is not text', [{ title: 'Fine' }, { title: 3 }]],
    ['a long title', [{ title: 'Fine' }, { title: 'x'.repeat(201) }]],
    ['a body that is not text', [{ title: 'Fine' }, { title: 'Two', body: 7 }]],
    ['variants in a batch', [{ title: 'Fine' }, { title: 'Two', variants: 3 }]],
    ['an entry that is not an object', [{ title: 'Fine' }, 'Two']],
  ];
  for (const [what, tickets] of refused) {
    await assert.rejects(t.runner.create({ tickets: tickets as never }, 'u1'), (error: unknown) => error instanceof BatchError && error.kind === 'invalid', what);
  }
  assert.equal((await t.tickets.list({ project: 'guestbook' })).length, before, 'nothing was created');
  assert.deepEqual(await t.runner.list(), []);
  assert.ok(BATCH_MIN === 2 && BATCH_MAX === 20);
  const ok = await t.runner.create({ tickets: titles(BATCH_MAX) }, 'u1');
  assert.equal(ok.items.length, BATCH_MAX, 'the most is allowed');
});

test('an unknown batch is not found', async () => {
  const t = await batches();
  await assert.rejects(t.runner.get('batch-99'), (error: unknown) => error instanceof BatchError && error.kind === 'not_found');
});
