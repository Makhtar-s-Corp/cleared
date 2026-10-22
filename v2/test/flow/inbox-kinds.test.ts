// The inbox kinds of lane 17 (docs/v2/milestone-2-plan.md, decisions 22, 26
// and 27): the session plan waiting for its Go, and the two generic kinds
// lanes 23 and 24 only call, through the store alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { SessionPlan } from '../../src/api/types.ts';
import { INBOX_TABLE, InboxStore } from '../../src/inbox/store.ts';

function store() {
  const db = new DatabaseSync(':memory:');
  db.exec(INBOX_TABLE);
  const clock = { now: Date.parse('2026-10-22T20:00:00.000Z') };
  return { db, clock, inbox: new InboxStore(db, () => new Date(clock.now)) };
}

const base = { ticket: 'LOCAL-3', project: 'guestbook' };

test('a contract item is added, listed, handled once with its outcome, and refused the second time', () => {
  const { inbox, clock } = store();
  const item = inbox.addContract({ ...base, sessionId: 's1', step: 'step-1', service: 'filter-api', path: 'contract/openapi.yaml', diff: '--- a/contract/openapi.yaml\n+++ b/contract/openapi.yaml\n+  severity:\n' });
  assert.equal(item.kind, 'contract');
  assert.equal(item.state, 'waiting');
  assert.equal(item.service, 'filter-api');
  assert.equal(item.step, 'step-1');
  assert.equal(item.outcome, null);
  assert.deepEqual(inbox.contracts().map((i) => i.id), [item.id]);
  assert.deepEqual(inbox.items().map((i) => i.kind), ['contract']);
  // The same step's diff proposed again is the same item.
  assert.equal(inbox.addContract({ ...base, sessionId: 's1', step: 'step-1', service: 'filter-api', path: 'contract/openapi.yaml', diff: 'x' }).id, item.id);
  clock.now += 60_000;
  assert.equal(inbox.handleContract(item.id, 'u1', { decision: 'send_back', message: 'Add an example for severity.' }), true);
  assert.equal(inbox.handleContract(item.id, 'u1', { decision: 'approve' }), false, 'an item is handled once');
  const handled = inbox.item(item.id);
  assert.equal(handled?.kind, 'contract');
  if (handled?.kind !== 'contract') throw new Error('not a contract item');
  assert.equal(handled.state, 'handled');
  assert.deepEqual(handled.outcome, { decision: 'send_back', message: 'Add an example for severity.', by: 'u1', at: '2026-10-22T20:01:00.000Z' });
  assert.deepEqual(inbox.contracts(), [], 'nothing waits');
  assert.deepEqual(inbox.contracts({ ticket: 'LOCAL-3', state: 'handled' }).map((i) => i.id), [item.id]);
  // A sent-back step proposes again: a new item.
  clock.now += 60_000;
  const second = inbox.addContract({ ...base, sessionId: 's2', step: 'step-1', service: 'filter-api', path: 'contract/openapi.yaml', diff: 'y' });
  assert.notEqual(second.id, item.id);
  assert.equal(inbox.handleContract(second.id, 'u1', { decision: 'approve' }), true);
  assert.equal(inbox.handleContract(second.id, 'u1', { decision: 'send_back', message: 'late' }), false);
  assert.deepEqual((inbox.item(second.id) as { outcome: unknown }).outcome, { decision: 'approve', by: 'u1', at: '2026-10-22T20:02:00.000Z' });
  assert.equal(inbox.handleContract('contract:none', 'u1', { decision: 'approve' }), false, 'an unknown item');
});

