// The editor's packages in a chunk of their own: the session screen imports
// this module dynamically (Editor.tsx), once a file is opened for editing.
// @codemirror/state, @codemirror/view, @codemirror/language and
// @lezer/highlight come with codemirror (lane 30).
export { basicSetup, EditorView } from 'codemirror';
export { EditorState, Prec } from '@codemirror/state';
export { keymap } from '@codemirror/view';
export { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { javascript } from '@codemirror/lang-javascript';
export { json } from '@codemirror/lang-json';
