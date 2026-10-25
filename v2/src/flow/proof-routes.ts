// GET /api/tickets/:id/proof/:service/:file (P210, issue #326): a capture
// of a ticket's proof receipt, the file the pull request's receipt links to
// through the app (/api/service/...), so only a person signed in to the app
// opens it. The app's proof first, as every route of the service; then one
// of the three names, of a service of the workspace, of a ticket the store
// knows (FlowEngine.proofFile), and a plain file, never a link.
// GET /api/tickets/:id/production (P218, issue #334): the production page's
// checks of a ticket's landed release, which its card shows; the capture
// itself is the file route's `production.png`.
// GET and POST /api/tickets/:id/captures (P226, issue #368): the human's
// choice of the receipt's captures on the ticket, Auto, On or Off; a post
// is a signed-in person's, as the editor's save is (terminal/routes.ts).
import { createReadStream, lstatSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { SERVICE_PROOF_HEADER } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { HttpError, humanUser, readBody } from '../terminal/routes.ts';
import { CAPTURE_CHOICES, type CaptureChoiceName } from './capture-need.ts';
import type { FlowEngine } from './engine.ts';

export type ProofRoutesDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
};

const TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.webm': 'video/webm' };
const UNCONFIGURED = { error: 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md' };

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function answer(context: RouteContext, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  context.response.end(text);
}

export function proofRoutes(deps: ProofRoutesDeps): Route[] {
  return [{
    method: 'GET', path: '/api/tickets/:id/proof/:service/:file',
    handle: async (context) => {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) return answer(context, 401, { error: 'unauthorized' });
      const engine = deps.engine(context.registry);
      if (!engine) return answer(context, 503, UNCONFIGURED);
      const { id, service, file } = context.params as { id: string; service: string; file: string };
      const path = await engine.proofFile(id, service, file);
      const stat = path ? lstatSync(path, { throwIfNoEntry: false }) : undefined;
      if (!path || !stat?.isFile()) return answer(context, 404, { error: 'no such capture' });
      context.response.writeHead(200, {
        'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
        'content-length': String(stat.size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      });
      // A file gone between the check and the read ends the answer, never the process.
      createReadStream(path).on('error', () => context.response.destroy()).pipe(context.response);
    },
  }, {
    method: 'GET', path: '/api/tickets/:id/production',
    handle: async (context) => {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) return answer(context, 401, { error: 'unauthorized' });
      const engine = deps.engine(context.registry);
      if (!engine) return answer(context, 503, UNCONFIGURED);
      const checks = await engine.productionChecks((context.params as { id: string }).id);
      if (!checks) return answer(context, 404, { error: 'no such ticket' });
      answer(context, 200, checks);
    },
  }, {
    method: 'GET', path: '/api/tickets/:id/captures',
    handle: async (context) => {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) return answer(context, 401, { error: 'unauthorized' });
      const engine = deps.engine(context.registry);
      if (!engine) return answer(context, 503, UNCONFIGURED);
      const choice = await engine.captureChoice((context.params as { id: string }).id);
      if (!choice) return answer(context, 404, { error: 'no such ticket' });
      answer(context, 200, choice);
    },
  }, {
    method: 'POST', path: '/api/tickets/:id/captures',
    handle: async (context) => {
      try {
        const user = await humanUser(context, deps.proof());
        const engine = deps.engine(context.registry);
        if (!engine) return answer(context, 503, UNCONFIGURED);
        const choice = (await readBody(context.request)).choice;
        if (!CAPTURE_CHOICES.includes(choice as CaptureChoiceName)) throw new HttpError(400, `choice is ${CAPTURE_CHOICES.join(', ')}`);
        const id = (context.params as { id: string }).id;
        if (!(await engine.captureChoice(id))) return answer(context, 404, { error: 'no such ticket' });
        answer(context, 200, await engine.chooseCaptures(id, choice as CaptureChoiceName, user));
      } catch (error) {
        if (error instanceof HttpError) return answer(context, error.status, { error: error.message });
        throw error;
      }
    },
  }];
}
