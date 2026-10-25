// A team's question says when it stops waiting for the owner and what then
// applies, and a parked plan item says so (issue #290), in English and in
// French, the time through the shell's duration formatter.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { QuestionItem } from '../../../../src/api/types.ts';
import { QUESTION_ID, inboxFixture } from '../../../fixtures/inbox.ts';
import { servicePlan } from '../../../fixtures/lead.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { deadlineLine, type InboxView } from '../../screens/inbox/model.ts';
import { renderInbox, renderPlanPanel, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });
const lead = { en: translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') }), fr: translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') }) };
const MIN = 60_000;
const iso = (minutes: number) => new Date(FIXTURE_NOW.getTime() + minutes * MIN).toISOString();

const question = (timeout: QuestionItem['timeout']): QuestionItem => {
  const item = inboxFixture(FIXTURE_NOW).items.find((i) => i.kind === 'question' && i.id.endsWith(QUESTION_ID)) as QuestionItem;
  return { ...item, ...(timeout ? { timeout } : {}) };
};
const declared = { at: iso(25), leadUntil: iso(35), answers: { 'Which name?': 'Show “Anonymous” (Recommended)' } };

test('before its delay: when the Lead decides, then the declared answer, without its "(Recommended)"', () => {
  assert.equal(deadlineLine(question(declared), FIXTURE_NOW, en), 'No answer in 25\u00a0min: the Lead decides, else “Show “Anonymous”” applies.');
  assert.equal(deadlineLine(question(declared), FIXTURE_NOW, fr), 'Sans réponse d\'ici 25 min, le Lead décide, sinon « Show “Anonymous” » s\'applique.');
  assert.equal(deadlineLine(question({ ...declared, at: iso(90), leadUntil: iso(100) }), FIXTURE_NOW, en), 'No answer in 1h\u00a030m: the Lead decides, else “Show “Anonymous”” applies.', 'a duration past an hour is in hours');
});

test('once the Lead is asked: its own window; with no declared answer, the ticket is parked', () => {
  const asked = { ...declared, at: iso(-5), leadUntil: iso(5), leadAt: iso(-5) };
  assert.equal(deadlineLine(question(asked), FIXTURE_NOW, en), 'The Lead decides within 5\u00a0min, else “Show “Anonymous”” applies.');
  assert.equal(deadlineLine(question({ ...asked, answers: null }), FIXTURE_NOW, en), 'The Lead decides within 5\u00a0min, else the ticket is parked.');
  assert.equal(deadlineLine(question({ ...declared, answers: null }), FIXTURE_NOW, fr), 'Sans réponse d\'ici 25 min, le Lead décide, sinon le ticket est mis de côté.');
  assert.equal(deadlineLine(question({ ...asked, answers: null }), FIXTURE_NOW, fr), 'Le Lead décide d\'ici 5 min, sinon le ticket est mis de côté.');
});

test('a question without a delay, or handled, says nothing; the detail shows the line under the question', () => {
  assert.equal(deadlineLine(question(undefined), FIXTURE_NOW, en), undefined);
  assert.equal(deadlineLine({ ...question(declared), state: 'handled' }, FIXTURE_NOW, en), undefined);
  const fixture = inboxFixture(FIXTURE_NOW);
  const items = fixture.items.map((i) => (i.kind === 'question' && i.id.endsWith(QUESTION_ID) ? question(declared) : i));
  const view: InboxView = {
    items, tickets: fixture.tickets, sessions: fixture.sessions, selected: question(declared).id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop',
  };
  const html = renderInbox(view, en);
  assert.ok(visibleText(html).includes('No answer in 25\u00a0min: the Lead decides, else “Show “Anonymous”” applies.'));
  assert.match(html, /<p class="d-deadline">/);
});

test('a parked plan item says Parked, Mis de côté in French', () => {
  const plan = servicePlan(FIXTURE_NOW);
  const parked = { ...plan, state: 'approved' as const, items: plan.items.map((item, i) => (i === 0 ? { ...item, state: 'parked' as const } : item)) };
  assert.ok(visibleText(renderPlanPanel(parked, lead.en)).includes('Parked'));
  assert.ok(visibleText(renderPlanPanel(parked, lead.fr, { language: 'fr' })).includes('Mis de côté'));
});
