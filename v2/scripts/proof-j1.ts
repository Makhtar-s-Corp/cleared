// The milestone 1 proof, driven through the browser only, as the owner would
// (docs/v2/milestone-1-plan.md, section 1): sign in, create the demo ticket,
// watch the live session, send a message mid run, answer a risky permission
// request, see the review, approve the release, and see the change live on
// the guestbook. Every duration it reports is read from the app's screens
// (the Checks card, the timeline's times); the script's own clock only says
// when it saw each step.
//
//   node scripts/proof-j1.ts
//
// Settings, from the environment:
//   PROOF_APP_URL         the app (default http://127.0.0.1:8792)
//   PROOF_GUESTBOOK_URL   the deployed example (default http://127.0.0.1:8793)
//   PROOF_OWNER           the app user who approves (default owner)
//   PROOF_PASSWORD_FILE   a file holding the password; it is read, never printed
//   PROOF_OUT             where captures and results go (default /tmp/cleared-captures/j1/proof)
//   PROOF_PLAYWRIGHT      the folder of an installed playwright-core (not a dependency of v2)
//   PROOF_CHROME          the Chromium executable
//   PROOF_TIMEOUT_MINUTES how long the whole run may take (default 90)
//   PROOF_AUTHOR_URL      an author session already running: steps 2 to 4 are
//                         taken as done by an earlier run, and the run goes on there
// No trace and no video are recorded: a trace keeps what is typed, the password included.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const env = process.env;
const APP = (env.PROOF_APP_URL ?? 'http://127.0.0.1:8792').replace(/\/$/, '');
const GUESTBOOK = (env.PROOF_GUESTBOOK_URL ?? 'http://127.0.0.1:8793').replace(/\/$/, '');
const OWNER = env.PROOF_OWNER ?? 'owner';
const OUT = env.PROOF_OUT ?? '/tmp/cleared-captures/j1/proof';
const DEADLINE = Date.now() + Number(env.PROOF_TIMEOUT_MINUTES ?? 90) * 60_000;
const passwordFile = env.PROOF_PASSWORD_FILE;
if (!passwordFile || !env.PROOF_PLAYWRIGHT) {
  console.error('proof: set PROOF_PASSWORD_FILE and PROOF_PLAYWRIGHT');
  process.exit(64);
}

// The demo ticket, as the guestbook's README gives it.
const TITLE = 'The guestbook shows the newest entry first';
const DESCRIPTION = `The page lists the entries oldest first, so a new entry lands at the bottom, out of sight once the list is long. Show the newest entry at the top.

Acceptance criteria (a checklist, which the session screen reads as such):
- [ ] The page lists the entries from the newest to the oldest.
- [ ] A test adds three entries one after the other and checks that the list gives them back newest first.
- [ ] \`npm test\` and \`npm run typecheck\` pass.`;
// The message sent mid run. It asks for one command the policy sends to the
// human (rule delete.outside_ticket): the request reaching the inbox is what
// shows the session took the message into account.
const SCRATCH = '/tmp/cleared-proof-scratch';
const MESSAGE = `Note from the owner: before you finish, run exactly \`rm -r ${SCRATCH}\` once (a scratch folder; if it does not exist, that is fine, go on), and say in your final message that you got this note.`;

type Step = { n: number; name: string; status: 'ok' | 'failed' | 'skipped'; seenAt: string; note: string; capture?: string };
const steps: Step[] = [];
const appDurations: Record<string, string> = {};
const rounds: string[] = [];
const timeline: Record<string, string> = {};
// The sessions' own requests (not the one the message asks for), answered on
// the session screen as the owner would, each one listed: "Allow once" for
// work in the checkout, "Deny" for what installs or fetches something.
const otherRequests: { command: string; answer: 'allow_once' | 'reject_once'; at: string }[] = [];
const OUTSIDE = /\b(apt-get|apk|sudo|pip3?|curl|wget|ssh|npx|embedded-postgres)\b|\bnpm (i|install|add|view)\b/;
const REVIEW_ROUNDS = Number(env.PROOF_REVIEW_ROUNDS ?? 2);
let ticketId = env.PROOF_TICKET ?? '';
let authorUrl = env.PROOF_AUTHOR_URL ?? '';
let reviewerUrl = '';

