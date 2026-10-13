// Takes the pictures attached to the pull request: the tower and the porthole,
// light and dark, at 1440, 768 and 390 px wide, from the demonstration data.
//   npm install && node screenshots.mjs [output folder]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appServer } from './server.mjs';
import { demoSource } from './sources/demo.mjs';

const out = process.argv[2] ?? new URL('./screenshots', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const token = 'd'.repeat(64);
const server = appServer({ source: demoSource(), token, ranges: ['127.0.0.0/8'], pollMs: 500, heartbeatMs: 2000 });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const signIn = await fetch(`http://127.0.0.1:${port}/session`, { headers: { authorization: `Bearer ${token}` } });
const session = /cleared_app=([^;]+)/.exec(signIn.headers.get('set-cookie'))[1];

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
    if (width === 1440 && theme === 'light') {
      await page.click('#ph-close');
      await page.click('.card[data-id="EX-34"] button');
      await page.waitForSelector('.tests');
      await page.screenshot({ path: join(out, 'porthole-no-screen-light-1440.png') });
      server.close();
      server.closeAllConnections();
      await page.waitForSelector('#conn:not([hidden])', { timeout: 20000 });
      await page.screenshot({ path: join(out, 'connection-lost-light-1440.png') });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
    }
    await context.close();
  }
}
// The mockups of the design, rendered the same way (their font link is answered from the fonts the app serves, so nothing leaves this machine).
const fontCss = `@font-face{font-family:Geist;src:url(data:font/woff2;base64,${readFileSync(new URL('./public/fonts/Geist-Variable.woff2', import.meta.url)).toString('base64')}) format("woff2");font-weight:100 900}@font-face{font-family:"Geist Mono";src:url(data:font/woff2;base64,${readFileSync(new URL('./public/fonts/GeistMono-Variable.woff2', import.meta.url)).toString('base64')}) format("woff2");font-weight:100 900}`;
for (const [file, width, height] of [['tower', 1440, 900], ['porthole-phone', 390, 844]]) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: fontCss }));
  await page.goto(new URL(`./reference/${file}.html`, import.meta.url).href);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `reference-${file}.png`), fullPage: file === 'tower' });
  await context.close();
}
await browser.close();
server.close();
server.closeAllConnections();
console.log(`screenshots in ${out}`);
