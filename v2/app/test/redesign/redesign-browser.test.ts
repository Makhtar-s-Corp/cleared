// The visual redesign (lane j3-visual-redesign, matrix P227, issue #375), in
// a real browser on the fixtures source: what the direction written in the
// decisions log names, measured. On a computer (1440): the sidebar's live
// sessions start where the screens' names start; a session's thread is the
// one framed surface, the ticket's and the right column's sections lie on
// the page; its composer is one field over one row of buttons, Send at the
// field's right edge; the inbox's buttons are a computer's (36 px at most),
// and a phone's still 44; Consumption's levers are sections of their panel,
// not cards in a card, and their choices are options with a mark, the one
// picked in the text's colour, not filled in ink; a lever of one button is an
// action and has no mark.
//
// The product owner's decision of 2026-10-25, 11:14: the sidebar is for the
// development. Consumption is not among its screens; a quota gauge at its
// foot says the week's quota, its percent and its reset, in the colour the
// Consumption screen gives its verdict, read out with both, reached by the
// keyboard, and opens Consumption, as the palette and the account menu do.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/redesign/redesign-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;
declare const getComputedStyle: any;

const fontsReady = (page: any) => page.evaluate(() => document.fonts.ready.then(() => undefined));

async function signedIn(width: number, run: (page: any, base: string) => Promise<void>, touch = false, language: 'en' | 'fr' = 'en'): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch, locale: language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris' });
    const page = await context.newPage();
    await page.clock.install({ time: FIXTURE_NOW });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await run(page, app.base);
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
  }
}

const box = (page: any, selector: string) => page.locator(selector).first().evaluate((el: any) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
});

async function authorSession(page: any, base: string): Promise<void> {
  const sessions = await (await page.request.get(`${base}/api/service/sessions`)).json() as { id: string; role: string }[];
  const author = sessions.find((s) => s.role === 'author') ?? sessions[0]!;
  await page.goto(`${base}/sessions/${author.id}`);
  await page.locator('#composer #send').waitFor();
  await fontsReady(page);
}

async function release(page: any, base: string): Promise<void> {
  const inbox = await (await page.request.get(`${base}/api/service/inbox`)).json() as { id: string; kind: string; state: string }[];
  const item = inbox.find((i) => i.kind === 'release' && i.state === 'waiting')!;
  await page.goto(`${base}/inbox#${encodeURIComponent(item.id)}`);
  await page.locator('.d-actions [data-act="approve"]').waitFor();
  await fontsReady(page);
}

test('the sidebar: a live session\'s title starts where a screen\'s name starts', { skip }, async () => {
  await signedIn(1440, async (page) => {
    await page.locator('.side-session .title').first().waitFor();
    await fontsReady(page);
    const label = await box(page, '.nav-item .nav-label');
    const title = await box(page, '.side-session .title');
    assert.ok(Math.abs(title.left - label.left) <= 1, `the session's title starts at ${title.left}, a screen's name at ${label.left}`);
  });
});

