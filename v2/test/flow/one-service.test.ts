// The one-service case is unchanged (docs/v2/milestone-2-plan.md, lane 16):
// a ticket of a one-service workspace runs the milestone 1 flow, from Todo
// to Done through the review, the release, the approval and the landing,
// and produces the events it produced before the workspace's lock and
// train. The fixture was written by this test on the engine before lane 16
// (`CLEARED_V2_WRITE_FIXTURE=1`), and the run is compared with it, with the
// configuration as milestone 1 writes it and with its one-service
// workspace spelled out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workspaceOf } from '../../src/flow/config.ts';
import { CONFIG, REPORT_FIX, approved, authorScript, ledgerRow, releaseRow, reviewerScript, REPORT_PASS, setup, type Setup } from './support.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/one-service-events.json', import.meta.url));

// Everything the run says, with the session ids and the item ids made stable.
function transcript(t: Setup): unknown {
  const ids = new Map<string, string>();
  const id = (value: string) => {
    if (!ids.has(value)) ids.set(value, `session-${ids.size + 1}`);
    return ids.get(value) as string;
  };
  for (const s of t.startedSessions) id(s.id);
  const stable = (text: string) => [...ids.entries()].reduce((out, [real, name]) => out.split(real).join(name), text);
  const sessions = [...new Set(t.startedSessions.map((s) => s.id))];
  return {
    events: sessions.map((session) => ({
      session: id(session),
      // The fake adapter stamps its own events with the real clock: their order is kept, not their time.
      events: t.store.events.after(session).map(({ event }) => JSON.parse(stable(JSON.stringify(event)))),
    })),
    flow: t.flowEvents.map((event) => JSON.parse(stable(JSON.stringify(event)))),
    inbox: t.inbox.list().map((item) => JSON.parse(stable(JSON.stringify(item)))),
    calls: t.calls,
    starts: t.startedSessions.map((s) => ({ role: s.input.role, model: s.input.model, workdir: s.input.workdir, project: s.input.project })),
    history: null as unknown,
  };
}

async function run(config: Partial<typeof CONFIG>): Promise<unknown> {
  const t = await setup({ scripts: { author: authorScript, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] }, config });
  const started = t.engine.start(t.ticket.id, 'u1');
  await started;
  // The author's permission request, answered in the inbox, then its message.
  const until = async (ok: () => boolean) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); };
  await until(() => t.inbox.list().some((i) => i.kind === 'permission' && i.state === 'waiting'));
  const author = t.startedSessions[0]!.id;
  await t.engine.answer(author, 'request-1', { kind: 'allow_once' }, 'u1');
  await t.engine.send(author, 'Go on.', 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'));
  await t.engine.settled();
  t.clock.now += 1000;
  await t.tickets.recordApproval(t.ticket.id, { kind: 'human', id: 'u1' });
  await t.engine.tick();
  await t.engine.settled();
  t.clock.now += 60_000;
  await t.engine.tick();
  await t.engine.settled();
  const mergedAt = new Date(t.clock.now).toISOString();
  releaseRow(t.store, { ticket: t.ticket.id, pr: 7, status: 'complete', mergedAt, endedAt: new Date(t.clock.now + 300_000).toISOString() });
  ledgerRow(t.store, { kind: 'release_watch_complete', ticket: t.ticket.id, pr: 7, at: new Date(t.clock.now + 300_000).toISOString() });
  t.clock.now += 400_000;
  await t.engine.tick();
  await t.engine.settled();
  const out = transcript(t) as Record<string, unknown>;
  out.history = (await t.tickets.history(t.ticket.id)).map((h) => [h.status, h.by.kind]);
  await t.engine.close();
  return JSON.parse(JSON.stringify(out)) as unknown;
}

void approved;

test('a ticket of a one-service workspace produces the events, inbox items, calls and moves it produced before the train', async () => {
  const before = await run({});
  if (process.env.CLEARED_V2_WRITE_FIXTURE === '1') writeFileSync(FIXTURE, `${JSON.stringify(before, null, 1)}\n`);
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  assert.deepEqual(before, fixture, 'the configuration as milestone 1 writes it');
  const spelled = await run({ workspace: workspaceOf(CONFIG) });
  assert.deepEqual(spelled, fixture, 'the same configuration with its one-service workspace spelled out');
  // Lane 23: with the steps on, a one-service ticket runs its one service step and nothing else changes.
  assert.deepEqual(await run({ steps: true }), fixture, 'the same configuration with the ticket\'s steps on');
});
