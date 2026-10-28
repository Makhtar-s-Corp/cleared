// The rehearsal of the milestone 5 proof (docs/v2/milestone-5-plan.md,
// sections 1 and 16; the real run's sheet is docs/v2/proof-j5.md): on this
// server, under a scratch Compose project name and free ports, with every
// Docker object labelled cleared.dev=v2.
//   1. The image of Cleared is built from this clone (the server may hold
//      an older one under the same tag, which the build moves and the
//      cleanup gives back), then the one command runs as the README gives
//      it: `docker compose -f v2/compose.yaml run --rm install`.
//   2. The rehearsal puts its fakes at the edges, and recreates the service
//      once with them (an override file of the scratch folder, never
//      v2/compose.yaml): a fake GitHub on loopback for the forge step and
//      the doctor, a gh stand-in on the service's PATH that lists the
//      repository and keeps the pull requests in a file, a bare copy of the
//      example guestbook as the remote, the fake harness
//      (CLEARED_V2_ADAPTER=fake) for the author and the reviewer, and a
//      stand-in lock on a Unix socket of the scratch folder.
//   3. Playwright walks the assistant as a newcomer would, from the setup
//      code to the first ticket's approval in the inbox and its live.
//   4. Each step's time comes from the assistant's own records (GET
//      /api/setup through the app), the command's from this script's clock; the report is
//      written as proof-report.ts writes the others, outside the repository.
//   5. Everything the rehearsal made is removed by the label: the scratch
//      project's objects, and what the service made with the label alone
//      since the rehearsal began, never an object that was there before.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core CLEARED_V2_CHROME=/usr/bin/google-chrome \
//     node scripts/proof-j5.ts [--language en|fr] [--report <file>]
//
// No port is opened but the three of Cleared (9700 to 9799, checked free
// with `ss -ltn`, never a reserved one) and the fake GitHub's (an ephemeral
// one), all on 127.0.0.1. No tunnel, no real account, no Claude login read.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETUP_CODE_LINE } from '../src/setup/code.ts';
import type { StepId, StepState, StepView } from '../src/setup/types.ts';
import type { RehearsalScript } from '../src/session/adapters/index.ts';
import type { FakeStep } from '../src/session/adapters/fake.ts';
import { duration } from './proof-report.ts';
import { freePort, listening, startBroker } from './proof-rehearsal.ts';

const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMPOSE = 'v2/compose.yaml';
const GUESTBOOK = fileURLToPath(new URL('../../examples/guestbook/', import.meta.url));
// Where the image of Cleared holds this clone, and its node.
const IN_IMAGE = { node: '/usr/local/bin/node', self: '/opt/cleared/v2/scripts/proof-j5.ts', rehearsal: '/opt/cleared/v2/scripts/proof-rehearsal.ts' };
const IMAGE = 'cleared-v2:local';
const LABEL = 'cleared.dev=v2';
const PROJECT_LABEL = 'com.docker.compose.project';

// ---- the steps ----------------------------------------------------------------

// Section 1's ten steps. Steps 2 to 9 are the assistant's, in its registry's
// order (src/setup/steps.ts); its first-ticket step holds both 9 and 10.
export const PROOF_STEPS: readonly { readonly n: number; readonly id: 'command' | StepId | 'live'; readonly name: string }[] = [
  { n: 1, id: 'command', name: 'The one command: the images, Cleared started, its address and the setup line' },
  { n: 2, id: 'owner', name: 'The setup code and the owner\'s account' },
  { n: 3, id: 'forge', name: 'The forge: a GitHub credential checked on the spot' },
  { n: 4, id: 'model', name: 'The model: the login claude setup-token prints' },
  { n: 5, id: 'workspace', name: 'The repository picked and cloned' },
  { n: 6, id: 'environment', name: 'The environment: the prepared image built' },
  { n: 7, id: 'secrets', name: 'The test secrets, or the step skipped' },
  { n: 8, id: 'checks', name: 'The checks: the ready lines of cleared doctor' },
  { n: 9, id: 'first-ticket', name: 'The first ticket, from Todo to the approval' },
  { n: 10, id: 'live', name: 'From the approval to live, through the lock' },
];

// ---- ports, names -------------------------------------------------------------

export type Ports = { readonly service: number; readonly app: number; readonly preview: number };

// The three ports of Cleared: free, distinct, never a reserved one.
export function choosePorts(inUse: ReadonlySet<number>, random: () => number = Math.random): Ports {
  const service = freePort(inUse, random);
  const app = freePort(new Set([...inUse, service]), random);
  const preview = freePort(new Set([...inUse, service, app]), random);
  return { service, app, preview };
}

export const scratchName = (random: () => number = Math.random): string =>
  `cleared-v2-proof-${Math.floor(random() * 0x1_0000_0000).toString(16).padStart(8, '0')}`;

// ---- the cleanup --------------------------------------------------------------

export type DockerObject = { readonly kind: 'container' | 'image' | 'network' | 'volume'; readonly id: string; readonly name: string; readonly labels: Readonly<Record<string, string>> };

// The second name the rehearsal gives an image the shared tag named before
// it: the build moves the tag, and an image left with no name is gone
// under Docker's containerd store, even while containers of another
// install run on it.
export const keepName = (project: string): string => `cleared-v2-proof-keep:${project.slice(project.lastIndexOf('-') + 1)}`;