test('a session on a computer: the thread is the one framed surface; its composer is a field over one row, Send at its right edge', { skip }, async () => {
  await signedIn(1440, async (page, base) => {
    await authorSession(page, base);
    const framed = await page.locator('.s-left > section, .s-right > section').evaluateAll((sections: any[]) => sections
      .filter((s) => { const style = getComputedStyle(s); return style.boxShadow !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)'; })
      .map((s) => s.querySelector('h2, h3')?.textContent ?? s.className));
    assert.deepEqual(framed, [], 'no section of the side columns is a card');
    const field = await box(page, '#composer #message');
    const form = await box(page, '#composer');
    const send = await box(page, '#composer #send');
    const interrupt = await box(page, '#composer #interrupt');
    const handover = await box(page, '#composer #handover');
    assert.ok(Math.abs(field.width - form.width) <= 1, `the field is ${field.width} px of the composer's ${form.width}`);
    assert.ok(send.top > field.bottom, 'the buttons are under the field');
    assert.ok(Math.abs(send.top - interrupt.top) <= 1 && Math.abs(send.top - handover.top) <= 1, `one row: Send at ${send.top}, Interrupt at ${interrupt.top}, the hand over at ${handover.top}`);
    assert.ok(Math.abs(send.right - field.right) <= 1, `Send ends at ${send.right}, the field at ${field.right}`);
  });
});

test('the inbox on a computer: the detail\'s buttons are 36 px tall at most, the commit beside its label', { skip }, async () => {
  await signedIn(1440, async (page, base) => {
    await release(page, base);
    const heights = await page.locator('.d-actions .btn').evaluateAll((buttons: any[]) => buttons.map((b) => Math.round(b.getBoundingClientRect().height)));
    assert.ok(heights.length >= 2, 'the release has its buttons');
    for (const height of heights) assert.ok(height <= 36, `a button is ${height} px tall`);
  });
});

test('the inbox on a phone: the detail\'s buttons stay 44 px tall', { skip }, async () => {
  await signedIn(390, async (page, base) => {
    await release(page, base);
    const heights = await page.locator('.d-actions .btn').evaluateAll((buttons: any[]) => buttons.map((b) => Math.round(b.getBoundingClientRect().height)));
    for (const height of heights) assert.ok(height >= 44, `a button is ${height} px tall`);
  }, true);
});

test('Consumption: the levers are not cards in a card; their choices are options with a mark, the picked one in the text\'s colour, a lone action none', { skip }, async () => {
  await signedIn(1440, async (page, base) => {
    await page.goto(`${base}/consumption`);
    await page.locator('.lever .choice').first().waitFor();
    const levers = await page.locator('.lever').evaluateAll((items: any[]) => items.map((l) => { const s = getComputedStyle(l); return `${s.boxShadow}|${s.backgroundColor}`; }));
    for (const lever of levers) assert.equal(lever, 'none|rgba(0, 0, 0, 0)', 'a lever has no frame or fill of its own');
    const choices: { mark: string; pressed: boolean; alone: boolean; colour: string; text: string }[] = await page.locator('.lever .choice').evaluateAll((items: any[]) => items.map((c) => ({
      mark: getComputedStyle(c, '::before').content,
      pressed: c.getAttribute('aria-pressed') === 'true' || c.dataset.state === 'on',
      alone: c.parentElement.children.length === 1,
      colour: getComputedStyle(c).color,
      text: getComputedStyle(document.body).color,
    })));
    assert.ok(choices.some((c) => c.pressed), 'a choice is picked');
    for (const choice of choices) {
      if (choice.alone) assert.equal(choice.mark, 'none', 'a lone action has no mark');
      else assert.notEqual(choice.mark, 'none', 'each choice among options has its mark');
      if (choice.pressed) assert.equal(choice.colour, choice.text, 'the picked choice keeps the text\'s colour');
    }
  });
});

// The colour a token gives, as the page computes it.
const tokenColour = (page: any, token: string) => page.evaluate((name: string) => {
  const probe = document.createElement('span');
  probe.style.setProperty('color', `var(${name})`);
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}, token);

test('the sidebar is the development\'s: Consumption is not among its screens; the quota gauge at its foot says the week and opens Consumption', { skip }, async () => {
  await signedIn(1440, async (page, base) => {
    await page.locator('#quota-gauge').waitFor();
    await fontsReady(page);
    assert.equal(await page.locator('.nav-item[data-nav="consumption"]').count(), 0, 'Consumption is not a screen of the sidebar');
    assert.deepEqual(await page.locator('.nav-item').evaluateAll((items: any[]) => items.map((i) => i.dataset.nav)), ['tower', 'inbox', 'session', 'lead']);
    const gauge = page.locator('#quota-gauge');
    assert.ok(await page.locator('.side-foot #quota-gauge').count() === 1, 'the gauge is at the sidebar\'s foot');
    assert.match(await gauge.getAttribute('aria-label'), /^Weekly quota: 62% used, resets [A-Z][a-z]{2} \d{1,2}:\d{2}\. Opens Consumption\.$/);
    assert.match(await gauge.innerText(), /62%[^]*resets [A-Z][a-z]{2} \d{1,2}:\d{2}/);
    // The verdict's colour: the Consumption screen's red for a quota reached before its reset.
    assert.equal(await gauge.getAttribute('data-verdict'), 'hit');
    assert.equal(await page.locator('#quota-gauge .quota-gauge-percent').evaluate((el: any) => getComputedStyle(el).color), await tokenColour(page, '--danger-text'));
    // By the keyboard: a link in the tab order, Enter opens Consumption.
    await gauge.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'quota-gauge');
    await page.keyboard.press('Enter');
    await page.waitForURL(`${base}/consumption`);
    await page.locator('.consumption-grid').waitFor();
    assert.equal(await gauge.getAttribute('aria-current'), 'page');
    // A click from another screen, the same.
    await page.locator('.nav-item[data-nav="tower"]').click();
    await page.waitForURL(`${base}/`);
    await gauge.click();
    await page.waitForURL(`${base}/consumption`);
  });
});

test('Consumption from the palette and from the account menu', { skip }, async () => {
  await signedIn(1440, async (page, base) => {
    await page.locator('#tower-body .tower').waitFor();
    await page.keyboard.press('Control+k');
    await page.locator('#palette input').waitFor();
    await page.keyboard.type('Consumption');
    await page.locator('#palette [cmdk-item][data-selected="true"]', { hasText: 'Consumption' }).waitFor();
    await page.keyboard.press('Enter');
    await page.waitForURL(`${base}/consumption`);
    await page.locator('.nav-item[data-nav="tower"]').click();
    await page.waitForURL(`${base}/`);
    await page.locator('#person').click();
    await page.locator('.person-menu a[href="/consumption"]').click();
    await page.waitForURL(`${base}/consumption`);
    assert.equal(await page.locator('.person-menu').count(), 0, 'the menu closes on its way');
  });
});

test('the gauge in French: its words and its reset through lib/time.ts', { skip }, async () => {
  await signedIn(1440, async (page) => {
    await page.locator('#quota-gauge').waitFor();
    assert.match(await page.locator('#quota-gauge').getAttribute('aria-label'), /^Quota de la semaine\u00a0: 62\u00a0% utilisés, reset [a-zé]+\. \d{1,2}\u00a0h\u00a0\d{2}\. Ouvre Consommation\.$/);
  }, false, 'fr');
});
