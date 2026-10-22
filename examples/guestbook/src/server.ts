// The guestbook's routes, on node:http:
//   GET  /         the page
//   POST /entries  adds an entry from a form, then back to / (303)
//   GET  /health   200 {"status":"ok"} while the database answers, else 503
// With a filter (FILTER_URL), an entry is checked by the filter API before
// it is stored; /health still checks the database only, so a filter that is
// down never fails the guestbook's release watch.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Filter, FilterVerdict } from './filter.ts';
import { LIMITS, renderPage, type FormState } from './page.ts';
import type { Store } from './store.ts';

export type AppOptions = {
  // The filter API's client; none when FILTER_URL is unset.
  readonly filter?: Filter;
  // The proof's provoked failure (config.ts, PROOF_BREAK_HEALTH).
  readonly breakHealth?: boolean;
};

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

// The body as text, or undefined when it is over MAX_BODY_BYTES. The rest of
// a body over the limit is still read, and dropped: the answer then goes out
// after the whole request, so an uploading client neither stalls on a
// server that stopped reading nor gets its connection reset before the answer.
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

async function addEntry(store: Store, options: AppOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    request.resume();
    sendText(response, 415, 'Send the form as application/x-www-form-urlencoded.');
    return;
  }
  const body = await readBody(request);
  if (body === undefined) {
    sendText(response, 413, `The form is larger than ${MAX_BODY_BYTES} bytes.`);
    return;
  }
  const entry = parseEntry(body);
  if (!entry.ok) {
    await page(store, response, 400, entry.form);
    return;
  }
  if (options.filter) {
    const { name, message } = entry;
    let verdict: FilterVerdict;
    try {
      verdict = await options.filter.check(`${name}\n${message}`);
    } catch {
      // Nothing goes in unchecked: the visitor keeps the form and tries again.
      await page(store, response, 503, { error: 'The filter did not answer. Try again in a moment.', name, message });
      return;
    }
    if (!verdict.ok) {
      await page(store, response, 400, { error: `The entry holds words the filter refuses: ${verdict.words.join(', ')}.`, name, message });
      return;
    }
  }
  await store.add(entry.name, entry.message);
  response.writeHead(303, { location: '/', 'content-length': '0', 'cache-control': 'no-store' });
  response.end();
}

async function route(store: Store, options: AppOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = requestPath(request.url ?? '/');
  if (path === undefined) return sendText(response, 400, 'Bad request.');
  const allow = ROUTES[path];
  if (allow === undefined) return sendText(response, 404, 'Not found.');
  if (!allow.split(', ').includes(request.method ?? '')) return sendJson(response, 405, { error: 'method not allowed' }, { allow });
  if (path === '/health') {
    if (options.breakHealth) return sendJson(response, 503, { status: 'broken', reason: 'PROOF_BREAK_HEALTH' });
    return (await store.ping()) ? sendJson(response, 200, { status: 'ok' }) : sendJson(response, 503, { status: 'unavailable' });
  }
  if (path === '/entries') return addEntry(store, options, request, response);
  return page(store, response);
}

export function createApp(store: Store, options: AppOptions = {}): Server {
  return createServer((request, response) => {
    route(store, options, request, response).catch(() => {
      // The database failed during a page or an insert: say so, without its details.
      if (response.headersSent) response.destroy();
      else sendText(response, 500, 'The database did not answer. Try again in a moment.');
    });
  });
}
