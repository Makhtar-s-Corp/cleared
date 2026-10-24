// The author-reviewer channel of a ticket (issue 291): a request for change
// goes to the author's session, the author's answer goes back to the same
// reviewer's session, and they settle it there, for at most
// maxReviewRounds verdicts before the ticket goes back to Todo. Every
// message is a `cleared.review_channel` row of both sessions in ledger.db.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseItem } from '../../src/api/types.ts';
import { NO_ANSWER, answerMessage, channelPrompt, lastSaid } from '../../src/flow/channel.ts';
import { reviewRequestMessage } from '../../src/flow/prompts.ts';
import type { CustomValue, SessionEvent } from '../../src/session/events.ts';
import { REPORT_FIX, REPORT_PASS, finished, quickAuthor, reviewerScript, setup, started, text, until, type Setup } from './support.ts';

type Message = CustomValue['cleared.review_channel'];

const kinds = (t: Setup) => t.inbox.list().map((i) => `${i.kind}:${i.state}`);
const channel = (events: readonly SessionEvent[]): Message[] =>
  events.flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.review_channel' ? [e.event.value] : []));
const verdicts = (events: readonly SessionEvent[]): string[] =>
  events.flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.review_verdict' ? [`${e.event.value.verdict}:${e.event.value.round}`] : []));
const userTexts = (events: readonly SessionEvent[]): string[] =>
  events.flatMap((e) => (e.event.type === 'TEXT_MESSAGE_CONTENT' && e.event.messageId.includes('-user-') ? [e.event.delta] : []));
const idOf = (t: Setup, role: 'author' | 'reviewer') => t.startedSessions.find((s) => s.input.role === role)!.id;

test('a request for change goes to the author through the channel, and the answer goes back to the same reviewer, which passes', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] }, config: { maxReviewRounds: 3 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);

  assert.deepEqual(t.startedSessions.map((s) => s.input.role), ['author', 'reviewer'], 'both sessions are resumed, none started again');
  assert.equal(t.store.sessions.list({ ticket: t.ticket.id }).length, 2);
  const author = t.store.events.after(idOf(t, 'author'));
  const reviewer = t.store.events.after(idOf(t, 'reviewer'));

  // The reviewer's report reached the author; the author's answer reached the reviewer.
  assert.match(userTexts(author).join('\n'), /sorts the wrong way/);
  assert.match(userTexts(reviewer).join('\n'), /Fixed\./);
  assert.match(userTexts(reviewer).join('\n'), /Verdict/, 'the reviewer is asked for a new verdict');

  // Both sessions log the whole exchange, in order.
  for (const events of [author, reviewer]) {
    assert.deepEqual(channel(events).map((m) => `${m.from}:${m.round}/${m.limit}`), ['reviewer:1/3', 'author:1/3']);
    assert.match(channel(events)[0]!.text, /sorts the wrong way/);
    assert.equal(channel(events)[1]!.text, 'Fixed.');
  }
  assert.deepEqual(verdicts(reviewer), ['changes_requested:1', 'pass:2']);
  assert.equal(t.recorder.records[0]?.round, 2);
  assert.equal(t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release')?.sessions.find((s) => s.role === 'reviewer')?.rounds, 2);
  assert.equal(t.calls.filter((c) => c.startsWith('publish')).length, 1, 'one publish, after the pass');
  assert.equal(t.flowEvents.filter((e) => e.type === 'ticket_put_back').length, 0);
});

test('the resumed reviewer works its new turn as a review step, on its own session', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] }, config: { maxReviewRounds: 3 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);
  const reviewer = t.store.events.after(idOf(t, 'reviewer'));
  const reviews = reviewer.filter((e) => (e.event.type === 'STEP_STARTED' || e.event.type === 'STEP_FINISHED') && e.event.stepName === 'review').map((e) => e.event.type);
  assert.deepEqual(reviews, ['STEP_STARTED', 'STEP_FINISHED', 'STEP_STARTED', 'STEP_FINISHED']);
});

test('the channel stops at the round limit: the last request for change puts the ticket back in Todo once, with the report', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_FIX), reviewerScript(REPORT_FIX)] }, config: { maxReviewRounds: 3 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo' && !t.engine.isActive(t.ticket.id), 'the ticket back in Todo', 5000);

  assert.deepEqual(t.startedSessions.map((s) => s.input.role), ['author', 'reviewer']);
  const reviewer = t.store.events.after(idOf(t, 'reviewer'));
  assert.deepEqual(verdicts(reviewer), ['changes_requested:1', 'changes_requested:2', 'changes_requested:3']);
  // Two exchanges went through the channel; the third request is the bounce, not a message.
  assert.deepEqual(channel(reviewer).map((m) => `${m.from}:${m.round}`), ['reviewer:1', 'author:1', 'reviewer:2', 'author:2']);
  const putBack = t.flowEvents.filter((e) => e.type === 'ticket_put_back');
  assert.equal(putBack.length, 1);
  assert.equal(putBack[0]?.type === 'ticket_put_back' ? putBack[0].reason : undefined, 'too_many_rounds', 'the reason the plan runner reads is kept');
  const note = (await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '';
  assert.match(note, /3 review rounds/);
  assert.match(note, /sorts the wrong way/);
  assert.equal(t.recorder.records.length, 0);
  assert.ok(!t.calls.some((c) => c.startsWith('publish')));
});