// What the rehearsal made: an object with the label, of the scratch project,
// or new since the rehearsal began and of no Compose project (what the
// service makes: prepared images, session containers, their networks).
// Another project's object, one there before, one without the label: never.
// Then the shared tag goes back to the image `kept` names, and that second
// name goes.
export function cleanupPlan(options: {
  readonly before: readonly DockerObject[]; readonly after: readonly DockerObject[]; readonly project: string;
  readonly kept: string | null; readonly image: string;
}): { readonly remove: readonly DockerObject[]; readonly commands: readonly (readonly string[])[] } {
  const key = (o: DockerObject) => `${o.kind} ${o.id}`;
  const before = new Set(options.before.map(key));
  const mine = (o: DockerObject) => o.labels['cleared.dev'] === 'v2'
    && (o.labels[PROJECT_LABEL] === options.project || (!before.has(key(o)) && o.labels[PROJECT_LABEL] === undefined));
  const remove = options.after.filter(mine);
  const commands: string[][] = [];
  for (const [kind, words] of [['container', ['rm', '--force']], ['network', ['network', 'rm']], ['image', ['image', 'rm']], ['volume', ['volume', 'rm']]] as const) {
    const ids = remove.filter((o) => o.kind === kind).map((o) => o.id);
    if (ids.length > 0) commands.push([...words, ...ids]);
  }
  if (options.kept) commands.push(['tag', options.kept, options.image], ['image', 'rm', options.kept]);
  return { remove, commands };
}

// ---- the fakes ----------------------------------------------------------------

// The override the rehearsal gives the service, and only the service.
export function overrideFile(options: { readonly fakes: string; readonly path: string; readonly script: string; readonly api: string; readonly socket: string; readonly conf: string; readonly repo: string }): string {
  for (const value of Object.values(options))
    if (/["\\$\n]/.test(value)) throw new Error('a value of the override holds a quote, a backslash, a dollar or a new line');
  return [
    '# The rehearsal\'s fakes (scripts/proof-j5.ts), for the service alone.',
    'services:',
    '  service:',
    '    environment:',
    `      PATH: "${options.fakes}/bin:${options.path}"`,
    '      CLEARED_V2_ADAPTER: "fake"',
    `      CLEARED_V2_FAKE_SCRIPT: "${options.script}"`,
    `      CLEARED_V2_FORGE_GITHUB_API: "${options.api}"`,
    `      CLEARED_RELEASE_SOCKET: "${options.socket}"`,
    `      CLEARED_CONF: "${options.conf}"`,
    `      CLEARED_REPO: "${options.repo}"`,
    '    volumes:',
    `      - "${options.fakes}:${options.fakes}"`,
    '',
  ].join('\n');
}

export type FakeRepository = { readonly repo: string; readonly url: string; readonly base: string };

const repositoryBody = (r: FakeRepository) => ({
  full_name: r.repo, clone_url: r.url, default_branch: r.base, private: true, archived: false, permissions: { admin: false, push: true, pull: true },
});

// The fake GitHub's answers: what the forge step and the doctor read.
export function fakeGitHub(method: string, path: string, auth: string | undefined, token: string, repos: readonly FakeRepository[]): { readonly status: number; readonly body: unknown } {
  if (auth !== `Bearer ${token}` && auth !== `token ${token}`) return { status: 401, body: { message: 'Bad credentials' } };
  const url = new URL(path, 'http://fake');
  if (method !== 'GET') return { status: 404, body: { message: 'Not Found' } };
  if (url.pathname === '/user') return { status: 200, body: { login: 'rehearsal', id: 1, type: 'User' } };
  if (url.pathname === '/user/repos') return { status: 200, body: repos.map(repositoryBody) };
  const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname)?.[1];
  const found = repos.find((r) => r.repo === repo);
  return found ? { status: 200, body: repositoryBody(found) } : { status: 404, body: { message: 'Not Found' } };
}

// What the gh stand-in answers of `gh api`, as gh prints it after its --jq
// (forge/github.ts): the list a line per repository, one repository whole.
// Anything else is the milestone 2 stand-in's (proof-rehearsal.ts).
export function ghApiAnswer(args: readonly string[], repos: readonly FakeRepository[]): { readonly code: number; readonly stdout: string } | undefined {
  if (args[0] !== 'api') return undefined;
  const endpoint = args.at(-1) ?? '';
  if (/^(user\/repos|installation\/repositories)\b/.test(endpoint))
    return { code: 0, stdout: repos.map((r) => `${JSON.stringify({ repo: r.repo, url: r.url, base: r.base, private: true, archived: false })}\n`).join('') };
  const found = repos.find((r) => `repos/${r.repo}` === endpoint);
  if (!found) return { code: 1, stdout: '' };
  const { full_name, clone_url, default_branch, private: closed, archived } = repositoryBody(found);
  return { code: 0, stdout: `${JSON.stringify({ full_name, clone_url, default_branch, private: closed, archived })}\n` };
}

// The line of the first ticket (src/setup/steps/first-ticket.ts), which the
// fake author adds at the end of the README.
export const FIRST_TICKET_LINE = {
  en: 'This project takes its changes through Cleared: an author, a reviewer, and the owner\'s approval.',
  fr: 'Ce projet passe ses changements par Cleared : un auteur, un relecteur et l\'approbation du propriétaire.',
} as const;

const text = (id: string, delta: string): FakeStep[] => [
  { emit: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: id } },
];
// No cost: a fake session has none to report, so no money reaches a page.
const run = (id: string, model: string, words: FakeStep[]): FakeStep[] => [
  { emit: { type: 'RUN_STARTED', threadId: 'proof-j5', runId: id } },
  ...words,
  { emit: { type: 'RUN_FINISHED', threadId: 'proof-j5', runId: id, outcome: { type: 'success' }, usage: [{ model, inputTokens: 12_000, outputTokens: 800 }], result: { stopReason: 'end_turn', total_cost_usd: null } } },
];
const REVIEW = 'I read the change and ran the tests.\n\nVerdict: “no blocking issues”\nDefects: none\nTo verify: nothing\nQuestions for the user: None.';

