// The session screen's captures (docs/v2/session/, issue #499): the screen in
// its five states, at 1440x900 and 390x844, in French, on the app's fixture
// source with made-up answers for the service's routes. No Docker, no service,
// no real data; the app listens on loopback for the run.
//
//   node scripts/session-captures.ts <folder> [port]
//
// It starts the built app (npm run build first) on a free port of 9800 to 9899,
// signs in a made-up user, draws each state, runs axe with the folds open and
// closes all of it. SESSION_SNAPSHOTS names a folder for sloplint's render tier;
// SESSION_EXTRA adds the states the owner's five do not name (a plan to approve,
// a question) and SESSION_LOOK opens the folds in a second capture.
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
if (!process.argv[2]) throw new Error('usage: node scripts/session-captures.ts <folder> [port]');
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
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const SERVICE = 'exemple-livre-or';
const AUTHOR = 'session-auteur-1';
const REVIEWER = 'session-relecteur-1';
const TICKET = 'LOCAL-7';
const OTHER = 'LOCAL-9';
const TITLE = 'Afficher la date de chaque message du livre d\'or';
const BODY = "## Ce qu'il faut\n\nChaque message du livre d'or montre le jour où il a été écrit.\n\n- [ ] La date s'affiche sous le message\n- [ ] `npm test` passe\n\nDétails : [la maquette](https://example.com/maquette).";
const PLAN_STEPS = [
  'Lire le composant `Message` et son **test**',
  'Ajouter la date au `Message`',
  'Formater la date selon la langue de la page',
  'Écrire le test de l\'affichage',
  'Lancer `npm test` et corriger ce qui échoue',
];
const PLAN = { steps: PLAN_STEPS, files: ['web/Message.tsx', 'web/Message.test.tsx'], confidence: 'high', reason: 'Le composant est petit et il a déjà un test.', proposedAt: ago(26) };
const GO = { by: 'delay', at: ago(24) };

const summary = (id: string, role: string, phase: string, status: string, started: number, updated: number, seq: number, model = 'claude-opus-5-5') =>
  ({ id, project: 'livre-or', ticket: TICKET, role, harness: 'claude-code', model, phase, status, startedAt: ago(started), updatedAt: ago(updated), lastSeq: seq, service: SERVICE });

// Someone else's session, in the sidebar and the inbox: never to be mixed with this one.
const elsewhere = { id: 'session-autre', project: 'livre-or', ticket: OTHER, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'waiting_human', status: 'Waiting for the Go', startedAt: ago(4), updatedAt: ago(3), lastSeq: 9, service: SERVICE };
const elsewherePlan = {
  id: 'session_plan:session-autre:1', kind: 'session_plan', ticket: OTHER, project: 'livre-or', state: 'waiting', since: ago(3), sessionId: 'session-autre', service: SERVICE,
  plan: { steps: ['Renommer le bouton'], files: ['web/Bouton.tsx'], confidence: 'high', reason: 'Un seul fichier.', proposedAt: ago(3), go: null },
};

const ticket = (status: string, pr: number | null) => ({
  id: TICKET, title: TITLE, body: BODY, status, labels: [], project: 'livre-or', createdAt: ago(30), updatedAt: ago(1),
  services: [{ name: SERVICE, branch: 'cleared/local-7', pr, state: 'open' }],
});
const otherTicket = { id: OTHER, title: 'Renommer le bouton d\'envoi', body: '', status: 'In Progress', labels: [], project: 'livre-or', createdAt: ago(4), updatedAt: ago(3), services: [{ name: SERVICE, branch: null, pr: null, state: 'open' }] };

const workspace = { id: 'livre-or', name: 'livre-or', services: [{ name: SERVICE, kind: 'repository', repo: 'exemple-org/exemple-livre-or', url: 'https://github.com/exemple-org/exemple-livre-or.git', base: 'main', path: null, healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null }] };

