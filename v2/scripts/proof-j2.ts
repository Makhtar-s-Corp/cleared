// The milestone 2 proof, driven through the browser only, as the owner would
// (docs/v2/milestone-2-plan.md, section 1): in the evening, sign in, give the
// goal on the lead screen, answer the lead's questions, see the plan and
// approve it, and tell the lead two things it must not forget; watch the
// night; in the morning, read what waits, answer it and approve the releases
// from the inbox; then read on the lead screen what the lead remembers. The
// times come from the app's routes (read by the signed-in page, as the
// screens read them) and, when the ledger is given, from the ledger itself,
// read only, for what no screen shows (notifications, costs).
//
// Lane 29 runs it on the React screens and the replanned milestone 2: the
// rehearsal builds the app first (npm run build) and serves the pages from
// the build's manifest; a question of several choices is answered with its
// Send; every author proposes a session plan, and the morning gives its Go
// to one that waits (a medium or low confidence holds its ticket until
// then); a team's question is answered from the inbox with its recommended
// option, else its first, in one click when one click answers it (issue
// #269, proof-inbox.ts); a knowledge item is left to the owner and counted; each release
// card's intent groups and flags are read before it is approved.
//
//   node scripts/proof-j2.ts                       the real run, against the running app
//   PROOF_REHEARSAL=1 node scripts/proof-j2.ts     the rehearsal: scripts/proof-rehearsal.ts
//                                                  starts a service and an app of its own on
//                                                  the fake adapter, in a temporary folder
//
// Settings, from the environment:
//   PROOF_APP_URL          the app (default http://127.0.0.1:8792); the rehearsal's own otherwise
//   PROOF_OWNER            the app user who approves (default owner)
//   PROOF_PASSWORD_FILE    a file holding the password; it is read, never printed
//   PROOF_LEDGER           ledger.db of the service, read only (optional: without it, no
//                          notification count and no cost)
//   PROOF_OUT              captures, result.json and durations.md (default
//                          /tmp/cleared-captures/j2/proof, or .../j2/rehearsal)
//   PROOF_PLAYWRIGHT       the folder of an installed playwright-core (not a dependency of v2)
//   PROOF_CHROME           the Chromium executable
//   PROOF_GOAL             the goal (default: question 5 (a) of the plan)
//   PROOF_ANSWERS          the answers to the lead's questions, in order, separated by "||";
//                          "recommended" (the default) picks the option marked so
//   PROOF_MORNING          when the morning starts, an ISO time (default: the next 08:00 on
//                          this machine's clock; the rehearsal: PROOF_NIGHT_MINUTES after the start)
//   PROOF_HOURS            when step 8 reads the lead, after the goal (default 48)
//   PROOF_WATCH_MINUTES    the night watch's interval (default 5; the rehearsal: 10 seconds)
//   PROOF_OWNER_APPROVES=1 the owner approves the releases and answers the permissions and
//                          the team's questions in the morning; the proof only watches and measures
//   PROOF_NOTIFICATIONS    skipped (the real run's default: the owner decided on 2026-10-22,
//                          question 2 of the replan, option (b), that the proof sends no
//                          notification to the Mac, so it runs on the inbox only and records
//                          the step as skipped, not failed) or counted (the rehearsal's
//                          default: its e-mail stand-in)
//   PROOF_RESUME_PLAN      the id of a plan already approved (or paused) to take over
//                          instead of sending a new goal (issue 285): steps 1 to 3 are
//                          skipped, step 4 gives a paused plan the owner's Resume on the lead
//                          screen and plants the two commitments, and every measure runs from
//                          then. Without it, a run stops before its first gesture (exit 64)
//                          when a plan is approved and not paused: two plans would run at once
//   PROOF_STUCK_MINUTES    how long step 7 waits on a blocked plan before it fails (default 90):
//                          nothing running, nothing to approve, every item left held, parked,
//                          ready but not started, or after one of those (proof-plan.ts). Above
//                          the service's own delays (a question's 30 min, then the lead's 10,
//                          the idle watchdog's 15), so the lead has its start_ticket turn first
//   PROOF_NIGHT_MINUTES    the rehearsal's night (default 4)
//   PROOF_TIMEOUT_MINUTES  the rehearsal's whole run at most (default 30)
// No trace and no video are recorded: a trace keeps what is typed, the password included.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LeadMemory, LeadMessage, LeadState, NextInboxItem, Plan, SessionSummary } from '../src/api/types.ts';
import { answerInInbox, leftForOwner, morningAction, type InboxEntry, type QuestionChoice } from './proof-inbox.ts';
import { blockageLine, planBlockage, startCheck, type StartDecision } from './proof-plan.ts';
import {
  NOTIFICATIONS_SKIPPED_NOTE, PLANTED, changes, commitmentOutcomes, duration, highestShare, notificationCount, ledgerFacts, morningSummary, newTimeline, orderCheck, renderDurations, sessionPlanFacts, track,
  type LedgerFacts, type Morning, type Outcome, type ProofResult, type ReleaseCard, type Snapshot, type Step,
} from './proof-report.ts';
import { REHEARSAL_GOAL, startRehearsal, type World } from './proof-rehearsal.ts';
import { said } from './proof-words.ts';

