// The captures of a proof receipt (issue #326, P210): Playwright opens the
// page of what the service's base runs (before: the origin of its
// `health_url`) and the page of the ticket's trial environment (after: the
// author's run sibling, through the service's preview route, with the
// app's proof as the preview listener sends it), takes a screenshot of
// each, and records a video of about 20 seconds of the flow on the after
// page: it scrolls down the page and back up.
//
// The after page is code the session wrote, run by a Chromium on the host.
// Each page may reach its own address only: every other request is
// aborted, every WebSocket closed and service workers blocked, so the page
// gets no network the session's container does not have, and the app's
// proof is added to the preview's own requests only, never sent elsewhere.
//
// The service has no runtime dependency (v2/README.md): playwright-core is
// loaded when a capture runs, from CLEARED_V2_PLAYWRIGHT when it names an
// installed one, else from v2's own development dependencies, and Chromium
// from CLEARED_V2_CHROME or Playwright's own. Without it, nothing is
// captured and the receipt says so. A capture never throws: what it could
// not take is named by a code, never by an error's text, since the text of
// a browser's error can hold an address or a token.
//
// The production page (P218, captureProduction) is opened the same way,
// once a release the human approved is deployed and its watch ended
// healthy: one screenshot of the address the project configures, read and
// never acted on. Its pages may send GET and HEAD requests to its own
// origin only, so a script or a form of the live page changes nothing there.
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, type ProductionCheck } from '../api/types.ts';
import type { PreviewTarget } from '../container/preview.ts';

export const PROOF_FILES = { before: 'before.png', after: 'after.png', video: 'flow.webm' } as const;
export const PRODUCTION_FILE = 'production.png';
export const FLOW_MS = 20_000;
const STEP_MS = 1000;
const PAGE_TIMEOUT_MS = 15_000;
const VIEWPORT = { width: 1280, height: 800 } as const;

export type ProofTarget = { readonly url: string; readonly headers?: Readonly<Record<string, string>> };

export type CaptureMissing = { readonly part: 'before' | 'after' | 'video'; readonly reason: 'no_browser' | 'no_before' | 'no_after' | 'failed' };
export type ProofCapture = {
  readonly before?: string;
  readonly after?: string;
  readonly video?: string;
  readonly videoMs?: number;               // how long the flow was recorded, measured
  readonly missing: readonly CaptureMissing[];
};

// What a capture uses of Playwright's Browser, BrowserContext and Page.
export interface ProofPage {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  readonly mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  video(): { saveAs(path: string): Promise<void> } | null;
}
export interface ProofRequest {
  url(): string;
  method?(): string;
  headers(): Record<string, string>;
}
export interface ProofRoute {
  continue(options?: { headers?: Record<string, string> }): Promise<void>;
  abort(): Promise<void>;
}
export interface ProofContext {
  newPage(): Promise<ProofPage>;
  route(url: string, handler: (route: ProofRoute, request: ProofRequest) => Promise<void>): Promise<void>;
  routeWebSocket(url: RegExp, handler: (socket: { close(): Promise<void> }) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
export interface ProofBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    recordVideo?: { dir: string; size: { width: number; height: number } };
    serviceWorkers: 'block';
  }): Promise<ProofContext>;
  close(): Promise<void>;
}

