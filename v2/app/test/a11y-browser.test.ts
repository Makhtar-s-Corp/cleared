// The app against WCAG 2.2 AA in a real browser (P224), on the fixtures
// source, in French and in English, at 1440 and 390 px; the page is light
// whatever the system's scheme or an old stored choice of a dark theme
// (issue #451: one theme, light):
//   - axe (axe-core, run in the page) finds no violation of the WCAG 2.0,
//     2.1 and 2.2 A and AA rules on the sign-in page, the tower, the inbox
//     with a release open, the sessions, a session and its Plan tab, a
//     resolved ticket's session, the plans, the consumption, a question to
//     the code, the command menu and the account menu; nor of four of its
//     best practices: a dialog has a name, a screen has its h1, every part
//     of the page is in a landmark, and no two landmarks share a name;
//   - the keyboard: Close opens its reason field and moves the focus there,
//     Keep brings it back to Close, and the outcome takes the focus once
//     the ticket is closed, on the session's page and in the inbox, where
//     the inbox's live line says it; the inbox's Send back moves it to its
//     question's Keep, and Keep back to Send back.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/a11y-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ASK_ID } from '../fixtures/ask.ts';
import { RESOLVED_AUTHOR_ID } from '../fixtures/cost.ts';
import { fixtureSource } from '../fixtures/source.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { PASSWORD, startApp } from './support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;
declare const window: any;

const LANGUAGES = ['fr', 'en'] as const;
type Language = typeof LANGUAGES[number];
// The system's scheme and the stored choice a page may come with: the app draws light under both.
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const;

// The rules of WCAG 2.2 AA, as axe tags them, and the four best practices this lane holds the app to.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const PRACTICES = ['aria-dialog-name', 'page-has-heading-one', 'region', 'landmark-unique'];

// WCAG 2.5.3 wants a control's visible label in its accessible name, and
// axe reads every piece of text inside the control as that label, glued
// together. These controls hold their label in their name, and some text
// that is not the label: the rows are named by their title and described by
// their kind, their line and their meta (app/web/test/tower/rows.test.tsx);
// the search button shows its shortcut's keys, the account button its
// avatar's letter, and Approve the short commit under its words (the full
// one is in its name). The rule runs on everything else.
const LABEL_IN_NAME = 'label-content-name-mismatch';
const NAMED_BY_LABEL = ['#palette-open', '#person', 'a.need.row', 'a.open.row', 'a.open.index-row', '#detail [data-act="approve"]'];

// axe-core is a dev dependency of v2 (pinned in package.json), read once.
let axe: string | undefined;
const axeSource = (): string => (axe ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));

type Violation = { id: string; impact: string; help: string; nodes: { target: string[]; failureSummary?: string }[] };

// axe is evaluated in the page through the protocol, not added as a script: the app's policy refuses an inline one.
async function violations(page: any): Promise<Violation[]> {
  if (!await page.evaluate(() => typeof window.axe === 'object')) await page.evaluate(axeSource());
  return page.evaluate(async ({ tags, practices, rule, named }: { tags: string[]; practices: string[]; rule: string; named: string[] }) => {
    const options = { resultTypes: ['violations'] };
    // The tags' rules as a run of them would pick them (none experimental or deprecated), and the practices, in one pass.
    const rules = window.axe.getRules(tags).filter((r: { ruleId: string; tags: string[] }) => r.ruleId !== rule && !r.tags.some((tag) => tag === 'experimental' || tag === 'deprecated'))
      .map((r: { ruleId: string }) => r.ruleId).concat(practices);
    const all = await window.axe.run(document, { ...options, runOnly: { type: 'rule', values: rules } });
    const label = await window.axe.run({ include: [document], exclude: named.map((selector) => [selector]) }, { ...options, runOnly: { type: 'rule', values: [rule] } });
    return [...all.violations, ...label.violations].map((v: Violation) => ({
      id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
    }));
  }, { tags: TAGS, practices: PRACTICES, rule: LABEL_IN_NAME, named: NAMED_BY_LABEL });
}

