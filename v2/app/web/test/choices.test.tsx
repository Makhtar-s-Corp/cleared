// The clickable answers as HTML: the options as buttons with the
// recommendation marked, a multiple choice that toggles, the free answer,
// Send, the busy state, the states once the question no longer waits, the
// French catalog and the escaping.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Question } from '../../../src/session/events.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { Choices } from '../components/choices/Choices.tsx';
import { emptyDraft, pick, typeFree, type ChoiceStatus } from '../components/choices/model.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { html, visibleText } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
const count = (markup: string, pattern: RegExp) => [...markup.matchAll(pattern)].length;

const week: Question = {
  question: 'Should a week that spans two months appear under the first month or be split?',
  header: 'Month edges',
  options: [
    { label: 'Under the first month (Recommended)', description: 'One heading per week, as the list reads today.' },
    { label: 'Split at the month\'s end' },
    { label: 'Under the month with more days' },
  ],
};
const days: Question = { question: 'Which days show a heading?', multiSelect: true, options: [{ label: 'Monday' }, { label: 'Saturday' }, { label: 'Sunday' }] };

const render = (questions: readonly Question[], status: ChoiceStatus, t: Translate = en, extra: { free?: boolean; send?: 'inline' | 'bar' } = {}) =>
  html(<Choices questions={questions} status={status} t={t} requestId="q-1" {...extra} />);

