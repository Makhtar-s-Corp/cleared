// The session view follows the ticket (docs/v2/ui-overhaul-plan.md, 2.3.1,
// 2.3.2 and U6, lane 36): one thread of the ticket's sessions in order, a
// handover row before each session after the first saying who carries on
// and when, Author and Reviewer as filters of that thread; the session the
// view acts on; what the ticket's sessions changed, checked and spent; the
// consecutive edits of one file merged into one row (Devin's); and the
// Editor's "last turn" beside all changes (Codex's). Pure, so it runs
// under Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../src/api/types.ts';
import type { AgUiEvent } from '../../../src/session/events.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { lastTurnFiles, scopedFiles } from '../../web/components/editor/model.ts';
import { translator } from '../../web/lib/i18n.ts';
import { applyAll, emptyModel, threadOf, timeline, type SessionThread } from '../../web/screens/session/model.ts';
import {
  actingSession, editsOf, filterOptions, viewSessions, handoverLine, ticketChecks, ticketFiles, ticketPlan, ticketSessions, ticketSteps, ticketThread, type Handover, type TicketPart,
} from '../../web/screens/session/ticket.ts';
import { message, modelOf, stored, tool } from './support.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

const at = (minute: number) => new Date(2026, 9, 21, 9, minute).toISOString();
const summary = (id: string, role: SessionSummary['role'], minute: number, phase: SessionSummary['phase'], model = role === 'reviewer' ? 'claude-sonnet-5-5' : 'claude-opus-5-5'): SessionSummary => ({
  id, project: 'guestbook', ticket: 'LOCAL-152', role, harness: 'claude-code', model, phase, status: '', startedAt: at(minute), updatedAt: at(minute + 1), lastSeq: 1,
});

const state = (files: { path: string; added: number; removed: number }[], checks: { name: string; state: 'passed' | 'pending' | 'failed' }[], phase: 'working' | 'done' | 'reviewing' = 'working', steps: { name: 'author' | 'review'; startedAt: string; finishedAt: string | null }[] = []): AgUiEvent =>
  ({ type: 'STATE_SNAPSHOT', snapshot: { status: '', phase, steps, files, checks, usage: {} } });

function threadFrom(session: string, minute: number, events: readonly AgUiEvent[]): SessionThread {
  const model = emptyModel();
  applyAll(model, stored(events, minute * 100 + 1, session).map((event, index) => ({ ...event, at: new Date(new Date(at(minute)).getTime() + index * 1000).toISOString() })));
  return threadOf(model);
}

const AUTHOR = summary('author-1', 'author', 0, 'done');
const REVIEWER = summary('reviewer-1', 'reviewer', 20, 'reviewing');
const authorThread = threadFrom('author-1', 0, [
  { type: 'RUN_STARTED', threadId: 'author-1', runId: 'turn-1' },
  state([], [{ name: 'npm test 2>&1 | tail -8', state: 'pending' }], 'working', [{ name: 'author', startedAt: at(0), finishedAt: null }]),
  ...tool('e1', 'Edit', { kind: 'edit', path: 'src/screens/Envelope.jsx', added: 12, removed: 3 }, { kind: 'edit', ok: true }),
  ...tool('e2', 'Edit', { kind: 'edit', path: 'src/screens/Envelope.jsx', added: 8, removed: 1 }, { kind: 'edit', ok: true }),
  ...tool('e3', 'Edit', { kind: 'edit', path: 'test/envelope.test.mjs', added: 30, removed: 0 }, { kind: 'edit', ok: true }),
  { type: 'RUN_FINISHED', threadId: 'author-1', runId: 'turn-1', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.2 } },
  ...message('m1', 'user', 'Show three months, not two.', 'user-demo'),
  { type: 'RUN_STARTED', threadId: 'author-1', runId: 'turn-2' },
  ...tool('e4', 'Edit', { kind: 'edit', path: 'src/screens/Envelope.jsx', added: 2, removed: 2 }, { kind: 'edit', ok: true }),
  state([{ path: 'src/screens/Envelope.jsx', added: 22, removed: 6 }, { path: 'test/envelope.test.mjs', added: 30, removed: 0 }], [{ name: 'npm test 2>&1 | tail -8', state: 'passed' }], 'done', [{ name: 'author', startedAt: at(0), finishedAt: at(18) }]),
]);
const reviewerThread = threadFrom('reviewer-1', 20, [
  { type: 'RUN_STARTED', threadId: 'reviewer-1', runId: 'review-1' },
  state([], [{ name: 'npm test 2>&1 | tail -8', state: 'pending' }, { name: 'Review', state: 'pending' }], 'reviewing', [{ name: 'review', startedAt: at(20), finishedAt: null }]),
  ...tool('r1', 'Bash', { kind: 'execute', command: 'git diff main...HEAD', description: '' }, { kind: 'execute', output: 'diff --git', cut: 0, isError: false }),
]);
const PARTS: readonly TicketPart[] = [{ summary: REVIEWER, thread: reviewerThread }, { summary: AUTHOR, thread: authorThread }];

