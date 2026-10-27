// The assistant's last step (docs/v2/milestone-5-plan.md, section 14, lane
// v2-j5-first-ticket): a first ticket from the step's own template, one
// visible line of the project, proposed with the service it targets, moved
// to Todo in one click, and followed to live; then the setup's summary, each
// step's time, the person's and the machine's, and the total. On the flow's
// fake harness (test/flow/support.ts), to the approval; the landing is the
// ticket store's move to Done, as the engine makes it once the watch ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type { FlowEngine } from '../../src/flow/engine.ts';
import { defaultRegistry, dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { HttpError } from '../../src/setup/http.ts';
import { SETUP_STEPS_TABLE, SetupRecords } from '../../src/setup/records.ts';
import type { StepDeps } from '../../src/setup/step.ts';
import FIRST_TICKET, { FIRST_TICKET_TABLE, firstTicketStep } from '../../src/setup/steps/first-ticket.ts';
import { HOUR_MS, summaryOf, totalOf } from '../../src/setup/summary.ts';
import type { FirstTicketView, StepView } from '../../src/setup/types.ts';
import { STEP_IDS } from '../../src/setup/types.ts';
import { REPORT_PASS, quickAuthor, reviewerScript, setup, until, type Setup } from '../flow/support.ts';

type Call = (path: string, options?: { readonly method?: string; readonly body?: unknown; readonly user?: string }) => Promise<{ status: number; text: string; json: any }>;

async function serve(engine: () => FlowEngine | undefined, run: (call: Call, records: SetupRecords, clock: { now: number }) => Promise<void>, clock = { now: Date.parse('2026-10-27T09:00:00.000Z') }): Promise<void> {
  const db = new DatabaseSync(':memory:');
  db.exec(SETUP_STEPS_TABLE);
  db.exec(FIRST_TICKET_TABLE);
  const records = new SetupRecords(db, { now: () => new Date(clock.now) });
  const deps = {
    db, records, env: { CLEARED_V2_APP_LANGUAGE: 'fr' }, fromEnvironment: new Set<string>(), fetch, now: () => new Date(clock.now),
    owner: async (context) => {
      if (context.request.headers['x-test-user'] !== 'owner') throw new HttpError(403, 'the setup is the owner\'s');
      return { id: 'u1', name: 'Demo' } as never;
    },
    onStop: () => undefined,
    container: undefined as never,
  } satisfies StepDeps;
  const step = firstTicketStep({ engine: () => engine() });
  const app: App = { registry: defaultRegistry(), tables: [], routes: step.routes?.(deps) ?? [] };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (path, { method = 'GET', body, user = 'owner' } = {}) => {
      const response = await fetch(`${base}/api/setup/first-ticket${path}`, {
        method, headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, text, json: JSON.parse(text) };
    }, records, clock);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

const flow = (): Promise<Setup> => setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });

test('the step is filled, may be skipped, and its file is the registry\'s', () => {
  assert.equal(FIRST_TICKET.id, 'first-ticket');
  assert.equal(FIRST_TICKET.filled, true);
  assert.equal(FIRST_TICKET.skippable, true);
  assert.deepEqual(FIRST_TICKET.tables, [FIRST_TICKET_TABLE]);
});

test('before a workspace is connected the step says so, proposes nothing to move, and refuses the move', async () => {
  await serve(() => undefined, async (call) => {
    const view = await call('?language=en');
    assert.equal(view.status, 200, view.text);
    const shown = view.json as FirstTicketView;
    assert.equal(shown.ready, false);
    assert.deepEqual(shown.services, []);
    assert.equal(shown.ticket, null);
    const moved = await call('', { method: 'POST', body: { service: 'guestbook', language: 'en' } });
    assert.equal(moved.status, 409);
    assert.deepEqual(moved.json, { error: 'no_workspace' });
  });
});

test('the proposal: one visible line of the project, in the asked language, else the app\'s, for each service of the workspace', async () => {
  const t = await flow();
  await serve(() => t.engine, async (call) => {
    const en = (await call('?language=en')).json as FirstTicketView;
    assert.equal(en.ready, true);
    assert.deepEqual(en.services, ['guestbook']);
    assert.equal(en.ticket, null);
    assert.match(en.proposal.title, /README/);
    assert.match(en.proposal.body, /one line/i);
    assert.match(en.proposal.body, /Change nothing else/);
    const fr = (await call('')).json as FirstTicketView;
    assert.notEqual(fr.proposal.title, en.proposal.title, 'CLEARED_V2_APP_LANGUAGE (fr) when none is asked');
    assert.match(fr.proposal.body, /README/);
    assert.equal((await call('', { user: 'someone' })).status, 403, 'the owner\'s only');
  });
});

test('one click moves the first ticket to Todo for the service picked: it starts, and a second click makes no second ticket', async () => {
  const t = await flow();
  await serve(() => t.engine, async (call) => {
    assert.deepEqual((await call('', { method: 'POST', body: { service: 'nowhere', language: 'en' } })).json, { error: 'unknown_service' });
    assert.equal((await call('', { method: 'POST', body: { language: 'en' } })).status, 400);
    const made = await call('', { method: 'POST', body: { service: 'guestbook', language: 'en' } });
    assert.equal(made.status, 200, made.text);
    const view = made.json as FirstTicketView;
    assert.ok(view.ticket);
    assert.equal(view.ticket.service, 'guestbook');
    assert.equal(view.ticket.title, view.proposal.title);
    const ticket = await t.tickets.get(view.ticket.id);
    assert.equal(ticket?.project, 'guestbook');
    assert.deepEqual((await t.tickets.history(view.ticket.id))[0], { status: 'Todo', by: { kind: 'human', id: 'u1' }, at: (await t.tickets.history(view.ticket.id))[0]?.at });
    await until(() => t.startedSessions.length >= 1, 'the author session');
    assert.equal(t.startedSessions[0]?.input.role, 'author');
    const again = await call('', { method: 'POST', body: { service: 'guestbook', language: 'en' } });
    assert.equal(again.status, 409);
    assert.deepEqual(again.json, { error: 'exists' });
    assert.equal((await t.tickets.list({ project: 'guestbook' })).length, 2, 'the fixture\'s ticket and the first one, no third');
  });
});

