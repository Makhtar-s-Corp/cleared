// The Editor tab's save (decision 33, lane 32), under Node: when a file is
// editable and why it is read only (cut at 400 lines, its text cleaned for
// the screen, the session ended or another's); the editor's states (clean,
// changed, saving, saved, conflict with reload, refused with the rule's
// reason, confirmation); what each answer of the save route becomes; and
// the PUT itself, with the loaded hash and the anti-forgery header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SessionFile } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import {
  editorReducer, editorStart, editorSentence, isDirty, languageOf, lineSeparator, putFile, readOnlyWhy, saveOutcome, sha256Hex, type EditorState,
} from '../../web/components/editor/model.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const fileOf = (path: string, text: string, extra: Partial<SessionFile> = {}): SessionFile => ({ path, text, lines: text.split('\n').length - 1, cut: false, hash: hex(text), ...extra });

test('the hash is the SHA-256 of the text\'s UTF-8 bytes, as the files route computes it', async () => {
  for (const text of ['', 'export const a = 1;\n', 'é€😀\r\n']) assert.equal(await sha256Hex(text), hex(text));
});

test('a file is editable when its shown text is the file; else it says why it is read only', async () => {
  const text = 'export const a = 1;\n';
  const open = { sessionOpen: true };
  assert.equal(await readOnlyWhy(fileOf('src/a.ts', text), open), undefined);
  assert.equal(await readOnlyWhy(fileOf('src/a.ts', text, { cut: true, lines: 812 }), open), 'cut', 'cut at 400 lines');
  // The route cleans the text it shows (a token, a path of the service) but
  // hashes the file's bytes: saving the cleaned text would write the mask.
  assert.equal(await readOnlyWhy(fileOf('src/a.ts', text, { hash: hex('export const a = "a real value";\n') }), open), 'cleaned');
  assert.equal(await readOnlyWhy(fileOf('src/a.ts', text), { sessionOpen: false }), 'session');
  assert.equal(await readOnlyWhy(fileOf('src/a.ts', text), { ...open, digest: async () => undefined }), 'unchecked', 'no digest in this browser: not editable');
});

test('the editor\'s states: clean, changed, saving, saved, then a second save sends the new hash', () => {
  const file = fileOf('src/a.ts', 'one\n');
  let state: EditorState = editorStart(file);
  assert.equal(state.status, 'clean');
  assert.equal(isDirty(state), false);
  state = editorReducer(state, { kind: 'edit', text: 'one\ntwo\n' });
  assert.equal(state.status, 'changed');
  assert.equal(isDirty(state), true);
  state = editorReducer(state, { kind: 'edit', text: 'one\n' });
  assert.equal(state.status, 'clean', 'back to the loaded text');
  state = editorReducer(editorReducer(state, { kind: 'edit', text: 'one\ntwo\n' }), { kind: 'save' });
  assert.equal(state.status, 'saving');
  assert.equal(state.doc.hash, file.hash, 'the save carries the loaded hash');
  state = editorReducer(state, { kind: 'saved', hash: hex('one\ntwo\n'), at: '2026-10-22T09:40:00.000Z' });
  assert.equal(state.status, 'saved');
  assert.equal(state.doc.hash, hex('one\ntwo\n'), 'the next save sends the hash the route answered');
  assert.equal(state.doc.loaded, 'one\ntwo\n');
  assert.equal(isDirty(state), false);
  state = editorReducer(state, { kind: 'edit', text: 'one\ntwo\nthree\n' });
  assert.equal(state.status, 'changed');

  // Typing while the save is on its way: what was sent is what is saved.
  state = editorReducer(editorReducer(state, { kind: 'save' }), { kind: 'edit', text: 'one\ntwo\nthree\nfour\n' });
  assert.equal(state.status, 'saving');
  state = editorReducer(state, { kind: 'saved', hash: hex('one\ntwo\nthree\n'), at: '2026-10-22T09:42:00.000Z' });
  assert.equal(state.status, 'changed', 'the line typed meanwhile is not saved yet');
  assert.equal(state.doc.loaded, 'one\ntwo\nthree\n');
  assert.equal(state.text, 'one\ntwo\nthree\nfour\n');
});

test('a stale hash is a conflict, and Reload takes the file as it is now', () => {
  const file = fileOf('src/a.ts', 'one\n');
  let state = editorReducer(editorReducer(editorStart(file), { kind: 'edit', text: 'mine\n' }), { kind: 'save' });
  state = editorReducer(state, saveOutcome(409, { error: 'the file changed since the editor loaded it: reload it', rule: null, reason: 'the file changed since the editor loaded it: reload it', hash: hex('theirs\n'), confirmable: false }));
  assert.equal(state.status, 'conflict');
  assert.equal(state.text, 'mine\n', 'the person\'s text is kept until they reload');
  state = editorReducer(state, { kind: 'reload', file: fileOf('src/a.ts', 'theirs\n') });
  assert.equal(state.status, 'clean');
  assert.equal(state.text, 'theirs\n');
  assert.equal(state.doc.hash, hex('theirs\n'));
});

