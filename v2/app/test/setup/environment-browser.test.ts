// The assistant's environment step in a real browser (docs/v2/milestone-5-plan.md,
// section 10, matrix C15), in English and in French: the app and the
// service's setup module on one scratch ledger, a workspace of two services
// over temporary repositories, and a fake `docker` program on PATH that
// builds after a pause; nothing real:
//   - each service is listed with what its base holds, not built;
//   - Build: the page says the builds run, Build is not offered again
//     meanwhile, and the page reads the view until each image is ready,
//     with its tag and its build's time, then its declared check's result
//     in that image, and the setup session proposed to the service with no
//     .devcontainer (C4), which waits for a restart here: no flow runs;
//   - no policy violation, no page error, no missing key, axe finds nothing;
//   - with CLEARED_V2_CAPTURES=<folder>, the step is captured at 1440, 1280,
//     768 and 390 px, in English, and at 1440 in French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/setup/environment-browser.test.ts
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
import { project } from '../../../test/container/prepared-fixture.ts';
import { fakeDockerBuildsOnPath } from '../../../test/setup/fake-docker-builds.ts';
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

async function run(language: 'en' | 'fr', failing = false): Promise<void> {
  const docker = fakeDockerBuildsOnPath(1_500, failing ? { code: 1, output: 'not ok 2 - the entries\n  sqlite3: command not found\n# fail 1\n' } : undefined);
  const services = {
    api: project({}, null, 'api'),
    web: project({ '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n', '.cleared/agents.conf': '[merge]\nverdict = ok\n' }, null, 'web'),
  };
  const state = tempDir('environment-browser');
  const file = join(state, 'workspace.conf');
  writeFileSync(file, ['[workspace]', 'id = demo', ...Object.entries(services).flatMap(([name, made]) => [
    `[service ${name}]`, `repository = example-org/${name}`, `url = ${made.bare}`, `dir = ${made.dir}`,
  ])].join('\n') + '\n');
  const service = await startSetup({ env: { CLEARED_V2_WORKSPACE: file, CLEARED_V2_STATE_DIR: state, PATH: process.env.PATH as string } });
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
    await page.goto(`${app.base}/setup/environment`);

    await page.locator('[data-environment-step] [data-service="web"]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    await checked(page, 'not built');
    assert.deepEqual(await page.locator('.setup-env-item').evaluateAll((items: any[]) => items.map((item) => item.dataset.state)), ['none', 'none']);
    assert.match(await page.locator('[data-service="api"]').innerText(), /npm ci/);

    await page.click('[data-act="setup_environment_build"]');
    await page.locator('.setup-env-item[data-state="building"]').first().waitFor();
    assert.equal(await page.locator('[data-act="setup_environment_build"]').isDisabled(), true, 'no second Build while one runs');
    await page.waitForFunction(() => [...document.querySelectorAll('.setup-env-item')].every((item: any) => item.dataset.state === 'ready'), undefined, { timeout: 30_000 });
    await checked(page, 'ready');
    const api = await page.locator('[data-service="api"]').innerText();
    assert.match(api, /cleared-v2-prep-api:[0-9a-f]{16}/);
    assert.doesNotMatch(api, /\d\s?ms\b/, 'no figure in milliseconds');
    assert.equal(await page.locator('[role="alert"]').count(), 0, 'no refusal');
    if (failing) {
      // A check that fails in its image: its last lines, and a setup session proposed for that reason.
      await page.locator('[data-service="api"] [data-env-check="failed"]').waitFor();
      assert.match(await page.locator('[data-service="api"] .setup-env-output').innerText(), /sqlite3: command not found/);
      assert.equal(await page.locator('[data-service="web"] [data-env-session="check_failed"]').count(), 1);
      await checked(page, 'check failed');
      if (CAPTURES) {
        for (const [width, theme] of [[1440, 'light'], [390, 'light']] as const) {
          await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await page.screenshot({ path: join(CAPTURES, `environment-check-failed-${width}-${theme}${language === 'fr' ? '-fr' : ''}.png`), fullPage: true });
        }
      }
      assert.deepEqual(errors, [], 'no page error');
      return;
    }
    // The declared check ran in each ready image; the service with no .devcontainer is proposed a setup session.
    await page.locator('[data-service="api"] [data-env-check="passed"]').waitFor();
    assert.match(await page.locator('[data-service="api"] [data-env-check]').innerText(), /npm test/);
    assert.equal(await page.locator('[data-service="api"] [data-env-session="no_devcontainer"]').count(), 1);
    assert.equal(await page.locator('[data-service="web"] [data-env-session]').count(), 0, 'a .devcontainer and a passing check: nothing proposed');
    assert.equal(await page.locator('[data-act="setup_environment_session"]').count(), 0, 'no flow runs here: no start offered');
    await checked(page, 'checked');
    await page.locator('.setup-progress li[data-step="environment"][data-state="done"]').waitFor();

    if (CAPTURES) {
      mkdirSync(CAPTURES, { recursive: true });
      if (language === 'en') {
        for (const theme of ['light']) {
          await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
          for (const width of WIDTHS) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await page.screenshot({ path: join(CAPTURES, `environment-${width}-${theme}.png`), fullPage: true });
          }
        }
      } else {
        await page.screenshot({ path: join(CAPTURES, 'environment-1440-light-fr.png'), fullPage: true });
      }
    }
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
    docker.restore();
  }
}

test('the environment step in English: not built, Build, each image ready with its time', { skip }, () => run('en'));
test('the same in French', { skip }, () => run('fr'));
test('a check that fails in its image shows its last lines and proposes a setup session, in French', { skip }, () => run('fr', true));