const env = process.env;
const REHEARSAL = env.PROOF_REHEARSAL === '1';
if (!env.PROOF_PLAYWRIGHT || (!REHEARSAL && !env.PROOF_PASSWORD_FILE)) {
  console.error('proof: set PROOF_PLAYWRIGHT, and PROOF_PASSWORD_FILE for a real run');
  process.exit(64);
}
const startedAt = new Date();
const minutes = (name: string, fallback: number): number => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) { console.error(`proof: ${name} must be a positive number`); process.exit(64); }
  return value;
};
// The next 08:00 on this machine's clock.
function nextEight(from: Date): Date {
  const at = new Date(from);
  at.setHours(8, 0, 0, 0);
  if (at <= from) at.setDate(at.getDate() + 1);
  return at;
}
const MORNING = env.PROOF_MORNING ? new Date(env.PROOF_MORNING) : REHEARSAL ? new Date(startedAt.getTime() + minutes('PROOF_NIGHT_MINUTES', 4) * 60_000) : nextEight(startedAt);
if (Number.isNaN(MORNING.getTime())) { console.error('proof: PROOF_MORNING is not a time'); process.exit(64); }
const WATCH_MS = REHEARSAL ? 10_000 : minutes('PROOF_WATCH_MINUTES', 5) * 60_000;
const DEADLINE = REHEARSAL ? startedAt.getTime() + minutes('PROOF_TIMEOUT_MINUTES', 30) * 60_000 : Number.POSITIVE_INFINITY;
const OWNER_APPROVES = env.PROOF_OWNER_APPROVES === '1';
const GOAL = env.PROOF_GOAL ?? REHEARSAL_GOAL;
const ANSWERS = (env.PROOF_ANSWERS ?? 'recommended').split('||').map((a) => a.trim()).filter(Boolean);
const NOTIFICATIONS = env.PROOF_NOTIFICATIONS ?? (REHEARSAL ? 'counted' : 'skipped');
if (NOTIFICATIONS !== 'counted' && NOTIFICATIONS !== 'skipped') { console.error('proof: PROOF_NOTIFICATIONS is counted or skipped'); process.exit(64); }
const NOTIFICATIONS_SKIPPED = NOTIFICATIONS === 'skipped' ? NOTIFICATIONS_SKIPPED_NOTE : null;
const OUT = env.PROOF_OUT ?? `/tmp/cleared-captures/j2/${REHEARSAL ? 'rehearsal' : 'proof'}`;
const RESUME = env.PROOF_RESUME_PLAN?.trim() || undefined;
// The rehearsal starts a service of its own, with no plan to take over.
if (RESUME && REHEARSAL) { console.error('proof: PROOF_RESUME_PLAN is for a real run: the rehearsal\'s service has no plan'); process.exit(64); }
const STUCK_MS = minutes('PROOF_STUCK_MINUTES', 90) * 60_000;

const log = (line: string) => console.log(`proof: ${line}`);
mkdirSync(OUT, { recursive: true });