let seq = 0;
const event = (session: string, minutes: number, body: unknown) => ({ seq: ++seq, at: ago(minutes), sessionId: session, ticket: TICKET, event: body });
const custom = (session: string, minutes: number, name: string, value: unknown) => event(session, minutes, { type: 'CUSTOM', name, value });
const tool = (session: string, minutes: number, id: string, name: string, input: unknown, output?: unknown) => [
  event(session, minutes, { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name }),
  event(session, minutes, { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(input) }),
  ...(output === undefined ? [] : [event(session, minutes, { type: 'TOOL_CALL_RESULT', toolCallId: id, content: JSON.stringify(output) })]),
];
const text = (session: string, minutes: number, id: string, message: string) => [
  event(session, minutes, { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }),
  event(session, minutes, { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: message }),
];
const USAGE = { inputTokens: 28_400, outputTokens: 7_100 };
const state = (phase: string, status: string, checks: unknown[] = []) => ({
  status, phase, files: [{ path: 'web/Message.tsx', added: 14, removed: 2 }, { path: 'web/Message.test.tsx', added: 22, removed: 0 }], checks, usage: USAGE,
  steps: [{ name: 'workspace', startedAt: ago(28), finishedAt: ago(27) }, { name: 'plan_gate', startedAt: ago(26), finishedAt: ago(24) }, { name: 'author', startedAt: ago(24), finishedAt: null }],
});
const CHECKS = [{ name: 'git status', state: 'passed' }, { name: 'git diff', state: 'passed' }, { name: 'git log -3', state: 'passed' }, { name: 'npm test', state: 'pending' }];

// What the author did up to the moment of each state.
const authorStory = (session: string) => [
  event(session, 28, { type: 'STEP_STARTED', stepName: 'workspace' }),
  event(session, 27, { type: 'STEP_FINISHED', stepName: 'workspace' }),
  event(session, 27, { type: 'RUN_STARTED', threadId: session, runId: 'r1' }),
  ...tool(session, 27, 'c1', 'Read', { kind: 'read', path: 'web/Message.tsx' }, { kind: 'read', path: 'web/Message.tsx', bytes: 900 }),
  ...tool(session, 27, 'c2', 'Read', { kind: 'read', path: 'web/Message.test.tsx' }, { kind: 'read', path: 'web/Message.test.tsx', bytes: 600 }),
  custom(session, 26, 'cleared.session_plan', { ...PLAN, go: null }),
  custom(session, 24, 'cleared.session_plan', { ...PLAN, go: GO }),
  ...tool(session, 22, 'c3', 'Edit', { kind: 'edit', path: 'web/Message.tsx', added: 14, removed: 2 }, { kind: 'edit', ok: true }),
  ...text(session, 20, 'm1', 'La date est ajoutée au message. Je passe au format selon la langue de la page.'),
  ...tool(session, 16, 'c4', 'Edit', { kind: 'edit', path: 'web/Message.test.tsx', added: 22, removed: 0 }, { kind: 'edit', ok: true }),
  custom(session, 12, 'cleared.permission_answered', { requestId: 'd1', decision: 'reject_once', by: 'policy', rule: 'host.docker' }),
  ...tool(session, 9, 'c5', 'Bash', { kind: 'execute', command: 'git status' }, { kind: 'execute', output: 'Sur la branche cleared/local-7', cut: 0, isError: false }),
];

type Story = {
  readonly sessions: readonly unknown[];
  readonly details: Readonly<Record<string, unknown>>;
  readonly events: Readonly<Record<string, readonly unknown[]>>;
  readonly ticket: unknown;
  readonly inbox: readonly unknown[];
  readonly cost?: unknown;
  readonly production?: readonly unknown[];
};

const running = (): Story => {
  const s = summary(AUTHOR, 'author', 'working', 'Running npm test', 28, 0, 40);
  return {
    sessions: [s, elsewhere], details: { [AUTHOR]: { ...s, state: state('working', 'Running npm test', CHECKS) } }, ticket: ticket('In Progress', null), inbox: [elsewherePlan],
    events: { [AUTHOR]: [event(AUTHOR, 28, { type: 'STATE_SNAPSHOT', snapshot: state('working', 'Running npm test', CHECKS) }), ...authorStory(AUTHOR), ...tool(AUTHOR, 0.2, 'c6', 'Bash', { kind: 'execute', command: 'npm test' })] },
  };
};

