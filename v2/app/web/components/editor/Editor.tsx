// The Editor tab's editor (decision 33, lane 32): CodeMirror on a file the
// session changed, with Save, its states and their sentences (model.ts).
//   - CodeMirror loads by a dynamic import (codemirror.ts) once a file is
//     opened for editing, so no other screen grows.
//   - Its <style> elements carry the page's nonce through its own option,
//     EditorView.cspNonce; the terminal's shims are not for it.
//   - The text is the editor's own from the file it opened: a change the
//     session makes meanwhile does not replace it; the tab says so (stale),
//     and Reload takes the file as it is now. A reload or a new file mounts
//     a new editor (its key).
//   - Mod-S saves, as the Save button does.
//   - The code's colours are the session sheet's --code-* tokens, so they
//     follow the page's theme (CodeMirror's own palette is for light only).
import { useEffect, useRef, type Ref } from 'react';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { pageNonce } from '../terminal/model.ts';
import { editorSentence, isDirty, languageOf, lineSeparator, type EditorState } from './model.ts';

export type EditorHandlers = {
  readonly onChange?: (text: string) => void;
  readonly onSave?: () => void;
  readonly onConfirm?: () => void;
  readonly onReload?: () => void;
  readonly onClose?: () => void;
};

export function EditorFrame({ t, state, taken, stale, host, onSave, onConfirm, onReload, onClose }: EditorHandlers & {
  readonly t: Translate; readonly state: EditorState; readonly taken: boolean; readonly stale: boolean; readonly host?: Ref<HTMLDivElement>;
}) {
  const saving = state.status === 'saving';
  const sentence = editorSentence(state, t, { taken });
  return (
    <div className="editing" data-editor-state={state.status}>
      <div className="cm-host" ref={host} />
      <div className="editing-foot">
        <p className={state.status === 'refused' || state.status === 'failed' ? 'editor-state bad' : 'editor-state'} role="status">
          {sentence}{stale && state.status !== 'conflict' ? <span className="editor-stale">{t('editor_stale')}</span> : null}
        </p>
        <div className="editing-actions">
          {state.status === 'confirm'
            ? <Button variant="ink" className="btn primary" data-act="editor_confirm" onClick={onConfirm}>{t('editor_confirm')}</Button>
            : state.status === 'conflict'
              ? <Button variant="ink" className="btn primary" data-act="editor_reload" onClick={onReload}>{t('editor_reload')}</Button>
              : <Button variant="ink" className="btn primary" data-act="editor_save" disabled={saving || !isDirty(state)} onClick={onSave}>{t('editor_save')}</Button>}
          {stale && state.status !== 'conflict' ? <Button className="btn" data-act="editor_reload" disabled={saving} onClick={onReload}>{t('editor_reload')}</Button> : null}
          <Button className="btn" data-act="editor_close" disabled={saving} onClick={onClose}>{t('editor_close')}</Button>
        </div>
      </div>
    </div>
  );
}

// The editor's look from the page's tokens: Geist Mono, the hairlines, the
// ink focus ring of the app's fields; the theme follows the page's.
const THEME = {
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '12.5px', borderRadius: '8px', boxShadow: 'var(--e-outline)' },
  '&.cm-focused': { outline: 'none', boxShadow: '0 0 0 2px var(--link)' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--text)', fontVariantLigatures: 'none' },
  '.cm-gutters': { backgroundColor: 'var(--surface-muted)', color: 'var(--text-faint)', borderRight: '1px solid var(--hairline)', borderRadius: '8px 0 0 8px', fontFamily: 'var(--mono)' },
  '.cm-activeLine': { backgroundColor: 'var(--tab-fill)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--tab-fill)', color: 'var(--text)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--select)' },
  '.cm-panels': { backgroundColor: 'var(--surface-muted)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--hairline)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--hairline)' },
  '.cm-textfield': { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '0', borderRadius: '6px', boxShadow: 'var(--e-control)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface)', color: 'var(--text)', border: '0', borderRadius: '6px', boxShadow: 'var(--e-control)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '0', borderRadius: '8px', boxShadow: 'var(--e-card)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--selected)', color: 'var(--text)' },
};

// The code's colours, by the sheet's tokens (session.css), in both themes.
function highlightOf(cm: typeof import('./codemirror.ts')) {
  const t = cm.tags;
  return cm.HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.operatorKeyword, t.modifier, t.moduleKeyword], color: 'var(--code-keyword)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--code-comment)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: 'var(--code-function)' },
    { tag: [t.definition(t.variableName), t.typeName, t.className], color: 'var(--code-definition)' },
    { tag: [t.propertyName, t.attributeName], color: 'var(--code-property)' },
    { tag: t.invalid, color: 'var(--danger-text)' },
  ]);
}

// The editor on its file: mounted once per key (a file, a reload); the
// text it starts with is the state's, and every change goes back to it.
export function Editing({ t, state, taken, stale, path, ...handlers }: EditorHandlers & {
  readonly t: Translate; readonly state: EditorState; readonly taken: boolean; readonly stale: boolean; readonly path: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ handlers, t });
  latest.current = { handlers, t };
  const start = useRef(state.text);

  useEffect(() => {
    let disposed = false;
    let destroy = () => {};
    void import('./codemirror.ts').then((cm) => {
      const element = host.current;
      if (disposed || !element) return;
      const language = languageOf(path);
      const separator = lineSeparator(start.current);
      const view = new cm.EditorView({
        parent: element,
        state: cm.EditorState.create({
          doc: start.current,
          extensions: [
            cm.Prec.highest(cm.keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { latest.current.handlers.onSave?.(); return true; } }])),
            cm.basicSetup,
            cm.EditorView.cspNonce.of(pageNonce(document)),
            cm.EditorView.theme(THEME),
            cm.syntaxHighlighting(highlightOf(cm)),
            cm.EditorView.contentAttributes.of({ 'aria-label': latest.current.t('editor_label', { path }) }),
            separator ? cm.EditorState.lineSeparator.of(separator) : [],
            language === 'json' ? cm.json() : language ? cm.javascript({ typescript: language === 'typescript' || language === 'tsx', jsx: language === 'jsx' || language === 'tsx' }) : [],
            cm.EditorView.updateListener.of((update) => { if (update.docChanged) latest.current.handlers.onChange?.(update.state.doc.toString()); }),
          ],
        }),
      });
      destroy = () => view.destroy();
    });
    return () => { disposed = true; destroy(); };
  }, [path]);

  return <EditorFrame t={t} state={state} taken={taken} stale={stale} host={host} {...handlers} />;
}
