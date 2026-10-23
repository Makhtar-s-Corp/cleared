// The web terminal and the editable editor as HTML (decisions 32 and 33,
// lane 32): each state of the terminal's frame (opening, open, closed and
// why, with Open again), what runs in it (the session's harness first,
// Shell its second choice: owner request of 2026-10-22 17:26), why when
// the web terminal is not offered, with no command to run on the server, and each state of the editor (read only and why, clean, changed,
// saving, saved, conflict with Reload, refused with the rule's reason,
// confirmation); in both languages, with no inline style. The packages
// themselves mount in the browser only (terminal-browser.test.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SessionFile, SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, FIXTURE_FILES, USER, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { TerminalFrame } from '../../components/terminal/Terminal.tsx';
import { EditorFrame } from '../../components/editor/Editor.tsx';
import { editorReducer, editorStart, saveOutcome, type EditorState } from '../../components/editor/model.ts';
import { applyAll, emptyModel, threadOf, type SessionView } from '../../screens/session/model.ts';
import { EditorTab, TakeoverNotice } from '../../screens/session/Tabs.tsx';
import { html, strings, visibleText } from '../render.tsx';

const en = translator(loadCatalog('session', 'en'));
const fr = translator(loadCatalog('session', 'fr'));
const sentinel: Translate = (key) => `«${key}»`;
const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const AT = FIXTURE_NOW.toISOString();

function viewOf(overrides: Partial<SessionView> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: USER, language: 'en', now: FIXTURE_NOW, ...overrides };
}

const ENGINE = 'src/engine/upcoming.mjs';
const engineText = FIXTURE_FILES[ENGINE]?.current as string;
const engineFile: SessionFile = { path: ENGINE, text: engineText, lines: engineText.split('\n').length - 1, cut: false, hash: hex(engineText) };

const noInlineStyle = (markup: string) => assert.doesNotMatch(markup, /\sstyle=|<style/, 'no inline style');

test('the terminal\'s frame: opening, open with its size, and the host the terminal mounts in', () => {
  const opening = html(<TerminalFrame t={en} status={{ kind: 'opening' }} mode="shell" harness="Claude Code" />);
  assert.match(opening, /data-terminal-state="opening"/);
  assert.ok(visibleText(opening).includes('Opening a shell in the session\'s container…'));
  const resuming = html(<TerminalFrame t={en} status={{ kind: 'opening' }} mode="harness" harness="Claude Code" />);
  assert.ok(visibleText(resuming).includes('Resuming Claude Code on this session…'));
  assert.match(opening, /<div[^>]*class="term-host"[^>]*>/);
  assert.match(opening, /aria-label="Terminal in the session&#39;s container"/);
  const open = html(<TerminalFrame t={en} status={{ kind: 'open', cols: 100, rows: 30 }} />);
  assert.match(open, /data-terminal-state="open"/);
  assert.ok(visibleText(open).some((line) => line.includes('100 × 30')), 'the size the shell has');
  assert.doesNotMatch(open, /data-act="terminal_open"/, 'no Open again while open');
  for (const markup of [opening, open]) noInlineStyle(markup);
});

test('the terminal\'s frame, closed: the reason, and Open again except after Give back', () => {
  for (const reason of ['idle', 'exit', 'closed', 'lost', 'refused'] as const) {
    const markup = html(<TerminalFrame t={en} status={{ kind: 'closed', reason }} />);
    assert.match(markup, new RegExp(`data-terminal-state="closed"[^>]*data-reason="${reason}"|data-reason="${reason}"[^>]*data-terminal-state="closed"`));
    assert.match(markup, /<button[^>]*data-act="terminal_open"/, `${reason}: Open again`);
    assert.match(markup, /role="status"/);
  }
  const idle = html(<TerminalFrame t={en} status={{ kind: 'closed', reason: 'idle' }} />);
  assert.ok(visibleText(idle).some((line) => /15 minutes/.test(line)));
  const refused = html(<TerminalFrame t={en} status={{ kind: 'closed', reason: 'refused', detail: 'the web terminal opens on this machine\'s browser only' }} />);
  assert.ok(visibleText(refused).some((line) => line.includes('the web terminal opens on this machine\'s browser only')), 'the service\'s reason');
  const given = html(<TerminalFrame t={en} status={{ kind: 'closed', reason: 'give_back' }} />);
  assert.doesNotMatch(given, /data-act="terminal_open"/, 'given back: nothing to open');
});