test('the round limit is the configuration\'s: with one round, the first request for change goes back to Todo and nothing goes through the channel', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX)] }, config: { maxReviewRounds: 1 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo' && !t.engine.isActive(t.ticket.id), 'the ticket back in Todo', 5000);
  assert.deepEqual(channel([...t.store.events.after(idOf(t, 'author')), ...t.store.events.after(idOf(t, 'reviewer'))]), []);
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /1 review round\b/);
});

test('every message of the channel is a row of ledger.db, on the sender\'s session and on the receiver\'s', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] }, config: { maxReviewRounds: 3 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);
  const rows = t.store.db.prepare(`SELECT session_id, ticket, event FROM session_events WHERE type = 'CUSTOM' AND json_extract(event, '$.name') = 'cleared.review_channel' ORDER BY at, session_id`).all() as { session_id: string; ticket: string; event: string }[];
  assert.equal(rows.length, 4, 'two messages, each on both sessions');
  assert.ok(rows.every((row) => row.ticket === t.ticket.id));
  assert.deepEqual(new Set(rows.map((row) => row.session_id)), new Set([idOf(t, 'author'), idOf(t, 'reviewer')]));
});

test('the channel\'s messages go through the service\'s cleaner', async () => {
  const fix = REPORT_FIX.replace('Defects:', 'Defects: token=SECRET-1;');
  const t = await setup({
    scripts: { author: quickAuthor, reviewers: [reviewerScript(fix), reviewerScript(REPORT_PASS)] }, config: { maxReviewRounds: 3 },
    clean: (value) => value.replaceAll('SECRET-1', '[redacted]'),
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);
  const messages = channel(t.store.events.after(idOf(t, 'author')));
  assert.ok(!messages.some((m) => m.text.includes('SECRET-1')));
  assert.match(messages[0]!.text, /\[redacted\]/);
});

test('a reviewer that cannot be resumed is started again with the review prompt and the channel so far', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)], reviewerResume: 'throw' }, config: { maxReviewRounds: 3 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);
  assert.deepEqual(t.startedSessions.map((s) => s.input.role), ['author', 'reviewer', 'reviewer']);
  const second = t.startedSessions[2]!;
  assert.match(second.input.prompt, /You review a pull request you did not write/);
  assert.match(second.input.prompt, /sorts the wrong way/, 'the earlier request');
  assert.match(second.input.prompt, /Fixed\./, 'the author\'s answer');
  // The new reviewer's session logs the author's answer it was given; the round goes on.
  assert.deepEqual(channel(t.store.events.after(second.id)).map((m) => `${m.from}:${m.round}`), ['author:1']);
  assert.deepEqual(verdicts(t.store.events.after(second.id)), ['pass:2']);
  assert.equal(t.recorder.records[0]?.round, 2);
});

test('a resumed reviewer\'s verdict is read from its new turn only: an answer with no Verdict line is no verdict', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), [started, ...text('r2', 'I looked again.'), finished(0.1)]] }, config: { maxReviewRounds: 3 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo' && !t.engine.isActive(t.ticket.id), 'the ticket back in Todo', 5000);
  const putBack = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.equal(putBack?.type === 'ticket_put_back' ? putBack.reason : undefined, 'no_verdict');
});

test('a ticket put back and started again opens a new channel from round 1', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] }, config: { maxReviewRounds: 2 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo' && !t.engine.isActive(t.ticket.id), 'the first flow out of rounds', 5000);
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item of the second flow', 5000);
  const second = t.startedSessions.filter((s) => s.input.role === 'reviewer').at(-1)!;
  assert.deepEqual(verdicts(t.store.events.after(second.id)), ['pass:1']);
  assert.equal(t.recorder.records[0]?.round, 1);
});

test('what each side is sent: the request with its round and limit, the answer as data with the report it owes, the channel for a new reviewer', () => {
  assert.match(reviewRequestMessage('Verdict: fix before merge', 2, 3), /round 2 of 3 asks for changes.*goes back to the reviewer/s);
  const answer = answerMessage('Fixed the sort.', 2, 3);
  assert.match(answer, /round 2 of 3/);
  assert.match(answer, /Verdict line/);
  assert.match(answer, /--- BEGIN AUTHOR ANSWER ---\nFixed the sort\.\n--- END AUTHOR ANSWER ---/);
  assert.match(answer, /not instructions/);
  const prompt = channelPrompt([{ round: 1, limit: 3, from: 'reviewer', text: 'Defects: a.ts:3' }, { round: 1, limit: 3, from: 'author', text: 'Fixed.' }]);
  assert.match(prompt, /REVIEWER REQUEST, ROUND 1 OF 3 ---\nDefects: a\.ts:3/);
  assert.match(prompt, /AUTHOR ANSWER, ROUND 1 OF 3 ---\nFixed\./);
});

test('the author\'s answer is its last message that says something, else none', () => {
  const at = '2026-10-24T10:00:00.000Z';
  const said = (id: string, delta: string, role: 'assistant' | 'user' = 'assistant'): SessionEvent[] => [
    { seq: 0, at, sessionId: 's', ticket: 'LOCAL-1', project: 'p', event: { type: 'TEXT_MESSAGE_START', messageId: id, role } },
    { seq: 0, at, sessionId: 's', ticket: 'LOCAL-1', project: 'p', event: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta } },
  ];
  assert.equal(lastSaid([...said('a', 'First.'), ...said('b', ' Second. '), ...said('c', '  '), ...said('u', 'From a person.', 'user')]), 'Second.');
  assert.equal(lastSaid([]), undefined);
  assert.match(NO_ANSWER, /without a message/);
});