test('the ticket\'s sessions: its authors and reviewers, oldest first; a reader or the lead is not of the thread', () => {
  const reader = { ...summary('reader-1', 'reader', 5, 'done'), ticket: 'LOCAL-152' };
  const other = { ...summary('author-2', 'author', 1, 'working'), ticket: 'LOCAL-160' };
  assert.deepEqual(ticketSessions([REVIEWER, reader, other, AUTHOR], 'LOCAL-152').map((s) => s.id), ['author-1', 'reviewer-1']);
});

test('a view draws the ticket\'s sessions when the address names an author or a reviewer; a lead\'s or a reader\'s session alone (review of 251, F1)', () => {
  const lead = { ...summary('lead-1', 'lead', 2, 'working'), ticket: 'lead' };
  assert.deepEqual(viewSessions([AUTHOR, REVIEWER, lead], lead).map((s) => s.id), ['lead-1']);
  assert.deepEqual(viewSessions([AUTHOR, REVIEWER, lead], REVIEWER).map((s) => s.id), ['author-1', 'reviewer-1']);
  assert.deepEqual(viewSessions([AUTHOR], REVIEWER).map((s) => s.id), ['author-1', 'reviewer-1'], 'the session the address names, even before the list has it');
  const leadThread = threadFrom('lead-1', 2, [...message('l1', 'assistant', 'The plan is ready.')]);
  assert.deepEqual(ticketThread([{ summary: lead, thread: leadThread }], 'all').map((e) => (e.kind === 'row' ? e.row.kind : e.kind)), ['message'], 'its own rows, no handover');
});

test('the view acts on the newest live session, else on the one the address names, else on the newest', () => {
  assert.equal(actingSession([AUTHOR, REVIEWER], 'author-1')?.id, 'reviewer-1', 'the reviewer runs: the view is the reviewer\'s');
  const ended = { ...REVIEWER, phase: 'done' as const };
  assert.equal(actingSession([AUTHOR, ended], 'author-1')?.id, 'author-1', 'nothing runs: the session asked for');
  assert.equal(actingSession([AUTHOR, ended], 'nobody')?.id, 'reviewer-1', 'nothing runs, an unknown address: the newest');
  const paused = { ...REVIEWER, phase: 'waiting_human' as const, takenOver: { by: 'user-demo', at: at(25) } };
  assert.equal(actingSession([AUTHOR, paused], 'author-1')?.id, 'reviewer-1', 'a session taken over is live');
  assert.equal(actingSession([], 'author-1'), undefined);
});

