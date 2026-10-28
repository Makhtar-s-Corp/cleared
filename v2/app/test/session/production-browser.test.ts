// The production page of a resolved ticket in a real browser (P218, issue
// #334), on the fixtures source with its resolved story (fixtures/cost.ts):
// the session screen of a Done ticket says, on the ticket card, when the
// production page was captured once its release landed healthy, as the
// service's own reader finds it in the story's ledger, and links the capture
// through the app, in a new tab; in English and in French, with no
// horizontal scroll on a phone. With CLEARED_V2_SHOTS set to a folder it
// writes the card's captures there, at 1440, 1280, 768 and 390 pixels,
// light.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/session/production-browser.test.ts
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

type Options = { language: 'en' | 'fr'; width?: number; scheme?: 'light' | 'dark' };

async function withBrowser(options: Options, run: (page: any) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW, resolved: true }), extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris', colorScheme: options.scheme ?? 'light' });
    // Dark is the app's own choice (its button keeps it in localStorage), never the system's.
    await context.addInitScript((value: string) => { try { (globalThis as any).localStorage.setItem('cleared-v2-theme', value); } catch { /* no storage */ } }, options.scheme ?? 'light');
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
    await page.locator('#s-left [data-ticket-production]').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const said = async (page: any) => ((await page.locator('#s-left [data-ticket-production] .fact').allInnerTexts()) as string[]).map((fact) => fact.replace(/\s+/g, ' ').trim());
// The check's time as the page's clock says it, in the browser's zone.
const time = (page: any) => page.evaluate(async (ticket: string) => {
  const [check] = await (await fetch(`/api/service/tickets/${encodeURIComponent(ticket)}/production`)).json();
  const d = new Date(check.at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}, RESOLVED_TICKET);
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = async (page: any, name: string) => { if (SHOTS) await page.locator('#s-left > .card:first-child').screenshot({ path: join(SHOTS, `${name}.png`) }); };

test('the ticket card of a resolved ticket says when its production page was captured, and opens the capture through the app in a new tab', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    assert.deepEqual(await said(page), [`Production page captured at ${await time(page)}, after the release landed healthy`, 'See the capture']);
    const link = page.locator('#s-left [data-ticket-production] a');
    const href = await link.getAttribute('href');
    assert.equal(href, `/api/service/tickets/${RESOLVED_TICKET}/proof/guestbook/production.png`);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    const capture = await page.evaluate(async (path: string) => { const answer = await fetch(path); return { status: answer.status, type: answer.headers.get('content-type') }; }, href);
    assert.deepEqual(capture, { status: 200, type: 'image/png' });
    // The cost's facts stay as P211 drew them, above.
    assert.equal(await page.locator('#s-left [data-ticket-cost] + [data-ticket-production]').count(), 1);
    assert.ok(await noOverflow(page));
  });
});

test('in French, and on a phone without a horizontal scroll', { skip }, async () => {
  await withBrowser({ language: 'fr', width: 390 }, async (page) => {
    assert.deepEqual(await said(page), [`Page de production capturée à ${await time(page)}, après une mise en ligne saine`, 'Voir la capture']);
    assert.ok(await page.locator('#s-left [data-ticket-production]').isVisible(), 'the line is on the ticket card the phone shows first');
    assert.ok(await noOverflow(page), 'no horizontal scroll at 390');
  });
});

test('the card at four widths, and in French: the line drawn, no horizontal scroll (the captures with CLEARED_V2_SHOTS)', { skip }, async () => {
  for (const width of [1440, 1280, 768, 390])
    for (const scheme of ['light'] as const)
      await withBrowser({ language: 'en', width, scheme }, async (page) => {
        assert.ok(await noOverflow(page), `no horizontal scroll at ${width}`);
        await shot(page, `post-deploy-en-${width}-${scheme}`);
      });
  for (const width of [1440, 390])
    await withBrowser({ language: 'fr', width }, async (page) => {
      assert.ok(await noOverflow(page), `no horizontal scroll at ${width} in French`);
      await shot(page, `post-deploy-fr-${width}-light`);
    });
});
