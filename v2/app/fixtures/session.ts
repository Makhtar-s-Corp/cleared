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
//
// Milestone 2's session tabs (decision 30, lane 20) add what the capture
// lacked: the session plan, proposed then given its Go by the owner (or
// still waiting: `{ plan: 'waiting' }`); the files the session changed, as
// the ticket's base held them and as the checkout holds them now, whose
// diffs are the Changes card's counts; the session's preview key, and the
// example app's upcoming screen as its trial environment (fixturePreview);
// and the take over, the give back, the Go and the Change as routes. Lane
// 32 adds the web terminal's routes and the editor's save (fixtureHuman).
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { changeFrame, sseFrame, TERMINAL_INPUT_MAX_BYTES, type ChangeKind, type InboxItem, type SessionDetail, type SessionFile, type SessionPlan, type SessionSummary, type TakenOver, type TerminalClosed, type TerminalMode, type Workspace } from '../../src/api/types.ts';
import { changedFiles } from '../../src/flow/files.ts';
import { GIVEN_BACK } from '../../src/flow/takeover.ts';
import { createCleaner } from '../../src/session/clean.ts';
import type { AgUiEvent, Question, SessionEvent, SessionState } from '../../src/session/events.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { ENDED, REPLAY_MAX, emptyModel, applyAll, stepCommit } from '../web/screens/session/model.ts';
import type { PreviewAnswer, PreviewUpstream } from '../src/preview.ts';
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

const MINUTE = 60_000;

// The author's branch as the flow journals it (issue #272): at the ticket's
// base when the session starts, then at the author's commit.
export const BASE_COMMIT = '3f1c9a0d2b7e4c6a8f0e1d2c3b4a5968778695a4';
export const AUTHOR_COMMIT = '9b2e7d4c1a0f3e6d8c5b2a1f0e9d8c7b6a5f4e3d';
const checkpoint = (commit: string, branch = `cleared/${TICKET_ID}`): AgUiEvent => ({ type: 'CUSTOM', name: 'cleared.checkpoint', value: { commit, branch } });

// The session's preview key (decision 20): what the service issued when its
// containers started, the unguessable segment of its preview address.
export const PREVIEW_KEY = 'fixturePreviewKey_guestbook-upcoming-0000001';

// The session plan the author proposed before changing a file (decision 22).
export function sessionPlanAt(now: Date, go: boolean = true): SessionPlan {
  const start = now.getTime() - 18 * MINUTE;
  return {
    steps: [
      'Group the upcoming entries by week, Monday first, in src/engine/upcoming.mjs',
      'Start a new section at each month; a week across two months stays under the first',
      'Draw the months and the weeks in src/screens/Upcoming.jsx',
      'Test the grouping and the totals in test/upcoming.test.mjs',
    ],
    files: ['src/engine/upcoming.mjs', 'src/screens/Upcoming.jsx', 'test/upcoming.test.mjs'],
    confidence: 'high',
    reason: 'One function changes its shape and one screen draws it; the list already has tests to extend.',
    proposedAt: new Date(start + MINUTE / 2).toISOString(),
    go: go ? { by: USER, at: new Date(start + MINUTE).toISOString() } : null,
  };
}

export const SESSION_PLAN: SessionPlan = sessionPlanAt(FIXTURE_NOW);

// The files the session changed: as the ticket's base held them (null: a
// new file) and as its checkout holds them now. Their diffs are the counts
// the Changes card shows (+24 -6, +41 -12, +38).
const ENGINE_BASE = [
  "// The upcoming list: entries from today on, nearest first.",
  "import { entries } from './store.mjs';",
  "",
  "export function upcoming(today = new Date()) {",
  "  const from = startOfDay(today);",
  "  return entries()",
  "    .filter((entry) => entry.date >= from)",
  "    .sort((a, b) => a.date - b.date);",
  "}",
  "",
  "export function upcomingList(today = new Date()) {",
  "  const list = upcoming(today);",
  "  return list.map((entry) => ({",
  "    id: entry.id,",
  "    title: entry.title,",
  "    day: entry.date.toLocaleDateString(),",
  "  }));",
  "}",
  "",
  "function startOfDay(date) {",
  "  return new Date(date.getFullYear(), date.getMonth(), date.getDate());",
  "}",
];
const ENGINE_NOW = [
  "// The upcoming list: entries from today on, nearest first.",
  "import { entries } from './store.mjs';",
  "",
  "export function upcoming(today = new Date()) {",
  "  const from = startOfDay(today);",
  "  return entries()",
  "    .filter((entry) => entry.date >= from)",
  "    .sort((a, b) => a.date - b.date);",
  "}",
  "",
  "export function upcomingList(today = new Date()) {",
  "  // A weekly agenda: each week has a heading, and a month starts a new",
  "  // section. A week that spans two months stays under the first one.",
  "  const months = [];",
  "  for (const entry of upcoming(today)) {",
  "    const week = mondayOf(entry.date);",
  "    const month = `${week.getFullYear()}-${week.getMonth() + 1}`;",
  "    let section = months.at(-1);",
  "    if (section?.month !== month) months.push((section = { month, weeks: [] }));",
  "    let group = section.weeks.at(-1);",
  "    if (group?.monday.getTime() !== week.getTime()) section.weeks.push((group = { monday: week, entries: [] }));",
  "    // The entries of a week keep their order: the list is sorted already.",
  "    group.entries.push({ id: entry.id, title: entry.title, day: entry.date.toLocaleDateString() });",
  "  }",
  "  return months;",
  "}",
  "",
  "// Weeks start on Monday, whatever the locale says.",
  "export function mondayOf(date) {",
  "  // The time of day is dropped first, so a week compares by its date.",
  "  const day = startOfDay(date);",
  "  // getDay() is 0 on Sunday: a Sunday goes back six days, a Monday none.",
  "  const back = (day.getDay() + 6) % 7;",
  "  day.setDate(day.getDate() - back);",
  "  return day;",
  "}",
  "",
  "function startOfDay(date) {",
  "  return new Date(date.getFullYear(), date.getMonth(), date.getDate());",
  "}",
];
const SCREEN_BASE = [
  "import { upcomingList } from '../engine/upcoming.mjs';",
  "import { Empty } from './Empty.jsx';",
  "",
  "// The upcoming screen: one long list, nearest first.",
  "export function Upcoming({ today }) {",
  "  const list = upcomingList(today);",
  "  if (list.length === 0) return <Empty what=\"upcoming\" />;",
  "  return (",
  "    <section className=\"upcoming\">",
  "      <h1>Upcoming</h1>",
  "      <ul className=\"entries\">",
  "        {list.map((entry) => (",
  "          <li key={entry.id} className=\"entry\">",
  "            <span className=\"day\">{entry.day}</span>",
  "            <span className=\"title\">{entry.title}</span>",
  "          </li>",
  "        ))}",
  "      </ul>",
  "      <p className=\"count\">{list.length} entries</p>",
  "    </section>",
  "  );",
  "}",
];
const SCREEN_NOW = [
  "import { upcomingList } from '../engine/upcoming.mjs';",
  "import { Empty } from './Empty.jsx';",
  "",
  "// The upcoming screen: a weekly agenda. Each month is a section, each",
  "// week a heading, Monday first; the entries keep their order.",
  "export function Upcoming({ today }) {",
  "  const months = upcomingList(today);",
  "  const total = months.reduce((sum, month) => sum + count(month), 0);",
  "  if (total === 0) return <Empty what=\"upcoming\" />;",
  "  return (",
  "    <section className=\"upcoming agenda\">",
  "      <h1>Upcoming</h1>",
  "      {months.map((month) => (",
  "        <Month key={month.month} month={month} />",
  "      ))}",
  "      <p className=\"count\">{total} entries</p>",
  "    </section>",
  "  );",
  "}",
  "",
  "function Month({ month }) {",
  "  const [year, number] = month.month.split('-').map(Number);",
  "  const name = new Date(year, number - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });",
  "  return (",
  "    <section className=\"month\" aria-label={name}>",
  "      <h2>{name}</h2>",
  "      {month.weeks.map((week) => (",
  "        <Week key={week.monday.toISOString()} week={week} />",
  "      ))}",
  "    </section>",
  "  );",
  "}",
  "",
  "function Week({ week }) {",
  "  const label = `Week of ${week.monday.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;",
  "  return (",
  "    <div className=\"week\">",
  "      <h3>{label}</h3>",
  "      <ol className=\"entries\">",
  "        {week.entries.map((entry) => (",
  "          <li key={entry.id} className=\"entry\" data-id={entry.id}>",
  "            <time className=\"day\">{entry.day}</time>",
  "            <span className=\"title\" title={entry.title}>{entry.title}</span>",
  "          </li>",
  "        ))}",
  "      </ol>",
  "    </div>",
  "  );",
  "}",
  "",
  "const count = (month) => month.weeks.reduce((sum, week) => sum + week.entries.length, 0);",
];
const TEST_NOW = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { mondayOf, upcomingList } from '../src/engine/upcoming.mjs';",
  "import { seed } from './seed.mjs';",
  "",
  "// Noon, so that no time zone moves an entry to the day before.",
  "const at = (day) => new Date(2026, 9, day, 12);",
  "",
  "test('weeks start on Monday', () => {",
  "  // Monday 19 October 2026 starts the week of the 21st.",
  "  assert.equal(mondayOf(at(21)).getDate(), 19);",
  "  assert.equal(mondayOf(at(19)).getDate(), 19);",
  "  assert.equal(mondayOf(at(25)).getDate(), 19);",
  "});",
  "",
  "test('entries are grouped by week, Monday first', () => {",
  "  seed([{ id: 1, title: 'Tea', date: at(20) }, { id: 2, title: 'Walk', date: at(22) }, { id: 3, title: 'Choir', date: at(27) }]);",
  "  const [october] = upcomingList(at(19));",
  "  assert.deepEqual(october.weeks.map((week) => week.entries.map((entry) => entry.id)), [[1, 2], [3]]);",
  "});",
  "",
  "test('a month starts a new section', () => {",
  "  seed([{ id: 1, title: 'Tea', date: at(20) }, { id: 2, title: 'Fair', date: new Date(2026, 10, 9, 12) }]);",
  "  assert.deepEqual(upcomingList(at(19)).map((month) => month.month), ['2026-10', '2026-11']);",
  "});",
  "",
  "test('a week that spans two months stays under the first month', () => {",
  "  seed([{ id: 1, title: 'Bake', date: new Date(2026, 10, 1, 12) }]);",
  "  const months = upcomingList(at(19));",
  "  assert.equal(months.length, 1);",
  "  assert.equal(months[0].month, '2026-10');",
  "});",
  "",
  "test('the totals are the same as the flat list', () => {",
  "  seed([{ id: 1, title: 'Tea', date: at(20) }, { id: 2, title: 'Walk', date: at(22) }, { id: 3, title: 'Fair', date: new Date(2026, 10, 9, 12) }]);",
  "  const total = upcomingList(at(19)).flatMap((month) => month.weeks).reduce((sum, week) => sum + week.entries.length, 0);",
  "  assert.equal(total, 3);",
  "});",
];

