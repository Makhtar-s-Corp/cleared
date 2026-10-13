// Pictures of the three gestures on a phone, from the demonstration data, driven for real:
// a virtual authenticator (the browser's own test facility) holds the passkey, and every
// click goes through the same routes as on a phone. Nothing here bypasses the server.
//   npm install && node screenshots-actions.mjs [output folder]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import { appServer } from './server.mjs';
import { createActions } from './lib/actions.mjs';
import { demoSource } from './sources/demo.mjs';

const out = process.argv[2] ?? new URL('./screenshots', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const token = 'e'.repeat(64);
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function scenario(graceMs, run) {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const source = demoSource();
  let keys = [];
  const actions = createActions({ source, origin, owner: 'alex', graceMs, readPasskeys: () => keys, writePasskeys: (list) => { keys = list; }, run: async () => ({ ok: true, author: 'alex', verified: true }) });
  const server = appServer({ source, token, ranges: ['127.0.0.0/8', '::1/128'], pollMs: 500, heartbeatMs: 2000, actions, origin, owner: 'alex' });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const signIn = await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const session = /cleared_app=([^;]+)/.exec(signIn.headers.get('set-cookie'))[1];
  const cache = join(process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright'));
  const bundled = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium-')).map((d) => join(cache, d, 'chrome-linux64', 'chrome')).find(existsSync) : null;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || bundled || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'cleared_app', value: session, url: origin }]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
  const registerPasskey = async () => {
    await page.goto(`${origin}/register#${actions.mintGrant().grant}`);
    await page.click('#go');
    await page.waitForSelector('#err.success');
  };
  const open = async (id) => { await page.goto(`${origin}/`); await page.waitForSelector('.card'); await page.click(`.card[data-id="${id}"] button`); await page.waitForSelector('#ph-actions:not([hidden])'); await page.waitForTimeout(250); };
  try { await run({ page, shot, registerPasskey, open, source, origin }); } finally { await browser.close(); server.close(); server.closeAllConnections(); }
}

// The grace delay as it really is (sixty seconds), the version change and the missing passkey.
await scenario(60000, async ({ page, shot, registerPasskey, open, source }) => {
  await open('EX-31');
  await shot('gesture-no-passkey');
  await registerPasskey();
  await open('EX-31');
  await shot('gesture-clear-ready');
  await page.click('.act.ink');
  await page.waitForSelector('.grace');
  await page.waitForTimeout(2000);
  await shot('gesture-clear-grace');
  await page.click('.undo');
  await page.waitForSelector('.act.ink:not([disabled])');
  await page.waitForTimeout(250);
  await shot('gesture-clear-undone');
  source.newVersion('EX-31');
  await page.waitForSelector('.act-warn', { timeout: 15000 });
  await shot('gesture-new-version');
});

// A short delay, so that the picture after the write can be taken.
await scenario(3000, async ({ page, shot, registerPasskey, open }) => {
  await registerPasskey();
  await open('EX-31');
  await page.click('.act.ink');
  await page.waitForSelector('.act-note', { timeout: 20000 });
  await page.waitForTimeout(250);
  await shot('gesture-clear-written');
  await open('EX-31');
  await page.click('.act.ghost');
  await page.fill('#sb-text', 'Round the remaining amount to the cent, then ask me again.');
  await shot('gesture-sendback-form');
  await page.click('.act.ink');
  await page.waitForSelector('.act-note', { timeout: 10000 });
  await shot('gesture-sendback-written');
  await open('EX-39');
  await shot('gesture-answer-form');
  await page.click('.act-options .act');
  await page.waitForSelector('.act-note', { timeout: 10000 });
  await shot('gesture-answer-written');
});
console.log(`screenshots in ${out}`);
