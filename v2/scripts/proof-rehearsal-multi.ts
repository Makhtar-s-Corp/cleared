// The rehearsal of the multi-service proof (docs/v2/milestone-2-plan.md,
// section 2.2, lane 29): the real service and the real app, started on the
// fake adapter in a temporary folder, on a workspace of two services (the
// guestbook, which consumes, and the filter API, which provides), with the
// stand-ins of scripts/proof-rehearsal.ts at the edges of the machine and
// three more for what a workspace of services adds:
//   - the locks: two stand-in brokers, one socket and one state folder each,
//     both writing the one temporary ledger; the guestbook's watch fails
//     when the merged src/config.ts turns PROOF_BREAK_HEALTH on, and rolls
//     its merge back, as the real watch would on /health;
//   - the containers: `docker` is a stand-in (this file, run as docker-stub)
//     that answers the labelled lists and inspections of a session's
//     containers, runs the service's own programs (the editor's read and
//     save, the checkout at Take over and Give back) on the session's
//     checkout, relays the preview to the trial stand-in, and gives the
//     human's terminal's Shell a stand-in shell; it refuses anything else
//     (a harness resumed in the terminal among them), and
//     never runs the real docker;
//   - the trial environment: a loopback server stands for the session's
//     siblings: the guestbook's page, which calls the filter API's fake,
//     built by images/fake/fake.ts from the contract the owner validated.
// No TCP port is opened but the service's, the app's, the preview
// listener's and the trial stand-in's, on 127.0.0.1, checked free with
// `ss -ltn` and never a reserved one. HOME is the temporary folder.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type net from 'node:net';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createFake, readContract, type Fake } from '../images/fake/fake.ts';
import { InboxStore } from '../src/inbox/store.ts';
import { RELAY } from '../src/container/preview.ts';
import type { FakeStep } from '../src/session/adapters/fake.ts';
import type { RehearsalScript } from '../src/session/adapters/index.ts';
import { END_TERMINAL, GIVE_PROGRAM, READ_PROGRAM, SHELL_COMMAND, TAKE_PROGRAM, WRITE_PROGRAM, terminalCommand } from '../src/terminal/container.ts';
import { guestbookHeading } from './proof-guestbook-heading.ts';
import { FROZEN_BRANCH, RUN_BRANCH, breaksHealth, type BaseSettings } from './proof-base.ts';
import { buildApp, freePort, listening, plannedAuthor, startBroker, writeGhStub } from './proof-rehearsal.ts';

