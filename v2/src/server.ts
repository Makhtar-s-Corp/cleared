import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type Health = {
  readonly status: 'ok';
};

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(text);
}

export function handle(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path !== '/health') {
    send(response, 404, { error: 'not found' });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    return;
  }
  const health: Health = { status: 'ok' };
  send(response, 200, health);
}

export function createHealthServer(): Server {
  return createServer(handle);
}