// The fake harness's script: any author start proposes its session plan
// (decision 22 of milestone 2: the flow holds an author until its plan has
// a Go), then, at the Go, adds the line after the README's last one; the
// reviewer passes it. The lead plays no act: it starts once the workspace
// is connected (issue #420), and has nothing to do here.
export function firstTicketScript(readme: string, line: string): RehearsalScript {
  const last = readme.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  const model = 'claude-opus-5-5';
  const intent = 'One line at the end of the README, as the ticket asks';
  const plan: FakeStep = { hostCall: { toolCallId: 'author-plan', name: 'propose_session_plan', input: { steps: [intent, 'Run the tests, commit'], files: ['README.md'], confidence: 'high', reason: 'One line added at the end of one file.' } } };
  const report: FakeStep = { hostCall: { toolCallId: 'author-report', name: 'report_changes', input: { groups: [{ intent, files: ['README.md'] }] } } };
  const steps: FakeStep[] = [
    ...run('author-plan', model, [...text('author-p', 'I read what the ticket needs. Here is my plan.'), plan]),
    { awaitMessage: true },
    ...run('author-work', model, [...text('author-a', 'I added the line at the end of the README, and changed nothing else.'), report]),
  ];
  return {
    lead: { rules: [], otherwise: [], context: { start: 1, perTurn: 1 }, turnCostUsd: 0 },
    author: { steps, file: { path: 'notes/proof-j5.md', text: 'The rehearsal.\n' } },
    authorRules: [{ when: '[\\s\\S]', files: [{ path: 'README.md', replace: [last, `${last}\n\n${line}`] }], steps }],
    reviewer: run('review', 'claude-sonnet-5-5', text('review-a', REVIEW)),
  };
}

// ---- the times and the report -------------------------------------------------

const EPOCH = new Date(0).toISOString();
export const spoken = (ms: number): string => duration(EPOCH, new Date(ms).toISOString());

export type Moments = { readonly todo?: string; readonly planAsked?: string; readonly go?: string; readonly approvalAsked?: string; readonly approved?: string; readonly live?: string };
export type Row = { readonly n: number; readonly name: string; readonly status: StepState | 'not done' | 'not seen'; readonly personMs: number | null; readonly machineMs: number | null; readonly note: string };

const between = (from: string | undefined, to: string | undefined): number | null => (from && to ? Date.parse(to) - Date.parse(from) : null);

// Each step's row: the command's time from this script's clock (with the
// build of the image, which a fresh machine's command does itself), the
// assistant's from its records, 9 and 10 split at the approval from the
// moments the rehearsal saw. The first-ticket record covers both.
export function proofRows(view: readonly StepView[], measured: { readonly commandMs: number; readonly buildMs: number | null; readonly moments: Moments }): Row[] {
  const { moments } = measured;
  return PROOF_STEPS.map(({ n, id, name }): Row => {
    if (id === 'command') {
      const note = measured.buildMs === null ? '' : `of which the build of Cleared's image, run just before the command: ${spoken(measured.buildMs)}`;
      return { n, name, status: 'done', personMs: 0, machineMs: measured.commandMs + (measured.buildMs ?? 0), note };
    }
    if (id === 'first-ticket') {
      const toApproved = between(moments.todo, moments.approved);
      const waits = [['for the session plan\'s Go', between(moments.planAsked, moments.go)], ['for the approval, its grace to undo included', between(moments.approvalAsked, moments.approved)]] as const;
      const said = waits.flatMap(([what, ms]) => (ms === null ? [] : [`${spoken(ms)} ${what}`]));
      const note = toApproved === null ? '' : `Todo to approved: ${spoken(toApproved)}${said.length === 0 ? '' : `, of which ${said.join(' and ')}`}`;
      return { n, name, status: moments.approved ? 'done' : 'not seen', personMs: null, machineMs: null, note };
    }
    if (id === 'live') {
      const lasted = between(moments.approved, moments.live);
      return { n, name, status: moments.live ? 'done' : 'not seen', personMs: null, machineMs: null, note: lasted === null ? '' : `approved to live: ${spoken(lasted)}` };
    }
    const step = view.find((v) => v.id === id);
    if (!step) return { n, name, status: 'not seen', personMs: null, machineMs: null, note: '' };
    return { n, name, status: step.state === 'todo' ? 'not done' : step.state, personMs: step.personMs, machineMs: step.machineMs, note: '' };
  });
}

export type ProofRun = {
  readonly startedAt: string;
  readonly project: string;
  readonly ports: Ports;
  readonly language: 'en' | 'fr';
  readonly rows: readonly Row[];
  readonly view: readonly StepView[];                     // the assistant's records, as GET /api/setup gave them
  readonly typedAfterCommand: number;
  readonly editedByHand: number;
  readonly standIns: readonly string[];
  readonly cleanup: { readonly removed: number; readonly left: number; readonly restored: string | null };
  readonly problems: readonly string[];
};

