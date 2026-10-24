// Open in an editor (docs/v2/complement-devin.md item 19, matrix C19):
//
//   GET /api/sessions/:id/editor -> EditorLinks
//
// the links that open the session's checkout in VS Code or in Cursor. The
// service runs no editor and starts nothing: it only says where the folder
// is, in a form the person's browser hands to their own editor, on this
// machine (`vscode://file/<path>`) or over SSH when CLEARED_V2_EDITOR_SSH_HOST
// names the server (`vscode://vscode-remote/ssh-remote+<host>/<path>`).
//
// The folder is the one the service itself started for the session
// (engine.sessionWorkdir), never a path the request carries, and it must
// still be a real worktree strictly inside the service's work folder
// (editor-link.ts). The path is the host's, which the events and the files
// the screen shows keep out (the cleaner); this route is the one place it is
// given, to a signed-in person, and it is not logged or stored. An edit made
// in the editor does not pass the in-app policy nor the `cleared.human_edit`
// journal: a taken-over session finds it at Give back (flow/takeover.ts).
export { EditorFolderError, checkoutFolder, editorLinks, parseEditorHost } from './editor-link.ts';
import { SERVICE_PROOF_HEADER, type EditorLinks } from '../api/types.ts';
import type { Registry, Route } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { answer, header, humanUser, HttpError } from '../terminal/routes.ts';
import { EditorFolderError, checkoutFolder, editorLinks } from './editor-link.ts';
import type { FlowEngine } from './engine.ts';

export type EditorDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
  readonly host?: () => string | undefined;   // the SSH host; none: the configuration's (engine.config.editorHost)
};

export function editorRoutes(deps: EditorDeps): Route[] {
  return [{
    method: 'GET', path: '/api/sessions/:id/editor',
    async handle(context) {
      try {
        if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
        const engine = deps.engine(context.registry);
        if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
        await humanUser(context, deps.proof());
        const id = context.params.id as string;
        if (!engine.sessionDetail(id)) throw new HttpError(404, 'no such session');
        const workdir = engine.sessionWorkdir(id);
        if (workdir === undefined) throw new HttpError(409, 'the service does not know this session\'s checkout any more: it restarted since the session ran');
        const folder = checkoutFolder(workdir, engine.config.workdirRoot);
        answer(context, 200, editorLinks(folder, deps.host ? deps.host() : engine.config.editorHost) satisfies EditorLinks);
      } catch (error) {
        if (error instanceof HttpError) answer(context, error.status, { error: error.message });
        else if (error instanceof EditorFolderError) answer(context, error.status, { error: error.message });
        else throw error;
      }
    },
  }];
}
