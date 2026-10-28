// The assistant's first-ticket step in a real browser (docs/v2/milestone-5-plan.md,
// section 14), in English and in French: the app and the service's setup
// module on one scratch ledger, the step given the flow's engine on the
// fake harness (test/flow/support.ts), nothing real:
//   - the proposal in the page's language, one button to Todo;
//   - the ticket followed by the page on its own, through the author and
//     the review, to the approval waiting in the inbox (the inbox's link);
//   - approved and Done: live, the step done, the setup's summary shown;
//   - no policy violation, no page error, no missing key, axe finds nothing;
//   - with CLEARED_V2_CAPTURES=<folder>, the proposal and live are captured
//     at 1440, 1280, 768 and 390 px, in English, and at
//     1440 in French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/setup/first-ticket-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SETUP_CODE_LINE } from '../../../src/setup/code.ts';
import { STEPS } from '../../../src/setup/steps.ts';
import { firstTicketStep } from '../../../src/setup/steps/first-ticket.ts';
import { SETUP_TABLES } from '../../../src/setup/tables.ts';
import users from '../../../src/modules/users.ts';
import { applyTables } from '../../../src/store/db.ts';
import { serviceSource } from '../../src/proxy.ts';
import { SESSION_TABLES } from '../../src/session-cookie.ts';
import { REPORT_PASS, quickAuthor, reviewerScript, setup, until } from '../../../test/flow/support.ts';
import { FAST, PASSWORD, startSetup } from '../../../test/setup/support.ts';
import { startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
declare const document: any;
declare const window: any;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = [1440, 1280, 768, 390] as const;

let axe: string | undefined;
const axeSource = (): string => (axe ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
async function checked(page: any, what: string): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, `${what}: no missing key drawn`);
  assert.deepEqual(await page.evaluate(() => window.violations ?? []), [], `${what}: no policy violation`);
  if (!await page.evaluate(() => typeof window.axe === 'object')) await page.evaluate(axeSource());
  const found = await page.evaluate(async (tags: string[]) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: tags } });
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
  assert.deepEqual(found, [], `${what}: axe`);
}

async function capture(page: any, language: 'en' | 'fr', name: string): Promise<void> {
  if (!CAPTURES) return;
  mkdirSync(CAPTURES, { recursive: true });
  if (language === 'fr') {
    await page.screenshot({ path: join(CAPTURES, `${name}-1440-light-fr.png`), fullPage: true });
    return;
  }
  for (const theme of ['light']) {
    await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({ path: join(CAPTURES, `${name}-${width}-${theme}.png`), fullPage: true });
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function run(language: 'en' | 'fr'): Promise<void> {
  const flow = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  const steps = STEPS.map((step) => (step.id === 'first-ticket' ? firstTicketStep({ engine: () => flow.engine }) : step));
  const service = await startSetup({ env: { CLEARED_V2_APP_LANGUAGE: language }, steps });
  service.start();
  const code = SETUP_CODE_LINE.exec(service.lines.find((line) => SETUP_CODE_LINE.test(line)) ?? '')?.[1] ?? '';
  const db = new DatabaseSync(join(service.dir, 'ledger.db'));
  applyTables(db, [...users.tables, ...SESSION_TABLES, ...SETUP_TABLES]);
  const app = await startApp({ db, source: serviceSource({ url: service.base, proof: 'a'.repeat(64) }), extra: { language, setup: { db, env: service.env, params: FAST } } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event: any) => { (window.violations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`); });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));

    await page.goto(`${app.base}/setup`);
    await page.locator('#setup-code').waitFor();
    await page.fill('#setup-code', code);
    await page.fill('#setup-name', 'alex');
    await page.fill('#setup-password', PASSWORD);
    await page.click('[data-act="setup_owner"]');
    await page.locator('[data-owner-made]').waitFor();

    // The last step, opened by its address.
    await page.goto(`${app.base}/setup/first-ticket`);
    await page.locator('[data-first-ticket="proposal"]').waitFor();
    await checked(page, 'the proposal');
    assert.match(await page.locator('.first-ticket-card').innerText(), /README/);
    assert.equal(await page.locator('[data-act="first_ticket_move"]').count(), 1);
    await capture(page, language, 'first-ticket-proposal');

    // One click: in Todo, then followed on its own to the approval.
    await page.click('[data-act="first_ticket_move"]');
    await page.locator('[data-first-ticket]:not([data-first-ticket="proposal"])').waitFor();
    await until(() => flow.inbox.list().some((item) => item.kind === 'release' && item.state === 'waiting'), 'the release item', 8000);
    await flow.engine.settled();
    await page.locator('[data-first-ticket="approval"]').waitFor({ timeout: 15_000 });
    await checked(page, 'the approval');
    assert.equal(await page.locator('[data-stage="approval"]').getAttribute('aria-current'), 'step');
    assert.equal(await page.locator('a[href="/inbox"]').count(), 1);

    // Approved, merged, the watch over: live, the step done, the summary.
    const [ticket] = (await flow.tickets.list({ project: 'guestbook' })).filter((t) => t.id !== flow.ticket.id);
    assert.ok(ticket);
    await flow.tickets.recordApproval(ticket.id, { kind: 'human', id: 'u1' });
    await flow.tickets.move(ticket.id, 'Done', { kind: 'agents', id: 'cleared-v2' });
    await page.locator('[data-first-ticket="live"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-setup-summary]').waitFor();
    await checked(page, 'live');
    assert.equal(await page.locator('.setup-progress li[data-step="first-ticket"]').getAttribute('data-state'), 'done');
    assert.doesNotMatch(await page.locator('[data-setup-summary]').innerText(), /\d{4,} ?ms/);
    await capture(page, language, 'first-ticket-live');
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
    await flow.engine.close();
  }
}

test('the first ticket in English: proposed, moved to Todo in one click, followed to the approval, then live with the summary', { skip, timeout: 120_000 }, () => run('en'));
test('the same in French', { skip, timeout: 120_000 }, () => run('fr'));
