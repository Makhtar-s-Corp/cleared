// Resume from here in a real browser (issue #272), on the session
// fixture's LOCAL-161, its author done:
//   - a step of the author's thread opens its detail, which offers Resume
//     from here; the form says the commit the branch goes back to;
//   - the corrected instruction is sent with the step's first event, the
//     service's route answers with the new author, and the view follows it
//     without a navigation: a row on each session says where the ticket
//     went on and where it came from, with the instruction;
//   - the old author's rows are still in the view, folded under its name,
//     and open to read;
//   - in French, the button and the form are the catalog's.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/session/replay-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUTHOR_ID, BASE_COMMIT, sessionFixture, sessionSource } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';
import { openDetails } from './fold.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const RESUMED = `${AUTHOR_ID}-r1`;

async function open(language: 'en' | 'fr') {
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  const source = sessionSource(fixture);
  const app = await startApp({ source, extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  await app.directory.add('owner', PASSWORD);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: language === 'fr' ? 'fr-FR' : 'en-US' })).newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  let documents = 0;
  page.on('load', () => { documents += 1; });
  await page.goto(`${app.base}/login`);
  await page.fill('#name', 'owner');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(`${app.base}/`);
  await page.goto(`${app.base}/sessions/${AUTHOR_ID}`);
  await openDetails(page);
  await page.locator('#timeline [data-row]').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.session[aria-busy="true"]') === null);
  // The targeted tests' step: the author ran them before its commit.
  const step = page.locator('#timeline details.step[data-row="run"]').first();
  await step.locator('summary').click();
  // The step's first event, as the fixture stored it.
  const seq = fixture.store.events.after(AUTHOR_ID).find((e) => e.event.type === 'TOOL_CALL_START' && e.event.toolCallId === 'run-1')!.seq;
  return {
    fixture, source, app, browser, page, errors, step, seq, documents: () => documents,
    async close() { await browser.close(); await app.close(); },
  };
}

test('Resume from here on a step: the instruction goes with the step, a new author follows in the same view, the old rows stay readable', { skip }, async () => {
  const h = await open('en');
  try {
    const { page, step } = h;
    const loaded = h.documents();
    assert.ok(await page.locator('#timeline [data-act="resume_open"]').count() > 3, 'every step of the author offers it');
    await step.locator('[data-act="resume_open"]').click();
    const form = step.locator('form.resume-form');
    await form.waitFor();
    assert.equal(await form.locator('label').innerText(), 'What should the session do instead, from this step?');
    assert.equal(await form.locator('p.faint').innerText(),
      `The branch goes back to commit ${BASE_COMMIT.slice(0, 12)}, as it was before this step, on a new branch. What follows stays readable in the thread.`);
    // An empty instruction is said, and nothing is sent.
    await form.locator('[data-act="resume_send"]').click();
    assert.equal(await form.locator('[role="status"]').innerText(), 'Say what to do instead.');
    assert.equal(h.source.calls.filter((c) => c.path.endsWith('/replay')).length, 0);

    await form.locator('textarea').fill('Group by ISO week, and keep the totals test first.');
    await form.locator('[data-act="resume_send"]').click();
    await page.waitForURL(new RegExp(`/sessions/${RESUMED}(#terminal)?$`));
    assert.deepEqual(h.source.calls.filter((c) => c.path.endsWith('/replay')).map((c) => ({ path: c.path, body: c.body })),
      [{ path: `/api/sessions/${AUTHOR_ID}/replay`, body: { seq: h.seq, message: 'Group by ISO week, and keep the totals test first.' } }]);

    // Both sessions say it, in one view, without a navigation.
    await page.waitForFunction(() => document.querySelectorAll('#timeline [data-row="replay"]').length === 2);
    const rows = (await page.locator('#timeline [data-row="replay"] summary .what').allTextContents() as string[]).map((text) => text.trim());
    assert.deepEqual(rows, [
      `Resumed from a step above by you: a new session goes on below, on cleared/LOCAL-161.r1 from ${BASE_COMMIT.slice(0, 12)}. What follows that step here is the earlier attempt.`,
      `Resumed by you from a step of the earlier session, on cleared/LOCAL-161.r1 from ${BASE_COMMIT.slice(0, 12)}.`,
    ]);
    const last = page.locator('#timeline [data-row="replay"]').last();
    await last.locator('summary').click();
    assert.match(await last.locator('.step-detail').innerText(), /Corrected instruction\s+Group by ISO week, and keep the totals test first\./);
    assert.equal(h.documents(), loaded, 'no document loaded');
    assert.equal(await page.locator('#detail-head .phrase-title').innerText(), 'Working', 'the view acts on the new author');

    // The old continuation: folded under the earlier author, every row there to read.
    const earlier = page.locator(`#timeline details.earlier[data-session="${AUTHOR_ID}"]`);
    await earlier.locator(':scope > summary').click();
    assert.ok(await earlier.locator('[data-row="run"]').count() >= 3, 'its commands, the commit among them');
    assert.ok(await earlier.locator('[data-row="replay"]').count() === 1, 'and where the ticket went on');
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test('in French, Resume from here and its form are the catalog\'s', { skip }, async () => {
  const h = await open('fr');
  try {
    const { step } = h;
    assert.equal(await step.locator('[data-act="resume_open"]').innerText(), 'Reprendre d\'ici');
    await step.locator('[data-act="resume_open"]').click();
    const form = step.locator('form.resume-form');
    await form.waitFor();
    assert.equal(await form.locator('label').innerText(), 'Que doit faire la session à la place, à partir de cette étape ?');
    assert.match(await form.locator('p.faint').innerText(), new RegExp(`^La branche revient au commit ${BASE_COMMIT.slice(0, 12)}, tel qu'il était avant cette étape`));
    assert.equal(await form.locator('[data-act="resume_send"]').innerText(), 'Reprendre');
    await form.locator('[data-act="resume_cancel"]').click();
    await step.locator('[data-act="resume_open"]').waitFor();
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
