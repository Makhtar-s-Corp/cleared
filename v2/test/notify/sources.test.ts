// What may notify, added in wave 10 (docs/v2/milestone-2-plan.md, decision
// 29 and the followups of lanes 17 and 23): a session plan waiting for its
// Go and a contract waiting for its validation are told as a team's
// permission is, with their inbox link; a schedule that could not run is
// told as a health problem; a schedule that ran is not told, since what it
// started waits in the inbox as any other ticket's work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxOccurrences, scheduleOccurrence } from '../../src/notify/sources.ts';
import { setup } from './support.ts';

const PLAN = { steps: ['Read the list', 'Sort it'], files: ['src/entries.ts'], confidence: 'medium' as const, reason: 'The sort is new.', proposedAt: '2026-10-22T20:00:00.000Z', go: null };

test('a session plan and a contract waiting are told as a permission of their ticket, with their inbox link; handled, they are not', () => {
  const t = setup();
  const plan = t.inbox.addSessionPlan({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 's-1', plan: PLAN });
  const contract = t.inbox.addContract({ ticket: 'LOCAL-2', project: 'guestbook', sessionId: 's-2', step: 'step-1', service: 'filter-api', path: 'contract/openapi.yaml', diff: '+  severity:' });
  const knowledge = t.inbox.addKnowledge({ ticket: 'LOCAL-3', project: 'guestbook', sessionId: 's-3', text: 'Sort with localeCompare.', level: 'workspace', service: null });
  const found = inboxOccurrences(t.inbox.list());
  assert.deepEqual(found.map((o) => `${o.kind} ${o.ticket} ${o.group} ${o.link} ${o.title}`), [
    `permission LOCAL-1 LOCAL-1 /inbox#${encodeURIComponent(plan.id)} `,
    `permission LOCAL-2 LOCAL-2 /inbox#${encodeURIComponent(contract.id)} `,
  ]);
  assert.ok(!found.some((o) => o.key === knowledge.id), 'knowledge waits for the owner\'s morning, untold');
  t.inbox.handleContract(contract.id, 'u1', { decision: 'approve' });
  t.inbox.handleSession('s-1', 'system');
  assert.deepEqual(inboxOccurrences(t.inbox.list()), []);
});

test('the dispatcher sends a waiting session plan with its link, and drops it once it is answered', async () => {
  const t = setup();
  await t.dispatcher.tick();
  const plan = t.inbox.addSessionPlan({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 's-1', plan: PLAN });
  await t.dispatcher.tick();
  assert.deepEqual(t.sender.sent.map((m) => `${m.kind} ${m.ticket} ${m.link}`), [`permission LOCAL-1 /inbox#${encodeURIComponent(plan.id)}`]);
  const contract = t.inbox.addContract({ ticket: 'LOCAL-2', project: 'guestbook', sessionId: 's-2', step: 'step-1', service: 'filter-api', path: 'contract/openapi.yaml', diff: '+' });
  t.inbox.handleContract(contract.id, 'u1', { decision: 'approve' });
  const result = await t.dispatcher.tick();
  assert.equal(t.sender.sent.length, 1, 'a contract approved before the tick is never sent');
  assert.deepEqual(result.sent, []);
});

test('a schedule that ran is not told; one skipped at the week stop is a week_stop; one that failed otherwise is a schedule_failed', () => {
  const at = '2026-10-22T03:00:30.000Z';
  assert.equal(scheduleOccurrence({ type: 'schedule_ran', schedule: 'sch-1', at, plan: 'plan-1' }), null);
  assert.deepEqual(scheduleOccurrence({ type: 'schedule_failed', schedule: 'sch-1', at, reason: 'week', note: 'The seven-day window is at 86 %.' }), {
    key: `schedule:sch-1:${at}`, kind: 'health', ticket: null, group: 'health:week_stop', title: '', code: 'week_stop', link: '/', from: null, at,
  });
  const failed = scheduleOccurrence({ type: 'schedule_failed', schedule: 'sch-2', at, reason: 'recipe', note: 'no recipe bump' });
  assert.equal(failed?.code, 'schedule_failed');
  assert.equal(failed?.group, 'health:schedule_failed');
  assert.equal(failed?.title, '', 'nothing of the note is said');
});
