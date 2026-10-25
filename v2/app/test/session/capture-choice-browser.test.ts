// The proof receipt's captures forced from the ticket in a real browser
// (P226, issue #368), on the fixtures source: the session screen's ticket
// card of a ticket in progress draws Auto, On and Off, Auto pressed; a click
// on Off saves the choice on the ticket through the service's route, and a
// reload shows it kept; in English and in French, with no horizontal scroll
// on a phone. With CLEARED_V2_SHOTS set to a folder it writes the card's
// captures there, at 1440, 1280, 768 and 390 pixels, light and dark.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/session/capture-choice-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TICKET_ID } from '../../fixtures/session.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const SHOTS = process.env.CLEARED_V2_SHOTS;
declare const document: any;

type Options = { language: 'en' | 'fr'; width?: number; scheme?: 'light' | 'dark' };

async function withBrowser(options: Options, run: (page: any) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language: options.language } });
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
    // The tower's author of the ticket in progress, as the source lists it.
    const author = await page.evaluate(async (ticket: string) => ((await (await fetch('/api/service/sessions')).json()) as { id: string; ticket: string; role: string }[]).find((s) => s.ticket === ticket && s.role === 'author')?.id, TICKET_ID);
    assert.ok(author, `an author of ${TICKET_ID} in the fixtures`);
    await page.goto(`${app.base}/sessions/${encodeURIComponent(author)}`);
    await page.locator('#s-left [data-ticket-captures]').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const buttons = (page: any): Promise<string[]> => page.locator('#s-left [data-ticket-captures] button').allInnerTexts();
const pressed = (page: any): Promise<string[]> => page.locator('#s-left [data-ticket-captures] button[aria-pressed="true"]').evaluateAll((all: any[]) => all.map((b) => b.dataset.captures));
const hint = async (page: any): Promise<string> => ((await page.locator('#s-left [data-ticket-captures] > p').first().innerText()) as string).trim();
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = async (page: any, name: string) => { if (SHOTS) await page.locator('#s-left > .card:first-child').screenshot({ path: join(SHOTS, `${name}.png`) }); };

test('the ticket card draws Auto, On and Off; Off is saved on the ticket and kept after a reload', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    assert.deepEqual(await buttons(page), ['Auto', 'On', 'Off']);
    assert.deepEqual(await pressed(page), ['auto']);
    assert.equal(await hint(page), 'Taken when the change touches a screen');
    await page.locator('#s-left [data-captures="off"]').click();
    await page.locator('#s-left [data-captures="off"][aria-pressed="true"]').waitFor();
    assert.equal(await hint(page), 'Never taken for this ticket');
    const kept = await page.evaluate(async (ticket: string) => (await fetch(`/api/service/tickets/${encodeURIComponent(ticket)}/captures`)).json(), TICKET_ID);
    assert.equal(kept.choice, 'off');
    assert.equal(typeof kept.by, 'string', 'the signed-in account\'s id, who chose');
    assert.ok(!Number.isNaN(Date.parse(kept.at)), 'and when');
    await page.reload();
    await page.locator('#s-left [data-captures="off"][aria-pressed="true"]').waitFor();
    assert.deepEqual(await pressed(page), ['off']);
  });
});

test('in French, and on a phone with no horizontal scroll', { skip }, async () => {
  await withBrowser({ language: 'fr', width: 390 }, async (page) => {
    assert.deepEqual(await buttons(page), ['Auto', 'Oui', 'Non']);
    assert.equal(await hint(page), 'Prises quand le changement touche un écran');
    await page.locator('#s-left [data-captures="on"]').click();
    await page.locator('#s-left [data-captures="on"][aria-pressed="true"]').waitFor();
    assert.equal(await hint(page), 'Prises quel que soit le changement');
    assert.ok(await noOverflow(page));
  });
});

test('the card\'s captures, when asked for', { skip: skip || (SHOTS ? false : 'CLEARED_V2_SHOTS is not set') }, async () => {
  for (const width of [1440, 1280, 768, 390])
    for (const scheme of ['light', 'dark'] as const)
      await withBrowser({ language: 'en', width, scheme }, async (page) => { await shot(page, `capture-choice-en-${width}-${scheme}`); });
  await withBrowser({ language: 'fr', width: 1440 }, async (page) => { await shot(page, 'capture-choice-fr-1440-light'); });
  await withBrowser({ language: 'fr', width: 390 }, async (page) => { await shot(page, 'capture-choice-fr-390-light'); });
});
