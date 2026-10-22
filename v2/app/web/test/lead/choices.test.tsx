// The lead's question on the lead screen, through the clickable answers: a
// question with three options as the lead's rule asks for them, the reply
// a click or Send makes, the buttons waiting while it is on its way, and
// the question once handled, read as a line of the lead as in the capture.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { LeadMessage } from '../../../../src/api/types.ts';
import type { Question } from '../../../../src/session/events.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { leadFixture, waitingForAnswer } from '../../../fixtures/lead.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { Thread } from '../../screens/lead/Lead.tsx';
import { choiceReply, type LeadView } from '../../screens/lead/model.ts';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });
const count = (markup: string, pattern: RegExp) => [...markup.matchAll(pattern)].length;

const PAGES: Question = {
  question: 'On desktop, do you want the entries in pages of 20, or one long list as on the phone?',
  header: 'Desktop list',
  options: [
    { label: 'Pages of 20 (Recommended)', description: 'A page bar under the list; the phone keeps the long list.' },
    { label: 'One long list' },
    { label: 'Pages of 50' },
  ],
};

// The fixture's waiting question, with the three options of the lead's rule.
async function waitingView(questions: readonly Question[] = [PAGES]): Promise<LeadView> {
  const fixture = await leadFixture(FIXTURE_NOW);
  const waiting = waitingForAnswer(fixture);
  const messages = waiting.messages.map((m): LeadMessage => (m.question ? { ...m, question: { ...m.question, questions } } : m));
  return { state: waiting.state, messages, plans: fixture.plans, planId: null, now: FIXTURE_NOW, language: 'en', memory: null };
}

test('three options as buttons inside the question bubble, each carrying its label as written, the reply field as the free answer', async () => {
  const markup = html(<Thread view={await waitingView()} t={en} />);
  const bubble = /<div class="bubble lead question waits">([\s\S]*?)<\/div><\/li>/.exec(markup)?.[1] ?? '';
  assert.deepEqual([...bubble.matchAll(/<button[^>]*data-answer="([^"]+)"/g)].map((m) => m[1]), ['Pages of 20 (Recommended)', 'One long list', 'Pages of 50'], 'proof-j2 reads #thread .bubble.question [data-answer]');
  assert.equal(count(bubble, /class="choice-rec">Recommended</g), 1);
  assert.match(bubble, /A page bar under the list; the phone keeps the long list\./);
  assert.doesNotMatch(bubble, /data-free=|data-choice-send/);
  assert.ok(visibleText(markup).includes('Or write your answer below.'));
});

test('a click sends the label as written, "(Recommended)" kept; a multiple choice sends its picks in one message; several questions one line each', () => {
  assert.deepEqual(choiceReply([PAGES], { [PAGES.question]: 'Pages of 20 (Recommended)' }), { kind: 'answer', body: { text: 'Pages of 20 (Recommended)' } });
  const days: Question = { question: 'Which days show a heading?', multiSelect: true, options: [{ label: 'Monday' }, { label: 'Sunday' }] };
  assert.deepEqual(choiceReply([days], { [days.question]: 'Monday, Sunday' }), { kind: 'answer', body: { text: 'Monday, Sunday' } });
  const phone: Question = { question: 'And on the phone?', options: [{ label: 'Same' }] };
  assert.deepEqual(choiceReply([PAGES, phone], { [PAGES.question]: 'Pages of 50', [phone.question]: 'Same' }), { kind: 'answer', body: { text: 'Desktop list: Pages of 50\nAnd on the phone?: Same' } });
});

test('the buttons wait while the answer is on its way; once handled the question reads as a line of the lead', async () => {
  const view = await waitingView();
  const busy = html(<Thread view={view} t={en} busy />);
  assert.equal(count(busy, /<button[^>]*disabled=""[^>]*data-answer=|<button[^>]*data-answer=[^>]*disabled=""/g), 3);
  const handled = html(<Thread view={{
    ...view, state: { ...view.state, pendingQuestion: null },
    messages: view.messages.map((m) => (m.question ? { ...m, question: { ...m.question, state: 'handled' as const } } : m)),
  }} t={en} />);
  assert.doesNotMatch(handled, /data-answer=|class="choices"/);
  assert.match(handled, /<div class="bubble lead question"><p class="bubble-text">On desktop, do you want the entries in pages of 20/);
});

test('in French the question\'s words come from the French catalog', async () => {
  const text = visibleText(html(<Thread view={{ ...(await waitingView()), language: 'fr' }} t={fr} />));
  assert.ok(text.includes('Recommandé'));
  for (const english of ['Recommended', 'Or write your answer below.']) assert.ok(!text.includes(english), english);
});
