// The onboarding lane's captures (docs/v2/onboarding/, issue #497): every step
// of the setup assistant, Reception, the Tour and a session, at 1440x900 and
// 390x844, in French, on the app's fixture source and with made-up answers for
// the setup routes, so each screen shows the state the owner reported. No
// Docker, no service, no real data; the app listens on loopback for the run.
//
//   node scripts/onboarding-captures.ts <folder> [port]
//
// It starts the built app (npm run build first) on a port of 9800 to 9899 that
// is free, signs in a made-up user, draws each screen and closes all of it.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };

const folder = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node scripts/onboarding-captures.ts <folder> [port]');
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
const DAY = 24 * 60;

const step = (id: string, state: string, personMs = 0, machineMs = 0) => ({
  id, state, filled: true, skippable: !['owner', 'forge', 'model'].includes(id),
  shownAt: state === 'todo' ? null : ago(5 * DAY), doneAt: state === 'done' ? ago(10) : null, skippedAt: null, personMs, machineMs,
});
const STEP_IDS = ['owner', 'forge', 'model', 'workspace', 'environment', 'secrets', 'checks', 'first-ticket'];
// The state the owner saw: the forge "done" four days and five hours after it was first shown.
const setupView = (current: string) => {
  const reached = STEP_IDS.indexOf(current);
  return {
    owner: USER, current, total: { personMs: 0, machineMs: 0 },
    steps: STEP_IDS.map((id, index) => step(id, index < reached ? 'done' : 'todo', id === 'forge' ? (4 * DAY + 5 * 60) * 60_000 : 90_000, 0)),
  };
};

const REPO = 'exemple-org/cleared-example-guestbook';
const SERVICE = 'cleared-example-guestbook';
const SET = { set: true, at: ago(5 * DAY), source: 'assistant' };

const environment = {
  workspace: true, sessions: 'ready',
  services: [{
    name: SERVICE, readable: true, devcontainer: 'none', foreignImage: null, install: null, state: 'ready',
    image: 'cleared-v2-prep-cleared-example-guestbook:12ef7e8f', builtAt: ago(4), buildMs: 41_000, startedAt: null, error: null,
    checkCommand: 'npm test',
    check: { command: 'npm test', passed: false, at: ago(4), ms: 900, tail: 'sh: 1: vitest: not found\nnpm error Lifecycle script `test` failed' },
    proposal: 'check_failed', setupTicket: null,
  }],
};

const testValues = { workspace: true, key: 'none', services: [{ name: SERVICE, inWorkspace: true, values: [] }] };
const expected = { services: [{ service: SERVICE, names: [{ name: 'STRIPE_TEST_KEY', from: '.env.example' }, { name: 'MAILER_SANDBOX_TOKEN', from: 'test/mail.test.ts' }] }] };

const doctorLine = (id: string, level: string, text: string, todo?: string) => ({ id, level, text, ...(todo ? { todo } : {}) });
const checks = {
  failed: 0, tookMs: 2300,
  lines: [
    doctorLine('docker', 'ok', 'Le démon Docker répond (29.1).'),
    doctorLine('image', 'ok', 'L\'image cleared-v2-session:2.1.306 est présente.'),
    doctorLine('egress', 'ok', 'L\'image cleared-v2-egress:1 est présente.'),
    doctorLine('label', 'ok', 'Chaque objet Docker créé porte le libellé cleared.dev=v2.'),
    doctorLine('socket', 'ok', 'Le socket Docker est lisible par le service.'),
    doctorLine('networks', 'ok', 'Le réseau d\'une session n\'atteint que le proxy de sortie.'),
    doctorLine('workspace', 'ok', 'L\'espace de travail se lit : 1 service.'),
    doctorLine('forge', 'ok', 'GitHub accepte le jeton.'),
    doctorLine('model', 'ok', 'Le jeton Claude Code est présent.'),
    doctorLine('key', 'ok', 'La signature d\'approbation est présente.'),
    doctorLine('disk', 'ok', 'Il reste 212 Go sur le disque du dossier d\'état.'),
    doctorLine('ports', 'ok', 'Aucun port réservé n\'est écouté par Cleared.'),
    doctorLine('leftovers', 'notice', '3 conteneurs de tests précédents portent le libellé cleared.dev=v2 sans session connue.'),
    doctorLine('secrets', 'off', 'Aucun secret de test : non vérifié.'),
  ],
};