// The envelope sheet of LOCAL-152 (lane 36's ticket with an author, then a
// reviewer): the month alone before; the three months before it after.
const ENVELOPE_BASE = [
  "import { envelopes } from '../engine/envelopes.mjs';",
  "import { Money } from './Money.jsx';",
  "",
  "// The envelope sheet: what an envelope holds this month.",
  "export function Envelope({ id }) {",
  "  const envelope = envelopes().find((e) => e.id === id);",
  "  const month = envelope.months.at(-1);",
  "  return (",
  "    <section className=\"envelope\">",
  "      <h1>{envelope.name}</h1>",
  "      <p className=\"left\"><Money value={month.left} /> left this month</p>",
  "      <ul className=\"moves\">",
  "        {month.moves.map((move) => <li key={move.id}>{move.label} <Money value={move.amount} /></li>)}",
  "      </ul>",
  "    </section>",
  "  );",
  "}",
];
const ENVELOPE_NOW = [
  "import { envelopes } from '../engine/envelopes.mjs';",
  "import { Money } from './Money.jsx';",
  "",
  "// The envelope sheet: what an envelope holds this month, and what it",
  "// held the months before, newest first.",
  "export const PREVIOUS = 3;",
  "",
  "export function Envelope({ id }) {",
  "  const envelope = envelopes().find((e) => e.id === id);",
  "  const [month, ...before] = [...envelope.months].reverse();",
  "  return (",
  "    <section className=\"envelope\">",
  "      <h1>{envelope.name}</h1>",
  "      <p className=\"left\"><Money value={month.left} /> left this month</p>",
  "      <ul className=\"moves\">",
  "        {month.moves.map((move) => <li key={move.id}>{move.label} <Money value={move.amount} /></li>)}",
  "      </ul>",
  "      {before.length > 0 ? (",
  "        <>",
  "          <h2>Previous months</h2>",
  "          <ol className=\"previous\">",
  "            {before.slice(0, PREVIOUS).map((m) => (",
  "              <li key={m.key}><span className=\"month\">{m.label}</span> <Money value={m.left} /></li>",
  "            ))}",
  "          </ol>",
  "        </>",
  "      ) : null}",
  "    </section>",
  "  );",
  "}",
];
const ENVELOPE_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { render } from './render.mjs';",
  "",
  "test('the sheet shows the three months before this one, newest first', () => {",
  "  const html = render('Envelope', { id: 'groceries' });",
  "  assert.match(html, /Previous months/);",
  "  assert.deepEqual([...html.matchAll(/class=\"month\">([^<]+)</g)].map((m) => m[1]), ['September 2026', 'August 2026', 'July 2026']);",
  "});",
  "",
  "test('a new envelope shows no previous month', () => {",
  "  assert.doesNotMatch(render('Envelope', { id: 'new-bike' }), /Previous months/);",
  "});",
];

const text_ = (lines: readonly string[]) => `${lines.join('\n')}\n`;
export const FIXTURE_FILES: Readonly<Record<string, { readonly base: string | null; readonly current: string }>> = {
  'src/engine/upcoming.mjs': { base: text_(ENGINE_BASE), current: text_(ENGINE_NOW) },
  'src/screens/Upcoming.jsx': { base: text_(SCREEN_BASE), current: text_(SCREEN_NOW) },
  'test/upcoming.test.mjs': { base: null, current: text_(TEST_NOW) },
  'src/screens/Envelope.jsx': { base: text_(ENVELOPE_BASE), current: text_(ENVELOPE_NOW) },
  'test/envelope.test.mjs': { base: null, current: text_(ENVELOPE_TEST) },
};