test('the terminal\'s frame names what runs: the harness first with Shell beside it, the shell with the way back', () => {
  const harness = html(<TerminalFrame t={en} status={{ kind: 'open', cols: 100, rows: 30 }} mode="harness" harness="Claude Code" />);
  assert.match(harness, /data-mode="harness"/);
  assert.ok(visibleText(harness).includes('Claude Code, resumed on this session'));
  assert.match(harness, /<button[^>]*data-act="terminal_shell"[^>]*>Shell<\/button>/, 'Shell, the second choice');
  assert.doesNotMatch(harness, /data-act="terminal_harness"/);
  const shell = html(<TerminalFrame t={en} status={{ kind: 'open', cols: 100, rows: 30 }} mode="shell" harness="Claude Code" />);
  assert.match(shell, /data-mode="shell"/);
  assert.ok(visibleText(shell).includes('Shell in the session\'s container'));
  assert.match(shell, /<button[^>]*data-act="terminal_harness"[^>]*>Back to Claude Code<\/button>/);
  // A harness the adapter cannot resume: its reason, and the Shell; nothing to open again.
  const unsupported = html(<TerminalFrame t={en} status={{ kind: 'closed', reason: 'unsupported', detail: 'The codex harness cannot be resumed in a terminal yet: open the Shell instead.' }} mode="harness" harness="Codex" />);
  const said = visibleText(unsupported);
  assert.ok(said.includes('Codex cannot be resumed here'), 'the header says it, not "resumed on this session"');
  assert.ok(!said.some((line) => line.includes('resumed on this session')));
  assert.equal(said.filter((line) => /cannot be resumed/.test(line)).length, 2, 'the header, then the adapter\'s reason once');
  assert.ok(said.includes('The codex harness cannot be resumed in a terminal yet: open the Shell instead.'));
  assert.match(unsupported, /data-act="terminal_shell"/);
  assert.doesNotMatch(unsupported, /data-act="terminal_open"/);
  // Given back: nothing to switch to.
  assert.doesNotMatch(html(<TerminalFrame t={en} status={{ kind: 'closed', reason: 'give_back' }} mode="harness" harness="Claude Code" />), /data-act="terminal_(shell|harness)"/);
  for (const markup of [harness, shell, unsupported]) {
    noInlineStyle(markup);
    assert.doesNotMatch(markup, /docker exec|on the server/);
  }
});

test('the Terminal tab without the web terminal: why, and no command to run on the server', () => {
  const view = viewOf({ takenOver: { by: USER, at: AT } });
  const here = html(<TakeoverNotice view={view} t={en} why="here_only" />);
  assert.doesNotMatch(here, /id="resume-command"|docker exec|on the server|<pre/);
  assert.ok(visibleText(here).some((line) => /this machine/.test(line)), 'why: the web terminal opens on the loopback address only');
  const plain = html(<TakeoverNotice view={view} t={en} />);
  assert.ok(!visibleText(plain).some((line) => /this machine/.test(line)), 'no why when the web terminal is there');
  const other = html(<TakeoverNotice view={viewOf({ takenOver: { by: 'someone-else', at: AT } })} t={en} why="other" />);
  assert.ok(visibleText(other).some((line) => /teammate/.test(line)));
  const web = html(<TakeoverNotice view={view} t={en} web />);
  assert.doesNotMatch(web, /id="resume-command"|docker exec|on the server|<pre/, 'beside the web terminal, no command either');
  assert.deepEqual(visibleText(web), ['Since 09:41.', 'Give back tells the session what you changed.'], 'one line beside the terminal (lane 36)');
});

function states(): Record<string, EditorState> {
  const start = editorStart(engineFile);
  const changed = editorReducer(start, { kind: 'edit', text: `${engineText}// one more line\n` });
  return {
    clean: start,
    changed,
    saving: editorReducer(changed, { kind: 'save' }),
    saved: editorReducer(editorReducer(changed, { kind: 'save' }), { kind: 'saved', hash: 'h2', at: '2026-10-22T09:41:00.000Z' }),
    conflict: editorReducer(changed, saveOutcome(409, { error: 'stale', rule: null, reason: 'the file changed since the editor loaded it: reload it', hash: 'h3', confirmable: false })),
    refused: editorReducer(changed, saveOutcome(403, { error: 'x', rule: 'default', reason: 'nothing allows this edit without asking', confirmable: false })),
    confirm: editorReducer(changed, saveOutcome(403, { error: 'x', rule: 'scripts.change', reason: 'a change of the scripts asks first', confirmable: true })),
    failed: editorReducer(changed, { kind: 'failed' }),
  };
}

