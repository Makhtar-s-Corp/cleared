// Captures every step of the setup assistant, for the visual loop of the
// interface lanes (lane j6-ui-hallmark): the same walk as
// app/test/setup/setup-browser.test.ts, on its fakes (a fake GitHub on
// loopback, a fake `docker` and a fake `gh` on PATH, a scratch ledger, a
// container whose terminal echoes), so nothing real is read or written.
// Each step is captured as the whole page at each width, then the walk goes
// on: the owner's code, the owner done, the forge, the model with its
// terminal, then workspace, environment, secrets, checks and first ticket
// (each says it has no workspace yet) and the end.
//
//   node scripts/capture-setup.ts --out <folder> [--widths 1440,390] [--language fr|en]
//
// Files are named setup-<step>-<width>.png. The ports are the kernel's
// (port 0, loopback). CLEARED_V2_CHROME names another Chromium than the one
// playwright-core installed.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { SETUP_CODE_LINE } from '../src/setup/code.ts';
import { SETUP_TABLES } from '../src/setup/tables.ts';
import users from '../src/modules/users.ts';
import { applyTables } from '../src/store/db.ts';
import type { SessionContainer, TerminalProcess } from '../src/terminal/container.ts';
import { serviceSource } from '../app/src/proxy.ts';
import { SESSION_TABLES } from '../app/src/session-cookie.ts';
import { fakeDockerOnPath } from '../test/doctor/fake-docker-cli.ts';
import { FakeForge } from '../test/setup/fakes/github.ts';
import { fakeGh } from '../test/forge/fake-gh.ts';
import { FAST, PASSWORD, startSetup } from '../test/setup/support.ts';
import { startApp } from '../app/test/support.ts';
import { WIDTHS } from './capture-screens.ts';

const { chromium } = createRequire(import.meta.url)('playwright-core') as { chromium: any };
declare const document: any;
declare const requestAnimationFrame: (run: () => void) => number;

const GOOD = ['forge', 'credential', 'of', 'the', 'test'].join('-');
const LOGIN = ['sk', 'ant', 'oat01', 'y'.repeat(40)].join('-');

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

export async function captureSetup(options: { readonly out: string; readonly widths: readonly string[]; readonly language: 'fr' | 'en' }): Promise<string[]> {
  mkdirSync(options.out, { recursive: true });
  const files: string[] = [];
  const docker = fakeDockerOnPath();
  const fake = new FakeForge({ [GOOD]: ['org/guestbook', 'org/filter-api'] });
  const api = await fake.listen();
  const gh = fakeGh({ repositories: [{ repo: 'org/guestbook', url: 'https://forge.invalid/org/guestbook.git', base: 'main', private: false, archived: false }], pulls: [] });
  const service = await startSetup({ env: { CLEARED_V2_FORGE_GITHUB_API: api, PATH: gh.env.PATH as string }, container: echoContainer() });
  service.start();
  const code = SETUP_CODE_LINE.exec(service.lines.find((line) => SETUP_CODE_LINE.test(line)) ?? '')?.[1] ?? '';
  const db = new DatabaseSync(join(service.dir, 'ledger.db'));
  applyTables(db, [...users.tables, ...SESSION_TABLES, ...SETUP_TABLES]);
  const app = await startApp({ db, source: serviceSource({ url: service.base, proof: 'a'.repeat(64) }), extra: { language: options.language, setup: { db, env: service.env, params: FAST } } });
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    const context = await browser.newContext({ viewport: WIDTHS['1440'], deviceScaleFactor: 1, colorScheme: 'light', locale: options.language === 'fr' ? 'fr-FR' : 'en-US' });
    const page = await context.newPage();
    const shoot = async (step: string) => {
      for (const w of options.widths) {
        await page.setViewportSize(WIDTHS[w]);
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        });
        await page.waitForTimeout(200);
        const file = join(options.out, `setup-${step}-${w}.png`);
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
        files.push(file);
      }
      await page.setViewportSize(WIDTHS['1440']);
    };
    await page.goto(`${app.base}/`);
    await page.waitForURL(`${app.base}/setup`);
    await page.locator('#setup-code').waitFor();
    await shoot('owner');
    await page.fill('#setup-code', code.toLowerCase());
    await page.fill('#setup-name', 'alex');
    await page.fill('#setup-password', PASSWORD);
    await page.click('[data-act="setup_owner"]');
    await page.locator('[data-public-key]').waitFor({ state: 'attached' });
    await shoot('owner-done');
    await page.click('[data-act="setup_next"]');
    await page.waitForURL(`${app.base}/setup/forge`);
    await page.locator('#setup-forge-value').waitFor();
    await shoot('forge');
    await page.fill('#setup-forge-value', GOOD);
    await page.click('[data-act="setup_forge_check"]');
    await page.locator('[data-forge-result="ok"]').waitFor();
    await page.click('[data-act="setup_next"]');
    await page.waitForURL(`${app.base}/setup/model`);
    await page.locator('#setup-model-value').waitFor();
    await page.click('[data-act="setup_terminal"]');
    await page.locator('.term[data-terminal-state="open"]').waitFor();
    await shoot('model');
    await page.fill('#setup-model-value', LOGIN);
    await page.click('[data-act="setup_model_save"]');
    await page.locator('[data-model-result="ok"]').waitFor();
    await page.click('[data-act="setup_next"]');
    for (const id of ['workspace', 'environment', 'secrets', 'checks', 'first-ticket']) {
      await page.waitForURL(`${app.base}/setup/${id}`);
      const marker = id === 'workspace' ? '[data-workspace-step] [name="repository"]' : id === 'checks' ? '[data-check="docker"]'
        : id === 'environment' ? '[data-environment-none]' : id === 'secrets' ? '[data-test-values-none]' : '[data-first-ticket="waiting"]';
      await page.locator(marker).first().waitFor();
      await shoot(id);
      await page.click('[data-act="setup_skip"]');
    }
    await page.locator('[data-setup-finished]').waitFor();
    await shoot('finished');
  } finally {
    await browser.close();
    await app.close();
    db.close();
    await service.close();
    await fake.close();
    docker.restore();
  }
  return files;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, widths: { type: 'string' }, language: { type: 'string' } } });
  if (!values.out) {
    console.error('capture-setup: --out <folder> is required');
    process.exit(64);
  }
  const widths = values.widths ? values.widths.split(',').map((w) => w.trim()) : ['1440', '390'];
  for (const w of widths) if (!WIDTHS[w]) throw new Error(`unknown width ${w}`);
  for (const file of await captureSetup({ out: resolve(values.out), widths, language: values.language === 'en' ? 'en' : 'fr' })) console.log(file);
  process.exit(0);
}
