// The session screen as HTML: the fixture session against the capture, the
// catalog in both languages, the escaping, and the rule that the page has
// no inline style.
import { test } from 'vitest';
import { renderIndex, renderSession, strings, visibleText } from '../render.tsx';
import assert from 'node:assert/strict';
import { AUTHOR_ID, ANSWER_TEXT, QUESTION_TEXT, TICKET_BODY, TICKET_TITLE, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { applyAll, emptyModel, parseCriteria, threadOf, timeline, type SessionModel, type SessionView } from '../../screens/session/model.ts';
import type { SessionSummary } from '../../../../src/api/types.ts';
import { modelOf, tool } from '../../../test/session/support.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../../screens/session/Session.tsx';

const sentinel: Translate = (key) => `«${key}»`;
// The screen's catalog over the shell's, as the shell gives it (lib/catalogs.ts): the intent's words are the shell's.
const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });

function viewOf(overrides: Partial<SessionView> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: 'demo-id', language: 'en', now: FIXTURE_NOW, ...overrides };
}

// A view on a model: the thread the session's agent would hold for it.
function on(model: SessionModel, overrides: Partial<SessionView> = {}): SessionView {
  return viewOf({ thread: threadOf(model), ...overrides });
}

const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;

test('the English screen reads as the capture, in milestone 1\'s words', () => {
  const text = visibleText(renderSession(viewOf(), en)).join('\n');
  for (const expected of [
    TICKET_TITLE, 'LOCAL-161', 'Done when', 'Entries grouped by week, Monday first', 'Same totals as today, a test proves it', 'Plan of the session',
    'Paused, waiting for you', '18\u00a0min · 35,500 tokens',
    'Read', 'src/screens/Upcoming.jsx', 'and 2 more files', 'Edit', 'src/engine/upcoming.mjs', '+24', '−6', 'Run the project\'s tests', 'npm run test:upcoming', '18 passed', QUESTION_TEXT, ANSWER_TEXT,
    'Allow the author to install date-fns?', 'The command adds a dependency to the project.', 'Command', 'npm install date-fns', 'Allow once', 'Always in this project', 'Deny',
    'Changes', 'Checks', 'Targeted tests', 'Full suite', 'Hand over to Codex', 'Interrupt', 'Send',
  ]) assert.ok(text.includes(expected), `missing: ${expected}`);
});

