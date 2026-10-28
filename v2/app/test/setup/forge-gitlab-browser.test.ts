// The forge step's GitLab choice in a real browser (docs/v2/milestone-5-plan.md,
// section 11, lane v2-j5-gitlab), in English and in French: the app with its
// first-start gate and the service's setup module on one scratch ledger, a
// fake GitLab on loopback, nothing real:
//   - the owner's account is made, then the forge step: GitLab is picked
//     from the two radio buttons, its address and a token typed, checked on
//     the fake GitLab through the forge contract, and saved;
//   - each page has no policy violation, no page error, no missing key, and
//     axe finds no violation of WCAG 2.2 AA;
//   - with CLEARED_V2_CAPTURES=<folder>, the GitLab choice is captured at
//     1440, 1280, 768 and 390 px, in English, and the saved
//     step at 1440 in French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/setup/forge-gitlab-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SETUP_CODE_LINE } from '../../../src/setup/code.ts';
import { SETUP_TABLES } from '../../../src/setup/tables.ts';
import { readSettings } from '../../../src/setup/settings.ts';
import users from '../../../src/modules/users.ts';
import { applyTables } from '../../../src/store/db.ts';
import { serviceSource } from '../../src/proxy.ts';
import { SESSION_TABLES } from '../../src/session-cookie.ts';
import { emptyGitLab, FakeGitLab } from '../../../test/forge/fakes/gitlab.ts';
import { FAST, PASSWORD, startSetup } from '../../../test/setup/support.ts';
import { startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
declare const document: any;
declare const window: any;

const GOOD = ['gitlab', 'credential', 'of', 'the', 'browser'].join('-');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = [1440, 1280, 768, 390] as const;

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

async function shots(page: any, name: string): Promise<void> {
  if (!CAPTURES) return;
  mkdirSync(CAPTURES, { recursive: true });
  for (const theme of ['light']) {
    await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({ path: join(CAPTURES, `${name}-${width}-${theme}.png`), fullPage: true });
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function run(language: 'en' | 'fr'): Promise<void> {
  const lab = new FakeGitLab(GOOD, {
    ...emptyGitLab(),
    projects: ['example/guestbook', 'example/apps/filter-api'].map((path) => ({ path_with_namespace: path, http_url_to_repo: `https://gitlab.invalid/${path}.git`, default_branch: 'main', visibility: 'private' as const, archived: false, access_level: 30 })),
  });
  const address = await lab.listen();
  const service = await startSetup({});
  service.start();
  const code = SETUP_CODE_LINE.exec(service.lines.find((line) => SETUP_CODE_LINE.test(line)) ?? '')?.[1] ?? '';
  assert.ok(code, 'the service printed a code');
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

    await page.goto(`${app.base}/`);
    await page.waitForURL(`${app.base}/setup`);
    await page.locator('#setup-code').waitFor();
    await page.fill('#setup-code', code.toLowerCase());
    await page.fill('#setup-name', 'alex');
    await page.fill('#setup-password', PASSWORD);
    await page.click('[data-act="setup_owner"]');
    await page.locator('[data-public-key]').waitFor({ state: 'attached' });   // folded for a lock set up by hand (issue #432)
    await page.click('[data-act="setup_next"]');

    await page.waitForURL(`${app.base}/setup/forge`);
    await page.locator('#setup-forge-value').waitFor();
    assert.equal(await page.locator('#setup-forge-github').isChecked(), true, 'GitHub first');
    await page.check('#setup-forge-gitlab');
    await page.locator('#setup-gitlab-value').waitFor();
    assert.equal(await page.locator('#setup-forge-value').count(), 0, 'GitHub\'s field is gone');
    assert.equal(await page.locator('#setup-gitlab-address').inputValue(), 'https://gitlab.com');
    await checked(page, 'the GitLab choice');
    if (language === 'en') await shots(page, 'forge-gitlab');

    // An address in clear, off loopback, is refused before anything is sent.
    await page.fill('#setup-gitlab-address', 'http://gitlab.example.org');
    await page.fill('#setup-gitlab-value', GOOD);
    await page.click('[data-act="setup_gitlab_check"]');
    await page.locator('.setup-error[role="alert"]').waitFor();
    await checked(page, 'the address refused');
    assert.equal(lab.requests.length, 0);

    await page.fill('#setup-gitlab-address', address);
    await page.fill('#setup-gitlab-value', GOOD);
    await page.click('[data-act="setup_gitlab_check"]');
    await page.locator('[data-forge-result="ok"]').waitFor();
    assert.match(await page.locator('[data-forge-result="ok"]').innerText(), /GitLab[\s\S]*2/);
    assert.equal(await page.locator('#setup-gitlab-value').count(), 0, 'once set, the field is gone: nothing to read back');
    await checked(page, 'GitLab saved');
    if (CAPTURES && language === 'fr') {
      mkdirSync(CAPTURES, { recursive: true });
      await page.screenshot({ path: join(CAPTURES, 'forge-gitlab-saved-1440-light-fr.png'), fullPage: true });
    }

    // Back on the step, GitLab is the forge it shows, with its address and no field.
    await page.reload();
    await page.locator('[data-act="setup_gitlab_replace"]').waitFor();
    assert.equal(await page.locator('#setup-forge-gitlab').isChecked(), true);
    assert.match(await page.locator('.setup-saved').innerText(), /127\.0\.0\.1/);
    await checked(page, 'GitLab saved, again');

    assert.deepEqual(errors, [], 'no page error');
    const settings = readSettings(join(service.dir, 'settings.conf'));
    assert.equal(settings.env.CLEARED_V2_GITLAB_URL, address);
    assert.ok(!readFileSync(join(service.dir, 'settings.conf'), 'utf8').includes(GOOD), 'no credential in the settings');
    assert.ok(lab.requests.every((r) => r.token), 'every call with the token, in its header');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
    await lab.close();
  }
}

test('the forge step on GitLab in English: picked, refused in clear, checked and saved', { skip }, () => run('en'));
test('the same in French', { skip }, () => run('fr'));