let world: World | undefined;
if (REHEARSAL) {
  world = await startRehearsal({ reminder: MORNING.toISOString(), log });
  // An interrupted rehearsal stops the service and the app it started.
  const started = world;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void started.stop().finally(() => process.exit(130)); });
}
const APP = (world?.appUrl ?? env.PROOF_APP_URL ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
const OWNER = world?.owner ?? env.PROOF_OWNER ?? 'owner';
const PASSWORD_FILE = (world?.passwordFile ?? env.PROOF_PASSWORD_FILE) as string;
const LEDGER = world?.ledger ?? env.PROOF_LEDGER;
const END_AFTER_GOAL_MS = minutes('PROOF_HOURS', 48) * 3_600_000;  // after the goal, or after the take-over

const require = createRequire(join(env.PROOF_PLAYWRIGHT, 'package.json'));
const { chromium } = require('playwright-core') as { chromium: any };
const browser = await chromium.launch({ headless: true, ...(env.PROOF_CHROME ? { executablePath: env.PROOF_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);

// ---- what the run keeps -------------------------------------------------------

const steps: Step[] = [];
const times: Record<string, string> = {};
const answers: { at: string; text: string }[] = [];
// The team's questions answered in the morning, as the multi-service proof keeps them.
const questions: (QuestionChoice & { at: string; ticket: string; session: string })[] = [];
const gestures: { at: string; what: string }[] = [];
const watchLog: { at: string; lines: string[] }[] = [];
const timeline = newTimeline();
// The commitment ids the lead recorded in the turn that answered each planted message.
const planted: Record<string, string[]> = {};
let planId = '';
let plan: Plan | undefined;
let resumed: { planId: string; at: string; items: Record<number, string> } | null = null;
let startRefusal: string | null = null;
// The blockage seen now (proof-plan.ts), and the last one, for the report.
type Blocked = { signature: string; since: string; line: string; failed: boolean };
let blocked: Blocked | null = null;
let lastBlocked: Blocked | null = null;
let morning: Morning | null = null;
const cards: ReleaseCard[] = [];
let left = { knowledge: 0, contract: 0 };
let last: Snapshot | undefined;
let captures = 0;
const now = () => new Date().toISOString();
const pad = (n: number) => String(n).padStart(2, '0');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gesture = (what: string) => { gestures.push({ at: now(), what }); log(`gesture: ${what}`); };

async function capture(name: string, target: any = page): Promise<string> {
  const file = join(OUT, `${pad(++captures)}-${name}.png`);
  // The pointer away from the buttons, so no hover state is captured.
  await target.mouse.move(2, 2).catch(() => undefined);
  await target.screenshot({ path: file, fullPage: true });
  chmodSync(file, 0o644);
  return file;
}

function save(): void {
  const file = join(OUT, 'result.json');
  writeFileSync(file, `${JSON.stringify({ app: APP, mode: REHEARSAL ? 'rehearsal' : 'real', planId, resumed, startRefusal, blocked: lastBlocked, planted, steps, times, answers, questions, gestures, timeline, morning, watch: watchLog }, null, 2)}\n`);
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

// A page that stays on the app, for the routes the screens read: the
// browser's own session and the app's forwarding to the service.
const reader = await context.newPage();
async function api<T>(path: string): Promise<T> {
  return await reader.evaluate(async (url: string) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return await response.json();
  }, `/api/service${path}`) as T;
}

function ledger<T>(read: (db: DatabaseSync) => T): T | undefined {
  if (!LEDGER) return undefined;
  const db = new DatabaseSync(LEDGER, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
// Where the measures start: the goal, or the take-over of a plan (issue 285).
const since = (): string => times.resumed_at ?? times.goal_sent_at ?? startedAt.toISOString();
const facts = (): LedgerFacts | undefined => ledger((db) => ledgerFacts(db, since()));

const LIVE = new Set(['starting', 'working', 'waiting_human', 'reviewing']);
async function readState(): Promise<Snapshot> {
  const [lead, plans, inbox, sessions] = await Promise.all([api<LeadState>('/lead'), api<Plan[]>('/plans'), api<NextInboxItem[]>('/inbox'), api<SessionSummary[]>('/sessions')]);
  plan = plans.find((p) => p.id === planId) ?? plan;
  // Only the count each reading: the whole ledger is read at the end (review 1, F2).
  const sent = ledger((db) => notificationCount(db, since()));
  return {
    at: now(),
    lead: { generation: lead.generation, phase: lead.phase, percent: lead.context?.percent ?? null, highestPercent: lead.highestPercent, refreshCount: lead.refreshCount, openCommitments: lead.openCommitments },
    plan: plan ? { id: plan.id, state: plan.state, items: plan.items.map((i) => ({ position: i.position, title: i.title, state: i.state, ticket: i.ticket, after: i.after })) } : null,
    inbox: inbox.filter((i) => i.state === 'waiting').map((i) => ({ id: i.id, kind: i.kind, ticket: i.ticket })),
    sessions: sessions.filter((s) => s.role !== 'lead' && LIVE.has(s.phase)).map((s) => ({ id: s.id, ticket: s.ticket, role: s.role, phase: s.phase })),
    notifications: sent ?? null,
  };
}

// One reading: the timeline, the changes printed, and a capture of the lead
// screen when something changed.
async function watch(label: string): Promise<Snapshot> {
  const snap = await readState();
  track(timeline, snap);
  const lines = changes(last, snap);
  last = snap;
  if (lines.length > 0) {
    watchLog.push({ at: snap.at, lines });
    for (const line of lines) log(`${label}: ${line}`);
    await page.goto(`${APP}/lead`);
    await page.locator('#thread').waitFor();
    await capture(`${label}-${watchLog.length}`);
    save();
  }
  return snap;
}

// Whether the plan is blocked (proof-plan.ts), said once when it starts or
// changes and once when it ends. Answers how long the same blockage has
// lasted, 0 when there is none.
function checkBlocked(label: string): number {
  const found = plan ? planBlockage(plan) : null;
  if (!found) {
    if (blocked) log(`${label}: the plan moves again after ${duration(blocked.since, now())} blocked`);
    blocked = null;
    return 0;
  }
  if (blocked?.signature !== found.signature) {
    blocked = { signature: found.signature, since: now(), line: blockageLine(found), failed: false };
    lastBlocked = blocked;
    log(`${label}: blocked: ${blocked.line}${label === 'morning' ? `; step 7 stops if this lasts ${STUCK_MS / 60_000} min` : ''}`);
    save();
  }
  return Date.now() - Date.parse(blocked.since);
}

// The last blockage, as the report keeps it.
function reportBlocked(): ProofResult['blocked'] {
  return lastBlocked && { since: lastBlocked.since, line: lastBlocked.line, failed: lastBlocked.failed };
}

// The lead's thread, as the lead screen reads it.
const thread = () => api<LeadMessage[]>('/lead/messages');

async function until<T>(what: string, check: () => Promise<T | undefined | false>, ms: number, every = 1_000): Promise<T> {
  const end = Math.min(Date.now() + ms, DEADLINE);
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// ---- 0. Sign in ------------------------------------------------------------------
const signedIn = await step(0, 'sign-in', async () => {
  await page.goto(`${APP}/`);
  await page.locator('#name').fill(OWNER);
  await page.locator('#password').fill(readFileSync(PASSWORD_FILE, 'utf8').trim());
  await Promise.all([page.waitForURL(`${APP}/`), page.locator('form.login-card [type=submit]').first().click()]);
  await page.locator('#ask-input').waitFor();
  await reader.goto(`${APP}/`);
  return `signed in as ${OWNER}`;
});

// ---- the plans already there (issue 285) -----------------------------------------
// A run sends a new goal only when no plan is approved, else it takes over
// the one PROOF_RESUME_PLAN names, else it stops before its first gesture.
let decision: StartDecision = { kind: 'new' };
// The plans before the goal: steps 2 and 3 take only a plan proposed after it.
let earlier = new Set<string>();
if (signedIn) {
  try {
    const plans = await api<Plan[]>('/plans');
    earlier = new Set(plans.map((p) => p.id));
    decision = startCheck(plans, RESUME);
  } catch (error) {
    decision = { kind: 'refuse', reason: `the plans could not be read: ${(error as Error).message.split('\n')[0]}` };
  }
  if (decision.kind === 'refuse') {
    startRefusal = decision.reason;
    log(`start: refused: ${decision.reason}`);
    save();
    await browser.close();
    if (world) await world.stop();
    process.exit(64);
  }
}
const takeOver = decision.kind === 'resume' ? decision.plan : undefined;

// The two planted commitments, as the owner writes them in the thread.
async function plant(): Promise<void> {
  await page.goto(`${APP}/lead`);
  await page.locator('#thread').waitFor();
  for (const message of PLANTED) {
    const before = (await thread()).length;
    const known = new Set((await api<LeadMemory>('/lead/memory')).commitments.map((c) => c.id));
    await page.locator('#reply-text').fill(message.text);
    await page.locator('#reply-send').click();
    gesture(`told the lead: ${message.text}`);
    await until('the lead\'s reply', async () => (await thread()).slice(before).some((m) => m.by === 'lead'), 10 * 60_000, 2_000);
    planted[message.key] = (await api<LeadMemory>('/lead/memory')).commitments.filter((c) => !known.has(c.id)).map((c) => c.id);
    log(`planted ${message.key}: ${planted[message.key]?.join(', ') || 'no commitment recorded'}`);
  }
}

// ---- 1. The goal -----------------------------------------------------------------
let goalSent = false;
if (signedIn && !takeOver) {
  goalSent = await step(1, 'goal', async () => {
    await page.goto(`${APP}/lead`);
    // The lead starts on the first request to its routes: wait until it is up.
    await until('the lead to start', async () => { const s = await api<LeadState>('/lead'); return s.phase === 'idle' || s.phase === 'working' ? s : undefined; }, 5 * 60_000, 2_000);
    await page.reload();
    await page.locator('#goal-toggle').click();
    await page.locator('#goal-toggle[aria-pressed="true"]').waitFor();
    await page.locator('#reply-text').fill(GOAL);
    times.goal_sent_at = now();
    await page.locator('#reply-send').click();
    gesture('gave the goal on the lead screen');
    await page.locator('#thread .owner-row').filter({ hasText: GOAL.slice(0, 40) }).first().waitFor();
    return 'goal sent from the lead screen';
  });
}

// ---- 2. The lead's questions -----------------------------------------------------
let planned = false;
if (goalSent) {
  await step(2, 'questions', async () => {
    let asked = 0;
    for (;;) {
      // A question that waits, or the plan: whichever comes first.
      const next = await until('a question or a plan', async () => {
        const state = await api<LeadState>('/lead');
        if (state.pendingQuestion) return 'question' as const;
        const plans = await api<Plan[]>('/plans');
        return plans.some((p) => p.state === 'proposed' && !earlier.has(p.id)) ? 'plan' as const : undefined;
      }, 20 * 60_000);
      if (next === 'plan') break;
      asked++;
      times.first_question_at ??= now();
      await page.reload();
      const options = page.locator('#thread .bubble.question [data-answer]');
      await options.first().waitFor();
      const wanted = ANSWERS[asked - 1] ?? 'recommended';
      if (wanted === 'recommended') {
        const recommended = options.filter({ hasText: said('session', 'choice_recommended') });
        const button = (await recommended.count()) > 0 ? recommended.first() : options.first();
        const label = (await button.getAttribute('data-answer')) ?? '';
        await button.click();
        // A question of several choices, or one that takes several answers,
        // toggles its options and sends them with its own button (lane 13).
        const send = page.locator('#thread .bubble.question [data-choice-send]');
        if (await send.count() > 0) await send.first().click();
        answers.push({ at: now(), text: label });
      } else {
        await page.locator('#reply-text').fill(wanted);
        await page.locator('#reply-send').click();
        answers.push({ at: now(), text: wanted });
      }
      gesture(`answered question ${asked}`);
      await until('the answer to be taken', async () => !(await api<LeadState>('/lead')).pendingQuestion, 2 * 60_000);
    }
    return `${asked} question(s) answered`;
  });
  // ---- 3. The plan -------------------------------------------------------------
  planned = await step(3, 'plan', async () => {
    const proposed = await until('the plan', async () => (await api<Plan[]>('/plans')).find((p) => p.state === 'proposed' && !earlier.has(p.id)), 20 * 60_000);
    planId = proposed.id;
    plan = proposed;
    times.plan_proposed_at = proposed.proposedAt;
    await page.goto(`${APP}/lead`);
    await page.locator(`#plan-side [data-plan="${planId}"][data-state="proposed"]`).waitFor();
    const n = proposed.items.length;
    const lanes = proposed.items.map((i) => `${i.position}:${i.lane}${i.after.length ? ` after ${i.after.join(',')}` : ''}`).join('; ');
    // The plan's notification, when the ledger is read: it may follow the plan by a tick.
    let sent: string | undefined = 'skipped';
    if (!NOTIFICATIONS_SKIPPED) {
      sent = await until('the plan notification', async () => (LEDGER ? facts()?.notifications.firstAt.plan : 'not read'), 3 * 60_000, 5_000).catch(() => undefined);
      if (sent && sent !== 'not read') times.plan_notified_at = sent;
    }
    return `${n} items (${n >= 4 && n <= 6 ? 'within' : 'outside'} 4 to 6): ${lanes}; about ${proposed.totals.minutes} min, $${proposed.totals.costUsd.toFixed(2)}; notification ${sent ?? 'not seen'}`;
  });
  // Step 3's notification on the Mac, and every wait's, are not part of this run: recorded as skipped.
  if (NOTIFICATIONS_SKIPPED) skip(3, 'notifications', NOTIFICATIONS_SKIPPED);
}

// ---- 4. Approve, then tell the lead what it must not forget -----------------------
let approved = false;
if (planned) {
  approved = await step(4, 'approve', async () => {
    await page.locator('#plan-side [data-plan-action="approve"]').click();
    times.approved_at = now();
    gesture('approved the plan on the lead screen');
    await page.locator(`#plan-side [data-plan="${planId}"][data-state="approved"]`).waitFor({ timeout: 120_000 });
    const first = await until('the first ticket to start', async () => {
      const p = await api<Plan>(`/plans/${planId}`);
      return p.items.some((i) => i.state === 'running') ? p : undefined;
    }, 10 * 60_000);
    times.first_start_at = now();
    const running = first.items.filter((i) => i.state === 'running').length;
    await plant();
    await watch('evening');
    const memory = await api<LeadMemory>('/lead/memory');
    return `approved; first start ${running} running (at most ${plan?.maxParallel ?? 2}); ${memory.commitments.filter((c) => c.state === 'open').length} open commitments`;
  });
}

// ---- 1 to 4, a plan taken over (issue 285) -----------------------------------------
// No goal, no question, no new plan: the owner gives a paused plan its
// Resume on the lead screen, as the gesture of step 4, and tells the lead
// the two things as after an approval. The runner starts the items put back
// at its next tick; a held or parked item waits for the lead's start_ticket.
if (takeOver) {
  for (const [n, name] of [[1, 'goal'], [2, 'questions'], [3, 'plan']] as const) skip(n, name, `took over plan ${takeOver.id}`);
  approved = await step(4, 'resume', async () => {
    planId = takeOver.id;
    let current = await api<Plan>(`/plans/${encodeURIComponent(planId)}`);
    const was = current.state;
    const items = Object.fromEntries(current.items.map((i) => [i.position, i.state]));
    await page.goto(`${APP}/plans/${encodeURIComponent(planId)}`);
    const panel = `#plan-side [data-plan="${planId}"]`;
    await page.locator(panel).waitFor();
    times.resumed_at = now();
    resumed = { planId, at: times.resumed_at, items };
    if (was === 'paused') {
      await page.locator(`${panel} [data-plan-action="resume"]`).click();
      gesture(`resumed plan ${planId} on the lead screen`);
      await page.locator(`${panel}[data-state="approved"]`).waitFor({ timeout: 120_000 });
      current = await api<Plan>(`/plans/${encodeURIComponent(planId)}`);
    }
    if (current.state !== 'approved') throw new Error(`plan ${planId} is ${current.state} after the take-over`);
    plan = current;
    await plant();
    await watch('evening');
    const memory = await api<LeadMemory>('/lead/memory');
    return `took over plan ${planId} (${was}${was === 'paused' ? ', resumed' : ''}); items then ${Object.entries(items).map(([n, state]) => `${n}:${state}`).join(' ')}; ${memory.commitments.filter((c) => c.state === 'open').length} open commitments`;
  });
}

// ---- 5. The night ------------------------------------------------------------------
if (approved) {
  await step(5, 'night', async () => {
    log(`the night until ${MORNING.toISOString()}, a reading every ${WATCH_MS / 1000} s`);
    while (Date.now() < MORNING.getTime() && Date.now() < DEADLINE) {
      await watch('night');
      // Said, never failed: the morning's gestures may unblock it.
      checkBlocked('night');
      await sleep(Math.min(WATCH_MS, Math.max(1_000, MORNING.getTime() - Date.now())));
    }
    const f = facts();
    const waits = Object.values(timeline.waits);
    return `${watchLog.length} changes seen; ${waits.length} waits, ${waits.filter((w) => !w.goneAt).length} still open; notifications ${NOTIFICATIONS_SKIPPED ? 'skipped' : f ? f.notifications.count : 'not read'}; most running at once ${timeline.maxRunning}`;
  });
} else {
  skip(5, 'night', 'no approved plan');
}

// ---- 6. The morning ----------------------------------------------------------------
if (approved) {
  await step(6, 'morning', async () => {
    const snap = await watch('morning');
    morning = morningSummary(snap, await thread(), times.approved_at ?? since());
    times.morning_at = snap.at;
    for (const screen of ['', 'inbox']) {
      await page.goto(`${APP}/${screen}`);
      await page.locator('#screen > *').first().waitFor();
      await capture(`morning-${screen || 'tower'}`);
    }
    return `waiting ${JSON.stringify(morning.waitingByKind)}; items ${JSON.stringify(morning.itemsByState)}; ${morning.nightMessages.length} night lines in the thread`;
  });
} else {
  skip(6, 'morning', 'no approved plan');
}

// ---- 7. The inbox, until the plan is done -----------------------------------------
const toEntry = (item: NextInboxItem): InboxEntry => ({
  id: item.id, kind: item.kind, ticket: item.ticket,
  ...(item.kind === 'permission' && item.input.kind === 'execute' ? { command: item.input.command } : {}),
  ...(item.kind === 'release' ? { checks: item.pr.checks } : {}),
  ...(item.kind === 'session_plan' ? { session: item.sessionId, confidence: item.plan.confidence } : {}),
});

async function openItem(id: string): Promise<void> {
  await page.goto(`${APP}/inbox`);
  const link = page.locator(`a.item[data-item="${id}"]`);
  await link.waitFor();
  await link.click();
  // The item's gestures: a request's three answers at the top of the detail (lane 37), the others' bar at its foot.
  await page.locator('#detail [data-act]').first().waitFor();
}

let planDoneAt: string | null = null;
if (approved) {
  await step(7, 'releases', async () => {
    const end = Math.min(DEADLINE, Date.parse(since()) + END_AFTER_GOAL_MS);
    let lastLeft = '';
    let lastSaid = Date.now();
    // A release approved here waits out its grace (60 s) before it leaves the
    // inbox: it is not approved again meanwhile.
    const approvedAt = new Map<string, number>();
    while (Date.now() < end) {
      const snap = await watch('morning');
      if (snap.plan?.state === 'done') { planDoneAt = snap.at; break; }
      const waiting = (await api<NextInboxItem[]>('/inbox')).filter((i) => i.state === 'waiting');
      left = leftForOwner(waiting.map(toEntry));
      const fresh = waiting.filter((i) => Date.now() - (approvedAt.get(i.id) ?? 0) > 5 * 60_000);
      const action = morningAction(fresh.map(toEntry), { releases: !OWNER_APPROVES, plan: !OWNER_APPROVES, questions: !OWNER_APPROVES });
      if (action.kind === 'wait') {
        const left = action.left.join(', ');
        // A line when what waits changes, and every 30 minutes while it does not (issue 285).
        if (left !== lastLeft || Date.now() - lastSaid >= 30 * 60_000) {
          log(`morning: nothing to do now${left !== lastLeft ? '' : `, as for ${duration(new Date(lastSaid).toISOString(), now())}`}${left ? `; waiting: ${left}` : ''}`);
          lastSaid = Date.now();
        }
        lastLeft = left;
        // A plan that cannot go on without someone else fails the step past
        // PROOF_STUCK_MINUTES, counted from when the blockage was first seen, the night included.
        const lasted = checkBlocked('morning');
        if (blocked && lasted >= STUCK_MS) {
          blocked.failed = true;
          throw new Error(`the plan is blocked since ${blocked.since}: ${blocked.line}`);
        }
        await sleep(REHEARSAL ? 5_000 : 60_000);
        continue;
      }
      blocked = null;
      await openItem(action.id);
      if (action.kind === 'permission') {
        await page.locator(`#detail [data-act="${action.decision}"]`).click();
        gesture(`${action.decision} for ${action.id}`);
      } else if (action.kind === 'session_plan') {
        await page.locator('#detail [data-act="plan_go"]').click();
        gesture(`gave the Go to the session plan ${action.id} in the inbox`);
      } else if (action.kind === 'plan') {
        await page.locator('#detail [data-act="approve_plan"]').click();
        gesture(`approved the plan from the inbox (${action.id})`);
      } else if (action.kind === 'question') {
        const item = waiting.find((i) => i.id === action.id);
        if (item?.kind === 'question') {
          const chosen = await answerInInbox(page, item.questions);
          const at = now();
          for (const choice of chosen) questions.push({ at, ticket: item.ticket, session: item.sessionId, ...choice });
          gesture(`answered the question of ${item.ticket} (${chosen.map((c) => `${c.how}: ${c.answer}`).join('; ')})`);
        }
      } else {
        // The card as it is shown: its intent groups and its flags (decision 23).
        const item = waiting.find((i) => i.id === action.id);
        if (item?.kind === 'release') {
          const shown = { groups: await page.locator('#detail [data-group]').count(), flags: await page.locator('#detail [data-flag]').count() };
          cards.push({ ticket: item.ticket, item: item.id, at: now(), groups: (item.groups ?? []).map((g) => ({ intent: g.intent, files: g.files.length })), flags: (item.flags ?? []).map((f) => f.kind), shown });
          log(`morning: the card of ${item.ticket} shows ${shown.groups} groups and ${shown.flags} flags`);
        }
        await page.locator('#detail [data-act="approve"]').click();
        gesture(`approved ${action.id}`);
        approvedAt.set(action.id, Date.now());
        const said = (await page.locator('#d-note').innerText().catch(() => '')).trim();
        if (said) log(`morning: the inbox says: ${said}`);
        // The approval is written after the grace; the next one need not wait for it.
        await page.getByRole('button', { name: /Undo|Annuler/ }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
        await capture('release-approved');
      }
      // The readings go on meanwhile, so no landing is seen late.
      await until('the item to leave the inbox', async () => {
        await watch('morning');
        return !(await api<NextInboxItem[]>('/inbox')).some((i) => i.id === action.id && i.state === 'waiting');
      }, 3 * 60_000, 2_000).catch(() => undefined);
    }
    if (!planDoneAt) throw new Error(`the plan is not done: ${JSON.stringify(last?.plan?.items.map((i) => `${i.position}:${i.state}`))}`);
    return `plan done at ${planDoneAt}`;
  });
} else {
  skip(7, 'releases', 'no approved plan');
}

// ---- 8. What the lead remembers ---------------------------------------------------
let leadState: LeadState | undefined;
let memory: LeadMemory | undefined;
if (approved) {
  await step(8, 'lead-memory', async () => {
    // The real proof reads it 48 hours after the goal; the rehearsal once the
    // reminder had its time and the plan is done (or the run's time is up).
    // A plan that step 7 found blocked is read at once: waiting out the hours left is the same idle loop (issue 285).
    const at = blocked?.failed ? Date.now() : REHEARSAL ? Math.max(MORNING.getTime() + 30_000, Date.now()) : Date.parse(since()) + END_AFTER_GOAL_MS;
    while (Date.now() < Math.min(at, DEADLINE)) {
      await watch('day');
      await sleep(Math.min(WATCH_MS, Math.max(1_000, at - Date.now())));
    }
    if (REHEARSAL) await until('the reminder', async () => (await api<LeadMemory>('/lead/memory')).commitments.some((c) => c.due !== null && c.state === 'done'), 2 * 60_000, 5_000).catch(() => undefined);
    leadState = await api<LeadState>('/lead');
    memory = await api<LeadMemory>('/lead/memory');
    await page.goto(`${APP}/lead`);
    await page.locator('#lead-remember').click();
    await page.locator('#lead-memory > *').first().waitFor();
    const outcomes = commitmentOutcomes(memory.commitments, planted);
    return `${blocked?.failed ? 'read at once, the plan being blocked; ' : ''}${leadState.refreshCount} refreshes, highest share ${leadState.highestPercent ?? '?'} %; ${outcomes.map((o) => `${o.key} ${o.state}`).join(', ')}`;
  });
} else {
  skip(8, 'lead-memory', 'no approved plan');
}

// ---- the report ---------------------------------------------------------------------
// Every "after" of the plan kept, "3 after 2" among them.
function orders(): Outcome {
  const checks = (plan?.items ?? []).flatMap((item) => item.after.map((after) => ({ item: item.position, after, outcome: orderCheck(timeline, item.position, after, resumed?.items) })));
  if (checks.length === 0) return { state: 'open', note: 'the plan has no "after"' };
  const state = checks.some((c) => c.outcome.state === 'broken') ? 'broken' : checks.every((c) => c.outcome.state === 'done') ? 'done' : 'open';
  return { state, note: checks.map((c) => `${c.item} after ${c.after}: ${c.outcome.state} (${c.outcome.note})`).join('; ') };
}

try {
  leadState ??= await api<LeadState>('/lead');
  memory ??= await api<LeadMemory>('/lead/memory');
} catch { /* the app is gone: the report says what it has */ }
const f = facts();
// The ledger knows when each ticket's first session started and when its
// release was seen healthy, which a reading every few minutes may miss: the
// earlier of the two times is kept.
if (f) {
  for (const item of Object.values(timeline.items)) {
    const ticket = item.ticket ? f.tickets[item.ticket] : undefined;
    for (const [state, at] of [['running', ticket?.startedAt], ['landed', ticket?.landedAt]] as const)
      if (at && (!item.states[state] || at < (item.states[state] as string))) item.states[state] = at;
  }
  timeline.maxRunning = Math.max(timeline.maxRunning, f.maxLive);
}
const result: ProofResult = {
  mode: REHEARSAL ? 'rehearsal' : 'real', app: APP, goal: GOAL, startedAt: startedAt.toISOString(), steps, times, answers,
  plan: plan ? { id: plan.id, title: plan.title, items: plan.items.map((i) => ({ position: i.position, title: i.title, lane: i.lane, after: i.after, minutes: i.estimate.minutes, costUsd: i.estimate.costUsd })), totals: plan.totals } : null,
  items: timeline.items, maxRunning: timeline.maxRunning, waits: timeline.waits, morning,
  lead: {
    refreshCount: leadState?.refreshCount ?? 0, highestPercent: highestShare(f?.lead.highestPercent, leadState?.highestPercent),
    threshold: REHEARSAL ? 5 : Number(env.CLEARED_V2_LEAD_CONTEXT_PERCENT ?? 50), generations: f?.lead.generations ?? null, turns: f?.lead.turns ?? null,
    costUsd: f?.lead.costUsd ?? null, compactions: f?.lead.compactions ?? null,
  },
  commitments: commitmentOutcomes(memory?.commitments ?? [], planted), order: orders(), notifications: f?.notifications ?? null, tickets: f?.tickets ?? {},
  gestures, planDoneAt, stand_ins: world?.standIns ?? [],
  notificationsSkipped: NOTIFICATIONS_SKIPPED, loginCuts: f?.loginCuts ?? null,
  sessionPlans: ledger((db) => sessionPlanFacts(db, since())) ?? [], cards, leftForOwner: left,
  resumed, blocked: reportBlocked(),
};
const durations = join(OUT, 'durations.md');
writeFileSync(durations, renderDurations(result));
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
// A run started in the background says by its exit whether a step failed; a skipped step does not (review 1, F4).
process.exitCode = counted('failed') > 0 ? 1 : 0;
