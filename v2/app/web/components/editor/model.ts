// The Editor tab's save (decision 33, lane 32), as pure parts the tests run
// under Node; Editor.tsx mounts CodeMirror on them.
//   - A file opens for editing only when the text on screen is the file:
//     the files route cleans what it shows (a secret's shape, a path of the
//     service) but hashes the file's bytes, so a cleaned text saved back
//     would write the mask. The text's SHA-256 is compared with the file's
//     hash; a file the viewer cut at 400 lines stays read only too.
//   - The states: clean, changed, saving, saved, conflict (a stale hash:
//     Reload takes the file as it is now), refused (the rule and its
//     reason), confirm (install.package or scripts.change: a second save
//     carries the rule), failed.
//   - The save is a PUT of the text and the hash the editor loaded (then
//     the one the route answered), with the anti-forgery header; the
//     refusal's body is read, since it names the rule.
import type { ConfirmableRule, FileWrite, FileWriteRefusal, FileWritten, SessionFile } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { clock } from '../../screens/session/model.ts';

const CONFIRMABLE: ReadonlySet<string> = new Set<ConfirmableRule>(['install.package', 'scripts.change']);

// ----------------------------------------------------------------- reading

type Digest = (text: string) => Promise<string | undefined>;

// The SHA-256 of the text's UTF-8 bytes, in hex; undefined where the page
// has no digest (not a secure context).
export const sha256Hex: Digest = async (text) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

// Why a file stays read only: cut at 400 lines, its text cleaned for the
// screen, unchecked (no digest here), or the session's (ended, a reviewer's,
// another account's).
export type ReadOnlyWhy = 'cut' | 'cleaned' | 'unchecked' | 'session';

export async function readOnlyWhy(file: SessionFile, options: { readonly sessionOpen: boolean; readonly digest?: Digest }): Promise<ReadOnlyWhy | undefined> {
  if (!options.sessionOpen) return 'session';
  if (file.cut) return 'cut';
  const hash = await (options.digest ?? sha256Hex)(file.text);
  if (hash === undefined) return 'unchecked';
  return hash === file.hash ? undefined : 'cleaned';
}

export type Language = 'javascript' | 'typescript' | 'jsx' | 'tsx' | 'json';

// The language pack for a path (lane 30 added JavaScript and JSON only).
export function languageOf(path: string): Language | null {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': case 'mts': case 'cts': return 'typescript';
    case 'jsx': return 'jsx';
    case 'tsx': return 'tsx';
    case 'json': return 'json';
    default: return null;
  }
}

// CodeMirror joins lines with \n: a file written with \r\n keeps its own.
export const lineSeparator = (text: string): string | undefined => (text.includes('\r\n') ? '\r\n' : undefined);

// ------------------------------------------------------------------ states

export type Doc = { readonly path: string; readonly loaded: string; readonly hash: string };
export type EditorState =
  | { readonly status: 'clean'; readonly doc: Doc; readonly text: string }
  | { readonly status: 'changed'; readonly doc: Doc; readonly text: string }
  | { readonly status: 'saving'; readonly doc: Doc; readonly text: string; readonly sent: string; readonly confirm?: ConfirmableRule }
  | { readonly status: 'saved'; readonly doc: Doc; readonly text: string; readonly at: string }
  | { readonly status: 'conflict'; readonly doc: Doc; readonly text: string; readonly current: string }
  | { readonly status: 'refused'; readonly doc: Doc; readonly text: string; readonly rule: string | null; readonly reason: string }
  | { readonly status: 'confirm'; readonly doc: Doc; readonly text: string; readonly rule: ConfirmableRule; readonly reason: string }
  | { readonly status: 'failed'; readonly doc: Doc; readonly text: string };

export type EditorAction =
  | { readonly kind: 'edit'; readonly text: string }
  | { readonly kind: 'save'; readonly confirm?: ConfirmableRule }
  | { readonly kind: 'saved'; readonly hash: string; readonly at: string }
  | { readonly kind: 'conflict'; readonly hash: string }
  | { readonly kind: 'refused'; readonly rule: string | null; readonly reason: string }
  | { readonly kind: 'confirm'; readonly rule: ConfirmableRule; readonly reason: string }
  | { readonly kind: 'failed' }
  | { readonly kind: 'reload'; readonly file: SessionFile };

