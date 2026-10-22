// The session screen's fixture: the data of session.png that milestone 1
// carries, stored as the service would store it (events through the cleaner
// into an in-memory log), and a stand-in for the service's session routes
// that the tests and the visual loop run the screen against.
//
// It is not wired into fixtures/source.ts, which lane 6 owns and which
// serves the tower's thinner sessions: `sessionSource` is what a test, or
// the capture script, hands to the app as its DataSource.
//
// Names are neutral, as the tower's are: the example guestbook, ticket
// LOCAL-161 of the tower fixture, with the same title and the same
// `npm install date-fns` request, so the two screens tell one story. What
// session.png shows and milestone 1 has no carrier for is left out: the
// plan of the session, the "briefed with" line, the share of the week and
// the picture of the example app (decisions log, 2026-10-21).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sseFrame, type InboxItem, type SessionDetail, type SessionSummary } from '../../src/api/types.ts';
import { createCleaner } from '../../src/session/clean.ts';
import type { AgUiEvent, Question, SessionEvent, SessionState } from '../../src/session/events.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { emptyModel, applyAll } from '../web/screens/session/model.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
import { FIXTURE_NOW, FIXTURE_PROJECT } from './tower.ts';

export const AUTHOR_ID = 'fixture-author';
export const TICKET_ID = 'LOCAL-161';
export const TICKET_TITLE = 'Upcoming: group entries by week';
export const TICKET_BODY = `The upcoming list becomes a weekly agenda. Each week has a heading, and a month starts a new section.

- [x] Entries grouped by week, Monday first
- [x] A month starts a new section
- [ ] Same totals as today, a test proves it
- [ ] Screens at 1440 and 390`;

export const REQUEST_ID = 'request-161';
export const QUESTION_TEXT = 'Weeks start on Monday in France. Should a week that spans two months appear under the first month or be split?';
export const ANSWER_TEXT = 'Under the first month, never split.';
export const USER = 'user-demo';

// The same story with the author's question asked through AskUserQuestion
// instead of in a message, waiting with its three options (the clickable
// answers' fixture: `sessionFixture(now, { question: true })`).
export const QUESTION_REQUEST_ID = 'question-161';
export const MONTH_QUESTION: Question = {
  question: QUESTION_TEXT,
  header: 'Month edges',
  options: [
    { label: 'Under the first month (Recommended)', description: 'One heading per week, as the list reads today.' },
    { label: 'Split at the month\'s end', description: 'Two half weeks, each under its own month.' },
    { label: 'Under the month with more days' },
  ],
};

export type SessionFixture = {
  readonly store: Store;
  readonly project: string;
  readonly now: Date;
  readonly ticket: Ticket;
  readonly sessions: SessionSummary[];
  readonly inbox: InboxItem[];
};

const MINUTE = 60_000;

const text = (messageId: string, role: 'assistant' | 'user', delta: string, name?: string): AgUiEvent[] => [
  { type: 'TEXT_MESSAGE_START', messageId, role, ...(name ? { name } : {}) },
  { type: 'TEXT_MESSAGE_CONTENT', messageId, delta },
  { type: 'TEXT_MESSAGE_END', messageId },
];

const call = (id: string, name: string, input: object, result: object): AgUiEvent[] => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(input) },
  { type: 'TOOL_CALL_END', toolCallId: id },
  { type: 'TOOL_CALL_RESULT', messageId: `${id}-result`, toolCallId: id, content: JSON.stringify(result), role: 'tool' },
];

const delta = (values: Record<string, unknown>): AgUiEvent =>
  ({ type: 'STATE_DELTA', delta: Object.entries(values).map(([key, value]) => ({ op: 'replace', path: `/${key}`, value })) });

// Stores events as the adapter would: through the cleaner, each with its time.
export class Player {
  readonly #cleaner = createCleaner();
  readonly #store: Store;
  readonly #session: string;
  readonly #ticket: string;
  readonly #project: string;

  constructor(store: Store, session: string, ticket: string, project: string) {
    this.#store = store;
    this.#session = session;
    this.#ticket = ticket;
    this.#project = project;
  }

