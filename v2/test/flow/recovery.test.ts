// The restart recovery pass (docs/v2/milestone-2-plan.md, decision 12): a
// new engine finds the sessions the last process left running, stops them,
// and puts their tickets back in Todo with a note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowEngine } from '../../src/flow/engine.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import { setup, stepLines } from './support.ts';

const agents = { kind: 'agents', id: 'cleared-v2' } as const;

test('a new engine stops the sessions the last process left working, puts their tickets back with a note, and handles their requests', async () => {
  const t = await setup();
  const { store, tickets, inbox } = t;
  const second = await tickets.create({ title: 'Trim names', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await tickets.move(t.ticket.id, 'In Progress', agents);
  await tickets.move(second.id, 'In Review', agents);
  const at = new Date(t.clock.now).toISOString();
  store.sessions.put({ id: 's-author', project: 'guestbook', ticket: t.ticket.id, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'waiting_human', createdAt: at, updatedAt: at });
  store.sessions.put({ id: 's-review', project: 'guestbook', ticket: second.id, role: 'reviewer', harness: 'claude-code', model: 'claude-sonnet-5-5', status: 'working', createdAt: at, updatedAt: at });
  store.events.append({ at, sessionId: 's-author', ticket: t.ticket.id, project: 'guestbook', event: { type: 'STEP_STARTED', stepName: 'waiting_human' } });
  // Sessions that must stay as they are: one done, one of another project, the lead's.
  store.sessions.put({ id: 's-done', project: 'guestbook', ticket: second.id, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'done', createdAt: at, updatedAt: at });
  store.sessions.put({ id: 's-other', project: 'elsewhere', ticket: 'LOCAL-50', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'working', createdAt: at, updatedAt: at });
  store.sessions.put({ id: 's-lead', project: 'guestbook', ticket: 'lead', role: 'lead', harness: 'claude-code', model: 'claude-opus-5-5', status: 'working', createdAt: at, updatedAt: at });
  inbox.addPermission({ ticket: t.ticket.id, project: 'guestbook', sessionId: 's-author', requestId: 'r1', tool: 'Bash', input: { kind: 'execute', command: 'x' }, suggestion: { decision: 'ask', rule: 'default', reason: 'x' } });

  const engine = new FlowEngine(t.deps);
  const events: FlowEvent[] = [];
  engine.subscribe((e) => { events.push(e); });
  await engine.recover();

  assert.equal(store.sessions.get('s-author')?.status, 'stopped');
  assert.equal(store.sessions.get('s-review')?.status, 'stopped');
  assert.equal(store.sessions.get('s-done')?.status, 'done');
  assert.equal(store.sessions.get('s-other')?.status, 'working');
  assert.equal(store.sessions.get('s-lead')?.status, 'working', 'the lead engine owns the lead\'s sessions');
  for (const id of [t.ticket.id, second.id]) {
    assert.equal((await tickets.get(id))?.status, 'Todo');
    assert.match((await tickets.comments(id)).at(-1)?.body ?? '', /service restarted/i);
  }
  assert.equal(inbox.waitingFor('s-author'), 0);
  const last = store.events.after('s-author').filter((e) => e.event.type !== 'STATE_SNAPSHOT').at(-1)?.event;
  assert.equal(last?.type, 'RUN_ERROR');
  if (last?.type === 'RUN_ERROR') assert.equal(last.code, 'restart');
  assert.deepEqual(stepLines(store.events.after('s-author')), ['+waiting_human', '-waiting_human']);
  assert.deepEqual(events.filter((e) => e.type === 'session_stopped').map((e) => e.type === 'session_stopped' && [e.session, e.reason]), [['s-author', 'restart'], ['s-review', 'restart']]);
  assert.deepEqual(events.filter((e) => e.type === 'ticket_put_back').map((e) => e.type === 'ticket_put_back' && [e.ticket, e.reason]).sort(), [[t.ticket.id, 'restart'], [second.id, 'restart']].sort());
  // The session screen reads the stopped phase.
  assert.equal(engine.sessionSummary('s-author')?.phase, 'stopped');

  // A second pass finds nothing more to do.
  const count = events.length;
  await engine.recover();
  assert.equal(events.length, count);
});

test('a ticket left In Progress with no session at all is put back too; a ticket waiting for approval or in go is left alone', async () => {
  const t = await setup();
  const waiting = await t.tickets.create({ title: 'Waits', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  const other = await t.tickets.create({ title: 'Elsewhere', project: 'elsewhere' }, { kind: 'human', id: 'u1' });
  await t.tickets.move(t.ticket.id, 'In Progress', agents);
  await t.tickets.move(waiting.id, 'Needs Approval', agents);
  await t.tickets.move(other.id, 'In Progress', agents);
  const engine = new FlowEngine(t.deps);
  await engine.recover();
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.equal((await t.tickets.get(waiting.id))?.status, 'Needs Approval');
  assert.equal((await t.tickets.get(other.id))?.status, 'In Progress', 'not this service\'s project');
});

test('recovery leaves a ticket this engine is running', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  await t.engine.recover();
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'In Progress');
  assert.equal(t.store.sessions.get(t.startedSessions[0]!.id)?.status, 'working');
});

test('after the recovery, the containers and networks of every session the ledger says is not live are released, its own project\'s only (issue 265)', async () => {
  const t = await setup();
  const at = new Date(t.clock.now).toISOString();
  const row = (id: string, status: string, over: { project?: string; role?: 'author' | 'reviewer' | 'lead' } = {}) =>
    t.store.sessions.put({ id, project: over.project ?? 'guestbook', ticket: t.ticket.id, role: over.role ?? 'author', harness: 'claude-code', model: 'claude-opus-5-5', status, createdAt: at, updatedAt: at });
  row('s-left-working', 'working');                  // the last process left it working: stopped by the recovery, then released
  row('s-stopped', 'stopped');                       // stopped long ago, its containers still running
  row('s-done', 'done');
  row('s-lead-old', 'stopped', { role: 'lead' });    // a stopped lead
  row('s-lead-live', 'working', { role: 'lead' });   // the lead engine's own, live
  row('s-other', 'stopped', { project: 'elsewhere' });
  const asked: string[][] = [];
  const engine = new FlowEngine({ ...t.deps, release: async (sessions) => { asked.push([...sessions]); return { containers: [], networks: [] }; } });
  await engine.recover();
  assert.equal(asked.length, 1);
  assert.deepEqual([...(asked[0] ?? [])].sort(), ['s-done', 's-lead-old', 's-left-working', 's-stopped']);
  // A release that fails does not fail the recovery.
  const failing = new FlowEngine({ ...t.deps, release: async () => { throw new Error('docker is not there'); } });
  await failing.recover();
});

test('a session this engine runs is never released by its recovery', async () => {
  const t = await setup();
  const asked: string[][] = [];
  const engine = new FlowEngine({ ...t.deps, release: async (sessions) => { asked.push([...sessions]); return { containers: [], networks: [] }; } });
  await engine.start(t.ticket.id, 'u1');
  await engine.recover();
  const live = t.startedSessions[0]?.id as string;
  assert.ok(!asked.flat().includes(live));
});
