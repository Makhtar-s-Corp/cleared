// The live Take over run (issue #463, lane v2-j6-live-takeover): step 11 of
// the multi-service proof (proof-j2-multi.ts) played for real, on a real
// Claude Code session, on an install of its own, then again after a restart
// of the service.
//
//   1. The install: the service and the app of this clone, on three free
//      ports of 9700 to 9799 on 127.0.0.1, in a temporary folder, on the real
//      Claude Code adapter. The example guestbook is the project, its remote a
//      bare copy (no fork), the forge the rehearsal's gh stand-in
//      (proof-rehearsal.ts). The login is named by CLEARED_CLAUDE_CREDENTIALS
//      and mounted read only in the session containers by the service; this
//      script checks its mode and never opens it. The service reads no quota
//      on the host (CLEARED_V2_QUOTA_MINUTES=0), runs no lead and no service
//      map: only the run's own sessions call the model.
//   2. Ticket A: Take over its author, one line typed to the harness and its
//      answer, the Shell with git status, npm ci and npm test
//      (proof-terminal.ts), one line of a file the author changed (src/page.ts
//      first) changed in the Editor and saved, Give back; the notice's turn. Then Take over its reviewer, one
//      line to the harness, Give back (O19). The ticket is set aside once its
//      review ended or its release card waits: nothing is approved.
//   3. Ticket B: Take over its author, then the service is restarted. What
//      became of the session is recorded; a session the restart stopped is
//      started again by moving the ticket to Todo, and the new session plays
//      step 11 as A's author did.
//   4. The quota: the seven-day window from the sessions' own reports
//      (cleared.rate_limit). The run stops, setting its tickets aside, once
//      it has spent STOP_SPENT points of the week or the window reaches
//      STOP_WINDOW.
//   5. The end: the service and the app stopped, the objects the run's
//      sessions made removed by their label, never one that was there before.
//      The report (result.json, log.md) is written redacted: no home folder,
//      no temporary folder, no token.
//
//   PROOF_PLAYWRIGHT=$PWD/node_modules/playwright-core PROOF_CHROME=<chrome> \
//   CLEARED_CLAUDE_CREDENTIALS=<the login file> node scripts/proof-takeover-live.ts
//
// Settings: PROOF_OUT (the report's folder), PROOF_MODEL (claude-haiku-5-5),
// PROOF_BUDGET_USD (2 a ticket), PROOF_STEP_MINUTES (20).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { NextInboxItem, SessionSummary } from '../src/api/types.ts';
import { Docker, commandRunner } from '../src/container/docker.ts';
import { SESSION_IMAGE } from '../src/container/session-runtime.ts';
import type { Ticket } from '../src/tickets/contract.ts';
import { answerInInbox, declaredChecks, permissionAnswer } from './proof-inbox.ts';
import { buildApp, freePort, listening, writeGhStub } from './proof-rehearsal.ts';
import { SHELL_LINES, atPrompt, lineOutcome } from './proof-terminal.ts';

const SELF = fileURLToPath(import.meta.url);
const V2 = fileURLToPath(new URL('../', import.meta.url));
const GUESTBOOK = fileURLToPath(new URL('../../examples/guestbook/', import.meta.url));
const OWNER = 'owner';

// ---- what the run decides, tested in test/scripts/proof-takeover-live.test.ts ----

// The run stops past either: 5 points of the week spent, or the week at 90 %.
export const STOP_SPENT = 5;
export const STOP_WINDOW = 90;

// The quota's verdict from the first seven-day figure of the run and the
// newest: go on, or stop with the reason.
export function quotaVerdict(first: number | undefined, latest: number | undefined): { readonly stop: false } | { readonly stop: true; readonly reason: string } {
  if (latest === undefined) return { stop: false };
  if (latest >= STOP_WINDOW) return { stop: true, reason: `the seven-day window is at ${latest} %, at or above ${STOP_WINDOW} %` };
  const spent = first === undefined ? 0 : Math.round((latest - first) * 10) / 10;
  if (spent >= STOP_SPENT) return { stop: true, reason: `the run spent ${spent} points of the week, at or above ${STOP_SPENT}` };
  return { stop: false };
}

// The line typed to the harness, and what its answer holds.
export const HARNESS_LINE = 'What is 17 plus 25? Reply with the number only.';
export const HARNESS_ANSWER = /\b42\b/;

