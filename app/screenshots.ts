// Takes the pictures attached to the pull request: the tower and the porthole,
// light and dark, at 1440, 768 and 390 px wide, from the demonstration data.
//   npm install && node screenshots.ts [output folder]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appServer } from './server.ts';
import { demoSource } from './sources/demo.ts';
import { createActions } from './lib/actions.ts';
import type { AddressInfo } from 'node:net';
import type { Passkey } from './lib/credentials.ts';


const out = process.argv[2] ?? new URL('./screenshots', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const token = 'd'.repeat(64);
// As `cleared app --demo` serves it: the answer form of a question is there (a gesture is written nowhere).
const source = demoSource();
let keys: Passkey[] = [];
const actions = createActions({ source, origin: '', owner: 'you', readPasskeys: () => keys, writePasskeys: (list) => { keys = list; }, run: async () => ({ ok: true }) });
const server = appServer({ source, token, ranges: ['127.0.0.0/8'], pollMs: 500, heartbeatMs: 2000, actions });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const signIn = await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
const session = /cleared_app=([^;]+)/.exec(signIn.headers.get('set-cookie')!)![1]!;

const cache = join(process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright'));
const bundled = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium-')).map((d) => join(cache, d, 'chrome-linux64', 'chrome')).find(existsSync) : null;
const executablePath = process.env.CHROME_PATH || bundled || '/usr/bin/google-chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

for (const width of [1440, 768, 390]) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1 });
    if (theme === 'dark') await context.addInitScript(() => { try { localStorage.setItem('cleared-theme', 'dark'); } catch { /* light */ } });
    await context.addCookies([{ name: 'cleared_app', value: session, url: `http://127.0.0.1:${port}` }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('.card');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `tower-${theme}-${width}.png`), fullPage: true });
    await page.click('.card[data-id="EX-31"] button');
    await page.waitForSelector('.device img');
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `porthole-${theme}-${width}.png`) });
    // A question: the whole of it, the team's recommendation, and the answer at hand.
    await page.click('#ph-close');
    await page.click('.card[data-id="EX-40"] button');
    await page.waitForSelector('.ph-question');
    await page.waitForSelector('#an-text');
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `porthole-question-${theme}-${width}.png`) });
    if (width === 1440 && theme === 'light') {
      await page.click('#ph-close');
      await page.click('.card[data-id="EX-34"] button');
      await page.waitForSelector('.tests');
      await page.screenshot({ path: join(out, 'porthole-no-screen-light-1440.png') });
      server.close();
      server.closeAllConnections();
      await page.waitForSelector('#conn:not([hidden])', { timeout: 20000 });
      await page.screenshot({ path: join(out, 'connection-lost-light-1440.png') });
      await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    }
    await context.close();
  }
}
// The mockups of the design, rendered the same way (they load the fonts from app/public/fonts, nothing from outside).
for (const [file, width, height] of [['tower', 1440, 900], ['porthole-phone', 390, 844]] as [string, number, number][]) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(new URL(`./reference/${file}.html`, import.meta.url).href);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `reference-${file}.png`), fullPage: file === 'tower' });
  await context.close();
}
await browser.close();
server.close();
server.closeAllConnections();
console.log(`screenshots in ${out}`);