test('the editor\'s frame in each state: its sentence and its buttons', () => {
  const all = states();
  const markup = (name: string) => html(<EditorFrame t={en} state={all[name] as EditorState} taken={false} stale={false} />);
  for (const name of Object.keys(all)) {
    const one = markup(name);
    assert.match(one, new RegExp(`data-editor-state="${name}"`), name);
    assert.match(one, /<div[^>]*class="cm-host"/, `${name}: the host CodeMirror mounts in`);
    noInlineStyle(one);
  }
  assert.match(markup('clean'), /<button[^>]*data-act="editor_save"[^>]*disabled/, 'nothing to save');
  assert.doesNotMatch(markup('changed'), /<button[^>]*data-act="editor_save"[^>]*disabled/);
  assert.match(markup('saving'), /<button[^>]*data-act="editor_save"[^>]*disabled/);
  assert.ok(visibleText(markup('saved')).some((line) => /Saved at/.test(line)));
  const conflict = markup('conflict');
  assert.match(conflict, /<button[^>]*data-act="editor_reload"/);
  assert.ok(visibleText(conflict).some((line) => /changed since you opened it/.test(line)));
  const refused = markup('refused');
  assert.ok(visibleText(refused).some((line) => line.includes('nothing allows this edit without asking') && line.includes('default')), 'the rule and its reason');
  assert.doesNotMatch(refused, /data-act="editor_confirm"/);
  const confirm = markup('confirm');
  assert.match(confirm, /<button[^>]*data-act="editor_confirm"/);
  assert.ok(visibleText(confirm).some((line) => line.includes('a change of the scripts asks first')));
  assert.ok(visibleText(confirm).some((line) => line.includes('scripts.change')));
  assert.ok(visibleText(markup('failed')).some((line) => /not saved/i.test(line)));
  // The session's own change to the file while it is open.
  const stale = html(<EditorFrame t={en} state={all.changed as EditorState} taken={false} stale />);
  assert.ok(visibleText(stale).some((line) => /session changed this file/.test(line)));
  assert.match(stale, /data-act="editor_reload"/);
});

test('the Editor tab: Edit on an open session\'s file, the reason when it stays read only, and the editor once editing', () => {
  const files = [{ path: ENGINE, added: 24, removed: 6 }];
  const shown = { file: engineFile, base: engineFile };
  const can = html(<EditorTab t={en} files={files} selected={ENGINE} shown={shown} mode="file" edit={{ can: true }} />);
  assert.match(can, /<button[^>]*data-act="editor_edit"/);
  assert.doesNotMatch(can, /class="read-only"/);
  for (const [why, words] of [['cut', /400 lines/], ['cleaned', /hidden/], ['unchecked', /checked/], ['session', /Read only/]] as const) {
    const markup = html(<EditorTab t={en} files={files} selected={ENGINE} shown={shown} mode="file" edit={{ can: false, why }} />);
    assert.doesNotMatch(markup, /data-act="editor_edit"/, why);
    assert.ok(visibleText(markup).some((line) => words.test(line)), `${why}: ${visibleText(markup).join(' | ')}`);
  }
  const editing = html(<EditorTab t={en} files={files} selected={ENGINE} shown={shown} mode="file" edit={{ can: true, state: states().changed as EditorState }} />);
  assert.match(editing, /data-editor-state="changed"/);
  assert.doesNotMatch(editing, /<table class="code"/, 'the editor in place of the viewer');
  assert.match(editing, /<button[^>]*data-file="[^"]*"[^>]*disabled/, 'another file waits until this one is saved or put back');
  noInlineStyle(editing);
});

test('every string comes from the catalog, and the French one is complete', () => {
  const all = states();
  const markups = [
    html(<TerminalFrame t={sentinel} status={{ kind: 'opening' }} mode="harness" harness="Claude Code" />),
    html(<TerminalFrame t={sentinel} status={{ kind: 'open', cols: 80, rows: 24 }} mode="harness" harness="Claude Code" />),
    html(<TerminalFrame t={sentinel} status={{ kind: 'open', cols: 80, rows: 24 }} mode="shell" harness="Claude Code" />),
    html(<TerminalFrame t={sentinel} status={{ kind: 'closed', reason: 'idle' }} mode="harness" harness="Claude Code" />),
    ...Object.values(all).map((state) => html(<EditorFrame t={sentinel} state={state} taken stale />)),
  ];
  for (const markup of markups) for (const line of visibleText(markup)) assert.match(line, /«[a-z_]+»/, `a string written in the component: ${line}`);
  assert.ok(strings(loadCatalog('session', 'fr')).size >= strings(loadCatalog('session', 'en')).size);
  for (const state of Object.values(all)) {
    const markup = html(<EditorFrame t={fr} state={state} taken={false} stale={false} />);
    for (const line of visibleText(markup)) assert.ok(!/\b(Save|Saved|Reload|the file)\b/.test(line), `French: ${line}`);
  }
  for (const reason of ['idle', 'give_back', 'exit', 'closed', 'lost', 'refused', 'unsupported'] as const) {
    const markup = html(<TerminalFrame t={fr} status={{ kind: 'closed', reason }} mode="harness" harness="Claude Code" />);
    assert.ok(!visibleText(markup).some((line) => /\b(the|terminal was)\b/.test(line)), reason);
  }
});