test('one thread: the author\'s rows, a handover row with who and when, then the reviewer\'s rows', () => {
  const entries = ticketThread(PARTS, 'all');
  assert.deepEqual(entries.map((e) => (e.kind === 'handover' ? `handover ${e.role} after ${e.after}` : `${e.session} ${e.row.kind}`)), [
    'author-1 edits', 'author-1 tool', 'author-1 message', 'author-1 tool', 'handover reviewer after author', 'reviewer-1 tool',
  ]);
  const handover = entries.find((e) => e.kind === 'handover') as Handover;
  assert.deepEqual([handover.session, handover.at, handover.model], ['reviewer-1', at(20), 'Sonnet']);
  assert.equal(handoverLine(handover, en), 'Sonnet started the review at 09:20. The author\'s work is above.');
  assert.equal(handoverLine(handover, fr), 'Sonnet a commencé la relecture à 09:20. Le travail de l\'auteur est au-dessus.');
  const back: Handover = { ...handover, role: 'author', model: 'Opus', after: 'reviewer' };
  assert.equal(handoverLine(back, en), 'Opus started on the review\'s changes at 09:20. The review is above.');
  assert.equal(handoverLine(back, fr), 'Opus a repris le ticket pour les changements demandés à 09:20. La relecture est au-dessus.');
  const again: Handover = { ...handover, role: 'author', model: 'Opus', after: 'author' };
  assert.equal(handoverLine(again, en), 'A new author session, Opus, started at 09:20. The last one is above.');
  assert.equal(handoverLine(again, fr), 'Une nouvelle session d\'auteur, Opus, a commencé à 09:20. La précédente est au-dessus.');
});

test('Author and Reviewer filter the thread: one role\'s rows, no handover row; a session not yet read adds nothing', () => {
  assert.deepEqual(ticketThread(PARTS, 'author').map((e) => (e.kind === 'handover' ? 'handover' : e.session)), ['author-1', 'author-1', 'author-1', 'author-1']);
  assert.deepEqual(ticketThread(PARTS, 'reviewer').map((e) => (e.kind === 'handover' ? 'handover' : e.session)), ['reviewer-1']);
  const unread: TicketPart[] = [{ summary: AUTHOR, thread: authorThread }, { summary: REVIEWER, thread: undefined }];
  assert.deepEqual(ticketThread(unread, 'all').map((e) => e.kind).slice(-1), ['handover'], 'the handover row is there before the reviewer\'s rows arrive');
});

test('the filters: the whole ticket, then the latest author and reviewer by their model, a role not started yet disabled', () => {
  assert.deepEqual(filterOptions([AUTHOR, REVIEWER], en).map((o) => [o.filter, o.label, o.disabled]), [['all', 'Whole ticket', false], ['author', 'Author (Opus)', false], ['reviewer', 'Reviewer (Sonnet)', false]]);
  assert.deepEqual(filterOptions([AUTHOR], fr).map((o) => [o.filter, o.label, o.disabled]), [['all', 'Tout le ticket', false], ['author', 'Auteur (Opus)', false], ['reviewer', 'Relecteur, en attente', true]]);
});

test('consecutive edits of one file are one row with their sum and their count; an edit of another file, or one asked about, is its own', () => {
  const rows = timeline(modelOf([
    ...tool('a', 'Edit', { kind: 'edit', path: 'src/a.js', added: 3, removed: 1 }, { kind: 'edit', ok: true }),
    ...tool('b', 'Edit', { kind: 'edit', path: 'src/a.js', added: 4, removed: 0 }, { kind: 'edit', ok: true }),
    ...tool('c', 'Edit', { kind: 'edit', path: 'src/a.js', added: 1, removed: 5 }, { kind: 'edit', ok: true }),
    ...tool('d', 'Edit', { kind: 'edit', path: 'src/b.js', added: 2, removed: 2 }, { kind: 'edit', ok: true }),
    ...tool('e', 'Edit', { kind: 'edit', path: 'src/a.js', added: 1, removed: 0 }, { kind: 'edit', ok: true }),
  ]));
  assert.deepEqual(rows.map((row) => (row.kind === 'edits' ? ['edits', row.path, row.added, row.removed, row.count, row.ids] : row.kind === 'tool' ? ['tool', row.id] : [row.kind])), [
    ['edits', 'src/a.js', 8, 6, 3, ['a', 'b', 'c']], ['tool', 'd'], ['tool', 'e'],
  ]);
});