// The two tickets: one visible line each on the guestbook's page.
export const LIVE_TICKETS = [
  {
    title: 'The page says how many entries it holds',
    body: 'Above the list, `src/page.ts` says how many entries the guestbook holds ("3 entries"; "1 entry"; "No entry yet").\n\nAcceptance criteria\n- [ ] The count above the list, singular and plural, with a test.\n- [ ] `npm test` passes.',
  },
  {
    title: 'The page\'s footer says the guestbook is a demo',
    body: 'At the end of the page, `src/page.ts` adds a footer line: "A demo guestbook."\n\nAcceptance criteria\n- [ ] The footer line, with a test.\n- [ ] `npm test` passes.',
  },
] as const;

// The service's environment: the real Claude Code adapter (no
// CLEARED_V2_ADAPTER), nothing that calls the model on its own, the login by
// its path only.
export function liveEnv(input: {
  readonly base: Readonly<Record<string, string>>; readonly state: string; readonly work: string; readonly project: string; readonly origin: string;
  readonly machine: string; readonly servicePort: number; readonly appPort: number; readonly login: string; readonly model: string; readonly budgetUsd: number;
}): Record<string, string> {
  return {
    ...input.base,
    CLEARED_STATE_DIR: input.state, CLEARED_CONF: input.machine, CLEARED_REPO: input.project,
    CLEARED_V2_HOST: '127.0.0.1', CLEARED_V2_PORT: String(input.servicePort),
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: input.project, CLEARED_V2_REPO: 'example/guestbook', CLEARED_V2_REPO_URL: input.origin,
    CLEARED_V2_STATE_DIR: input.state, CLEARED_V2_WORKDIRS: input.work, CLEARED_V2_BASE: 'main',
    CLEARED_CLAUDE_CREDENTIALS: input.login,
    CLEARED_V2_AUTHOR_MODEL: input.model, CLEARED_V2_REVIEWER_MODEL: input.model, CLEARED_V2_BUDGET_USD: String(input.budgetUsd),
    CLEARED_V2_REVIEW_ROUNDS: '1',
    CLEARED_V2_LEAD_ENABLED: 'off', CLEARED_V2_QUOTA_MINUTES: '0', CLEARED_V2_MAP_MINUTES: '0',
    CLEARED_V2_APP_LANGUAGE: 'en', CLEARED_NOTIFY_LINK_BASE: `http://127.0.0.1:${input.appPort}`,
  };
}

