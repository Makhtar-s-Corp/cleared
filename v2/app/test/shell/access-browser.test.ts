// The API access panel in a real browser (docs/v2/milestone-5-plan.md,
// section 8, C18), in English and in French: the person's menu opens it,
// a token is made and its value shown once, the list names it, Revoke
// takes it away, Esc closes the panel and gives the focus back to the
// menu's button; axe finds no violation of WCAG 2.2 AA. The app's other
// calls go to the fixtures; the tokens' go to the run module's own routes,
// through the app's proxy, as in the service. With CLEARED_V2_CAPTURES=<folder>,
// the panel with a token just made is captured at 1440, 1280, 768 and 390 px,
// light and dark, in English, and at 1440 in French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/shell/access-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defaultRegistry, dispatch, type App } from '../../../src/modules/registry.ts';
import { runRoutes } from '../../../src/run/routes.ts';
import { ApiTokens } from '../../../src/run/tokens.ts';
import { handle } from '../../../src/server.ts';
import { openStore } from '../../../src/store/db.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { serviceSource, type DataSource } from '../../src/proxy.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const PROOF = 'proof-of-the-access-browser-test';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
const WIDTHS = [1440, 1280, 768, 390] as const;
declare const document: any;
declare const window: any;

let axe: string | undefined;
const axeSource = (): string => (axe ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
async function violations(page: any): Promise<string[]> {
  if (!await page.evaluate(() => typeof window.axe === 'object')) await page.evaluate(axeSource());
  return page.evaluate(async (tags: string[]) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: tags } });
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
}

async function run(language: 'en' | 'fr'): Promise<void> {
  // The run module's routes over a ledger of their own, every person known.
  const store = openStore(':memory:');
  const tokens = new ApiTokens(store.db);
  const registry = { ...defaultRegistry(), users: { get: async (id: string) => ({ id, name: 'owner' }), list: async () => [] } };
  const service: App = { registry, tables: [], routes: runRoutes({ tokens: () => tokens, launcher: () => undefined, proof: () => PROOF }) };
  const upstream = createServer((request, response) => dispatch(service, request, response, handle));
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const tokenSource = serviceSource({ url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, proof: PROOF });
  const fixtures = await fixtureSource({ now: () => FIXTURE_NOW });
  const source: DataSource = {
    kind: 'fixtures',
    forward: (request, response, forward) => (forward.path.startsWith('/api/tokens') ? tokenSource : fixtures).forward(request, response, forward),
  };
  const app = await startApp({ source, extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event: any) => { (window.violations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`); });
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.origin });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.locator('#tower-body .tower').waitFor();

    await page.click('#person');
    await page.click('#access-open');
    const panel = page.locator('#access');
    await panel.waitFor();
    assert.equal(await panel.getAttribute('role'), 'dialog');
    assert.equal(await panel.getAttribute('aria-modal'), 'true');
    assert.match(await page.locator('#access-title').innerText(), language === 'fr' ? /Accès à l’API/ : /API access/);
    await page.waitForFunction(() => !document.querySelector('#access [aria-busy="true"]'));
    assert.match(await panel.innerText(), language === 'fr' ? /Aucun jeton pour l’instant/ : /No token yet/);

    // An empty name is refused in the page, before any call.
    await page.click('#access-make');
    assert.equal(await page.locator('#access-name').getAttribute('aria-invalid'), 'true');
    assert.equal(tokens.list(await ownerId(app)).length, 0);

    await page.fill('#access-name', 'CI');
    await page.click('#access-make');
    const value = page.locator('#access-value');
    await value.waitFor();
    const shown = await value.inputValue();
    assert.match(shown, /^clr_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(tokens.verify(shown)?.user, await ownerId(app), 'the value made is the person\'s');
    assert.equal(await page.locator('#access [data-revoke]').count(), 1);
    await page.click('#access-copy');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), shown);
    assert.deepEqual(await violations(page), [], 'axe, with the value shown');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    assert.deepEqual(await violations(page), [], 'axe, dark');
    for (const theme of CAPTURES ? ['light', 'dark'] : []) {
      await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
      for (const width of language === 'en' ? WIDTHS : [1440]) {
        if (language === 'fr' && theme === 'dark') continue;
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        mkdirSync(CAPTURES as string, { recursive: true });
        await page.screenshot({ path: join(CAPTURES as string, `access-${width}-${theme}${language === 'fr' ? '-fr' : ''}.png`) });
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.click('#access [data-revoke]');
    await page.waitForFunction(() => document.querySelectorAll('#access [data-revoke]').length === 0);
    assert.equal(tokens.verify(shown), undefined, 'revoked');
    assert.match(await page.locator('#access-said').innerText(), language === 'fr' ? /CI est révoqué/ : /CI is revoked/);
    assert.equal(await page.locator('#access-value').count(), 0, 'the value goes with its token');

    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.ok(await page.evaluate(() => document.activeElement?.id === 'person'), 'the focus is back on the menu\'s button');
    assert.deepEqual(errors, [], 'no page error');
    assert.deepEqual(await page.evaluate(() => window.violations ?? []), [], 'no policy violation');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
    store.close();
  }
}

declare const navigator: any;
async function ownerId(app: Awaited<ReturnType<typeof startApp>>): Promise<string> {
  return (await app.directory.list()).find((user) => user.name === 'owner')!.id;
}

test('the panel in English: make a token, see it once, revoke it, close with Esc', { skip }, () => run('en'));
test('the panel in French', { skip }, () => run('fr'));