const firstTicket = (stage: string) => ({
  ready: true, services: [SERVICE],
  proposal: { title: 'Dire que ce projet passe par Cleared', body: 'Ajouter une ligne à la fin du README.md.\n\nRien d\'autre ne change.' },
  ticket: stage === 'none' ? null : { id: 'LOCAL-2', title: 'Dire que ce projet passe par Cleared', service: SERVICE, stage, createdAt: ago(3), rolledBack: false },
});

// What the owner saw in Reception: a request of the setup session (LOCAL-1) next to the plan of another (LOCAL-2).
const inboxBase = { project: 'guestbook', state: 'waiting' };
const SETUP_SESSION = 'session-setup-1';
const PLAN_SESSION = 'session-ticket-2';
const inbox = [
  {
    ...inboxBase, kind: 'permission', id: `permission:${SETUP_SESSION}:r1`, ticket: 'LOCAL-1', since: ago(9), sessionId: SETUP_SESSION, requestId: 'r1', tool: 'Bash',
    input: { kind: 'execute', command: 'ls -la && node --version && which npm', description: 'Voir ce que le dépôt attend pour installer ses dépendances' },
    suggestion: { decision: 'ask', rule: 'shell.compound', reason: 'node --version is not a command the policy allows on its own' },
  },
  {
    ...inboxBase, kind: 'session_plan', id: `session_plan:${PLAN_SESSION}:1`, ticket: 'LOCAL-2', since: ago(2), sessionId: PLAN_SESSION, service: SERVICE,
    plan: { steps: ['Ajouter une ligne à la fin du README.md'], files: ['README.md'], confidence: 'high', reason: 'Le fichier existe à la racine.', proposedAt: ago(2), go: null },
  },
];
const reviewing = (): readonly unknown[] => [{ ...sessionsOf()[1], phase: 'reviewing', status: 'Reading the diff' }];
const sessionsOf = (setupPhase = 'waiting_human') => [
  { id: SETUP_SESSION, project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: setupPhase, status: 'Waiting for your answer', startedAt: ago(12), updatedAt: ago(9), lastSeq: 40, service: SERVICE },
  { id: PLAN_SESSION, project: 'guestbook', ticket: 'LOCAL-2', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'waiting_human', status: 'Waiting for the Go', startedAt: ago(3), updatedAt: ago(2), lastSeq: 12, service: SERVICE },
];
const ticketsOf = () => [
  { id: 'LOCAL-1', title: `Préparer l'environnement du service ${SERVICE}`, body: '', status: 'In Progress', labels: ['environment'], project: 'guestbook', services: [{ name: SERVICE, branch: null, pr: null, state: 'open' }], createdAt: ago(12), updatedAt: ago(9) },
  { id: 'LOCAL-2', title: 'Dire que ce projet passe par Cleared', body: '', status: 'In Progress', labels: [], project: 'guestbook', services: [{ name: SERVICE, branch: null, pr: null, state: 'open' }], createdAt: ago(3), updatedAt: ago(2) },
];


