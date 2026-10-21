// The session screen as HTML: the fixture session against the capture, the
// catalog in both languages, the escaping, and the rule that the page has
// no inline style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_ID, ANSWER_TEXT, QUESTION_TEXT, TICKET_BODY, TICKET_TITLE, USER, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../../public/i18n.ts';
import { applyAll, emptyModel, parseCriteria, renderIndex, renderSession, timeline, type SessionView } from '../../public/screens/session.ts';
import type { SessionSummary } from '../../../src/api/types.ts';
import { modelOf, strings, tool, visibleText } from './support.ts';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator(loadCatalog('session', 'en'));

function viewOf(overrides: Partial<SessionView> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return { summary: fixture.sessions[0] as SessionSummary, model, ticket: fixture.ticket, siblings: fixture.sessions, me: 'demo-id', language: 'en', now: FIXTURE_NOW, ...overrides };
}

const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;

test('the English screen reads as the capture, in milestone 1\'s words', () => {
  const text = visibleText(renderSession(viewOf(), en)).join('\n');
  for (const expected of [
    TICKET_TITLE, 'LOCAL-161', 'Done when', 'Entries grouped by week, Monday first', 'Same totals as today, a test proves it', 'Plan of the session',
    'Paused, waiting for you', '18 min · 35,500 tokens',
    'Read', 'src/screens/Upcoming.jsx', 'and 2 more files', 'Edit', 'src/engine/upcoming.mjs', '+24', '−6', 'Run', 'npm run test:upcoming', '18 passed', QUESTION_TEXT, ANSWER_TEXT,
    'Wants to run', 'npm install date-fns', 'Network access and a new dependency.', 'Allow once', 'Always in this project', 'Deny, use what we have',
    'Changes', 'Checks', 'Targeted tests', 'Full suite', 'Screen so far', 'Hand over to Codex', 'Interrupt', 'Send', 'Author · Opus', 'Reviewer, waiting',
  ]) assert.ok(text.includes(expected), `missing: ${expected}`);
});

