// The bar's number of authors (issue #271, P75): on a workspace of one
// service, one author or 2 to 4 variants, pressed as chosen; a workspace of
// several services has no such choice; the ticket's body says the variants
// only when more than one author is asked for.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { Bar } from '../screens/tower/Tower.tsx';
import { VARIANT_CHOICES, newTicket } from '../screens/tower/model.ts';
import { html, visibleText } from './render.tsx';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('tower', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('tower', 'fr') });

const pressed = (markup: string) => [...markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*data-variants="(\d)"/g)].map((m) => `${m[2]}:${m[1]}`);

test('a one-service workspace offers one author or 2 to 4 variants, the choice pressed', () => {
  assert.deepEqual(VARIANT_CHOICES, [1, 2, 3, 4]);
  const markup = html(<Bar t={en} title="Newest first" body="" services={['guestbook']} variants={3} />);
  assert.match(markup, /<div class="ask-variants" role="group" aria-label="How many authors work this ticket at once">/);
  assert.deepEqual(pressed(markup), ['1:false', '2:false', '3:true', '4:false']);
  assert.match(markup, /aria-label="3 variants, compared in the inbox"/);
  assert.match(markup, /aria-label="1 author"/);
  assert.match(html(<Bar t={fr} title="x" body="" />), /aria-label="Combien d&#39;auteurs travaillent ce ticket en même temps"/);
  assert.deepEqual(pressed(html(<Bar t={en} title="" body="" />)), ['1:true', '2:false', '3:false', '4:false'], 'one author by default');
  for (const text of visibleText(html(<Bar t={sentinel} title="x" body="" />))) assert.ok(!/Authors|1 author|One author|compared in/.test(text), `"${text}" is not from the catalog`);
});

test('a workspace of several services has no variants: the services are its choice', () => {
  const markup = html(<Bar t={en} title="x" body="" services={['guestbook', 'filter-api']} picked={[]} variants={2} />);
  assert.doesNotMatch(markup, /ask-variants|data-variants/);
});

test('the body names the variants only for more than one author', () => {
  assert.deepEqual(newTicket(' Newest first ', '', 'guestbook'), { title: 'Newest first', project: 'guestbook' });
  assert.deepEqual(newTicket('Newest first', '', 'guestbook', [], 1), { title: 'Newest first', project: 'guestbook' });
  assert.deepEqual(newTicket('Newest first', 'Sort it.', 'guestbook', [], 3), { title: 'Newest first', project: 'guestbook', body: 'Sort it.', variants: 3 });
});