test('the request has its three buttons, and nothing else on the page answers it', () => {
  const html = renderSession(viewOf(), en);
  assert.deepEqual([...html.matchAll(/data-answer="([a-z_]+)"/g)].map((m) => m[1]), ['allow_once', 'allow_always', 'reject_once']);
  assert.equal(count(html, /data-row="/g), 9, 'nine rows: the read group, the plan and its Go, two edits, the run, the two messages, the install');
  assert.equal(count(html, /data-row="read"/g), 1);
  assert.equal(count(html, /data-row="edit"/g), 2);
  assert.equal(count(html, /data-row="request"/g), 1);
});

test('the composer has Send and Interrupt; the hand over is offered on a live author, and off, with its reason, on a reviewer (B6.3)', () => {
  const html = renderSession(viewOf(), en);
  assert.match(html, /<button[^>]*id="send"[^>]*type="submit"|<button[^>]*type="submit"[^>]*id="send"/);
  assert.match(html, /<button[^>]*id="interrupt"/);
  assert.match(html, /<button[^>]*id="handover"[^>]*data-to="codex"/);
  assert.doesNotMatch(html, /<button[^>]*id="handover"[^>]*aria-disabled/);
  const reviewer = renderSession(viewOf({ summary: { ...(viewOf().summary), role: 'reviewer' } }), en);
  assert.match(reviewer, /<button[^>]*id="handover"[^>]*aria-disabled="true"/);
  assert.ok(visibleText(reviewer).includes('Only a live author\'s session is handed over, when nobody has taken it over.'));
  assert.match(html, /placeholder="Message the author…"/);
});

test('Send waits for a message; Interrupt keeps its name where a phone shows its icon only (lane 38, the critique)', () => {
  const empty = renderToStaticMarkup(<Composer view={viewOf()} t={en} text="" />);
  assert.match(empty, /<button[^>]*id="send"[^>]*disabled/);
  assert.match(renderToStaticMarkup(<Composer view={viewOf()} t={en} text="   " />), /<button[^>]*id="send"[^>]*disabled/);
  assert.doesNotMatch(renderToStaticMarkup(<Composer view={viewOf()} t={en} text="Look at the week view" />), /<button[^>]*id="send"[^>]*disabled/);
  assert.match(empty, /<button[^>]*id="interrupt"[^>]*><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span class="btn-label">Interrupt<\/span><\/button>/);
});

test('the sessions index puts what waits for the person first, then the most recent', () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const base = fixture.sessions[0] as SessionSummary;
  const other = (id: string, ticket: string, phase: SessionSummary['phase'], updatedAt: string): SessionSummary => ({ ...base, id, ticket, phase, updatedAt });
  const sessions = [other('a', 'LOCAL-1', 'working', '2026-10-21T09:50:00Z'), other('b', 'LOCAL-2', 'waiting_human', '2026-10-21T09:00:00Z'), other('c', 'LOCAL-3', 'working', '2026-10-21T09:40:00Z')];
  const order = [...renderIndex({ sessions, tickets: [], now: FIXTURE_NOW }, en).matchAll(/href="\/sessions\/([a-z])"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['b', 'a', 'c']);
});

test('an ended session cannot be written to or interrupted', () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = modelOf([{ type: 'STATE_SNAPSHOT', snapshot: { status: 'Done', phase: 'done', steps: [], files: [], checks: [], usage: {} } }]);
  const html = renderSession(on(model, { summary: { ...(fixture.sessions[0] as SessionSummary), phase: 'done' } }), en);
  assert.match(html, /<input[^>]*id="message"[^>]*disabled/);
  assert.match(html, /<button[^>]*id="send"[^>]*disabled/);
  assert.match(html, /<button[^>]*id="interrupt"[^>]*disabled/);
  assert.ok(visibleText(html).includes('Done'));
});

test('every word on the screen comes from the catalog or from the data', () => {
  const view = viewOf();
  const rows = view.thread.rows;
  const allowed = strings([view.ticket, view.summary, view.thread.state, rows]);
  const parsed = parseCriteria(TICKET_BODY);
  for (const text of [...parsed.description, ...parsed.criteria.map((c) => c.text)]) allowed.add(text);
  for (const row of rows) allowed.add(`${String(new Date(row.at).getHours()).padStart(2, '0')}:${String(new Date(row.at).getMinutes()).padStart(2, '0')}`);
  // A command's last lines, one a line, in its step's detail.
  for (const row of rows) if (row.kind === 'tool' && row.output?.kind === 'execute') for (const line of row.output.output.split('\n')) allowed.add(line.trim());
  allowed.add('LOCAL-161');
  const html = renderSession(view, sentinel);
  for (const text of visibleText(html)) {
    const rest = text.replace(/«[a-z0-9_]+»/g, '').trim();
    if (!/\p{L}/u.test(rest)) continue;
    assert.ok(allowed.has(rest), `not from the catalog nor the data: ${JSON.stringify(rest)}`);
  }
  assert.doesNotMatch(html, /\sstyle=/, 'no inline style: the page runs under default-src \'self\'');
  assert.doesNotMatch(html.replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ''), /<style|<script|https?:\/\//, 'nothing inline, nothing from another site (an icon\'s SVG namespace is a name, not an address)');
});

test('the French screen has no English sentence left', () => {
  const enCatalog = { ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') };
  const frCatalog = { ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') };
  const html = renderSession(viewOf(), translator(frCatalog));
  for (const [key, value] of Object.entries(enCatalog)) {
    if (frCatalog[key] === value || value.length < 12 || !/\s/.test(value)) continue;
    const plain = value.replace(/\{[a-z_]+\}/g, '').trim();
    if (plain.length < 12) continue;      // "install {name}": a word of the data, not a sentence
    assert.ok(!html.includes(plain), `English left in French: ${plain}`);
  }
  assert.ok(visibleText(html).includes('En pause, attend votre réponse'));
});

test('what the data says is escaped, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>"&';
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = modelOf([
    { type: 'STATE_SNAPSHOT', snapshot: { status: evil, phase: 'working', steps: [], files: [{ path: evil, added: 1, removed: 1 }], checks: [{ name: evil, state: 'passed' }], usage: {} } },
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: evil }, { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    ...tool('t', 'Bash', { kind: 'execute', command: evil, description: evil }, { kind: 'execute', output: evil, cut: 0, isError: false }),
    { type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId: evil, toolCallId: 't', tool: evil, input: { kind: 'execute', command: evil }, suggestion: { decision: 'ask', rule: evil, reason: evil } } },
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'x', decision: 'reject_once', by: 'policy', rule: evil } },
    { type: 'CUSTOM', name: 'cleared.question', value: { requestId: evil, questions: [{ question: evil, options: [{ label: evil }] }] } },
    { type: 'RUN_ERROR', message: evil },
  ]);
  const html = renderSession({
    ...viewOf(), thread: threadOf(model), ticket: { ...fixture.ticket, title: evil, body: `${evil}\n\n- [ ] ${evil}` },
    summary: { ...(fixture.sessions[0] as SessionSummary), model: evil }, siblings: [{ ...(fixture.sessions[0] as SessionSummary), model: evil }],
  }, en);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'));
  assert.ok(!html.includes('data-request-id="<'), 'an id in an attribute is escaped too');
});