export const editorStart = (file: SessionFile): EditorState => ({ status: 'clean', doc: { path: file.path, loaded: file.text, hash: file.hash }, text: file.text });

// Whether the text on screen differs from what the file holds, as far as the editor knows.
export const isDirty = (state: EditorState): boolean => state.text !== state.doc.loaded;

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { doc, text } = state;
  switch (action.kind) {
    case 'edit':
      // Typing goes on while a save is on its way: the text sent is kept apart.
      if (state.status === 'saving') return { ...state, text: action.text };
      return { status: action.text === doc.loaded ? 'clean' : 'changed', doc, text: action.text };
    case 'save':
      if (state.status === 'saving') return state;
      return action.confirm ? { status: 'saving', doc, text, sent: text, confirm: action.confirm } : { status: 'saving', doc, text, sent: text };
    case 'saved': {
      const loaded = state.status === 'saving' ? state.sent : text;
      const saved = { ...doc, loaded, hash: action.hash };
      return text === loaded ? { status: 'saved', doc: saved, text, at: action.at } : { status: 'changed', doc: saved, text };
    }
    case 'conflict':
      return { status: 'conflict', doc, text, current: action.hash };
    case 'refused':
      return { status: 'refused', doc, text, rule: action.rule, reason: action.reason };
    case 'confirm':
      return { status: 'confirm', doc, text, rule: action.rule, reason: action.reason };
    case 'failed':
      return { status: 'failed', doc, text };
    case 'reload':
      return editorStart(action.file);
  }
}

// What an answer of the save route becomes.
export function saveOutcome(status: number, body: unknown, at: string = new Date().toISOString()): EditorAction {
  const value = (body && typeof body === 'object' ? body : {}) as Partial<FileWritten & FileWriteRefusal>;
  const reason = typeof value.reason === 'string' ? value.reason : typeof value.error === 'string' ? value.error : undefined;
  const rule = typeof value.rule === 'string' ? value.rule : null;
  if (status === 200 && typeof value.hash === 'string') return { kind: 'saved', hash: value.hash, at };
  if (status === 409 && typeof value.hash === 'string') return { kind: 'conflict', hash: value.hash };
  if (status === 403 && value.confirmable === true && rule !== null && CONFIRMABLE.has(rule) && reason !== undefined)
    return { kind: 'confirm', rule: rule as ConfirmableRule, reason };
  if ([400, 403, 404, 409, 413, 415].includes(status) && reason !== undefined) return { kind: 'refused', rule, reason };
  return { kind: 'failed' };
}

// The sentence under the editor for its state; none while clean.
export function editorSentence(state: EditorState, t: Translate, options: { readonly taken: boolean }): string {
  switch (state.status) {
    case 'clean': return '';
    case 'changed': return t('editor_state_changed');
    case 'saving': return t('editor_state_saving');
    case 'saved': return t(options.taken ? 'editor_state_saved_taken' : 'editor_state_saved', { time: clock(state.at) });
    case 'conflict': return t('editor_state_conflict');
    case 'refused': return state.rule ? t('editor_state_refused', { reason: state.reason, rule: state.rule }) : t('editor_state_refused_plain', { reason: state.reason });
    case 'confirm': return t('editor_state_confirm', { reason: state.reason, rule: state.rule });
    case 'failed': return t('editor_state_failed');
  }
}

// ------------------------------------------------------------------- route

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// PUT /api/service/sessions/:id/files/<path>: the answer's status and body,
// read whatever the status, since a refusal names its rule.
export async function putFile(options: {
  readonly session: string; readonly path: string; readonly text: string; readonly hash: string; readonly csrf: string;
  readonly confirm?: ConfirmableRule | undefined; readonly fetcher?: Fetch;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const url = `/api/service/sessions/${encodeURIComponent(options.session)}/files/${options.path.split('/').map(encodeURIComponent).join('/')}`;
  const body: FileWrite = { text: options.text, hash: options.hash, ...(options.confirm ? { confirm: options.confirm } : {}) };
  const response = await (options.fetcher ?? ((u, init) => fetch(u, init)))(url, {
    method: 'PUT', credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': options.csrf },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
