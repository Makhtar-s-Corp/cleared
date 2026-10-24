// The links that open a session's checkout in VS Code or in Cursor (docs/v2/
// complement-devin.md item 19, flow/editor.ts serves them). Pure: nothing is
// run, no editor is started on the server; the person's own browser follows
// the link and their own editor opens the folder, on this machine or over
// SSH. Kept apart from the route so the configuration can check the SSH host
// without loading the flow.
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { EDITORS, type EditorLinks } from '../api/types.ts';

// An SSH host as an ssh config names it: an optional user, then a name that
// starts with a letter or digit (never a dash, which ssh would read as an
// option) and holds only letters, digits, dots, dashes and underscores. It
// goes into a link as written, so nothing that could change the link (a
// slash, a hash, a question mark, a percent sign, a colon, a space) passes.
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseEditorHost(value: string | undefined): string | undefined {
  const host = value?.trim();
  if (host === undefined || host === '') return undefined;
  if (!HOST.test(host) || host.length > 255) throw new Error('CLEARED_V2_EDITOR_SSH_HOST must be a host name as an ssh config writes it, with an optional user@ (letters, digits, dots, dashes and underscores)');
  return host;
}

export class EditorFolderError extends Error {
  readonly status: 403 | 409;
  constructor(status: 403 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

// The checkout's real folder when it is a worktree of Cleared: a folder
// strictly inside the service's work folder (a link that leaves it, the work
// folder itself and a sibling that shares its prefix are refused) that holds
// a .git. The path that goes into a link is this real one. 409: gone.
export function checkoutFolder(workdir: string, root: string): string {
  const refuse = () => new EditorFolderError(403, 'the session\'s checkout is not a worktree of this service: no link is given');
  if (!isAbsolute(workdir) || /[\u0000-\u001f\u007f]/.test(workdir)) throw refuse();
  let real: string;
  let top: string;
  try { top = realpathSync(root); } catch { throw new EditorFolderError(409, 'the service\'s work folder is gone'); }
  try { real = realpathSync(workdir); } catch { throw new EditorFolderError(409, 'the session\'s checkout is gone'); }
  if (!real.startsWith(top.endsWith(sep) ? top : `${top}${sep}`)) throw refuse();
  if (!lstatSync(real).isDirectory() || !lstatSync(join(real, '.git'), { throwIfNoEntry: false })) throw refuse();
  return real;
}

const encode = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

// Local: <editor>://file/<path>. Over SSH: <editor>://vscode-remote/ssh-remote+<host>/<path>.
export function editorLinks(folder: string, host?: string): EditorLinks {
  const path = encode(folder);
  return {
    mode: host === undefined ? 'local' : 'ssh',
    links: EDITORS.map((editor) => ({ editor, url: host === undefined ? `${editor}://file${path}` : `${editor}://vscode-remote/ssh-remote+${host}${path}` })),
  };
}
