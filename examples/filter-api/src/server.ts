// The filter API's routes, on node:http (contract/openapi.yaml):
//   POST /check   {"text": "..."} to {"ok": true|false, "words": [...]}
//   GET  /health  200 {"status":"ok"}
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { findWords, type WordList } from './words.ts';

export const MAX_BODY_BYTES = 16 * 1024;

const ROUTES: Record<string, string> = { '/check': 'POST', '/health': 'GET, HEAD' };

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
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
function requestPath(target: string): string | undefined {
  try {
    return new URL(target, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

// The body as text, or undefined when it is over MAX_BODY_BYTES. The rest of
// a body over the limit is still read, and dropped, so the answer goes out
// after the whole request and an uploading client never stalls.
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on('end', () => resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function check(words: WordList, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    request.resume();
    return sendJson(response, 415, { error: 'Send the body as application/json.' });
  }
  const body = await readBody(request);
  if (body === undefined) return sendJson(response, 413, { error: `The body is larger than ${MAX_BODY_BYTES} bytes.` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendJson(response, 400, { error: 'The body is not JSON.' });
  }
  const text = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { text?: unknown }).text : undefined;
  if (typeof text !== 'string') return sendJson(response, 400, { error: 'The body needs "text", a string.' });
  const found = findWords(words, text);
  sendJson(response, 200, { ok: found.length === 0, words: found });
}

async function route(words: WordList, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = requestPath(request.url ?? '/');
  if (path === undefined) return sendJson(response, 400, { error: 'Bad request.' });
  const allow = ROUTES[path];
  if (allow === undefined) return sendJson(response, 404, { error: 'Not found.' });
  if (!allow.split(', ').includes(request.method ?? '')) return sendJson(response, 405, { error: 'Method not allowed.' }, { allow });
  if (path === '/health') return sendJson(response, 200, { status: 'ok' });
  return check(words, request, response);
}

export function createApp(words: WordList): Server {
  return createServer((request, response) => {
    route(words, request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: 'The check failed.' });
    });
  });
}
