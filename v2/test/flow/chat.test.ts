// A ticket launched from a chat (P212): a signed slash command
// "@cleared <task>" on POST /hooks/chat creates a ticket in the service's
// project, answers at once with the ticket, then posts its session's link
// and its pull request's link to the command's reply address. Driven by a
// fake chat client (chat-client.ts) over loopback; no chat account.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Levers } from '../../src/consumption/levers.ts';
import { BatchRunner } from '../../src/flow/batch.ts';
import { CHAT_PATH, CHAT_ROUTE, CHAT_TASK_MAX, ChatConfigError, ChatLauncher, chatRoutes, jsonPoster, loadChatConfig, taskOf, type ChatConfig } from '../../src/flow/chat.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import type { FlowListener } from '../../src/flow/events.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { Batch } from '../../src/api/types.ts';
import { FakeChatClient } from './chat-client.ts';
import { REPORT_PASS, authorScript, quickAuthor, reviewerScript, setup, until, type Setup } from './support.ts';

const SIGNING = 'fake-chat-signing-value-for-tests-only';
const OTHER = 'another-fake-value-not-the-one';
const APP = 'https://cleared.example.test';

type Served = { t: Setup; runner: BatchRunner; launcher: ChatLauncher; client: FakeChatClient; url: string; close: () => Promise<void> };
const open: Served[] = [];
after(async () => { for (const served of open) await served.close(); });

function config(client: FakeChatClient, overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    secret: SIGNING, users: new Map([['U0TEST1', 'u1'], ['U0TEST2', 'ghost']]), replyOrigins: [client.origin],
    language: 'en', appOrigin: APP, ...overrides,
  };
}

async function serve(options: { t?: Setup; config?: Partial<ChatConfig>; off?: boolean; lanes?: number } = {}): Promise<Served> {
  const t = options.t ?? await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  const client = new FakeChatClient({ secret: SIGNING, now: () => t.clock.now });
  await client.open();
  const levers = { read: (): Levers => ({ model: null, maxLanes: options.lanes ?? null, paused: false }) };
  const runner = new BatchRunner({ db: t.store.db, tickets: t.tickets, flow: t.engine, project: 'guestbook', levers, weekStopPercent: 85, now: () => new Date(t.clock.now) });
  runner.listen();
  const chat = config(client, options.config);
  const launcher = new ChatLauncher({ db: t.store.db, runner, flow: t.engine, users: t.users, config: chat, now: () => new Date(t.clock.now) });
  launcher.listen();
  const routes = chatRoutes({ config: () => (options.off ? undefined : chat), launcher: () => (options.off ? undefined : launcher) });
  const app: App = { registry: t.engine.registry, tables: [], routes };
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CHAT_PATH}`;
  const served: Served = {
    t, runner, launcher, client, url,
    close: async () => {
      await launcher.close();
      await runner.close();
      await t.engine.settled();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.close();
    },
  };
  open.push(served);
  return served;
}

const chatTickets = async (t: Setup) => (await t.tickets.list({ project: 'guestbook' })).filter((ticket) => ticket.labels.includes('chat'));

test('the route is POST /hooks/chat, outside the app\'s API', () => {
  assert.equal(CHAT_PATH, '/hooks/chat');
  assert.equal(CHAT_ROUTE, 'POST /hooks/chat');
  const routes = chatRoutes({ config: () => undefined, launcher: () => undefined });
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), [CHAT_ROUTE]);
});

test('a signed "@cleared <task>" creates a ticket in the service\'s project, answers with it at once, then posts its session\'s link and its pull request\'s link', async () => {
  const s = await serve();
  const answer = await s.client.send(s.url, { text: '@cleared Show the newest entry first' });
  assert.equal(answer.status, 200);
  const [ticket, ...others] = await chatTickets(s.t);
  assert.ok(ticket, 'one ticket');
  assert.equal(others.length, 0);
  assert.equal(ticket.title, 'Show the newest entry first');
  assert.equal(ticket.project, 'guestbook');
  assert.ok(ticket.labels.some((label) => label.startsWith('batch:')), 'it is started as a batch of one, within the lanes and the stop');
  assert.deepEqual(answer.json, { response_type: 'in_channel', text: `Ticket ${ticket.id} created: Show the newest entry first. It is on the Tower: ${APP}/` });

  await until(() => s.t.flowEvents.some((e) => e.type === 'release_requested'), 'the release request', 5000);
  await s.t.engine.settled();
  await s.launcher.settled();
  const session = s.t.startedSessions[0]!.id;
  const posted = s.client.posted.map((p) => [p.path, p.body]);
  assert.deepEqual(posted, [
    ['/reply/1', { response_type: 'in_channel', replace_original: false, text: `${ticket.id} has started: ${APP}/sessions/${session}` }],
    ['/reply/1', { response_type: 'in_channel', replace_original: false, text: `Pull request #7 of ${ticket.id}: https://example.invalid/pull/7. It waits for an approval in the Inbox.` }],
  ]);
});

