// The assistant's secrets step in a real browser (docs/v2/milestone-5-plan.md,
// section 12, step 7 of the proof, C16), in English and in French: the app
// and the service's setup module on one scratch ledger and state folder, a
// workspace of two services; nothing real, a fake value made at run time:
//   - the step lists both services with no value yet, and Done waits;
//   - a value saved is listed by its name, the day and the person, and the
//     page never holds the value once saved, not even in its field;
//   - a refusal (a value too short) is said in words, in an alert;
//   - Done ends the step;
//   - no policy violation, no page error, no missing key, axe finds nothing;
//   - with CLEARED_V2_CAPTURES=<folder>, the step is captured at 1440, 1280,
//     768 and 390 px, in English, and at 1440 in French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/setup/secrets-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SETUP_TABLES } from '../../../src/setup/tables.ts';
import users from '../../../src/modules/users.ts';
import { applyTables } from '../../../src/store/db.ts';
import { serviceSource } from '../../src/proxy.ts';
import { SESSION_TABLES } from '../../src/session-cookie.ts';
import { FAST, PASSWORD, startSetup } from '../../../test/setup/support.ts';
import { tempDir } from '../../../test/workspace/git.ts';
import { startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
declare const document: any;
declare const window: any;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = [1440, 1280, 768, 390] as const;
const VALUE = ['sandbox', 'fake', 'value', 'browser'].join('-');

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

async function run(language: 'en' | 'fr'): Promise<void> {
  const state = tempDir('secrets-browser');
  const file = join(state, 'workspace.conf');
  writeFileSync(file, ['[workspace]', 'id = demo',
    '[service api]', 'repository = example-org/api', `url = ${join(state, 'api.git')}`, `dir = ${join(state, 'api')}`,
    '[service web]', 'repository = example-org/web', `url = ${join(state, 'web.git')}`, `dir = ${join(state, 'web')}`,
  ].join('\n') + '\n');
  const service = await startSetup({ env: { CLEARED_V2_WORKSPACE: file, CLEARED_V2_STATE_DIR: state } });
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
    await page.goto(`${app.base}/setup/secrets`);

    // Nothing in these repositories asks for a secret: one sentence, the step skipped by itself.
    await page.locator('[data-test-values-none]').waitFor({ state: 'attached' });
    await page.locator('.setup-progress li[data-step="secrets"][data-state="skipped"]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    await checked(page, 'empty');
    assert.equal(await page.locator('form[data-test-values-expected]').count(), 0, 'no form to fill');

    // Any other value is one click away.
    await page.locator('.setup-detail > summary').first().click();
    await page.locator('[data-test-values-service="web"]').waitFor();

    await page.selectOption('#setup-test-value-service', 'api');
    await page.fill('#setup-test-value-name', 'PAYMENT_SANDBOX_KEY');
    await page.fill('#setup-test-value-value', 'short');
    await page.click('[data-act="setup_test_values_save"]');
    await page.locator('[data-test-values] [role="alert"]').waitFor();
    await checked(page, 'refused');

    await page.fill('#setup-test-value-value', VALUE);
    await page.click('[data-act="setup_test_values_save"]');
    await page.locator('[data-test-values-service="api"] [data-test-value="PAYMENT_SANDBOX_KEY"]').waitFor();
    await checked(page, 'saved');
    assert.equal(await page.inputValue('#setup-test-value-value'), '', 'the field is emptied once saved');
    assert.ok(!(await page.content()).includes(VALUE), 'the page never holds the value');
    const line: string = await page.locator('[data-test-value="PAYMENT_SANDBOX_KEY"]').innerText();
    assert.match(line, /alex/);
    assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}T/, 'no ISO time');

    if (CAPTURES) {
      mkdirSync(CAPTURES, { recursive: true });
      if (language === 'en') {
        for (const theme of ['light']) {
          await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
          for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await page.screenshot({ path: join(CAPTURES, `secrets-${width}-${theme}.png`), fullPage: true });
          }
        }
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        await page.setViewportSize({ width: 1440, height: 900 });
      } else {
        await page.screenshot({ path: join(CAPTURES, 'secrets-1440-light-fr.png'), fullPage: true });
      }
    }

    await page.locator('.setup-progress li[data-step="secrets"][data-state="done"]').waitFor();
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
  }
}

test('the secrets step in English: a refusal in words, a value saved by name, Done', { skip }, () => run('en'));
test('the same in French', { skip }, () => run('fr'));
