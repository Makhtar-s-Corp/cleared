// The captures of the fixes from the wave 4 real tickets (docs/v2/real-fixes/,
// issues #503 to #510): the token step with a token that cannot write, the
// environment step with the receipt's addresses, a session whose publication
// failed and the Consumption screen on a login the hourly reading refuses, at
// 1440x900 and 390x844, in French, on the app's fixture source with made-up
// answers for the service's routes. No Docker, no service, no real data; the app
// listens on loopback for the run.
//
//   node scripts/real-fixes-captures.ts <folder> [port]
//
// It starts the built app (npm run build first) on a free port of 9800 to 9899,
// signs in a made-up user, draws each state and closes all of it. The same
// answers serve the old screens and the new ones: a route an old screen never
// asks for is simply not read. REAL_FIXES_EXTRA adds the states an old screen
// did not have, REAL_FIXES_SNAPSHOTS names a folder for sloplint's render tier,
// and REAL_FIXES_AXE runs axe on each state with its folds open.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

declare const document: any;
declare const window: any;

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };

const folder = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node scripts/real-fixes-captures.ts <folder> [port]');
mkdirSync(folder, { recursive: true });

const free = (port: number) => new Promise<boolean>((done) => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
});
async function pickPort(): Promise<number> {
  if (process.argv[3]) return Number(process.argv[3]);
  for (let port = 9800; port < 9900; port += 1) if (await free(port)) return port;
  throw new Error('no free port in 9800 to 9899');
}

const USER = 'demo';
const PHRASE = ['made', 'up', 'for', 'the', 'captures'].join('-');
const FAKE_TOKEN = ['not', 'a', 'real', 'token'].join('-');
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const SERVICE = 'exemple-livre-or';
const REPOSITORY = `exemple-org/${SERVICE}`;
const AUTHOR = 'session-auteur-1';
const REVIEWER = 'session-relecteur-1';
const TICKET = 'LOCAL-7';
const TITLE = 'Afficher la date de chaque message du livre d\'or';