const permission = (): Story => {
  const s = summary(AUTHOR, 'author', 'waiting_human', 'Waiting for your answer', 28, 1, 40);
  const command = 'npm install date-fns && npm test';
  const request = { requestId: 'r1', toolCallId: 'c6', tool: 'Bash', input: { kind: 'execute', command, description: 'Installer la bibliothèque de dates' }, suggestion: { decision: 'ask', rule: 'install.package', reason: 'installing a package needs a person' } };
  return {
    sessions: [s, elsewhere], details: { [AUTHOR]: { ...s, state: state('waiting_human', 'Waiting for your answer', CHECKS) } }, ticket: ticket('In Progress', null),
    inbox: [{ id: `permission:${AUTHOR}:r1`, kind: 'permission', ticket: TICKET, project: 'livre-or', state: 'waiting', since: ago(1), sessionId: AUTHOR, requestId: 'r1', tool: 'Bash', input: request.input, suggestion: request.suggestion }, elsewherePlan],
    events: { [AUTHOR]: [event(AUTHOR, 28, { type: 'STATE_SNAPSHOT', snapshot: state('waiting_human', 'Waiting for your answer', CHECKS) }), ...authorStory(AUTHOR), ...tool(AUTHOR, 1, 'c6', 'Bash', request.input), custom(AUTHOR, 1, 'cleared.permission_request', request)] },
  };
};

const RELEASE = {
  id: `release:${TICKET}:12`, kind: 'release', ticket: TICKET, project: 'livre-or', state: 'waiting', since: ago(2), title: TITLE, announcement: 'Chaque message montre sa date.',
  pr: { number: 12, url: 'https://github.com/exemple-org/exemple-livre-or/pull/12', checks: 'passed' }, heads: [{ pr: 12, head: '4f2a9c1e7b3d' }], requestedAt: ago(2),
  captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 22 }, { role: 'reviewer', model: 'claude-sonnet-5-5', minutes: 4 }],
};
const reviewed = (status: string, phase: string): { sessions: unknown[]; details: Record<string, unknown>; events: Record<string, unknown[]> } => {
  const author = summary(AUTHOR, 'author', 'done', 'Done', 28, 6, 40);
  const reviewer = summary(REVIEWER, 'reviewer', phase, 'Done', 6, 2, 12, 'claude-sonnet-5-5');
  const passed = [{ name: 'git status', state: 'passed' }, { name: 'git diff', state: 'passed' }, { name: 'npm test', state: 'passed' }];
  return {
    sessions: [author, reviewer, elsewhere],
    details: { [AUTHOR]: { ...author, state: state('done', 'Done', passed) }, [REVIEWER]: { ...reviewer, state: state(phase, status, passed) } },
    events: {
      [AUTHOR]: [event(AUTHOR, 28, { type: 'STATE_SNAPSHOT', snapshot: state('done', 'Done', passed) }), ...authorStory(AUTHOR), ...tool(AUTHOR, 7, 'c6', 'Bash', { kind: 'execute', command: 'npm test' }, { kind: 'execute', output: '# pass 42\n# fail 0', cut: 0, isError: false }), event(AUTHOR, 6, { type: 'RUN_FINISHED', threadId: AUTHOR, runId: 'r1', outcome: { type: 'success' } })],
      [REVIEWER]: [event(REVIEWER, 6, { type: 'STATE_SNAPSHOT', snapshot: state(phase, status, passed) }), ...tool(REVIEWER, 5, 'v1', 'Bash', { kind: 'execute', command: 'git diff main' }, { kind: 'execute', output: '2 fichiers modifiés', cut: 0, isError: false }), custom(REVIEWER, 2, 'cleared.review_verdict', { verdict: 'pass', round: 1 })],
    },
  };
};

const review = (): Story => ({ ...reviewed('Done', 'done'), ticket: ticket('Needs Approval', 12), inbox: [RELEASE, elsewherePlan] });

const done = (): Story => {
  const base = reviewed('Done', 'done');
  base.events[REVIEWER]?.push(custom(REVIEWER, 2, 'cleared.proof_captured', { service: SERVICE, before: 'before.png', after: 'after.png', missing: [] }));
  return {
    ...base, ticket: ticket('Done', 12), inbox: [elsewherePlan],
    cost: { ticket: TICKET, sessions: 2, turns: 3, tokens: 48_200, workMs: 26 * 60_000, elapsedMs: 31 * 60_000, costUsd: 0.84 },
    production: [{ service: SERVICE, pr: 12, url: 'https://example.com/', at: ago(1), file: 'production.png', missing: null }],
  };
};

const failed = (): Story => {
  const s = summary(AUTHOR, 'author', 'failed', 'Failed', 28, 3, 40);
  return {
    sessions: [s, elsewhere], details: { [AUTHOR]: { ...s, state: state('failed', 'Failed', CHECKS) } }, ticket: ticket('Todo', null), inbox: [elsewherePlan],
    events: { [AUTHOR]: [event(AUTHOR, 28, { type: 'STATE_SNAPSHOT', snapshot: state('failed', 'Failed', CHECKS) }), ...authorStory(AUTHOR), event(AUTHOR, 3, { type: 'RUN_ERROR', message: 'container exited', code: 'container_failed' })] },
  };
};