const V2 = fileURLToPath(new URL('../', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../../examples/', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SERVICES = ['guestbook', 'filter-api'] as const;
type ServiceName = (typeof SERVICES)[number];

// ---- the proof's four tickets ---------------------------------------------------

// Tickets 1 to 3 as the guestbook's README gives them (lane 28); ticket 4,
// step 11's, on the guestbook alone, added after it (section 2.2).
export const MULTI_TICKETS = [
  {
    title: 'An entry the filter flags is held for review instead of refused',
    body: 'Today an entry with a word of the filter\'s list is refused, and the visitor loses it. The filter API\'s `POST /check` should also answer a `severity`: `none` when `ok` is true, `review` otherwise. The guestbook stores an entry whose severity is `review` as held: it is not shown on the page, and the visitor reads that the entry waits for review.\n\nAcceptance criteria\n- [ ] `contract/openapi.yaml` of the filter API gives `severity` in the answer of `POST /check`, with its examples, and the contract test passes.\n- [ ] The filter API answers `severity`, with a test for each value.\n- [ ] The guestbook stores a flagged entry as held and leaves it off the page, with a test using a fake filter.\n- [ ] `npm test` and `npm run typecheck` pass in both projects.',
    services: ['guestbook', 'filter-api'],
  },
  {
    title: 'The filter refuses "casino", and the guestbook\'s refusal lists the words in bold',
    body: 'Add `casino` to the filter API\'s `words.txt`. In the guestbook, show each word of a refusal in bold. This ticket also sets `PROOF_BREAK_HEALTH` to `true` in the guestbook\'s `src/config.ts`: it is the proof\'s provoked failure, and the guestbook\'s release must be rolled back.\n\nAcceptance criteria\n- [ ] The filter API refuses a text holding "Casino", with a test.\n- [ ] The guestbook\'s refusal shows each word in `<strong>`, with a test.\n- [ ] `PROOF_BREAK_HEALTH` is `true` in the guestbook\'s `src/config.ts`, and its config test says so.\n- [ ] `npm test` and `npm run typecheck` pass in both projects.',
    services: ['guestbook', 'filter-api'],
  },
  {
    title: 'The filter API answers where each word was found',
    body: '`POST /check` also answers `positions`: for each word found, the character offsets where it starts in the text. Change the contract and the app; the guestbook is not part of this ticket.\n\nAcceptance criteria\n- [ ] `contract/openapi.yaml` gives `positions` in the answer of `POST /check`, with its examples, and the contract test passes.\n- [ ] `npm test` and `npm run typecheck` pass.',
    services: ['filter-api'],
  },
  {
    title: 'The page says how many entries it holds',
    body: 'Above the list, `src/page.ts` says how many entries the guestbook holds ("3 entries"; "1 entry"; "No entry yet").\n\nAcceptance criteria\n- [ ] The count above the list, singular and plural, with a test.\n- [ ] `npm test` and `npm run typecheck` pass.',
    services: ['guestbook'],
  },
] as const;

// ---- an earlier run ---------------------------------------------------------------

// What an earlier run leaves in the ledger, which the clean base puts
// straight before ticket 1 (proof-base.ts): ticket 1 Done with a lesson
// its handover proposed still waiting, and ticket 2 waiting for its
// approval with its release card. Written as the service writes them, in
// the ledger the service and the stand-in brokers share; their ids.
export function seedEarlierRun(ledger: string, at = new Date()): string[] {
  const db = new DatabaseSync(ledger);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const when = at.toISOString();
    const ticket = (title: string, status: string): string => {
      const row = db.prepare("INSERT INTO tracker_tickets (title, body, labels, project, status, created_at, updated_at) VALUES (?, '', '[]', 'guestbook', ?, ?, ?) RETURNING id").get(title, status, when, when) as { id: number };
      db.prepare("INSERT INTO tracker_history (ticket, status, actor_kind, actor_id, at) VALUES (?, ?, 'agents', 'cleared-v2', ?)").run(row.id, status, when);
      return `LOCAL-${row.id}`;
    };
    const [first, second] = [MULTI_TICKETS[0], MULTI_TICKETS[1]] as const;
    const done = ticket(first.title, 'Done');
    const waiting = ticket(second.title, 'Needs Approval');
    const inbox = new InboxStore(db, () => at);
    inbox.addKnowledge({ ticket: done, project: 'guestbook', sessionId: randomUUID(), text: 'An earlier run\'s lesson: the filter answers ok and words.', level: 'service', service: 'filter-api' });
    inbox.addRelease({
      ticket: waiting, project: 'guestbook', title: second.title, announcement: 'An earlier run\'s release, never approved.', requestedAt: when,
      pr: { number: 900, url: 'https://forge.invalid/rehearsal/guestbook/pull/900', checks: 'pending' }, heads: [{ pr: 900, head: 'e'.repeat(40) }],
      captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
    });
    return [done, waiting];
  } finally {
    db.close();
  }
}

// ---- the workspace file -----------------------------------------------------------

// Where the rehearsal keeps each service: its bare copy (the remote), its
// checkout on the "server", its broker's clone, socket and state folder,
// and the clone the proof recreates its run branch from (proof-base.ts).
export const servicePaths = (root: string, name: string) => ({
  origin: join(root, 'origins', `${name}.git`), dir: join(root, 'services', name, 'checkout'), clone: join(root, 'locks', name), base: join(root, 'base', name),
  socket: join(root, 'brokers', name, 'broker.sock'), state: join(root, 'brokers', name, 'state'),
});

// examples/workspace.conf as the rehearsal needs it: the same services, ids
// and keys, with its own repositories, folders and sockets, so nothing of
// the server's (127.0.0.1:8793, its brokers) is ever named. A sibling's
// `run` port is a port inside the session's network, never bound here.
export function rehearsalWorkspace(options: { readonly root: string; readonly ports: Readonly<Record<ServiceName, number>> }): string {
  const section = (name: ServiceName, extra: string[]) => {
    const p = servicePaths(options.root, name);
    return [`[service ${name}]`, 'kind = repository', `repository = rehearsal/${name}`, `url = ${p.origin}`, `base = ${RUN_BRANCH}`, `dir = ${p.dir}`, 'sensitivity = normal', ...extra,
      `broker_socket = ${p.socket}`, `broker_state = ${p.state}`, ''];
  };
  return [
    '# The multi-service proof\'s workspace, for its rehearsal (scripts/proof-rehearsal-multi.ts):',
    '# examples/workspace.conf with this temporary folder\'s repositories, checkouts and brokers.',
    '[workspace]', 'id = guestbook', 'name = Guestbook and filter API', '',
    ...section('guestbook', ['consumes = filter-api', `run = Dockerfile ${options.ports.guestbook}`]),
    ...section('filter-api', [`run = Dockerfile ${options.ports['filter-api']}`, 'contract = openapi:contract/openapi.yaml']),
  ].join('\n');
}

// ---- the scripted sessions ----------------------------------------------------------

const say = (id: string, delta: string): FakeStep[] => [
  { emit: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: id } },
];
const run = (id: string): FakeStep => ({ emit: { type: 'RUN_STARTED', threadId: 'rehearsal', runId: id } });
const end = (id: string, cost: number, model: string): FakeStep => ({
  emit: { type: 'RUN_FINISHED', threadId: 'rehearsal', runId: id, outcome: { type: 'success' }, usage: [{ model, inputTokens: 20_000, outputTokens: 1_500 }], result: { stopReason: 'end_turn', total_cost_usd: cost } },
});
const REVIEW = 'I read the change of every service and ran the tests.\n\nVerdict: “no blocking issues”\nDefects: none\nTo verify: nothing\nQuestions for the user: None.';

// The contract's answer example of POST /check, as lane 28 wrote it.
const ACCEPTED = '                    ok: true\n                    words: []';
const REFUSED = '                    ok: false\n                    words:\n                      - jackpot\n                      - scam';
const NOTE = { path: 'notes/{ticket}.md', text: '# {ticket}\n\n{title}: written by the rehearsal of the multi-service proof.\n' };
const title = (n: number) => (MULTI_TICKETS[n - 1] as (typeof MULTI_TICKETS)[number]).title.split(',')[0]?.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&') ?? '';
const of = (n: number, step: string) => `^Ticket \\S+: ${title(n)}[\\s\\S]*${step}`;

