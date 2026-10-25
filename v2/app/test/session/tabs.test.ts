// The session screen's four tabs (docs/v2/milestone-2-plan.md, decision 30,
// lane 20), as pure functions over the fixture: which tab an address opens,
// the Plan tab's session plan with its confidence and its Go, the Terminal
// tab's take over and the command that resumes the session on the server,
// the Editor tab's diff of a file against the ticket's base, and the Browser
// tab's preview address.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionPlan } from '../../../src/api/types.ts';
import { STEP_NAMES } from '../../../src/session/events.ts';
import { AUTHOR_ID, FIXTURE_FILES, PREVIEW_KEY, SESSION_PLAN, USER, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { applyAll, emptyModel, threadOf } from '../../web/screens/session/model.ts';
import {
  CHANGE_MAX, DEFAULT_TAB, TABS, browserView, changeProblem, cutNote, diffCounts, goLine, lineDiff, nextTab, planView, serviceLine, tabOf, takeoverOf,
} from '../../web/screens/session/tabs.ts';
import * as tabs from '../../web/screens/session/tabs.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

test('the four tabs, Terminal first opened; the address\'s hash names the others, and the arrows move between them', () => {
  assert.deepEqual([...TABS], ['plan', 'terminal', 'editor', 'browser']);
  assert.equal(DEFAULT_TAB, 'terminal');
  assert.equal(tabOf(''), 'terminal');
  assert.equal(tabOf('#plan'), 'plan');
  assert.equal(tabOf('#editor'), 'editor');
  assert.equal(tabOf('#browser'), 'browser');
  assert.equal(tabOf('#nothing'), 'terminal');
  assert.equal(nextTab('plan', 'ArrowLeft'), 'browser');
  assert.equal(nextTab('browser', 'ArrowRight'), 'plan');
  assert.equal(nextTab('editor', 'Home'), 'plan');
  assert.equal(nextTab('plan', 'End'), 'browser');
  for (const tab of TABS) for (const t of [en, fr]) assert.ok(t(`tabs_${tab}`));
});

test('every step the flow names has its words, the plan gate\'s included', () => {
  for (const step of STEP_NAMES) for (const t of [en, fr]) assert.ok(t(`step_${step}`), step);
});

test('the fixture\'s session carries its plan, read from the stream, with the Go the owner gave', () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  const thread = threadOf(model);
  assert.deepEqual(thread.plan, SESSION_PLAN);
  assert.equal(thread.plan?.go?.by, USER);
  // The proposal and the Go are rows of the timeline, the host call is not.
  assert.deepEqual(thread.rows.filter((row) => row.kind === 'plan').map((row) => row.kind === 'plan' && (row.go ? 'go' : 'proposed')), ['proposed', 'go']);
  assert.ok(!thread.rows.some((row) => row.kind === 'tool' && row.name === 'mcp__cleared__propose_session_plan'));
});

test('the Plan tab: the plan, its confidence and reason; Go and Change while it waits, and who gave the Go after', () => {
  const waiting: SessionPlan = { ...SESSION_PLAN, go: null };
  const open = planView(waiting, { ended: false, takenOver: false });
  assert.equal(open.kind, 'plan');
  assert.equal(open.kind === 'plan' && open.waiting, true);
  assert.equal(open.kind === 'plan' && open.canAct, true);
  const paused = planView(waiting, { ended: false, takenOver: true });
  assert.equal(paused.kind === 'plan' && paused.canAct, false, 'no Go while taken over');
  const ended = planView(waiting, { ended: true, takenOver: false });
  assert.equal(ended.kind === 'plan' && ended.canAct, false, 'no Go on an ended session');
  assert.deepEqual(planView(null, { ended: false, takenOver: false }), { kind: 'none' });

  const at = SESSION_PLAN.go?.at as string;
  const time = `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`;
  assert.equal(goLine(SESSION_PLAN, USER, en), `Go given by you at ${time}`);
  assert.equal(goLine(SESSION_PLAN, 'someone-else', en), `Go given by a teammate at ${time}`);
  assert.equal(goLine({ ...SESSION_PLAN, go: { by: 'delay', at } }, USER, en), `Started by itself at ${time}: no answer in time, and its confidence is high`);
  assert.equal(goLine({ ...SESSION_PLAN, go: { by: 'lead', at } }, USER, en), `Go given by the Lead at ${time}, for a plan you approved`);
  assert.equal(goLine(waiting, USER, en), undefined);
  for (const confidence of ['low', 'medium', 'high'] as const) for (const t of [en, fr]) assert.ok(t(`confidence_${confidence}`));

  assert.equal(CHANGE_MAX, 2000);
  assert.equal(changeProblem('   '), 'empty');
  assert.equal(changeProblem('x'.repeat(2001)), 'too_long');
  assert.equal(changeProblem('Test the empty list too.'), undefined);
});