  play(at: Date, ...events: readonly (AgUiEvent | readonly AgUiEvent[])[]): SessionEvent[] {
    const stored: SessionEvent[] = [];
    for (const event of events.flat()) {
      for (const clean of this.#cleaner.clean(event)) {
        stored.push(this.#store.events.append({ at: at.toISOString(), sessionId: this.#session, ticket: this.#ticket, project: this.#project, event: clean }));
      }
    }
    return stored;
  }
}

export function sessionFixture(now: Date = FIXTURE_NOW, options: { readonly question?: boolean } = {}): SessionFixture {
  const project = FIXTURE_PROJECT;
  const store = openStore(':memory:');
  const start = new Date(now.getTime() - 18 * MINUTE);
  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);
  const player = new Player(store, AUTHOR_ID, TICKET_ID, project);
  const usage = { model: 'claude-opus-5-5', inputTokens: 31_200, outputTokens: 4_300 };
  const steps = (waitingSince: Date | null): SessionState['steps'] => [
    { name: 'workspace', startedAt: at(-1).toISOString(), finishedAt: start.toISOString() },
    { name: 'author', startedAt: start.toISOString(), finishedAt: null },
    ...(waitingSince ? [{ name: 'waiting_human' as const, startedAt: waitingSince.toISOString(), finishedAt: null }] : []),
  ];