// The question ticket 3's author asks while it works: the proof answers it
// with the option marked recommended, the second one, and records it.
export const T3_QUESTION: FakeStep = {
  question: {
    requestId: 't3-offsets',
    questions: [{
      question: 'Should the positions count characters from 0 or from 1?', header: 'Offsets',
      options: [{ label: 'From 1', description: 'As a person counts.' }, { label: 'From 0 (Recommended)', description: 'As String.prototype.indexOf answers.' }],
    }],
  },
};

// The authors of each ticket and step (decisions 22 and 26): each proposes
// its plan with a high confidence, then works at the Go. Ticket 4's working
// turn stays open, so the session works when the owner takes it over; its
// reopened author, after Give back, commits what the owner changed.
export function multiScript(): RehearsalScript {
  const planned = (id: string, files: readonly string[], intent: string, more: Partial<Parameters<typeof plannedAuthor>[1]> = {}) =>
    plannedAuthor(id, { confidence: 'high', files, intent, ...more });
  return {
    lead: { rules: [], otherwise: [{ say: 'Understood.' }], context: { start: 1, perTurn: 0.5 }, turnCostUsd: 0.04 },
    author: { steps: planned('author', [NOTE.path], 'The change the ticket asks for'), file: NOTE },
    authorRules: [
      // Ticket 1: the contract gains severity, validated by the owner; then each service, then the integration.
      { when: of(1, 'the contract step'), service: 'filter-api', files: [{ path: 'contract/openapi.yaml', replace: [ACCEPTED, `${ACCEPTED}\n                    severity: none`] }, { path: 'contract/openapi.yaml', replace: [REFUSED, `${REFUSED}\n                    severity: review`] }], steps: planned('t1-contract', ['contract/openapi.yaml'], 'POST /check answers a severity') },
      { when: of(1, 'the step of filter-api'), service: 'filter-api', files: [NOTE], steps: planned('t1-filter', [NOTE.path], 'The filter answers the severity') },
      { when: of(1, 'the step of guestbook'), service: 'guestbook', files: [NOTE], steps: planned('t1-guestbook', [NOTE.path], 'A flagged entry is held for review') },
      { when: of(1, 'the integration step'), service: 'guestbook', files: [], steps: planned('t1-integration', [], 'The end-to-end test across both services') },
      // Ticket 2: no change to the contract; the guestbook's change turns PROOF_BREAK_HEALTH on.
      { when: of(2, 'the contract step'), service: 'filter-api', files: [], steps: planned('t2-contract', [], 'No change to the contract') },
      { when: of(2, 'the step of filter-api'), service: 'filter-api', files: [{ path: 'words.txt', replace: ['scam', 'scam\ncasino'] }], steps: planned('t2-filter', ['words.txt'], 'The filter refuses casino') },
      { when: of(2, 'the step of guestbook'), service: 'guestbook', files: [{ path: 'src/config.ts', replace: ['export const PROOF_BREAK_HEALTH: boolean = false;', 'export const PROOF_BREAK_HEALTH: boolean = true;'] }], steps: planned('t2-guestbook', ['src/config.ts'], 'The refusal lists the words in bold; the provoked failure') },
      { when: of(2, 'the integration step'), service: 'guestbook', files: [], steps: planned('t2-integration', [], 'The end-to-end test across both services') },
      // Ticket 3: the filter API alone changes the contract the guestbook consumes.
      // A ticket of one service has one step and the author's prompt alone (flow/engine.ts start).
      { when: of(3, ''), service: 'filter-api', files: [{ path: 'contract/openapi.yaml', replace: [ACCEPTED, `${ACCEPTED}\n                    positions: {}`] }, NOTE], steps: planned('t3-filter', ['contract/openapi.yaml', NOTE.path], 'POST /check answers the positions', { work: [T3_QUESTION] }) },
      // Ticket 4: works until the owner takes it over.
      { when: of(4, ''), service: 'guestbook', files: [{ path: 'src/page.ts', replace: ['export', '// The count of entries above the list (rehearsal).\nexport'] }], steps: planned('t4-guestbook', ['src/page.ts'], 'The count above the list', { hold: true }) },
    ],
    reviewer: [run('review'), ...say('review-a', REVIEW), end('review', 0.1, 'claude-sonnet-5-5')],
    // After Give back: the notice, read; the human's change committed (reopenCommits); the report.
    reopen: [
      { awaitMessage: true }, run('reopen'), ...say('reopen-a', 'I read the files the owner changed again; the change stays as the owner wrote it.'),
      { hostCall: { toolCallId: 'reopen-report', name: 'report_changes', input: { groups: [{ intent: 'The count above the list', files: ['src/page.ts'] }] } } },
      end('reopen', 0.1, 'claude-opus-5-5'),
    ],
    reopenCommits: true,
  };
}

// ---- the guestbook's watch ----------------------------------------------------------

// The provoked failure (examples/guestbook/src/config.ts): /health answers
// 503 once the merged config turns PROOF_BREAK_HEALTH on (proof-base.ts,
// whose check of the frozen base reads it too).
export { breaksHealth };

