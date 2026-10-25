// `cleared run "<task>" [--service <name>] [--template <id>] [--wait]`
// (docs/v2/milestone-5-plan.md, section 8, C18): the command makes a ticket
// of the task through POST /api/run with the person's token, read from
// CLEARED_V2_API_TOKEN_FILE or CLEARED_V2_API_TOKEN, and prints its address;
// with --wait it follows GET /api/run/:id and prints the session, the pull
// request and the time taken, and stops at the approval, which stays in the
// app. Run as a process against the run routes on loopback, on the fake
// harness; French and English; the token in no output.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Levers } from '../../src/consumption/levers.ts';
import { BatchRunner } from '../../src/flow/batch.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { RunLauncher } from '../../src/run/runs.ts';
import { runRoutes } from '../../src/run/routes.ts';
import { ApiTokens } from '../../src/run/tokens.ts';
import { RUN_LABEL } from '../../src/run/types.ts';
import { handle } from '../../src/server.ts';
import { REPORT_PASS, authorScript, quickAuthor, reviewerScript, setup, type Setup } from '../flow/support.ts';

const cli = new URL('../../src/cli/run.ts', import.meta.url).pathname;
const MESSAGES = new URL('../../src/cli/messages/', import.meta.url).pathname;
const APP = 'http://127.0.0.1:8792';
const scratch = mkdtempSync(join(tmpdir(), 'cleared-v2-run-cli-'));