const require = createRequire(join(env.PROOF_PLAYWRIGHT, 'package.json'));
const { chromium } = require('playwright-core') as { chromium: any };

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(env.PROOF_CHROME ? { executablePath: env.PROOF_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);

const left = (): number => Math.max(1_000, DEADLINE - Date.now());
const pad = (n: number): string => String(n).padStart(2, '0');

async function capture(n: number, name: string, target: any = page): Promise<string> {
  const file = join(OUT, `${pad(n)}-${name}.png`);
  await target.screenshot({ path: file, fullPage: true });
  chmodSync(file, 0o644);
  return file;
}

function record(step: Step): void {
  steps.push(step);
  console.log(`proof: ${pad(step.n)} ${step.name}: ${step.status} at ${step.seenAt}${step.note ? ` (${step.note})` : ''}`);
  save();
}

function save(): void {
  const file = join(OUT, 'result.json');
  writeFileSync(file, JSON.stringify({ app: APP, ticket: ticketId, author: authorUrl, reviewer: reviewerUrl, steps, appDurations, timeline, rounds, otherRequests }, null, 2) + '\n');
  chmodSync(file, 0o644);
}

// Runs one step; a failure is recorded with what the screen showed, and the
// steps that need it are skipped.
async function step(n: number, name: string, body: () => Promise<string>): Promise<boolean> {
  try {
    const note = await body();
    record({ n, name, status: 'ok', seenAt: new Date().toISOString(), note, capture: await capture(n, name) });
    return true;
  } catch (error) {
    let shot: string | undefined;
    try { shot = await capture(n, `${name}-failed`); } catch { /* the page is gone */ }
    record({ n, name, status: 'failed', seenAt: new Date().toISOString(), note: (error as Error).message.split('\n')[0] ?? '', ...(shot ? { capture: shot } : {}) });
    return false;
  }
}

function skip(n: number, name: string, why: string): void {
  record({ n, name, status: 'skipped', seenAt: new Date().toISOString(), note: why });
}

// The steps the Checks card lists, label to duration, for the session open on the page.
async function readSteps(): Promise<Record<string, string>> {
  const items = await page.locator('ul.steps li').all();
  const found: Record<string, string> = {};
  for (const item of items) {
    const parts = await item.locator('span').allInnerTexts();
    if (parts[0]) found[parts[0].trim()] = (parts[1] ?? '').trim();
  }
  return found;
}

// Waits until `done` answers true, answering on the way, on the session
// screen open, every request that waits for the owner and is not the one the
// message asked for: the session pauses on each, and the run would stall.
// The page is loaded again every 30 seconds, so a new session's tab shows.
async function waitAnswering(done: () => Promise<boolean>, timeout: number): Promise<void> {
  const until = Date.now() + timeout;
  let loaded = Date.now();
  for (;;) {
    if (await done()) return;
    if (Date.now() > until) throw new Error('timed out');
    const open = page.locator('#timeline [data-row="request"]').filter({ has: page.locator('[data-answer="allow_once"]:not([disabled])') });
    for (const request of await open.all()) {
      const text = (await request.innerText()).replace(/\s+/g, ' ').trim();
      if (text.includes(SCRATCH)) continue;
      const answer = OUTSIDE.test(text) ? 'reject_once' : 'allow_once';
      await request.locator(`[data-answer="${answer}"]`).click();
      otherRequests.push({ command: text.slice(0, 300), answer, at: new Date().toISOString() });
      console.log(`proof: ${answer} for a session request: ${text.slice(0, 120)}`);
      save();
    }
    if (Date.now() - loaded > 30_000) {
      await page.reload();
      await page.locator('#screen > *').first().waitFor();
      loaded = Date.now();
    }
    await page.waitForTimeout(3_000);
  }
}

// The ticket this run created, or the one of the session it resumed.
function ticketOf(): string {
  if (ticketId) return ticketId;
  throw new Error('the ticket id is not known: run from the start, or give PROOF_TICKET with PROOF_AUTHOR_URL');
}

async function rowTime(row: any): Promise<string> {
  const time = row.locator('time');
  return await time.count() > 0 ? (await time.first().getAttribute('datetime')) ?? '' : '';
}

// ---- 1. Sign in --------------------------------------------------------------
const signedIn = await step(1, 'sign-in', async () => {
  await page.goto(`${APP}/`);
  await page.locator('#name').fill(OWNER);
  await page.locator('#password').fill(readFileSync(passwordFile, 'utf8').trim());
  await Promise.all([page.waitForURL(`${APP}/`), page.locator('form.login-card button[type=submit], form.login-card [type=submit]').first().click()]);
  await page.locator('#ask-input').waitFor();
  return `signed in as ${OWNER}`;
});

// ---- 2. Create the ticket, and 3. it goes to Todo ---------------------------
let created = false;
if (signedIn && authorUrl) {
  skip(2, 'create-ticket', 'done by an earlier run');
  skip(3, 'todo', 'done by an earlier run');
  skip(4, 'live-session', `done by an earlier run: ${authorUrl}`);
  await page.goto(authorUrl);
  await page.locator('#timeline [data-row]').first().waitFor();
}
if (signedIn && !authorUrl) {
  created = await step(2, 'create-ticket', async () => {
    // The tower's bar takes a description when the app has the field; a
    // title alone otherwise, which the note says.
    await page.locator('#ask-input').fill(TITLE);
    const description = page.locator('#ask-body');
    const hasBody = await description.count() > 0;
    if (hasBody) await description.fill(DESCRIPTION);
    const answer = page.waitForResponse((r: any) => r.url().endsWith('/api/service/tickets') && r.request().method() === 'POST');
    await page.locator('#ask-input').press('Enter');
    const response = await answer;
    if (!response.ok()) throw new Error(`the app answered ${response.status()} to the new ticket`);
    const ticket = await response.json() as { id: string; status: string };
    ticketId = ticket.id;
    timeline.ticket_created_status = ticket.status;
    await page.locator('#ask-note').filter({ hasText: ticket.id }).waitFor();
    return `${ticket.id} created in ${ticket.status}${hasBody ? ', with the README description and criteria' : ', title only: the bar has no description field'}`;
  });
}
if (created) {
  await step(3, 'todo', async () => {
    // A ticket the app creates lands in Todo and starts at once (lane 7,
    // decision 1): there is no separate move. The tower shows it live.
    await page.locator(`a.open[href^="/sessions/"]`).first().waitFor({ timeout: 120_000 });
    return `created in ${timeline.ticket_created_status}: creating starts it, there is no separate move to Todo`;
  });
}

// ---- 4. Watch the live session ---------------------------------------------
let live = false;
if (created) {
  live = await step(4, 'live-session', async () => {
    await page.locator('a.open[href^="/sessions/"]').first().click();
    await page.waitForURL(/\/sessions\/[A-Za-z0-9_-]+$/);
    authorUrl = page.url();
    await page.locator('#timeline [data-row]').first().waitFor({ timeout: 300_000 });
    // Some work, not just the start: a few rows. The author may ask first.
    await waitAnswering(async () => await page.locator('#timeline [data-row]').nth(2).count() > 0, 300_000);
    timeline.first_row_at = await rowTime(page.locator('#timeline [data-row]').first());
    return `author session ${authorUrl.split('/').pop()}, first row at ${timeline.first_row_at}`;
  });
}

// ---- 5. Send a message mid run ----------------------------------------------
let sent = false;
if (live || (signedIn && authorUrl)) {
  sent = await step(5, 'message', async () => {
    const bubble = page.locator('#timeline [data-row="message"]').filter({ hasText: 'Note from the owner' });
    if (await bubble.count() === 0) {
      await page.locator('#message').fill(MESSAGE);
      timeline.message_sent_at = new Date().toISOString();
      await page.locator('#send').click();
    }
    await bubble.first().waitFor({ timeout: 60_000 });
    timeline.message_row_at = await rowTime(bubble.first());
    // Taken into account: the request for the command the message asked for,
    // waiting or answered (an answered request becomes its tool row).
    const request = page.locator('#timeline [data-row]:not([data-row="message"])').filter({ hasText: SCRATCH });
    await waitAnswering(async () => await request.count() > 0, left());
    timeline.message_acknowledged_at = new Date().toISOString();
    timeline.request_row_at = await rowTime(request.first());
    return `the session asked to run rm -r ${SCRATCH}, as the message asked`;
  });
}

// ---- 6. Answer the risky permission request in the inbox -------------------
let answered = false;
if (sent) {
  answered = await step(6, 'permission-inbox', async () => {
    await page.goto(`${APP}/inbox`);
    // The list names the ticket; the detail shows the command.
    const items = page.locator('a.item:not(.handled)').filter({ hasText: ticketOf() });
    try {
      await items.first().waitFor({ timeout: 20_000 });
    } catch {
      throw new Error('the inbox does not show the waiting request (the inbox screen is a stub before lane 10)');
    }
    let found = false;
    for (const item of await items.all()) {
      await item.click();
      if (await page.locator('#detail').getByText(SCRATCH).count() > 0) { found = true; break; }
    }
    if (!found) throw new Error('no inbox item shows the command the message asked for');
    await capture(6, 'permission-inbox-open');
    await page.locator('#detail [data-act="allow_once"]').click();
    timeline.permission_answered_at = new Date().toISOString();
    return 'allowed once from the inbox';
  });
  if (!answered) {
    // Not the plan's path, said as such: the session screen's own buttons.
    answered = await step(6, 'permission-session-fallback', async () => {
      await page.goto(authorUrl);
      // The session may ask for the command alone or fold it into another one.
      const request = page.locator('#timeline [data-row="request"]').filter({ hasText: SCRATCH }).first();
      const answered = page.locator('#timeline [data-row]:not([data-row="message"])').filter({ hasText: SCRATCH }).filter({ hasText: /Allowed once by|Denied by|Allowed in this project by/ });
      await waitAnswering(async () => await request.count() > 0 || await answered.count() > 0, 60_000);
      if (await request.count() === 0) return `already answered by an earlier run: ${(await answered.first().innerText()).replace(/\s+/g, ' ').slice(-60)}`;
      await request.locator('[data-answer="allow_once"]:not([disabled])').click();
      timeline.permission_answered_at = new Date().toISOString();
      await page.locator('#timeline').getByText(/Allowed once by/).first().waitFor();
      return 'answered on the session screen, not the inbox';
    });
  }
}

// ---- 7. The review and its verdict -----------------------------------------
let reviewed = false;
if (answered) {
  reviewed = await step(7, 'review', async () => {
    // A review that asks for changes reopens the author, then a new review
    // follows: the run waits for a pass, up to the flow's number of rounds.
    const judged = new Set<string>();
    for (;;) {
      await page.goto(authorUrl);
      const tab = page.locator('a.tab').filter({ hasText: /^Reviewer/ });
      let href = '';
      await waitAnswering(async () => {
        if (await tab.count() === 0) return false;
        href = (await tab.first().getAttribute('href')) ?? '';
        return !judged.has(href);
      }, left());
      Object.assign(appDurations, Object.fromEntries(Object.entries(await readSteps()).map(([k, v]) => [`author: ${k}`, v])));
      await capture(7, `author-before-review-${judged.size + 1}`);
      await page.goto(`${APP}${href}`);
      reviewerUrl = page.url();
      const verdict = page.locator('#timeline').getByText(/Review (passed|asked for changes), round/).first();
      // The reviewer's own requests are answered the same way.
      await waitAnswering(async () => await verdict.count() > 0, left());
      const text = (await verdict.innerText()).trim();
      rounds.push(text);
      save();
      if (/passed/.test(text)) return text;
      judged.add(href);
      await capture(7, `review-round-${judged.size}`);
      if (judged.size >= REVIEW_ROUNDS) throw new Error(`no pass after ${judged.size} rounds: ${rounds.join('; ')}`);
    }
  });
}

// ---- 8. Approve the release in the inbox -----------------------------------
let approved = false;
if (reviewed) {
  approved = await step(8, 'approve', async () => {
    await page.goto(`${APP}/inbox`);
    const approve = page.locator('#detail [data-act="approve"]');
    // This ticket's release: another ticket's, with the same title, may wait beside it.
    const item = page.locator('a.item:not(.handled)').filter({ hasText: 'Release' }).filter({ hasText: `${ticketOf()} · ` }).first();
    try {
      // The release waits until the branch is published and the lock asked.
      await waitAnswering(async () => {
        if (await item.count() > 0) return true;
        await page.reload();
        return false;
      }, Math.min(left(), 15 * 60_000));
      await item.click();
      await approve.waitFor({ timeout: 60_000 });
      if (await page.locator('#detail').getByText(ticketOf()).count() === 0) throw new Error('not this ticket');
    } catch {
      throw new Error('the inbox shows no release to approve for this ticket (the inbox screen is a stub before lane 10)');
    }
    timeline.release_seen_at = new Date().toISOString();
    await capture(8, 'release-card');
    // As a careful owner: approve once the checks are green. The lock queues
    // a release whose checks still run, and nothing in v2 retries the queue.
    const green = page.locator('#detail').getByText(/all checks green|checks green/);
    await waitAnswering(async () => {
      if (await green.count() > 0) return true;
      if (await page.locator('#detail').getByText(/checks failed/).count() > 0) throw new Error('the release card says the checks failed');
      await page.reload();
      await item.click();
      return false;
    }, Math.min(left(), 20 * 60_000));
    timeline.checks_green_seen_at = new Date().toISOString();
    await capture(8, 'release-checks-green');
    await approve.click();
    timeline.approved_at = new Date().toISOString();
    await page.getByRole('button', { name: /Undo/ }).first().waitFor({ timeout: 10_000 });
    await capture(8, 'approve-grace');
    // The grace: the approval is written after 60 seconds.
    await page.getByRole('button', { name: /Undo/ }).first().waitFor({ state: 'detached', timeout: 120_000 });
    return 'approved in the inbox; the 60 second Undo passed';
  });
}

// ---- 9. The change is live --------------------------------------------------
if (approved) {
  await step(9, 'live', async () => {
    // Two entries, one after the other: newest first once the change is live.
    const guest = await context.newPage();
    const stamp = Date.now().toString(36);
    const names = [`proof-a-${stamp}`, `proof-b-${stamp}`];
    for (const name of names) {
      await guest.goto(`${GUESTBOOK}/`);
      await guest.locator('input[name="name"]').fill(name);
      await guest.locator('textarea[name="message"], input[name="message"]').first().fill('milestone 1 proof');
      await Promise.all([guest.waitForURL(`${GUESTBOOK}/`), guest.locator('form [type=submit], form button').last().click()]);
    }
    for (;;) {
      await guest.goto(`${GUESTBOOK}/`);
      const text = await guest.locator('body').innerText();
      const a = text.indexOf(names[0] as string);
      const b = text.indexOf(names[1] as string);
      if (a >= 0 && b >= 0 && b < a) break;
      if (Date.now() > DEADLINE) throw new Error('the guestbook still lists the oldest entry first');
      await guest.waitForTimeout(15_000);
    }
    timeline.live_seen_at = new Date().toISOString();
    await capture(9, 'guestbook-live', guest);
    await guest.close();
    return 'the guestbook lists the newest entry first';
  });
} else {
  skip(9, 'live', 'no approval');
}

// ---- The app's measured steps ----------------------------------------------
for (const [who, url] of [['author', authorUrl], ['reviewer', reviewerUrl]] as const) {
  if (!url) continue;
  try {
    await page.goto(url);
    await page.locator('#checks-title').waitFor();
    // The reviewer's watch and approval steps fill in as the release goes on.
    Object.assign(appDurations, Object.fromEntries(Object.entries(await readSteps()).map(([k, v]) => [`${who}: ${k}`, v])));
    await capture(10, `checks-${who}`);
  } catch { /* recorded as missing below */ }
}
save();
await browser.close();
console.log(`proof: done, ${steps.filter((s) => s.status === 'ok').length} of ${steps.length} steps ok; results in ${join(OUT, 'result.json')}`);
