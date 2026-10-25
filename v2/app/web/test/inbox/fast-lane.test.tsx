// The release card of a Quick ticket (matrix B2.2), as HTML in English and
// in French: on the fast lane, the approval is asked while the full checks
// run, and the card says it lands once they are green; sent back to the
// full circuit, it says why in the rules' words, never the path; a card
// without a lane says nothing of one.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { FastLane, ReleaseItem } from '../../../../src/api/types.ts';
import { inboxFixture } from '../../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import type { InboxView } from '../../screens/inbox/model.ts';
import { renderDetail, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });

const fixture = inboxFixture(FIXTURE_NOW);
const release = fixture.items.find((i): i is ReleaseItem => i.kind === 'release' && i.state === 'waiting') as ReleaseItem;
const card = (fastLane: FastLane | undefined, checks: ReleaseItem['pr']['checks'] = 'pending'): ReleaseItem => {
  const { fastLane: _, ...rest } = release;
  return { ...rest, pr: { ...release.pr, checks }, ...(fastLane ? { fastLane } : {}) };
};

function viewOf(item: ReleaseItem, language: 'en' | 'fr' = 'en'): InboxView {
  return {
    items: [item], tickets: fixture.tickets, sessions: fixture.sessions, selected: item.id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', language,
  };
}
const shown = (item: ReleaseItem, t: Translate, language: 'en' | 'fr' = 'en') => visibleText(renderDetail(viewOf(item, language), t)).join('\n');

test('on the fast lane the card says the approval can be given while the full checks run, in English and in French', () => {
  const cases: [ReleaseItem['pr']['checks'], string, string][] = [
    ['pending', 'Fast lane: approve now, it lands once all checks are green', 'Voie rapide\u00a0: approuvez dès maintenant, la mise en production attend que tous les contrôles soient au vert'],
    ['passed', 'Fast lane: all checks green', 'Voie rapide\u00a0: tous les contrôles au vert'],
    ['failed', 'Fast lane: checks failed', 'Voie rapide\u00a0: contrôles en échec'],
  ];
  for (const [checks, english, french] of cases) {
    const item = card({ state: 'fast', reasons: [] }, checks);
    assert.match(renderDetail(viewOf(item), en), /data-lane="fast"/);
    const inEnglish = shown(item, en);
    assert.ok(inEnglish.includes('Lane'), 'the fact\'s label');
    assert.ok(inEnglish.includes(english), `missing in English: ${english}`);
    const inFrench = shown(item, fr, 'fr');
    assert.ok(inFrench.includes('Circuit'));
    assert.ok(inFrench.includes(french), `missing in French: ${french}`);
  }
});

test('sent back to the full circuit, or not fast at this version, the card says why in the rules\' words', () => {
  const back = card({ state: 'full', reasons: ['outside_safe', 'dependency'] });
  assert.match(renderDetail(viewOf(back), en), /data-lane="full"/);
  assert.ok(shown(back, en).includes('Back to the full circuit: a file outside the safe list, it changes a dependency'));
  assert.ok(shown(back, fr, 'fr').includes('Repassé en circuit complet\u00a0: un fichier hors de la liste sûre, il change une dépendance'));
  const off = card({ state: 'off', reasons: ['disabled'] });
  assert.ok(shown(off, en).includes('Full circuit for this version: the fast lane is off for this service'));
  assert.ok(shown(off, fr, 'fr').includes('Circuit complet pour cette version\u00a0: la voie rapide est désactivée pour ce service'));
  const several = card({ state: 'full', reasons: ['several_services'] });
  assert.ok(shown(several, en).includes('Back to the full circuit: the ticket changes several services'));
  assert.ok(shown(several, fr, 'fr').includes('Repassé en circuit complet\u00a0: le ticket change plusieurs services'));
});

test('every reason the service can give has its words in both languages', () => {
  const reasons: FastLane['reasons'] = ['empty', 'too_many_files', 'too_many_lines', 'too_large', 'unusual_change', 'binary', 'path_form', 'protected', 'dependency', 'migration',
    'outside_safe', 'file_type', 'content', 'link', 'asked', 'unreadable', 'settings', 'disabled', 'several_services'];
  for (const reason of reasons) {
    for (const [t, language] of [[en, 'en'], [fr, 'fr']] as const) {
      const text = shown(card({ state: 'full', reasons: [reason] }), t, language);
      assert.ok(!text.includes(`fast_reason_${reason}`), `${reason} has no words in ${language}`);
    }
  }
});

test('a card without a lane says nothing of one', () => {
  const plain = card(undefined);
  assert.doesNotMatch(renderDetail(viewOf(plain), en), /data-lane/);
  assert.ok(!shown(plain, en).includes('Fast lane'));
  assert.ok(!shown(plain, en).includes('full circuit'));
});