type Served = { t: Setup; tokens: ApiTokens; port: number; close: () => Promise<void> };
const open: Served[] = [];
after(async () => {
  for (const served of open) await served.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function serve(options: { lanes?: number; author?: typeof quickAuthor } = {}): Promise<Served> {
  const t = await setup({ scripts: { author: options.author ?? quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  const levers = { read: (): Levers => ({ model: null, maxLanes: options.lanes ?? null, paused: false }) };
  const runner = new BatchRunner({ db: t.store.db, tickets: t.tickets, flow: t.engine, project: 'guestbook', levers, weekStopPercent: 85, now: () => new Date(t.clock.now) });
  runner.listen();
  const launcher = new RunLauncher({ db: t.store.db, runner, flow: t.engine, tickets: t.tickets, project: 'guestbook', services: () => ['guestbook'], appOrigin: APP, now: () => new Date(t.clock.now) });
  launcher.listen();
  const tokens = new ApiTokens(t.store.db, () => new Date(t.clock.now));
  const app: App = { registry: t.engine.registry, tables: [], routes: runRoutes({ tokens: () => tokens, launcher: () => launcher, proof: () => 'proof' }) };
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const served: Served = {
    t, tokens, port: (server.address() as AddressInfo).port,
    close: async () => {
      await launcher.close();
      await runner.close();
      await t.engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  open.push(served);
  return served;
}

let files = 0;
function credentialFile(value: string, mode = 0o600): string {
  const file = join(scratch, `access-${++files}`);
  writeFileSync(file, `${value}\n`);
  chmodSync(file, mode);
  return file;
}

type Result = { status: number | null; stdout: string; stderr: string };
// The command as a process: the server it calls runs in this one, so the call is not synchronous.
// With `until`, it is stopped once its output matches.
function run(args: string[], env: Record<string, string | undefined>, until?: RegExp): Promise<Result> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CLEARED_') && !name.startsWith('ORCH_')));
  const child = spawn(process.execPath, [cli, ...args], { env: { ...clean, CLEARED_V2_APP_LANGUAGE: 'en', CLEARED_V2_RUN_POLL_MS: '50', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (until?.test(stdout)) child.kill('SIGTERM');
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  return new Promise((resolve) => child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); }));
}

const runTickets = async (t: Setup) => (await t.tickets.list({ project: 'guestbook' })).filter((ticket) => ticket.labels.includes(RUN_LABEL));

test('the task becomes a ticket made as the token\'s person; the command prints its id and its address, and the token nowhere', async () => {
  const s = await serve();
  const made = s.tokens.make('u1', 'cli');
  const result = await run(['Show the newest entry first'], { CLEARED_V2_PORT: String(s.port), CLEARED_V2_API_TOKEN_FILE: credentialFile(made.value) });
  assert.equal(result.status, 0, result.stderr);
  const [ticket] = await runTickets(s.t);
  assert.ok(ticket);
  assert.equal(ticket.title, 'Show the newest entry first');
  assert.equal(result.stdout, `Ticket ${ticket.id} made: Show the newest entry first.\n${APP}/\n`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(made.value));
});

test('a long task: its first line is the title, the whole task the description; --service and --template reach the ticket', async () => {
  const s = await serve();
  const made = s.tokens.make('u1', 'cli');
  const task = `The footer overlaps the last entry\n\nOn a phone, the footer covers the last entry of the list.`;
  const result = await run([task, '--service', 'guestbook', '--template', 'bug'], { CLEARED_V2_PORT: String(s.port), CLEARED_V2_API_TOKEN: made.value });
  assert.equal(result.status, 0, result.stderr);
  const [ticket] = await runTickets(s.t);
  assert.equal(ticket?.title, 'The footer overlaps the last entry');
  assert.equal(ticket?.body, task);
  assert.ok(ticket?.labels.includes('type:bug'));
  assert.deepEqual(ticket?.services?.map((service) => service.name), ['guestbook']);
});

test('--wait follows the ticket: its session, its pull request, the time taken, and it stops at the approval', async () => {
  const s = await serve();
  const made = s.tokens.make('u1', 'cli');
  const result = await run(['Show the newest entry first', '--wait'], { CLEARED_V2_PORT: String(s.port), CLEARED_V2_API_TOKEN_FILE: credentialFile(made.value) });
  assert.equal(result.status, 0, result.stderr);
  const [ticket] = await runTickets(s.t);
  const session = s.t.startedSessions[0]!.id;
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines[0], `Ticket ${ticket!.id} made: Show the newest entry first.`);
  assert.ok(lines.includes(`${ticket!.id} has started: ${APP}/sessions/${session}`), result.stdout);
  assert.ok(lines.includes(`Pull request #7 of ${ticket!.id}: https://example.invalid/pull/7`), result.stdout);
  assert.match(lines.at(-1)!, new RegExp(`^${ticket!.id} waits for your approval in the app's Inbox\\. Time taken: \\d+\\s?s\\.$`));
  assert.equal(new Set(lines).size, lines.length, 'each line once');
  assert.equal(s.t.approvals.approvals.length, 0, 'the approval stays in the app');
});

test('--wait says what holds a queued ticket, in French too', async () => {
  const s = await serve({ lanes: 1, author: authorScript });
  const made = s.tokens.make('u1', 'cli');
  const env = { CLEARED_V2_PORT: String(s.port), CLEARED_V2_API_TOKEN_FILE: credentialFile(made.value) };
  assert.equal((await run(['First'], env)).status, 0);
  const second = await run(['Second', '--wait'], { ...env, CLEARED_V2_APP_LANGUAGE: 'fr' }, /attend une voie/);
  assert.match(second.stdout, /^Ticket \S+ créé\s:\sSecond\.\n/);
  assert.match(second.stdout, /\S+ attend une voie\s:\s1 sur 1 en cours\./);
});

test('the time taken reads as a person reads it', () => {
  const en = JSON.parse(readFileSync(join(MESSAGES, 'run.en.json'), 'utf8')) as Record<string, string>;
  assert.match(en.approval ?? '', /\{time\}/);
  assert.doesNotMatch(JSON.stringify(en), /\bms\b|millisecond/);
});

test('no task, an unknown option, or an option without its value: the usage, exit 64, nothing made', async () => {
  const s = await serve();
  const env = { CLEARED_V2_PORT: String(s.port), CLEARED_V2_API_TOKEN: s.tokens.make('u1', 'cli').value };
  for (const args of [[], ['  '], ['task', '--nope'], ['task', '--service'], ['task', '--template'], ['one', 'two'], ['task', '--template', 'feature']]) {
    const result = await run(args, env);
    assert.equal(result.status, 64, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Usage: cleared run "<task>"/, args.join(' '));
  }
  assert.deepEqual(await runTickets(s.t), []);
  const help = await run(['--help'], env);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: cleared run "<task>"/);
  const french = await run([], { ...env, CLEARED_V2_APP_LANGUAGE: 'fr' });
  assert.match(french.stderr, /Utilisation\s:\scleared run «\s<tâche>\s»/);
});

test('no credential, one in a file others can read, an empty one, or one the service refuses: said, exit 64 or 77, the value never printed', async () => {
  const s = await serve();
  const made = s.tokens.make('u1', 'cli');
  const port = String(s.port);
  const none = await run(['task'], { CLEARED_V2_PORT: port });
  assert.equal(none.status, 64);
  assert.match(none.stderr, /CLEARED_V2_API_TOKEN_FILE/);
  const open = await run(['task'], { CLEARED_V2_PORT: port, CLEARED_V2_API_TOKEN_FILE: credentialFile(made.value, 0o644) });
  assert.equal(open.status, 64);
  assert.match(open.stderr, /chmod 600/);
  const empty = await run(['task'], { CLEARED_V2_PORT: port, CLEARED_V2_API_TOKEN_FILE: credentialFile('') });
  assert.equal(empty.status, 64);
  const missing = await run(['task'], { CLEARED_V2_PORT: port, CLEARED_V2_API_TOKEN_FILE: join(scratch, 'none') });
  assert.equal(missing.status, 64);
  s.tokens.revoke('u1', made.token.id);
  const refused = await run(['task'], { CLEARED_V2_PORT: port, CLEARED_V2_API_TOKEN_FILE: credentialFile(made.value) });
  assert.equal(refused.status, 77);
  assert.match(refused.stderr, /refused/);
  for (const result of [none, open, empty, missing, refused]) assert.ok(!`${result.stdout}${result.stderr}`.includes(made.value));
  assert.deepEqual(await runTickets(s.t), []);
});

test('a refusal of the service is said with its reason; a service that does not answer, with its address, exit 69', async () => {
  const s = await serve();
  const env = { CLEARED_V2_PORT: String(s.port), CLEARED_V2_API_TOKEN: s.tokens.make('u1', 'cli').value };
  const refused = await run(['task', '--service', 'billing'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /billing is not a service/);
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const down = await run(['task'], { ...env, CLEARED_V2_PORT: String(port) });
  assert.equal(down.status, 69);
  assert.match(down.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
});

const placeholders = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('the command\'s catalogs: French and English, the same keys and placeholders, every key said, French typography', () => {
  const en = JSON.parse(readFileSync(join(MESSAGES, 'run.en.json'), 'utf8')) as Record<string, string>;
  const fr = JSON.parse(readFileSync(join(MESSAGES, 'run.fr.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim() && fr[key]!.trim(), `${key} is empty`);
    assert.notEqual(fr[key], value, `${key}: the French is the English`);
    assert.deepEqual(placeholders(fr[key]!), placeholders(value), `${key}: placeholders differ`);
    assert.doesNotMatch(key, /token|secret|key|pass/, key);
    assert.doesNotMatch(fr[key]!, / [?!;:%»]|« /, `${key}: French typography`);
    assert.doesNotMatch(`${value} ${fr[key]}`, /—/, `${key}: no em dash`);
  }
  const text = readFileSync(cli, 'utf8');
  const said = new Set([...text.matchAll(/\bt\('([a-z0-9_]+)'/g)].map(([, key]) => key as string));
  for (const key of said) assert.ok(Object.hasOwn(en, key), `${key} is said and not in the catalog`);
  for (const key of Object.keys(en)) assert.ok(said.has(key), `${key} is never said`);
});