test('the Terminal tab: Take over for the author or the reviewer of a live session; no command to run on the server once taken over', () => {
  // The owner's request of 2026-10-22 17:26: the docker exec command is gone from the screen.
  assert.equal('resumeCommand' in tabs, false);
  assert.equal('containerName' in tabs, false);
  assert.deepEqual(takeoverOf({ takenOver: null, me: USER, role: 'author', ended: false }), { kind: 'free', can: true });
  // The owner's scope extension of 2026-10-22 22:01: a reviewer's session is taken over too; the lead's is not.
  assert.deepEqual(takeoverOf({ takenOver: null, me: USER, role: 'reviewer', ended: false }), { kind: 'free', can: true });
  assert.deepEqual(takeoverOf({ takenOver: null, me: USER, role: 'lead', ended: false }), { kind: 'free', can: false });
  assert.deepEqual(takeoverOf({ takenOver: null, me: USER, role: 'author', ended: true }), { kind: 'free', can: false });
  assert.deepEqual(takeoverOf({ takenOver: { by: USER, at: FIXTURE_NOW.toISOString() }, me: USER, role: 'author', ended: false }), { kind: 'mine', at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(takeoverOf({ takenOver: { by: 'other', at: FIXTURE_NOW.toISOString() }, me: USER, role: 'author', ended: false }), { kind: 'other', at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(takeoverOf({ takenOver: { by: USER, at: FIXTURE_NOW.toISOString() }, me: USER, role: 'author', ended: true }), { kind: 'free', can: false }, 'an ended session is not taken over any more');
});

test('the Editor tab: a line diff of the base and the file, with the counts the Changes card shows', () => {
  const diff = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(diff.map((line) => `${line.kind}:${line.text}`), ['same:a', 'del:b', 'add:B', 'same:c', 'add:d']);
  assert.deepEqual(diff.map((line) => [line.old ?? null, line.new ?? null]), [[1, 1], [2, null], [null, 2], [3, 3], [null, 4]]);
  assert.deepEqual(diffCounts(diff), { added: 2, removed: 1 });
  assert.deepEqual(lineDiff(undefined, 'new\n').map((line) => line.kind), ['add'], 'a new file');
  assert.deepEqual(lineDiff('gone\n', undefined).map((line) => line.kind), ['del'], 'a deleted file');
  assert.deepEqual(lineDiff('', ''), []);

  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  for (const file of model.state?.files ?? []) {
    const versions = FIXTURE_FILES[file.path];
    assert.ok(versions, `the fixture has ${file.path}`);
    assert.deepEqual(diffCounts(lineDiff(versions.base ?? undefined, versions.current)), { added: file.added, removed: file.removed }, file.path);
  }

  assert.equal(cutNote({ path: 'long.txt', text: '', lines: 1000, cut: true, hash: '' }, en), 'Only the first 400 of its 1,000 lines are shown.');
  assert.equal(cutNote({ path: 'short.txt', text: '', lines: 10, cut: false, hash: '' }, en), undefined);
});

test('the Browser tab: the session\'s preview from the listener\'s own origin, sandboxed; else why not', () => {
  const page = { id: AUTHOR_ID, previewKey: PREVIEW_KEY, previewOrigin: 'http://127.0.0.1:8794' };
  assert.deepEqual(browserView({ ...page, pageHost: '127.0.0.1' }), { kind: 'frame', src: `http://127.0.0.1:8794/preview/${AUTHOR_ID}/${PREVIEW_KEY}/` });
  assert.deepEqual(browserView({ ...page, pageHost: 'localhost' }).kind, 'frame');
  assert.deepEqual(browserView({ ...page, pageHost: 'cleared.example.invalid' }), { kind: 'here_only' }, 'a loopback preview from another device');
  assert.deepEqual(browserView({ ...page, previewOrigin: 'https://preview.example.invalid', pageHost: 'cleared.example.invalid' }).kind, 'frame', 'the README\'s proxy');
  assert.deepEqual(browserView({ ...page, previewKey: null, pageHost: '127.0.0.1' }), { kind: 'none' });
  assert.deepEqual(browserView({ ...page, previewOrigin: undefined, pageHost: '127.0.0.1' }), { kind: 'none' });
  assert.equal(browserView({ ...page, id: 'a/b', pageHost: '127.0.0.1' }).kind === 'frame' && (browserView({ ...page, id: 'a/b', pageHost: '127.0.0.1' }) as { src: string }).src.includes('a%2Fb'), true);
});

test('the service line names the service a session works on', () => {
  assert.equal(serviceLine('filter-api', en), 'on filter-api');
  assert.equal(serviceLine(undefined, en), undefined);
  assert.equal(serviceLine('filter-api', fr), 'sur filter-api');
});