const json = (route: any, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ---------------------------------------------------------------- the assistant

const STEP_IDS = ['owner', 'forge', 'model', 'workspace', 'environment', 'secrets', 'checks', 'first-ticket'];
const setupView = (current: string) => {
  const at = STEP_IDS.indexOf(current);
  return {
    steps: STEP_IDS.map((id, index) => ({ id, state: index < at ? 'done' : 'todo', filled: true, skippable: id !== 'owner' && id !== 'forge', shownAt: ago(30), doneAt: index < at ? ago(20) : null, skippedAt: null, personMs: 60_000, machineMs: 1_000 })),
    owner: USER, current, total: { personMs: 60_000, machineMs: 1_000 },
  };
};
const RIGHTS = [
  { permission: 'metadata', access: 'read', optional: false }, { permission: 'contents', access: 'write', optional: false }, { permission: 'pull_requests', access: 'write', optional: false },
  { permission: 'commit_statuses', access: 'read', optional: false }, { permission: 'workflows', access: 'write', optional: true }, { permission: 'issues', access: 'write', optional: true },
];
const GITLAB = { credential: { set: false }, address: 'https://gitlab.com' };

// The token step: a token GitHub accepts, and what it may do on the repository picked there.
async function tokenRoutes(page: any, access: { readonly contents: string; readonly pullRequests: string }) {
  let saved = false;
  const credential = () => (saved ? { set: true, at: ago(0), source: 'assistant' } : { set: false });
  await page.route('**/api/service/setup', (route: any) => json(route, setupView('forge')));
  await page.route('**/api/service/setup/forge', (route: any) => {
    if (route.request().method() !== 'POST') return json(route, { credential: credential(), rights: RIGHTS, gitlab: GITLAB });
    saved = true;
    return json(route, { forge: 'github', credential: credential(), repositories: 1, more: false, sample: [REPOSITORY] });
  });
  await page.route('**/api/service/setup/forge/access', (route: any) => {
    if (route.request().method() !== 'POST') return json(route, { repositories: [REPOSITORY], more: false, connected: [] });
    return json(route, { repository: REPOSITORY, ...access });
  });
}

const preparedService = {
  name: SERVICE, readable: true, devcontainer: 'image', foreignImage: null, install: 'npm ci', state: 'ready', image: 'cleared-v2-prepared-exemple:1a2b3c', builtAt: ago(4), buildMs: 92_000, startedAt: null, error: null,
  checkCommand: 'npm test', check: { command: 'npm test', passed: true, at: ago(3), ms: 8_000, tail: '' }, proposal: null, setupTicket: null,
};

async function environmentRoutes(page: any, proof: unknown) {
  await page.route('**/api/service/setup', (route: any) => json(route, setupView('environment')));
  await page.route('**/api/service/setup/environment', (route: any) => json(route, { workspace: true, services: [{ ...preparedService, proof }], sessions: 'ready' }));
}

// ---------------------------------------------------------------- the session

const summary = (id: string, role: string, phase: string, status: string, started: number, updated: number, seq: number, model = 'claude-opus-5-5') =>
  ({ id, project: 'livre-or', ticket: TICKET, role, harness: 'claude-code', model, phase, status, startedAt: ago(started), updatedAt: ago(updated), lastSeq: seq, service: SERVICE });
const ticket = { id: TICKET, title: TITLE, body: 'Chaque message du livre d\'or montre le jour où il a été écrit.', status: 'Todo', labels: [], project: 'livre-or', createdAt: ago(30), updatedAt: ago(1), services: [{ name: SERVICE, branch: null, pr: null, state: 'open' }] };
const workspace = { id: 'livre-or', name: 'livre-or', services: [{ name: SERVICE, kind: 'repository', repo: REPOSITORY, url: `https://github.com/${REPOSITORY}.git`, base: 'main', path: null, healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null }] };

let seq = 0;
const event = (session: string, minutes: number, body: unknown) => ({ seq: ++seq, at: ago(minutes), sessionId: session, ticket: TICKET, event: body });
const custom = (session: string, minutes: number, name: string, value: unknown) => event(session, minutes, { type: 'CUSTOM', name, value });
const PASSED = [{ name: 'git diff', state: 'passed' }, { name: 'npm test', state: 'passed' }];
const USAGE = { inputTokens: 28_400, outputTokens: 7_100 };
const state = (phase: string) => ({ status: 'Done', phase, files: [{ path: 'web/Message.tsx', added: 14, removed: 2 }], checks: PASSED, usage: USAGE, steps: [] });
const REFUSED = `git push failed in [removed: service path]: remote: Permission to ${REPOSITORY}.git denied to exemple-compte. fatal: unable to access '...': The requested URL returned error: 403`;

async function sessionRoutes(page: any, failure: { readonly code: string; readonly detail: string }) {
  const author = summary(AUTHOR, 'author', 'done', 'Done', 28, 6, 5);
  const reviewer = summary(REVIEWER, 'reviewer', 'done', 'Done', 6, 2, 4, 'claude-sonnet-5-5');
  const events: Record<string, unknown[]> = {
    [AUTHOR]: [event(AUTHOR, 28, { type: 'STATE_SNAPSHOT', snapshot: state('done') }), event(AUTHOR, 6, { type: 'RUN_FINISHED', threadId: AUTHOR, runId: 'r1', outcome: { type: 'success' } })],
    [REVIEWER]: [event(REVIEWER, 6, { type: 'STATE_SNAPSHOT', snapshot: state('done') }), custom(REVIEWER, 2, 'cleared.review_verdict', { verdict: 'pass', round: 1 }), custom(REVIEWER, 2, 'cleared.publish_failed', { ...failure, service: null })],
  };
  await page.route('**/api/service/**', (route: any) => json(route, { error: 'unknown' }, 404));
  await page.route('**/api/service/inbox**', (route: any) => json(route, []));
  await page.route('**/api/service/workspace', (route: any) => json(route, workspace));
  await page.route('**/api/service/tickets', (route: any) => json(route, [ticket]));
  await page.route('**/api/service/sessions', (route: any) => json(route, [author, reviewer]));
  await page.route(`**/api/service/tickets/${TICKET}`, (route: any) => json(route, ticket));
  await page.route(`**/api/service/tickets/${TICKET}/steps`, (route: any) => json(route, []));
  await page.route(`**/api/service/tickets/${TICKET}/captures`, (route: any) => json(route, { choice: 'auto', by: null, at: null }));
  await page.route(`**/api/service/tickets/${TICKET}/cost`, (route: any) => json(route, { ticket: TICKET, sessions: 2, turns: 2, tokens: 35_500, workMs: 22 * 60_000, elapsedMs: 28 * 60_000, costUsd: 0.13 }));
  await page.route(`**/api/service/tickets/${TICKET}/production`, (route: any) => json(route, []));
  for (const [id, detail] of [[AUTHOR, author], [REVIEWER, reviewer]] as const) {
    await page.route(`**/api/service/sessions/${id}`, (route: any) => json(route, { ...detail, state: state('done') }));
    let sent = false;
    await page.route(`**/api/service/sessions/${id}/events**`, (route: any) => {
      const frames = sent ? '' : (events[id] ?? []).map((one: any) => `id: ${one.seq}\nevent: ${one.event.type}\ndata: ${JSON.stringify(one)}\n\n`).join('');
      sent = true;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames });
    });
  }
}

