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

// The path of a request target, or undefined when the URL parser refuses it.
// Node's HTTP parser lets through targets the URL parser throws on (`//[`).
export function requestPath(target: string): string | undefined {
  try {
    return new URL(target, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

// host:port as written in a URL: an IPv6 address goes in brackets.
export function formatAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export function handle(request: IncomingMessage, response: ServerResponse): void {
  const path = requestPath(request.url ?? '/');
  if (path === undefined) {
    send(response, 400, { error: 'bad request' });
    return;
  }
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