test('the turns of a session are kept, so the Editor can show the last turn that changed a file beside all changes', () => {
  assert.equal(authorThread.turns.length, 2);
  const edits = editsOf(PARTS);
  assert.deepEqual(edits.map((e) => [e.path, e.added, e.removed]), [['src/screens/Envelope.jsx', 12, 3], ['src/screens/Envelope.jsx', 8, 1], ['test/envelope.test.mjs', 30, 0], ['src/screens/Envelope.jsx', 2, 2]]);
  const last = lastTurnFiles(edits, PARTS.flatMap((p) => p.thread?.turns ?? []));
  assert.deepEqual(last, [{ path: 'src/screens/Envelope.jsx', added: 2, removed: 2 }], 'the reviewer\'s turn changed nothing: the author\'s second turn is the last that did');
  const all = ticketFiles(PARTS);
  assert.deepEqual(all, [{ path: 'src/screens/Envelope.jsx', added: 22, removed: 6 }, { path: 'test/envelope.test.mjs', added: 30, removed: 0 }], 'all changes: the ticket\'s, as the author left them');
  assert.deepEqual(scopedFiles(all, last, 'all'), all);
  assert.deepEqual(scopedFiles(all, last, 'last'), last);
  assert.deepEqual(lastTurnFiles([], []), []);
  assert.deepEqual(lastTurnFiles([{ path: 'a', added: 1, removed: 0, at: at(1) }, { path: 'a', added: 2, removed: 1, at: at(2) }], []), [{ path: 'a', added: 3, removed: 1 }], 'no turn known: every edit is the last turn\'s');
});

test('the ticket\'s checks go on: each by its name, the newest session\'s value, in the order they first came', () => {
  assert.deepEqual(ticketChecks(PARTS), [{ name: 'npm test 2>&1 | tail -8', state: 'pending' }, { name: 'Review', state: 'pending' }]);
  assert.deepEqual(ticketChecks([PARTS[1] as TicketPart]), [{ name: 'npm test 2>&1 | tail -8', state: 'passed' }]);
});

test('the time by step adds up every session of the ticket; the plan is the latest author\'s', () => {
  const steps = ticketSteps(PARTS, new Date(at(24)).getTime());
  assert.deepEqual(steps.map((s) => [s.name, s.ms / 60_000, s.open]), [['author', 18, false], ['review', 4, true]]);
  assert.equal(ticketPlan(PARTS), null);
});

// The review channel (issue 291): each message is journaled on the sender's
// session and on the receiver's; the whole ticket shows it once, where it
// arrived, and a filter shows both sides of one role.
test('the review channel shows each message once in the whole ticket, where it arrived; a role\'s filter shows what it sent and received', () => {
  const request = { round: 1, limit: 3, from: 'reviewer' as const, text: 'Verdict: fix before merge\nDefects: src/a.ts:3' };
  const answer = { round: 1, limit: 3, from: 'author' as const, text: 'Fixed the sort.' };
  const channel = (value: typeof request | typeof answer): AgUiEvent => ({ type: 'CUSTOM', name: 'cleared.review_channel', value });
  const author = threadFrom('author-1', 0, [...message('a1', 'assistant', 'Done.'), channel(request), ...message('a2', 'assistant', 'Fixed the sort.'), channel(answer)]);
  const reviewer = threadFrom('reviewer-1', 20, [...message('r1', 'assistant', request.text), channel(request), channel(answer), ...message('r2', 'assistant', 'Verdict: no blocking issues')]);
  const parts: TicketPart[] = [{ summary: AUTHOR, thread: author }, { summary: REVIEWER, thread: reviewer }];
  const line = (e: ReturnType<typeof ticketThread>[number]) => (e.kind === 'handover' ? 'handover' : e.row.kind === 'channel' ? `${e.session} channel ${e.row.from}` : `${e.session} ${e.row.kind}`);
  assert.deepEqual(ticketThread(parts, 'all').map(line), [
    'author-1 message', 'author-1 channel reviewer', 'author-1 message', 'handover', 'reviewer-1 message', 'reviewer-1 channel author', 'reviewer-1 message',
  ]);
  assert.deepEqual(ticketThread(parts, 'author').map(line), ['author-1 message', 'author-1 channel reviewer', 'author-1 message', 'author-1 channel author']);
  assert.deepEqual(ticketThread(parts, 'reviewer').map(line), ['reviewer-1 message', 'reviewer-1 channel reviewer', 'reviewer-1 channel author', 'reviewer-1 message']);
});
