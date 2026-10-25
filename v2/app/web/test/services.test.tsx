// The service map screen as HTML (milestone 4, section 11): the drawing is
// one image with its name, the links are said in words beside it, each
// service is a button that shows its impact, the legend says each kind in
// words as well as by its line; in both languages, every word from the
// catalog, no raw time.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { serviceMapFixture } from '../../fixtures/services.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { ServicesView } from '../screens/services/Services.tsx';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('services', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('services', 'fr') });
const later = new Date(FIXTURE_NOW.getTime() + 3 * 60_000);
const render = (t: Translate, picked: string | null = null, note = '') =>
  html(<ServicesView map={serviceMapFixture(FIXTURE_NOW)} t={t} now={later} picked={picked} note={note} />);

test('the screen draws the map as one named image, with its links in words and its legend', () => {
  const markup = render(en);
  assert.match(markup, /<section class="services"[^>]*data-screen="services"/);
  assert.match(markup, /<h1[^>]*>Service map<\/h1>/);
  assert.match(markup, /<svg[^>]*role="img"[^>]*aria-labelledby="services-diagram-title"/);
  assert.match(markup, /<title id="services-diagram-title">Service map diagram\. The list of links says the same in words\.<\/title>/);
  assert.equal(markup.match(/<g class="map-box" data-box="service"/g)?.length, 2);
  assert.equal(markup.match(/<g class="map-box" data-box="database"/g)?.length, 1);
  assert.match(markup, /<path class="map-edge" data-edge="call"/);
  assert.match(markup, /<path class="map-edge" data-edge="database"/);
  const text = visibleText(markup).join('\n');
  assert.match(text, /guestbook calls filter-api: POST \/check/);
  assert.match(text, /declared and found in the code/);
  assert.match(text, /guestbook uses PostgreSQL of guestbook: entries/);
  assert.match(text, /src\/filter\.ts:38/);
  for (const word of ['Call', 'Event', 'Database']) assert.match(text, new RegExp(word));
  assert.match(text, /Built 3\smin ago from the base branches/);
});

test('each service is a button; the one picked is pressed and its impact is shown', () => {
  const none = render(en);
  assert.equal(none.match(/<button[^>]*data-service="[a-z-]+"[^>]*aria-pressed="false"/g)?.length, 2);
  assert.match(visibleText(none).join('\n'), /Pick a service to see what a change of it reaches\./);
  const picked = render(en, 'filter-api');
  assert.match(picked, /<button[^>]*data-service="filter-api"[^>]*aria-pressed="true"/);
  const text = visibleText(picked).join('\n');
  assert.match(text, /If filter-api changes/);
  assert.match(text, /guestbook calls it: POST \/check/);
  assert.match(text, /guestbook must change in the same ticket/);
  assert.match(text, /Landing order: filter-api, then guestbook/);
});

test('in French, every word from the catalog', () => {
  const text = visibleText(render(fr, 'filter-api')).join('\n');
  assert.match(text, /Carte des services/);
  assert.match(text, /guestbook appelle filter-api\s:\sPOST \/check/);
  assert.match(text, /Si filter-api change/);
  assert.match(text, /Construite il y a 3\smin/);
  assert.doesNotMatch(text, /⟦/);
});

test('a refusal is said as an alert, and Refresh is a button', () => {
  const markup = render(en, null, 'The map could not be refreshed. Try again in a moment.');
  assert.match(markup, /role="alert"[^>]*>The map could not be refreshed\. Try again in a moment\.</);
  assert.match(markup, /<button[^>]*id="services-refresh"[^>]*>[\s\S]*?Refresh/);
});
