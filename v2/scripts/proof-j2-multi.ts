// The multi-service proof of milestone 2 (docs/v2/milestone-2-plan.md,
// section 2.2, lane 29), driven through the browser only, as the owner
// would, on a workspace of two services: the guestbook, which consumes, and
// the filter API, which provides. Its steps:
//    1 create the first ticket from the tower bar, naming both services;
//    2 see it split into steps (the contract, one per service, the integration);
//    3 validate the contract's diff in the inbox;
//    4 see the two service steps run, and the guestbook's Browser tab show the
//      trial environment, where the filter API is a fake of the validated contract;
//    5 see the integration step end;
//    6 approve the one release card: two pull requests in landing order;
//    7 see the train land in order, each service healthy, the ticket Done;
//    8 create the second ticket, whose guestbook change breaks /health, and approve it;
//    9 see the rollback in reverse order: "Rolled back, 2 of 2", the ticket in Todo;
//   10 create the third ticket, a contract change without the guestbook: the
//      card is blocked before approval with the proposal, and has no Approve;
//   11 create the fourth ticket, on the guestbook alone; Take over its working
//      session (the web terminal opens on its harness, pull request 230), open
//      the Shell and type git status, npm ci and npm test, each after the
//      one before has answered (proof-terminal.ts), change one line in the
//      Editor tab and save it, Give back; see the session's next turn begin
//      with the notice, and the change in the ticket's diff.
// Every session proposes its session plan first (decision 22): the proof
// gives each one of its tickets its Go from the inbox, as the owner would.
// The times come from the app's routes, as the screens read them, and from
// the ledger, read only, when it is given.
//
//   node scripts/proof-j2-multi.ts                       the real run, against the running app
//   PROOF_REHEARSAL=1 node scripts/proof-j2-multi.ts     the rehearsal: scripts/proof-rehearsal-multi.ts
//                                                        starts a service and an app of its own on the
//                                                        fake adapter, in a temporary folder
//
// Settings, from the environment:
//   PROOF_APP_URL          the app on its loopback address, which the web terminal needs
//                          (decision 32; default http://127.0.0.1:8792); the rehearsal's own otherwise
//   PROOF_OWNER            the app user (default owner): the single owner account takes over
//   PROOF_PASSWORD_FILE    a file holding the password; it is read, never printed
//   PROOF_LEDGER           ledger.db of the service, read only (optional: the trains' times,
//                          step 11's journal, the session plans)
//   PROOF_OUT              captures, result.json and durations.md (default
//                          /tmp/cleared-captures/j2/multi-proof, or .../j2/multi-rehearsal)
//   PROOF_PLAYWRIGHT       the folder of an installed playwright-core (not a dependency of v2)
//   PROOF_CHROME           the Chromium executable
//   PROOF_STEP_MINUTES     the longest wait of one step (default 60; the rehearsal: 6)
//   PROOF_TIMEOUT_MINUTES  the rehearsal's whole run at most (default 40)
// The fake's calls are read through the docker wrapper of src/container/docker.ts,
// under its label rule: the session's egress container asks the fake, as the
// preview route asks the guestbook. No trace and no video are recorded.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NextInboxItem, ReleaseItem, SessionDetail, SessionSummary, TicketStep, Workspace } from '../src/api/types.ts';
import { Docker, commandRunner } from '../src/container/docker.ts';
import { RELAY } from '../src/container/preview.ts';
import { DEFAULT_FAKE_PORT } from '../src/container/services.ts';
import { sessionNames, siblingAddress } from '../src/container/session-runtime.ts';
import type { Ticket } from '../src/tickets/contract.ts';
import { GUESTBOOK_HEADING } from './proof-guestbook-heading.ts';
import { answerFor } from './proof-inbox.ts';
import { SHELL_LINES, atPrompt, lineOutcome } from './proof-terminal.ts';
import { humanFacts, renderMultiDurations, sessionPlanFacts, trainFacts, type MultiResult, type Step } from './proof-report.ts';
import { MULTI_TICKETS, startMultiRehearsal, type MultiWorld } from './proof-rehearsal-multi.ts';

