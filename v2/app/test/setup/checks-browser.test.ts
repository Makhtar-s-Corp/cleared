// The assistant's checks step in a real browser (docs/v2/milestone-5-plan.md,
// section 7, issue #415), in English and in French: the app and the
// service's setup module on one scratch ledger, a fake GitHub, a fake
// container and a fake `docker` program on PATH, nothing real:
//   - after the owner, forge and model steps, and the stubs skipped, the
//     checks step runs the ready section on its own; a missing image is a
//     failed line with what to do under it, and Continue is not offered;
//   - once the image is there, Check again: that line passes, one failure
//     fewer, and Continue is offered when none is left (this machine's own
//     disk is measured, so a full disk would keep one);
//   - no policy violation, no page error, no missing key, axe finds nothing;
//   - with CLEARED_V2_CAPTURES=<folder>, the step is captured at 1440, 1280,
//     768 and 390 px, light and dark, in English, and at 1440 in French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/setup/checks-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EGRESS_IMAGE, SESSION_IMAGE } from '../../../src/container/session-runtime.ts';
import { SETUP_CODE_LINE } from '../../../src/setup/code.ts';
import { SETUP_TABLES } from '../../../src/setup/tables.ts';
import users from '../../../src/modules/users.ts';
import { applyTables } from '../../../src/store/db.ts';
import type { SessionContainer, TerminalProcess } from '../../../src/terminal/container.ts';
import { serviceSource } from '../../src/proxy.ts';
import { SESSION_TABLES } from '../../src/session-cookie.ts';
import { fakeDockerOnPath } from '../../../test/doctor/fake-docker-cli.ts';
import { FakeGitHubForChecks } from '../../../test/doctor/fake-github.ts';
import { FAST, PASSWORD, startSetup } from '../../../test/setup/support.ts';
import { startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
declare const document: any;
declare const window: any;

const GOOD = ['forge', 'credential', 'of', 'the', 'checks'].join('-');
const LOGIN = ['sk', 'ant', 'oat01', 'z'.repeat(40)].join('-');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = [1440, 1280, 768, 390] as const;

const quietContainer = (): SessionContainer => ({
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  async terminal(): Promise<TerminalProcess> {
    return { write: () => undefined, async resize() {}, onOutput: () => undefined, onExit: () => undefined, async end() {} };
  },
});

let axe: string | undefined;
const axeSource = (): string => (axe ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
async function checked(page: any, what: string): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, `${what}: no missing key drawn`);
  assert.deepEqual(await page.evaluate(() => window.violations ?? []), [], `${what}: no policy violation`);
  if (!await page.evaluate(() => typeof window.axe === 'object')) await page.evaluate(axeSource());
  const found = await page.evaluate(async (tags: string[]) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: tags } });
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
  assert.deepEqual(found, [], `${what}: axe`);
}

const failedCount = async (page: any): Promise<number> => Number(await page.locator('[data-checks-summary]').getAttribute('data-checks-summary'));

async function run(language: 'en' | 'fr'): Promise<void> {
  const docker = fakeDockerOnPath([SESSION_IMAGE]);
  const fake = new FakeGitHubForChecks({ [GOOD]: ['org/guestbook'] });
  const api = await fake.listen();
  const service = await startSetup({ env: { CLEARED_V2_FORGE_GITHUB_API: api, CLEARED_V2_APP_LANGUAGE: language }, container: quietContainer() });
  service.start();
  const code = SETUP_CODE_LINE.exec(service.lines.find((line) => SETUP_CODE_LINE.test(line)) ?? '')?.[1] ?? '';
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

    await page.goto(`${app.base}/setup`);
    await page.locator('#setup-code').waitFor();
    await page.fill('#setup-code', code);
    await page.fill('#setup-name', 'alex');
    await page.fill('#setup-password', PASSWORD);
    await page.click('[data-act="setup_owner"]');
    await page.locator('[data-public-key]').waitFor();
    await page.click('[data-act="setup_next"]');
    await page.locator('#setup-forge-value').waitFor();
    await page.fill('#setup-forge-value', GOOD);
    await page.click('[data-act="setup_forge_check"]');
    await page.locator('[data-forge-result="ok"]').waitFor();
    await page.click('[data-act="setup_next"]');
    await page.locator('#setup-model-value').waitFor();
    await page.fill('#setup-model-value', LOGIN);
    await page.click('[data-act="setup_model_save"]');
    await page.locator('[data-model-result="ok"]').waitFor();
    await page.click('[data-act="setup_next"]');
    for (const id of ['workspace', 'environment', 'secrets']) {
      await page.waitForURL(`${app.base}/setup/${id}`);
      await page.click('[data-act="setup_skip"]');
    }

    // The egress image is missing: a failed line, what to do, no Continue.
    await page.waitForURL(`${app.base}/setup/checks`);
    await page.locator('[data-check="images"]').waitFor();
    await checked(page, 'checks, one image missing');
    const images = page.locator('[data-check="images"]');
    assert.equal(await images.getAttribute('data-level'), 'fail');
    assert.ok((await images.innerText()).includes(EGRESS_IMAGE));
    assert.match(await images.locator('.setup-check-todo').innerText(), /compose -f v2\/compose\.yaml run --rm install/);
    assert.equal(await page.locator('[data-check="forge"]').getAttribute('data-level'), 'ok');
    assert.equal(await page.locator('[data-check="model"]').getAttribute('data-level'), 'ok');
    assert.equal(await page.locator('[data-check="checkout"]').getAttribute('data-level'), 'notice', 'no workspace yet');
    assert.equal(await page.locator('[data-act="setup_next"]').count(), 0, 'no Continue while a check fails');
    const before = await failedCount(page);
    assert.ok(before >= 1);
    const body = await page.evaluate(() => document.body.innerText);
    assert.ok(!body.includes(GOOD) && !body.includes(LOGIN), 'no credential on the page');
    if (CAPTURES) {
      mkdirSync(CAPTURES, { recursive: true });
      if (language === 'en') {
        for (const theme of ['light', 'dark']) {
          await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
          for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await page.screenshot({ path: join(CAPTURES, `checks-${width}-${theme}.png`), fullPage: true });
          }
        }
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        await page.setViewportSize({ width: 1440, height: 900 });
      } else {
        await page.screenshot({ path: join(CAPTURES, 'checks-1440-light-fr.png'), fullPage: true });
      }
    }

    // The image is there now: Check again.
    docker.images([SESSION_IMAGE, EGRESS_IMAGE]);
    await page.click('[data-act="setup_checks_again"]');
    await page.waitForFunction(() => document.querySelector('[data-check="images"]')?.getAttribute('data-level') === 'ok');
    await checked(page, 'checks again');
    const after = await failedCount(page);
    assert.equal(after, before - 1, 'one failure fewer');
    if (after === 0) await page.locator('[data-act="setup_next"]').waitFor();
    else assert.equal(await page.locator('[data-act="setup_next"]').count(), 0);
    assert.deepEqual(errors, [], 'no page error');
    assert.ok(fake.paths.includes('/user') && fake.paths.includes('/repos/org/guestbook') === false, 'the token read; no repository asked before a workspace exists');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
    await fake.close();
    docker.restore();
  }
}

test('the checks step in English: a failed line with what to do, then all passed after Check again', { skip }, () => run('en'));
test('the same in French', { skip }, () => run('fr'));
