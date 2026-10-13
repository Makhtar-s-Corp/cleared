// Takes the pictures attached to the pull request: the tower and the porthole,
// light and dark, at 1440, 768 and 390 px wide, from the demonstration data.
//   npm install && node screenshots.mjs [output folder]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
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

const cache = join(process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright'));
const bundled = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium-')).map((d) => join(cache, d, 'chrome-linux64', 'chrome')).find(existsSync) : null;
const executablePath = process.env.CHROME_PATH || bundled || '/usr/bin/google-chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

for (const width of [1440, 768, 390]) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 1 });
    await context.addCookies([{ name: 'cleared_app', value: token, url: `http://127.0.0.1:${port}` }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('.card');
    await page.screenshot({ path: join(out, `tower-${theme}-${width}.png`), fullPage: width === 390 });
    await page.click('.card[data-id="EX-31"] button');
    await page.waitForSelector('.pair img');
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
await browser.close();
server.close();
server.closeAllConnections();
console.log(`screenshots in ${out}`);