test('a refusal keeps the rule and its reason; a confirmable one asks, and the next save carries the rule', () => {
  const file = fileOf('package.json', '{}\n');
  let state = editorReducer(editorReducer(editorStart(file), { kind: 'edit', text: '{"dependencies":{"x":"1"}}\n' }), { kind: 'save' });
  state = editorReducer(state, saveOutcome(403, { error: 'installing a package asks first', rule: 'install.package', reason: 'installing a package asks first', confirmable: true }));
  assert.equal(state.status, 'confirm');
  assert.equal(state.status === 'confirm' && state.rule, 'install.package');
  state = editorReducer(state, { kind: 'save', confirm: 'install.package' });
  assert.equal(state.status, 'saving');
  assert.equal(state.status === 'saving' && state.confirm, 'install.package');

  const denied = editorReducer(editorReducer(editorReducer(editorStart(fileOf('CLAUDE.md', 'x\n')), { kind: 'edit', text: 'y\n' }), { kind: 'save' }),
    saveOutcome(403, { error: 'asks first', rule: 'default', reason: 'nothing allows an edit of CLAUDE.md', confirmable: false }));
  assert.equal(denied.status, 'refused');
  assert.equal(denied.status === 'refused' && denied.rule, 'default');
  assert.equal(denied.status === 'refused' && denied.reason, 'nothing allows an edit of CLAUDE.md');
  assert.equal(isDirty(denied), true, 'a refused text is still unsaved');
  // A confirmation is only ever offered for the two rules the editor confirms.
  assert.equal(saveOutcome(403, { error: 'x', rule: 'default', reason: 'x', confirmable: true }).kind, 'refused');
});

test('every other answer of the save route', () => {
  assert.deepEqual(saveOutcome(200, { saved: true, hash: 'h2' }, '2026-10-22T09:41:00.000Z'), { kind: 'saved', hash: 'h2', at: '2026-10-22T09:41:00.000Z' });
  assert.deepEqual(saveOutcome(409, { error: 'the review runs: the checkout is not edited meanwhile' }), { kind: 'refused', rule: null, reason: 'the review runs: the checkout is not edited meanwhile' });
  assert.deepEqual(saveOutcome(403, { error: 'saving a file of a session is the owner account\'s alone' }), { kind: 'refused', rule: null, reason: 'saving a file of a session is the owner account\'s alone' });
  assert.deepEqual(saveOutcome(404, { error: 'no such file in the checkout' }), { kind: 'refused', rule: null, reason: 'no such file in the checkout' });
  assert.deepEqual(saveOutcome(503, {}), { kind: 'failed' });
  assert.deepEqual(saveOutcome(500, 'not json'), { kind: 'failed' });
});

test('each state has its sentence, in both languages, with the rule and the reason where there are', () => {
  const file = fileOf('src/a.ts', 'one\n');
  const start = editorStart(file);
  const changed = editorReducer(start, { kind: 'edit', text: 'two\n' });
  const states: EditorState[] = [
    start, changed, editorReducer(changed, { kind: 'save' }),
    editorReducer(editorReducer(changed, { kind: 'save' }), { kind: 'saved', hash: 'h', at: '2026-10-22T09:41:00.000Z' }),
    editorReducer(changed, saveOutcome(409, { error: 'x', rule: null, reason: 'x', hash: 'h3', confirmable: false })),
    editorReducer(changed, saveOutcome(403, { error: 'x', rule: 'push.base', reason: 'the base branch is never written', confirmable: false })),
    editorReducer(changed, saveOutcome(403, { error: 'x', rule: 'scripts.change', reason: 'a script change asks first', confirmable: true })),
    editorReducer(changed, { kind: 'failed' }),
  ];
  for (const t of [en, fr]) for (const state of states) {
    const line = editorSentence(state, t, { taken: false });
    assert.ok(line === '' || !line.includes('{'), `${state.status}: ${line}`);
  }
  assert.equal(editorSentence(start, en, { taken: false }), '');
  assert.match(editorSentence(states[5] as EditorState, en, { taken: false }), /the base branch is never written/);
  assert.match(editorSentence(states[5] as EditorState, en, { taken: false }), /push\.base/);
  assert.match(editorSentence(states[3] as EditorState, en, { taken: false }), /told/);
  assert.match(editorSentence(states[3] as EditorState, en, { taken: true }), /give it back/i);
});

test('the language of a file, and its line ends kept', () => {
  assert.equal(languageOf('src/a.ts'), 'typescript');
  assert.equal(languageOf('src/Upcoming.jsx'), 'jsx');
  assert.equal(languageOf('src/App.tsx'), 'tsx');
  assert.equal(languageOf('src/engine/upcoming.mjs'), 'javascript');
  assert.equal(languageOf('package.json'), 'json');
  assert.equal(languageOf('README.md'), null);
  assert.equal(lineSeparator('a\r\nb\r\n'), '\r\n');
  assert.equal(lineSeparator('a\nb\n'), undefined);
});

test('the save is a PUT of the text and the loaded hash, with the anti-forgery header; the refusal\'s body is read', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = { status: 200, body: { saved: true, hash: 'h2' } as unknown };
  const fetcher = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  assert.deepEqual(await putFile({ session: 's 1', path: 'src/engine/up coming.mjs', text: 'x\n', hash: 'h1', csrf: 'token-1', fetcher }), { status: 200, body: { saved: true, hash: 'h2' } });
  const [call] = calls;
  assert.equal(call?.url, '/api/service/sessions/s%201/files/src/engine/up%20coming.mjs');
  assert.equal(call?.init.method, 'PUT');
  assert.equal(call?.init.credentials, 'same-origin');
  assert.equal(new Headers(call?.init.headers).get('x-csrf-token'), 'token-1');
  assert.deepEqual(JSON.parse(String(call?.init.body)), { text: 'x\n', hash: 'h1' });
  await putFile({ session: 's1', path: 'package.json', text: '{}', hash: 'h1', csrf: 't', confirm: 'install.package', fetcher });
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { text: '{}', hash: 'h1', confirm: 'install.package' });
  answer.status = 409;
  answer.body = { error: 'stale', rule: null, reason: 'stale', hash: 'h9', confirmable: false };
  assert.deepEqual(await putFile({ session: 's1', path: 'a', text: '', hash: 'h1', csrf: 't', fetcher }), { status: 409, body: answer.body });
});