test('the request has its three buttons, and nothing else on the page answers it', () => {
  const html = renderSession(viewOf(), en);
  assert.deepEqual([...html.matchAll(/data-answer="([a-z_]+)"/g)].map((m) => m[1]), ['allow_once', 'allow_always', 'reject_once']);
  assert.equal(count(html, /data-row="/g), 7, 'seven rows: the read group, two edits, the run, the two messages, the install');
  assert.equal(count(html, /data-row="read"/g), 1);
  assert.equal(count(html, /data-row="edit"/g), 2);
  assert.equal(count(html, /data-row="request"/g), 1);
});

test('the composer has Send and Interrupt, and the hand over is disabled with its note', () => {
  const html = renderSession(viewOf(), en);
  assert.match(html, /<button[^>]*id="send"[^>]*type="submit"|<button[^>]*type="submit"[^>]*id="send"/);
  assert.match(html, /<button[^>]*id="interrupt"/);
  assert.match(html, /<button[^>]*id="handover"[^>]*aria-disabled="true"/);
  assert.ok(visibleText(html).includes('Handing a session over to another harness comes in milestone 3.'));
  assert.match(html, /placeholder="Message the author…"/);
});

test('an ended session cannot be written to or interrupted', () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = modelOf([{ type: 'STATE_SNAPSHOT', snapshot: { status: 'Done', phase: 'done', steps: [], files: [], checks: [], usage: {} } }]);
  const html = renderSession(viewOf({ model, summary: { ...(fixture.sessions[0] as SessionSummary), phase: 'done' } }), en);
  assert.match(html, /<input[^>]*id="message"[^>]*disabled/);
  assert.match(html, /<button[^>]*id="send"[^>]*disabled/);
  assert.match(html, /<button[^>]*id="interrupt"[^>]*disabled/);
  assert.ok(visibleText(html).includes('Done'));
});

test('every word on the screen comes from the catalog or from the data', () => {
  const view = viewOf();
  const rows = timeline(view.model);
  const allowed = strings([view.ticket, view.summary, view.model.state, rows]);
  const parsed = parseCriteria(TICKET_BODY);
  for (const text of [...parsed.description, ...parsed.criteria.map((c) => c.text)]) allowed.add(text);
  for (const row of rows) allowed.add(`${String(new Date(row.at).getHours()).padStart(2, '0')}:${String(new Date(row.at).getMinutes()).padStart(2, '0')}`);
  allowed.add('LOCAL-161');
  const html = renderSession(view, sentinel);
  for (const text of visibleText(html)) {
    const rest = text.replace(/«[a-z0-9_]+»/g, '').trim();
    if (!/\p{L}/u.test(rest)) continue;
    assert.ok(allowed.has(rest), `not from the catalog nor the data: ${JSON.stringify(rest)}`);
  }
  assert.doesNotMatch(html, /\sstyle=/, 'no inline style: the page runs under default-src \'self\'');
  assert.doesNotMatch(html, /<style|<script|https?:\/\//, 'nothing inline, nothing from another site');
});

test('the French screen has no English sentence left', () => {
  const enCatalog = loadCatalog('session', 'en');
  const frCatalog = loadCatalog('session', 'fr');
  const html = renderSession(viewOf(), translator(frCatalog));
  for (const [key, value] of Object.entries(enCatalog)) {
    if (frCatalog[key] === value || value.length < 12 || !/\s/.test(value)) continue;
    const plain = value.replace(/\{[a-z_]+\}/g, '').trim();
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
    ...viewOf(), model, ticket: { ...fixture.ticket, title: evil, body: `${evil}\n\n- [ ] ${evil}` },
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
  const html = renderSession(viewOf({ model }), en);
  const text = visibleText(html);
  assert.ok(text.includes('Blocked by the rules: pushing to the base branch.'), 'the policy refusal, with its rule in words');
  assert.ok(text.includes('Allowed once by you'));
  assert.ok(text.includes('Denied by a teammate'));
  assert.ok(text.includes('Cancelled when the turn was interrupted'));
  assert.equal(count(html, /data-answer=/g), 0, 'no button for an answered request');
  const unknown = renderSession(viewOf({ model: modelOf([{ type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r9', decision: 'reject_once', by: 'policy', rule: 'future.rule' } }]) }), en);
  assert.ok(visibleText(unknown).includes('Blocked by the rules (future.rule).'), 'a rule the catalog does not know is named as it is');
});

test('the tabs switch between the author and the reviewer of the ticket', () => {
  const view = viewOf();
  const reviewer: SessionSummary = { ...view.summary, id: 'fixture-reviewer', role: 'reviewer', model: 'claude-sonnet-5-5', phase: 'reviewing', status: 'Reading the diff' };
  const both = renderSession({ ...view, siblings: [view.summary, reviewer] }, en);
  assert.match(both, /<a[^>]*href="\/sessions\/fixture-author"[^>]*aria-current="page"[^>]*>/);
  assert.match(both, /<a[^>]*href="\/sessions\/fixture-reviewer"[^>]*>/);
  assert.ok(visibleText(both).includes('Reviewer · Sonnet'));
  const asReviewer = renderSession({ ...view, summary: reviewer, siblings: [view.summary, reviewer] }, en);
  assert.match(asReviewer, /<a[^>]*href="\/sessions\/fixture-reviewer"[^>]*aria-current="page"/);
  assert.match(asReviewer, /placeholder="Message the reviewer…"/);
  assert.doesNotMatch(renderSession(view, en), /href="\/sessions\/[^"]*"[^>]*>Reviewer/, 'no reviewer yet: not a link');
});

test('a ticket that did not load still shows the session, and one with no checklist says so', () => {
  const bare = renderSession(viewOf({ ticket: undefined }), en);
  assert.ok(visibleText(bare).includes('LOCAL-161'));
  const fixture = sessionFixture(FIXTURE_NOW);
  const none = renderSession(viewOf({ ticket: { ...fixture.ticket, body: 'Only a description.' } }), en);
  assert.ok(visibleText(none).includes('The ticket lists no criteria.'));
  assert.ok(visibleText(none).includes('Only a description.'));
});

test('the sessions index lists the sessions with their ticket title, and says when there are none', () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const html = renderIndex({ sessions: fixture.sessions, tickets: [fixture.ticket], now: FIXTURE_NOW }, en);
  const text = visibleText(html);
  assert.ok(text.includes(TICKET_TITLE) && text.includes('Paused, waiting for you') && text.includes('Open session'));
  assert.match(html, /href="\/sessions\/fixture-author"/);
  assert.ok(visibleText(renderIndex({ sessions: [], tickets: [], now: FIXTURE_NOW }, en)).includes('No session yet. Move a ticket to Todo and one starts.'));
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
  const text = visibleText(renderSession(viewOf({ model, summary }), en));
  assert.ok(text.includes('10 min'), 'from 08:50 to the last event, 10 min');
});
