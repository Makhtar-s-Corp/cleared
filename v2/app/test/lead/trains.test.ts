// The lead screen's thread lines for a release train and a block (decisions
// 21 and 23, lane 22). The thread holds no train line of its own (no
// LeadMessage kind says one), so the screen reads the trains from the
// inbox's release items, waiting or handled in the last day, and places each
// line among the lead's messages at the time its train last moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LeadMessage, NextInboxItem, ReleaseItem } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { leadFixture } from '../../fixtures/lead.ts';
import { FIXTURE_NOW, towerFixture, trainItems } from '../../fixtures/tower.ts';
import { translator } from '../../web/lib/i18n.ts';
import { stopText, threadRows, trainHeadline, trainLines } from '../../web/screens/lead/model.ts';

const t = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });
const minutesBefore = (minutes: number) => new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();

test('only release items with a train make a line, oldest move first, each at the time its train last moved', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const sessionPlan = { kind: 'session_plan', id: 'session-plan-1', ticket: 'LOCAL-172', project: 'guestbook', since: minutesBefore(1), state: 'waiting', sessionId: 's', plan: { steps: [], files: [], confidence: 'medium', reason: '', proposedAt: minutesBefore(1), go: null } } as const;
  const items: NextInboxItem[] = [...base.inbox, sessionPlan, ...trainItems(FIXTURE_NOW)];
  const lines = trainLines(items);
  assert.deepEqual(lines.map((line) => [line.ticket, line.state, line.at]), [
    ['LOCAL-168', 'rolled_back', minutesBefore(61)],
    ['LOCAL-169', 'landing', minutesBefore(4)],
    ['LOCAL-171', 'blocked', minutesBefore(7)],
  ].sort((a, b) => Date.parse(a[2] as string) - Date.parse(b[2] as string)));
  assert.ok(lines.every((line) => line.href === `/inbox#${encodeURIComponent(line.id)}`));
});

test('each train says where it is, and each service its state, in English and French', () => {
  const [blocked, landing, rolled] = trainItems(FIXTURE_NOW).map((item) => trainLines([item])[0]!);
  assert.equal(trainHeadline(landing!, t), 'LOCAL-169 is landing, one service at a time.');
  assert.deepEqual(landing!.stops.map((stop) => stopText(stop, t)), ['filter-api #8 healthy', 'guestbook #51 merged, health being read']);
  assert.equal(trainHeadline(rolled!, t), 'LOCAL-168 was rolled back, the last landing first.');
  assert.deepEqual(rolled!.stops.map((stop) => stopText(stop, t)), ['filter-api #7 reverted', 'guestbook #49 reverted']);
  assert.equal(trainHeadline(blocked!, t), 'LOCAL-171 is blocked before your approval.');
  assert.match(blocked!.blocked?.reason ?? '', /has no step/);
  assert.match(blocked!.blocked?.proposal ?? '', /backward compatible/);
  assert.equal(trainHeadline(landing!, fr), 'LOCAL-169 atterrit, un service après l\'autre.');
  assert.equal(stopText(landing!.stops[1]!, fr), 'guestbook #51 fusionné, santé en cours de lecture');
  for (const state of ['waiting', 'landed', 'halted'] as const) {
    const line = { ...landing!, state };
    assert.match(trainHeadline(line, t), /^LOCAL-169 /, state);
    assert.match(trainHeadline(line, fr), /^LOCAL-169 /, state);
  }
  for (const state of ['waiting', 'failed'] as const) assert.match(stopText({ ...landing!.stops[0]!, state, pr: null }, t), /^filter-api [a-z]/);
});

test('a train line sits among the lead\'s messages at its time, after the messages written before it', async () => {
  const lead = await leadFixture(FIXTURE_NOW);
  const messages: LeadMessage[] = [
    { ...lead.messages[0]!, seq: 1, at: minutesBefore(120) },
    { ...lead.messages[1]!, seq: 2, at: minutesBefore(30) },
    { ...lead.messages[2]!, seq: 3, at: minutesBefore(2) },
  ];
  const lines = trainLines(trainItems(FIXTURE_NOW));
  const rows = threadRows(messages, lines);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? `m${row.message.seq}` : row.line.ticket)), ['m1', 'LOCAL-168', 'm2', 'LOCAL-171', 'LOCAL-169', 'm3']);
  assert.deepEqual(threadRows(messages, []).map((row) => row.kind), ['message', 'message', 'message']);
});

test('a train with no time of its own sits at the item\'s time', () => {
  const [blocked] = trainItems(FIXTURE_NOW) as [ReleaseItem];
  const [line] = trainLines([blocked]);
  assert.equal(line?.at, blocked.since);
});