// The workspace of the fixtures: the guestbook alone, as the milestone 1
// variables make it (decision 18).
export function workspaceFixture(project: string): Workspace {
  return {
    id: project, name: 'Guestbook',
    services: [{
      name: project, kind: 'repository', repo: 'example-org/cleared-example-guestbook', url: 'https://example.invalid/guestbook.git', base: 'main',
      path: null, healthUrl: 'http://127.0.0.1:8793/health', sensitivity: 'normal', consumes: [], run: { dockerfile: 'Dockerfile', port: 3000 }, contract: null,
    }],
  };
}

export type SessionFixture = {
  readonly store: Store;
  readonly project: string;
  readonly now: Date;
  readonly ticket: Ticket;
  readonly sessions: SessionSummary[];
  readonly inbox: InboxItem[];
  readonly takenOver: Map<string, TakenOver>;             // by session, until Give back
};


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

// The reviewer of the story's ticket (lane 36): it starts once the author
// is done, in the same view of the ticket.
export const REVIEWER_ID = 'fixture-reviewer';

// `review`: the author's turn goes on past the request (allowed, the full
// suite, the commit) and the author is done; 'started' adds the reviewer
// (startReview), 'later' leaves it for a test to start.
export function sessionFixture(now: Date = FIXTURE_NOW, options: { readonly question?: boolean; readonly plan?: 'go' | 'waiting'; readonly review?: 'later' | 'started' } = {}): SessionFixture {
  const project = FIXTURE_PROJECT;
  const store = openStore(':memory:');
  const start = new Date(now.getTime() - 18 * MINUTE);
  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);
  const player = new Player(store, AUTHOR_ID, TICKET_ID, project);
  const usage = { model: 'claude-opus-5-5', inputTokens: 31_200, outputTokens: 4_300 };
  const proposed = at(0.5);
  const given = at(1);
  const steps = (waitingSince: Date | null): SessionState['steps'] => [
    { name: 'workspace', startedAt: at(-1).toISOString(), finishedAt: start.toISOString() },
    { name: 'author', startedAt: start.toISOString(), finishedAt: proposed.toISOString() },
    { name: 'plan_gate', startedAt: proposed.toISOString(), finishedAt: given.toISOString() },
    { name: 'author', startedAt: given.toISOString(), finishedAt: null },
    ...(waitingSince ? [{ name: 'waiting_human' as const, startedAt: waitingSince.toISOString(), finishedAt: null }] : []),
  ];
  const plan = (go: boolean): AgUiEvent => ({ type: 'CUSTOM', name: 'cleared.session_plan', value: sessionPlanAt(now, go) });

  player.play(at(-1), { type: 'STEP_STARTED', stepName: 'workspace' });
  player.play(start,
    { type: 'STEP_FINISHED', stepName: 'workspace' },
    { type: 'STEP_STARTED', stepName: 'author' },
    { type: 'RUN_STARTED', threadId: AUTHOR_ID, runId: 'turn-1' },
    checkpoint(BASE_COMMIT),
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'Reading src/screens/Upcoming.jsx', phase: 'working', steps: steps(null), files: [], checks: [{ name: 'Targeted tests', state: 'pending' }, { name: 'Full suite', state: 'pending' }], usage } },
    text('prompt-1', 'user', `${TICKET_TITLE}\n\n${TICKET_BODY}`, 'cleared'),
    call('read-1', 'Read', { kind: 'read', path: 'src/screens/Upcoming.jsx' }, { kind: 'read', path: 'src/screens/Upcoming.jsx', bytes: 2210 }),
    call('read-2', 'Read', { kind: 'read', path: 'test/upcoming.test.mjs' }, { kind: 'read', path: 'test/upcoming.test.mjs', bytes: 1480 }),
    call('read-3', 'Read', { kind: 'read', path: 'test/screens.test.mjs' }, { kind: 'read', path: 'test/screens.test.mjs', bytes: 960 }),
  );
  // The plan, before any change; still waiting for its Go in the 'waiting' story.
  player.play(proposed, plan(false), { type: 'STEP_FINISHED', stepName: 'author' }, { type: 'STEP_STARTED', stepName: 'plan_gate' });
  if (options.plan === 'waiting') return waitingForGo(store, project, now, start, proposed, usage, player);
  player.play(given, plan(true), { type: 'STEP_FINISHED', stepName: 'plan_gate' }, { type: 'STEP_STARTED', stepName: 'author' });
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

  if (options.review) player.play(at(15.5),
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: REQUEST_ID, decision: 'allow_once', by: USER } },
    { type: 'TOOL_CALL_RESULT', messageId: 'run-2-result', toolCallId: 'run-2', content: JSON.stringify({ kind: 'execute', output: 'added 1 package in 2s\n', cut: 0, isError: false }), role: 'tool' },
    delta({ phase: 'working', status: 'Running the full suite', steps: steps(null) }),
    call('run-3', 'Bash', { kind: 'execute', command: 'npm test 2>&1 | tail -8', description: 'Run the full suite' }, { kind: 'execute', output: '# tests 22\n# pass 22\n# fail 0\n', cut: 0, isError: false }),
    delta({ checks: [{ name: 'Targeted tests', state: 'passed' }, { name: 'Full suite', state: 'passed' }] }),
    call('run-4', 'Bash', { kind: 'execute', command: 'git add -A && git commit -q -m "Upcoming: group entries by week"', description: 'Commit the change' }, { kind: 'execute', output: '', cut: 0, isError: false }),
    checkpoint(AUTHOR_COMMIT),
    text('assistant-2', 'assistant', 'The upcoming list is grouped by week, Monday first, under its month. The totals are the same, and the full suite passes.'),
    { type: 'RUN_FINISHED', threadId: AUTHOR_ID, runId: 'turn-1', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.62 } },
    { type: 'STEP_FINISHED', stepName: 'author' },
    delta({ phase: 'done', status: 'Done', steps: steps(null).map((step) => (step.finishedAt === null ? { ...step, finishedAt: at(15.5).toISOString() } : step)) }),
  );

  const events = store.events.after(AUTHOR_ID);
  const last = events[events.length - 1] as SessionEvent;
  const author: SessionSummary = {
    id: AUTHOR_ID, project, ticket: TICKET_ID, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: options.review ? 'done' : 'waiting_human',
    status: options.review ? 'Done' : 'Waiting for you', startedAt: start.toISOString(), updatedAt: last.at, lastSeq: last.seq,
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
  if (options.review) inbox.forEach((item, index) => { inbox[index] = { ...item, state: 'handled' }; });
  const fixture: SessionFixture = { store, project, now, ticket, sessions: [author], inbox, takenOver: new Map() };
  if (options.review === 'started') startReview(fixture, at(16));
  return fixture;
}