test('the step follows the ticket: working, review, then the approval waiting in the inbox; live once Done, with the machine\'s time from its history', async () => {
  const t = await flow();
  await serve(() => t.engine, async (call, records, clock) => {
    records.shown('first-ticket');
    clock.now += 2 * 60_000;                                    // two minutes to read the proposal (the flow's clock)
    const made = (await call('', { method: 'POST', body: { service: 'guestbook', language: 'en' } })).json as FirstTicketView;
    const id = made.ticket?.id as string;
    await until(() => t.inbox.list().some((item) => item.kind === 'release' && item.state === 'waiting'), 'the release item', 5000);
    await t.engine.settled();
    const waiting = (await call('?language=en')).json as FirstTicketView;
    assert.equal(waiting.ticket?.stage, 'approval');
    assert.equal(records.get('first-ticket')?.doneAt ?? null, null, 'not done before live');

    // The history's clock: the sessions ran 9 minutes, the owner approved 3 minutes later, the merge and the watch took 4.
    const created = Date.parse(made.ticket?.createdAt as string);
    const at = (minutes: number) => new Date(created + minutes * 60_000).toISOString();
    t.clock.now = Date.parse(at(12));
    await t.tickets.recordApproval(id, { kind: 'human', id: 'u1' });
    assert.equal(((await call('?language=en')).json as FirstTicketView).ticket?.stage, 'merging');
    t.clock.now = Date.parse(at(16));
    await t.tickets.move(id, 'Done', { kind: 'agents', id: 'cleared-v2' });
    clock.now = Date.parse(at(17));                            // the page looks a minute later
    const live = (await call('?language=en')).json as FirstTicketView;
    assert.equal(live.ticket?.stage, 'live');
    assert.equal(live.ticket?.rolledBack, false);
    const record = records.get('first-ticket');
    assert.equal(record?.doneAt, at(16), 'done when the ticket went live, not when the page looked');
    const history = await t.tickets.history(id);
    const validateAt = Date.parse(history.find((h) => h.status === 'Needs Approval')?.at as string);
    assert.equal(record?.machineMs, (validateAt - created) + 4 * 60_000, 'the sessions\' time and the merge\'s');
    assert.equal(record?.personMs, 2 * 60_000 + 16 * 60_000 - (record?.machineMs ?? 0));
    (await call('?language=en'));
    assert.equal(records.get('first-ticket')?.machineMs, record?.machineMs, 'counted once');
  }, t.clock);
});

test('a first ticket rolled back by the release watch is back in Todo, said so, and not live', async () => {
  const t = await flow();
  await serve(() => t.engine, async (call) => {
    const made = (await call('', { method: 'POST', body: { service: 'guestbook', language: 'en' } })).json as FirstTicketView;
    const id = made.ticket?.id as string;
    await until(() => t.inbox.list().some((item) => item.kind === 'release' && item.state === 'waiting'), 'the release item', 5000);
    await t.engine.settled();
    await t.tickets.recordApproval(id, { kind: 'human', id: 'u1' });
    await t.tickets.move(id, 'Todo', { kind: 'agents', id: 'cleared-v2' });
    const back = (await call('?language=en')).json as FirstTicketView;
    assert.equal(back.ticket?.stage, 'todo');
    assert.equal(back.ticket?.rolledBack, true);
  });
});

// The summary (src/setup/summary.ts): what the last page and the step show.
const step = (id: StepView['id'], over: Partial<StepView> = {}): StepView => ({
  id, state: 'done', filled: true, skippable: false, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0, ...over,
});

test('the summary: each step\'s time, the person\'s and the machine\'s, the total, and whether it held in the hour', () => {
  const steps = STEP_IDS.map((id, index) => step(id, { personMs: (index + 1) * 60_000, machineMs: id === 'environment' ? 6 * 60_000 : 0, ...(id === 'secrets' ? { state: 'skipped', personMs: 5_000 } : {}) }));
  const summary = summaryOf(steps);
  assert.deepEqual(summary.lines.map((line) => line.id), [...STEP_IDS]);
  assert.deepEqual(summary.lines.find((line) => line.id === 'environment'), { id: 'environment', state: 'done', personMs: 5 * 60_000, machineMs: 6 * 60_000 });
  assert.deepEqual(totalOf(steps), { personMs: summary.total.personMs, machineMs: summary.total.machineMs });
  assert.equal(summary.total.personMs, (1 + 2 + 3 + 4 + 5 + 7 + 8) * 60_000 + 5_000);
  assert.equal(summary.total.machineMs, 6 * 60_000);
  assert.equal(summary.total.allMs, summary.total.personMs + summary.total.machineMs);
  assert.equal(summary.withinHour, true);
  assert.deepEqual(summary.skipped, ['secrets']);
  assert.equal(summaryOf(steps.map((s) => ({ ...s, machineMs: HOUR_MS }))).withinHour, false);
  assert.equal(summaryOf(steps.map((s) => ({ ...s, state: 'todo' as const }))).finished, false);
  assert.equal(summary.finished, true);
});