const cell = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const tableRow = (...cells: unknown[]) => `| ${cells.map(cell).join(' | ')} |`;
const maybe = (ms: number | null) => (ms === null ? '' : spoken(ms));

export function renderReport(r: ProofRun): string {
  const ticket = r.view.find((v) => v.id === 'first-ticket');
  const person = r.view.reduce((sum, v) => sum + v.personMs, 0);
  const machine = r.view.reduce((sum, v) => sum + v.machineMs, 0) + (r.rows[0]?.machineMs ?? 0);
  const all = person + machine;
  const out = [
    '# Milestone 5 proof: durations (rehearsal)',
    '',
    `Run from ${r.startedAt} as the Compose project ${r.project}: the service on 127.0.0.1:${r.ports.service}, the app on 127.0.0.1:${r.ports.app}, the previews on 127.0.0.1:${r.ports.preview}, in ${r.language === 'fr' ? 'French' : 'English'}.`,
    '',
    '## Steps',
    '',
    tableRow('Step', 'Name', 'Status', 'The person', 'The machine', 'Note'),
    tableRow('---', '---', '---', '---', '---', '---'),
    ...r.rows.map((row) => tableRow(row.n, row.name, row.status, maybe(row.personMs), maybe(row.machineMs), row.note)),
    '',
    ticket ? `Steps 9 and 10 are one record of the assistant, its first-ticket step: the person ${spoken(ticket.personMs)}, the machine ${spoken(ticket.machineMs)}.` : 'The assistant has no record of its first-ticket step.',
    '',
    `Total: ${spoken(all)} (the person ${spoken(person)}, the machine ${spoken(machine)}), ${all < 3_600_000 ? 'under' : 'over'} the hour.`,
    '',
    `Commands typed after the one command: ${r.typedAfterCommand}. Files edited by hand: ${r.editedByHand}.`,
    '',
  ];
  if (r.problems.length > 0) out.push('## What did not pass', '', ...r.problems.map((p) => `- ${cell(p)}`), '');
  if (r.standIns.length > 0) out.push('## What the rehearsal replaced', '', 'These were stand-ins, so the rehearsal does not prove them:', '', ...r.standIns.map((s) => `- ${s}`), '');
  out.push('## The cleanup', '', `${r.cleanup.removed} objects removed by the label, ${r.cleanup.left} left${r.cleanup.restored ? `; ${r.cleanup.restored} named again the image it named before` : ''}.`, '');
  return `${out.join('\n')}\n`;
}

// ---- Docker -------------------------------------------------------------------

type Result = { readonly code: number; readonly out: string };