// The reviewer of the story starts (lane 36): its session is listed, and
// its first events are stored, as the flow's review start stores them.
export function startReview(fixture: SessionFixture, at: Date = new Date(fixture.now.getTime() - 2 * MINUTE)): SessionSummary {
  const player = new Player(fixture.store, REVIEWER_ID, TICKET_ID, fixture.project);
  const later = (seconds: number) => new Date(at.getTime() + seconds * 1000);
  const review = (finishedAt: string | null) => [{ name: 'review' as const, startedAt: at.toISOString(), finishedAt }];
  player.play(at,
    { type: 'STEP_STARTED', stepName: 'review' },
    { type: 'RUN_STARTED', threadId: REVIEWER_ID, runId: 'review-1' },
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'Reading the diff', phase: 'reviewing', steps: review(null), files: [], checks: [{ name: 'Full suite', state: 'passed' }, { name: 'Review', state: 'pending' }], usage: { model: 'claude-sonnet-5-5', inputTokens: 8_400, outputTokens: 600 } } },
  );
  player.play(later(20), call('review-run-1', 'Bash', { kind: 'execute', command: 'git log --oneline main..HEAD; git diff --stat main...HEAD', description: 'Read the branch' }, { kind: 'execute', output: '3 files changed, 103 insertions(+), 18 deletions(-)\n', cut: 0, isError: false }));
  player.play(later(40),
    call('review-read-1', 'Read', { kind: 'read', path: 'src/engine/upcoming.mjs' }, { kind: 'read', path: 'src/engine/upcoming.mjs', bytes: 1904 }),
    delta({ status: 'Reading the diff of src/engine/upcoming.mjs' }),
  );
  const events = fixture.store.events.after(REVIEWER_ID);
  const last = events[events.length - 1] as SessionEvent;
  const reviewer: SessionSummary = {
    id: REVIEWER_ID, project: fixture.project, ticket: TICKET_ID, role: 'reviewer', harness: 'claude-code', model: 'claude-sonnet-5-5', phase: 'reviewing',
    status: 'Reading the diff of src/engine/upcoming.mjs', startedAt: at.toISOString(), updatedAt: last.at, lastSeq: last.seq,
  };
  fixture.sessions.push(reviewer);
  return reviewer;
}

// The story of a plan that waits for its Go: the author read, proposed, and
// ended its turn; nothing is changed yet.
function waitingForGo(store: Store, project: string, now: Date, start: Date, proposed: Date, usage: SessionState['usage'], player: Player): SessionFixture {
  player.play(proposed,
    { type: 'RUN_FINISHED', threadId: AUTHOR_ID, runId: 'turn-1', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.4 } },
    { type: 'STATE_SNAPSHOT', snapshot: {
      status: 'Waiting for the Go', phase: 'waiting_human', files: [], checks: [], usage,
      steps: [
        { name: 'workspace', startedAt: new Date(start.getTime() - MINUTE).toISOString(), finishedAt: start.toISOString() },
        { name: 'author', startedAt: start.toISOString(), finishedAt: proposed.toISOString() },
        { name: 'plan_gate', startedAt: proposed.toISOString(), finishedAt: null },
      ],
    } },
  );
  const events = store.events.after(AUTHOR_ID);
  const last = events[events.length - 1] as SessionEvent;
  const author: SessionSummary = {
    id: AUTHOR_ID, project, ticket: TICKET_ID, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'waiting_human',
    status: 'Waiting for the Go', startedAt: start.toISOString(), updatedAt: last.at, lastSeq: last.seq,
  };
  const ticket: Ticket = {
    id: TICKET_ID, title: TICKET_TITLE, body: TICKET_BODY, labels: [], project, status: 'In Progress',
    createdAt: new Date(now.getTime() - 20 * MINUTE).toISOString(), updatedAt: start.toISOString(),
  };
  return { store, project, now, ticket, sessions: [author], inbox: [], takenOver: new Map() };
}

// LOCAL-152 in the fixtures source (lane 36): the author's session, done,
// then the reviewer's, which the tower shows reading the diff; both in one
// store, the reviewer's events under the tower's id for it. The author
// edits the envelope sheet twice in a row (one row in the thread), writes
// its test, commits, and on the owner's word renames a heading in a second
// turn (the Editor's last turn); its checks are named by their commands.
export const ENVELOPE_TICKET = 'LOCAL-152';
export const ENVELOPE_AUTHOR_ID = 'fixture-envelope-author';
export const ENVELOPE_BODY = `Each envelope's sheet shows the months before this one, so a person sees where the money went.

- [x] The three months before this one, newest first
- [x] A new envelope shows none
- [ ] The sheet at 390 keeps one column`;

export function envelopeStory(now: Date, reviewer: SessionSummary): { readonly store: Store; readonly author: SessionSummary } {
  const store = openStore(':memory:');
  const project = reviewer.project;
  const start = new Date(now.getTime() - 40 * MINUTE);
  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);
  const author = new Player(store, ENVELOPE_AUTHOR_ID, ENVELOPE_TICKET, project);
  const TESTS = 'npm test 2>&1 | tail -8';
  const COMMIT = 'git add -A && git commit -q -m "Envelope: the months before"';
  const steps = (end: Date | null): SessionState['steps'] => [{ name: 'author', startedAt: start.toISOString(), finishedAt: end?.toISOString() ?? null }];
  const checks = (tests: 'pending' | 'passed', commit: 'pending' | 'passed') => [{ name: TESTS, state: tests }, { name: COMMIT, state: commit }];
  const passed = { kind: 'execute', output: '# tests 9\n# pass 9\n# fail 0\n', cut: 0, isError: false };
  author.play(start,
    { type: 'STEP_STARTED', stepName: 'author' },
    { type: 'RUN_STARTED', threadId: ENVELOPE_AUTHOR_ID, runId: 'turn-1' },
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'Reading src/screens/Envelope.jsx', phase: 'working', steps: steps(null), files: [], checks: checks('pending', 'pending'), usage: { model: 'claude-opus-5-5', inputTokens: 21_800, outputTokens: 2_900 } } },
    text('envelope-prompt', 'user', ENVELOPE_BODY, 'cleared'),
    call('envelope-read-1', 'Read', { kind: 'read', path: 'src/screens/Envelope.jsx' }, { kind: 'read', path: 'src/screens/Envelope.jsx', bytes: 610 }),
    call('envelope-read-2', 'Read', { kind: 'read', path: 'src/engine/envelopes.mjs' }, { kind: 'read', path: 'src/engine/envelopes.mjs', bytes: 1320 }),
    call('envelope-read-3', 'Read', { kind: 'read', path: 'test/render.mjs' }, { kind: 'read', path: 'test/render.mjs', bytes: 480 }),
  );
  author.play(at(6),
    call('envelope-edit-1', 'Edit', { kind: 'edit', path: 'src/screens/Envelope.jsx', added: 9, removed: 2 }, { kind: 'edit', ok: true }),
    call('envelope-edit-2', 'Edit', { kind: 'edit', path: 'src/screens/Envelope.jsx', added: 5, removed: 0 }, { kind: 'edit', ok: true }),
    call('envelope-edit-3', 'Write', { kind: 'edit', path: 'test/envelope.test.mjs', added: 13, removed: 0 }, { kind: 'edit', ok: true }),
    delta({ status: 'Running the tests', files: [{ path: 'src/screens/Envelope.jsx', added: 14, removed: 2 }, { path: 'test/envelope.test.mjs', added: 13, removed: 0 }] }),
  );
  author.play(at(12),
    call('envelope-run-1', 'Bash', { kind: 'execute', command: TESTS, description: 'Run the tests' }, passed),
    call('envelope-run-2', 'Bash', { kind: 'execute', command: COMMIT, description: 'Commit the change' }, { kind: 'execute', output: '', cut: 0, isError: false }),
    delta({ checks: checks('passed', 'passed') }),
    text('envelope-said-1', 'assistant', 'The sheet lists the three months before this one, newest first, under a History heading. A new envelope shows none.'),
    { type: 'RUN_FINISHED', threadId: ENVELOPE_AUTHOR_ID, runId: 'turn-1', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.41 } },
  );
  author.play(at(20), text('envelope-owner-1', 'user', 'Call the section Previous months, as the ticket says.', USER));
  author.play(at(21),
    { type: 'RUN_STARTED', threadId: ENVELOPE_AUTHOR_ID, runId: 'turn-2' },
    call('envelope-edit-4', 'Edit', { kind: 'edit', path: 'src/screens/Envelope.jsx', added: 1, removed: 1 }, { kind: 'edit', ok: true }),
    call('envelope-run-3', 'Bash', { kind: 'execute', command: TESTS, description: 'Run the tests' }, passed),
    call('envelope-run-4', 'Bash', { kind: 'execute', command: 'git commit -qam "Envelope: Previous months"', description: 'Commit the change' }, { kind: 'execute', output: '', cut: 0, isError: false }),
    delta({ files: [{ path: 'src/screens/Envelope.jsx', added: 15, removed: 2 }, { path: 'test/envelope.test.mjs', added: 13, removed: 0 }] }),
    { type: 'RUN_FINISHED', threadId: ENVELOPE_AUTHOR_ID, runId: 'turn-2', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.12 } },
    { type: 'STEP_FINISHED', stepName: 'author' },
    delta({ phase: 'done', status: 'Done', steps: steps(at(34)) }),
  );

  // The reviewer, from its start four minutes ago: what the tower says it does.
  const reviewing = new Player(store, reviewer.id, ENVELOPE_TICKET, project);
  const begun = new Date(reviewer.startedAt);
  const after = (minutes: number) => new Date(begun.getTime() + minutes * MINUTE);
  const review = [{ name: 'review' as const, startedAt: begun.toISOString(), finishedAt: null }];
  reviewing.play(begun,
    { type: 'STEP_STARTED', stepName: 'review' },
    { type: 'RUN_STARTED', threadId: reviewer.id, runId: 'review-1' },
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'Reading the branch', phase: 'reviewing', steps: review, files: [], checks: [...checks('passed', 'passed'), { name: 'Review', state: 'pending' }], usage: { model: 'claude-sonnet-5-5', inputTokens: 9_600, outputTokens: 700 } } },
    text('envelope-review-prompt', 'user', ENVELOPE_BODY, 'cleared'),
  );
  reviewing.play(after(1), call('envelope-review-run-1', 'Bash', { kind: 'execute', command: 'git log --oneline main..HEAD; git diff --stat main...HEAD', description: 'Read the branch' }, { kind: 'execute', output: '2 files changed, 28 insertions(+), 2 deletions(-)\n', cut: 0, isError: false }));
  reviewing.play(after(2), call('envelope-review-run-2', 'Bash', { kind: 'execute', command: 'ls node_modules >/dev/null 2>&1 && (npm test 2>&1 | tail -8; npm run typecheck 2>&1 | tail -5)', description: 'Run the tests and the type check' }, passed));
  reviewing.play(after(3),
    call('envelope-review-read-1', 'Read', { kind: 'read', path: 'src/screens/Envelope.jsx' }, { kind: 'read', path: 'src/screens/Envelope.jsx', bytes: 1010 }),
    delta({ status: reviewer.status }),
  );
  const events = store.events.after(ENVELOPE_AUTHOR_ID);
  const last = events[events.length - 1] as SessionEvent;
  return {
    store,
    author: {
      id: ENVELOPE_AUTHOR_ID, project, ticket: ENVELOPE_TICKET, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'done', status: 'Done',
      startedAt: start.toISOString(), updatedAt: last.at, lastSeq: last.seq,
    },
  };
}