// ---- the containers' stand-in ---------------------------------------------------------

export type StubContext = {
  // The session's ticket and its checkout on this machine, when the ledger knows it.
  readonly session: (id: string) => { readonly ticket: string; readonly checkout: string } | undefined;
  readonly services: readonly string[];
  readonly trialPort: number;
  readonly pidFile: (session: string) => string;
};

export type StubAnswer =
  | { readonly kind: 'answer'; readonly code: number; readonly stdout: string }
  | { readonly kind: 'program'; readonly args: readonly string[] }            // node's arguments
  | { readonly kind: 'shell'; readonly cwd: string; readonly session: string; readonly pidFile: string }
  | { readonly kind: 'end'; readonly pidFile: string }
  | { readonly kind: 'refuse'; readonly why: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LABEL_FILTER = 'label=cleared.dev=v2';
const PROGRAMS = new Set([READ_PROGRAM, WRITE_PROGRAM, TAKE_PROGRAM, GIVE_PROGRAM]);
const MOUNT = '/workspace';
// Each container of a session on its network: the siblings in the
// workspace's order, then the session and its egress.
const address = (index: number) => `10.89.0.${2 + index}`;

function parts(ctx: StubContext): string[] {
  return ['session', 'egress', ...ctx.services.map((name) => `sib-${name}`)];
}

// A stub id: the session, and which of its containers.
function owned(ctx: StubContext, id: string): { session: string; part: string } | undefined {
  const m = new RegExp(`^stub-(${UUID})-(.+)$`).exec(id);
  if (!m || !ctx.session(m[1] as string)) return undefined;
  return parts(ctx).includes(m[2] as string) ? { session: m[1] as string, part: m[2] as string } : undefined;
}

const ok = (stdout = ''): StubAnswer => ({ kind: 'answer', code: 0, stdout });
const refuse = (why: string): StubAnswer => ({ kind: 'refuse', why });

// What the docker wrapper (src/container/docker.ts) asks, answered as a
// session's containers would; anything else refused.
export function dockerStub(args: readonly string[], ctx: StubContext): StubAnswer {
  const [first = '', second = ''] = args;
  const verb = ['network', 'volume', 'image'].includes(first) ? `${first} ${second}` : first;
  const filters = args.flatMap((arg, i) => (arg === '--filter' ? [args[i + 1] ?? ''] : []));
  const after = args.indexOf('--') >= 0 ? args.slice(args.indexOf('--') + 1) : [];
  if (verb === 'ps') {
    if (!filters.includes(LABEL_FILTER)) return refuse('a list without the label filter');
    const session = filters.map((f) => new RegExp(`^label=cleared\\.session=(${UUID})$`).exec(f)?.[1]).find(Boolean);
    if (!session || !ctx.session(session)) return ok();
    return ok(parts(ctx).map((part) => `${JSON.stringify({ ID: `stub-${session}-${part}`, Names: `cleared-v2-${session}-${part}`, State: 'running', Labels: `cleared.dev=v2,cleared.session=${session},cleared.role=${part.startsWith('sib-') ? 'sibling' : part}` })}\n`).join(''));
  }
  if (verb === 'network ls' || verb === 'volume ls' || verb === 'image ls') return filters.includes(LABEL_FILTER) ? ok() : refuse('a list without the label filter');
  if (verb === 'stop' || verb === 'rm' || verb === 'start') return after.length > 0 && after.every((id) => owned(ctx, id)) ? ok() : refuse(`${verb} of what no labelled list returned`);
  if (verb === 'inspect') {
    const target = after.length === 1 ? owned(ctx, after[0] as string) : undefined;
    if (!target || args[1] !== '--type' || args[2] !== 'container') return refuse('an inspection of what no labelled list returned');
    const sibling = target.part.startsWith('sib-') ? ctx.services.indexOf(target.part.slice(4)) : -1;
    const ip = sibling >= 0 ? address(sibling) : target.part === 'session' ? '10.89.0.20' : '10.89.0.21';
    return ok(`${JSON.stringify([{ Id: after[0], State: { Running: true }, Config: { User: 'node' }, NetworkSettings: { Networks: { [`cleared-v2-${target.session}`]: { IPAddress: ip } } } }])}\n`);
  }
  if (verb !== 'exec') return refuse(`docker ${verb} is not part of the rehearsal`);
  const at = args.indexOf('--');
  if (at < 0) return refuse('an exec without "--"');
  // The exec's own flags: the ones the wrapper writes, and nothing else.
  const flags = args.slice(1, at);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] as string;
    if (flag === '--interactive' || flag === '--tty') continue;
    if (flag === '--env' || flag === '--user' || flag === '--workdir') { i++; continue; }
    return refuse(`an exec flag the wrapper does not write: ${flag}`);
  }
  const target = owned(ctx, args[at + 1] ?? '');
  const command = args.slice(at + 2);
  if (!target) return refuse('an exec in what no labelled list returned');
  const known = ctx.session(target.session) as { ticket: string; checkout: string };
  if (target.part === 'session') {
    // The terminal's Shell (terminal/container.ts); a harness resumed there is a model's, never a rehearsal's.
    const shell = terminalCommand(SHELL_COMMAND);
    if (flags.includes('--tty') && command.length === shell.length && command.every((word, i) => word === shell[i]))
      return { kind: 'shell', cwd: known.checkout, session: target.session, pidFile: ctx.pidFile(target.session) };
    if (command.length === END_TERMINAL.length && command.every((word, i) => word === END_TERMINAL[i])) return { kind: 'end', pidFile: ctx.pidFile(target.session) };
    if (command[0] === 'node' && command[1] === '-e' && PROGRAMS.has(command[2] ?? '') && command[3] === '--' && command[4] === MOUNT)
      return { kind: 'program', args: ['-e', command[2] as string, '--', known.checkout, ...command.slice(5)] };
    return refuse('a command in the session\'s container that is not one of the service\'s programs');
  }
  if (target.part === 'egress' && command[0] === 'node' && command[1] === '-e' && command[2] === RELAY && command.length === 6) {
    let url: URL;
    try { url = new URL(command[3] as string); } catch { return refuse('a relay to no address'); }
    const index = [...ctx.services.keys()].find((i) => address(i) === url.hostname);
    if (index === undefined || url.protocol !== 'http:') return refuse('a relay to an address of no sibling');
    const service = ctx.services[index] as string;
    return { kind: 'program', args: ['-e', RELAY, `http://127.0.0.1:${ctx.trialPort}/__session/${target.session}/${service}${url.pathname}${url.search}`, command[4] as string, command[5] as string] };
  }
  return refuse('a command in a sibling\'s container');
}

