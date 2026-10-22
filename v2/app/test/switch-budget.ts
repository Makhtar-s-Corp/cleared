// The tab-switch budget's measure (docs/v2/ui-overhaul-plan.md, 2.1.8 and
// U5), shared by the browser test (budget-browser.test.ts) and by a lane
// that measures its "before": the same clicks and the same clock on any
// version of the app, whether a switch loads a document or not.
//
// A switch is a click on a link of the page (the header's tabs, a session's
// "Open session"), timed from the click's event to the first animation
// frame in which the next screen's data is drawn and visible. Both ends are
// read in the page as epoch milliseconds (performance.timeOrigin plus the
// page's clock), kept in sessionStorage so a document load between them
// does not lose them. Each run warms the five screens once, then makes
// twenty switches; it counts the documents loaded and the requests to
// /api/ made between a click and its paint, the long-lived streams aside
// (/events and /stream, which reconnect on their own schedule).

// What the page shows once a screen's data is drawn.
export const PAINTED: Readonly<Record<string, string>> = {
  tower: '#tower-body .tower',
  inbox: '.inbox .inbox-list',
  sessions: '.index .sessions, .index .empty',
  session: '.session:not([aria-busy]) #status',
  session2: '.session:not([aria-busy]) #status',
  lead: '.lead-screen:not([aria-busy])',
};

// The link a person clicks to reach each screen from the one before it.
export const LINKS: Readonly<Record<string, string>> = {
  tower: 'header nav a[href="/"]',
  inbox: 'header nav a[href="/inbox"]',
  sessions: 'header nav a[href="/sessions"]',
  session: '.index a.open[href^="/sessions/"]',
  session2: '.index .sessions > li:nth-child(2) a.open[href^="/sessions/"]',
  lead: 'header nav a[href="/lead"]',
};

// The order of a lap: each step is reachable from the one before it.
export const LAP: readonly string[] = ['inbox', 'sessions', 'session', 'lead', 'tower'];
// The browser job's lap, through two sessions, so the kept stack moves
// between them (review of 248, F10). The "before" of lane 34 was measured
// on LAP.
export const LAP_TWO: readonly string[] = ['inbox', 'sessions', 'session', 'sessions', 'session2', 'lead', 'tower'];

export type Run = { readonly times: number[]; readonly p95: number; readonly median: number; readonly documents: number; readonly requests: number[] };

// Installed in every document of the page before its own scripts; a frame
// (a sandboxed preview) and a document without storage are left alone.
export const PROBE = `(() => {
  if (window.top !== window) return;                   // the page, not a frame of it
  try { sessionStorage.length; } catch { return; }      // a document without storage (the blank page before the first)
  const now = () => performance.timeOrigin + performance.now();
  document.addEventListener('click', (event) => {
    if (sessionStorage.getItem('budget-expect')) sessionStorage.setItem('budget-click', String(performance.timeOrigin + event.timeStamp));
  }, true);
  const watch = () => {
    const expect = sessionStorage.getItem('budget-expect');
    if (expect && !sessionStorage.getItem('budget-painted')) {
      const found = [...document.querySelectorAll(expect)].some((el) => el.checkVisibility());
      if (found) sessionStorage.setItem('budget-painted', String(now()));
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
})();`;

export const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? NaN;
};

// The page is signed in and on the tower, with PROBE installed.
// `warmed` runs once the five screens were each drawn once, before the
// twenty switches that are counted.
export async function switchRun(page: any, switches = 20, warmed?: () => Promise<unknown>, lap: readonly string[] = LAP): Promise<Run> {
  const go = async (screen: string): Promise<{ time: number; requests: number }> => {
    let requests = 0;
    const count = (request: { url(): string }) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/') && !/\/(?:events|stream)$/.test(url.pathname)) requests += 1;
    };
    await page.evaluate((expect: string) => {
      sessionStorage.removeItem('budget-click');
      sessionStorage.removeItem('budget-painted');
      sessionStorage.setItem('budget-expect', expect);
    }, PAINTED[screen]);
    page.on('request', count);
    await page.click(LINKS[screen]);
    await page.waitForFunction(() => sessionStorage.getItem('budget-painted') !== null, undefined, { timeout: 15_000 });
    page.off('request', count);
    const time = await page.evaluate(() => {
      const value = Number(sessionStorage.getItem('budget-painted')) - Number(sessionStorage.getItem('budget-click'));
      sessionStorage.removeItem('budget-expect');
      return value;
    });
    return { time, requests };
  };
  for (const screen of lap) await go(screen);
  await warmed?.();
  let documents = 0;
  const loaded = () => { documents += 1; };
  page.on('load', loaded);
  const times: number[] = [];
  const requests: number[] = [];
  for (let i = 0; i < switches; i += 1) {
    const one = await go(lap[i % lap.length] as string);
    times.push(one.time);
    requests.push(one.requests);
  }
  page.off('load', loaded);
  return { times, p95: percentile(times, 95), median: percentile(times, 50), documents, requests };
}