// The session as the service answers GET /api/sessions/:id: the summary and
// the state the stored events add up to.
export function detailOf(fixture: SessionFixture, id: string): SessionDetail | undefined {
  const summary = fixture.sessions.find((s) => s.id === id);
  if (!summary) return undefined;
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(id));
  const state = model.state ?? { status: summary.status, phase: summary.phase, steps: [], files: [], checks: [], usage: {} };
  const takenOver = fixture.takenOver.get(id);
  return {
    ...summary, phase: state.phase, status: state.status, state: { ...state, ...(model.plan ? { plan: model.plan } : {}), ...(takenOver ? { takenOver } : {}) },
    previewKey: PREVIEW_KEY, ...(takenOver ? { takenOver } : {}),
  };
}

// A file of the session's checkout, or of the ticket's base, as the files
// route answers it (flow/files.ts).
export function fixtureFile(path: string, version: 'base' | 'current'): SessionFile | undefined {
  const versions = FIXTURE_FILES[path];
  const text = versions ? (version === 'base' ? versions.base : versions.current) : null;
  if (text === null || text === undefined) return undefined;
  return { path, text, lines: text.split('\n').length - 1, cut: false, hash: createHash('sha256').update(text).digest('hex') };
}

// The trial environment of the fixtures' session (decision 20): the example
// app's upcoming screen, as the service's preview route answers it for the
// session's key. Any other key is unknown.
export function fixturePreview(): PreviewUpstream {
  const page = Buffer.from(UPCOMING_PAGE);
  return async (path): Promise<PreviewAnswer> => {
    const match = /^\/api\/sessions\/[^/]+\/preview\/([^/?]+)(\/[^?]*)?(?:\?.*)?$/.exec(path);
    if (!match || match[1] !== PREVIEW_KEY) return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from('{"error":"no preview"}') };
    if (match[2] && match[2] !== '/') return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Not found') };
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'guestbook=1; Path=/' }, body: page };
  };
}

