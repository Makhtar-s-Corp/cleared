// Captures the app's screens on the fixtures source, for the visual loop of
// the interface lanes (docs/v2/ui-overhaul-plan.md, sections 5 and U12):
// the app and its preview listener start in this process on ephemeral
// loopback ports (port 0: the kernel picks a free one, never 8787 to 8799),
// a throwaway account signs in through the page, and each screen is
// captured at each width in each theme, then everything is stopped.
//
//   node scripts/capture-screens.ts --out ../docs/v2/ui-overhaul/after/34
//     [--screens tower,inbox,sessions,session,lead,review] [--widths 1440,390] [--themes light,dark]
//     [--via load|click]
//
// --via load (the default) opens each screen's address as a page; --via
// click opens the tower, then reaches each screen by a click on a link of
// the page, which the app answers without a document load (lane 34): the
// two sets are the same pixels when switching changes nothing.
//
// The clock is the fixtures' (FIXTURE_NOW), in the source and in the page,
// so two runs on the same code give the same pixels. A page error or a
// request that leaves the app's and the preview's origins fails the run.
// playwright-core is v2's own dev dependency; CLEARED_V2_CHROME names
// another Chromium than the one it installed.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fixturePreview } from '../app/fixtures/session.ts';
import { fixtureSource } from '../app/fixtures/source.ts';
import { FIXTURE_NOW } from '../app/fixtures/tower.ts';
import { createPreviewHandler } from '../app/src/preview.ts';
import { PASSWORD, startApp } from '../app/test/support.ts';

export const WIDTHS: Readonly<Record<string, { readonly width: number; readonly height: number }>> = {
  1440: { width: 1440, height: 900 },
  1280: { width: 1280, height: 800 },
  768: { width: 768, height: 1024 },
  390: { width: 390, height: 844 },
};
export const SCREENS = ['tower', 'inbox', 'sessions', 'session', 'lead'] as const;
// Screens a lane asks for by name, outside the default set: a reviewer's
// session (lane 36, the ticket's view at its review).
export const EXTRA_SCREENS = ['review'] as const;
export type CaptureScreen = typeof SCREENS[number] | typeof EXTRA_SCREENS[number];
const ACCOUNT = 'owner';

// playwright-core is read untyped, as the proof scripts read it: its types need the DOM's,
// which the service's type check leaves out; so do the page's functions below.
const { chromium } = createRequire(import.meta.url)('playwright-core') as { chromium: any };
declare const document: any;
declare const requestAnimationFrame: (run: () => void) => number;

const list = (value: string | undefined, all: readonly string[]): string[] => (value ? value.split(',').map((v) => v.trim()).filter(Boolean) : [...all]);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function capture(options: { readonly out: string; readonly screens?: readonly string[]; readonly widths?: readonly string[]; readonly themes?: readonly string[]; readonly via?: 'load' | 'click' }): Promise<{ readonly files: string[]; readonly errors: string[]; readonly away: string[] }> {
  const screens = options.screens ?? SCREENS;
  const widths = options.widths ?? Object.keys(WIDTHS).reverse();
  const themes = options.themes ?? ['light', 'dark'];
  for (const s of screens) if (![...SCREENS, ...EXTRA_SCREENS].includes(s as CaptureScreen)) throw new Error(`unknown screen ${s}`);
  for (const w of widths) if (!WIDTHS[w]) throw new Error(`unknown width ${w}`);
  mkdirSync(options.out, { recursive: true });

  const preview = createServer();
  const previewBase = await listen(preview);
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { previewOrigin: previewBase } });
  preview.on('request', createPreviewHandler({ upstream: fixturePreview(), origin: previewBase, appOrigins: [app.origin] }));
  const errors: string[] = [];
  const away: string[] = [];
  const files: string[] = [];
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add(ACCOUNT, PASSWORD);
    for (const theme of themes) {
      for (const w of widths) {
        const context = await browser.newContext({ viewport: WIDTHS[w], deviceScaleFactor: 1, colorScheme: theme === 'dark' ? 'dark' : 'light' });
        await context.addInitScript((value: string) => { try { (globalThis as any).localStorage.setItem('cleared-v2-theme', value); } catch { /* no storage */ } }, theme);
        const page = await context.newPage();
        await page.clock.setFixedTime(FIXTURE_NOW);
        page.on('pageerror', (error: Error) => errors.push(`${w} ${theme}: ${error.message}`));
        page.on('request', (request: { url(): string }) => { if (!request.url().startsWith(app.base) && !request.url().startsWith(previewBase) && !request.url().startsWith('data:')) away.push(request.url()); });
        await page.goto(`${app.base}/login`);
        await page.fill('#name', ACCOUNT);
        await page.fill('#password', PASSWORD);
        await page.click('button[type=submit]');
        await page.waitForURL(`${app.base}/`);
        const sessions = await (await page.request.get(`${app.base}/api/service/sessions`)).json() as { id: string; role: string }[];
        const author = sessions.find((s) => s.role === 'author') ?? sessions[0];
        const reviewer = sessions.find((s) => s.role === 'reviewer') ?? sessions[0];
        const paths: Readonly<Record<CaptureScreen, string>> = {
          tower: '/', inbox: '/inbox', sessions: '/sessions', session: `/sessions/${author?.id ?? ''}`, lead: '/lead', review: `/sessions/${reviewer?.id ?? ''}`,
        };
        let documents = 0;
        page.on('load', () => { documents += 1; });
        for (const screen of screens) {
          const path = paths[screen as CaptureScreen];
          if (options.via === 'click') {
            const before = documents;
            await page.evaluate((href: string) => {
              const link = document.createElement('a');
              link.href = href;
              document.body.append(link);
              link.click();
              link.remove();
            }, path);
            await page.waitForURL(`${app.base}${path}`);
            if (documents !== before) errors.push(`${w} ${theme}: ${screen} loaded a document`);
          } else await page.goto(`${app.base}${path}`);
          await settle(page);
          const file = join(options.out, `${screen}-${w}-${theme}.png`);
          await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
          files.push(file);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await app.close();
    preview.closeAllConnections();
    await new Promise<void>((done) => preview.close(() => done()));
  }
  return { files, errors, away };
}

// The screen has drawn its data: no element busy, the fonts loaded, then
// two frames so the last layout is painted.
async function settle(page: any): Promise<void> {
  await page.waitForSelector('#screen > *', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null, undefined, { timeout: 10_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await page.waitForTimeout(250);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, screens: { type: 'string' }, widths: { type: 'string' }, themes: { type: 'string' }, via: { type: 'string' } } });
  if (values.via !== undefined && values.via !== 'load' && values.via !== 'click') {
    console.error('capture-screens: --via is load or click');
    process.exit(64);
  }
  if (!values.out) {
    console.error('capture-screens: --out <folder> is required');
    process.exit(64);
  }
  const result = await capture({ out: resolve(values.out), screens: list(values.screens, SCREENS), widths: list(values.widths, Object.keys(WIDTHS).reverse()), themes: list(values.themes, ['light', 'dark']), via: values.via === 'click' ? 'click' : 'load' });
  for (const file of result.files) console.log(file);
  for (const error of result.errors) console.error(`page error: ${error}`);
  for (const url of result.away) console.error(`request off the app's origin: ${url}`);
  if (result.errors.length > 0 || result.away.length > 0) process.exit(1);
}