test('a waiting question shows each option as a button carrying its label as written, the recommendation marked, and a free answer', () => {
  const markup = render([week], { kind: 'waiting' });
  assert.deepEqual([...markup.matchAll(/<button[^>]*data-answer="([^"]*)"/g)].map((m) => m[1]), ['Under the first month (Recommended)', 'Split at the month&#39;s end', 'Under the month with more days']);
  assert.match(markup, /<span class="choice-label">Under the first month<\/span><span class="choice-rec">Recommended<\/span><span class="choice-desc">One heading per week, as the list reads today\.<\/span>/);
  assert.match(markup, /<span class="choice-header">Month edges<\/span>/);
  assert.match(markup, /<form class="choices" data-choices="true" data-request-id="q-1" novalidate="">/);
  assert.match(markup, /<input type="text" class="choice-free-input" data-free="0" maxlength="2000"/);
  assert.match(markup, /<button type="submit"[^>]*class="choice-send" data-choice-send="true" disabled="">Send the answer<\/button>/, 'Send waits for a free answer');
  assert.doesNotMatch(markup, /aria-pressed/, 'a click on a single choice answers: these buttons are actions, not toggles');
  const text = visibleText(markup);
  for (const expected of [week.question, 'Under the first month', 'Recommended', 'Split at the month\'s end', 'Or answer in your own words', 'Send the answer']) assert.ok(text.includes(expected), expected);
});

test('without a free field of its own and with one choice to click, there is nothing to send', () => {
  const markup = render([week], { kind: 'waiting' }, en, { free: false });
  assert.doesNotMatch(markup, /data-free|data-choice-send/);
  assert.equal(count(markup, /<button[^>]*data-answer=/g), 3);
});

test('a multiple choice toggles: its buttons say whether they are pressed, and Send is enabled once each question has an answer', () => {
  const draft = pick([days], emptyDraft([days]), 0, 'Saturday');
  const markup = render([days], { kind: 'waiting', draft }, en, { free: false });
  assert.match(markup, /aria-pressed="true"[^>]*data-answer="Saturday"|data-answer="Saturday"[^>]*aria-pressed="true"/);
  assert.equal(count(markup, /aria-pressed="false"/g), 2);
  assert.match(markup, /data-multi="true"/);
  assert.match(markup, /class="choice-send" data-choice-send="true">Send the answer<\/button>/);
  assert.match(render([days], { kind: 'waiting' }, en, { free: false }), /data-choice-send="true" disabled=""/, 'nothing picked yet');
});

test('in the inbox the clicks only pick and the screen\'s bar sends: no form, no Send of its own', () => {
  const markup = render([week], { kind: 'waiting', draft: pick([week], emptyDraft([week]), 0, 'Split at the month\'s end') }, en, { send: 'bar' });
  assert.match(markup, /^<div class="choices" data-choices="true"/);
  assert.doesNotMatch(markup, /<form|data-choice-send/);
  assert.equal(count(markup, /aria-pressed="true"/g), 1, 'one question, one choice: still a pick here');
  assert.match(markup, /data-free="0"/);
});

test('a free answer typed before a redraw is drawn again; one over the limit says so and cannot be sent; the buttons wait while an answer is on its way', () => {
  const typed = typeFree(emptyDraft([week]), 0, 'Under the second <month>');
  const markup = render([week], { kind: 'waiting', draft: typed });
  assert.match(markup, /value="Under the second &lt;month&gt;"/);
  assert.match(markup, /data-choice-send="true">Send the answer/);
  const long = render([week], { kind: 'waiting', draft: typeFree(emptyDraft([week]), 0, 'x'.repeat(2001)) });
  assert.match(long, /<p class="choice-note" role="status">An answer is at most 2,000 characters\.<\/p>/);
  assert.match(long, /data-choice-send="true" disabled=""/);
  const busy = render([week], { kind: 'waiting', draft: typed, busy: true });
  assert.equal(count(busy, /<button[^>]*disabled=""/g), 4, 'three options and Send');
  assert.match(busy, /data-free="0"[^>]*disabled=""|disabled=""[^>]*data-free="0"/);
});

test('once it no longer waits the options are lines, without a button, those sent marked, with what happened', () => {
  const answered = render([week], { kind: 'answered', who: 'you', sent: 'Split at the month\'s end', chosen: ['Split at the month\'s end'] });
  assert.doesNotMatch(answered, /<button|<input|<form/);
  assert.match(answered, /data-choices-state="answered"/);
  assert.equal(count(answered, /class="choice-line chosen"/g), 1);
  assert.match(answered, /<li class="choice-line chosen"><svg[^>]*class="choice-mark"[^>]*>.*?<\/svg><span class="choice-label">Split at the month&#39;s end<\/span><\/li>/);
  assert.ok(visibleText(answered).includes('Answered by you: Split at the month\'s end'));
  assert.ok(visibleText(render([week], { kind: 'answered', who: 'a teammate' })).includes('Answered by a teammate'));
  assert.ok(visibleText(render([week], { kind: 'cancelled' })).includes('Cancelled when the turn was interrupted'));
  assert.ok(visibleText(render([week], { kind: 'settled' })).includes('This question was settled without you.'));
  assert.ok(visibleText(render([week], { kind: 'ended' })).includes('The session ended before an answer.'));
  const read = render([week], { kind: 'read' });
  assert.doesNotMatch(read, /choice-foot|<button/);
  assert.equal(count(render([days], { kind: 'answered', who: 'you', chosen: ['Monday', 'Sunday'] }), /class="choice-line chosen"/g), 2, 'every pick of a multiple choice is marked');
});

test('in French no English sentence is left', () => {
  const words = [
    ...visibleText(render([week], { kind: 'waiting', draft: typeFree(emptyDraft([week]), 0, 'x'.repeat(2001)) }, fr)),
    ...(['answered', 'cancelled', 'settled', 'ended'] as const).flatMap((kind) => visibleText(render([week], kind === 'answered' ? { kind, who: 'vous', sent: 'Oui' } : { kind }, fr))),
  ];
  for (const english of ['Or answer in your own words', 'Send the answer', 'Recommended', 'Answered by', 'Cancelled', 'settled without you', 'ended before', 'at most']) {
    assert.ok(!words.some((w) => w.includes(english)), `English left in French: ${english}`);
  }
});

test('what the question says is escaped, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>"&';
  const markup = render([{ question: evil, header: evil, options: [{ label: evil, description: evil }] }], { kind: 'waiting', draft: typeFree(emptyDraft([week]), 0, evil) });
  assert.ok(!markup.includes('<img'));
  assert.ok(!markup.includes('data-answer="<'));
  assert.ok(visibleText(render([week], { kind: 'answered', who: 'you', sent: evil })).some((line) => line.includes(evil)));
});