// The human's stand-in shell: the lines the proof types, answered.
export type ShellAnswer = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'git-status' } | { readonly kind: 'exit' };

export function shellAnswer(raw: string): ShellAnswer {
  const line = raw.trim();
  if (line === '') return { kind: 'text', text: '' };
  if (line === 'pwd') return { kind: 'text', text: MOUNT };
  if (line === 'git status') return { kind: 'git-status' };
  if (line === 'exit') return { kind: 'exit' };
  if (line === 'npm ci') return { kind: 'text', text: 'npm ci: the rehearsal\'s stand-in shell installs nothing (a real session\'s container does)' };
  if (line === 'npm test') return { kind: 'text', text: 'npm test: the rehearsal\'s stand-in shell does not run the project\'s tests (a real session\'s container does)' };
  if (/^git push\b/.test(line)) return { kind: 'text', text: 'fatal: could not read Username for the remote: no credential in the session\'s container' };
  return { kind: 'text', text: `${line.split(/\s+/)[0]}: not part of the rehearsal's stand-in shell` };
}

// ---- the trial environment's stand-in --------------------------------------------------

// The session's siblings on its network: the guestbook's page and the
// filter API's fake, one fake per session (each session has its own
// sibling), built from the ticket's validated contract (ticket_steps).
function startTrial(options: { readonly ledger: string; readonly workdirs: string; readonly log: (line: string) => void }): { server: Server; calls: (session: string) => { total: number; operations: Record<string, number>; source: string } | undefined } {
  const fakes = new Map<string, { fake: Fake; source: string }>();
  const read = <T>(sql: string, ...values: string[]): T | undefined => {
    const db = new DatabaseSync(options.ledger, { readOnly: true });
    try { return db.prepare(sql).get(...values) as T | undefined; } catch { return undefined; } finally { db.close(); }
  };
  const fakeOf = (session: string): { fake: Fake; source: string } => {
    const known = fakes.get(session);
    if (known) return known;
    const ticket = read<{ ticket: string }>('SELECT ticket FROM sessions WHERE id = ?', session)?.ticket ?? '';
    const validated = read<{ contract: string | null }>("SELECT contract FROM ticket_steps WHERE ticket = ? AND kind = 'contract' AND state = 'done' AND contract IS NOT NULL ORDER BY position LIMIT 1", ticket)?.contract;
    const checkout = join(options.workdirs, ticket, 'filter-api', 'contract', 'openapi.yaml');
    const file = validated && existsSync(validated) ? validated : existsSync(checkout) ? checkout : join(EXAMPLES, 'filter-api', 'contract', 'openapi.yaml');
    const made = { fake: createFake(readContract(readFileSync(file, 'utf8'), file)), source: validated && file === validated ? 'the contract as validated' : 'the contract of the ticket branch' };
    fakes.set(session, made);
    options.log(`trial: the fake of the filter API for ${ticket} (${session.slice(0, 8)}) from ${made.source}`);
    return made;
  };
  const server = createServer((request, response) => {
    request.resume();
    const m = new RegExp(`^/__session/(${UUID})/([a-z-]+)(/[^?]*)?(\\?.*)?$`).exec(request.url ?? '');
    if (!m) { response.writeHead(404).end(); return; }
    const [, session = '', service = '', path = '/', query = ''] = m;
    const { fake, source } = fakeOf(session);
    if (service === 'filter-api') {
      const answer = fake.handle(request.method ?? 'GET', `${path}${query}`);
      response.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(answer.body ?? null));
      return;
    }
    // The guestbook's page, which checks a sample entry with the filter, as the guestbook does before it stores one.
    const checked = fake.handle('POST', '/check');
    const html = `<!doctype html><meta charset="utf-8"><title>Guestbook</title><h1>${guestbookHeading(0)}</h1>
<p>The trial environment of this session: the rehearsal's stand-in for the guestbook built from the ticket branch.</p>
<p>A sample entry was checked by the filter API, a fake built from ${source}: it answered ${checked.status}, <code>${JSON.stringify(checked.body).replace(/[<>&]/g, '')}</code>.</p>`;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  return {
    server,
    calls: (session) => {
      const known = fakes.get(session);
      if (!known) return undefined;
      const body = known.fake.handle('GET', '/__fake/calls').body as { total: number; operations: Record<string, number> };
      return { ...body, source: known.source };
    },
  };
}

// ---- the world ----------------------------------------------------------------------

export type MultiWorld = {
  readonly root: string;
  readonly appUrl: string;
  readonly serviceUrl: string;
  readonly owner: string;
  readonly passwordFile: string;
  readonly ledger: string;
  readonly docker: string;                                  // the docker stand-in, for the proof's own reading of the fake
  readonly standIns: readonly string[];
  readonly base: BaseSettings;                              // the clean base, on the bare copies
  stop(): Promise<void>;
};

async function waitFor(what: string, check: () => Promise<boolean>, ms: number, child: ChildProcess): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${what} exited with ${child.exitCode}`);
    if (await check().catch(() => false)) return;
    if (Date.now() > until) throw new Error(`${what} did not start within ${Math.round(ms / 1000)} s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const OWNER = 'owner';

export async function startMultiRehearsal(options: { readonly log: (line: string) => void; readonly watchMs?: number }): Promise<MultiWorld> {
  buildApp(options.log);
  const root = mkdtempSync(join(tmpdir(), 'cleared-j2-multi-'));
  const dir = (...p: string[]) => { const path = join(root, ...p); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const state = dir('state');
  const home = dir('home');
  const bin = dir('bin');
  const notify = dir('notify');
  const work = join(root, 'work');
  const forge = join(root, 'forge.json');
  const mail = join(root, 'mail.log');
  const identity = { GIT_AUTHOR_NAME: 'Cleared', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'Cleared', GIT_COMMITTER_EMAIL: '' };
  const base = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, LANG: 'C.UTF-8', TZ: process.env.TZ ?? 'UTC' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...base, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] });

  const setup = execFileSync(process.execPath, ['--no-warnings', join(V2, 'src/cli/setup.ts'), '--owner', OWNER, '--key', join(state, 'approval.key')], { env: { ...base, CLEARED_STATE_DIR: state }, encoding: 'utf8' });
  const publicKey = /human_public_key = (\S+)/.exec(setup)?.[1];
  if (!publicKey) throw new Error('setup gave no public key');

  // Each example, committed once with the owner's key, copied bare as its remote.
  let firstConf = '';
  for (const name of SERVICES) {
    const p = servicePaths(root, name);
    const seed = join(root, 'seeds', name);
    cpSync(join(EXAMPLES, name), seed, { recursive: true, filter: (source) => !source.includes('node_modules') });
    const conf = readFileSync(join(seed, '.cleared', 'agents.conf'), 'utf8').replace(/^\[tracker\]$/m, `[tracker]\nhuman_public_key = ${publicKey}`);
    writeFileSync(join(seed, '.cleared', 'agents.conf'), conf);
    if (name === 'guestbook') firstConf = conf;
    git(seed, 'init', '--quiet', '--initial-branch=main');
    git(seed, 'add', '--all');
    git(seed, 'commit', '--quiet', '-m', `The example ${name}, for the rehearsal`);
    mkdirSync(join(root, 'origins'), { recursive: true, mode: 0o700 });
    git(root, 'clone', '--quiet', '--bare', seed, p.origin);
    // The clean base as the real proof repositories keep it: the frozen
    // branch, and a run branch an earlier run left a commit on, which the
    // proof recreates from the frozen one before its first ticket.
    git(p.origin, 'branch', FROZEN_BRANCH, 'main');
    git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'What an earlier run merged');
    git(seed, 'push', '--quiet', p.origin, `HEAD:refs/heads/${RUN_BRANCH}`);
    git(root, 'clone', '--quiet', p.origin, p.base);
    mkdirSync(join(root, 'locks'), { recursive: true, mode: 0o700 });
    git(root, 'clone', '--quiet', p.origin, p.clone);
    mkdirSync(p.state, { recursive: true, mode: 0o700 });
  }

  const machine = join(root, 'agents.conf');
  writeFileSync(machine, `${firstConf}
# The rehearsal's machine settings (scripts/proof-rehearsal-multi.ts).
[tracker]
owner_id = ${OWNER}
human_private_key = ${join(state, 'approval.key')}
[notify]
adapters = email
secrets_dir = ${notify}
coalesce_minutes = 1
`);
  writeFileSync(join(notify, 'credentials.json'), JSON.stringify({ email: { to: 'owner@guestbook.invalid', from: 'cleared@guestbook.invalid' } }), { mode: 0o600 });
  writeFileSync(join(bin, 'sendmail'), `#!/bin/sh\n{ printf '%s\\n' "---- $(date -u +%FT%TZ)"; cat; } >> "${mail}"\n`, { mode: 0o755 });
  writeFileSync(forge, JSON.stringify({ next: 101, prs: [] }));
  writeGhStub(bin, forge, Object.fromEntries(SERVICES.map((name) => [`rehearsal/${name}`, servicePaths(root, name).origin])));

  const script = join(root, 'script.json');
  writeFileSync(script, JSON.stringify(multiScript(), null, 2));
  const passwordFile = join(root, 'password');
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  execFileSync(process.execPath, ['--no-warnings', join(V2, 'src/cli/user.ts'), 'add', OWNER], { env: { ...base, CLEARED_STATE_DIR: state }, input: `${password}\n${password}\n`, stdio: ['pipe', 'ignore', 'pipe'] });

  const inUse = listening();
  const taken = new Set(inUse);
  const pick = () => { const port = freePort(taken); taken.add(port); return port; };
  const [servicePort, appPort, previewPort, trialPort] = [pick(), pick(), pick(), pick()];
  // The siblings' ports inside the session's network: never bound on this machine.
  const workspace = join(root, 'workspace.conf');
  writeFileSync(workspace, rehearsalWorkspace({ root, ports: { guestbook: 3000, 'filter-api': 3001 } }));

  const ledger = join(state, 'ledger.db');
  const watchMs = options.watchMs ?? 15_000;
  const brokers: net.Server[] = [];
  for (const name of SERVICES) {
    const p = servicePaths(root, name);
    brokers.push(await startBroker({
      socket: p.socket, state: p.state, ledger, forge, origin: p.origin, clone: p.clone, watchMs, log: options.log, repo: `rehearsal/${name}`, name, base: RUN_BRANCH,
      ...(name === 'guestbook' ? { watch: ({ clone }) => (breaksHealth(readFileSync(join(clone, 'src', 'config.ts'), 'utf8')) ? 'failing' : 'healthy') } : {}),
    }));
  }

  // The containers' stand-in and the trial environment's.
  const trial = startTrial({ ledger, workdirs: work, log: options.log });
  await new Promise<void>((ready, fail) => { trial.server.once('error', fail); trial.server.listen(trialPort, '127.0.0.1', () => ready()); });
  const containers = join(root, 'containers.json');
  writeFileSync(containers, JSON.stringify({ ledger, workdirs: work, services: SERVICES, trialPort, root }), { mode: 0o600 });
  const docker = join(bin, 'docker');
  writeFileSync(docker, `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${SELF}" docker-stub "${containers}" "$@"\n`, { mode: 0o755 });

  const env = {
    ...base,
    CLEARED_STATE_DIR: state, CLEARED_CONF: machine, CLEARED_REPO: servicePaths(root, 'guestbook').dir,
    CLEARED_V2_HOST: '127.0.0.1', CLEARED_V2_PORT: String(servicePort), CLEARED_V2_WORKSPACE: workspace,
    CLEARED_V2_STATE_DIR: state, CLEARED_V2_WORKDIRS: work,
    CLEARED_V2_ADAPTER: 'fake', CLEARED_V2_FAKE_SCRIPT: script,
    CLEARED_V2_AUTHOR_MODEL: 'claude-opus-5-5', CLEARED_V2_REVIEWER_MODEL: 'claude-sonnet-5-5', CLEARED_V2_LEAD_MODEL: 'claude-opus-5-5',
    CLEARED_V2_LEAD_CONTEXT_PERCENT: '50', CLEARED_V2_LEAD_BATCH_SECONDS: '5', CLEARED_V2_MERGE_RETRY_SECONDS: '10',
    CLEARED_RELEASE_SOCKET: servicePaths(root, 'guestbook').socket, CLEARED_NOTIFY_SENDMAIL: join(bin, 'sendmail'), CLEARED_NOTIFY_LINK_BASE: `http://127.0.0.1:${appPort}`,
  };
  const children: ChildProcess[] = [];
  const start = (name: string, entry: string, extra: Record<string, string>) => {
    const out = openSync(join(root, `${name}.log`), 'a', 0o600);
    const child = spawn(process.execPath, ['--no-warnings', join(V2, entry)], { cwd: V2, env: { ...env, ...extra }, stdio: ['ignore', out, out] });
    closeSync(out);
    children.push(child);
    return child;
  };
  const service = start('service', 'src/main.ts', {});
  await waitFor('the service', async () => (await fetch(`http://127.0.0.1:${servicePort}/health`)).ok, 30_000, service);
  const earlier = seedEarlierRun(ledger);
  const app = start('app', 'app/main.ts', { CLEARED_V2_APP_PORT: String(appPort), CLEARED_V2_APP_HOST: '127.0.0.1', CLEARED_V2_APP_PROJECT: 'guestbook', CLEARED_V2_PREVIEW_PORT: String(previewPort) });
  await waitFor('the app', async () => (await fetch(`http://127.0.0.1:${appPort}/`, { redirect: 'manual' })).status < 500, 30_000, app);
  options.log(`rehearsal: ${root}, service on ${servicePort}, app on ${appPort}, preview on ${previewPort}, trial stand-in on ${trialPort}; an earlier run's ${earlier.join(' and ')} left open`);

  return {
    root, appUrl: `http://127.0.0.1:${appPort}`, serviceUrl: `http://127.0.0.1:${servicePort}`, owner: OWNER, passwordFile, ledger, docker,
    base: { frozen: FROZEN_BRANCH, run: RUN_BRANCH, remote: 'origin', repos: SERVICES.map((name) => ({ service: name, clone: servicePaths(root, name).base })), deployMs: 60_000 },
    standIns: [
      'the forge: a bare copy of each example as its remote, and a gh stand-in that opens, lists and passes pull requests per repository in a file',
      'the locks: two stand-in brokers, one socket and one state folder each on the one ledger, that merge an approved branch into the bare copy and write the release watch\'s rows themselves; the guestbook\'s watch fails twice and reverts its merge when the merged src/config.ts turns PROOF_BREAK_HEALTH on, instead of probing a deployed /health',
      'the deployments: nothing is deployed and no /health is probed; the clean base recreates the run branch on the bare copies, closes no pull request (the forge stand-in has none of an earlier run) and waits for no watcher',
      'the earlier run: two tickets written into the ledger before the run (ticket 1 Done with a knowledge item waiting, ticket 2 in Needs Approval with its release card), which the clean base sets aside through the app',
      'the containers: a docker stand-in answers the labelled lists and inspections of a session\'s containers, runs the service\'s own programs (the editor\'s read and save, the checkout at Take over and Give back) on the session\'s checkout on this machine, and relays the preview; no container, no network and no image exist',
      'the trial environment: a loopback stand-in for the session\'s siblings, the guestbook\'s page and the filter API\'s fake; the fake is images/fake/fake.ts built from the contract the owner validated, and the page checks one sample entry with it at each load',
      'the harness in the terminal: the fake adapter\'s scripted sessions have no interactive harness, so Take over shows the harness as unsupported and step 11 goes to the Shell; Take over attached to a live Claude Code harness, then the Shell beside it, is shown by the real run only',
      'the human\'s terminal: a stand-in shell answers pwd, runs git status on the checkout, says it does not run npm ci nor npm test, and refuses a push for want of a credential',
      'the models: the authors and the reviewers play a script (session/adapters/index.ts); their plans, changes and verdicts are scripted, not judged',
    ],
    async stop() {
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.all(children.map((child) => (child.exitCode !== null ? undefined : new Promise((r) => child.once('exit', r)))));
      await Promise.all(brokers.map((broker) => new Promise((r) => broker.close(r))));
      await new Promise((r) => trial.server.close(r));
    },
  };
}

