// The Services screen's nightly pass panel as HTML (issue #455): each
// service with its box, checked while its pass is on, and what its last
// run did; a refusal in words. Both languages, every word from the catalogs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { DreamingView } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { DreamingPanel } from '../screens/services/Dreaming.tsx';
import { dreamingRefusal, lastPassLine } from '../screens/services/dreaming.ts';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('services', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('services', 'fr') });
const each = (run: (t: Translate, language: 'en' | 'fr') => void) => { run(en, 'en'); run(fr, 'fr'); };

const VIEW: DreamingView = {
  services: [
    { service: 'guestbook', enabled: true, last: { at: '2026-10-28T02:10:00.000Z', outcome: 'done', proposed: 2 } },
    { service: 'filter-api', enabled: false, last: null },
    { service: 'mailer', enabled: true, last: { at: '2026-10-27T02:10:00.000Z', outcome: 'quota', proposed: 0 } },
  ],
};

test('one box per service, checked while its pass is on, with what its last run did', () => {
  each((t, language) => {
    const markup = html(<DreamingPanel t={t} view={VIEW} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.ok(!markup.includes(String.fromCharCode(0x2014)), `${language}: no long dash`);
    assert.match(markup, /<section[^>]*aria-labelledby="dreaming-title"/);
    const boxes = [...markup.matchAll(/<input type="checkbox" id="dreaming-(\d)"([^>]*)>/g)].map((m) => /checked/.test(m[2] as string));
    assert.deepEqual(boxes, [true, false, true], language);
    // Each box has its label.
    for (const i of [0, 1, 2]) assert.match(markup, new RegExp(`<label for="dreaming-${i}">`), language);
    const text = visibleText(markup).join('\n');
    assert.ok(text.includes(t('dreaming_intro')), language);
    assert.ok(text.includes(t('dreaming_off')), language);
  });
  assert.equal(lastPassLine(VIEW.services[0]?.last ?? null, en), 'On. Last pass on 28 October: 2 proposals.');
  assert.equal(lastPassLine(VIEW.services[2]?.last ?? null, en), 'On. On 27 October the pass waited: the week\'s quota was at its stop.');
  assert.equal(lastPassLine(null, fr), 'Activée. Aucune passe pour le moment.');
  assert.equal(lastPassLine({ at: '2026-10-28T02:10:00.000Z', outcome: 'done', proposed: 1 }, fr), 'Activée. Dernière passe le 28 octobre : une proposition.');
});

test('a refusal in words: the owner\'s switch, or the general one', () => {
  assert.equal(dreamingRefusal(en, 403), 'Only the workspace\'s owner turns the pass on or off.');
  assert.equal(dreamingRefusal(fr, 500), 'La passe n\'a pas pu être modifiée. Réessayez dans un instant.');
  const markup = html(<DreamingPanel t={en} view={VIEW} error={dreamingRefusal(en, 403)} busy />);
  assert.match(markup, /role="alert"[^>]*>Only the workspace/);
  assert.equal([...markup.matchAll(/<input[^>]*disabled/g)].length, 3);
});