// The docker CLI, its output kept, and written to the log as it comes.
function docker(args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly log?: string; readonly cwd?: string } = {}): Promise<Result> {
  return new Promise((done) => {
    const child = spawn('docker', [...args], { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk: Buffer) => { out += chunk.toString('utf8'); if (options.log) appendFileSync(options.log, chunk); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => done({ code: code ?? 1, out }));
  });
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// Every object with the label, each kind listed with the label's filter.
async function labelled(): Promise<DockerObject[]> {
  const found: DockerObject[] = [];
  const kinds = [
    ['container', ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${LABEL}`]],
    ['image', ['image', 'ls', '--quiet', '--no-trunc', '--filter', `label=${LABEL}`]],
    ['network', ['network', 'ls', '--quiet', '--no-trunc', '--filter', `label=${LABEL}`]],
    ['volume', ['volume', 'ls', '--quiet', '--filter', `label=${LABEL}`]],
  ] as const;
  for (const [kind, args] of kinds) {
    const ids = [...new Set(lines((await docker(args)).out))];
    if (ids.length === 0) continue;
    // Three JSON values a line, apart by a tab, which JSON never holds raw.
    const format = {
      container: '{{json .Id}}\t{{json .Name}}\t{{json .Config.Labels}}',
      image: '{{json .Id}}\t{{json .RepoTags}}\t{{json .Config.Labels}}',
      network: '{{json .Id}}\t{{json .Name}}\t{{json .Labels}}',
      volume: '{{json .Name}}\t{{json .Name}}\t{{json .Labels}}',
    }[kind];
    const inspected = await docker([kind, 'inspect', '--format', format, ...ids]);
    for (const line of lines(inspected.out)) {
      const [id, name, labels] = line.split('\t').map((part) => JSON.parse(part) as unknown) as [string, string | string[] | null, Record<string, string> | null];
      found.push({ kind, id, name: Array.isArray(name) ? (name[0] ?? '') : String(name ?? '').replace(/^\//, ''), labels: labels ?? {} });
    }
  }
  return found;
}

async function imageNamed(name: string): Promise<string | null> {
  return lines((await docker(['image', 'ls', '--quiet', '--no-trunc', '--filter', `label=${LABEL}`, '--filter', `reference=${name}`])).out)[0] ?? null;
}

async function containerOf(project: string, service: string): Promise<string | null> {
  return lines((await docker(['container', 'ls', '--quiet', '--filter', `label=${LABEL}`, '--filter', `label=${PROJECT_LABEL}=${project}`, '--filter', `label=com.docker.compose.service=${service}`])).out)[0] ?? null;
}

// ---- the rehearsal --------------------------------------------------------------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, check: () => Promise<T | undefined | null | false>, ms: number, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what}: not within ${spoken(ms)}`);
    await wait(every);
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Cleared', GIT_AUTHOR_EMAIL: 'rehearsal@cleared.invalid', GIT_COMMITTER_NAME: 'Cleared', GIT_COMMITTER_EMAIL: 'rehearsal@cleared.invalid' } });
}

// A program on the service's PATH, run by the image's node: this file in
// the image, as the gh stand-in.
function containerStub(file: string, words: readonly string[]): void {
  writeFileSync(file, `#!${IN_IMAGE.node} --no-warnings\nprocess.argv.splice(1, 1, ${JSON.stringify(IN_IMAGE.self)}, ...${JSON.stringify(words)});\nimport(${JSON.stringify(pathToFileURL(IN_IMAGE.self).href)});\n`, { mode: 0o755 });
}

const STAND_INS = [
  'the image: built from this clone just before the one command and timed apart, with the layers this server keeps in its cache; a fresh machine\'s command builds it itself, from nothing',
  'the forge: a fake GitHub on loopback answers the forge step and the doctor, a gh stand-in on the service\'s PATH lists the repository and keeps the pull requests in a file, and a bare copy of the example guestbook is the remote',
  'the service: recreated once after the one command, by an override file of the rehearsal\'s own folder, to carry those fakes; v2/compose.yaml is not changed',
  'the model: the login is a made-up value pasted in the step, and the fake harness plays the author and the reviewer; no Claude Code runs',
  'the project of the approval: the service is given the project\'s .cleared/agents.conf as CLEARED_CONF and the checkout the workspace step makes as CLEARED_REPO, since the approval of a single service reads its verdict phrase and the pull request\'s head through them only, and an install by the assistant sets neither: without them the release cannot be requested (issue #445)',
  'the lock: a stand-in on a Unix socket merges the approved branch into the bare copy and writes the release watch\'s rows, healthy after a fixed delay; the Compose broker idles, as it does without a project (issue #438)',
  'the person: Playwright clicks and fills what the assistant shows, so the person\'s times are a script\'s, not a newcomer\'s reading',
];

type Options = { readonly language: 'en' | 'fr'; readonly report: string; readonly playwright: string; readonly chrome?: string };

export async function rehearse(options: Options): Promise<ProofRun> {
  const startedAt = new Date().toISOString();
  const project = scratchName();
  const root = mkdtempSync(join(tmpdir(), `${project}-`));
  if (!root.startsWith('/tmp/')) throw new Error(`the rehearsal's folder must be under /tmp, the service's own temporary folder (here ${root})`);
  chmodSync(root, 0o700);
  const logFile = `${options.report}.log`;
  writeFileSync(logFile, '', { mode: 0o600 });
  const say = (line: string) => { process.stdout.write(`${line}\n`); appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); };
  const ports = choosePorts(listening());
  const state = join(root, 'state');
  const fakes = join(root, 'fakes');
  mkdirSync(join(fakes, 'bin'), { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, COMPOSE_PROJECT_NAME: project, CLEARED_V2_STATE_DIR: state, CLEARED_V2_APP_LANGUAGE: options.language,
    CLEARED_V2_PORT: String(ports.service), CLEARED_V2_APP_PORT: String(ports.app), CLEARED_V2_PREVIEW_PORT: String(ports.preview),
  };
  say(`proof-j5: project ${project}, ports ${ports.service} ${ports.app} ${ports.preview}, folder ${root}`);

  const before = await labelled();
  // The image the shared tag names now, kept under a second name through the build.
  const previous = await imageNamed(IMAGE);
  const kept = previous ? keepName(project) : null;
  if (previous && kept && (await docker(['tag', previous, kept])).code !== 0) throw new Error(`could not keep the image ${IMAGE} named before the rehearsal`);
  const problems: string[] = [];
  const moments: { todo?: string; planAsked?: string; go?: string; approvalAsked?: string; approved?: string; live?: string } = {};
  let buildMs: number | null = null;
  let commandMs = 0;
  let view: StepView[] = [];
  let github: Server | undefined;
  let broker: { close(callback: () => void): void } | undefined;
  let browser: { close(): Promise<void> } | undefined;
  try {
    // 1. The image, then the one command.
    let t = Date.now();
    const built = await docker(['compose', '--file', COMPOSE, 'build', 'install'], { env, log: logFile });
    if (built.code !== 0) throw new Error(`the build of Cleared's image ended with ${built.code}`);
    buildMs = Date.now() - t;
    say(`proof-j5: the image built in ${spoken(buildMs)}`);
    t = Date.now();
    const command = await docker(['compose', '-f', COMPOSE, 'run', '--rm', 'install'], { env, log: logFile });
    commandMs = Date.now() - t;
    if (command.code !== 0) throw new Error(`the one command ended with ${command.code}`);
    say(`proof-j5: the one command in ${spoken(commandMs)}`);
    // The command says the service's line after its own words (install.ts, setup_said).
    const said = new RegExp(SETUP_CODE_LINE.source.slice(1));
    if (!lines(command.out).some((l) => said.test(l))) problems.push('the one command did not show the setup line');
    const app = `http://127.0.0.1:${ports.app}`;

    // 2. The fakes, and the service recreated with them.
    const token = ['rehearsal', 'forge', 'credential'].join('-');
    const seed = join(fakes, 'seed');
    cpSync(GUESTBOOK, seed, { recursive: true, filter: (source) => !source.includes('node_modules') });
    git(seed, 'init', '--quiet', '--initial-branch=main');
    git(seed, 'add', '--all');
    git(seed, 'commit', '--quiet', '-m', 'The example guestbook, for the rehearsal');
    const origin = join(fakes, 'guestbook.git');
    git(fakes, 'clone', '--quiet', '--bare', seed, origin);
    git(fakes, 'clone', '--quiet', origin, join(fakes, 'lock-clone'));
    const repos: FakeRepository[] = [{ repo: 'rehearsal/guestbook', url: origin, base: 'main' }];
    const forgeFile = join(fakes, 'forge.json');
    writeFileSync(forgeFile, JSON.stringify({ next: 101, prs: [] }));
    writeFileSync(`${forgeFile}.origins.json`, JSON.stringify({ 'rehearsal/guestbook': origin }));
    writeFileSync(join(fakes, 'repos.json'), JSON.stringify(repos));
    containerStub(join(fakes, 'bin', 'gh'), ['gh-stub', forgeFile, `${forgeFile}.origins.json`, join(fakes, 'repos.json')]);
    const script = join(fakes, 'script.json');
    writeFileSync(script, JSON.stringify(firstTicketScript(readFileSync(join(seed, 'README.md'), 'utf8'), FIRST_TICKET_LINE[options.language]), null, 2));
    github = createServer((request, response) => {
      const answer = fakeGitHub(request.method ?? 'GET', request.url ?? '/', request.headers.authorization, token, repos);
      appendFileSync(logFile, `${new Date().toISOString()} github: ${request.method} ${request.url} -> ${answer.status}\n`);
      response.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((done) => github?.listen(0, '127.0.0.1', done));
    const api = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    const socket = join(fakes, 'release.sock');
    broker = await startBroker({ socket, state, ledger: join(state, 'ledger.db'), forge: forgeFile, origin, clone: join(fakes, 'lock-clone'), watchMs: 15_000, log: say, repo: 'rehearsal/guestbook' });
    const imageId = await imageNamed(IMAGE);
    const imageEnv = JSON.parse((await docker(['image', 'inspect', '--format', '{{json .Config.Env}}', imageId ?? IMAGE])).out || '[]') as string[];
    const path = imageEnv.find((e) => e.startsWith('PATH='))?.slice(5) ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const override = join(root, 'fakes.yaml');
    // The project, which the approval of a single service knows only from
    // CLEARED_CONF (its verdict phrase, read at the start) and CLEARED_REPO
    // (the pull request's head): an install by the assistant sets neither.
    // The checkout is where the workspace step clones the repository.
    const conf = join(fakes, 'agents.conf');
    cpSync(join(seed, '.cleared', 'agents.conf'), conf);
    const checkout = join(state, 'repositories', 'rehearsal', 'guestbook');
    writeFileSync(override, overrideFile({ fakes, path, script, api, socket, conf, repo: checkout }));
    const recreated = await docker(['compose', '--file', COMPOSE, '--file', override, 'up', '-d', '--no-deps', 'service'], { env, log: logFile });
    if (recreated.code !== 0) throw new Error(`the service did not start again with the fakes (${recreated.code})`);
    const service = await until('the service', () => containerOf(project, 'service'), 60_000);
    const code = await until('the setup line', async () => {
      const log = await docker(['container', 'logs', service]);
      return lines(log.out).map((l) => SETUP_CODE_LINE.exec(l)?.[1]).filter(Boolean).at(-1);
    }, 120_000);
    say('proof-j5: the service runs with the fakes');

    // 3. The assistant, in a browser.
    const require = createRequire(join(options.playwright, 'package.json'));
    const { chromium } = require('playwright-core') as { chromium: { launch(o: Record<string, unknown>): Promise<any> } };
    const opened = await chromium.launch({ headless: true, ...(options.chrome ? { executablePath: options.chrome } : {}) });
    browser = opened;
    const context = await opened.newContext({ viewport: { width: 1440, height: 900 }, locale: options.language === 'fr' ? 'fr-FR' : 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => problems.push(`a page error: ${error.message}`));
    const next = async () => { await page.click('[data-act="setup_next"]'); };
    const skip = async (why: string) => { problems.push(why); await page.click('[data-act="setup_skip"]'); };
    const MINUTE = 60_000;

    await page.goto(`${app}/`);
    await page.locator('#setup-code').waitFor({ timeout: MINUTE });
    await page.fill('#setup-code', code);
    await page.fill('#setup-name', 'owner');
    await page.fill('#setup-password', ['rehearsal', 'password', String(Date.now())].join('-'));
    await page.click('[data-act="setup_owner"]');
    await page.locator('[data-public-key]').waitFor({ state: 'attached', timeout: MINUTE });
    await next();
    say('proof-j5: step 2 done');

    await page.locator('#setup-forge-value').waitFor();
    await page.fill('#setup-forge-value', token);
    await page.click('[data-act="setup_forge_check"]');
    await page.locator('[data-forge-result="ok"]').waitFor({ timeout: MINUTE });
    await next();
    say('proof-j5: step 3 done');

    await page.locator('#setup-model-value').waitFor();
    await page.fill('#setup-model-value', ['sk', 'ant', 'oat01', 'r'.repeat(40)].join('-'));
    await page.click('[data-act="setup_model_save"]');
    await page.locator('[data-model-result="ok"]').waitFor({ timeout: MINUTE });
    await next();
    say('proof-j5: step 4 done');

    await page.locator('[name="repository"][value="rehearsal/guestbook"]').waitFor({ timeout: 2 * MINUTE });
    await page.check('[name="repository"][value="rehearsal/guestbook"]');
    await page.click('[data-act="setup_workspace_propose"]');
    await page.locator('[data-act="setup_workspace_write"]').waitFor({ timeout: 5 * MINUTE });
    await page.click('[data-act="setup_workspace_write"]');
    await page.locator('[data-workspace-result="ok"]').waitFor({ timeout: 2 * MINUTE });
    await page.locator('.setup-progress li[data-step="workspace"][data-state="done"]').waitFor({ timeout: MINUTE });
    await next();
    say('proof-j5: step 5 done');

    await page.locator('[data-environment-step]').waitFor({ timeout: MINUTE });
    await page.click('[data-act="setup_environment_build"]');
    const built6 = await until('the prepared image', async () => {
      if (await page.locator('.setup-progress li[data-step="environment"][data-state="done"]').count() > 0) return 'done';
      if (await page.locator('.setup-env-item[data-state="failed"]').count() > 0) return 'failed';
      return undefined;
    }, 30 * MINUTE, 2000);
    if (built6 === 'done') await next();
    else await skip(`step 6: the prepared image failed: ${cell(await page.locator('.setup-env-item[data-state="failed"]').first().innerText())}`);
    say(`proof-j5: step 6 ${built6}`);

    await page.locator('[data-test-values], [data-act="setup_skip"]').first().waitFor({ timeout: MINUTE });
    await page.click('[data-act="setup_skip"]');
    say('proof-j5: step 7 skipped');

    await page.locator('[data-check="images"]').waitFor({ timeout: 3 * MINUTE });
    await page.waitForFunction(() => !(globalThis as any).document.querySelector('[aria-busy="true"]'), undefined, { timeout: 3 * MINUTE });
    if (await page.locator('[data-act="setup_next"]').count() > 0) await next();
    else {
      const failed = await page.locator('[data-check][data-state="fail"]').allInnerTexts().catch(() => [] as string[]);
      await skip(`step 8: ${failed.length} ready lines failed: ${failed.map(cell).join('; ') || 'not read'}`);
    }
    say('proof-j5: step 8 seen');

    await page.locator('[data-first-ticket="proposal"]').waitFor({ timeout: MINUTE });
    await page.click('[data-act="first_ticket_move"]');
    moments.todo = new Date().toISOString();
    // The author's session plan waits for its Go in the inbox; the step
    // does not say so (the Go comes by itself after the delay, 10 minutes,
    // when the plan's confidence is high). The rehearsal gives it, as the
    // inbox asks, and the report says how long it waited.
    const inbox = async () => (await (await page.request.get(`${app}/api/service/inbox`)).json()) as { id: string; kind: string; state: string }[];
    const plan = await until('the session plan in the inbox', async () => (await inbox()).find((i) => i.kind === 'session_plan' && i.state === 'waiting'), 5 * MINUTE);
    moments.planAsked = new Date().toISOString();
    problems.push('step 9: the author\'s session plan waits for its Go in the inbox, and the first-ticket step does not say so; a newcomer following the step alone waits for the delay\'s Go (10 minutes for a plan of high confidence; issue #446)');
    await page.goto(`${app}/inbox#${encodeURIComponent(plan.id)}`);
    await page.locator('.d-actions [data-act="plan_go"]').waitFor({ timeout: MINUTE });
    await page.click('.d-actions [data-act="plan_go"]');
    await until('the Go', async () => (await inbox()).find((i) => i.id === plan.id && i.state !== 'waiting'), 2 * MINUTE);
    moments.go = new Date().toISOString();
    say('proof-j5: step 9, the session plan has its Go');
    await page.goto(`${app}/setup/first-ticket`);
    await page.locator('[data-first-ticket="approval"]').waitFor({ timeout: 6 * MINUTE });
    moments.approvalAsked = new Date().toISOString();
    say('proof-j5: step 9, the approval waits in the inbox');
    await page.click('a[href="/inbox"]');
    const item = await until('the release in the inbox', async () => (await inbox()).find((i) => i.kind === 'release' && i.state === 'waiting'), 2 * MINUTE);
    await page.goto(`${app}/inbox#${encodeURIComponent(item.id)}`);
    await page.locator('.d-actions [data-act="approve"]').waitFor({ timeout: MINUTE });
    await page.click('.d-actions [data-act="approve"]');
    await until('the approval', async () => (await inbox()).find((i) => i.id === item.id && i.state !== 'waiting'), 3 * MINUTE);
    moments.approved = new Date().toISOString();
    say('proof-j5: step 9 done, approved');
    await page.goto(`${app}/setup/first-ticket`);
    await page.locator('[data-first-ticket="live"]').waitFor({ timeout: 6 * MINUTE });
    moments.live = new Date().toISOString();
    say('proof-j5: step 10 done, live');
    await page.locator('[data-setup-summary]').waitFor({ timeout: MINUTE });
    // The assistant's records, as its pages read them (screens/setup/model.ts).
    const records = (await (await page.request.get(`${app}/api/service/setup`)).json()) as { steps?: StepView[] };
    if (Array.isArray(records.steps)) view = records.steps;
    else problems.push('the assistant\'s records could not be read');
  } catch (error) {
    problems.push(`stopped: ${cell((error as Error).message)}`);
    say(`proof-j5: stopped: ${(error as Error).message}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((done) => (github ? github.close(() => done()) : done()));
    await new Promise<void>((done) => (broker ? broker.close(() => done()) : done()));
  }

  // What the ledger and the service say, for the log only, before the folder goes.
  if (problems.some((p) => p.startsWith('stopped:'))) await diagnose(state, project, logFile);

  // 5. The cleanup, by the label.
  const after = await labelled();
  const plan = cleanupPlan({ before, after, project, kept, image: IMAGE });
  for (const command of plan.commands) {
    const done = await docker(command, { log: logFile });
    if (done.code !== 0) problems.push(`the cleanup's docker ${command.slice(0, 2).join(' ')} ended with ${done.code}`);
  }
  const left = cleanupPlan({ before, after: await labelled(), project, kept: null, image: IMAGE }).remove.length;
  rmSync(root, { recursive: true, force: true });
  say(`proof-j5: ${plan.remove.length} objects removed, ${left} left`);

  const result: ProofRun = {
    startedAt, project, ports, language: options.language,
    rows: proofRows(view, { commandMs, buildMs, moments }), view, typedAfterCommand: 0, editedByHand: 0,
    standIns: STAND_INS, problems,
    cleanup: { removed: plan.remove.length, left, restored: kept && previous === await imageNamed(IMAGE) ? IMAGE : null },
  };
  writeFileSync(options.report, renderReport(result), { mode: 0o600 });
  say(`proof-j5: the report is ${options.report}`);
  return result;
}

// The tickets' history, the sessions, the newest session's last events, the
// inbox and the flow's events, then the service's last lines, read only.
async function diagnose(state: string, project: string, logFile: string): Promise<void> {
  const write = (title: string, rows: unknown) => appendFileSync(logFile, `---- ${title}\n${JSON.stringify(rows, null, 1).slice(0, 20_000)}\n`);
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(state, 'ledger.db'), { readOnly: true });
    const all = (sql: string) => { try { return db.prepare(sql).all(); } catch (error) { return (error as Error).message; } };
    write('tracker_history', all('SELECT ticket, status, actor_kind, at FROM tracker_history ORDER BY id'));
    write('tracker_comments', all('SELECT ticket, created_at, substr(body, 1, 600) AS body FROM tracker_comments ORDER BY id'));
    write('sessions', all('SELECT id, role, status, ticket, created_at, updated_at FROM sessions ORDER BY created_at'));
    write('the newest session\'s events', all("SELECT seq, at, type, substr(event, 1, 400) AS event FROM session_events WHERE session_id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1) ORDER BY seq DESC LIMIT 25"));
    write('flow_inbox', all('SELECT id, kind, state, ticket FROM flow_inbox'));
    write('events', all('SELECT at, kind, ticket, substr(detail, 1, 300) AS detail FROM events ORDER BY event_id DESC LIMIT 25'));
    db.close();
  } catch (error) { write('the ledger', (error as Error).message); }
  const service = await containerOf(project, 'service');
  if (service) appendFileSync(logFile, `---- the service's last lines\n${(await docker(['container', 'logs', '--tail', '80', service])).out}\n`);
}

// ---- run as gh, in the service's container ----------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === SELF && process.argv[2] === 'gh-stub') {
  const [forgeFile, originsFile, reposFile, ...args] = process.argv.slice(3) as [string, string, string, ...string[]];
  const answer = ghApiAnswer(args, JSON.parse(readFileSync(reposFile, 'utf8')) as FakeRepository[]);
  if (answer) {
    appendFileSync(`${forgeFile}.log`, `${new Date().toISOString()} gh ${args.filter((a) => !a.startsWith('/')).join(' ')} -> ${answer.code}\n`);
    if (answer.code !== 0) process.stderr.write('gh (rehearsal): Not Found\n');
    process.stdout.write(answer.stdout);
    process.exitCode = answer.code;
  } else {
    const rehearsal = existsSync(IN_IMAGE.rehearsal) ? IN_IMAGE.rehearsal : fileURLToPath(new URL('./proof-rehearsal.ts', import.meta.url));
    process.exitCode = spawnSync(process.execPath, ['--no-warnings', rehearsal, 'gh-stub', forgeFile, originsFile, ...args], { stdio: 'inherit' }).status ?? 1;
  }
} else if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const flag = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
  const language = flag('--language') === 'fr' ? 'fr' : 'en';
  const playwright = process.env.CLEARED_V2_PLAYWRIGHT;
  if (!playwright) {
    process.stderr.write('proof-j5: CLEARED_V2_PLAYWRIGHT names the playwright-core folder the rehearsal drives the browser with\n');
    process.exit(64);
  }
  const report = resolve(flag('--report') ?? join(tmpdir(), `cleared-v2-proof-j5-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`));
  const result = await rehearse({ language, report, playwright, ...(process.env.CLEARED_V2_CHROME ? { chrome: process.env.CLEARED_V2_CHROME } : {}) });
  process.stdout.write(renderReport(result));
  // The path held when every step is done or skipped and nothing was left; what needs a fix is in the report.
  process.exitCode = result.rows.every((r) => r.status === 'done' || r.status === 'skipped') && result.cleanup.left === 0 ? 0 : 1;
}