test('without a signing secret the route is off: 404, and nothing is created', async () => {
  const s = await serve({ off: true });
  const answer = await s.client.send(s.url, { text: '@cleared Anything' });
  assert.equal(answer.status, 404);
  assert.deepEqual(await chatTickets(s.t), []);
});

test('a command with no signature, a wrong one, one of another secret, or a timestamp more than five minutes off is refused, before anything is read', async () => {
  const s = await serve();
  const now = Math.floor(s.t.clock.now / 1000);
  const refused = [
    { text: 'one', signature: null },
    { text: 'two', signature: 'v0=' + '0'.repeat(64) },
    { text: 'three', signature: 'v1=abc' },
    { text: 'four', secret: OTHER },
    { text: 'five', timestamp: now - 301 },
    { text: 'six', timestamp: now + 301 },
  ];
  for (const command of refused) {
    const answer = await s.client.send(s.url, command);
    assert.equal(answer.status, 401, command.text);
    assert.equal(answer.raw.includes(SIGNING), false);
  }
  const noTimestamp = s.client.sign({ text: 'seven' });
  delete noTimestamp.headers['x-slack-request-timestamp'];
  assert.equal((await s.client.resend(s.url, noTimestamp)).status, 401);
  assert.equal((await s.client.send(s.url, { text: 'eight', timestamp: now - 299 })).status, 200, 'within the five minutes');
  assert.deepEqual((await chatTickets(s.t)).map((ticket) => ticket.title), ['eight']);
});

test('the same signed command sent twice is refused the second time: one ticket', async () => {
  const s = await serve();
  const first = await s.client.send(s.url, { text: '@cleared Once only' });
  assert.equal(first.status, 200);
  const again = await s.client.resend(s.url, first.sent);
  assert.equal(again.status, 409);
  assert.equal((await chatTickets(s.t)).length, 1);
});

test('a chat user not linked, or linked to a user the service does not know, is told so and creates nothing', async () => {
  const s = await serve();
  for (const user of ['U0NOBODY', 'U0TEST2']) {
    const answer = await s.client.send(s.url, { text: '@cleared Do it', user });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { response_type: 'ephemeral', text: 'This chat account is not linked to a Cleared user: ask the owner to add it to CLEARED_V2_CHAT_USERS.' });
  }
  assert.deepEqual(await chatTickets(s.t), []);
  assert.deepEqual(s.client.posted, []);
});

test('an empty task gets the help, in English and in French, and creates nothing', async () => {
  const en = await serve();
  for (const text of ['', '   ', '@cleared', '<@U0BOT>', '<@U0BOT|cleared>  ']) {
    const answer = await en.client.send(en.url, { text });
    assert.equal(answer.status, 200, text);
    assert.deepEqual(answer.json, { response_type: 'ephemeral', text: 'Write the task after the command, for example: @cleared show the newest entry first.' }, text);
  }
  const fr = await serve({ config: { language: 'fr' } });
  const answer = await fr.client.send(fr.url, { text: '@cleared' });
  assert.deepEqual(answer.json, { response_type: 'ephemeral', text: 'Écrivez la tâche après la commande, par exemple : @cleared afficher la dernière entrée en premier.' });
  assert.deepEqual(await chatTickets(en.t), []);
  assert.deepEqual(await chatTickets(fr.t), []);
});

test('the answers are in French when the app is', async () => {
  const s = await serve({ config: { language: 'fr' } });
  const answer = await s.client.send(s.url, { text: '@cleared Trier les entrées' });
  const [ticket] = await chatTickets(s.t);
  assert.deepEqual(answer.json, { response_type: 'in_channel', text: `Ticket ${ticket!.id} créé : Trier les entrées. Il est dans la Tour : ${APP}/` });
  await until(() => s.client.posted.length === 2, 'the two replies', 5000);
  assert.match(String(s.client.posted[0]!.body.text), new RegExp(`^${ticket!.id} a démarré : ${APP}/sessions/`));
  assert.equal(s.client.posted[1]!.body.text, `Pull request #7 de ${ticket!.id} : https://example.invalid/pull/7. Elle attend une approbation dans la Réception.`);
  const unknown = await s.client.send(s.url, { text: 'x', user: 'U0NOBODY' });
  assert.equal(unknown.json?.text, 'Ce compte de chat n\'est lié à aucun utilisateur de Cleared : demandez au propriétaire de l\'ajouter à CLEARED_V2_CHAT_USERS.');
});

