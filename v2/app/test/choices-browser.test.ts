// The clickable answers in a real browser, against the fixture sources: a
// click on an option of the session's question calls the session answer
// route with that label, and the question then reads answered by you; a
// click on an option of the lead's pending question calls the lead's
// messages route with it. Run only when CLEARED_V2_PLAYWRIGHT names the
// folder of an installed playwright-core (not a dependency of v2), as
// notify/browser.test.ts does, for example:
//
//   CLEARED_V2_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLEARED_V2_CHROME=/path/to/chrome node --test app/test/choices-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { LeadMessage } from '../../src/api/types.ts';
import type { Question } from '../../src/session/events.ts';
import { AUTHOR_ID, MONTH_QUESTION, QUESTION_REQUEST_ID, sessionFixture, sessionSource } from '../fixtures/session.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { leadFixture, leadSource, waitingForAnswer } from '../fixtures/lead.ts';
import type { DataSource } from '../src/proxy.ts';
import { PASSWORD, startApp } from './support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';

const PAGES: Question = {
  question: 'On desktop, do you want the entries in pages of 20, or one long list as on the phone?',
  header: 'Desktop list',
  options: [{ label: 'Pages of 20 (Recommended)' }, { label: 'One long list' }, { label: 'Pages of 50' }],
};

// Signs alex in through the page, then opens `path`; every page error and
// every request that leaves the app's origin is kept.
async function browse(source: DataSource, path: string, run: (page: any, base: string) => Promise<void>): Promise<{ errors: string[]; away: string[] }> {
  const app = await startApp({ source });
  await app.directory.add('alex', PASSWORD);
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const errors: string[] = [];
  const away: string[] = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    page.on('request', (request: { url(): string }) => { if (!request.url().startsWith(app.base)) away.push(request.url()); });
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'alex');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}${path}`);
    await run(page, app.base);
  } finally {
    await browser.close();
    await app.close();
  }
  return { errors, away };
}

test('a click on an option of the session\'s question calls the session answer route with that label', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW, { question: true });
  const source = sessionSource(fixture);
  const label = MONTH_QUESTION.options?.[1]?.label as string;
  const seen = await browse(source, `/sessions/${AUTHOR_ID}`, async (page) => {
    const question = page.locator(`#timeline [data-row="question"][data-request-id="${QUESTION_REQUEST_ID}"]`);
    await question.locator('[data-answer]').first().waitFor();
    assert.equal(await question.locator('[data-answer]').count(), 3);
    await question.locator(`[data-answer="${label}"]`).click();
    await question.locator('[data-choices-state="answered"]').waitFor();
    assert.match(await question.innerText(), new RegExp(`Answered by you: ${label}`));
  });
  const answers = source.calls.filter((c) => c.path.endsWith('/answer'));
  assert.deepEqual(answers.map((c) => [c.path, c.body]), [
    [`/api/sessions/${AUTHOR_ID}/requests/${QUESTION_REQUEST_ID}/answer`, { decision: { kind: 'answer', answers: { [MONTH_QUESTION.question]: label } } }],
  ]);
  assert.deepEqual(seen, { errors: [], away: [] });
});

test('a click on an option of the lead\'s pending question calls the lead\'s messages route with that label', { skip }, async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const waiting = waitingForAnswer(fixture);
  const messages = waiting.messages.map((m): LeadMessage => (m.question ? { ...m, question: { ...m.question, questions: [PAGES] } } : m));
  const source = leadSource({ ...fixture, state: waiting.state, messages }, { now: () => FIXTURE_NOW });
  const seen = await browse(source, '/lead', async (page) => {
    const options = page.locator('#thread .bubble.question [data-answer]');
    await options.first().waitFor();
    assert.equal(await options.count(), 3);
    const recommended = options.filter({ hasText: /Recommended/ });
    assert.equal(await recommended.count(), 1);
    await recommended.click();
    await page.locator('#thread .bubble.question [data-answer]').first().waitFor({ state: 'detached' });
  });
  assert.deepEqual(source.calls.map((c) => [c.method, c.path, c.body]), [['POST', '/api/lead/messages', { text: 'Pages of 20 (Recommended)' }]]);
  assert.equal(source.state().pendingQuestion, null);
  assert.deepEqual(seen, { errors: [], away: [] });
});
