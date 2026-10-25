// The inbox on a phone (P217, issue #333): a 375 by 667 touch screen, in
// French and in English, on the inbox's fixtures source with a session plan
// waiting for its Go:
//   - the list fits the width, each waiting row a full-width target;
//   - the session plan's Go and Change, the release's Approve, Send back and
//     Close, and the lead plan's Approve are reached by a finger without
//     scrolling: the point at a button's centre is the button, not the
//     shell's bottom bar laid over it;
//   - the release's Approve keeps its words on one line, its commit under them;
//   - a tap on Go sends the Go, a tap on Approve starts the grace with Undo
//     in reach;
//   - scrolled to its end, the detail's last line stays above its buttons.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/inbox/mobile-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { inboxFixture, inboxSource, type InboxSource } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;
declare const window: any;

const PHONE = { width: 375, height: 667 } as const;
const LANGUAGES = ['fr', 'en'] as const;
type Language = typeof LANGUAGES[number];

const WORDS: Record<Language, { readonly kinds: readonly string[]; readonly go: RegExp; readonly approve: string; readonly undo: string; readonly grace: RegExp }> = {
  fr: {
    kinds: ['Mise en production', 'Autorisation', 'Plan de session', 'Plan', 'Question'],
    go: /^Go donné à .+\. L'auteur commence à écrire\.$/, approve: 'Approuver la mise en production', undo: 'Annuler', grace: /^Approbation dans \d+ s$/,
  },
  en: {
    kinds: ['Release', 'Permission', 'Session plan', 'Plan', 'Question'],
    go: /^Go given at .+\. The author starts writing\.$/, approve: 'Approve the release', undo: 'Undo', grace: /^Approving in \d+ s$/,
  },
};

type Item = { id: string; kind: string; state: string; sessionId?: string; ticket?: string };

