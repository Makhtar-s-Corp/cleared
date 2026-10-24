// The session screen's four tabs as HTML (decision 30, lane 20): the tab
// strip and its ARIA, the Plan tab's plan with Go and Change, the Terminal
// tab's take over with the command, the Editor tab's read-only diff, the
// Browser tab's sandboxed frame, in both languages, with no inline style.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionFile, SessionPlan, SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, FIXTURE_FILES, PREVIEW_KEY, SESSION_PLAN, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { applyAll, emptyModel, parseCriteria, threadOf, type SessionView } from '../../screens/session/model.ts';
import { BrowserTab, EditorTab, PlanTab, TabStrip, TakeoverButton, TakeoverNotice } from '../../screens/session/Tabs.tsx';
import { LeftCards, StatusHead } from '../../screens/session/Session.tsx';
import { browserView } from '../../screens/session/tabs.ts';
import { html, strings, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
const sentinel: Translate = (key) => `«${key}»`;

function viewOf(overrides: Partial<SessionView> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...overrides };
}

const file = (path: string, text: string): SessionFile => ({ path, text, lines: text.split('\n').length - 1, cut: false, hash: 'h' });

test('the tab strip: four tabs, one selected, each naming its panel; Take over, in the thread\'s header, on a free session', () => {
  const markup = html(<><TabStrip tab="terminal" t={en} /><TakeoverButton t={en} takeover={{ kind: 'free', can: true }} /></>);
  const tabs = [...markup.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 4);
  assert.deepEqual(tabs.map((tab) => /aria-selected="(true|false)"/.exec(tab)?.[1]), ['false', 'true', 'false', 'false']);
  assert.deepEqual(tabs.map((tab) => /aria-controls="([^"]+)"/.exec(tab)?.[1]), ['tab-plan', 'tab-terminal', 'tab-editor', 'tab-browser']);
  assert.deepEqual(tabs.map((tab) => /tabindex="(-?\d)"/.exec(tab)?.[1]), ['-1', '0', '-1', '-1'], 'one tab in the page\'s order');
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /<button[^>]*id="takeover"/);
  for (const word of ['Plan', 'Terminal', 'Editor', 'Browser', 'Take over']) assert.ok(visibleText(markup).includes(word), word);
  assert.equal(html(<TakeoverButton t={en} takeover={{ kind: 'free', can: false }} />), '', 'no Take over for a lead\'s or an ended session');
  assert.equal(html(<TakeoverButton t={en} takeover={{ kind: 'other', at: FIXTURE_NOW.toISOString() }} />), '', 'nothing to give back of a teammate\'s');
  const mine = html(<TakeoverButton t={en} takeover={{ kind: 'mine', at: FIXTURE_NOW.toISOString() }} />);
  assert.match(mine, /<button[^>]*id="giveback"/);
  assert.match(mine, /title="Hands the session back and tells it what you changed\."/, 'Give back says it tells the session what changed');
  assert.doesNotMatch(mine, /id="takeover"/);
});

test('the Plan tab: the confidence, the reason, the steps and the files; Go and Change while the plan waits', () => {
  const waiting: SessionPlan = { ...SESSION_PLAN, go: null };
  const markup = html(<PlanTab view={viewOf()} plan={waiting} t={en} />);
  const text = visibleText(markup);
  for (const expected of ['Session plan', 'High confidence', SESSION_PLAN.reason, ...SESSION_PLAN.steps, ...SESSION_PLAN.files, 'Waiting for your Go', 'Go', 'Change', 'Done when'])
    assert.ok(text.includes(expected), `missing: ${expected}`);
  assert.match(markup, /<button[^>]*data-act="plan_go"/);
  assert.match(markup, /<button[^>]*data-act="plan_change"/);
  assert.match(markup, /class="confidence high"/);

  const given = html(<PlanTab view={viewOf()} plan={SESSION_PLAN} t={en} />);
  assert.doesNotMatch(given, /data-act="plan_go"/, 'no Go once given');
  assert.ok(visibleText(given).some((line) => line.startsWith('Go given by you at')));

  const changing = html(<PlanTab view={viewOf()} plan={waiting} t={en} changing />);
  assert.match(changing, /<textarea[^>]*id="plan-change"[^>]*maxlength="2000"/);
  assert.match(changing, /<button[^>]*data-act="plan_change_send"/);

  const none = visibleText(html(<PlanTab view={viewOf()} plan={null} t={en} />));
  assert.ok(none.includes('No session plan yet.'));
});

test('the left card says the plan in short, and the ticket names the service the session works on', () => {
  const left = visibleText(html(<LeftCards view={viewOf({ summary: { ...(viewOf().summary), service: 'filter-api' } })} t={en} />));
  assert.ok(left.includes('High confidence'));
  assert.ok(left.includes(`${SESSION_PLAN.steps.length} steps`));
  assert.ok(left.includes('on filter-api'));
  assert.ok(!visibleText(html(<LeftCards view={viewOf()} t={en} />)).includes('on filter-api'));
});