const planWaits = (): Story => {
  const s = summary(AUTHOR, 'author', 'waiting_human', 'Waiting for the Go', 6, 1, 8);
  const snapshot = { ...state('waiting_human', 'Waiting for the Go'), files: [] };
  return {
    sessions: [s, elsewhere], details: { [AUTHOR]: { ...s, state: snapshot } }, ticket: ticket('In Progress', null), inbox: [{ id: `session_plan:${AUTHOR}:1`, kind: 'session_plan', ticket: TICKET, project: 'livre-or', state: 'waiting', since: ago(1), sessionId: AUTHOR, service: SERVICE, plan: { ...PLAN, go: null } }, elsewherePlan],
    events: { [AUTHOR]: [event(AUTHOR, 6, { type: 'STATE_SNAPSHOT', snapshot }), ...tool(AUTHOR, 5, 'c1', 'Read', { kind: 'read', path: 'web/Message.tsx' }, { kind: 'read', path: 'web/Message.tsx', bytes: 900 }), custom(AUTHOR, 1, 'cleared.session_plan', { ...PLAN, go: null })] },
  };
};

const question = (): Story => {
  const s = summary(AUTHOR, 'author', 'waiting_human', 'Waiting for your answer', 28, 1, 40);
  const asked = { requestId: 'q1', questions: [{ question: 'Quel format de date préférez-vous ?', header: 'Format', multiSelect: false, options: [{ label: '31 octobre 2026 (Recommended)', description: 'Le mois en toutes lettres.' }, { label: '31/10/2026', description: 'Plus court.' }] }] };
  return {
    sessions: [s, elsewhere], details: { [AUTHOR]: { ...s, state: state('waiting_human', 'Waiting for your answer', CHECKS) } }, ticket: ticket('In Progress', null), inbox: [elsewherePlan],
    events: { [AUTHOR]: [event(AUTHOR, 28, { type: 'STATE_SNAPSHOT', snapshot: state('waiting_human', 'Waiting for your answer', CHECKS) }), ...authorStory(AUTHOR), custom(AUTHOR, 1, 'cleared.question', asked)] },
  };
};

type Stub = { readonly status?: number; readonly body: unknown };
const json = (route: any, { status = 200, body }: Stub) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stories(page: any, story: Story) {
  await page.route('**/api/service/**', (route: any) => json(route, { status: 404, body: { error: 'unknown' } }));
  await page.route('**/api/service/inbox**', (route: any) => json(route, { body: story.inbox }));
  await page.route('**/api/service/workspace', (route: any) => json(route, { body: workspace }));
  await page.route('**/api/service/tickets', (route: any) => json(route, { body: [story.ticket, otherTicket] }));
  await page.route('**/api/service/sessions', (route: any) => json(route, { body: story.sessions }));
  await page.route(`**/api/service/tickets/${TICKET}`, (route: any) => json(route, { body: story.ticket }));
  await page.route(`**/api/service/tickets/${TICKET}/steps`, (route: any) => json(route, { body: [] }));
  await page.route(`**/api/service/tickets/${TICKET}/captures`, (route: any) => json(route, { body: { choice: 'auto', by: null, at: null } }));
  await page.route(`**/api/service/tickets/${TICKET}/cost`, (route: any) => json(route, story.cost ? { body: story.cost } : { body: { ticket: TICKET, sessions: 1, turns: 1, tokens: 35_500, workMs: 22 * 60_000, elapsedMs: 28 * 60_000, costUsd: 0.42 } }));
  await page.route(`**/api/service/tickets/${TICKET}/production`, (route: any) => json(route, { body: story.production ?? [] }));
  for (const [id, detail] of Object.entries(story.details)) {
    await page.route(`**/api/service/sessions/${id}`, (route: any) => json(route, { body: detail }));
    const once = new Set<string>();
    await page.route(`**/api/service/sessions/${id}/events**`, (route: any) => {
      const first = !once.has('events');
      once.add('events');
      const frames = first ? (story.events[id] ?? []).map((one: any) => `id: ${one.seq}\nevent: ${one.event.type}\ndata: ${JSON.stringify(one)}\n\n`).join('') : '';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames });
    });
  }
}

async function shot(page: any, name: string, frame: 'desktop' | 'mobile') {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(folder, `${name}-${frame}.png`), fullPage: true, animations: 'disabled' });
  if (process.env.SESSION_SNAPSHOTS && frame === 'desktop') await snapshot(page, name);
}

