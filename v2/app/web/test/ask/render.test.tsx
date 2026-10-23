// The /ask/:id screen as HTML (decision 28, lane 27): the question and what
// it is about, each turn with its answer as text and its cost, the total
// with the week share, and the follow-up field, held while a turn runs; in
// both languages, every word from the catalog or the data, no inline style.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ASK_ANSWER, ASK_ID, ASK_QUESTION, FOLLOW_QUESTION, askFixture, platformAsk } from '../../../fixtures/ask.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { AskScreen } from '../../screens/ask/Ask.tsx';
import { QUESTION_MAX } from '../../screens/ask/model.ts';
import { html, strings, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('ask', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('ask', 'fr') });
const render = (t: Translate, ask = askFixture(), extra: { draft?: string; note?: string; busy?: boolean; language?: 'en' | 'fr' } = {}) =>
  html(<AskScreen ask={ask} t={t} language={extra.language ?? 'en'} draft={extra.draft ?? ''} note={extra.note ?? ''} busy={extra.busy ?? false} />);

test('an answered ask: the question, what it is about, both turns with their answers and costs, the total, the follow-up field', () => {
  const markup = render(en);
  assert.match(markup, new RegExp(`<section class="ask-screen" data-ask="${ASK_ID}" data-state="answered"`));
  assert.match(markup, /<h1[^>]*>What does line 12 of the page do, and which function calls it\?<\/h1>/);
  assert.match(markup, /guestbook · src\/page\.ts, line 12/);
  assert.equal(markup.match(/<li class="turn"/g)?.length, 2);
  assert.ok(visibleText(markup).includes(ASK_ANSWER));
  assert.ok(visibleText(markup).includes(FOLLOW_QUESTION));
  assert.match(markup, /data-ask-total=""[^>]*>[^<]*week used at 29%/);
  assert.match(markup, /<textarea[^>]*id="follow-input"[^>]*maxlength="4000"/);
  assert.equal(QUESTION_MAX, 4000);
  assert.match(markup, /<button[^>]*data-act="follow"[^>]*>Ask<\/button>/);
  assert.doesNotMatch(/<button[^>]*data-act="follow"[^>]*>/.exec(markup)?.[0] ?? '', /disabled/);
  assert.match(markup, /Read only: the reader never edits, commits or pushes\./);
  assert.doesNotMatch(markup, /\sstyle=/);
});

test('while a turn runs, its answer waits and the follow-up is held; a starting platform ask says so', () => {
  const running = render(en, askFixture(FIXTURE_NOW, 'running'));
  assert.match(running, /data-state="running"/);
  assert.match(running, /<p class="answer waiting"[^>]*>[^<]*The reader is reading the code…/);
  assert.match(/<button[^>]*data-act="follow"[^>]*>/.exec(running)?.[0] ?? '', /disabled=""/);
  assert.match(running, /Wait for the answer before asking again\./);
  const starting = render(en, platformAsk());
  assert.match(starting, /The whole platform/);
  assert.match(starting, /Starting a reader on the base branch…/);
  assert.doesNotMatch(starting, /data-ask-total/, 'nothing spent yet');
});

test('an answer is text: markup in it is shown, never run', () => {
  const ask = { ...askFixture(), turns: [{ ...askFixture().turns[0]!, answer: 'It writes <script>alert(1)</script> as text.' }] };
  const markup = render(en, ask);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a note and a draft are kept; a busy follow-up waits', () => {
  const markup = render(en, askFixture(), { draft: 'And the archive?', note: 'Three questions are being answered: ask again once one is answered.', busy: true });
  assert.match(markup, />And the archive\?<\/textarea>/);
  assert.match(markup, /role="status"[^>]*>Three questions are being answered/);
  assert.match(/<button[^>]*data-act="follow"[^>]*>/.exec(markup)?.[0] ?? '', /disabled=""/);
});

test('in French, and every word from the catalog or the data', () => {
  const markup = render(fr, askFixture(), { language: 'fr' });
  assert.match(markup, /guestbook · src\/page\.ts, ligne 12/);
  assert.match(markup, /semaine utilisée à 29\u202f%/);
  assert.match(markup, />Demander<\/button>/);
  // With a translator that names its keys, no word of the screen is left but the data's.
  const sentinel: Translate = (key) => `«${key}»`;
  const text = visibleText(render(sentinel, askFixture(FIXTURE_NOW, 'running'))).join('\n');
  for (const word of ['Reader', 'You', 'Ask', 'Read only', 'In all', 'tokens', ', line', 'Wait for the answer', 'reading the code']) assert.ok(!text.includes(word), word);
  assert.ok(text.includes(ASK_QUESTION) && text.includes(ASK_ANSWER), 'the data is shown as it is');
});