test('a session taken over by you: the status says so, and the Terminal tab gives no command to run on the server', () => {
  const at = FIXTURE_NOW.toISOString();
  const view = viewOf({ summary: { ...(viewOf().summary), takenOver: { by: USER, at } } });
  assert.ok(visibleText(html(<StatusHead view={view} t={en} />)).includes('Taken over by you'));
  const notice = html(<TakeoverNotice view={view} t={en} />);
  const text = visibleText(notice);
  assert.ok(!text.some((line) => /docker exec|on the server|claude --resume/.test(line)));
  // One line (lane 36): who took it over and when, and what Give back does.
  assert.deepEqual(text, ['Taken over at 09:41.', 'Give back tells the session what you changed.']);
  assert.equal([...notice.matchAll(/<p /g)].length, 1);
  assert.doesNotMatch(notice, /id="resume-command"/);
  assert.equal(html(<TakeoverNotice view={viewOf()} t={en} />), '', 'nothing when nobody took it over');
});

test('the Editor tab: the changed files, a file\'s diff against the base, read only; the file alone on request', () => {
  const view = viewOf();
  const files = view.thread.state?.files ?? [];
  const path = 'src/engine/upcoming.mjs';
  const versions = FIXTURE_FILES[path];
  assert.ok(versions);
  const shown = { file: file(path, versions.current), base: versions.base === null ? null : file(path, versions.base) };
  const markup = html(<EditorTab t={en} files={files} selected={path} shown={shown} mode="diff" />);
  assert.equal([...markup.matchAll(/<button[^>]*data-file="/g)].length, files.length);
  assert.match(markup, new RegExp(`<button[^>]*data-file="${path}"[^>]*aria-current="true"|<button[^>]*aria-current="true"[^>]*data-file="${path}"`));
  assert.equal([...markup.matchAll(/<tr class="line add"/g)].length, 24);
  assert.equal([...markup.matchAll(/<tr class="line del"/g)].length, 6);
  assert.ok(visibleText(markup).includes('Read only'));
  assert.doesNotMatch(markup, /contenteditable|<textarea/);

  const whole = html(<EditorTab t={en} files={files} selected={path} shown={shown} mode="file" />);
  assert.equal([...whole.matchAll(/<tr class="line(?: [a-z]+)?"/g)].length, versions.current.split('\n').length - 1);
  assert.doesNotMatch(whole, /class="line del"/);

  const cut = html(<EditorTab t={en} files={files} selected={path} shown={{ file: { ...shown.file, cut: true, lines: 1000 }, base: shown.base }} mode="file" />);
  assert.ok(visibleText(cut).some((line) => line.includes('first 400 of its 1,000 lines')));
  const refused = visibleText(html(<EditorTab t={en} files={files} selected={path} shown={{ file: null, base: null, error: 'secrets, keys and credential files are never read in a session' }} mode="diff" />));
  assert.ok(refused.some((line) => line.includes('secrets, keys and credential files')));
  assert.ok(visibleText(html(<EditorTab t={en} files={[]} mode="diff" />)).includes('No file changed yet.'));
});

test('the Browser tab: a sandboxed frame of the preview, never same-origin; else milestone 1\'s screen or why not', () => {
  const frame = html(<BrowserTab view={browserView({ id: AUTHOR_ID, previewKey: PREVIEW_KEY, previewOrigin: 'http://127.0.0.1:8794', pageHost: '127.0.0.1' })} t={en} />);
  assert.match(frame, /<iframe[^>]*sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(frame, /allow-same-origin|allow-top-navigation|allow-popups/);
  assert.match(frame, /referrerpolicy="no-referrer"/);
  assert.match(frame, new RegExp(`src="http://127\\.0\\.0\\.1:8794/preview/${AUTHOR_ID}/${PREVIEW_KEY}/"`));
  assert.ok(visibleText(html(<BrowserTab view={{ kind: 'none' }} t={en} />)).includes(en('screen_empty')));
  assert.ok(visibleText(html(<BrowserTab view={{ kind: 'here_only' }} t={en} />)).includes(en('browser_here_only')));
});

test('the tabs\' words come from the catalog, French included, and nothing is styled inline', () => {
  const view = viewOf();
  const waiting: SessionPlan = { ...SESSION_PLAN, go: null };
  const parts = (t: Translate) => [
    html(<TabStrip tab="plan" t={t} />),
    html(<TakeoverButton t={t} takeover={{ kind: 'free', can: true }} />),
    html(<PlanTab view={view} plan={waiting} t={t} />),
    html(<TakeoverNotice view={viewOf({ summary: { ...view.summary, takenOver: { by: USER, at: FIXTURE_NOW.toISOString() } } })} t={t} />),
    html(<EditorTab t={t} files={view.thread.state?.files ?? []} mode="diff" />),
    html(<BrowserTab view={{ kind: 'here_only' }} t={t} />),
  ];
  const allowed = strings([SESSION_PLAN, view.thread.state?.files, AUTHOR_ID, parseCriteria(view.ticket?.body ?? '').criteria.map((c) => c.text)]);
  for (const markup of parts(sentinel)) {
    assert.doesNotMatch(markup, / style="/);
    for (const text of visibleText(markup)) assert.ok(/^«[a-z_]+»/.test(text) || allowed.has(text) || /^[+−]\d+$/.test(text), `not from the catalog: ${text}`);
  }
  const french = parts(fr).flatMap(visibleText).join('\n');
  for (const word of ['Plan', 'Terminal', 'Éditeur', 'Navigateur', 'Prendre la main']) assert.ok(french.includes(word), word);
});
