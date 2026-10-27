// The setup assistant in a real browser (docs/v2/milestone-5-plan.md,
// section 5, lane v2-j5-assistant), in English and in French: the app with
// its first-start gate and the service's setup module on one scratch
// ledger, a fake GitHub and a fake container, nothing real:
//   - a newcomer opens the address, is sent to /setup, types the code the
//     service printed, a name and a password, sees the public key, goes on;
//   - the forge step checks a credential on the fake GitHub; the model step
//     takes a pasted login; every later step is skipped: the stubs, and the
//     checks step once its lines are drawn (lane v2-j5-doctor fills it, its
//     reads of Docker answered by a fake `docker` program on PATH);
//   - each page has no policy violation, no page error, no missing key, and
//     axe finds no violation of WCAG 2.2 AA;
//   - with CLEARED_V2_CAPTURES=<folder>, the forge step is captured at 1440,
//     1280, 768 and 390 px, light and dark.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/setup/setup-browser.test.ts
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
import type { SessionContainer, TerminalProcess } from '../../../src/terminal/container.ts';
import { serviceSource } from '../../src/proxy.ts';
import { SESSION_TABLES } from '../../src/session-cookie.ts';
import { fakeDockerOnPath } from '../../../test/doctor/fake-docker-cli.ts';
import { FakeForge } from '../../../test/setup/fakes/github.ts';
import { fakeGh } from '../../../test/forge/fake-gh.ts';
import { FAST, PASSWORD, startSetup } from '../../../test/setup/support.ts';
import { startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
declare const document: any;
declare const window: any;

const GOOD = ['forge', 'credential', 'of', 'the', 'test'].join('-');
const LOGIN = ['sk', 'ant', 'oat01', 'y'.repeat(40)].join('-');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = [1440, 1280, 768, 390] as const;

// A container whose terminal answers what is typed, so the step's terminal opens without Docker.
const echoContainer = (): SessionContainer => ({
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  async terminal(): Promise<TerminalProcess> {
    const outputs: ((chunk: Buffer) => void)[] = [];
    const exits: (() => void)[] = [];
    return {
      write: (data) => { for (const listener of outputs) listener(Buffer.from(data)); },
      async resize() {},
      onOutput: (listener) => { outputs.push(listener); setTimeout(() => listener(Buffer.from('$ ')), 10); },
      onExit: (listener) => { exits.push(listener); },
      async end() { for (const listener of exits.splice(0)) listener(); },
    };
  },
});

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
  const docker = fakeDockerOnPath();
  const fake = new FakeForge({ [GOOD]: ['org/guestbook', 'org/filter-api'] });
  const api = await fake.listen();
  // The workspace step lists through gh once the forge step is done: a fake on PATH, so no call reaches GitHub.
  const gh = fakeGh({ repositories: [{ repo: 'org/guestbook', url: 'https://forge.invalid/org/guestbook.git', base: 'main', private: false, archived: false }], pulls: [] });
  const service = await startSetup({ env: { CLEARED_V2_FORGE_GITHUB_API: api, PATH: gh.env.PATH as string }, container: echoContainer() });
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
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    await checked(page, 'owner');
    await page.fill('#setup-code', code.toLowerCase());
    await page.fill('#setup-name', 'alex');
    await page.fill('#setup-password', PASSWORD);
    await page.click('[data-act="setup_owner"]');
    await page.locator('[data-public-key]').waitFor({ state: 'attached' });   // folded for a lock set up by hand (issue #432)
    await checked(page, 'owner done');
    await page.click('[data-act="setup_next"]');

    await page.waitForURL(`${app.base}/setup/forge`);
    await page.locator('#setup-forge-value').waitFor();
    await checked(page, 'forge');
    if (CAPTURES && language === 'en') {
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          mkdirSync(CAPTURES, { recursive: true });
          await page.screenshot({ path: join(CAPTURES, `forge-${width}-${theme}.png`), fullPage: true });
        }
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.fill('#setup-forge-value', GOOD);
    await page.click('[data-act="setup_forge_check"]');
    await page.locator('[data-forge-result="ok"]').waitFor();
    assert.match(await page.locator('[data-forge-result="ok"]').innerText(), /2/);
    assert.equal(await page.locator('#setup-forge-value').count(), 0, 'once set, the field is gone: nothing to read back');
    await checked(page, 'forge done');
    await page.click('[data-act="setup_next"]');

    await page.waitForURL(`${app.base}/setup/model`);
    await page.locator('#setup-model-value').waitFor();
    await page.click('[data-act="setup_terminal"]');
    await page.locator('.term[data-terminal-state="open"]').waitFor();
    await checked(page, 'model with its terminal');
    if (CAPTURES && language === 'fr') await page.screenshot({ path: join(CAPTURES, 'model-1440-light-fr.png'), fullPage: true });
    await page.fill('#setup-model-value', LOGIN);
    await page.click('[data-act="setup_model_save"]');
    await page.locator('[data-model-result="ok"]').waitFor();
    await page.click('[data-act="setup_next"]');

    for (const id of ['workspace', 'environment', 'secrets', 'checks', 'first-ticket']) {
      await page.waitForURL(`${app.base}/setup/${id}`);
      // The workspace, environment, checks and first-ticket steps are filled (lanes v2-j5-connect, v2-j5-images, v2-j5-doctor and
      // v2-j5-first-ticket, each with its own tests); the others are stubs.
      const marker = id === 'workspace' ? '[data-workspace-step] [name="repository"]' : id === 'checks' ? '[data-check="docker"]'
        : id === 'environment' ? '[data-environment-none]' : id === 'first-ticket' ? '[data-first-ticket="waiting"]' : `[data-step-stub="${id}"]`;
      await page.locator(marker).first().waitFor();
      if (id === 'environment') await checked(page, 'the environment with no workspace');
      if (id === 'first-ticket') await checked(page, 'the first ticket with no workspace');
      if (id === 'secrets') await checked(page, 'a stub');
      await page.click('[data-act="setup_skip"]');
    }
    await page.locator('[data-setup-finished]').waitFor();
    await checked(page, 'the end');
    if (CAPTURES && language === 'en') await page.screenshot({ path: join(CAPTURES, 'finished-1440-light.png'), fullPage: true });
    const states = await page.locator('.setup-progress li').evaluateAll((items: any[]) => items.map((item) => item.dataset.state));
    assert.deepEqual(states, ['done', 'done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    await page.click('[data-act="setup_tower"]');
    await page.waitForURL(`${app.base}/`);

    assert.deepEqual(errors, [], 'no page error');
    const settings = readFileSync(join(service.dir, 'settings.conf'), 'utf8');
    assert.ok(!settings.includes(GOOD) && !settings.includes(LOGIN), 'no credential in the settings');
    assert.equal(readSettings(join(service.dir, 'settings.conf')).env.CLEARED_V2_OWNER_ID, 'alex');
    assert.equal(fake.requests.filter((r) => r.path.startsWith('/user/repos')).length, 1, 'the forge step read GitHub once');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
    await fake.close();
    docker.restore();
  }
}

test('a newcomer goes through the assistant in English: code, owner, forge, model, the stubs skipped', { skip }, () => run('en'));
test('the same in French', { skip }, () => run('fr'));
