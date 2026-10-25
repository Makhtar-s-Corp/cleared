// The cost of a resolved ticket in a real browser (P211, issue #327), on the
// fixtures source with its resolved story (fixtures/cost.ts): the session
// screen of a Done ticket draws, on the ticket card, the cost the service's
// own ticketCost reads from the story's ledger, in English and in French,
// with no horizontal scroll on a phone. With CLEARED_V2_SHOTS set to a folder
// it writes the card's captures there.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/session/ticket-cost-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { RESOLVED_AUTHOR_ID, RESOLVED_TICKET } from '../../fixtures/cost.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const SHOTS = process.env.CLEARED_V2_SHOTS;
declare const document: any;

async function withBrowser(options: { language: 'en' | 'fr'; width?: number }, run: (page: any) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW, resolved: true }), extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris' });
    const page = await context.newPage();
    await page.clock.install({ time: FIXTURE_NOW });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/sessions/${RESOLVED_AUTHOR_ID}`);
    await page.locator('#s-left [data-ticket-cost]').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const said = async (page: any) => ((await page.locator('#s-left [data-ticket-cost]').innerText()) as string).replace(/\s+/g, ' ').trim();
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = async (page: any, name: string) => { if (SHOTS) await page.locator('#s-left').screenshot({ path: join(SHOTS, `${name}.png`) }); };

test('the ticket card of a resolved ticket says what its sessions used, as the ledger holds it', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    assert.equal(await said(page), 'Cost: 232,900 tokens · 32 min of agent work over 38 min · $1.03 API-equivalent, as the agents reported it');
    const cost = await page.evaluate(async (ticket: string) => (await fetch(`/api/service/tickets/${encodeURIComponent(ticket)}/cost`)).json(), RESOLVED_TICKET);
    assert.deepEqual(cost, { ticket: RESOLVED_TICKET, sessions: 2, turns: 2, tokens: 232_900, workMs: 32 * 60_000, elapsedMs: 38 * 60_000, costUsd: 1.03 });
    assert.ok(await noOverflow(page));
    await shot(page, 'ticket-cost-en-desktop');
  });
});

test('in French, and on a phone without a horizontal scroll', { skip }, async () => {
  await withBrowser({ language: 'fr', width: 390 }, async (page) => {
    assert.equal(await said(page), 'Coût : 232 900 jetons · 32 min de travail des agents sur 38 min · 1,03 $US en équivalent API, déclarés par les agents');
    assert.ok(await noOverflow(page), 'no horizontal scroll at 390');
    await shot(page, 'ticket-cost-fr-phone');
  });
});