const said = (found: readonly Violation[]): string => found.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 4).map((n) => `    ${n.target.join(' ')}: ${(n.failureSummary ?? '').split('\n').slice(1).join(' ').trim()}`).join('\n')}`).join('\n');

async function withApp(language: Language, run: (browser: any, base: string) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW, resolved: true }), extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    await run(browser, app.base);
  } finally {
    await browser.close();
    await app.close();
  }
}

async function open(browser: any, language: Language, theme: string, viewport: { width: number; height: number }): Promise<{ page: any; errors: string[]; close(): Promise<void> }> {
  const context = await browser.newContext({ viewport, locale: language === 'fr' ? 'fr-FR' : 'en-US', colorScheme: theme === 'dark' ? 'dark' : 'light' });
  await context.addInitScript(`try { localStorage.setItem('cleared-v2-theme', '${theme}'); } catch {}`);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  return { page, errors, close: () => context.close() };
}

async function signIn(page: any, base: string): Promise<void> {
  await page.fill('#name', 'owner');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/`);
  await page.locator('#tower-body .tower').waitFor();
}

// Drawn: the screen's element, no placeholder left, the fonts in, and no
// animation running (a dialog fading in would be measured half drawn).
async function drawn(page: any, selector: string): Promise<void> {
  await page.locator(selector).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => document.getAnimations().every((animation: any) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
}

// Each place: where it is, and what says it is drawn; a step opens what the address alone does not.
type Place = { readonly name: string; readonly path?: string; readonly ready: string; readonly step?: (page: any) => Promise<void> };
const PLACES: readonly Place[] = [
  { name: 'tower', path: '/', ready: '#tower-body .tower' },
  { name: 'command menu', ready: '#palette [cmdk-input]', step: async (page) => { await page.keyboard.press('Control+k'); } },
  { name: 'inbox, a release open', path: '/inbox#release-158', ready: '#detail [data-act="approve"]' },
  { name: 'sessions', path: '/sessions', ready: '.index a.open' },
  { name: 'a session', path: '/sessions/fixture-1', ready: '.view-tabs [aria-selected="true"]' },
  { name: 'a session, Plan tab', ready: '#tab-plan:not([hidden]) .plan-tab', step: async (page) => { await page.click('#tab-plan-button'); } },
  { name: 'a resolved ticket', path: `/sessions/${RESOLVED_AUTHOR_ID}`, ready: '#s-left [data-ticket-cost]' },
  { name: 'plans', path: '/lead', ready: '[data-plan-action]' },
  { name: 'consumption', path: '/consumption', ready: '.consumption-grid' },
  // Picked without scrolling the page, as the other places are read from its top: a scroll puts the head under the phone's top bar.
  { name: 'the service map, a service picked', path: '/services', ready: '.services-impact [data-impact]', step: async (page) => { await page.locator('[data-service="filter-api"]').dispatchEvent('click'); } },
  { name: 'a question to the code', path: `/ask/${ASK_ID}`, ready: '#ask-title' },
  { name: 'account menu', path: '/', ready: '.person-menu', step: async (page) => { await page.click('#person'); } },
];

for (const language of LANGUAGES) {
  test(`${language}: no WCAG 2.2 AA violation on the main screens, at 1440 and 390 px, light under a dark system scheme too`, { skip }, async () => {
    await withApp(language, async (browser, base) => {
      const found: string[] = [];
      for (const theme of THEMES) {
        for (const viewport of WIDTHS) {
          const { page, errors, close } = await open(browser, language, theme, viewport);
          const at = `${theme === 'dark' ? 'a dark system scheme and an old dark choice' : 'light'}, ${viewport.width} px`;
          const check = async (name: string) => {
            // The paper as the light theme's token computes it, whatever the system's scheme or an old stored choice.
            const paper = await page.evaluate(() => {
              const probe = document.createElement('span');
              probe.style.setProperty('background-color', 'var(--canvas)');
              document.body.append(probe);
              const colour = getComputedStyle(probe).backgroundColor;
              probe.remove();
              return colour;
            });
            assert.deepEqual(await page.evaluate(() => [document.documentElement.lang, document.documentElement.dataset.theme, getComputedStyle(document.documentElement).colorScheme, getComputedStyle(document.body).backgroundColor]), [language, 'light', 'light', paper], `${name}, ${at}: the page in its language, light, on the paper`);
            assert.match(paper, /0\.938|rgb\(239, 240, 241\)/, `${name}, ${at}: the paper is the light theme's (#EFF0F1)`);
            assert.equal(await page.evaluate(() => { try { return localStorage.getItem('cleared-v2-theme'); } catch { return null; } }), null, `${name}, ${at}: an old choice of theme is forgotten`);
            const result = await violations(page);
            if (result.length > 0) found.push(`${name}, ${at}:\n  ${said(result)}`);
          };
          try {
            await page.goto(`${base}/login`);
            await drawn(page, '#name');
            await check('sign-in');
            await signIn(page, base);
            for (const place of PLACES) {
              if (place.path) await page.goto(`${base}${place.path}`);
              if (place.step) {
                await drawn(page, '#screen');
                await place.step(page);
              }
              await drawn(page, place.ready);
              await check(place.name);
              if (place.step && !place.path) await page.keyboard.press('Escape');
            }
            assert.deepEqual(errors, [], `${at}: no page error`);
          } finally {
            await close();
          }
        }
      }
      assert.deepEqual(found, [], `axe found:\n${found.join('\n')}`);
    });
  });
}

const focused = (page: any): Promise<string> => page.evaluate(() => {
  const element = document.activeElement;
  if (!element || element === document.body) return 'body';
  return element.id ? `#${element.id}` : element.getAttribute('data-act') ? `[data-act="${element.getAttribute('data-act')}"]` : element.tagName.toLowerCase();
});

const CLOSED: Record<Language, RegExp> = {
  fr: /^Fermé à \d\d:\d\d\. Rien n'a été fusionné\. La carte reste dans l'historique\.$/,
  en: /^Closed at \d\d:\d\d\. Nothing was merged\. The card stays in the history\.$/,
};

for (const language of LANGUAGES) {
  test(`${language}: Close by keyboard keeps the focus, on the session's page and in the inbox`, { skip }, async () => {
    await withApp(language, async (browser, base) => {
      const { page, errors, close } = await open(browser, language, 'light', WIDTHS[0]);
      try {
        await page.goto(`${base}/login`);
        await signIn(page, base);

        // The session's page: its ticket card's Close.
        await page.goto(`${base}/sessions/fixture-1`);
        await drawn(page, '#close-open');
        await page.focus('#close-open');
        await page.keyboard.press('Enter');
        assert.equal(await focused(page), '#close-message', 'Close moves the focus to the reason');
        await page.focus('#close-keep');
        await page.keyboard.press('Enter');
        assert.equal(await focused(page), '#close-open', 'Keep brings the focus back to Close');
        await page.keyboard.press('Enter');
        await page.keyboard.type(language === 'fr' ? 'Un ticket de répétition' : 'A rehearsal ticket');
        await page.focus('#close-send');
        await page.keyboard.press('Enter');
        await page.locator('#close-done').waitFor();
        assert.equal(await focused(page), '#close-done', 'the outcome takes the focus');
        assert.match((await page.locator('#close-done').innerText()).trim(), CLOSED[language]);

        // The inbox: a release's Send back asks once, then its Close.
        await page.goto(`${base}/inbox#release-158`);
        await drawn(page, '#detail [data-act="close"]');
        await page.focus('#detail [data-act="send_back"]');
        await page.keyboard.press('Enter');
        assert.equal(await focused(page), '[data-act="keep"]', 'Send back moves the focus to its question\'s first answer, Keep');
        await page.keyboard.press('Enter');
        assert.equal(await focused(page), '[data-act="send_back"]', 'Keep brings the focus back to Send back');
        await page.focus('#detail [data-act="close"]');
        await page.keyboard.press('Enter');
        assert.equal(await focused(page), '#close-message', 'Close moves the focus to the reason');
        await page.focus('#detail [data-act="close_keep"]');
        await page.keyboard.press('Enter');
        assert.equal(await focused(page), '[data-act="close"]', 'Keep brings the focus back to Close');
        await page.keyboard.press('Enter');
        await page.keyboard.type(language === 'fr' ? 'Un ticket de répétition' : 'A rehearsal ticket');
        await page.focus('#detail [data-act="close_send"]');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('#detail [data-act]'));
        assert.equal(await focused(page), '#detail', 'the detail that says the outcome takes the focus');
        assert.match((await page.locator('#inbox-live').innerText()).trim(), CLOSED[language], 'the live line says it');
        assert.deepEqual(errors, [], 'no page error');
      } finally {
        await close();
      }
    });
  });
}