// ---------------------------------------------------------------- the quota

const DAYS = Array.from({ length: 7 }, (_, index) => new Date(NOW - (6 - index) * 86_400_000).toISOString().slice(0, 10));
const SPEND = { sessions: 2, turns: 2, tokens: 35_500, workMs: 22 * 60_000, costUsd: 0.13 };
const LEVERS = { model: { current: 'claude-opus-5-5', choice: null, options: ['claude-opus-5-5', 'claude-haiku-5-5'], reviewer: 'claude-sonnet-5-5' }, maxLanes: { choice: null, options: [1, 2, 3] }, paused: false };
const claude = (quotas: readonly unknown[]) => ({
  harness: 'claude-code', sessions: 2, tokens: 35_500, perDay: DAYS.map((day, index) => ({ day, tokens: index === 6 ? 35_500 : 0 })), quotas,
  lastReading: { at: ago(35), source: 'claude-code /api/oauth/usage', ok: false, error: 'the endpoint refused the login (HTTP 403)', unavailable: true }, costUsd: 0.13, costTurns: { reported: 2, turns: 2 },
});
async function consumptionRoutes(page: any, quotas: readonly unknown[]) {
  const body = { at: new Date(NOW).toISOString(), timeZone: 'Europe/Paris', days: DAYS, harnesses: [claude(quotas)], levers: LEVERS, wins: [] };
  await page.route('**/api/service/**', (route: any) => json(route, { error: 'unknown' }, 404));
  await page.route('**/api/service/inbox**', (route: any) => json(route, []));
  await page.route('**/api/service/workspace', (route: any) => json(route, workspace));
  await page.route('**/api/service/tickets', (route: any) => json(route, []));
  await page.route('**/api/service/sessions', (route: any) => json(route, []));
  await page.route('**/api/service/consumption?**', (route: any) => json(route, body));
  await page.route('**/api/service/consumption/week?**', (route: any) => json(route, { at: body.at, timeZone: body.timeZone, days: DAYS, since: `${DAYS[0]}T00:00:00.000Z`, merged: [], spend: SPEND, estimates: { tickets: 0, estimatedMinutes: 0, actualMinutes: 0 }, services: [] }));
}
const reported = { window: 'seven_day', usedPercent: 54, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(), observedAt: ago(90), source: 'session', projection: { kind: 'holds', percentAtReset: 78 } };

// ---------------------------------------------------------------- the scenes

type Scene = { readonly name: string; readonly path: string; routes(page: any): Promise<unknown>; act?(page: any): Promise<unknown> };
const pasteToken = async (page: any) => {
  await page.fill('#setup-forge-value', FAKE_TOKEN);
  await page.click('[data-act="setup_forge_check"]');
  await page.locator('[data-forge-result="ok"]').waitFor();
  await page.waitForTimeout(300);
};
const DETECTED = { healthUrl: 'http://127.0.0.1:9811/health', run: 'Dockerfile:3000' };
const SCENES: readonly Scene[] = [
  { name: 'token-step', path: '/setup/forge', routes: (page) => tokenRoutes(page, { contents: 'refused', pullRequests: 'refused' }), act: pasteToken },
  { name: 'health-run-step', path: '/setup/environment', routes: (page) => environmentRoutes(page, { healthUrl: null, run: null, detected: DETECTED }) },
  { name: 'session-publish-failed', path: `/sessions/${REVIEWER}`, routes: (page) => sessionRoutes(page, { code: 'token_denied', detail: REFUSED }) },
  { name: 'quota-unavailable', path: '/consumption', routes: (page) => consumptionRoutes(page, []) },
  ...(process.env.REAL_FIXES_EXTRA ? [
    { name: 'token-step-ok', path: '/setup/forge', routes: (page: any) => tokenRoutes(page, { contents: 'ok', pullRequests: 'ok' }), act: pasteToken },
    { name: 'health-run-step-saved', path: '/setup/environment', routes: (page: any) => environmentRoutes(page, { ...DETECTED, detected: DETECTED }) },
    { name: 'health-run-step-none', path: '/setup/environment', routes: (page: any) => environmentRoutes(page, { healthUrl: null, run: null, detected: { healthUrl: null, run: null } }) },
    { name: 'session-publish-taken', path: `/sessions/${REVIEWER}`, routes: (page: any) => sessionRoutes(page, { code: 'branch_taken', detail: 'git push failed: ! [rejected] (non-fast-forward)' }) },
    { name: 'quota-unavailable-reported', path: '/consumption', routes: (page: any) => consumptionRoutes(page, [reported]) },
  ] satisfies readonly Scene[] : []),
];

