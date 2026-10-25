// The assistant's workspace step in a real browser (docs/v2/milestone-5-plan.md,
// section 9, lane v2-j5-connect), in English and in French: the app and the
// service's setup module on one scratch ledger, the owner signed in, a fake
// gh on PATH listing the two examples as temporary bare repositories, and
// nothing real:
//   - the Services screen, with no map to read, offers Connect, which opens
//     the step;
//   - the owner picks a monorepo, keeps it whole, then picks instead the
//     guestbook and the filter API; the step clones and
//     reads them, and proposes the filter API's contract and the guestbook's
//     call of POST /check at src/filter.ts line 38, none of them ticked;
//   - nothing is written before the person ticks; once the link and the
//     contract are ticked, the workspace file holds them and the step is done;
//   - each page has no policy violation, no page error, no missing key, and
//     axe finds no violation of WCAG 2.2 AA;
//   - with CLEARED_V2_CAPTURES=<folder>, the proposal is captured at 1440,
//     1280, 768 and 390 px, light and dark, in English, and once in French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/setup/workspace-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readSettings } from '../../../src/setup/settings.ts';
import { SETUP_TABLES } from '../../../src/setup/tables.ts';
import users from '../../../src/modules/users.ts';
import { applyTables } from '../../../src/store/db.ts';
import { WORKSPACE_FILE } from '../../../src/workspace/connect.ts';
import { serviceSource } from '../../src/proxy.ts';
import { SESSION_TABLES } from '../../src/session-cookie.ts';
import { fakeGh } from '../../../test/forge/fake-gh.ts';
import { remote } from '../../../test/workspace/git.ts';
import { FAST, PASSWORD, startSetup } from '../../../test/setup/support.ts';
import { startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
declare const document: any;
declare const window: any;

const EXAMPLES = fileURLToPath(new URL('../../../../examples/', import.meta.url));
const GOOD = ['forge', 'credential', 'of', 'the', 'test'].join('-');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = [1440, 1280, 768, 390] as const;

function files(root: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(posix.join(root, relative)).sort()) {
      const path = relative ? posix.join(relative, name) : name;
      const stat = lstatSync(posix.join(root, path));
      if (stat.isDirectory()) { if (name !== 'node_modules') walk(path); }
      else if (stat.isFile()) out[prefix + path] = readFileSync(posix.join(root, path), 'utf8');
    }
  };
  walk('');
  return out;
}

let axe: string | undefined;
const axeSource = (): string => (axe ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
async function violations(page: any): Promise<string[]> {
  if (!await page.evaluate(() => typeof window.axe === 'object')) await page.evaluate(axeSource());
  return page.evaluate(async (tags: string[]) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: tags } });
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
}

async function checked(page: any, what: string): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, `${what}: no missing key drawn`);
  assert.deepEqual(await page.evaluate(() => window.violations ?? []), [], `${what}: no policy violation`);
  assert.deepEqual(await violations(page), [], `${what}: axe`);
}

async function run(language: 'en' | 'fr'): Promise<void> {
  const gh = fakeGh({
    repositories: [
      { repo: 'example-org/filter-api', url: remote(files(`${EXAMPLES}filter-api`)), base: 'main', private: false, archived: false },
      { repo: 'example-org/guestbook', url: remote(files(`${EXAMPLES}guestbook`)), base: 'main', private: true, archived: false },
      { repo: 'example-org/both', url: remote({ ...files(`${EXAMPLES}guestbook`, 'guestbook/'), ...files(`${EXAMPLES}filter-api`, 'filter-api/') }), base: 'main', private: false, archived: false },
    ],
    pulls: [],
  });
  const service = await startSetup({ env: { PATH: gh.env.PATH as string, GH_TOKEN: GOOD } });
  await service.directory.add('alex', PASSWORD);
  const db = new DatabaseSync(join(service.dir, 'ledger.db'));
  applyTables(db, [...users.tables, ...SESSION_TABLES, ...SETUP_TABLES]);
  const app = await startApp({ db, source: serviceSource({ url: service.base, proof: 'a'.repeat(64) }), extra: { language, setup: { db, env: service.env, params: FAST } } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event: any) => { (window.violations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`); });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));

    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'alex');
    await page.fill('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${app.base}/`);

    // No workspace yet: the Services screen reads no map, and offers Connect.
    await page.goto(`${app.base}/services`);
    await page.locator('[data-act="services_connect"]').waitFor();
    await page.click('[data-act="services_connect"]');
    await page.waitForURL(`${app.base}/setup/workspace`);

    await page.locator('[data-workspace-step] [name="repository"]').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    await checked(page, 'the list');
    // A monorepo kept whole, then no longer picked: the next proposal does not carry that choice.
    await page.check('[name="repository"][value="example-org/both"]');
    await page.click('[data-act="setup_workspace_propose"]');
    await page.locator('[data-workspace-proposal] [name="service"][value="guestbook"]').waitFor();
    await page.check('[data-workspace-proposal] [type="radio"][value="whole"]');
    await page.locator('[data-workspace-proposal] [name="service"][value="both"]').waitFor();
    await page.uncheck('[name="repository"][value="example-org/both"]');
    await page.check('[name="repository"][value="example-org/guestbook"]');
    await page.check('[name="repository"][value="example-org/filter-api"]');
    await page.click('[data-act="setup_workspace_propose"]');
    await page.locator('[data-workspace-proposal] [name="link"]').waitFor();
    await checked(page, 'the proposal');
    assert.equal(await page.locator('[role="alert"]').count(), 0, 'no refusal');
    const text = await page.locator('[data-workspace-proposal]').innerText();
    assert.match(text, /POST \/check/);
    assert.match(text, /src\/filter\.ts/);
    assert.match(text, /38/);
    assert.equal(await page.locator('[name="link"]:checked').count(), 0, 'nothing ticked for the person');
    assert.equal(existsSync(join(service.dir, WORKSPACE_FILE)), false, 'nothing written before the tick');
    assert.equal(readSettings(join(service.dir, 'settings.conf')).env.CLEARED_V2_WORKSPACE, undefined);

    if (CAPTURES) {
      mkdirSync(CAPTURES, { recursive: true });
      const themes = language === 'en' ? ['light', 'dark'] : ['light'];
      const widths = language === 'en' ? WIDTHS : [1440];
      for (const theme of themes) {
        await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
        for (const width of widths) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await page.screenshot({ path: join(CAPTURES, `workspace-${width}-${theme}${language === 'fr' ? '-fr' : ''}.png`), fullPage: true });
        }
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    await page.check('[name="link"][value="guestbook>filter-api"]');
    await page.check('[name="contract"][value="filter-api"]');
    await page.click('[data-act="setup_workspace_write"]');
    await page.locator('[data-workspace-result="ok"]').waitFor();
    await checked(page, 'written');
    const written = readFileSync(join(service.dir, WORKSPACE_FILE), 'utf8');
    assert.match(written, /^consumes = filter-api$/m);
    assert.match(written, /^contract = openapi:contract\/openapi\.yaml$/m);
    assert.equal(readSettings(join(service.dir, 'settings.conf')).env.CLEARED_V2_WORKSPACE, join(service.dir, WORKSPACE_FILE));
    await page.locator('.setup-progress li[data-step="workspace"][data-state="done"]').waitFor();
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
  }
}

test('the owner connects the two examples in English: picked, cloned, the link proposed, only the ticks written', { skip }, () => run('en'));
test('the same in French', { skip }, () => run('fr'));