test('a reply address outside the allowed origins, or not http, is refused before any ticket, and nothing is posted there', async () => {
  const s = await serve();
  for (const responseUrl of ['https://elsewhere.example.test/hook', 'file:///etc/hostname', 'not a url', `${s.client.origin.replace('127.0.0.1', 'localhost')}/reply/9`]) {
    const answer = await s.client.send(s.url, { text: '@cleared Sneaky', responseUrl });
    assert.equal(answer.status, 400, responseUrl);
  }
  assert.deepEqual(await chatTickets(s.t), []);
  assert.deepEqual(s.client.posted, []);
});

test('a command with no reply address creates the ticket and posts nothing later', async () => {
  const s = await serve();
  const answer = await s.client.send(s.url, { text: '@cleared Quietly', responseUrl: null });
  assert.equal(answer.status, 200);
  assert.equal((await chatTickets(s.t)).length, 1);
  await until(() => s.t.flowEvents.some((e) => e.type === 'release_requested'), 'the release request', 5000);
  await s.launcher.settled();
  assert.deepEqual(s.client.posted, []);
});

test('a ticket that waits for a lane says so in the answer', async () => {
  const t = await setup({ scripts: { authors: [authorScript], author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.startedSessions.length === 1, 'the first session');
  const s = await serve({ t, lanes: 1 });
  const answer = await s.client.send(s.url, { text: '@cleared Later' });
  const [ticket] = await chatTickets(t);
  assert.equal(ticket!.status, 'Todo');
  assert.equal(answer.json?.text, `Ticket ${ticket!.id} created: Later. It is on the Tower: ${APP}/ It waits for a free lane (1 in use, 1 allowed).`);
});

test('a long task becomes a title of at most 200 characters, cut at a word, and the whole task is the body', async () => {
  const s = await serve();
  const task = `${'word '.repeat(60)}end`;
  assert.equal((await s.client.send(s.url, { text: `@cleared ${task}` })).status, 200);
  const [ticket] = await chatTickets(s.t);
  assert.ok(ticket!.title.length <= 200);
  assert.ok(ticket!.title.endsWith('word…'), ticket!.title);
  assert.equal(ticket!.body, task);
  const tooLong = await s.client.send(s.url, { text: 'x'.repeat(CHAT_TASK_MAX + 1) });
  assert.equal(tooLong.status, 200);
  assert.deepEqual(tooLong.json, { response_type: 'ephemeral', text: 'The task is at most 20,000 characters.' });
  assert.equal((await chatTickets(s.t)).length, 1);
});

test('a body over 64 KB is refused with a 413', async () => {
  const s = await serve();
  const sent = s.client.sign({ text: 'y'.repeat(70 * 1024) });
  assert.equal((await s.client.resend(s.url, sent)).status, 413);
  assert.deepEqual(await chatTickets(s.t), []);
});

test('the task is the text after the mention, with the chat\'s escapes undone', () => {
  assert.equal(taskOf('@cleared fix it'), 'fix it');
  assert.equal(taskOf('  @Cleared   fix it  '), 'fix it');
  assert.equal(taskOf('<@U0BOT> fix it'), 'fix it');
  assert.equal(taskOf('<@U0BOT|cleared> fix &lt;b&gt; &amp; more'), 'fix <b> & more');
  assert.equal(taskOf('fix it'), 'fix it');
  assert.equal(taskOf('@clearedx fix'), '@clearedx fix');
  assert.equal(taskOf('@cleared'), '');
});

// A flow that only says what the test emits, and a runner that only records.
function fakes() {
  const listeners = new Set<FlowListener>();
  const flow = { subscribe: (listener: FlowListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const emit = async (event: FlowEvent) => { for (const listener of listeners) await listener(event); };
  let seq = 0;
  const runner = {
    async create(input: { readonly tickets: unknown }, by: string): Promise<Batch> {
      seq++;
      const [first] = input.tickets as { title: string }[];
      return { id: `batch-${seq}`, project: 'guestbook', by, at: '2026-10-21T10:00:00.000Z', lanes: 3, running: 0, hold: null, items: [{ position: 1, ticket: `LOCAL-${seq}`, title: first!.title, state: 'queued', status: 'Todo', note: null }] };
    },
  };
  return { flow, emit, runner, listeners };
}

test('a launch is kept in the ledger: a launcher built after a restart posts the links, each once, and only for its tickets', async () => {
  const t = await setup();
  const client = new FakeChatClient({ secret: SIGNING, now: () => t.clock.now });
  await client.open();
  try {
    const f = fakes();
    const chat = config(client);
    const first = new ChatLauncher({ db: t.store.db, runner: f.runner, flow: f.flow, users: t.users, config: chat, now: () => new Date(t.clock.now) });
    first.listen();
    const sent = client.sign({ text: '@cleared Survive a restart' });
    const answer = await first.command(Buffer.from(sent.body), sent.headers);
    assert.equal(answer.status, 200);
    await first.close();
    assert.equal(f.listeners.size, 0, 'closed: no longer listening');

    const second = new ChatLauncher({ db: t.store.db, runner: f.runner, flow: f.flow, users: t.users, config: chat, now: () => new Date(t.clock.now) });
    second.listen();
    const base = { at: '2026-10-21T10:01:00.000Z', project: 'guestbook' };
    await f.emit({ ...base, type: 'ticket_started', ticket: 'LOCAL-9', by: 'u1', origin: null, session: 's-other' });
    await f.emit({ ...base, type: 'ticket_started', ticket: 'LOCAL-1', by: 'u1', origin: null, session: 's-1' });
    await f.emit({ ...base, type: 'ticket_started', ticket: 'LOCAL-1', by: 'u1', origin: null, session: 's-1' });
    await f.emit({ ...base, type: 'release_requested', ticket: 'LOCAL-1', session: 's-1', item: 'release:LOCAL-1', pr: 12, url: 'https://example.invalid/pull/12' });
    await f.emit({ ...base, type: 'release_requested', ticket: 'LOCAL-1', session: 's-1', item: 'release:LOCAL-1', pr: 12, url: 'https://example.invalid/pull/12' });
    await second.settled();
    assert.deepEqual(client.posted.map((p) => p.body.text), [
      `LOCAL-1 has started: ${APP}/sessions/s-1`,
      'Pull request #12 of LOCAL-1: https://example.invalid/pull/12. It waits for an approval in the Inbox.',
    ]);
    // A third launcher over the same ledger sends nothing again.
    await second.close();
    const third = new ChatLauncher({ db: t.store.db, runner: f.runner, flow: f.flow, users: t.users, config: chat, now: () => new Date(t.clock.now) });
    third.listen();
    await f.emit({ ...base, type: 'release_requested', ticket: 'LOCAL-1', session: 's-1', item: 'release:LOCAL-1', pr: 12, url: 'https://example.invalid/pull/12' });
    await third.settled();
    assert.equal(client.posted.length, 2);
    await third.close();
  } finally {
    await client.close();
  }
});

test('without an app address the answers name the ticket and the session without a link', async () => {
  const t = await setup();
  const client = new FakeChatClient({ secret: SIGNING, now: () => t.clock.now });
  await client.open();
  try {
    const f = fakes();
    const launcher = new ChatLauncher({ db: t.store.db, runner: f.runner, flow: f.flow, users: t.users, config: config(client, { appOrigin: undefined }), now: () => new Date(t.clock.now) });
    launcher.listen();
    const sent = client.sign({ text: 'No link' });
    const answer = await launcher.command(Buffer.from(sent.body), sent.headers);
    assert.deepEqual(answer.body, { response_type: 'in_channel', text: 'Ticket LOCAL-1 created: No link.' });
    await f.emit({ at: '2026-10-21T10:01:00.000Z', project: 'guestbook', type: 'ticket_started', ticket: 'LOCAL-1', by: 'u1', origin: null, session: 's-1' });
    await launcher.settled();
    assert.deepEqual(client.posted.map((p) => p.body.text), ['LOCAL-1 has started.']);
    await launcher.close();
  } finally {
    await client.close();
  }
});

test('a reply that fails is logged by its error\'s name and does not stop the next one', async () => {
  const t = await setup();
  const client = new FakeChatClient({ secret: SIGNING, now: () => t.clock.now });
  await client.open();
  const errors: string[] = [];
  const log = console.error;
  console.error = (line: unknown) => { errors.push(String(line)); };
  try {
    const f = fakes();
    let calls = 0;
    const post = async () => { calls++; if (calls === 1) throw new TypeError('connect ECONNREFUSED with a path /home/x'); };
    const launcher = new ChatLauncher({ db: t.store.db, runner: f.runner, flow: f.flow, users: t.users, config: config(client), post, now: () => new Date(t.clock.now) });
    launcher.listen();
    const sent = client.sign({ text: 'Fragile' });
    await launcher.command(Buffer.from(sent.body), sent.headers);
    const base = { at: '2026-10-21T10:01:00.000Z', project: 'guestbook', ticket: 'LOCAL-1' };
    await f.emit({ ...base, type: 'ticket_started', by: 'u1', origin: null, session: 's-1' });
    await f.emit({ ...base, type: 'release_requested', session: 's-1', item: 'release:LOCAL-1', pr: 3, url: 'https://example.invalid/pull/3' });
    await launcher.settled();
    assert.equal(calls, 2);
    assert.deepEqual(errors, ['cleared-v2: a chat reply for LOCAL-1 could not be sent (TypeError)']);
    await launcher.close();
  } finally {
    console.error = log;
    await client.close();
  }
});

test('the poster sends JSON and follows no redirect', async () => {
  let hits = 0;
  const target = createServer((request, response) => {
    hits++;
    if (request.url === '/moved') { response.writeHead(302, { location: '/elsewhere' }); response.end(); return; }
    response.writeHead(200); response.end();
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  try {
    await jsonPoster(`${base}/ok`, { response_type: 'in_channel', text: 'hi' });
    assert.equal(hits, 1);
    await assert.rejects(jsonPoster(`${base}/moved`, { response_type: 'in_channel', text: 'hi' }));
    assert.equal(hits, 2, 'the redirect was not followed');
  } finally {
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test('the configuration: off without a secret file; the secret, the users, the reply origins, the language and the app\'s address read from the environment', () => {
  assert.equal(loadChatConfig({}), undefined);
  const dir = mkdtempSync(join(tmpdir(), 'cleared-chat-'));
  const file = join(dir, 'chat-secret');
  writeFileSync(file, `${SIGNING}\n`);
  const chat = loadChatConfig({ CLEARED_V2_CHAT_SECRET_FILE: file, CLEARED_V2_CHAT_USERS: 'U0TEST1=u1, U0TEST3=u3' });
  assert.ok(chat);
  assert.equal(chat.secret, SIGNING);
  assert.deepEqual([...chat.users], [['U0TEST1', 'u1'], ['U0TEST3', 'u3']]);
  assert.deepEqual(chat.replyOrigins, ['https://hooks.slack.com']);
  assert.equal(chat.language, 'fr');
  assert.equal(chat.appOrigin, 'http://127.0.0.1:8792');
  const set = loadChatConfig({
    CLEARED_V2_CHAT_SECRET_FILE: file, CLEARED_V2_CHAT_REPLY_ORIGINS: 'https://chat.example.test, http://127.0.0.1:9999/ignored/path',
    CLEARED_V2_APP_LANGUAGE: 'en', CLEARED_V2_APP_ORIGIN: 'https://cleared.example.test:8443/x',
  });
  assert.deepEqual(set?.replyOrigins, ['https://chat.example.test', 'http://127.0.0.1:9999']);
  assert.equal(set?.language, 'en');
  assert.equal(set?.appOrigin, 'https://cleared.example.test:8443');
  assert.deepEqual([...(set?.users ?? [])], []);

  const short = join(dir, 'short');
  writeFileSync(short, 'tooshort');
  const bad: NodeJS.ProcessEnv[] = [
    { CLEARED_V2_CHAT_SECRET_FILE: join(dir, 'missing') },
    { CLEARED_V2_CHAT_SECRET_FILE: short },
    { CLEARED_V2_CHAT_SECRET_FILE: file, CLEARED_V2_CHAT_USERS: 'U0TEST1' },
    { CLEARED_V2_CHAT_SECRET_FILE: file, CLEARED_V2_CHAT_USERS: 'U0TEST1=u1,U0TEST1=u2' },
    { CLEARED_V2_CHAT_SECRET_FILE: file, CLEARED_V2_CHAT_REPLY_ORIGINS: 'ftp://chat.example.test' },
    { CLEARED_V2_CHAT_SECRET_FILE: file, CLEARED_V2_CHAT_REPLY_ORIGINS: 'nonsense' },
  ];
  for (const env of bad) {
    assert.throws(() => loadChatConfig(env), (error: unknown) => error instanceof ChatConfigError && !String((error as Error).message).includes(SIGNING), JSON.stringify(env));
  }
});