// What the report may say: no home folder, no temporary folder, no token,
// no cookie, no anti-forgery token.
export function redact(text: string, paths: { readonly root?: string; readonly home?: string; readonly login?: string }): string {
  let out = text;
  if (paths.login) out = out.split(paths.login).join('<login>');
  if (paths.root) out = out.split(paths.root).join('<run>');
  if (paths.home) out = out.split(paths.home).join('~');
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '<token>')
    .replace(/((?:set-)?cookie|x-csrf-token|authorization)(["']?\s*[:=]\s*)("[^"]*"|(?:Bearer\s+)?[^\s,;]+)/gi, '$1$2<redacted>')
    .replace(/\/home\/[^/\s"']+/g, '~');
}

// ---- the run ------------------------------------------------------------------------

// A wait that cannot end any more: said at once, not after its timeout.
class Ended extends Error {}

type Phase = { readonly name: string; readonly status: 'ok' | 'failed' | 'skipped'; readonly at: string; readonly note: string };

async function main(): Promise<void> {
  const env = process.env;
  const login = env.CLEARED_CLAUDE_CREDENTIALS;
  if (!env.PROOF_PLAYWRIGHT || !login) {
    console.error('proof: set PROOF_PLAYWRIGHT and CLEARED_CLAUDE_CREDENTIALS');
    process.exit(64);
  }
  // The login's mode and kind, never its content.
  const mode = statSync(login);
  if (!mode.isFile() || (mode.mode & 0o077) !== 0) { console.error('proof: the login is not a file readable by its owner alone'); process.exit(64); }
  const model = env.PROOF_MODEL ?? 'claude-haiku-5-5';
  const budgetUsd = Number(env.PROOF_BUDGET_USD ?? 2);
  const stepMs = Number(env.PROOF_STEP_MINUTES ?? 20) * 60_000;
  const docker = new Docker(commandRunner('docker'));
  const images = execFileSync('docker', ['images', '--filter', 'label=cleared.dev=v2', '--filter', `reference=${SESSION_IMAGE}`, '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
  if (!images.split('\n').includes(SESSION_IMAGE)) { console.error(`proof: no labelled ${SESSION_IMAGE}`); process.exit(64); }
  const before = new Set((await docker.containers()).map((c) => c.name));

  const root = mkdtempSync(join(tmpdir(), 'cleared-live-takeover-'));
  const OUT = env.PROOF_OUT ?? join(root, 'report');
  mkdirSync(OUT, { recursive: true });
  const lines: string[] = [];
  const phases: Phase[] = [];
  const gestures: { at: string; what: string }[] = [];
  const quota: { at: string; percent: number }[] = [];
  const tickets: Record<string, string> = {};
  const now = () => new Date().toISOString();
  const say = (line: string) => { const text = `${now()} ${redact(line, { root, home: homedir(), login })}`; lines.push(text); console.log(`proof: ${text}`); };
  const gesture = (what: string) => { gestures.push({ at: now(), what: redact(what, { root, home: homedir(), login }) }); say(`gesture: ${what}`); };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- the install ----
  buildApp(say);
  const dir = (...parts: string[]) => { const path = join(root, ...parts); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const state = dir('state');
  const home = dir('home');
  const bin = dir('bin');
  const work = join(root, 'work');
  const project = join(root, 'project');
  const origin = join(root, 'origin.git');
  const forge = join(root, 'forge.json');
  const base = { PATH: `${bin}:${env.PATH ?? ''}`, HOME: home, LANG: 'C.UTF-8', TZ: env.TZ ?? 'UTC' };
  const identity = { GIT_AUTHOR_NAME: 'Cleared', GIT_AUTHOR_EMAIL: 'cleared@example.invalid', GIT_COMMITTER_NAME: 'Cleared', GIT_COMMITTER_EMAIL: 'cleared@example.invalid' };
  const setup = execFileSync(process.execPath, ['--no-warnings', join(V2, 'src/cli/setup.ts'), '--owner', OWNER, '--key', join(state, 'approval.key')], { env: { ...base, CLEARED_STATE_DIR: state }, encoding: 'utf8' });
  const publicKey = /human_public_key = (\S+)/.exec(setup)?.[1];
  if (!publicKey) throw new Error('setup gave no public key');
  const seed = join(root, 'seed');
  cpSync(GUESTBOOK, seed, { recursive: true, filter: (source) => !source.includes('node_modules') });
  const conf = readFileSync(join(seed, '.cleared', 'agents.conf'), 'utf8').replace(/^\[tracker\]$/m, `[tracker]\nhuman_public_key = ${publicKey}`);
  writeFileSync(join(seed, '.cleared', 'agents.conf'), conf);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...base, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(seed, 'init', '--quiet', '--initial-branch=main');
  git(seed, 'add', '--all');
  git(seed, 'commit', '--quiet', '-m', 'The example guestbook, for the live Take over run');
  git(root, 'clone', '--quiet', '--bare', seed, origin);
  const machine = join(root, 'agents.conf');
  writeFileSync(machine, `${conf}\n# The live run's machine settings (scripts/proof-takeover-live.ts).\n[tracker]\nowner_id = ${OWNER}\nhuman_private_key = ${join(state, 'approval.key')}\n`);
  writeGhStub(bin, forge, { 'example/guestbook': origin });
  writeFileSync(forge, JSON.stringify({ next: 101, prs: [] }));
  const passwordFile = join(root, 'password');
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  execFileSync(process.execPath, ['--no-warnings', join(V2, 'src/cli/user.ts'), 'add', OWNER], { env: { ...base, CLEARED_STATE_DIR: state }, input: `${password}\n${password}\n`, stdio: ['pipe', 'ignore', 'pipe'] });

  const inUse = listening();
  const servicePort = freePort(inUse);
  const appPort = freePort(new Set([...inUse, servicePort]));
  const previewPort = freePort(new Set([...inUse, servicePort, appPort]));
  const serviceEnv = liveEnv({ base, state, work, project, origin, machine, servicePort, appPort, login, model, budgetUsd });
  const children: ChildProcess[] = [];
  const start = (name: string, entry: string, extra: Record<string, string>): ChildProcess => {
    const out = openSync(join(root, `${name}.log`), 'a', 0o600);
    const child = spawn(process.execPath, ['--no-warnings', join(V2, entry)], { cwd: V2, env: { ...serviceEnv, ...extra }, stdio: ['ignore', out, out] });
    closeSync(out);
    children.push(child);
    return child;
  };
  const healthy = async (port: number, path: string) => { try { return (await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' })).status < 500; } catch { return false; } };
  const waitFor = async (what: string, check: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (!(await check())) { if (Date.now() > end) throw new Error(`${what} did not answer within ${ms / 1000} s`); await sleep(250); }
  };
  let service = start('service', 'src/main.ts', {});
  await waitFor('the service', () => healthy(servicePort, '/health'), 60_000);
  const app = start('app', 'app/main.ts', { CLEARED_V2_APP_PORT: String(appPort), CLEARED_V2_APP_HOST: '127.0.0.1', CLEARED_V2_APP_PROJECT: 'guestbook', CLEARED_V2_PREVIEW_PORT: String(previewPort) });
  await waitFor('the app', () => healthy(appPort, '/'), 60_000);
  const APP = `http://127.0.0.1:${appPort}`;
  say(`install: service on ${servicePort}, app on ${appPort}, preview on ${previewPort}, model ${model}, budget ${budgetUsd} USD a ticket`);

  // ---- the ledger, read only ----
  const ledgerPath = join(state, 'ledger.db');
  function ledger<T>(read: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try { return read(db); } finally { db.close(); }
  }
  type Row = { seq: number; at: string; event: string };
  const eventsOf = (session: string) => ledger((db) => db.prepare('SELECT seq, at, event FROM session_events WHERE session_id = ? ORDER BY seq').all(session) as Row[])
    .map((row) => ({ seq: row.seq, at: row.at, event: JSON.parse(row.event) as { type: string; name?: string; value?: Record<string, unknown>; delta?: string; code?: string; message?: string } }));
  const week = (): number | undefined => {
    const rows = ledger((db) => db.prepare("SELECT at, event FROM session_events WHERE type = 'CUSTOM' AND event LIKE '%cleared.rate_limit%' ORDER BY at").all() as { at: string; event: string }[]);
    let latest: number | undefined;
    for (const row of rows) {
      const value = (JSON.parse(row.event) as { value: { window: string; usedPercent: number } }).value;
      if (value.window !== 'seven_day') continue;
      latest = value.usedPercent;
      // Each figure once, when it changes: the rows are read again at each call.
      const last = quota.at(-1);
      if ((!last || row.at > last.at) && last?.percent !== latest) quota.push({ at: row.at, percent: latest });
    }
    return latest;
  };
  const costOf = (ticket: string): number => ledger((db) => {
    let total = 0;
    for (const { s } of db.prepare('SELECT id AS s FROM sessions WHERE ticket = ?').all(ticket) as { s: string }[]) {
      let last = 0;
      for (const { event } of db.prepare("SELECT event FROM session_events WHERE session_id = ? AND type = 'RUN_FINISHED' ORDER BY seq").all(s) as { event: string }[]) {
        const cost = (JSON.parse(event) as { result?: { total_cost_usd?: number | null } }).result?.total_cost_usd;
        if (typeof cost === 'number') last = cost;
      }
      total += last;
    }
    return Math.round(total * 1000) / 1000;
  });

  // ---- the browser ----
  const require = createRequire(join(env.PROOF_PLAYWRIGHT, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: any };
  const browser = await chromium.launch({ headless: true, ...(env.PROOF_CHROME ? { executablePath: env.PROOF_CHROME } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const reader = await context.newPage();
  let shots = 0;
  const capture = async (name: string) => {
    const file = join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`);
    await page.mouse.move(2, 2).catch(() => undefined);
    await page.screenshot({ path: file });
    chmodSync(file, 0o644);
  };
  async function api<T>(path: string, method = 'GET', body: unknown = null): Promise<T> {
    return await reader.evaluate(async ([url, how, payload]: [string, string, unknown]) => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (how !== 'GET') {
        headers['content-type'] = 'application/json';
        headers['x-csrf-token'] = (await (await fetch('/api/me', { headers: { accept: 'application/json' } })).json() as { csrf: string }).csrf;
      }
      const response = await fetch(url, { method: how, headers, ...(how === 'GET' ? {} : { body: JSON.stringify(payload) }) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${how} ${url} answered ${response.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    }, [`/api/service${path}`, method, body]) as T;
  }
  const sessions = () => api<SessionSummary[]>('/sessions');
  const checks = declaredChecks(readFileSync(join(GUESTBOOK, 'package.json'), 'utf8'));
  let stopped: string | undefined;

  async function openItem(id: string): Promise<void> {
    await page.goto(`${APP}/inbox`);
    const link = page.locator(`a.item[data-item="${id}"]`);
    await link.waitFor();
    await link.click();
    await page.locator(`a.item[data-item="${id}"][aria-current="true"]`).waitFor();
    await page.locator('#d-actions, #detail [data-act]').first().waitFor({ state: 'attached' });
  }
  // What the owner tends while the run waits: the session plans' Go, the
  // permissions by the proofs' rule, the questions with their recommended option.
  async function tend(): Promise<void> {
    const ours = new Set(Object.values(tickets));
    for (const item of await api<NextInboxItem[]>('/inbox')) {
      if (item.state !== 'waiting' || !ours.has(item.ticket)) continue;
      if (item.kind === 'session_plan') {
        await openItem(item.id);
        await page.locator('#detail [data-act="plan_go"]').click();
        gesture(`gave the Go to the session plan of ${item.ticket} (${item.plan.confidence})`);
        await sleep(2_000);
      } else if (item.kind === 'permission') {
        const session = (await sessions()).find((s) => s.id === item.sessionId);
        const command = item.input.kind === 'execute' ? item.input.command : undefined;
        const { decision, rule } = permissionAnswer({ role: session?.role, command, checks });
        await openItem(item.id);
        await page.locator(`#detail [data-act="${decision}"]`).click();
        gesture(`${decision} for a permission of the ${session?.role ?? 'unknown'} (${rule}${command ? `: ${command.replace(/\s+/g, ' ').slice(0, 80)}` : ''})`);
      } else if (item.kind === 'question') {
        await openItem(item.id);
        const chosen = await answerInInbox(page, item.questions);
        gesture(`answered a question of ${item.ticket} (${chosen.map((c) => c.answer).join('; ')})`);
        await sleep(2_000);
      }
    }
  }
  function checkQuota(): void {
    const verdict = quotaVerdict(quota[0]?.percent ?? week(), week());
    if (verdict.stop && !stopped) { stopped = verdict.reason; say(`quota: stop: ${verdict.reason}`); }
    if (stopped) throw new Error(`stopped: ${stopped}`);
  }
  async function until<T>(what: string, check: () => Promise<T | undefined | false>, ms = stepMs, every = 2_000, tending = true): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      checkQuota();
      if (tending) await tend().catch((error: unknown) => say(`tend: ${(error as Error).message.split('\n')[0]}`));
      const value = await check().catch((error: unknown) => { if (error instanceof Ended) throw error; return undefined; });
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(every);
    }
  }
  async function phase(name: string, body: () => Promise<string>): Promise<boolean> {
    try {
      const note = await body();
      phases.push({ name, status: 'ok', at: now(), note: redact(note, { root, home: homedir(), login }) });
      say(`${name}: ok (${note})`);
      await capture(name).catch(() => undefined);
      return true;
    } catch (error) {
      const note = (error as Error).message.split('\n')[0] ?? '';
      phases.push({ name, status: 'failed', at: now(), note: redact(note, { root, home: homedir(), login }) });
      say(`${name}: failed (${note})`);
      await capture(`${name}-failed`).catch(() => undefined);
      return false;
    }
  }

  async function createTicket(n: 0 | 1): Promise<string> {
    const t = LIVE_TICKETS[n];
    await page.goto(`${APP}/`);
    await page.locator('#ask-input').fill(t.title);
    await page.locator('#ask-body').fill(t.body);
    const chip = page.locator('#ask .svc-toggle[data-service="guestbook"]');
    if (await chip.count() > 0 && (await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
    const known = new Set((await api<Ticket[]>('/tickets')).map((ticket) => ticket.id));
    await page.locator('#ask button[type="submit"]').click();
    const made = await until(`the ticket "${t.title}"`, async () => (await api<Ticket[]>('/tickets')).find((ticket) => !known.has(ticket.id) && ticket.title === t.title), 60_000, 1_000, false);
    tickets[n === 0 ? 'A' : 'B'] = made.id;
    gesture(`created ${made.id} from the tower bar: ${t.title}`);
    return made.id;
  }
  // The file the Editor changes, per session: one the author changed itself.
  const editorFile = new Map<string, string>();
  // A live session of the ticket. With `changed`, an author that has changed
  // a file already, as step 11 waits for src/page.ts: the Editor tab lists the
  // session's changed files only. Its own handover is not one; src/page.ts is
  // preferred. An author that ended with none is said at once.
  const live = (ticket: string, role: 'author' | 'reviewer', changed = false) => until(`the ${role} of ${ticket} to work${changed ? ' on a file' : ''}`, async () => {
    const all = (await sessions()).filter((s) => s.ticket === ticket);
    const found = all.find((s) => s.role === role && (s.phase === (role === 'author' ? 'working' : 'reviewing')) && !s.takenOver);
    if (changed && !found && all.some((s) => s.role === 'reviewer')) throw new Ended(`the author of ${ticket} ended before changing a file the Editor could open`);
    if (!found || !changed) return found;
    const paths = (await api<{ files: { path: string }[] }>(`/sessions/${encodeURIComponent(found.id)}/files`)).files.map((f) => f.path).filter((path) => path !== 'HANDOVER.md');
    const path = paths.includes('src/page.ts') ? 'src/page.ts' : paths[0];
    if (!path) return undefined;
    editorFile.set(found.id, path);
    return found;
  }, stepMs, 1_000);

  // Take over, a line to the harness, and, for an author, the Shell and the Editor; then Give back.
  async function takeOver(session: SessionSummary, options: { readonly shell: boolean; readonly editor: boolean; readonly giveBack: boolean }): Promise<string> {
    const notes: string[] = [];
    const taken = eventsOf(session.id).at(-1)?.seq ?? 0;
    await page.goto(`${APP}/sessions/${encodeURIComponent(session.id)}`);
    await page.locator('#takeover').click();
    gesture(`took over the ${session.role} ${session.id.slice(0, 8)} of ${session.ticket}`);
    await page.locator('#giveback').waitFor({ timeout: 60_000 });
    await page.locator('#tab-terminal-button').click();
    const terminal = page.locator('[data-terminal-state]').first();
    await terminal.waitFor();
    await until('the terminal to open', async () => {
      const at = await terminal.getAttribute('data-terminal-state');
      return at === 'open' || at === 'closed' ? at : undefined;
    }, 90_000, 500, false);
    const said = (await page.locator('.term-mode').first().innerText().catch(() => '')).trim();
    if ((await terminal.getAttribute('data-terminal-state')) !== 'open') throw new Error(`the terminal did not open: ${said} (${await terminal.getAttribute('data-reason')})`);
    notes.push(`terminal: "${said}"`);
    const rows = () => page.locator('.term-host').first().innerText().catch(() => '');
    if ((await terminal.getAttribute('data-mode')) !== 'shell') {
      await page.locator('.term-host').first().click();
      await sleep(4_000);
      await page.keyboard.type(HARNESS_LINE, { delay: 15 });
      await sleep(500);
      await page.keyboard.press('Enter');
      gesture(`typed to the harness: ${HARNESS_LINE}`);
      const answered = await until('the harness\'s answer', async () => HARNESS_ANSWER.test((await rows()).split(HARNESS_LINE).slice(1).join('')) || undefined, 180_000, 1_000, false).then(() => true, () => false);
      notes.push(answered ? 'the harness answered 42' : 'no answer from the harness in 3 min');
      await capture(`harness-${session.role}`);
    } else {
      notes.push('the terminal opened on the Shell, not the harness');
    }
    if (options.shell) {
      await page.locator('[data-act="terminal_shell"]').first().click();
      gesture('opened the Shell');
      await page.locator('[data-terminal-state="open"][data-mode="shell"]').first().waitFor({ timeout: 60_000 });
      await page.locator('.term-host').first().click();
      const answered: string[] = [];
      for (const { line, expect, timeoutMs, required } of SHELL_LINES) {
        await page.keyboard.type(line, { delay: 20 });
        await page.keyboard.press('Enter');
        gesture(`typed ${line} in the Shell`);
        await sleep(500);
        const seen = await until(`the answer to ${line}`, async () => { const text = await rows(); return atPrompt(text) && (!expect || expect.test(text)) ? text : undefined; }, timeoutMs, 500, false)
          .catch((error: unknown) => { if (required) throw error; return undefined; });
        answered.push(`${line}: ${seen === undefined ? 'no answer in time' : lineOutcome(line, seen)}`);
        if (line === 'git status') await capture('shell-git-status');
      }
      notes.push(answered.join('; '));
      await capture('shell-tests');
    }
    if (options.editor) {
      const saves: number[] = [];
      const listener = (response: any) => { if (response.request().method() === 'PUT' && /\/files\//.test(response.url())) saves.push(response.status()); };
      page.on('response', listener);
      await page.locator('#tab-editor-button').click();
      const file = editorFile.get(session.id) ?? 'src/page.ts';
      await page.locator(`[data-file="${file}"]`).click();
      await page.locator('[data-act="editor_edit"]').click();
      await page.locator('[data-editor-state]').first().waitFor();
      await page.locator('.cm-content').first().click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('// The owner changed this line in the Editor tab (live Take over run).\n');
      await page.locator('[data-act="editor_save"]').click();
      await page.locator('[data-editor-state="saved"]').first().waitFor({ timeout: 60_000 });
      page.off('response', listener);
      gesture(`changed one line of ${file} in the Editor tab and saved it`);
      notes.push(`editor save of ${file}: ${saves.join(', ') || 'no PUT seen'}`);
      await capture('editor-saved');
    }
    if (!options.giveBack) return notes.join('; ');
    const mark = eventsOf(session.id).at(-1)?.seq ?? 0;
    await page.locator('#giveback').click();
    gesture(`gave the ${session.role} ${session.id.slice(0, 8)} back`);
    // The session's own work after the Give back's words: a new turn, or the
    // turn the take over found not begun yet, which the runner holds while the
    // harness is the owner's and carries on with after the Give back.
    await until('the turn after the Give back', async () => {
      const after = eventsOf(session.id).filter((e) => e.seq > mark);
      const told = after.findIndex((e) => e.event.type === 'TEXT_MESSAGE_CONTENT' && /gave the session back/.test(e.event.delta ?? ''));
      return told >= 0 && after.slice(told + 1).some((e) => ['RUN_STARTED', 'TOOL_CALL_START', 'REASONING_START'].includes(e.event.type));
    }, 180_000, 1_000);
    const after = eventsOf(session.id).filter((e) => e.seq > mark);
    // The editor's save journals its edit when it is saved; Give back, the terminal's.
    const edits = eventsOf(session.id).filter((e) => e.seq > taken && e.event.type === 'CUSTOM' && e.event.name === 'cleared.human_edit').length;
    const file = editorFile.get(session.id);
    const notice = file !== undefined && after.some((e) => e.event.type === 'TEXT_MESSAGE_CONTENT' && (e.event.delta ?? '').includes(file));
    notes.push(`given back: the notice's turn began; ${edits} human edit(s) journaled; ${file ? `the notice ${notice ? 'names' : 'does not name'} ${file}` : 'no file edited'}`);
    return notes.join('; ');
  }

  // ---- 0. sign in ----
  const signedIn = await phase('sign-in', async () => {
    await page.goto(`${APP}/`);
    await page.locator('#name').fill(OWNER);
    await page.locator('#password').fill(password);
    await Promise.all([page.waitForURL(`${APP}/`), page.locator('form.login-card [type=submit]').first().click()]);
    await page.locator('#ask-input').waitFor();
    await reader.goto(`${APP}/`);
    return `signed in as ${OWNER}`;
  });

  let authorA: SessionSummary | undefined;
  // ---- 1. ticket A: the author taken over, the Shell, the Editor, Give back ----
  const ranA = signedIn && await phase('A-author', async () => {
    const ticket = await createTicket(0);
    authorA = await live(ticket, 'author', true);
    const note = await takeOver(authorA, { shell: true, editor: true, giveBack: true });
    return `${authorA.id.slice(0, 8)} of ${ticket}: ${note}`;
  });
  // ---- 2. ticket A: the reviewer taken over and given back; #233 on the author's screen ----
  if (ranA && authorA) {
    const author = authorA;
    await phase('A-reviewer', async () => {
      const reviewer = await live(author.ticket, 'reviewer');
      const note = await takeOver(reviewer, { shell: false, editor: false, giveBack: true });
      await page.goto(`${APP}/sessions/${encodeURIComponent(author.id)}`);
      const shown = (await page.locator('.phrase-title').first().innerText().catch(() => '?')).trim();
      const phaseNow = (await sessions()).find((s) => s.id === author.id)?.phase;
      await capture('author-after-giveback');
      return `${reviewer.id.slice(0, 8)}: ${note}; the author's screen reads "${shown}" (its phase ${phaseNow})`;
    });
  } else {
    phases.push({ name: 'A-reviewer', status: 'skipped', at: now(), note: 'the author\'s phase did not pass' });
  }
  await phase('A-end', async () => {
    const ticket = tickets.A;
    if (!ticket) return 'no ticket';
    // A failed author phase leaves its session taken over: nothing to wait for.
    const card = !ranA ? 'the author\'s phase failed' : await until('the review\'s end or the release card', async () => {
      const item = (await api<NextInboxItem[]>('/inbox')).find((i) => i.ticket === ticket && i.kind === 'release' && i.state === 'waiting');
      if (item) return `the release card waits (${item.kind === 'release' ? item.groups?.flatMap((g) => g.files).includes('src/page.ts') ? 'src/page.ts in its diff' : 'src/page.ts not in its diff' : ''})`;
      const t = await api<Ticket>(`/tickets/${encodeURIComponent(ticket)}`);
      return t.status === 'Todo' ? `the ticket is back in Todo` : undefined;
    }, 15 * 60_000).catch((error: unknown) => `no end seen: ${(error as Error).message}`);
    await api(`/tickets/${encodeURIComponent(ticket)}/set-aside`, 'POST');
    gesture(`set ${ticket} aside (nothing approved)`);
    // Issue #233: with nothing of the ticket live, the page heads with the
    // author's own state, which read "Working" after a Give back.
    const verdict = ledger((db) => (db.prepare("SELECT event FROM session_events WHERE ticket = ? AND event LIKE '%cleared.review_verdict%' ORDER BY seq").all(ticket) as { event: string }[])
      .map((row) => (JSON.parse(row.event) as { value: { verdict: string } }).value.verdict)).at(-1);
    let shown = 'no author';
    if (authorA) {
      await sleep(2_000);
      await page.goto(`${APP}/sessions/${encodeURIComponent(authorA.id)}`);
      // The page draws from the session's detail first, then from its journal: read it once the journal is in.
      await sleep(5_000);
      shown = (await page.locator('.phrase-title').first().innerText().catch(() => '?')).trim();
    }
    return `${card}; the review's verdict: ${verdict ?? 'none'}; set aside; the author's screen then reads "${shown}"; ${costOf(ticket)} USD`;
  });

  // ---- 3. ticket B: taken over, then the service restarted ----
  let authorB: SessionSummary | undefined;
  const restarted = signedIn && !stopped && await phase('B-restart', async () => {
    const ticket = await createTicket(1);
    authorB = await live(ticket, 'author');
    await takeOver(authorB, { shell: false, editor: false, giveBack: false });
    const containers = (await docker.containers(authorB.id)).length;
    gesture('restarted the service (SIGTERM, then the same command)');
    service.kill('SIGTERM');
    await new Promise((r) => service.once('exit', r));
    service = start('service', 'src/main.ts', {});
    await waitFor('the restarted service', () => healthy(servicePort, '/health'), 60_000);
    await sleep(10_000);
    const row = (await sessions()).find((s) => s.id === authorB!.id);
    const last = eventsOf(authorB.id).filter((e) => e.event.type === 'RUN_ERROR').at(-1)?.event;
    const t = await api<Ticket>(`/tickets/${encodeURIComponent(ticket)}`);
    await page.goto(`${APP}/sessions/${encodeURIComponent(authorB.id)}`);
    const shown = (await page.locator('.phrase-title').first().innerText().catch(() => '?')).trim();
    const left = (await docker.containers(authorB.id)).length;
    return `before the restart: taken over, ${containers} container(s); after it: phase ${row?.phase}, taken over ${row?.takenOver ? 'yes' : 'no'}, last error "${last?.code ?? 'none'}: ${last?.message ?? ''}", ticket ${t.status}, the screen reads "${shown}", ${left} container(s) left`;
  });
  // ---- 4. after the restart: the same session if it survived, else a new one ----
  if (restarted && authorB) {
    const first = authorB;
    await phase('B-after-restart', async () => {
      const row = (await sessions()).find((s) => s.id === first.id);
      let session: SessionSummary;
      if (row && (row.phase === 'working' || row.phase === 'waiting_human')) {
        session = row;
      } else {
        // As the restart's note says: move it to Todo to start it again (Todo to Todo starts it too).
        await api(`/tickets/${encodeURIComponent(first.ticket)}/move`, 'POST', { status: 'Todo' });
        gesture(`moved ${first.ticket} to Todo to start it again`);
        await until('a new author', async () => (await sessions()).find((s) => s.ticket === first.ticket && s.role === 'author' && s.id !== first.id));
        session = await live(first.ticket, 'author', true);
      }
      const note = await takeOver(session, { shell: true, editor: true, giveBack: true });
      return `${session.id === first.id ? 'the same session' : `a new session ${session.id.slice(0, 8)}`}: ${note}`;
    });
    await phase('B-end', async () => {
      await api(`/tickets/${encodeURIComponent(first.ticket)}/set-aside`, 'POST');
      gesture(`set ${first.ticket} aside (nothing approved)`);
      return `${costOf(first.ticket)} USD`;
    });
  }

  // ---- the end ----
  for (const id of Object.values(tickets)) await api(`/tickets/${encodeURIComponent(id)}/set-aside`, 'POST').catch(() => undefined);
  await sleep(5_000);
  week();
  const ours = ledger((db) => (db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id));
  await browser.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map((child) => (child.exitCode !== null ? undefined : new Promise((r) => child.once('exit', r)))));
  const released = await docker.releaseStopped(ours).catch(() => ({ containers: [], networks: [] }));
  for (const id of ours) await docker.removeVolumes(id).catch(() => undefined);
  // Other processes of this server run sessions too: only this run's are its own.
  const left = (await docker.containers()).filter((c) => !before.has(c.name) && ours.includes(c.labels['cleared.session'] ?? '')).map((c) => c.name);
  const result = {
    mode: 'real', model, budgetUsd, ports: { service: servicePort, app: appPort, preview: previewPort },
    tickets, costs: Object.fromEntries(Object.entries(tickets).map(([k, id]) => [k, costOf(id)])), quota, stopped: stopped ?? null,
    phases, gestures, released: { containers: released.containers.length, networks: released.networks.length }, left,
  };
  writeFileSync(join(OUT, 'result.json'), `${redact(JSON.stringify(result, null, 2), { root, home: homedir(), login })}\n`);
  writeFileSync(join(OUT, 'log.md'), `${lines.join('\n')}\n`);
  rmSync(passwordFile, { force: true });
  say(`done: ${phases.filter((p) => p.status === 'ok').length} ok, ${phases.filter((p) => p.status === 'failed').length} failed; ${OUT}; the run's folder is kept for reading: ${root}`);
  process.exitCode = phases.some((p) => p.status === 'failed') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) await main();