async function shot(page: any, name: string, frame: 'desktop' | 'mobile') {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(folder, `${name}-${frame}.png`), fullPage: true, animations: 'disabled' });
  if (process.env.REAL_FIXES_SNAPSHOTS && frame === 'desktop') await snapshot(page, name);
}

// The screen as a page of its own, its sheets inline and no script, for sloplint's render tier.
async function snapshot(page: any, name: string) {
  const dir = process.env.REAL_FIXES_SNAPSHOTS as string;
  mkdirSync(dir, { recursive: true });
  const markup: string = await page.evaluate(async () => {
    const sheets = await Promise.all([...document.querySelectorAll('link[rel="stylesheet"]')].map(async (link: any) => (await fetch(link.href)).text()));
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"]').forEach((node: any) => node.remove());
    const style = document.createElement('style');
    style.textContent = sheets.join('\n');
    clone.querySelector('head')?.prepend(style);
    return `<!doctype html>${clone.outerHTML}`;
  });
  const stamp = /^\/\* Hallmark[^]*?(?=\n\n|\n[^/ ])/.exec(readFileSync('app/web/styles/app.css', 'utf8'))?.[0] ?? '';
  writeFileSync(join(dir, `${name}.html`), markup.replace('<style>', `<style>${stamp}\n`).replaceAll('/fonts/', `file://${resolve('app/public/fonts')}/`));
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const problems: string[] = [];
async function accessible(page: any, what: string) {
  await page.evaluate(() => { document.querySelectorAll('details').forEach((fold: any) => { fold.open = true; }); });
  await page.waitForTimeout(100);
  await page.evaluate(axeSource);
  const found: string[] = await page.evaluate(async (tags: string[]) => {
    const axe = (window as any).axe;
    const rules = axe.getRules(tags).filter((r: { ruleId: string; tags: string[] }) => r.ruleId !== 'label-content-name-mismatch' && !r.tags.some((tag) => tag === 'experimental' || tag === 'deprecated')).map((r: { ruleId: string }) => r.ruleId);
    const all = await axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'rule', values: rules } });
    return all.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
  for (const problem of found) problems.push(`${what}: ${problem}`);
}

const FRAMES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

const stateDir = mkdtempSync(join(tmpdir(), 'cleared-v2-j7-real-fixes-'));
const port = await pickPort();
const env = { ...process.env, CLEARED_STATE_DIR: stateDir, CLEARED_V2_APP_SOURCE: 'fixtures', CLEARED_V2_APP_PORT: String(port), CLEARED_V2_APP_LANGUAGE: 'fr' };
const adding = spawn(process.execPath, ['src/cli/user.ts', 'add', USER], { env, stdio: ['pipe', 'ignore', 'inherit'] });
adding.stdin.end(`${PHRASE}\n${PHRASE}\n`);
await new Promise((done) => adding.once('exit', done));
const app = spawn(process.execPath, ['app/main.ts'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const origin = `http://127.0.0.1:${port}`;
try {
  for (let tries = 0; ; tries += 1) {
    const up = await fetch(`${origin}/login`).then((r) => r.ok, () => false);
    if (up) break;
    if (tries > 100) throw new Error('the app did not start');
    await new Promise((done) => setTimeout(done, 100));
  }
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  for (const [frame, viewport] of Object.entries(FRAMES) as ['desktop' | 'mobile', { width: number; height: number }][]) {
    const context = await browser.newContext({ viewport, locale: 'fr-FR', deviceScaleFactor: 1, hasTouch: frame === 'mobile', isMobile: frame === 'mobile' });
    const signin = await context.newPage();
    await signin.goto(`${origin}/login`);
    await signin.fill('input[name=name], input[autocomplete=username]', USER);
    await signin.fill('input[type=password]', PHRASE);
    await signin.press('input[type=password]', 'Enter');
    await signin.waitForURL((url: URL) => url.pathname !== '/login');
    await signin.close();
    for (const scene of SCENES) {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await scene.routes(page);
      await page.goto(`${origin}${scene.path}`);
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
      await scene.act?.(page);
      await shot(page, scene.name, frame);
      if (process.env.REAL_FIXES_AXE) await accessible(page, `${scene.name} ${frame}`);
      for (const error of errors) problems.push(`${scene.name} ${frame}: page error: ${error}`);
      await page.close();
    }
    await context.close();
  }
  await browser.close();
  console.log(problems.length === 0 ? (process.env.REAL_FIXES_AXE ? 'axe: no violation on any state, at 1440 and 390' : 'captures taken') : `problems:\n${problems.join('\n')}`);
  if (problems.length > 0) process.exitCode = 1;
} finally {
  app.kill();
  rmSync(stateDir, { recursive: true, force: true });
}
