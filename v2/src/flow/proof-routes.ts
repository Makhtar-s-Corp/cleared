// GET /api/tickets/:id/proof/:service/:file (P210, issue #326): a capture
// of a ticket's proof receipt, the file the pull request's receipt links to
// through the app (/api/service/...), so only a person signed in to the app
// opens it. The app's proof first, as every route of the service; then one
// of the three names, of a service of the workspace, of a ticket the store
// knows (FlowEngine.proofFile), and a plain file, never a link.
import { createReadStream, lstatSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { SERVICE_PROOF_HEADER } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { FlowEngine } from './engine.ts';

export type ProofRoutesDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
};

const TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.webm': 'video/webm' };

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
      if (!engine) return answer(context, 503, { error: 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md' });
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
  }];
}