// The screen as a page of its own, its sheets inline and no script, for sloplint's render tier.
async function snapshot(page: any, name: string) {
  const dir = process.env.SESSION_SNAPSHOTS as string;
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

// axe on the screen with its folds open: nothing may fail, in the fold or out of it.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const problems: string[] = [];
async function accessible(page: any, what: string) {
  await page.evaluate(() => { document.querySelectorAll('details').forEach((fold: any) => { fold.open = true; }); });
  await page.waitForTimeout(100);
  await page.evaluate(axeSource);
  const found: string[] = await page.evaluate(async (tags: string[]) => {
    // As the app's own accessibility test runs it (app/test/a11y-browser.test.ts): the named controls keep their longer name.
    const LABEL = 'label-content-name-mismatch';
    const axe = (window as any).axe;
    const rules = axe.getRules(tags).filter((r: { ruleId: string; tags: string[] }) => r.ruleId !== LABEL && !r.tags.some((tag) => tag === 'experimental' || tag === 'deprecated')).map((r: { ruleId: string }) => r.ruleId);
    const named = ['#palette-open', '#person', 'a.need.row', 'a.open.row', 'a.open.index-row'];
    const all = await axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'rule', values: rules } });
    const label = await axe.run({ include: [document], exclude: named.map((selector) => [selector]) }, { resultTypes: ['violations'], runOnly: { type: 'rule', values: [LABEL] } });
    return [...all.violations, ...label.violations].map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
  for (const problem of found) problems.push(`${what}: ${problem}`);
}

const FRAMES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

const SCENES: readonly { readonly name: string; readonly story: () => Story; readonly opens: string }[] = [
  { name: 'running', story: running, opens: AUTHOR },
  { name: 'waiting-permission', story: permission, opens: AUTHOR },
  { name: 'waiting-review', story: review, opens: REVIEWER },
  { name: 'done-pr', story: done, opens: REVIEWER },
  { name: 'failed', story: failed, opens: AUTHOR },
  ...(process.env.SESSION_EXTRA ? [{ name: 'waiting-go', story: planWaits, opens: AUTHOR }, { name: 'waiting-question', story: question, opens: AUTHOR }] : []),
];

const stateDir = mkdtempSync(join(tmpdir(), 'cleared-v2-j7-session-'));
const port = await pickPort();
const env = { ...process.env, CLEARED_STATE_DIR: stateDir, CLEARED_V2_APP_SOURCE: 'fixtures', CLEARED_V2_APP_PORT: String(port), CLEARED_V2_APP_LANGUAGE: 'fr' };
const adding = spawn(process.execPath, ['src/cli/user.ts', 'add', USER], { env, stdio: ['pipe', 'ignore', 'inherit'] });
adding.stdin.end(`${PHRASE}\n${PHRASE}\n`);
await new Promise((done_) => adding.once('exit', done_));
const app = spawn(process.execPath, ['app/main.ts'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const origin = `http://127.0.0.1:${port}`;
try {
  for (let tries = 0; ; tries += 1) {
    const up = await fetch(`${origin}/login`).then((r) => r.ok, () => false);
    if (up) break;
    if (tries > 100) throw new Error('the app did not start');
    await new Promise((done_) => setTimeout(done_, 100));
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
      await stories(page, scene.story());
      await page.goto(`${origin}/sessions/${scene.opens}`);
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
      await shot(page, scene.name, frame);
      if (process.env.SESSION_LOOK) {
        await page.evaluate(() => { document.querySelectorAll('details').forEach((fold: any) => { fold.open = true; }); });
        await page.waitForTimeout(150);
        await page.screenshot({ path: join(folder, `${scene.name}-${frame}-open.png`), fullPage: true, animations: 'disabled' });
        if (process.env.SESSION_SNAPSHOTS && frame === 'desktop') await snapshot(page, `${scene.name}-open`);
      }
      await accessible(page, `${scene.name} ${frame}`);
      for (const error of errors) problems.push(`${scene.name} ${frame}: page error: ${error}`);
      await page.close();
    }
    await context.close();
  }
  await browser.close();
  console.log(problems.length === 0 ? 'axe: no violation on any state, at 1440 and 390' : `problems:\n${problems.join('\n')}`);
  if (problems.length > 0) process.exitCode = 1;
} finally {
  app.kill();
  rmSync(stateDir, { recursive: true, force: true });
}
