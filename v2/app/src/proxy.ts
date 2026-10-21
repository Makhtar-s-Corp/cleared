// Where the app's data comes from: the live service, or the fixtures
// (fixtures/source.ts). The browser asks /api/service/<rest>; the server
// has already checked the session (and, for a write, the anti-forgery
// token and the origin), then hands the request to the source as
// /api/<rest> with the signed-in user.
//
// To the service, a request goes over loopback with the app's proof and
// the user's id (SERVICE_PROOF_HEADER, SERVICE_USER_HEADER), and with only
// the headers below from the browser: never its cookie, its anti-forgery
// token or anything that would let the service mistake it for the browser.
// Answers stream back as they come, so the session's event stream works
// through it.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import type { User } from '../../src/modules/registry.ts';

export type Forward = {
  readonly method: string;
  readonly path: string;                 // '/api/<rest>', with its query string
  readonly user: User;
};

export interface DataSource {
  readonly kind: 'service' | 'fixtures';
  forward(request: IncomingMessage, response: ServerResponse, forward: Forward): void;
}

const REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'last-event-id'] as const;
const RESPONSE_HEADERS = ['content-type', 'content-length', 'cache-control', 'allow', 'retry-after'] as const;

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  response.end(text);
}

export function serviceSource(options: { readonly url: string; readonly proof: string }): DataSource {
  const base = new URL(options.url);
  return {
    kind: 'service',
    forward(request, response, forward) {
      const headers: Record<string, string> = { [SERVICE_PROOF_HEADER]: options.proof, [SERVICE_USER_HEADER]: forward.user.id };
      for (const name of REQUEST_HEADERS) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const upstream = httpRequest({ protocol: base.protocol, hostname: base.hostname, port: base.port, method: forward.method, path: forward.path, headers }, (answer) => {
        const out: Record<string, string> = {};
        for (const name of RESPONSE_HEADERS) {
          const value = answer.headers[name];
          if (typeof value === 'string') out[name] = value;
        }
        response.writeHead(answer.statusCode ?? 502, out);
        response.flushHeaders();
        answer.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) sendJson(response, 502, { error: 'the service did not answer' });
        else response.destroy();
      });
      // The browser went away: so does the request to the service.
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    },
  };
}
