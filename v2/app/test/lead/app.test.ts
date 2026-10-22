// The lead screen against the app: the pages, the catalog, the stylesheet
// and the two scripts are served, and the routes the screen reads answer
// through the forwarding from lane 8's stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LeadMessage, LeadState, Plan } from '../../../src/api/types.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { leadFixture, leadSource, otherPlans } from '../../fixtures/lead.ts';
import { signedIn, startApp } from '../support.ts';

test('the app serves the lead\'s pages, catalog, stylesheet and scripts, and its reads reach the lead and plan routes', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const { running, done } = otherPlans(FIXTURE_NOW);
  const app = await startApp({ source: leadSource({ ...fixture, plans: [...fixture.plans, running, done] }, { now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const get = (path: string) => fetch(`${app.base}${path}`, { headers: { cookie } });
    for (const path of ['/lead', '/plans/plan-2']) {
      const page = await get(path);
      assert.equal(page.status, 200, path);
      assert.match(await page.text(), /data-screen="lead"/, path);
    }
    const catalog = await (await get('/messages/lead.json')).json() as Record<string, string>;
    assert.equal(catalog.plan_approve, 'Approve the plan and start');
    assert.equal(catalog.lead_remember, 'What does the lead remember?');
    const css = await get('/screens/lead.css');
    assert.equal(css.status, 200);
    const sheet = await css.text();
    assert.doesNotMatch(sheet, /gradient|prefers-color-scheme/i, 'flat colours, and the theme is the person\'s choice');
    assert.match(sheet, /\[data-theme="dark"\]/);
    assert.match(await (await get('/screens/lead.ts')).text(), /export function mount\(/);
    assert.match(await (await get('/plan-panel.ts')).text(), /export function renderPlanPanel\(/);

    const api = (path: string) => get(`/api/service${path}`);
    assert.equal((await (await api('/lead')).json() as LeadState).generation, 3);
    assert.equal((await (await api('/lead/messages?after=4')).json() as LeadMessage[]).length, 1);
    assert.deepEqual((await (await api('/plans')).json() as Plan[]).map((p) => p.state), ['proposed', 'approved', 'done']);
    assert.match(await (await api('/lead/stream?after=4')).text(), /^id: 5\nevent: message\n/);
  } finally {
    await app.close();
  }
});