const env = process.env;
const REHEARSAL = env.PROOF_REHEARSAL === '1';
if (!env.PROOF_PLAYWRIGHT || (!REHEARSAL && !env.PROOF_PASSWORD_FILE)) {
  console.error('proof: set PROOF_PLAYWRIGHT, and PROOF_PASSWORD_FILE for a real run');
  process.exit(64);
}
const minutes = (name: string, fallback: number): number => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) { console.error(`proof: ${name} must be a positive number`); process.exit(64); }
  return value;
};
const startedAt = new Date();
const STEP_MS = minutes('PROOF_STEP_MINUTES', REHEARSAL ? 6 : 60) * 60_000;
const DEADLINE = REHEARSAL ? startedAt.getTime() + minutes('PROOF_TIMEOUT_MINUTES', 40) * 60_000 : Number.POSITIVE_INFINITY;
const OUT = env.PROOF_OUT ?? `/tmp/cleared-captures/j2/multi-${REHEARSAL ? 'rehearsal' : 'proof'}`;
const log = (line: string) => console.log(`proof: ${line}`);
mkdirSync(OUT, { recursive: true });

let world: MultiWorld | undefined;
if (REHEARSAL) {
  world = await startMultiRehearsal({ log });
  const started = world;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void started.stop().finally(() => process.exit(130)); });
}
const APP = (world?.appUrl ?? env.PROOF_APP_URL ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
const OWNER = world?.owner ?? env.PROOF_OWNER ?? 'owner';
const PASSWORD_FILE = (world?.passwordFile ?? env.PROOF_PASSWORD_FILE) as string;
const LEDGER = world?.ledger ?? env.PROOF_LEDGER;
// The rehearsal's docker is its stand-in; the real run's is the CLI, behind the wrapper's label rule.
const docker = new Docker(commandRunner(world?.docker ?? 'docker'));

const require = createRequire(join(env.PROOF_PLAYWRIGHT, 'package.json'));
const { chromium } = require('playwright-core') as { chromium: any };
const browser = await chromium.launch({ headless: true, ...(env.PROOF_CHROME ? { executablePath: env.PROOF_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);

// ---- what the run keeps ---------------------------------------------------------

const steps: Step[] = [];
const times: Record<string, string> = {};
const gestures: { at: string; what: string }[] = [];
const tickets: Record<number, string> = {};
const saves: { at: string; status: number; kept: boolean | null }[] = [];
let fake: MultiResult['fake'] = null;
let proposal: string | null = null;
let human: { session: string; givenBackAt: string | null } | null = null;
let harnessShown = '';
let captures = 0;
const now = () => new Date().toISOString();
const pad = (n: number) => String(n).padStart(2, '0');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gesture = (what: string) => { gestures.push({ at: now(), what }); log(`gesture: ${what}`); };

async function capture(name: string): Promise<string> {
  const file = join(OUT, `${pad(++captures)}-${name}.png`);
  // The pointer away from the buttons, so no hover state is captured.
  await page.mouse.move(2, 2).catch(() => undefined);
  await page.screenshot({ path: file, fullPage: true });
  chmodSync(file, 0o644);
  return file;
}

function save(): void {
  const file = join(OUT, 'result.json');
  writeFileSync(file, `${JSON.stringify({ app: APP, mode: REHEARSAL ? 'rehearsal' : 'real', tickets, steps, times, gestures, saves, fake, proposal }, null, 2)}\n`);
  chmodSync(file, 0o644);
}

async function step(n: number, name: string, body: () => Promise<string>): Promise<boolean> {
  try {
    const note = await body();
    steps.push({ n, name, status: 'ok', seenAt: now(), note, capture: await capture(`step-${n}-${name}`) });
    log(`${pad(n)} ${name}: ok (${note})`);
    save();
    return true;
  } catch (error) {
    let shot: string | undefined;
    try { shot = await capture(`step-${n}-${name}-failed`); } catch { /* the page is gone */ }
    const note = (error as Error).message.split('\n')[0] ?? '';
    steps.push({ n, name, status: 'failed', seenAt: now(), note, ...(shot ? { capture: shot } : {}) });
    log(`${pad(n)} ${name}: failed (${note})`);
    save();
    return false;
  }
}

function skip(n: number, name: string, why: string): void {
  steps.push({ n, name, status: 'skipped', seenAt: now(), note: why });
  log(`${pad(n)} ${name}: skipped (${why})`);
}

// ---- reading the state, as the signed-in page does ---------------------------

const reader = await context.newPage();
async function api<T>(path: string): Promise<T> {
  return await reader.evaluate(async (url: string) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return await response.json();
  }, `/api/service${path}`) as T;
}
const inbox = () => api<NextInboxItem[]>('/inbox');
const stepsOf = (ticket: string) => api<TicketStep[]>(`/tickets/${encodeURIComponent(ticket)}/steps`);
const ticketOf = (ticket: string) => api<Ticket>(`/tickets/${encodeURIComponent(ticket)}`);
function ledger<T>(read: (db: DatabaseSync) => T): T | undefined {
  if (!LEDGER) return undefined;
  const db = new DatabaseSync(LEDGER, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
// How long each step of a ticket ran, which the API's steps do not say: the ledger's ticket_steps.
const minutesOf = (ticket: string): Map<number, number> => new Map((ledger((db) => db.prepare('SELECT position, minutes FROM ticket_steps WHERE ticket = ? AND minutes IS NOT NULL').all(ticket) as { position: number; minutes: number }[]) ?? [])
  .map((row) => [Number(row.position), Math.round(Number(row.minutes) * 10) / 10]));

// What the owner tends while the proof waits: the Go of a session plan of
// one of the proof's tickets, and a permission of one of them, answered by
// the rule of the 48-hour proof's morning (proof-inbox.ts).
async function tend(): Promise<void> {
  const ours = new Set(Object.values(tickets));
  for (const item of await inbox()) {
    if (item.state !== 'waiting' || !ours.has(item.ticket)) continue;
    if (item.kind === 'session_plan') {
      await openItem(item.id);
      await page.locator('#detail [data-act="plan_go"]').click();
      gesture(`gave the Go to the session plan of ${item.ticket}${item.service ? ` on ${item.service}` : ''} (${item.plan.confidence})`);
      await until('the Go to be taken', async () => !(await inbox()).some((i) => i.id === item.id && i.state === 'waiting'), 60_000, 1_000, false);
    } else if (item.kind === 'permission') {
      const decision = item.input.kind === 'execute' ? answerFor(item.input.command) : 'reject_once';
      await openItem(item.id);
      await page.locator(`#detail [data-act="${decision}"]`).click();
      gesture(`${decision} for ${item.id}`);
    }
  }
}

async function until<T>(what: string, check: () => Promise<T | undefined | false>, ms = STEP_MS, every = 2_000, tending = true): Promise<T> {
  const end = Math.min(Date.now() + ms, DEADLINE);
  for (;;) {
    if (tending) await tend();
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

async function openItem(id: string): Promise<void> {
  await page.goto(`${APP}/inbox`);
  const link = page.locator(`a.item[data-item="${id}"]`);
  await link.waitFor();
  await link.click();
  // The item shown: a waiting one with its buttons, a handled one (a train
  // rolled back) with its line only.
  await page.locator(`a.item[data-item="${id}"][aria-current="true"]`).waitFor();
  await page.locator('#d-actions').waitFor({ state: 'attached' });
}

// Creates ticket `n` of the proof from the tower bar, naming its services.
async function createTicket(n: number): Promise<string> {
  const t = MULTI_TICKETS[n - 1] as (typeof MULTI_TICKETS)[number];
  await page.goto(`${APP}/`);
  await page.locator('#ask-input').fill(t.title);
  await page.locator('#ask-body').fill(t.body);
  for (const service of t.services) {
    const chip = page.locator(`#ask .svc-toggle[data-service="${service}"]`);
    await chip.waitFor();
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  }
  const before = new Set((await api<Ticket[]>('/tickets')).map((ticket) => ticket.id));
  await page.locator('#ask button[type="submit"]').click();
  const made = await until(`ticket ${n} to be created`, async () => (await api<Ticket[]>('/tickets')).find((ticket) => !before.has(ticket.id) && ticket.title === t.title), 60_000, 1_000, false);
  tickets[n] = made.id;
  gesture(`created ticket ${n} (${made.id}) from the tower bar on ${t.services.join(' and ')}`);
  return made.id;
}

const releaseOf = async (ticket: string, state: 'waiting' | 'handled' | 'any' = 'waiting'): Promise<ReleaseItem | undefined> =>
  (await inbox()).filter((i): i is ReleaseItem => i.kind === 'release' && i.ticket === ticket && (state === 'any' || i.state === state)).at(-1);

const stepLine = (list: readonly TicketStep[]) => list.map((s) => `${s.position}:${s.kind}/${s.service}${s.after.length ? ` after ${s.after.join(',')}` : ''}`).join('; ');

// The fake's own count (images/fake/fake.ts), asked from the session's
// egress container on the session's network, as the preview asks its page.
async function fakeCalls(session: string): Promise<{ total: number; operations: Record<string, number> } | undefined> {
  const address = await siblingAddress(docker, session, 'filter-api');
  if (!address) return undefined;
  const workspace = await api<Workspace>('/workspace');
  // Where the fake listens: the service's run port, as the runtime plans it
  // (container/services.ts planSiblings), else its default.
  const port = workspace.services.find((s) => s.name === 'filter-api')?.run?.port ?? DEFAULT_FAKE_PORT;
  const result = await docker.exec(session, sessionNames(session).egress, ['node', '-e', RELAY, `http://${address}:${port}/__fake/calls`, '65536', '5000'], { timeoutMs: 20_000 });
  const relayed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { status?: number; body?: string };
  if (relayed.status !== 200 || !relayed.body) return undefined;
  return JSON.parse(Buffer.from(relayed.body, 'base64').toString('utf8')) as { total: number; operations: Record<string, number> };
}

// ---- 0. Sign in ----------------------------------------------------------------
const signedIn = await step(0, 'sign-in', async () => {
  await page.goto(`${APP}/`);
  await page.locator('#name').fill(OWNER);
  await page.locator('#password').fill(readFileSync(PASSWORD_FILE, 'utf8').trim());
  await Promise.all([page.waitForURL(`${APP}/`), page.locator('form.login-card [type=submit]').first().click()]);
  await page.locator('#ask-input').waitFor();
  await reader.goto(`${APP}/`);
  const workspace = await api<Workspace>('/workspace');
  const names = workspace.services.map((s) => s.name);
  if (!names.includes('guestbook') || !names.includes('filter-api')) throw new Error(`the workspace has ${names.join(', ')}, not the guestbook and the filter API`);
  return `signed in as ${OWNER}; workspace ${workspace.id}: ${names.join(', ')}`;
});

// ---- 1 to 7. The first ticket, across both services --------------------------------
let first = '';
const created = signedIn && await step(1, 'ticket', async () => {
  times.ticket_created_at = now();
  first = await createTicket(1);
  return `${first} created on the guestbook and the filter API`;
});

let split: TicketStep[] = [];
const splitOk = created && await step(2, 'steps', async () => {
  split = await until('the steps', async () => { const list = await stepsOf(first); return list.length > 1 ? list : undefined; }, 120_000, 1_000);
  times.steps_proposed_at = now();
  const kinds = split.map((s) => s.kind).join(',');
  if (kinds !== 'contract,service,service,integration') throw new Error(`steps ${stepLine(split)}`);
  return stepLine(split);
});

const validated = splitOk && await step(3, 'contract', async () => {
  const item = await until('the contract item', async () => (await inbox()).find((i) => i.kind === 'contract' && i.ticket === first && i.state === 'waiting'));
  times.contract_shown_at = item.since;
  await openItem(item.id);
  const shown = await page.locator('#detail').innerText();
  if (!/severity/.test(shown)) throw new Error('the contract\'s diff shows no severity');
  await page.locator('#detail [data-act="contract_approve"]').click();
  times.contract_validated_at = now();
  gesture(`validated the contract of ${first} in the inbox`);
  await until('the contract step to be done', async () => (await stepsOf(first)).find((s) => s.kind === 'contract')?.state === 'done');
  return `the diff of contract/openapi.yaml validated (shown ${item.since})`;
});

if (validated) {
  await step(4, 'trial', async () => {
    let parallel = 0;
    const guestbook = await until('the guestbook\'s step to run', async () => {
      const list = await stepsOf(first);
      parallel = Math.max(parallel, list.filter((s) => s.kind === 'service' && s.state === 'running').length);
      return list.find((s) => s.kind === 'service' && s.service === 'guestbook' && s.session)?.session ?? undefined;
    });
    const detail = await until('its preview', async () => { const d = await api<SessionDetail>(`/sessions/${guestbook}`); return d.previewKey ? d : undefined; }, 120_000);
    // The root page only: the guestbook's form posts to /entries and redirects
    // to /, root-absolute addresses that leave the session's preview address,
    // and the preview relays no write (issue 213, item 5): a known limit of
    // the Browser tab, not a failure of this step.
    await page.goto(`${APP}/sessions/${encodeURIComponent(detail.id)}#browser`);
    await page.locator('#tab-browser-button').click();
    // The guestbook's own page, as its heading says (examples/guestbook/src/page.ts;
    // the rehearsal's stand-in page carries the same heading format).
    const frame = page.frameLocator('iframe[sandbox]');
    await frame.locator('h1').filter({ hasText: GUESTBOOK_HEADING }).waitFor({ timeout: 60_000 });
    // The fake's own count, read until it answered once or for a minute: the
    // real guestbook calls the filter only on an entry's post, which the
    // preview does not relay, so 0 calls is a possible, honest reading.
    let counted: Awaited<ReturnType<typeof fakeCalls>>;
    const until_ = Date.now() + 60_000;
    for (;;) {
      counted = await fakeCalls(guestbook).catch(() => undefined);
      if ((counted?.total ?? 0) >= 1) { times.fake_first_answer_at = now(); break; }
      if (Date.now() > until_) break;
      await sleep(3_000);
    }
    fake = counted ? { calls: counted.total, operations: counted.operations } : null;
    const list = await until('both service steps to end', async () => {
      const now = await stepsOf(first);
      parallel = Math.max(parallel, now.filter((s) => s.kind === 'service' && s.state === 'running').length);
      return now.filter((s) => s.kind === 'service').every((s) => s.state === 'done') ? now : undefined;
    });
    const took = minutesOf(first);
    // Readings every few seconds miss two short steps that overlap: the
    // ledger's sessions of the two service steps say whether they ran at once.
    const spans = ledger((db) => db.prepare('SELECT s.created_at AS a, s.updated_at AS b FROM ticket_steps t JOIN sessions s ON s.id = t.session WHERE t.ticket = ? AND t.kind = ?').all(first, 'service') as { a: string; b: string }[]) ?? [];
    if (spans.length === 2 && spans[0] && spans[1] && spans[0].a < spans[1].b && spans[1].a < spans[0].b) parallel = Math.max(parallel, 2);
    const times_ = list.filter((s) => s.kind === 'service').map((s) => `${s.service} ${took.get(s.position) ?? '?'} min`).join(', ');
    return `the guestbook's Browser tab shows the trial environment; the fake answered ${fake?.calls ?? 'unread'} calls; at most ${parallel} service steps running at once; ${times_}`;
  });
  await step(5, 'integration', async () => {
    const done = await until('the integration step', async () => (await stepsOf(first)).find((s) => s.kind === 'integration' && (s.state === 'done' || s.state === 'failed')));
    if (done.state !== 'done') throw new Error(`the integration step ${done.state}`);
    return `the integration on ${done.service}: ${done.state} in ${minutesOf(first).get(done.position) ?? '?'} min`;
  });
} else {
  skip(4, 'trial', 'the contract was not validated');
  skip(5, 'integration', 'the contract was not validated');
}

let approvedFirst = false;
if (validated) {
  approvedFirst = await step(6, 'card', async () => {
    const card = await until('the release card', async () => { const r = await releaseOf(first); return r?.train && r.pr.checks === 'passed' ? r : undefined; });
    await openItem(card.id);
    const stops = await page.locator('#detail [data-stop]').evaluateAll((nodes: { getAttribute(name: string): string | null }[]) => nodes.map((n) => n.getAttribute('data-stop')));
    const line = (await page.locator('#detail [data-train-line]').first().innerText().catch(() => '')).trim();
    const services = card.train?.services.map((s) => s.service) ?? [];
    if (services.join(',') !== 'filter-api,guestbook') throw new Error(`the landing order is ${services.join(', ')}`);
    await page.locator('#detail [data-act="approve"]').click();
    times.approved_at = now();
    gesture(`approved the train of ${first} with one gesture`);
    return `${card.heads.length} pull requests, landing order ${services.join(' then ')} (shown: ${stops.join(', ')}); ${card.train?.compatibility ?? line}; ${card.groups?.length ?? 0} groups, flags ${(card.flags ?? []).map((f) => f.kind).join(', ') || 'none'}`;
  });
} else skip(6, 'card', 'the contract was not validated');

if (approvedFirst) {
  await step(7, 'landing', async () => {
    const done = await until('the train to land', async () => {
      const r = await releaseOf(first, 'any');
      if (r?.train && ['rolled_back', 'halted'].includes(r.train.state)) throw new Error(`the train is ${r.train.state}`);
      return (await ticketOf(first)).status === 'Done' && r?.train?.state === 'landed' ? r : undefined;
    });
    await page.goto(`${APP}/`);
    return (done.train?.services ?? []).map((s) => `${s.service} ${s.state} at ${s.at ?? '?'}`).join('; ');
  });
} else skip(7, 'landing', 'the card was not approved');

// ---- 8, 9. The provoked failure and its rollback in reverse order ---------------
let second = '';
const approvedSecond = signedIn && await step(8, 'provoked', async () => {
  second = await createTicket(2);
  const card = await until('its release card', async () => { const r = await releaseOf(second); return r?.train && r.pr.checks === 'passed' ? r : undefined; });
  await openItem(card.id);
  await page.locator('#detail [data-act="approve"]').click();
  times.second_approved_at = now();
  gesture(`approved the train of ${second}, whose guestbook change breaks /health`);
  return `${second}: ${card.heads.length} pull requests approved`;
});

if (approvedSecond) {
  await step(9, 'rollback', async () => {
    const rolled = await until('the rollback', async () => {
      const r = await releaseOf(second, 'any');
      if (r?.train?.state === 'landed') throw new Error('the train landed: no rollback');
      return r?.train?.state === 'rolled_back' ? r : undefined;
    });
    const ticket = await until('the ticket back in Todo', async () => { const t = await ticketOf(second); return t.status === 'Todo' ? t : undefined; }, 120_000);
    const first = ledger((db) => db.prepare("SELECT at FROM events WHERE kind = 'release_health_failing' AND ticket = ? ORDER BY at LIMIT 1").get(second) as { at: string } | undefined);
    if (first) times.first_failing_at = first.at;
    await openItem(rolled.id);
    const line = (await page.locator('#detail [data-train-line]').first().innerText().catch(() => '')).trim();
    if (!/Rolled back, 2 of 2/.test(line)) throw new Error(`the card says: ${line || 'nothing'}`);
    const order = [...(rolled.train?.services ?? [])].filter((s) => s.state === 'reverted').sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? '')).map((s) => s.service);
    if (order.join(',') !== 'guestbook,filter-api') throw new Error(`reverted in this order: ${order.join(', ')}`);
    return `"${line}"; reverted ${order.join(' then ')}; ${ticket.id} in ${ticket.status}`;
  });
} else skip(9, 'rollback', 'the second release was not approved');

// ---- 10. The untouched consumer: the card blocked ---------------------------------
if (signedIn) {
  await step(10, 'blocked', async () => {
    const third = await createTicket(3);
    const card = await until('its blocked card', async () => { const r = await releaseOf(third); return r?.train?.state === 'blocked' ? r : undefined; });
    times.block_shown_at = now();
    await openItem(card.id);
    await page.locator('#detail [data-blocked]').first().waitFor();
    if (await page.locator('#detail [data-act="approve"]').count() > 0) throw new Error('the blocked card has an Approve button');
    proposal = card.train?.blocked?.proposal ?? null;
    return `blocked: ${card.train?.blocked?.reason ?? '?'}; proposal: ${proposal ?? '?'}; no Approve`;
  });
}

// ---- 11. Take over, type, save, give back ---------------------------------------------
if (signedIn) {
  await step(11, 'takeover', async () => {
    const fourth = await createTicket(4);
    const session = await until('its session to work', async () => {
      const live = (await api<SessionSummary[]>('/sessions')).find((s) => s.ticket === fourth && s.role === 'author' && s.phase === 'working');
      if (!live) return undefined;
      const files = await api<{ files: { path: string }[] }>(`/sessions/${live.id}/files`);
      return files.files.some((f) => f.path === 'src/page.ts') ? live : undefined;
    });
    human = { session: session.id, givenBackAt: null };
    await page.goto(`${APP}/sessions/${encodeURIComponent(session.id)}`);
    await page.locator('#takeover').click();
    times.take_over_at = now();
    gesture(`took over ${session.id.slice(0, 8)} of ${fourth}`);
    await page.locator('#giveback').waitFor({ timeout: 60_000 });
    // The web terminal opens on the session's own harness (pull request 230):
    // Claude Code resumed, or, for a harness that cannot be resumed (the
    // rehearsal's scripted one), the reason and the Shell alone. What it
    // showed is recorded; the lines of section 2.2 are typed in the Shell.
    await page.locator('#tab-terminal-button').click();
    const terminal = page.locator('[data-terminal-state]').first();
    await terminal.waitFor();
    await until('the terminal to open or to say why not', async () => {
      const state = await terminal.getAttribute('data-terminal-state');
      return state === 'open' || (state === 'closed' && (await terminal.getAttribute('data-reason')) === 'unsupported') ? state : undefined;
    }, 60_000, 500, false);
    // Attached to the harness, or unsupported (the fake adapter's scripted
    // sessions have no interactive harness: said as such, not as a failure).
    const attached = (await terminal.getAttribute('data-terminal-state')) === 'open';
    const said = (await page.locator('.term-mode').first().innerText().catch(() => '')).trim();
    harnessShown = attached ? `Take over attached to the harness ("${said}")` : `the harness unsupported${REHEARSAL ? ' on the fake adapter' : ''} ("${said}")`;
    times.terminal_open_at = now();
    await capture('takeover-harness');
    if ((await terminal.getAttribute('data-mode')) !== 'shell') {
      await page.locator('[data-act="terminal_shell"]').first().click();
      gesture('opened the Shell beside the harness');
    }
    await page.locator('[data-terminal-state="open"][data-mode="shell"]').first().waitFor({ timeout: 60_000 });
    await page.locator('.term-host').first().click();
    // One line at a time, each typed once the one before has answered: the
    // prompt back on the last row, and "On branch" for git status, before
    // npm test scrolls it out of the rows (proof-terminal.ts). npm ci comes
    // first in a checkout with no node_modules. A red install or test is recorded.
    const rows = () => page.locator('.term-host').first().innerText().catch(() => '');
    const answered: string[] = [];
    for (const { line, expect, timeoutMs, required } of SHELL_LINES) {
      await page.keyboard.type(line, { delay: 20 });
      await page.keyboard.press('Enter');
      gesture(`typed ${line} in the web terminal`);
      await sleep(500);
      const seen = await until(`the answer to ${line}`, async () => {
        const text = await rows();
        return atPrompt(text) && (!expect || expect.test(text)) ? text : undefined;
      }, timeoutMs, 500, false).catch((error: unknown) => {
        if (required) throw error;
        return undefined;
      });
      if (line === 'git status') await capture('takeover-terminal');
      answered.push(`${line}: ${seen === undefined ? `no answer within ${Math.round(timeoutMs / 60_000)} min` : lineOutcome(line, seen)}`);
    }
    await capture('takeover-tests');
    // The editor: one line changed in src/page.ts, saved.
    page.on('response', (response: any) => {
      if (response.request().method() === 'PUT' && /\/files\//.test(response.url())) saves.push({ at: now(), status: response.status(), kept: null });
    });
    await page.locator('#tab-editor-button').click();
    await page.locator('[data-file="src/page.ts"]').click();
    await page.locator('[data-act="editor_edit"]').click();
    await page.locator('[data-editor-state]').first().waitFor();
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('// The owner changed this line in the Editor tab (step 11).\n');
    await page.locator('[data-act="editor_save"]').click();
    await page.locator('[data-editor-state="saved"]').first().waitFor({ timeout: 60_000 });
    times.save_at = now();
    gesture('changed one line of src/page.ts in the Editor tab and saved it');
    await capture('takeover-editor');
    await page.locator('#giveback').click();
    times.give_back_at = now();
    human.givenBackAt = times.give_back_at;
    gesture(`gave ${session.id.slice(0, 8)} back`);
    // The notice in the session's next turn, and the change in the ticket's diff.
    const card = await until('the ticket\'s release card with the owner\'s change', async () => {
      const r = await releaseOf(fourth);
      return r?.groups?.some((g) => g.files.includes('src/page.ts')) ? r : undefined;
    });
    // A save the card's branch carries was kept. Issue 226 (item 7) asks the
    // real run for the rate at which a save is lost to a change the session
    // makes between the write program's hash check and its rename: each save
    // and its answer are recorded, and one the branch does not carry reads
    // as not kept.
    for (const s of saves) s.kept = s.status === 200;
    const facts = ledger((db) => humanFacts(db, session.id, times.give_back_at ?? null));
    return `taken over: ${harnessShown}; then the Shell button, ${SHELL_LINES.map((l) => l.line).join(', ')} typed (${answered.join('; ')}), ${facts?.lines ?? '?'} lines journaled; ${saves.length} editor save(s) (${saves.map((x) => x.status).join(', ')}); given back; the notice's turn at ${facts?.noticeTurnAt ?? '?'}; src/page.ts in the card of ${card.ticket}`;
  });
}

// ---- the screens as the proof left them ------------------------------------------------
// The visual loop's widths and themes, on the four screens the proof drove,
// in the state it left them: /tmp/cleared-captures/j2/proof-multi-<screen>-<width>-<theme>.png
// (PROOF_SCREENS=0 leaves them out; the real run takes them too).
if (signedIn && env.PROOF_SCREENS !== '0') {
  const shots = '/tmp/cleared-captures/j2';
  mkdirSync(shots, { recursive: true });
  const session = (human as { session: string } | null)?.session;
  const screens: [string, string][] = [['tower', '/'], ['inbox', '/inbox'], ['lead', '/lead'], ...(session ? [['session', `/sessions/${encodeURIComponent(session)}`] as [string, string]] : [])];
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(([key, value]: string[]) => { try { localStorage.setItem(key as string, value as string); } catch { /* no storage */ } }, ['cleared-v2-theme', theme]);
      for (const width of [1440, 1280, 768, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        for (const [name, path] of screens) {
          await page.goto(`${APP}${path}`);
          await page.locator('#screen > *').first().waitFor().catch(() => undefined);
          await sleep(500);
          await page.mouse.move(2, 2).catch(() => undefined);
          const file = join(shots, `proof-multi-${name}-${width}-${theme}.png`);
          await page.screenshot({ path: file, fullPage: true });
          chmodSync(file, 0o644);
        }
      }
    }
    log(`the screens at four widths, light and dark: ${shots}/proof-multi-*.png`);
  } catch (error) {
    log(`the screens' captures stopped: ${(error as Error).message.split('\n')[0]}`);
  }
}

// ---- the report ----------------------------------------------------------------------
const since = startedAt.toISOString();
const ticketSteps: MultiResult['ticketSteps'] = {};
for (const id of Object.values(tickets)) {
  const took = minutesOf(id);
  try { ticketSteps[id] = (await stepsOf(id)).map((s) => ({ position: s.position, kind: s.kind, service: s.service, state: s.state, costUsd: s.costUsd, minutes: took.get(s.position) ?? null })); } catch { /* the app is gone */ }
}
const result: MultiResult = {
  mode: REHEARSAL ? 'rehearsal' : 'real', app: APP, startedAt: since, steps, times, tickets, ticketSteps,
  trains: ledger((db) => trainFacts(db)) ?? [], fake, human: human ? ledger((db) => humanFacts(db, (human as { session: string }).session, (human as { givenBackAt: string | null }).givenBackAt)) ?? null : null,
  saves, sessionPlans: ledger((db) => sessionPlanFacts(db, since)) ?? [], gestures, stand_ins: world?.standIns ?? [], proposal,
};
const durations = join(OUT, 'durations.md');
writeFileSync(durations, renderMultiDurations(result));
chmodSync(durations, 0o644);
save();
await browser.close();
if (world) {
  await world.stop();
  rmSync(world.passwordFile, { force: true });
  log(`the rehearsal's folder is kept for reading: ${world.root}`);
}
const counted = (status: Step['status']) => steps.filter((s) => s.status === status).length;
log(`done: ${counted('ok')} steps ok, ${counted('skipped')} skipped, ${counted('failed')} failed; ${durations}`);
process.exitCode = counted('failed') > 0 ? 1 : 0;
