// The guestbook's routes, on node:http:
//   GET  /         the page
//   POST /entries  adds an entry from a form, then back to / (303)
//   GET  /health   200 {"status":"ok"} while the database answers, else 503
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LIMITS, renderPage, type FormState } from './page.ts';
import type { Store } from './store.ts';

export const MAX_BODY_BYTES = 16 * 1024;

const ROUTES: Record<string, string> = { '/': 'GET, HEAD', '/health': 'GET, HEAD', '/entries': 'POST' };

function send(response: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void =>
  send(response, status, 'application/json', JSON.stringify(body), headers);

const sendText = (response: ServerResponse, status: number, text: string): void => send(response, status, 'text/plain', `${text}\n`);

// The path of a request target, or undefined when the URL parser refuses it.
function requestPath(target: string): string | undefined {
  try {
    return new URL(target, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

class TooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type Parsed = { readonly ok: true; readonly name: string; readonly message: string } | { readonly ok: false; readonly form: FormState };

export function parseEntry(body: string): Parsed {
  const fields = new URLSearchParams(body);
  const name = (fields.get('name') ?? '').trim();
  const message = (fields.get('message') ?? '').trim();
  let error: string | undefined;
  if (name === '') error = 'The name is empty.';
  else if (message === '') error = 'The message is empty.';
  else if (name.length > LIMITS.name) error = `The name is longer than ${LIMITS.name} characters.`;
  else if (message.length > LIMITS.message) error = `The message is longer than ${LIMITS.message} characters.`;
  return error === undefined ? { ok: true, name, message } : { ok: false, form: { error, name, message } };
}

async function page(store: Store, response: ServerResponse, status = 200, form: FormState = {}): Promise<void> {
  send(response, status, 'text/html', renderPage(await store.list(), form));
}

async function addEntry(store: Store, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    request.resume();
    sendText(response, 415, 'Send the form as application/x-www-form-urlencoded.');
    return;
  }
  let body: string;
  try {
    body = await readBody(request);
  } catch (error) {
    if (!(error instanceof TooLarge)) throw error;
    request.resume();
    sendText(response, 413, `The form is larger than ${MAX_BODY_BYTES} bytes.`);
    return;
  }
  const entry = parseEntry(body);
  if (!entry.ok) {
    await page(store, response, 400, entry.form);
    return;
  }
  await store.add(entry.name, entry.message);
  response.writeHead(303, { location: '/', 'content-length': '0', 'cache-control': 'no-store' });
  response.end();
}

async function route(store: Store, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = requestPath(request.url ?? '/');
  if (path === undefined) return sendText(response, 400, 'Bad request.');
  const allow = ROUTES[path];
  if (allow === undefined) return sendText(response, 404, 'Not found.');
  if (!allow.split(', ').includes(request.method ?? '')) return sendJson(response, 405, { error: 'method not allowed' }, { allow });
  if (path === '/health') {
    return (await store.ping()) ? sendJson(response, 200, { status: 'ok' }) : sendJson(response, 503, { status: 'unavailable' });
  }
  if (path === '/entries') return addEntry(store, request, response);
  return page(store, response);
}

export function createApp(store: Store): Server {
  return createServer((request, response) => {
    route(store, request, response).catch(() => {
      // The database failed during a page or an insert: say so, without its details.
      if (response.headersSent) response.destroy();
      else sendText(response, 500, 'The database did not answer. Try again in a moment.');
    });
  });
}