// ---- run as docker, or as the human's shell ---------------------------------------------

function stubContext(file: string): StubContext {
  const config = JSON.parse(readFileSync(file, 'utf8')) as { ledger: string; workdirs: string; services: string[]; trialPort: number; root: string };
  return {
    services: config.services, trialPort: config.trialPort,
    pidFile: (session) => join(config.root, `terminal-${session}.pid`),
    session(id) {
      const db = new DatabaseSync(config.ledger, { readOnly: true });
      let row: { ticket: string; service: string | null } | undefined;
      try { row = db.prepare('SELECT ticket, service FROM sessions WHERE id = ?').get(id) as typeof row; } catch { row = undefined; } finally { db.close(); }
      if (!row) return undefined;
      // A ticket of several services has a checkout per service; a ticket of one keeps <workdirs>/<ticket>.
      const scoped = row.service ? join(config.workdirs, row.ticket, row.service) : '';
      const isDir = (path: string) => path !== '' && (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false);
      return { ticket: row.ticket, checkout: isDir(scoped) ? scoped : join(config.workdirs, row.ticket) };
    },
  };
}

function shellStub(cwd: string, pidFile: string): void {
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const prompt = () => process.stdout.write(`rehearsal:${MOUNT}$ `);
  process.on('SIGHUP', () => process.exit(0));
  prompt();
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on('line', (line) => {
    const answer = shellAnswer(line);
    if (answer.kind === 'exit') process.exit(0);
    if (answer.kind === 'git-status') {
      try { process.stdout.write(execFileSync('git', ['-C', cwd, 'status'], { encoding: 'utf8' })); } catch { process.stdout.write('git status failed\n'); }
    } else if (answer.text) process.stdout.write(`${answer.text}\n`);
    prompt();
  });
  lines.on('close', () => process.exit(0));
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const [mode, file, ...args] = process.argv.slice(2) as [string, string, ...string[]];
  if (mode === 'shell-stub') shellStub(file, args[0] as string);
  else if (mode === 'docker-stub') {
    const answer = dockerStub(args, stubContext(file));
    if (answer.kind === 'refuse') {
      process.stderr.write(`docker (rehearsal): refused: ${answer.why}\n`);
      process.exitCode = 1;
    } else if (answer.kind === 'answer') {
      process.stdout.write(answer.stdout);
      process.exitCode = answer.code;
    } else if (answer.kind === 'end') {
      // The stand-in shell only: its pid file names it, and /proc says it is one.
      let pid = 0;
      try { pid = Number(readFileSync(answer.pidFile, 'utf8').trim()); } catch { pid = 0; }
      let ours = false;
      try { ours = pid > 0 && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('shell-stub') && statSync(`/proc/${pid}`).uid === process.getuid?.(); } catch { ours = false; }
      if (ours) process.kill(pid, 'SIGHUP');
      rmSync(answer.pidFile, { force: true });
    } else {
      const child = answer.kind === 'shell'
        ? spawn(process.execPath, ['--no-warnings', SELF, 'shell-stub', answer.cwd, answer.pidFile], { stdio: 'inherit', cwd: answer.cwd })
        : spawn(process.execPath, ['--no-warnings', ...answer.args], { stdio: 'inherit' });
      child.on('close', (code) => { process.exitCode = code ?? 1; });
    }
  }
}