  player.play(at(-1), { type: 'STEP_STARTED', stepName: 'workspace' });
  player.play(start,
    { type: 'STEP_FINISHED', stepName: 'workspace' },
    { type: 'STEP_STARTED', stepName: 'author' },
    { type: 'RUN_STARTED', threadId: AUTHOR_ID, runId: 'turn-1' },
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'Reading src/screens/Upcoming.jsx', phase: 'working', steps: steps(null), files: [], checks: [{ name: 'Targeted tests', state: 'pending' }, { name: 'Full suite', state: 'pending' }], usage } },
    text('prompt-1', 'user', `${TICKET_TITLE}\n\n${TICKET_BODY}`, 'cleared'),
    call('read-1', 'Read', { kind: 'read', path: 'src/screens/Upcoming.jsx' }, { kind: 'read', path: 'src/screens/Upcoming.jsx', bytes: 2210 }),
    call('read-2', 'Read', { kind: 'read', path: 'test/upcoming.test.mjs' }, { kind: 'read', path: 'test/upcoming.test.mjs', bytes: 1480 }),
    call('read-3', 'Read', { kind: 'read', path: 'test/screens.test.mjs' }, { kind: 'read', path: 'test/screens.test.mjs', bytes: 960 }),
  );
  player.play(at(2),
    call('edit-1', 'Edit', { kind: 'edit', path: 'src/engine/upcoming.mjs', added: 24, removed: 6 }, { kind: 'edit', ok: true }),
    delta({ files: [{ path: 'src/engine/upcoming.mjs', added: 24, removed: 6 }] }),
  );
  player.play(at(4),
    call('run-1', 'Bash', { kind: 'execute', command: 'npm run test:upcoming', description: 'Run the upcoming tests' }, { kind: 'execute', output: '# tests 18\n# pass 18\n# fail 0\n', cut: 0, isError: false }),
    delta({ checks: [{ name: 'Targeted tests', state: 'passed' }, { name: 'Full suite', state: 'pending' }] }),
  );
  if (!options.question) {
    player.play(at(8), text('assistant-1', 'assistant', QUESTION_TEXT));
    player.play(at(9), text('user-1', 'user', ANSWER_TEXT, USER));
  }
  player.play(at(10),
    call('edit-2', 'Edit', { kind: 'edit', path: 'src/screens/Upcoming.jsx', added: 41, removed: 12 }, { kind: 'edit', ok: true }),
    delta({ files: [{ path: 'src/engine/upcoming.mjs', added: 24, removed: 6 }, { path: 'src/screens/Upcoming.jsx', added: 41, removed: 12 }, { path: 'test/upcoming.test.mjs', added: 38, removed: 0 }] }),
  );
  if (options.question) player.play(at(15),
    { type: 'CUSTOM', name: 'cleared.question', value: { requestId: QUESTION_REQUEST_ID, questions: [MONTH_QUESTION] } },
    delta({ phase: 'waiting_human', status: 'Waiting for you', steps: steps(at(15)) }),
  );
  else player.play(at(15),
    { type: 'TOOL_CALL_START', toolCallId: 'run-2', toolCallName: 'Bash' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'run-2', delta: JSON.stringify({ kind: 'execute', command: 'npm install date-fns', description: 'Install date-fns to group dates by week' }) },
    {
      type: 'CUSTOM', name: 'cleared.permission_request', value: {
        requestId: REQUEST_ID, toolCallId: 'run-2', tool: 'Bash',
        input: { kind: 'execute', command: 'npm install date-fns', description: 'Install date-fns to group dates by week' },
        suggestion: { decision: 'ask', rule: 'install.package', reason: 'Network access and a new dependency.' },
      },
    },
    delta({ phase: 'waiting_human', status: 'Waiting for you', steps: steps(at(15)) }),
  );

  const events = store.events.after(AUTHOR_ID);
  const last = events[events.length - 1] as SessionEvent;
  const author: SessionSummary = {
    id: AUTHOR_ID, project, ticket: TICKET_ID, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'waiting_human',
    status: 'Waiting for you', startedAt: start.toISOString(), updatedAt: last.at, lastSeq: last.seq,
  };
  const ticket: Ticket = {
    id: TICKET_ID, title: TICKET_TITLE, body: TICKET_BODY, labels: [], project, status: 'In Progress',
    createdAt: new Date(now.getTime() - 20 * MINUTE).toISOString(), updatedAt: start.toISOString(),
  };
  const inbox: InboxItem[] = options.question ? [{
    kind: 'question', id: 'question-item-161', ticket: TICKET_ID, project, since: at(15).toISOString(), state: 'waiting', sessionId: AUTHOR_ID, requestId: QUESTION_REQUEST_ID, questions: [MONTH_QUESTION],
  }] : [{
    kind: 'permission', id: 'permission-161', ticket: TICKET_ID, project, since: at(15).toISOString(), state: 'waiting', sessionId: AUTHOR_ID, requestId: REQUEST_ID, tool: 'Bash',
    input: { kind: 'execute', command: 'npm install date-fns', description: 'Install date-fns to group dates by week' },
    suggestion: { decision: 'ask', rule: 'install.package', reason: 'Network access and a new dependency.' },
  }];
  return { store, project, now, ticket, sessions: [author], inbox };
}

// The session as the service answers GET /api/sessions/:id: the summary and
// the state the stored events add up to.
export function detailOf(fixture: SessionFixture, id: string): SessionDetail | undefined {
  const summary = fixture.sessions.find((s) => s.id === id);
  if (!summary) return undefined;
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(id));
  const state = model.state ?? { status: summary.status, phase: summary.phase, steps: [], files: [], checks: [], usage: {} };
  return { ...summary, phase: state.phase, status: state.status, state };
}

export type Call = { readonly method: string; readonly path: string; readonly user: string; readonly body: unknown };
export type SessionSource = DataSource & { readonly calls: Call[] };

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(undefined); } });
    request.on('error', () => resolve(undefined));
  });
}

