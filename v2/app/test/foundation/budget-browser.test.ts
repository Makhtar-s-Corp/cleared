// The tab-switch budget in a real browser (docs/v2/ui-overhaul-plan.md,
// 2.1.8 and U5, lane 34), on the fixtures source: twenty switches among the
// five screens, timed from the click to the first frame in which the next
// screen's data is drawn (switch-budget.ts). The median of the runs' p95 is
// under 100 ms, no switch loads a document, none asks more than one
// request, and after the first visit of each screen none draws a busy
// placeholder: the second visit draws the cache's value at once. In CI
// (CI=true) three runs, one slow run on a shared runner being forgiven;
// locally one. The numbers are printed as "measure" lines for the browser
// job's summary.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/foundation/budget-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';
import { PROBE, percentile, switchRun, type Run } from '../switch-budget.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const RUNS = process.env.CI === 'true' ? 3 : 1;
export const BUDGET_MS = 100;

// Any busy placeholder the screen draws, counted from the moment it is armed.
const BUSY_WATCH = `(() => {
  if (window.top !== window) return;
  const seen = { count: 0, armed: false };
  window.__busy = seen;
  new MutationObserver((records) => {
    if (!seen.armed) return;
    for (const record of records) {
      const nodes = record.type === 'attributes' ? [record.target] : [...record.addedNodes];
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('[aria-busy="true"]') || node.querySelector('[aria-busy="true"]')) seen.count += 1;
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
})();`;

test('twenty switches among the five screens: under 100 ms at p95, no document, at most one request, no placeholder on a second visit', { skip }, async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const runs: Run[] = [];
  const errors: string[] = [];
  try {
    await app.directory.add('owner', PASSWORD);
    for (let r = 0; r < RUNS; r += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(PROBE);
      await context.addInitScript(BUSY_WATCH);
      const page = await context.newPage();
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.goto(`${app.base}/login`);
      await page.fill('#name', 'owner');
      await page.fill('#password', PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForURL(`${app.base}/`);
      await page.locator('#tower-body .tower').waitFor();
      const run = await switchRun(page, 20, () => page.evaluate(() => { (window as unknown as { __busy: { armed: boolean } }).__busy.armed = true; }));
      runs.push(run);
      const busy = await page.evaluate(() => (window as unknown as { __busy: { count: number } }).__busy.count);
      const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);
      console.log(`measure tab_switch_p95_run${r + 1}_ms ${run.p95.toFixed(1)}`);
      console.log(`measure tab_switch_median_run${r + 1}_ms ${run.median.toFixed(1)}`);
      assert.equal(run.documents, 0, 'a switch loads no document');
      assert.equal(navigations, 1, 'one document for the whole run');
      assert.ok(Math.max(...run.requests) <= 1, `at most one request per switch: ${run.requests.join(' ')}`);
      assert.equal(busy, 0, 'no busy placeholder once each screen was drawn');
      await context.close();
    }
  } finally {
    await browser.close();
    await app.close();
  }
  const p95s = runs.map((run) => run.p95);
  const median = percentile(p95s, 50);
  console.log(`measure tab_switch_p95_median_ms ${median.toFixed(1)}`);
  console.log(`measure tab_switch_documents ${runs.reduce((sum, run) => sum + run.documents, 0)}`);
  console.log(`measure tab_switch_requests_max ${Math.max(...runs.flatMap((run) => run.requests))}`);
  assert.deepEqual(errors, []);
  assert.ok(median < BUDGET_MS, `the median of the runs' p95 is ${median.toFixed(1)} ms, over ${BUDGET_MS} ms`);
});
