// An agent's question with choices in a real browser (issue #269), on the
// fixtures source: the inbox is open when the session asks; the question's
// row and its choices as buttons are on screen within 5 s, with no reload,
// through the change stream (in French) and through the inbox's own poll
// when the stream is down (in English); one click on a choice sends that
// label to the session answer route, and the detail says it was sent.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/inbox/questions-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { QuestionItem } from '../../../src/api/types.ts';
import { QUESTION_TICKET } from '../../fixtures/inbox.ts';
import { fixtureSource, type FixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;

const SHOWN_MS = 5000;
const SESSION = 'fixture-269';
const REQUEST = 'question-269';
const WHICH = { en: 'Which database should the guestbook keep its entries in?', fr: 'Dans quelle base le livre d\'or garde-t-il ses entrées ?' };

const question = (language: 'en' | 'fr'): QuestionItem => ({
  kind: 'question', id: `question:${SESSION}:${REQUEST}`, ticket: QUESTION_TICKET, project: 'guestbook', since: new Date().toISOString(), state: 'waiting',
  sessionId: SESSION, requestId: REQUEST,
  questions: [{ question: WHICH[language], header: 'Database', options: [{ label: 'Postgres (Recommended)', description: 'The one the tests run' }, { label: 'SQLite' }] }],
});

async function withInbox(language: 'en' | 'fr', run: (page: any, source: FixtureSource) => Promise<void>, options: { readonly streamDown?: boolean } = {}): Promise<void> {
  const source = await fixtureSource({ now: () => FIXTURE_NOW });
  const app = await startApp({ source, extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const errors: string[] = [];
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    // The stream refused: the cache polls what the screens read.
    if (options.streamDown) await context.route(/\/api\/service\/events/, (route: any) => route.fulfill({ status: 503, body: '' }));
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/inbox`);
    await page.locator('#inbox-list a.item').first().waitFor();
    await run(page, source);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

// Asked now; the time until its row is in the list, with no reload.
async function askAndWait(page: any, source: FixtureSource, item: QuestionItem): Promise<number> {
  // Let the first reads settle, so the question arrives on a page at rest.
  await page.waitForTimeout(1500);
  const from = Date.now();
  source.ask(item);
  await page.locator(`#inbox-list a.item[data-item="${item.id}"]`).waitFor({ timeout: SHOWN_MS + 2000 });
  return Date.now() - from;
}

async function clickAndSend(page: any, item: QuestionItem, label: string): Promise<unknown> {
  await page.locator(`#inbox-list a.item[data-item="${item.id}"]`).click();
  const choices = page.locator(`#detail [data-choices][data-request-id="${REQUEST}"] [data-answer]`);
  await choices.first().waitFor();
  assert.deepEqual(await choices.evaluateAll((nodes: any[]) => nodes.map((n) => n.getAttribute('data-answer'))), ['Postgres (Recommended)', 'SQLite']);
  assert.equal(await choices.evaluateAll((nodes: any[]) => nodes.filter((n) => n.hasAttribute('aria-pressed')).length), 0, 'buttons that answer, not toggles');
  const sent = page.waitForRequest((request: any) => request.method() === 'POST' && request.url().endsWith(`/sessions/${SESSION}/requests/${REQUEST}/answer`));
  await choices.nth(['Postgres (Recommended)', 'SQLite'].indexOf(label)).click();
  const body = (await sent).postDataJSON();
  await page.locator('#detail .d-done').waitFor();
  return body;
}

test('in French, through the change stream: the question and its choices within 5 s, and one click sends "SQLite" to the session', { skip }, async () => {
  await withInbox('fr', async (page, source) => {
    const item = question('fr');
    const shown = await askAndWait(page, source, item);
    assert.ok(shown < SHOWN_MS, `on screen after ${shown} ms`);
    assert.match(await page.locator(`#inbox-list a.item[data-item="${item.id}"]`).innerText(), /Dans quelle base/);
    assert.deepEqual(await clickAndSend(page, item, 'SQLite'), { decision: { kind: 'answer', answers: { [WHICH.fr]: 'SQLite' } } });
    assert.equal((await page.locator('#detail .d-done').innerText()).trim(), 'Réponse envoyée. La session continue.');
  });
});

test('in English, with the stream down: the inbox\'s own poll still shows the question within 5 s, and one click sends the recommended option', { skip }, async () => {
  await withInbox('en', async (page, source) => {
    const item = question('en');
    const shown = await askAndWait(page, source, item);
    assert.ok(shown < SHOWN_MS, `on screen after ${shown} ms`);
    assert.deepEqual(await clickAndSend(page, item, 'Postgres (Recommended)'), { decision: { kind: 'answer', answers: { [WHICH.en]: 'Postgres (Recommended)' } } });
    assert.equal((await page.locator('#detail .d-done').innerText()).trim(), 'Answer sent. The session goes on.');
  }, { streamDown: true });
});