// The session routes of the service API, over the fixture. A write is
// recorded in `calls` and stored as the event the service would store, so a
// reload shows it: an answer to a question as `cleared.answered`, to a
// permission as `cleared.permission_answered`, and an interrupt cancels
// what waits as the adapters do. The stream answers the events after
// `?after=` and ends.
export function sessionSource(fixture: SessionFixture, options: { readonly now?: () => Date } = {}): SessionSource {
  const calls: Call[] = [];
  const now = options.now ?? (() => new Date());
  const players = new Map<string, Player>();
  const player = (id: string): Player => {
    let found = players.get(id);
    if (!found) {
      found = new Player(fixture.store, id, TICKET_ID, fixture.project);
      players.set(id, found);
    }
    return found;
  };

  async function handle(request: IncomingMessage, response: ServerResponse, method: string, url: URL, user: string): Promise<void> {
    const parts = url.pathname.split('/').slice(2);
    const [collection, id, sub, requestId, action] = parts;
    if (method === 'GET' && collection === 'inbox') return sendJson(response, 200, fixture.inbox);
    if (method === 'GET' && collection === 'tickets') {
      if (parts.length === 1) return sendJson(response, 200, [fixture.ticket]);
      return id === fixture.ticket.id ? sendJson(response, 200, fixture.ticket) : sendJson(response, 404, { error: 'no such ticket' });
    }
    if (collection !== 'sessions') return sendJson(response, 404, { error: 'not in the fixtures' });
    if (method === 'GET' && parts.length === 1) return sendJson(response, 200, fixture.sessions);
    const detail = id ? detailOf(fixture, id) : undefined;
    if (!detail) return sendJson(response, 404, { error: 'no such session' });
    if (method === 'GET' && parts.length === 2) return sendJson(response, 200, detail);
    if (method === 'GET' && sub === 'events') {
      const from = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const event of fixture.store.events.after(id as string, Number.isInteger(from) && from >= 0 ? from : 0)) response.write(sseFrame(event));
      return void response.end();
    }
    if (method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
    const body = await readJson(request);
    calls.push({ method, path: url.pathname, user, body });
    const stamp = now();
    if (sub === 'messages' && parts.length === 3) {
      const message = (body as { text?: unknown } | undefined)?.text;
      if (typeof message !== 'string' || !message.trim()) return sendJson(response, 400, { error: 'a message needs text' });
      player(id as string).play(stamp, text(`message-${calls.length}`, 'user', message, user));
      return sendJson(response, 202, { accepted: true });
    }
    if (sub === 'requests' && action === 'answer' && requestId) {
      const decision = (body as { decision?: { kind?: string } } | undefined)?.decision;
      if (!decision?.kind) return sendJson(response, 400, { error: 'an answer needs a decision' });
      const item = fixture.inbox.find((i) => (i.kind === 'question' || i.kind === 'permission') && i.sessionId === id && i.requestId === requestId);
      if (!item || item.state !== 'waiting') return sendJson(response, 404, { error: `no request ${requestId} is waiting` });
      if ((item.kind === 'question') !== (decision.kind === 'answer')) return sendJson(response, 400, { error: 'a question is answered with an answer' });
      fixture.inbox.splice(fixture.inbox.indexOf(item), 1, { ...item, state: 'handled' });
      player(id as string).play(stamp,
        item.kind === 'question'
          ? { type: 'CUSTOM', name: 'cleared.answered', value: { requestId, by: user } }
          : { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId, decision: decision.kind as 'allow_once', by: user } },
        delta({ phase: 'working', status: 'Working' }),
      );
      return sendJson(response, 202, { accepted: true });
    }
    if (sub === 'interrupt' && parts.length === 3) {
      const waiting = fixture.inbox.filter((i) => (i.kind === 'question' || i.kind === 'permission') && i.sessionId === id && i.state === 'waiting');
      for (const item of waiting) fixture.inbox.splice(fixture.inbox.indexOf(item), 1, { ...item, state: 'handled' });
      player(id as string).play(stamp,
        ...waiting.map((item): AgUiEvent => ({ type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: (item as { requestId: string }).requestId, decision: 'cancelled', by: 'policy', rule: 'interrupt' } })),
        { type: 'RUN_FINISHED', threadId: id as string, runId: 'interrupted', outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: null } },
        delta({ phase: 'waiting_human', status: 'Waiting for a message' }),
      );
      return sendJson(response, 202, { accepted: true });
    }
    sendJson(response, 404, { error: 'not in the fixtures' });
  }

  return {
    kind: 'fixtures',
    calls,
    forward(request, response, forward) {
      handle(request, response, forward.method, new URL(forward.path, 'http://fixtures'), forward.user.id).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    },
  };
}