test('the policy refusal and the answered requests read as sentences', () => {
  const model = modelOf([
    ...tool('t1', 'Bash', { kind: 'execute', command: 'git push origin main' }, { kind: 'execute', output: '', cut: 0, isError: true }),
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r0', decision: 'reject_once', by: 'policy', rule: 'push.base' } },
    ...tool('t2', 'Bash', { kind: 'execute', command: 'touch a' }),
    { type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId: 'r2', toolCallId: 't2', tool: 'Bash', input: { kind: 'execute', command: 'touch a' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule allows this request' } } },
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r2', decision: 'allow_once', by: 'demo-id' } },
    ...tool('t3', 'Bash', { kind: 'execute', command: 'touch b' }),
    { type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId: 'r3', toolCallId: 't3', tool: 'Bash', input: { kind: 'execute', command: 'touch b' }, suggestion: { decision: 'ask', rule: 'default', reason: 'x' } } },
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r3', decision: 'reject_once', by: 'someone-else' } },
    ...tool('t4', 'Bash', { kind: 'execute', command: 'touch c' }),
    { type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId: 'r4', toolCallId: 't4', tool: 'Bash', input: { kind: 'execute', command: 'touch c' }, suggestion: { decision: 'ask', rule: 'default', reason: 'x' } } },
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r4', decision: 'cancelled', by: 'policy', rule: 'interrupt' } },
  ]);
  const html = renderSession(on(model), en);
  const text = visibleText(html);
  assert.ok(text.includes('The agent tried to push to the base branch. Cleared never lets a session do that: it publishes the branch itself, after the review.'), 'the policy refusal, explained in one human sentence');
  assert.ok(text.includes('Allowed once by you'));
  assert.ok(text.includes('Denied by a teammate'));
  assert.ok(text.includes('Cancelled when the turn was interrupted'));
  assert.equal(count(html, /data-answer=/g), 0, 'no button for an answered request');
  const unknown = renderSession(on(modelOf([{ type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r9', decision: 'reject_once', by: 'policy', rule: 'future.rule' } }])), en);
  assert.ok(visibleText(unknown).includes("Cleared's rules stopped this action (future.rule); the agent has to find another way."), 'a rule the catalog does not know is named as it is');
});

test('Author and Reviewer filter the ticket\'s thread, never links to another page (lane 36)', () => {
  const view = viewOf();
  const reviewer: SessionSummary = { ...view.summary, id: 'fixture-reviewer', role: 'reviewer', model: 'claude-sonnet-5-5', phase: 'reviewing', status: 'Reading the diff' };
  const both = renderSession({ ...view, siblings: [view.summary, reviewer] }, en);
  assert.doesNotMatch(both, /<a[^>]*href="\/sessions\//, 'no link to a session');
  const pressed = [...both.matchAll(/<button[^>]*data-filter="([a-z]+)"[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(pressed, [['all', 'true', 'Whole ticket'], ['author', 'false', 'Author · Opus'], ['reviewer', 'false', 'Reviewer · Sonnet']]);
  const filtered = renderSession({ ...view, siblings: [view.summary, reviewer], filter: 'reviewer' }, en);
  assert.match(filtered, /data-filter="reviewer" aria-pressed="true"/);
  assert.equal(count(filtered, /data-row="/g), 0, 'the reviewer has no row yet: the author\'s are filtered out');
  const asReviewer = renderSession({ ...view, summary: reviewer, siblings: [view.summary, reviewer] }, en);
  assert.match(asReviewer, /placeholder="Message the reviewer…"/);
  assert.doesNotMatch(renderSession(view, en), /data-filter=/, 'one session: nothing to filter yet');
});

test('a ticket that did not load still shows the session, and one with no checklist says so', () => {
  const bare = renderSession(viewOf({ ticket: undefined }), en);
  assert.ok(visibleText(bare).includes('LOCAL-161'));
  const fixture = sessionFixture(FIXTURE_NOW);
  const none = renderSession(viewOf({ ticket: { ...fixture.ticket, body: 'Only a description.' } }), en);
  // A card with nothing to say is not drawn (lane 34's art director): no "Done when" without criteria.
  assert.ok(!visibleText(none).includes('Done when'));
  assert.ok(!visibleText(none).includes('The ticket lists no criteria.'));
  assert.ok(visibleText(none).includes('Only a description.'));
});

test('the sessions index lists one row per session, named by its ticket\'s title, and says when there are none', () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const html = renderIndex({ sessions: fixture.sessions, tickets: [fixture.ticket], now: FIXTURE_NOW }, en);
  const text = visibleText(html);
  assert.ok(text.includes(TICKET_TITLE) && text.includes('Paused, waiting for you'));
  // A row, as the tower's (lane 38, the art director of lane 36): the row is the link, with no "Open session" beside it.
  assert.ok(!text.includes('Open session'));
  const row = /<li class="session-card" data-phase="[a-z_]+"><a class="open index-row" href="\/sessions\/fixture-author" data-row="true" aria-labelledby="([^"]+)"[^>]*>/.exec(html);
  assert.ok(row, 'the row is the link');
  assert.match(html, new RegExp(`<span class="session-title" id="${row[1]}">${TICKET_TITLE}</span>`));
  assert.match(html, /<span class="id">LOCAL-161<\/span>/, 'the ticket\'s number, which the proof scripts read');
  // The top bar names the screen: its heading is read out, not drawn twice (lane 38's art director, item 6).
  assert.match(html, /<h1 class="sr-only">Sessions<\/h1>/);
  const empty = renderIndex({ sessions: [], tickets: [], now: FIXTURE_NOW }, en);
  assert.deepEqual(visibleText(empty).filter((line) => line !== 'Sessions'), ['No session yet.', 'One starts when a ticket moves to Todo.', 'New ticket']);
  assert.match(empty, /<div class="empty-state block">/);
  assert.equal(USER.length > 0, true);
});

test('a request whose answer is on its way keeps its buttons disabled across redraws', () => {
  const free = renderSession(viewOf(), en);
  assert.doesNotMatch(free, /data-answer="[a-z_]+"[^>]*disabled/);
  const busy = renderSession(viewOf({ busy: new Set(['request-161']) }), en);
  assert.equal(count(busy, /data-answer="[a-z_]+" disabled/g), 3);
  const other = renderSession(viewOf({ busy: new Set(['some-other-request']) }), en);
  assert.doesNotMatch(other, /data-answer="[a-z_]+"[^>]*disabled/);
});

test('an ended session shows its duration up to its last event, not the stale summary', () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  // the summary was loaded long before the end: updatedAt is 09:24
  const summary = { ...(fixture.sessions[0] as SessionSummary), phase: 'done' as const, startedAt: new Date(2026, 9, 21, 8, 50, 0).toISOString(), updatedAt: new Date(2026, 9, 21, 9, 24, 0).toISOString() };
  // the last event is stored at 09:00:01 local
  const model = modelOf([{ type: 'STATE_SNAPSHOT', snapshot: { status: 'Done', phase: 'done', steps: [], files: [], checks: [], usage: {} } }]);
  const text = visibleText(renderSession(on(model, { summary }), en));
  assert.ok(text.includes('10\u00a0min'), 'from 08:50 to the last event, 10\u00a0min');
});

// Lane 37: the thread's request says what the inbox says, from lib/request.ts.
test('a waiting request asks its question with who asks, says why in the person\'s words, and folds its command, kept whole in data-command', () => {
  const html = renderSession(viewOf(), en);
  assert.match(html, /<p class="request-title">Allow the author to install date-fns\?<\/p>/);
  assert.match(html, /data-command="npm install date-fns"/);
  assert.match(html, /<details class="request-fold"><summary>/, 'a plain install stays folded');
  const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
  assert.ok(visibleText(renderSession(viewOf(), fr)).includes('Autoriser l\'auteur à installer date-fns ?'));
});

// The review channel (issue 291): the reviewer's request and the author's
// answer, each a row that says its side and its round, the answer how long
// the request waited, in a duration of lib/time.ts; the text opens below.
test('the review channel\'s messages read in English and in French, the wait as a duration, the text in the row\'s detail', () => {
  const model = emptyModel();
  const at = (minute: number) => new Date(2026, 9, 21, 9, minute).toISOString();
  const channel = (seq: number, minute: number, from: 'reviewer' | 'author', text: string) =>
    ({ seq, at: at(minute), sessionId: AUTHOR_ID, ticket: 'LOCAL-161', project: 'guestbook', event: { type: 'CUSTOM' as const, name: 'cleared.review_channel' as const, value: { round: 2, limit: 3, from, text } } });
  applyAll(model, [channel(1, 0, 'reviewer', 'Defects: src/entries.ts:3 sorts the wrong way'), channel(2, 72, 'author', 'Sorted newest first.')]);
  // The author's filter: its own answer is hidden from the whole ticket, which shows it on the reviewer's side.
  const html = renderSession(on(model, { filter: 'author' }), en);
  assert.equal(count(html, /data-row="channel"/g), 2);
  assert.equal(count(renderSession(on(model), en), /data-row="channel"/g), 1);
  const text = visibleText(html);
  for (const expected of ['Reviewer to author: changes asked, round 2 of 3', 'Author to reviewer: answer, round 2 of 3', 'answered in 1h 12m', 'Defects: src/entries.ts:3 sorts the wrong way', 'Sorted newest first.'])
    assert.ok(text.some((line) => line.includes(expected)), `missing: ${expected}`);
  const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
  const french = visibleText(renderSession(on(model, { filter: 'author' }), fr));
  for (const expected of ['Du relecteur à l\'auteur : changements demandés, tour 2 sur 3', 'De l\'auteur au relecteur : réponse, tour 2 sur 3', 'répondu en 1 h 12'])
    assert.ok(french.some((line) => line.includes(expected)), `manque : ${expected}`);
});

test('a container lost then recreated reads in English and in French, from the catalog, never the service\'s English (issue #453)', () => {
  const model = emptyModel();
  const at = new Date(2026, 9, 21, 9, 5).toISOString();
  const event = (seq: number, value: Parameters<typeof applyAll>[1][number]['event']) => ({ seq, at, sessionId: AUTHOR_ID, ticket: 'LOCAL-161', project: 'guestbook', event: value });
  applyAll(model, [
    event(1, { type: 'RUN_ERROR', message: 'the session\'s container stopped (exit code 137)', code: 'container_lost' }),
    event(2, { type: 'CUSTOM', name: 'cleared.container_recreated', value: { attempt: 1, limit: 3, waitedMs: 5000 } }),
    event(3, { type: 'RUN_ERROR', message: 'The session\'s container stopped 4 times: it was not recreated again.', code: 'container_failed' }),
  ]);
  const html = renderSession(on(model), en);
  assert.equal(count(html, /data-row="recreated"/g), 1);
  const text = visibleText(html);
  for (const expected of [
    'The session\'s container stopped.',
    'Container recreated on the same checkout after 5s, attempt 1 of 3: the session carries on, its uncommitted work kept.',
    'The session\'s container could not be kept running: the session stopped, and its ticket is back in Todo.',
  ]) assert.ok(text.some((line) => line.includes(expected)), `missing: ${expected}`);
  assert.ok(!text.some((line) => line.includes('exit code 137')), 'the service\'s own words are not shown');
  const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
  const french = visibleText(renderSession(on(model), fr));
  for (const expected of [
    'Le conteneur de la session s\'est arrêté.',
    'Conteneur recréé sur la même copie de travail après 5\u00a0s, tentative 1 sur 3\u00a0: la session continue, son travail non commité conservé.',
    'Le conteneur de la session n\'a pas pu rester en marche\u00a0: la session s\'est arrêtée, et son ticket est revenu en Todo.',
  ]) assert.ok(french.some((line) => line.includes(expected)), `manque : ${expected}`);
});