test('a knowledge item is added, listed, approved or rejected once, and refused the second time', () => {
  const { inbox } = store();
  const lesson = inbox.addKnowledge({ ...base, sessionId: 's1', text: 'The entries table is read newest first.', level: 'service', service: 'guestbook' });
  const decision = inbox.addKnowledge({ ...base, sessionId: 's1', text: 'Words are matched whole.', level: 'contract', service: 'filter-api' });
  const general = inbox.addKnowledge({ ...base, sessionId: 's1', text: 'Tests run against Postgres 16.', level: 'workspace', service: null });
  assert.deepEqual(inbox.knowledge().map((i) => [i.level, i.service]), [['service', 'guestbook'], ['contract', 'filter-api'], ['workspace', null]]);
  assert.equal(lesson.kind, 'knowledge');
  assert.equal(lesson.sessionId, 's1');
  assert.equal(inbox.handleKnowledge(lesson.id, 'u1', 'approve'), true);
  assert.equal(inbox.handleKnowledge(lesson.id, 'u1', 'reject'), false, 'handled once');
  assert.equal(inbox.handleKnowledge(decision.id, 'u1', 'reject'), true);
  assert.equal(inbox.handleKnowledge(decision.id, 'u1', 'approve'), false);
  assert.deepEqual((inbox.item(lesson.id) as { outcome: unknown }).outcome, { decision: 'approve', by: 'u1', at: '2026-10-22T20:00:00.000Z' });
  assert.deepEqual((inbox.item(decision.id) as { outcome: unknown }).outcome, { decision: 'reject', by: 'u1', at: '2026-10-22T20:00:00.000Z' });
  assert.deepEqual(inbox.knowledge().map((i) => i.id), [general.id]);
  assert.throws(() => inbox.addKnowledge({ ...base, sessionId: 's1', text: 'x', level: 'service', service: null }), /names its service/);
  assert.throws(() => inbox.addKnowledge({ ...base, sessionId: 's1', text: ' ', level: 'workspace', service: null }), /text/);
});

const plan: SessionPlan = { steps: ['Sort the entries'], files: ['src/entries.ts'], confidence: 'medium', reason: 'One function.', proposedAt: '2026-10-22T20:00:00.000Z', go: null };

test('a session plan waits as its session\'s item, and leaves with the session; a contract or a knowledge item does not', () => {
  const { inbox } = store();
  const waiting = inbox.addSessionPlan({ ...base, sessionId: 's1', service: 'guestbook', plan });
  assert.equal(waiting.kind, 'session_plan');
  assert.equal(waiting.sessionId, 's1');
  assert.deepEqual(waiting.plan, plan);
  assert.equal(inbox.sessionPlan('s1')?.id, waiting.id);
  assert.equal(inbox.waitingFor('s1'), 1, 'a session whose plan waits waits for a person');
  assert.equal(inbox.find('s1', waiting.id), undefined, 'no answer route finds it');
  const contract = inbox.addContract({ ...base, sessionId: 's1', step: 'step-1', service: 'filter-api', path: 'contract/openapi.yaml', diff: 'x' });
  const knowledge = inbox.addKnowledge({ ...base, sessionId: 's1', text: 'A lesson.', level: 'workspace', service: null });
  assert.equal(inbox.waitingFor('s1'), 1, 'a contract or a knowledge item is not a request of the session');
  inbox.handleSession('s1', 'system');
  assert.equal(inbox.sessionPlan('s1'), undefined);
  assert.equal(inbox.item(waiting.id)?.state, 'handled');
  assert.equal(inbox.item(contract.id)?.state, 'waiting');
  assert.equal(inbox.item(knowledge.id)?.state, 'waiting');
  // After a restart, a session plan of a session that is not live is handled too.
  const again = inbox.addSessionPlan({ ...base, sessionId: 's2', plan: { ...plan, proposedAt: '2026-10-22T20:05:00.000Z' } });
  inbox.handleRequests('system', new Set(['s3']));
  assert.equal(inbox.item(again.id)?.state, 'handled');
  assert.equal(inbox.item(contract.id)?.state, 'waiting');
  assert.equal(inbox.item(knowledge.id)?.state, 'waiting');
});