// The after page: a session's preview through the service's own route on
// loopback, with the proof that only the app holds.
export function previewAddress(server: { readonly host: string; readonly port: number }, target: PreviewTarget, proof: string): ProofTarget {
  const host = server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host;
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shown}:${server.port}/api/sessions/${encodeURIComponent(target.session)}/preview/${encodeURIComponent(target.key)}/`,
    headers: { [SERVICE_PROOF_HEADER]: proof },
  };
}

// Before: the page at the origin of the address the release watch probes,
// which runs the base; none when it is not a plain http(s) address.
export function proofTargets(service: { readonly healthUrl: string | null }, after: ProofTarget | undefined): { before?: ProofTarget; after?: ProofTarget } {
  let before: ProofTarget | undefined;
  if (service.healthUrl) {
    try {
      const url = new URL(service.healthUrl);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) before = { url: `${url.origin}/` };
    } catch { /* no address */ }
  }
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

// Playwright's Chromium, or undefined when playwright-core cannot be loaded.
export async function playwrightBrowser(env: NodeJS.ProcessEnv = process.env): Promise<ProofBrowser | undefined> {
  let chromium: { launch(options: Record<string, unknown>): Promise<ProofBrowser> };
  try {
    const from = env.CLEARED_V2_PLAYWRIGHT ? join(env.CLEARED_V2_PLAYWRIGHT, 'package.json') : import.meta.url;
    ({ chromium } = createRequire(from)('playwright-core') as { chromium: typeof chromium });
  } catch {
    return undefined;
  }
  try {
    return await chromium.launch({ headless: true, ...(env.CLEARED_V2_CHROME ? { executablePath: env.CLEARED_V2_CHROME } : {}) });
  } catch {
    return undefined;
  }
}

// A context whose pages reach `target` only, with its headers there;
// `reads`: with GET and HEAD requests only.
async function confine(context: ProofContext, target: ProofTarget, reads = false): Promise<void> {
  await context.route('**/*', async (route, request) => {
    if (!request.url().startsWith(target.url)) return route.abort();
    if (reads && !['GET', 'HEAD'].includes(request.method?.() ?? '')) return route.abort();
    return route.continue(target.headers ? { headers: { ...request.headers(), ...target.headers } } : undefined);
  });
  await context.routeWebSocket(/.*/, (socket) => socket.close());
}

async function quietly(run: () => Promise<unknown>): Promise<void> {
  try { await run(); } catch { /* already closed */ }
}

export async function captureProof(input: {
  readonly browser: ProofBrowser | undefined;
  readonly before?: ProofTarget | undefined;
  readonly after?: ProofTarget | undefined;
  readonly dir: string;
  readonly flowMs?: number;
  readonly now?: () => number;
}): Promise<ProofCapture> {
  const { browser, dir } = input;
  const now = input.now ?? Date.now;
  const flowMs = input.flowMs ?? FLOW_MS;
  if (!browser) {
    return {
      missing: [
        { part: 'before', reason: input.before ? 'no_browser' : 'no_before' },
        { part: 'after', reason: input.after ? 'no_browser' : 'no_after' },
        { part: 'video', reason: input.after ? 'no_browser' : 'no_after' },
      ],
    };
  }
  const missing: CaptureMissing[] = [];
  const out: { before?: string; after?: string; video?: string; videoMs?: number } = {};
  try {
    mkdirSync(dir, { recursive: true });
    if (!input.before) missing.push({ part: 'before', reason: 'no_before' });
    else {
      let context: ProofContext | undefined;
      try {
        context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
        await confine(context, input.before);
        const page = await context.newPage();
        await page.goto(input.before.url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
        await page.screenshot({ path: join(dir, PROOF_FILES.before), fullPage: true });
        out.before = PROOF_FILES.before;
      } catch {
        missing.push({ part: 'before', reason: 'failed' });
      } finally {
        const open = context;
        if (open) await quietly(() => open.close());
      }
    }

    if (!input.after) missing.push({ part: 'after', reason: 'no_after' }, { part: 'video', reason: 'no_after' });
    else {
      const raw = join(dir, '.video');
      let context: ProofContext | undefined;
      let video: ReturnType<ProofPage['video']> = null;
      let began = 0;
      let ended = 0;
      try {
        context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: raw, size: VIEWPORT }, serviceWorkers: 'block' });
        await confine(context, input.after);
        began = now();
        const page = await context.newPage();
        video = page.video();
        await page.goto(input.after.url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
        await page.screenshot({ path: join(dir, PROOF_FILES.after), fullPage: true });
        out.after = PROOF_FILES.after;
        // The flow: down the page for the first half, back up for the second.
        while (now() - began < flowMs) {
          await page.mouse.wheel(0, now() - began < flowMs / 2 ? 400 : -400);
          await page.waitForTimeout(STEP_MS);
        }
        ended = now();
      } catch {
        if (!out.after) missing.push({ part: 'after', reason: 'failed' });
      } finally {
        const open = context;
        if (open) await quietly(() => open.close());
      }
      // Playwright writes the video when its page closes.
      try {
        if (!video || !ended) throw new Error('no video');
        await video.saveAs(join(dir, PROOF_FILES.video));
        out.video = PROOF_FILES.video;
        out.videoMs = ended - began;
      } catch {
        missing.push({ part: 'video', reason: 'failed' });
      }
      rmSync(raw, { recursive: true, force: true });
    }
  } finally {
    await quietly(() => browser.close());
  }
  return { ...out, missing };
}

// What the production page's capture took: its file, or why it has none.
export type ProductionCapture = { readonly file: typeof PRODUCTION_FILE } | { readonly missing: 'no_browser' | 'failed' };

// One screenshot of the production page at `url`, its requests kept to
// reads of the page's own origin. Never throws; closes the browser.
export async function captureProduction(input: { readonly browser: ProofBrowser | undefined; readonly url: string; readonly dir: string }): Promise<ProductionCapture> {
  const { browser, url, dir } = input;
  if (!browser) return { missing: 'no_browser' };
  let context: ProofContext | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
    await confine(context, { url: `${new URL(url).origin}/` }, true);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.screenshot({ path: join(dir, PRODUCTION_FILE), fullPage: true });
    return { file: PRODUCTION_FILE };
  } catch {
    return { missing: 'failed' };
  } finally {
    const open = context;
    if (open) await quietly(() => open.close());
    await quietly(() => browser.close());
  }
}

// What the ticket says of a check, in the service's words (its comments are English).
export function productionComment(check: ProductionCheck): string {
  const page = `The production page of ${check.service} (${check.url})`;
  const landed = `after pull request #${check.pr} landed healthy`;
  const own = 'Cleared did not deploy it: the deploy is yours or your CI\'s.';
  switch (check.missing) {
    case null: return `${page} was captured ${landed}; the capture is on the ticket's card. ${own}`;
    case 'unwatched': return `The production page of ${check.service} was not opened after pull request #${check.pr} landed: the project has no health check, so Cleared cannot tell when the deploy is done. Set [release] health_url or health_command to have it captured.`;
    case 'no_browser': return `${page} was not captured ${landed}: no browser is installed on the server (CLEARED_V2_PLAYWRIGHT in v2/README.md).`;
    case 'failed': return `${page} could not be captured ${landed}. ${own}`;
  }
}