// The session the owner found hard to read: a setup session with a ticket in
// Markdown, three commands that read the same way, a refusal and a request.
const MARKDOWN = "## Quoi écrire\n\nLe fichier qui décrit l'environnement du service, pour que ses tests tournent.\n\n## Comment vérifier\n\n- `npm test` passe dans l'image\n- La **relecture** voit le résultat\n\nDétails : [la documentation](https://example.com/docs).";
const CHECKS = [{ name: 'git status', state: 'passed' }, { name: 'git log -3', state: 'passed' }, { name: 'git diff', state: 'pending' }, { name: 'npm test', state: 'failed' }];
const SESSION_STATE = {
  status: 'En attente de votre réponse', phase: 'waiting_human', files: [{ path: '.devcontainer/devcontainer.json', added: 12, removed: 0 }], checks: CHECKS, usage: { inputTokens: 1200, outputTokens: 300 },
  steps: [{ name: 'workspace', startedAt: ago(12), finishedAt: ago(11) }, { name: 'author', startedAt: ago(11), finishedAt: null }],
};
const stored = (seq: number, minutes: number, event: unknown) => ({ seq, at: ago(minutes), sessionId: SETUP_SESSION, ticket: 'LOCAL-1', event });
const STORY = [
  stored(1, 12, { type: 'STATE_SNAPSHOT', snapshot: SESSION_STATE }),
  stored(2, 11, { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'Read' }),
  stored(3, 11, { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: JSON.stringify({ kind: 'read', path: 'package.json' }) }),
  stored(4, 10, { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'd1', decision: 'reject_once', by: 'policy', rule: 'host.docker' } }),
  stored(5, 9, { type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId: 'r1', toolCallId: 'c2', tool: 'Bash', input: { kind: 'execute', command: 'ls -la && node --version && which npm', description: 'Voir ce que le dépôt attend pour installer ses dépendances' }, suggestion: { decision: 'ask', rule: 'shell.compound', reason: 'node --version is not a command the policy allows on its own' } } }),
];
function sessionScene(page: any) {
  const detail = { ...sessionsOf()[0], state: SESSION_STATE };
  const answered = new Set<string>();
  return Promise.all([
    page.route('**/api/service/sessions', (route: any) => json(route, { body: sessionsOf() })),
    page.route(`**/api/service/sessions/${SETUP_SESSION}`, (route: any) => json(route, { body: detail })),
    page.route(`**/api/service/sessions/${SETUP_SESSION}/events**`, (route: any) => {
      const first = !answered.has('events');
      answered.add('events');
      const frames = first ? STORY.map((event) => `id: ${event.seq}\nevent: ${(event.event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('') : '';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames });
    }),
    page.route('**/api/service/tickets/LOCAL-1', (route: any) => json(route, { body: { ...ticketsOf()[0], body: MARKDOWN } })),
    page.route('**/api/service/tickets/LOCAL-1/**', (route: any) => json(route, { status: 404, body: { error: 'unknown' } })),
    page.route('**/api/service/inbox**', (route: any) => json(route, { body: inbox })),
  ]);
}

type Stub = { readonly status?: number; readonly body: unknown };
const json = (route: any, { status = 200, body }: Stub) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// The setup routes' answers for a screen of the assistant at `current`.
async function setupRoutes(page: any, current: string, tweak: Record<string, unknown> = {}) {
  // No session waits, unless the scene says one does (its later route wins).
  await page.route('**/api/service/inbox**', (route: any) => json(route, { body: [] }));
  await page.route('**/api/service/sessions', (route: any) => json(route, { body: [] }));
  return page.route('**/api/service/setup**', (route: any) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/service/setup', '');
    const post = route.request().method() === 'POST';
    if (path in tweak) return json(route, { body: tweak[path] });
    if (path === '' || path.endsWith('/shown') || path.endsWith('/skip')) return json(route, { body: setupView(current) });
    if (path === '/owner') return json(route, { body: { name: USER, publicKey: 'ed25519-made-up-public-half', setting: 'human_public_key' } });
    if (path === '/forge') return json(route, { body: { credential: SET, rights: [], gitlab: { credential: { set: false }, address: 'https://gitlab.com' } } });
    if (path === '/model') return json(route, { body: { credential: { set: false }, terminal: true } });
    if (path === '/workspace' && !post) return json(route, { body: { source: 'assistant', connected: null, problem: null, archived: 0, repositories: [{ repo: REPO, private: false }, { repo: 'exemple-org/autre-depot', private: true }] } });
    if (path === '/workspace/propose') return json(route, { body: { machineMs: 0, repositories: [{ repo: REPO, folders: [], from: null }], services: [{ name: SERVICE, repo: REPO, path: null, contract: null }], links: [] } });
    if (path === '/environment') return json(route, { body: environment });
    if (path === '/environment/session') return json(route, { body: { ticket: 'LOCAL-1', created: true } });
    if (path === '/secrets') return json(route, { body: testValues });
    if (path === '/secrets/expected') return json(route, { body: expected });
    if (path === '/checks') return json(route, { body: checks });
    if (path === '/first-ticket') return json(route, { body: firstTicket('working') });
    return json(route, { status: 404, body: { error: 'other' } });
  });
}

function reception(page: any) {
  return Promise.all([
    page.route('**/api/service/inbox**', (route: any) => json(route, { body: inbox })),
    page.route('**/api/service/sessions', (route: any) => json(route, { body: sessionsOf() })),
    page.route('**/api/service/tickets', (route: any) => (route.request().method() === 'GET' ? json(route, { body: ticketsOf() }) : route.fallback())),
    page.route('**/api/service/plans/**', (route: any) => json(route, { status: 404, body: { error: 'unknown' } })),
  ]);
}

async function shot(page: any, name: string, frame: 'desktop' | 'mobile') {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(folder, `${name}-${frame}.png`), fullPage: true, animations: 'disabled' });
  if (process.env.ONBOARDING_SNAPSHOTS && frame === 'desktop') await snapshot(page, name);
}

// The screen as a page of its own, its sheets inline and no script, for
// sloplint's render tier (ONBOARDING_SNAPSHOTS names the folder).
async function snapshot(page: any, name: string) {
  const dir = process.env.ONBOARDING_SNAPSHOTS as string;
  mkdirSync(dir, { recursive: true });
  const markup: string = await page.evaluate(async () => {
    const sheets = await Promise.all([...document.querySelectorAll('link[rel="stylesheet"]')].map(async (link: any) => (await fetch(link.href)).text()));
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"]').forEach((node) => node.remove());
    const style = document.createElement('style');
    style.textContent = sheets.join('\n');
    clone.querySelector('head')?.prepend(style);
    return `<!doctype html>${clone.outerHTML}`;
  });
  // The bundle has no comment left: the stamp of the app's sheet first, as sloplint reads it.
  const stamp = /^\/\* Hallmark[^]*?(?=\n\n|\n[^/ ])/.exec(readFileSync('app/web/styles/app.css', 'utf8'))?.[0] ?? '';
  writeFileSync(join(dir, `${name}.html`), markup.replace('<style>', `<style>${stamp}\n`).replaceAll('/fonts/', `file://${resolve('app/public/fonts')}/`));
}

// axe on the screen with its folds open: nothing may fail, in the fold or out of it.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const problems: string[] = [];
async function accessible(page: any, what: string) {
  await page.evaluate(() => { document.querySelectorAll('details').forEach((fold: any) => { fold.open = true; }); });
  await page.evaluate(axeSource);
  const found: string[] = await page.evaluate(async (tags: string[]) => {
    // The shell's named controls and the Tour's rows carry the longer name the app's own accessibility test allows them (app/test/a11y-browser.test.ts).
    const result = await (window as any).axe.run({ include: [document], exclude: [['#palette-open'], ['#person'], ['.tower a'], ['#screen a[data-kind]'], ['#screen a[aria-labelledby]'], ['#screen a[href*="inbox#"]'], ['#screen a[href*="plan"]']] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: tags } });
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
  for (const problem of found) problems.push(`${what}: ${problem}`);
}

const FRAMES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

type Scene = {
  readonly name: string;
  readonly path: string;
  readonly current?: string;
  readonly tweak?: Record<string, unknown>;
  readonly reception?: boolean;
  readonly prepare?: (page: any) => Promise<unknown>;
  readonly act?: (page: any) => Promise<unknown>;
};

const SCENES: readonly Scene[] = [
  { name: 'owner', path: '/setup/owner', current: 'forge' },
  { name: 'forge', path: '/setup/forge', current: 'model' },
  { name: 'model', path: '/setup/model', current: 'model' },
  {
    name: 'workspace', path: '/setup/workspace', current: 'workspace',
    act: async (page) => {
      await page.locator('input[type=checkbox]').first().check();
      await page.locator('[data-act=setup_workspace_propose]').click();
      await page.locator('[data-workspace-proposal]').waitFor();
    },
  },
  { name: 'environment', path: '/setup/environment', current: 'environment' },
  {
    name: 'environment-session', path: '/setup/environment', current: 'environment', reception: true,
    prepare: (page) => page.route('**/api/service/inbox**', (route: any) => json(route, { body: inbox.slice(0, 1) })),
    tweak: { '/environment': { ...environment, services: [{ ...environment.services[0], proposal: null, setupTicket: 'LOCAL-1' }] } },
  },
  { name: 'secrets', path: '/setup/secrets', current: 'secrets' },
  { name: 'checks', path: '/setup/checks', current: 'checks' },
  {
    name: 'first-ticket', path: '/setup/first-ticket', current: 'first-ticket',
    tweak: { '/first-ticket': { ...firstTicket('review'), ticket: { ...firstTicket('review').ticket, pullRequest: { number: 12, url: 'https://example.com/pull/12' } } } },
    prepare: (page) => Promise.all([
      page.route('**/api/service/sessions', (route: any) => json(route, { body: reviewing() })),
      page.route(`**/api/service/sessions/${PLAN_SESSION}/events**`, (route: any) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `id: 1\nevent: TOOL_CALL_START\ndata: ${JSON.stringify({ seq: 1, at: ago(1), sessionId: PLAN_SESSION, ticket: 'LOCAL-2', event: { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'Read' } })}\n\nid: 2\nevent: TOOL_CALL_ARGS\ndata: ${JSON.stringify({ seq: 2, at: ago(1), sessionId: PLAN_SESSION, ticket: 'LOCAL-2', event: { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: JSON.stringify({ kind: 'read', path: '/workspace/README.md' }) } })}\n\n` })),
    ]),
  },
  { name: 'reception', path: '/inbox', reception: true },
  { name: 'tour', path: '/' },
  {
    name: 'tour-service-refused', path: '/',
    prepare: (page) => page.route('**/api/service/**', (route: any) => json(route, { status: 503, body: { error: process.env.ONBOARDING_REFUSAL ?? 'service_starting' } })),
  },
  { name: 'session', path: `/sessions/${SETUP_SESSION}`, prepare: sessionScene },
];

const state = mkdtempSync(join(tmpdir(), 'cleared-v2-j7-'));
const port = await pickPort();
const env = { ...process.env, CLEARED_STATE_DIR: state, CLEARED_V2_APP_SOURCE: 'fixtures', CLEARED_V2_APP_PORT: String(port), CLEARED_V2_APP_LANGUAGE: 'fr' };
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
      if (scene.current) await setupRoutes(page, scene.current, scene.tweak);
      if (scene.reception) await reception(page);
      await scene.prepare?.(page);
      await page.goto(`${origin}${scene.path}`);
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
      await scene.act?.(page);
      await shot(page, scene.name, frame);
      await accessible(page, `${scene.name} ${frame}`);
      await page.close();
    }
    await context.close();
  }
  await browser.close();
  console.log(problems.length === 0 ? 'axe: no violation on any screen, at 1440 and 390' : `axe:\n${problems.join('\n')}`);
  if (problems.length > 0) process.exitCode = 1;
} finally {
  app.kill();
  rmSync(state, { recursive: true, force: true });
}
