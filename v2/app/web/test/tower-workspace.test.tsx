// The tower in a workspace of two services (lane 22): the workspace line,
// the service on each live session, a session taken over, and a chip per
// service in the bar; a one-service workspace draws milestone 1's tower.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FIXTURE_NOW, OWNER_ID, towerFixture, workspaceFixture } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { Bar } from '../screens/tower/Tower.tsx';
import { towerModel } from '../screens/tower/model.ts';
import { html, renderTower, renderTowerBody, strings, visibleText } from './render.tsx';

const en = translator(loadCatalog('tower', 'en'));
const fr = translator(loadCatalog('tower', 'fr'));

test('the workspace line names each service, its live sessions and its train', async () => {
  const markup = renderTowerBody(towerModel(await workspaceFixture(FIXTURE_NOW), FIXTURE_NOW, OWNER_ID), en);
  assert.match(markup, /<ul class="workspace-line" aria-label="Services">/);
  assert.match(markup, /<li class="svc" data-service="guestbook" data-state="landing"><span class="svc-name">guestbook<\/span> <span class="svc-state">3 live sessions · <span class="svc-train">landing LOCAL-169<\/span><\/span><\/li>/);
  assert.match(markup, /<li class="svc" data-service="filter-api" data-state="rolled_back"><span class="svc-name">filter-api<\/span> <span class="svc-state">2 live sessions · <span class="svc-train">rolled back LOCAL-168<\/span><\/span><\/li>/);
  assert.doesNotMatch(markup, /\sstyle=/);
});

test('a session taken over reads "taken over by you" in place of its phrase, with its service, and no pulse', async () => {
  const markup = renderTowerBody(towerModel(await workspaceFixture(FIXTURE_NOW), FIXTURE_NOW, OWNER_ID), en);
  const card = /<li class="session-card taken"[^]*?<\/li>/.exec(markup)?.[0] ?? '';
  assert.match(card, /<span class="live taken" aria-hidden="true"><\/span>/);
  assert.match(card, /<span class="phrase taken-line"><svg[^>]*aria-hidden="true"[^]*?<\/svg>Taken over by you · 6 min<\/span>/);
  assert.match(card, /<span class="svc-tag">filter-api<\/span>/);
  assert.match(card, /href="\/sessions\/fixture-taken-170"/);
  assert.equal(markup.match(/<span class="svc-tag">/g)?.length, 5, 'every live session names its service');
});

test('the bar offers a chip per service, pressed when picked', () => {
  const markup = html(<Bar t={en} title="" body="" services={['guestbook', 'filter-api']} picked={['filter-api']} />);
  assert.match(markup, /<div class="ask-services" role="group" aria-label="Services this ticket touches">/);
  assert.match(markup, /<button[^>]*aria-pressed="false"[^>]*data-service="guestbook"[^>]*>guestbook<\/button>/);
  assert.match(markup, /<button[^>]*aria-pressed="true"[^>]*data-service="filter-api"[^>]*>filter-api<\/button>/);
  assert.doesNotMatch(html(<Bar t={en} title="" body="" services={['guestbook']} picked={[]} />), /ask-services|data-service/);
  assert.doesNotMatch(html(<Bar t={en} title="" body="" />), /ask-services/);
});

test('a one-service workspace draws the tower as before', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const before = renderTower(towerModel(base, FIXTURE_NOW), en);
  assert.doesNotMatch(before, /workspace-line|svc-tag|taken/);
  assert.equal(renderTower(towerModel({ ...base, workspace: null }, FIXTURE_NOW, OWNER_ID), en), before);
});

test('in French, and every word from the catalog or the data', async () => {
  const data = await workspaceFixture(FIXTURE_NOW);
  const markup = renderTowerBody(towerModel(data, FIXTURE_NOW, OWNER_ID), fr);
  assert.match(markup, /Repris en main par vous · 6 min/);
  assert.match(markup, /3 sessions en cours · <span class="svc-train">atterrit LOCAL-169<\/span>/);
  const sentinel: Translate = (key) => `«${key}»`;
  const model = towerModel(data, FIXTURE_NOW, OWNER_ID);
  const allowed = strings(data);
  for (const card of model.live) allowed.add(`${card.harness === 'claude-code' ? 'claude' : card.harness} · ${card.model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')}`);
  for (const row of model.landed) allowed.add(row.time);
  for (const text of visibleText(renderTowerBody(model, sentinel) + html(<Bar t={sentinel} title="" body="" services={model.serviceNames} picked={[]} />))) {
    const rest = text.replace(/«[a-z0-9_]+»/g, '').trim();
    if (!/\p{L}/u.test(rest)) continue;
    assert.ok(allowed.has(rest), `not from the catalog nor the data: ${JSON.stringify(rest)}`);
  }
});