async function onPhone(language: Language, run: (page: any, base: string, items: Item[], source: InboxSource) => Promise<void>): Promise<void> {
  // The grace is held for good: what this file checks is the tap and the countdown, not the write after it.
  const source = inboxSource(inboxFixture(FIXTURE_NOW, { sessionPlan: 'medium' }), { now: () => FIXTURE_NOW, later: () => undefined });
  const app = await startApp({ source, extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const errors: string[] = [];
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    const items = await (await page.request.get(`${app.base}/api/service/inbox`)).json() as Item[];
    await run(page, app.base, items, source);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const open = async (page: any, base: string, item: Item | undefined) => {
  assert.ok(item, 'the fixtures list the item');
  await page.goto(`${base}/inbox#${encodeURIComponent(item.id)}`);
  await page.locator('#detail [data-act]').first().waitFor();
  await page.waitForTimeout(100);
};
const waiting = (items: Item[], kind: string) => items.find((item) => item.kind === kind && item.state === 'waiting');

// Nothing wider than the screen: no sideways scroll.
const fitsWidth = (page: any): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// A finger on the button's centre lands on the button: it is on the screen, at least 44 px tall, and nothing lies over it.
const reachable = (page: any, selector: string): Promise<{ ok: boolean; why: string }> => page.locator(selector).first().evaluate((element: any) => {
  const box = element.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const hit = document.elementFromPoint(x, y);
  const what = hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}${hit.closest('nav, [id]')?.id ? ` in #${hit.closest('nav, [id]').id}` : ''}` : 'nothing';
  const ok = box.height >= 44 && box.left >= 0 && box.right <= window.innerWidth && y > 0 && y < window.innerHeight && !!hit && element.contains(hit);
  return { ok, why: `${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.left)},${Math.round(box.top)}; the point at its centre is ${what}` };
});

const assertReachable = async (page: any, selector: string, at: string) => {
  const result = await reachable(page, selector);
  assert.ok(result.ok, `${at}: ${selector} is reached by a finger (${result.why})`);
};

for (const language of LANGUAGES) {
  const words = WORDS[language];

  test(`${language}: the list on a 375 px phone fits the width, each waiting row a full-width target in its language`, { skip }, async () => {
    await onPhone(language, async (page, base) => {
      await page.goto(`${base}/inbox`);
      await page.locator('#inbox-list a.item').first().waitFor();
      assert.ok(await fitsWidth(page), 'no sideways scroll');
      const rows = await page.locator('#inbox-list section:first-of-type a.item').evaluateAll((links: any[]) => links.map((link) => {
        const box = link.getBoundingClientRect();
        return { width: box.width, height: box.height, right: box.right, kind: link.querySelector('.chip')?.innerText.trim() ?? '' };
      }));
      assert.deepEqual(rows.map((row: { kind: string }) => row.kind), words.kinds, 'the kinds, in the page\'s language');
      for (const row of rows) {
        assert.ok(row.height >= 44, `a row is ${row.height} px tall`);
        assert.ok(row.width >= PHONE.width - 32 - 1 && row.right <= PHONE.width, `a row is ${row.width} px wide, inside the screen`);
      }
    });
  });

  test(`${language}: the session plan's Go and Change are in reach on a 375 px phone, and a tap on Go sends it`, { skip }, async () => {
    await onPhone(language, async (page, base, items, source) => {
      const plan = waiting(items, 'session_plan');
      await open(page, base, plan);
      assert.ok(await fitsWidth(page), 'no sideways scroll');
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      for (const act of ['plan_change', 'plan_go']) await assertReachable(page, `#detail [data-act="${act}"]`, 'unscrolled');
      await page.locator('#detail [data-act="plan_go"]').tap();
      await page.locator('#detail .d-done').waitFor();
      assert.match((await page.locator('#detail .d-done').innerText()).trim(), words.go);
      assert.deepEqual(source.calls.map((call) => `${call.method} ${call.path}`), [`POST /api/sessions/${plan?.sessionId}/plan/go`]);
    });
  });

  test(`${language}: the release's Approve, Send back and Close are in reach on a 375 px phone, Approve on one line, and a tap starts the grace`, { skip }, async () => {
    await onPhone(language, async (page, base, items, source) => {
      const release = waiting(items, 'release');
      await open(page, base, release);
      assert.ok(await fitsWidth(page), 'no sideways scroll');
      for (const act of ['approve', 'send_back', 'close']) await assertReachable(page, `#detail [data-act="${act}"]`, 'unscrolled');
      // Its words on one line, the commit on the next: no word cut, no third line.
      const approve = page.locator('#detail [data-act="approve"]');
      const lines = await approve.evaluate((button: any) => {
        const label = [...button.childNodes].find((node: any) => node.nodeType === 3 || !node.classList?.contains('commit'));
        const range = document.createRange();
        range.selectNodeContents(label);
        return { label: range.toString().trim(), lines: new Set([...range.getClientRects()].map((rect: any) => Math.round(rect.top))).size };
      });
      assert.equal(lines.label, words.approve);
      assert.equal(lines.lines, 1, `"${lines.label}" on one line`);
      // Scrolled to its end, the detail's last line is above the buttons, which stay in reach.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(100);
      const last = await page.locator('#detail .d-body').evaluate((body: any) => body.lastElementChild.getBoundingClientRect().bottom);
      const bar = await page.locator('#detail .d-actions').evaluate((element: any) => element.getBoundingClientRect().top);
      assert.ok(last <= bar + 1, `the last line ends at ${Math.round(last)}, the buttons start at ${Math.round(bar)}`);
      for (const act of ['approve', 'send_back', 'close']) await assertReachable(page, `#detail [data-act="${act}"]`, 'scrolled to the end');
      await approve.tap();
      await page.locator('#detail .grace-text').waitFor();
      assert.match((await page.locator('#detail .grace-text').innerText()).trim(), words.grace);
      assert.equal((await page.locator('#detail [data-act="undo"]').innerText()).trim(), words.undo);
      await assertReachable(page, '#detail [data-act="undo"]', 'during the grace');
      assert.deepEqual(source.calls.map((call) => `${call.method} ${call.path}`), [`POST /api/tickets/${release?.ticket}/approve`]);
    });
  });

  test(`${language}: the lead plan's Approve is in reach on a 375 px phone`, { skip }, async () => {
    await onPhone(language, async (page, base, items) => {
      await open(page, base, waiting(items, 'plan'));
      assert.ok(await fitsWidth(page), 'no sideways scroll');
      await assertReachable(page, '#detail [data-act="approve_plan"]', 'unscrolled');
    });
  });
}
