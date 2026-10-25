// A ticket launched from a chat (P212, issue #328): a slash command
// "@cleared <task>" posted by a chat platform to POST /hooks/chat. The
// command is form-encoded and signed as Slack signs one (v0: HMAC-SHA256 of
// "v0:<timestamp>:<body>" with the shared secret, in x-slack-signature and
// x-slack-request-timestamp), so a real workspace could be pointed at it
// later; it is tested with a fake client only (test/flow/chat-client.ts).
//
//   the secret     read from CLEARED_V2_CHAT_SECRET_FILE; no file named, the
//                  route answers 404, as if it did not exist
//   a replay       the same signature twice is refused (chat_seen), and a
//                  timestamp more than five minutes off is refused outright
//   who            a chat user id maps to a user of the service
//                  (CLEARED_V2_CHAT_USERS=U0AB=u1,...); anyone else is told
//                  so and creates nothing
//   the ticket     created in the service's project as a batch of one
//                  (flow/batch.ts), so it starts within the Consumption
//                  screen's lanes and the week stop, as a batch does
//   the answers    at once, the ticket and the Tower's link; then, posted to
//                  the command's response_url, the author session's link at
//                  ticket_started and the pull request's at
//                  release_requested, each once (chat_replies), after a
//                  restart too (chat_launches). A response_url is used only
//                  when its origin is one of CLEARED_V2_CHAT_REPLY_ORIGINS
//                  (Slack's hooks host by default), and no redirect is followed.
//
// The route is not part of the app's API (api/types.ts): the app never
// calls it, and its own proxy does not reach it. The service listens on
// loopback only (B3.2); how a chat platform reaches it is the owner's
// setup, not this file's.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { AppConfigError, readAppConfig } from '../../app/src/config.ts';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Catalog, type Translate } from '../../app/web/lib/i18n.ts';
import type { Batch } from '../api/types.ts';
import type { Registry, Route, RouteContext, UserDirectory } from '../modules/registry.ts';
import { formatAddress } from '../server.ts';
import type { UserId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';
import { BATCH_TITLE_MAX } from './batch.ts';
import type { FlowEvent, FlowListener } from './events.ts';

export const CHAT_PATH = '/hooks/chat';
export const CHAT_ROUTE = `POST ${CHAT_PATH}`;
export const CHAT_SIGNATURE_HEADER = 'x-slack-signature';
export const CHAT_TIMESTAMP_HEADER = 'x-slack-request-timestamp';
export const CHAT_SKEW_SECONDS = 5 * 60;
export const CHAT_BODY_MAX = 64 * 1024;
export const CHAT_TASK_MAX = 20_000;                          // a ticket's body, as the API takes it
export const CHAT_SECRET_MIN = 16;
export const CHAT_LABEL = 'chat';
export const DEFAULT_REPLY_ORIGINS: readonly string[] = ['https://hooks.slack.com'];
export const CHAT_MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;

export const CHAT_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS chat_seen (signature TEXT PRIMARY KEY, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chat_launches (
  ticket TEXT PRIMARY KEY, chat_user TEXT NOT NULL, by_user TEXT NOT NULL, reply_url TEXT, at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS chat_replies (
  ticket TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (ticket, key)
)`,
];

export type ChatConfig = {
  readonly secret: string;
  readonly users: ReadonlyMap<string, UserId>;               // the chat's user id to the service's
  readonly replyOrigins: readonly string[];
  readonly language: Language;
  readonly appOrigin: string | undefined;                    // where the links point; none, no link
};

export class ChatConfigError extends Error {
  override name = 'ChatConfigError';
}

const origins = (value: string, name: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
  let url: URL;
  try { url = new URL(part); } catch { throw new ChatConfigError(`${name}: "${part}" is not an address such as https://hooks.slack.com`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ChatConfigError(`${name}: "${part}" is not an http or https address`);
  return url.origin;
});

// The chat's settings, or undefined when no secret file is named (the route is off).
export function loadChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig | undefined {
  const file = env.CLEARED_V2_CHAT_SECRET_FILE?.trim();
  if (!file) return undefined;
  let secret: string;
  try { secret = readFileSync(file, 'utf8').trim(); } catch { throw new ChatConfigError('CLEARED_V2_CHAT_SECRET_FILE: the file cannot be read'); }
  if (secret.length < CHAT_SECRET_MIN) throw new ChatConfigError(`CLEARED_V2_CHAT_SECRET_FILE: the secret holds fewer than ${CHAT_SECRET_MIN} characters`);
  const users = new Map<string, UserId>();
  for (const entry of (env.CLEARED_V2_CHAT_USERS ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = /^([^=\s]+)=([^=\s]+)$/.exec(entry);
    if (!match) throw new ChatConfigError(`CLEARED_V2_CHAT_USERS: "${entry}" is not <chat user id>=<user id>`);
    if (users.has(match[1] as string)) throw new ChatConfigError(`CLEARED_V2_CHAT_USERS: ${match[1]} is named twice`);
    users.set(match[1] as string, match[2] as UserId);
  }
  const replies = env.CLEARED_V2_CHAT_REPLY_ORIGINS?.trim();
  let app;
  try { app = readAppConfig(env); } catch (error) {
    if (error instanceof AppConfigError) throw new ChatConfigError(error.message);
    throw error;
  }
  return {
    secret, users, replyOrigins: replies ? origins(replies, 'CLEARED_V2_CHAT_REPLY_ORIGINS') : DEFAULT_REPLY_ORIGINS,
    language: app.language, appOrigin: app.publicOrigin ?? `http://${formatAddress(app.host, app.port)}`,
  };
}

// The signature a chat platform puts on a command.
export function chatSignature(secret: string, timestamp: string, body: Buffer | string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
}

// The task: the command's text after a leading mention (@cleared, or the
// chat's <@U...> form), with the chat's escapes of & < > undone.
export function taskOf(text: string): string {
  return text.trim().replace(/^(?:@cleared(?=\s|$)|<@[A-Z0-9]+(?:\|[^>]*)?>)\s*/i, '').trim()
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// A title of at most 200 characters, cut at a word; the whole task is then the body.
function titleOf(task: string): string {
  const line = (task.split('\n')[0] ?? '').trim();
  if (line.length <= BATCH_TITLE_MAX) return line;
  const cut = line.slice(0, BATCH_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The chat's own escapes, for a text that came from a person.
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type ChatReply = { readonly response_type: 'in_channel' | 'ephemeral'; readonly text: string; readonly replace_original?: false };
export type ChatPoster = (url: string, reply: ChatReply) => Promise<void>;
export type ChatAnswer = { readonly status: number; readonly body: unknown };

// Posts a reply as JSON, follows no redirect, gives up after ten seconds.
export const jsonPoster: ChatPoster = async (url, reply) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reply), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`the chat answered ${response.status}`);
};

// What the chat uses of the batches (flow/batch.ts BatchRunner) and of the flow.
export type ChatRunner = { create(input: { readonly tickets: unknown }, by: UserId, options?: { readonly min?: number }): Promise<Batch> };
export type ChatFlow = { subscribe(listener: FlowListener): () => void };

export type ChatDeps = {
  readonly db: DatabaseSync;
  readonly runner: ChatRunner;
  readonly flow: ChatFlow;
  readonly users: UserDirectory;
  readonly config: ChatConfig;
  readonly post?: ChatPoster;
  readonly now?: () => Date;
};

type Row = Record<string, unknown>;

const header = (headers: IncomingHttpHeaders | Record<string, string>, name: string): string | undefined => {
  const value = (headers as IncomingHttpHeaders)[name];
  return Array.isArray(value) ? value[0] : value;
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export class ChatLauncher {
  #deps: ChatDeps;
  #db: DatabaseSync;
  #now: () => Date;
  #post: ChatPoster;
  #t: Translate;
  #queue: Promise<void> = Promise.resolve();
  #unsubscribe: (() => void) | undefined;

  constructor(deps: ChatDeps) {
    this.#deps = deps;
    this.#db = deps.db;
    this.#now = deps.now ?? (() => new Date());
    this.#post = deps.post ?? jsonPoster;
    for (const table of CHAT_TABLES) this.#db.exec(table);
    const language = deps.config.language;
    const read = (lang: Language) => JSON.parse(readFileSync(`${CHAT_MESSAGES_DIR}chat.${lang}.json`, 'utf8')) as Record<string, string>;
    const catalog: Catalog = { ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) };
    this.#t = translator(catalog);
  }

  listen(): void {
    this.#unsubscribe ??= this.#deps.flow.subscribe((event) => this.#follow(event));
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.settled();
  }

  // Waits until every reply asked for so far is sent or has failed.
  async settled(): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== this.#queue) {
      seen = this.#queue;
      await seen;
    }
  }

  // ---- the command ---------------------------------------------------------------

  async command(raw: Buffer, headers: IncomingHttpHeaders | Record<string, string>): Promise<ChatAnswer> {
    const { config } = this.#deps;
    const now = this.#now();
    const timestamp = header(headers, CHAT_TIMESTAMP_HEADER) ?? '';
    const signature = header(headers, CHAT_SIGNATURE_HEADER) ?? '';
    if (!/^[0-9]{1,12}$/.test(timestamp) || Math.abs(now.getTime() / 1000 - Number(timestamp)) > CHAT_SKEW_SECONDS) return { status: 401, body: { error: 'unauthorized' } };
    const expected = Buffer.from(chatSignature(config.secret, timestamp, raw));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401, body: { error: 'unauthorized' } };
    // The five minutes bound what must be kept to refuse a replay.
    this.#db.prepare('DELETE FROM chat_seen WHERE at < ?').run(new Date(now.getTime() - 2 * CHAT_SKEW_SECONDS * 1000).toISOString());
    if (this.#db.prepare('INSERT OR IGNORE INTO chat_seen (signature, at) VALUES (?, ?)').run(signature, now.toISOString()).changes === 0)
      return { status: 409, body: { error: 'this command was already received' } };
    if (!(header(headers, 'content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded'))
      return { status: 400, body: { error: 'a command is form-encoded' } };

    const form = new URLSearchParams(raw.toString('utf8'));
    const replyUrl = form.get('response_url')?.trim() || null;
    if (replyUrl !== null && !this.#allowed(replyUrl)) return { status: 400, body: { error: 'the reply address is not allowed' } };
    const t = this.#t;
    const chatUser = form.get('user_id')?.trim() ?? '';
    const by = config.users.get(chatUser);
    if (!by || !(await this.#deps.users.get(by))) return { status: 200, body: this.#private(t('chat_unknown_user')) };
    const task = taskOf(form.get('text') ?? '');
    if (!task) return { status: 200, body: this.#private(t('chat_help')) };
    if (task.length > CHAT_TASK_MAX) return { status: 200, body: this.#private(t('chat_too_long', { max: CHAT_TASK_MAX })) };

    const title = titleOf(task);
    const batch = await this.#deps.runner.create({ tickets: [{ title, ...(title === task ? {} : { body: task }), labels: [CHAT_LABEL] }] }, by, { min: 1 });
    const item = batch.items[0];
    if (!item) throw new Error('the batch of one has no ticket');
    this.#db.prepare('INSERT OR REPLACE INTO chat_launches (ticket, chat_user, by_user, reply_url, at) VALUES (?, ?, ?, ?, ?)')
      .run(item.ticket, chatUser, by, replyUrl, now.toISOString());
    const link = config.appOrigin ? `${config.appOrigin}/` : undefined;
    const created = link
      ? t('chat_created_link', { ticket: item.ticket, title: escaped(item.title), link })
      : t('chat_created', { ticket: item.ticket, title: escaped(item.title) });
    return { status: 200, body: { response_type: 'in_channel', text: [created, this.#hold(batch)].filter(Boolean).join(' ') } satisfies ChatReply };
  }

  #private(text: string): ChatReply {
    return { response_type: 'ephemeral', text };
  }

  // What holds the ticket, said as the batch says it; nothing when it starts.
  #hold(batch: Batch): string {
    const hold = batch.hold;
    if (!hold || batch.items[0]?.state !== 'queued') return '';
    if (hold.reason === 'lanes') return this.#t('chat_waits_lanes', { running: hold.running, lanes: hold.lanes });
    const values = { percent: hold.percent, stop: hold.stop };
    return hold.window === 'seven_day' ? this.#t('chat_waits_seven_day', values) : this.#t('chat_waits_five_hour', values);
  }

  #allowed(address: string): boolean {
    let url: URL;
    try { url = new URL(address); } catch { return false; }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return false;
    return this.#deps.config.replyOrigins.includes(url.origin);
  }

  // ---- the replies that follow ------------------------------------------------------

  #follow(event: FlowEvent): void {
    if (event.type !== 'ticket_started' && event.type !== 'release_requested') return;
    const launch = this.#db.prepare('SELECT reply_url FROM chat_launches WHERE ticket = ?').get(event.ticket) as Row | undefined;
    const replyUrl = launch?.reply_url;
    if (typeof replyUrl !== 'string' || !this.#allowed(replyUrl)) return;
    const key = event.type === 'ticket_started' ? `session:${event.session}` : `pr:${event.pr}`;
    if (this.#db.prepare('INSERT OR IGNORE INTO chat_replies (ticket, key, at) VALUES (?, ?, ?)').run(event.ticket, key, this.#now().toISOString()).changes === 0) return;
    const text = event.type === 'ticket_started' ? this.#started(event.ticket, event.session) : this.#t('chat_pr', { pr: String(event.pr), ticket: event.ticket, url: event.url });
    this.#send(event.ticket, replyUrl, { response_type: 'in_channel', replace_original: false, text });
  }

  #started(ticket: TicketId, session: string): string {
    const origin = this.#deps.config.appOrigin;
    return origin
      ? this.#t('chat_started_link', { ticket, link: `${origin}/sessions/${encodeURIComponent(session)}` })
      : this.#t('chat_started', { ticket });
  }

  // One reply at a time, in the order the flow said them; a reply that
  // fails is logged by its error's name (a message may carry an address).
  #send(ticket: TicketId, url: string, reply: ChatReply): void {
    this.#queue = this.#queue.then(() => this.#post(url, reply)).catch((error: unknown) => {
      console.error(`cleared-v2: a chat reply for ${ticket} could not be sent (${errorName(error)})`);
    });
  }
}

// ---- the route ---------------------------------------------------------------------

export type ChatRoutesDeps = {
  readonly config: () => ChatConfig | undefined;
  readonly launcher: (registry: Registry) => ChatLauncher | undefined;
};

// What is read past the limit is dropped, so the answer reaches the client;
// a body far past it ends the connection.
async function readRaw(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 16 * CHAT_BODY_MAX) { request.destroy(); return undefined; }
    if (size <= CHAT_BODY_MAX) chunks.push(chunk as Buffer);
  }
  return size > CHAT_BODY_MAX ? undefined : Buffer.concat(chunks);
}

function answer(context: RouteContext, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  context.response.end(text);
}

// POST /hooks/chat: off (404) without a secret, 503 without a flow, then the command's own checks.
export function chatRoutes(deps: ChatRoutesDeps): Route[] {
  return [{
    method: 'POST', path: CHAT_PATH,
    handle: async (context) => {
      if (!deps.config()) return answer(context, 404, { error: 'not found' });
      const launcher = deps.launcher(context.registry);
      if (!launcher) return answer(context, 503, { error: 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md' });
      const raw = await readRaw(context.request);
      if (!raw) return answer(context, 413, { error: 'the request body is too large' });
      const result = await launcher.command(raw, context.request.headers);
      answer(context, result.status, result.body);
    },
  }];
}