// The guestbook's upcoming screen on the ticket's branch: weeks under their month.
const UPCOMING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guestbook · Upcoming</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1f2328; background: #fffdf8; }
  header { padding: 14px 24px; border-bottom: 1px solid #e7e1d6; font-weight: 600; }
  main { max-width: 640px; padding: 8px 24px 32px; }
  h1 { font-size: 22px; margin: 16px 0 4px; }
  h2 { font-size: 15px; margin: 20px 0 6px; color: #8a5a00; text-transform: uppercase; letter-spacing: .04em; }
  h3 { font-size: 13px; margin: 12px 0 4px; color: #57606a; font-weight: 500; }
  ol { list-style: none; margin: 0; padding: 0; border: 1px solid #e7e1d6; border-radius: 8px; background: #fff; }
  li { display: flex; gap: 16px; padding: 8px 12px; border-top: 1px solid #f0ebe2; }
  li:first-child { border-top: 0; }
  .day { width: 92px; color: #57606a; font-variant-numeric: tabular-nums; }
  .count { margin-top: 18px; color: #57606a; font-size: 13px; }
</style>
</head>
<body>
<header>Guestbook</header>
<main>
<section class="upcoming agenda">
<h1>Upcoming</h1>
<section class="month"><h2>October 2026</h2>
<div class="week"><h3>Week of 19 Oct</h3><ol class="entries">
<li class="entry"><time class="day">Tue 20 Oct</time><span class="title">Tea with the reading circle</span></li>
<li class="entry"><time class="day">Thu 22 Oct</time><span class="title">Autumn walk by the canal</span></li>
</ol></div>
<div class="week"><h3>Week of 26 Oct</h3><ol class="entries">
<li class="entry"><time class="day">Tue 27 Oct</time><span class="title">Choir rehearsal</span></li>
<li class="entry"><time class="day">Sun 1 Nov</time><span class="title">Bake sale for the library</span></li>
</ol></div>
</section>
<section class="month"><h2>November 2026</h2>
<div class="week"><h3>Week of 9 Nov</h3><ol class="entries">
<li class="entry"><time class="day">Mon 9 Nov</time><span class="title">Winter fair planning</span></li>
</ol></div>
</section>
<p class="count">5 entries</p>
</section>
</main>
</body>
</html>
`;

export type Call = { readonly method: string; readonly path: string; readonly user: string; readonly body: unknown };
export type SessionSource = DataSource & { readonly calls: Call[]; changed(kind: ChangeKind, id: string | null): void };

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
// `?after=` and ends. The change stream (lane 34's GET /api/events) is
// answered too: an event for each write, and for each changed() a test
// calls (lane 36: the reviewer's start).
export function sessionSource(fixture: SessionFixture, options: { readonly now?: () => Date } = {}): SessionSource {
  const calls: Call[] = [];
  const human = fixtureHuman();
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

  const listeners = new Set<ServerResponse>();
  let seq = 0;
  const changed = (kind: ChangeKind, id: string | null) => {
    seq += 1;
    for (const listener of listeners) listener.write(changeFrame(seq, { kind, id, at: now().toISOString() }));
  };

  async function handle(request: IncomingMessage, response: ServerResponse, method: string, url: URL, user: string): Promise<void> {
    const parts = url.pathname.split('/').slice(2);
    const [collection, id, sub, requestId, action] = parts;
    if (method === 'GET' && collection === 'events' && parts.length === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      response.write(': stream open\n\n');
      listeners.add(response);
      response.on('close', () => listeners.delete(response));
      return;
    }
    if (method !== 'GET' && collection === 'sessions' && id) response.once('finish', () => { if (response.statusCode < 300) changed('session', decodeURIComponent(id)); });
    if (method === 'GET' && collection === 'inbox') return sendJson(response, 200, fixture.inbox);
    if (method === 'GET' && collection === 'tickets') {
      if (parts.length === 1) return sendJson(response, 200, [fixture.ticket]);
      return id === fixture.ticket.id ? sendJson(response, 200, fixture.ticket) : sendJson(response, 404, { error: 'no such ticket' });
    }
    if (method === 'GET' && collection === 'workspace' && parts.length === 1) return sendJson(response, 200, workspaceFixture(fixture.project));
    if (collection !== 'sessions') return sendJson(response, 404, { error: 'not in the fixtures' });
    if (method === 'GET' && parts.length === 1) return sendJson(response, 200, fixture.sessions.map((s) => (fixture.takenOver.has(s.id) ? { ...s, takenOver: fixture.takenOver.get(s.id) } : s)));
    const detail = id ? detailOf(fixture, id) : undefined;
    if (!detail) return sendJson(response, 404, { error: 'no such session' });
    if (method === 'GET' && parts.length === 2) return sendJson(response, 200, detail);
    // The Editor tab's files (flow/files.ts): the changed files, and one file now or at the base.
    if (method === 'GET' && sub === 'files') {
      if (parts.length === 3) return sendJson(response, 200, { files: changedFiles(detail.state.files) });
      const version = url.searchParams.get('version');
      if (version !== null && version !== 'base') return sendJson(response, 400, { error: 'version is base, or nothing for the checkout' });
      const path = parts.slice(3).map(decodeURIComponent).join('/');
      const found = version === 'base' ? fixtureFile(path, 'base') : human.file(path);
      return found ? sendJson(response, 200, found) : sendJson(response, 404, { error: 'no such file in the checkout' });
    }
    if (method === 'GET' && sub === 'events') {
      const from = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const event of fixture.store.events.after(id as string, Number.isInteger(from) && from >= 0 ? from : 0)) response.write(sseFrame(event));
      return void response.end();
    }
    // The web terminal and the editor's save (lane 32).
    const route = { method, url, parts, user, taken: fixture.takenOver.get(id as string), record: (body: unknown) => calls.push({ method, path: url.pathname, user, body }) };
    if (await human.handle(request, response, route)) return;
    if (method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
    const body = await readJson(request);
    calls.push({ method, path: url.pathname, user, body });
    const stamp = now();
    if (sub === 'messages' && parts.length === 3) {
      if (fixture.takenOver.has(id as string)) return sendJson(response, 409, { error: `session ${id} is taken over: give it back first` });
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
    // Take over and Give back (flow/takeover.ts): the turn interrupted and
    // what waited cancelled, the session paused until Give back.
    if (sub === 'takeover' && parts.length === 3) {
      if (fixture.takenOver.has(id as string)) return sendJson(response, 409, { error: `session ${id} is already taken over` });
      const waiting = fixture.inbox.filter((i) => (i.kind === 'question' || i.kind === 'permission') && i.sessionId === id && i.state === 'waiting');
      for (const item of waiting) fixture.inbox.splice(fixture.inbox.indexOf(item), 1, { ...item, state: 'handled' });
      fixture.takenOver.set(id as string, { by: user, at: stamp.toISOString() });
      player(id as string).play(stamp,
        ...waiting.map((item): AgUiEvent => ({ type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: (item as { requestId: string }).requestId, decision: 'cancelled', by: 'policy', rule: 'takeover' } })),
        { type: 'RUN_FINISHED', threadId: id as string, runId: 'taken-over', outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: null } },
        delta({ phase: 'waiting_human', status: 'Waiting for a message' }),
      );
      return sendJson(response, 200, { accepted: true, by: user });
    }
    if (sub === 'giveback' && parts.length === 3) {
      const taken = fixture.takenOver.get(id as string);
      if (!taken) return sendJson(response, 409, { error: `session ${id} is not taken over` });
      if (taken.by !== user) return sendJson(response, 403, { error: 'only the account that took the session over gives it back' });
      human.close(id as string, 'give_back');
      fixture.takenOver.delete(id as string);
      player(id as string).play(stamp, text(`given-back-${calls.length}`, 'user', GIVEN_BACK, 'cleared'), delta({ phase: 'working', status: 'Working' }));
      return sendJson(response, 200, { accepted: true });
    }
    // The session plan's Go and Change (flow/plan-gate.ts).
    if (sub === 'plan' && parts.length === 4 && (requestId === 'go' || requestId === 'change')) {
      if (fixture.takenOver.has(id as string)) return sendJson(response, 409, { error: `session ${id} is taken over: give it back first` });
      const model = emptyModel();
      applyAll(model, fixture.store.events.after(id as string));
      if (!model.plan || model.plan.go !== null) return sendJson(response, 409, { error: `session ${id} has no session plan waiting for its Go` });
      if (requestId === 'go') {
        player(id as string).play(stamp,
          { type: 'CUSTOM', name: 'cleared.session_plan', value: { ...model.plan, go: { by: user, at: stamp.toISOString() } } },
          { type: 'STEP_FINISHED', stepName: 'plan_gate' }, { type: 'STEP_STARTED', stepName: 'author' },
          delta({ phase: 'working', status: 'Working' }),
        );
        return sendJson(response, 200, { accepted: true });
      }
      const message = (body as { message?: unknown } | undefined)?.message;
      if (typeof message !== 'string' || !message.trim() || message.length > 2000) return sendJson(response, 400, { error: 'message must be a non-empty text of at most 2000 characters' });
      player(id as string).play(stamp, text(`change-${calls.length}`, 'user', message, user), delta({ phase: 'working', status: 'Working' }));
      return sendJson(response, 200, { accepted: true });
    }
    // Resume from here (flow/replay.ts): the ticket's live sessions stopped,
    // and a new author on the resume branch, at the step's commit.
    if (sub === 'replay' && parts.length === 3) {
      const { seq, message } = (body ?? {}) as { seq?: unknown; message?: unknown };
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return sendJson(response, 400, { error: 'seq must be the number of an event of the session' });
      if (typeof message !== 'string' || !message.trim() || message.length > REPLAY_MAX) return sendJson(response, 400, { error: `message must be a non-empty text of at most ${REPLAY_MAX} characters` });
      if (detail.role !== 'author') return sendJson(response, 400, { error: `session ${id} is the ${detail.role}'s: a ticket is resumed from a step of an author's session` });
      const model = emptyModel();
      applyAll(model, fixture.store.events.after(id as string));
      const from = model.lastSeq >= seq ? stepCommit(model.checkpoints, seq) : undefined;
      if (!from) return sendJson(response, 400, { error: `no commit of session ${id} is known at its event ${seq}` });
      const n = fixture.sessions.filter((s) => s.id.startsWith(`${AUTHOR_ID}-r`)).length + 1;
      const resumed = `${AUTHOR_ID}-r${n}`;
      const branch = `cleared/${TICKET_ID}.r${n}`;
      for (const [index, summary] of fixture.sessions.entries()) {
        if (ENDED.has(summary.phase)) continue;
        player(summary.id).play(stamp, { type: 'RUN_ERROR', message: 'The owner resumed the ticket from an earlier step: this session was stopped.', code: 'replayed' }, delta({ phase: 'stopped', status: 'Stopped' }));
        fixture.sessions[index] = { ...summary, phase: 'stopped', status: 'Stopped', updatedAt: stamp.toISOString() };
      }
      const value = { from: id as string, to: resumed, seq, commit: from.commit, branch, previous: model.checkpoints.at(-1)?.branch ?? from.branch, by: user, message: message.trim() };
      // Each summary says its last event, as the service's does: the stopped sessions and the one left are read again.
      const left = player(id as string).play(stamp, { type: 'CUSTOM', name: 'cleared.replay', value });
      for (const [index, summary] of fixture.sessions.entries()) {
        const last = fixture.store.events.after(summary.id).at(-1);
        if (last && last.seq !== summary.lastSeq) fixture.sessions[index] = { ...summary, lastSeq: last.seq, updatedAt: last.at };
      }
      void left;
      const stored = player(resumed).play(stamp,
        { type: 'STEP_STARTED', stepName: 'workspace' }, { type: 'STEP_FINISHED', stepName: 'workspace' }, { type: 'STEP_STARTED', stepName: 'author' },
        { type: 'RUN_STARTED', threadId: resumed, runId: 'turn-1' },
        { type: 'STATE_SNAPSHOT', snapshot: { status: 'Working', phase: 'working', steps: [{ name: 'author', startedAt: stamp.toISOString(), finishedAt: null }], files: [], checks: [], usage: {} } },
        checkpoint(from.commit, branch),
        { type: 'CUSTOM', name: 'cleared.replay', value },
      );
      fixture.sessions.push({
        id: resumed, project: fixture.project, ticket: TICKET_ID, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'working', status: 'Working',
        startedAt: stamp.toISOString(), updatedAt: stamp.toISOString(), lastSeq: (stored.at(-1) as SessionEvent).seq,
      });
      changed('session', resumed);
      changed('ticket', TICKET_ID);
      return sendJson(response, 200, { accepted: true, session: resumed, branch, commit: from.commit });
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
    changed,
    forward(request, response, forward) {
      handle(request, response, forward.method, new URL(forward.path, 'http://fixtures'), forward.user.id).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    },
  };
}

// The web terminal and the editor's save over the fixtures (decisions 32
// and 33, lane 32), for both fixture sources: a stand-in for the harness of
// each session taken over, the terminal's default (owner request of
// 2026-10-22 17:26: it shows the session's last words, echoes what is
// typed and answers each line with a sentence saying it is a stand-in;
// /exit ends it), and one for its shell (it echoes what is typed and
// answers ls, pwd, git status, colours and exit; its first lines are the
// service's, then a line in 256 colours and one in 24-bit colour), its stream as the service
// sends it (the chunks after Last-Event-ID or ?after=, held open until the
// terminal closes), and the checkout's files as the editor saves them (a
// stale hash is a 409 with the current one; CLAUDE.md and .claude/ are
// refused by the default rule; a dependency of package.json asks for its
// confirmation). Nothing runs: the shell is words.
type Listener = (frame: string) => void;
type FixtureTerminal = { readonly mode: TerminalMode; readonly chunks: { seq: number; data: string }[]; readonly listeners: Set<Listener>; line: string; closed?: TerminalClosed['reason'] };

const PROMPT = '\u001b[1mnode@session\u001b[0m:/workspace$ ';
const HARNESS = 'Claude Code';
const HARNESS_PROMPT = '\u001b[1m>\u001b[0m ';
// What the stand-in harness shows when resumed: the session's last words, as a resumed conversation does.
const HARNESS_RESUMED = '\u001b[2m# Claude Code, resumed on this session.\u001b[0m\r\n\r\n'
  + '\u001b[38;5;174m⏺\u001b[0m I grouped the upcoming entries by week, Monday first. A week that spans two months stays under the first month. Next: the headings, then the tests.\r\n\r\n'
  + '\u001b[38;5;174m⏺\u001b[0m \u001b[1mBash\u001b[0m(npm test)\r\n  ⎿  \u001b[32m14 passed\u001b[0m, 1 failed: entries are grouped by week, Monday first\r\n\r\n'
  + '\u001b[2m  ⎿  Interrupted: the owner took the session over\u001b[0m\r\n\r\n';
// LOCAL-152's reviewer, resumed (lane 36): its own last words, about the envelope sheet.
export const ENVELOPE_RESUMED = '\u001b[2m# Claude Code, resumed on this session.\u001b[0m\r\n\r\n'
  + '\u001b[38;5;174m⏺\u001b[0m The branch shows the three months before this one on the envelope sheet, newest first, and none for a new envelope. Next: the sheet at 390.\r\n\r\n'
  + '\u001b[38;5;174m⏺\u001b[0m \u001b[1mBash\u001b[0m(npm test 2>&1 | tail -8)\r\n  ⎿  \u001b[32m9 passed\u001b[0m\r\n\r\n'
  + '\u001b[2m  ⎿  Interrupted: the owner took the session over\u001b[0m\r\n\r\n';
const HARNESS_ANSWER = '\u001b[38;5;174m⏺\u001b[0m (the fixtures\' stand-in for the harness: in a real session, Claude Code answers here)\r\n\r\n';
const COLOURS = '\u001b[38;5;208m256 colours\u001b[0m: \u001b[48;5;24m\u001b[38;5;231m a line from the palette \u001b[0m\r\n'
  + '\u001b[38;2;200;30;40m24-bit colour\u001b[0m: \u001b[48;2;20;80;160m\u001b[38;2;255;255;255m a line in true colour \u001b[0m\r\n';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const dataFrame = (chunk: { seq: number; data: string }) => `id: ${chunk.seq}\nevent: data\ndata: ${JSON.stringify(chunk)}\n\n`;
const closedFrame = (reason: TerminalClosed['reason']) => `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`;

export type FixtureHuman = {
  readonly files: Map<string, string>;
  // A file of the checkout as the files route answers it, after the saves.
  file(path: string): SessionFile | undefined;
  // Closes a session's terminal, as Give back does.
  close(session: string, reason: TerminalClosed['reason']): void;
  // Answers the terminal's routes and the save; false for any other route.
  handle(request: IncomingMessage, response: ServerResponse, route: {
    readonly method: string; readonly url: URL; readonly parts: readonly string[]; readonly user: string;
    readonly taken: TakenOver | undefined; readonly record?: (body: unknown) => void;
  }): Promise<boolean>;
};

// `resumed`: what a session's stand-in harness shows when resumed, by session; else LOCAL-161's story.
export function fixtureHuman(options: { readonly resumed?: (session: string) => string | undefined } = {}): FixtureHuman {
  const files = new Map(Object.entries(FIXTURE_FILES).map(([path, versions]) => [path, versions.current]));
  const terminals = new Map<string, FixtureTerminal>();
  const push = (terminal: FixtureTerminal, data: string) => {
    const chunk = { seq: terminal.chunks.length + 1, data };
    terminal.chunks.push(chunk);
    for (const listener of terminal.listeners) listener(dataFrame(chunk));
  };
  const close = (session: string, reason: TerminalClosed['reason']) => {
    const terminal = terminals.get(session);
    if (!terminal) return;
    terminals.delete(session);
    terminal.closed = reason;
    for (const listener of terminal.listeners) listener(closedFrame(reason));
    terminal.listeners.clear();
  };
  const run = (session: string, command: string): string => {
    if (command === '') return '';
    if (command === 'ls') return `${[...files.keys()].join('\r\n')}\r\n`;
    if (command === 'pwd') return '/workspace\r\n';
    if (command === 'git status') return `On branch cleared/${TICKET_ID}\r\nChanges not staged for commit:\r\n${[...files.keys()].map((path) => `\t\u001b[31mmodified:   ${path}\u001b[0m`).join('\r\n')}\r\n`;
    if (command === 'colours') return COLOURS;
    if (command === 'exit') { queueMicrotask(() => close(session, 'exit')); return 'logout\r\n'; }
    return `${command.split(' ')[0]}: not in the fixtures\r\n`;
  };
  const type = (session: string, terminal: FixtureTerminal, data: string) => {
    let echo = '';
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const command = terminal.line.trim();
        terminal.line = '';
        echo += `\r\n${run(session, command)}`;
        if (command !== 'exit') echo += PROMPT;
      } else if (char === '\u007f') {
        if (terminal.line) { terminal.line = terminal.line.slice(0, -1); echo += '\b \b'; }
      } else if (char >= ' ') {
        terminal.line += char;
        echo += char;
      }
    }
    if (echo) push(terminal, echo);
  };
  // The stand-in harness: each line answered by the same sentence; /exit ends it.
  const talk = (session: string, terminal: FixtureTerminal, data: string) => {
    let echo = '';
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const said = terminal.line.trim();
        terminal.line = '';
        if (said === '/exit') { queueMicrotask(() => close(session, 'exit')); echo += '\r\n'; continue; }
        echo += said ? `\r\n\r\n${HARNESS_ANSWER}${HARNESS_PROMPT}` : `\r\n${HARNESS_PROMPT}`;
      } else if (char === '\u007f') {
        if (terminal.line) { terminal.line = terminal.line.slice(0, -1); echo += '\b \b'; }
      } else if (char >= ' ') {
        terminal.line += char;
        echo += char;
      }
    }
    if (echo) push(terminal, echo);
  };
  const json = async (request: IncomingMessage): Promise<Record<string, unknown> | undefined> => {
    const value = await readJson(request);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  };

  return {
    files,
    file(path) {
      const text = files.get(path);
      return text === undefined ? undefined : { path, text, lines: text.split('\n').length - 1, cut: false, hash: sha256(text) };
    },
    close,
    async handle(request, response, { method, url, parts, user, taken, record }) {
      const [collection, id, sub, action] = parts;
      if (collection !== 'sessions' || !id) return false;
      const answer = (status: number, body: unknown): true => { sendJson(response, status, body); return true; };
      if (method === 'PUT' && sub === 'files' && parts.length > 3) {
        const path = parts.slice(3).map(decodeURIComponent).join('/');
        const body = await json(request);
        record?.(body);
        if (taken && taken.by !== user) return answer(403, { error: 'the session is taken over by another account' });
        const current = files.get(path);
        if (current === undefined) return answer(404, { error: 'no such file in the checkout' });
        const { text, hash, confirm } = body ?? {};
        if (typeof text !== 'string' || typeof hash !== 'string') return answer(400, { error: 'text and hash are required' });
        const refuse = (status: number, rule: string | null, reason: string, extra: object = {}) => answer(status, { error: reason, rule, reason, confirmable: false, ...extra });
        if (hash !== sha256(current)) return refuse(409, null, 'the file changed since the editor loaded it: reload it', { hash: sha256(current) });
        if (path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md') || path.startsWith('.claude/')) return refuse(403, 'default', 'the session\'s own files are not edited');
        if (path === 'package.json' && confirm !== 'install.package' && text !== current)
          return answer(403, { error: 'a dependency change asks first', rule: 'install.package', reason: 'a dependency change asks first', confirmable: true });
        files.set(path, text);
        return answer(200, { saved: true, hash: sha256(text) });
      }
      if (sub !== 'terminal' || parts.length !== 4) return false;
      if (!taken) return answer(409, { error: 'the session is not taken over: take it over first' });
      if (taken.by !== user) return answer(403, { error: 'the terminal is for the account that took the session over' });
      const terminal = terminals.get(id);
      if (method === 'GET' && action === 'stream') {
        if (!terminal) return answer(409, { error: 'no terminal is open for this session' });
        const after = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        for (const chunk of terminal.chunks) if (chunk.seq > (Number.isFinite(after) ? after : 0)) response.write(dataFrame(chunk));
        const listener: Listener = (frame) => {
          response.write(frame);
          if (frame.startsWith('event: closed')) response.end();
        };
        terminal.listeners.add(listener);
        request.on('close', () => terminal.listeners.delete(listener));
        return true;
      }
      if (method !== 'POST') return answer(405, { error: 'method not allowed' });
      const body = await json(request);
      record?.(body);
      if (action === 'open') {
        if (terminal) return answer(409, { error: 'a terminal is already open for this session: one at a time', mode: terminal.mode });
        const mode: TerminalMode = body?.mode === 'shell' ? 'shell' : 'harness';
        const opened: FixtureTerminal = { mode, chunks: [], listeners: new Set(), line: '' };
        terminals.set(id, opened);
        const size = { cols: Number(body?.cols) || 80, rows: Number(body?.rows) || 24 };
        if (mode === 'harness') {
          push(opened, `${options.resumed?.(id) ?? HARNESS_RESUMED}${HARNESS_PROMPT}`);
          return answer(200, { opened: true, ...size, mode, name: HARNESS });
        }
        push(opened, `\u001b[2m# A shell in the session's container, as its user, in its checkout.\u001b[0m\r\n${COLOURS}${PROMPT}`);
        return answer(200, { opened: true, ...size, mode });
      }
      if (!terminal) return answer(409, { error: 'no terminal is open for this session' });
      if (action === 'input') {
        const data = body?.data;
        if (typeof data !== 'string') return answer(400, { error: 'data is the text typed' });
        if (Buffer.byteLength(data) > TERMINAL_INPUT_MAX_BYTES) return answer(413, { error: `at most ${TERMINAL_INPUT_MAX_BYTES} bytes per post` });
        if (terminal.mode === 'harness') talk(id, terminal, data);
        else type(id, terminal, data);
        return answer(200, { accepted: true });
      }
      if (action === 'resize') return answer(200, { accepted: true });
      if (action === 'close') {
        close(id, 'closed');
        return answer(200, { accepted: true });
      }
      return false;
    },
  };
}
