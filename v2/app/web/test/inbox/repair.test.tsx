// The release card while its failed checks are repaired (issue #273), as
// HTML in English and in French: the repair's fact at each state, the
// list's line once the attempts are spent, and nothing before a check failed.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { CiRepair, ReleaseItem } from '../../../../src/api/types.ts';
import { RELEASE_TICKET, inboxFixture } from '../../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { detailKey, itemLine, type InboxView } from '../../screens/inbox/model.ts';
import { renderDetail, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });

const fixture = inboxFixture(FIXTURE_NOW);
const release = fixture.items.find((i): i is ReleaseItem => i.kind === 'release' && i.state === 'waiting') as ReleaseItem;
const repaired = (repair: Partial<CiRepair>, state: ReleaseItem['state'] = 'waiting'): ReleaseItem => ({
  ...release, state, pr: { ...release.pr, checks: repair.state === 'repaired' ? 'passed' : repair.state === 'pushed' ? 'pending' : 'failed' },
  repair: { attempt: 1, limit: 2, state: 'started', checks: ['test'], at: FIXTURE_NOW.toISOString(), ...repair },
});

function viewOf(item: ReleaseItem, language: 'en' | 'fr' = 'en'): InboxView {
  return {
    items: [item], tickets: fixture.tickets, sessions: fixture.sessions, selected: item.id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', language,
  };
}
const shown = (item: ReleaseItem, t: Translate, language: 'en' | 'fr' = 'en') => visibleText(renderDetail(viewOf(item, language), t)).join('\n');

test('each state of a repair is a fact of the card, in English and in French', () => {
  const cases: [Partial<CiRepair>, ReleaseItem['state'], string, string][] = [
    [{ state: 'started', checks: ['test', 'lint'] }, 'handled', 'test, lint failed: attempt 1 of 2 started on the ticket branch', 'Échec de test, lint : tentative 1 sur 2 lancée sur la branche du ticket'],
    [{ state: 'pushed' }, 'waiting', 'Attempt 1 of 2 published, checks running', 'Tentative 1 sur 2 publiée, contrôles en cours'],
    [{ state: 'repaired', attempt: 2 }, 'waiting', 'Repaired by attempt 2 of 2', 'Réparé par la tentative 2 sur 2'],
    [{ state: 'gave_up', attempt: 2 }, 'waiting', 'Still failing after 2 attempts (test): nothing more is tried, you decide', 'Toujours en échec après 2 tentatives (test) : rien de plus n\'est tenté, à vous de décider'],
    [{ state: 'refused', attempt: 0, checks: [] }, 'waiting', 'Not repaired: the branch is a base branch', 'Pas de réparation : la branche est une branche de base'],
  ];
  for (const [repair, state, english, french] of cases) {
    const item = repaired(repair, state);
    assert.match(renderDetail(viewOf(item), en), new RegExp(`data-repair="${repair.state}"`));
    const inEnglish = shown(item, en);
    assert.ok(inEnglish.includes('Repair of the checks'), `the fact's label for ${repair.state}`);
    assert.ok(inEnglish.includes(english), `missing in English: ${english}`);
    const inFrench = shown(item, fr, 'fr');
    assert.ok(inFrench.includes('Réparation des contrôles'));
    assert.ok(inFrench.includes(french), `missing in French: ${french}`);
  }
});

test('the checks unnamed by the forge are "the checks"; no repair, no fact', () => {
  assert.ok(shown(repaired({ state: 'gave_up', attempt: 2, checks: [] }), en).includes('Still failing after 2 attempts (the checks)'));
  assert.ok(shown(repaired({ state: 'gave_up', attempt: 2, checks: [] }), fr, 'fr').includes('Toujours en échec après 2 tentatives (les contrôles)'));
  const plain = renderDetail(viewOf(release), en);
  assert.doesNotMatch(plain, /data-repair/);
  assert.ok(!visibleText(plain).join('\n').includes('Repair of the checks'));
});

test('the list says when the attempts are spent, and the detail is redrawn as the repair moves', () => {
  const spent = repaired({ state: 'gave_up', attempt: 2 });
  assert.equal(itemLine(spent, viewOf(spent), en), `${RELEASE_TICKET} · Checks still failing after 2 repair attempts`);
  assert.equal(itemLine(spent, viewOf(spent, 'fr'), fr), `${RELEASE_TICKET} · Contrôles toujours en échec après 2 tentatives de réparation`);
  const pushed = repaired({ state: 'pushed' });
  assert.equal(itemLine(pushed, viewOf(pushed), en), `${RELEASE_TICKET} · Reviewed by Sonnet, checks running`);
  const keys = new Set([release, pushed, repaired({ state: 'repaired' }), repaired({ state: 'pushed', attempt: 2 })].map((item) => detailKey(viewOf(item))));
  assert.equal(keys.size, 4);
});

test('no long dash in what the repair says', () => {
  for (const language of ['en', 'fr'] as const) {
    const catalog = loadCatalog('inbox', language);
    for (const [key, value] of Object.entries(catalog)) if (key.includes('repair')) assert.doesNotMatch(String(value), /[\u2014\u2013]/, key);
  }
});
