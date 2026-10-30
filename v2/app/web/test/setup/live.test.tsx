// A session seen from the assistant (issues #493 and #495): the alert a session
// waiting for the person raises on every step, in the person's words, and a
// session live with its state, its link and its pull request.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { NextInboxItem, SessionSummary } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { LiveSession, WaitingAlert, WatchContext, askOf, lastActionOf, waitingOf, type Watch } from '../../screens/setup/live.tsx';
import { setupTranslator } from '../../screens/setup/model.ts';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };
const NOW = new Date('2026-10-30T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const permission = {
  kind: 'permission', id: 'permission:s1:r1', ticket: 'LOCAL-1', project: 'demo', since: ago(9), state: 'waiting', sessionId: 's1', requestId: 'r1', tool: 'Bash',
  input: { kind: 'execute', command: 'ls && node x.js' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule' },
} as unknown as NextInboxItem;
const plan = { kind: 'session_plan', id: 'session_plan:s2:1', ticket: 'LOCAL-2', project: 'demo', since: ago(2), state: 'waiting', sessionId: 's2' } as unknown as NextInboxItem;
const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', project: 'demo', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'working', status: 'Reading', startedAt: ago(4), updatedAt: ago(1), lastSeq: 3, ...over,
} as SessionSummary);
const watched = (watch: Partial<Watch>, child: React.ReactNode) => html(<WatchContext.Provider value={{ sessions: [], waiting: [], ...watch }}>{child}</WatchContext.Provider>);

test('what waits for the person, oldest first; what is handled or is the release\'s own step is not an alert', () => {
  const handled = { ...permission, id: 'other', state: 'handled' } as NextInboxItem;
  const release = { ...permission, id: 'release', kind: 'release' } as NextInboxItem;
  assert.deepEqual(waitingOf([plan, handled, release, permission]).map((item) => item.id), [permission.id, plan.id]);
});

test('a session waiting is said on the step: which, for how long, what it asks in the person\'s words, and where to answer', () => {
  each((t, language) => {
    const markup = watched({ waiting: waitingOf([permission]) }, <WaitingAlert t={t} now={NOW} />);
    assert.doesNotMatch(markup, /⟦/, language);
    const text = visibleText(markup).join(' ');
    assert.match(text, /LOCAL-1/);
    assert.match(text, /9\s?min/);
    assert.doesNotMatch(text, /&&|node x\.js/, 'not the raw command');
    assert.match(markup, /href="\/inbox#permission%3As1%3Ar1"/);
    assert.match(markup, /role="status"/);
    const many = visibleText(watched({ waiting: waitingOf([permission, plan]) }, <WaitingAlert t={t} now={NOW} />)).join(' ');
    assert.match(many, /2/);
  });
});

test('nothing waiting: no alert', () => {
  assert.equal(watched({}, <WaitingAlert t={en} now={NOW} />), '');
});

test('what an agent said it does comes first; a plan and a question say so', () => {
  const described = { ...permission, input: { kind: 'execute', command: 'ls', description: 'Look at what the repository needs' } } as NextInboxItem;
  assert.equal(askOf(described, en), 'Look at what the repository needs.');
  assert.equal(askOf(plan, en), en('setup_waiting_plan'));
});

test('a session live: its state in a word, for how long, its link, its pull request; before it exists, that it starts', () => {
  each((t, language) => {
    const markup = watched({ sessions: [session({ phase: 'reviewing' })] }, <LiveSession t={t} ticket="LOCAL-1" pullRequest={{ number: 12, url: 'https://example.org/pull/12' }} now={NOW} />);
    assert.doesNotMatch(markup, /⟦/, language);
    const text = visibleText(markup).join(' ');
    assert.ok(text.includes(t('setup_live_reviewing')));
    assert.match(text, /4\s?min/);
    assert.match(markup, /href="\/sessions\/s1"/);
    assert.match(markup, /href="https:\/\/example\.org\/pull\/12"/);
    assert.match(markup, /aria-live="polite"/);
    const none = watched({}, <LiveSession t={t} ticket="LOCAL-1" now={NOW} />);
    assert.ok(visibleText(none).join(' ').includes(t('setup_live_none')));
    assert.doesNotMatch(none, /href="\/sessions/);
  });
});

test('the newest session of the ticket is the one shown', () => {
  const markup = watched({ sessions: [session({ id: 'old', startedAt: ago(40) }), session({ id: 'new', startedAt: ago(1) })] }, <LiveSession t={en} ticket="LOCAL-1" now={NOW} />);
  assert.match(markup, /href="\/sessions\/new"/);
});

test('the last action reads from the session\'s events', () => {
  const names = new Map<string, string>();
  const stored = (event: unknown) => ({ seq: 1, at: ago(1), sessionId: 's1', ticket: 'LOCAL-1', event }) as never;
  assert.equal(lastActionOf(stored({ type: 'TOOL_CALL_START', toolCallId: 'c', toolCallName: 'Read' }), names, undefined), undefined);
  assert.deepEqual(lastActionOf(stored({ type: 'TOOL_CALL_ARGS', toolCallId: 'c', delta: JSON.stringify({ kind: 'read', path: '/workspace/README.md' }) }), names, undefined), { kind: 'read', path: 'README.md' });
  assert.deepEqual(lastActionOf(stored({ type: 'TOOL_CALL_ARGS', toolCallId: 'c', delta: JSON.stringify({ kind: 'execute', command: 'npm test' }) }), names, undefined), { kind: 'command', command: 'npm test' });
});
