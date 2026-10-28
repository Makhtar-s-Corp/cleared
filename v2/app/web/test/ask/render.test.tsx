// The /ask/:id screen as HTML (decision 28, lane 27): the question and what
// it is about, each turn with its answer as text and its cost, the total
// with the week share, and the follow-up field, held while a turn runs; in
// both languages, every word from the catalog or the data, no inline style.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ASK_ANSWER, ASK_CITATIONS, ASK_COMMIT, ASK_ID, ASK_QUESTION, FOLLOW_QUESTION, askFixture, platformAsk } from '../../../fixtures/ask.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { AskScreen } from '../../screens/ask/Ask.tsx';
import { QUESTION_MAX } from '../../screens/ask/model.ts';
import { html, strings, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('ask', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('ask', 'fr') });
// The text of a turn's answer, its links' text included.
const answerText = (markup: string, turn: number) => {
  const block = new RegExp(`<li class="turn"[^>]*data-turn="${turn}"[^>]*>[\\s\\S]*?<p class="answer-text">([\\s\\S]*?)</p>`).exec(markup)?.[1] ?? '';
  return visibleText(`<p>${block.replace(/<[^>]*>/g, '')}</p>`).join('');
};
const render = (t: Translate, ask = askFixture(), extra: { draft?: string; note?: string; busy?: boolean; language?: 'en' | 'fr' } = {}) =>
  html(<AskScreen ask={ask} t={t} language={extra.language ?? 'en'} draft={extra.draft ?? ''} note={extra.note ?? ''} busy={extra.busy ?? false} />);

test('an answered ask: the question, what it is about, both turns with their answers and costs, the total, the follow-up field', () => {
  const markup = render(en);
  assert.match(markup, new RegExp(`<section class="ask-screen" data-ask="${ASK_ID}" data-state="answered"`));
  assert.match(markup, /<h1[^>]*>What does line 12 of the page do, and which function calls it\?<\/h1>/);
  assert.match(markup, /guestbook · src\/page\.ts, line 12/);
  assert.equal(markup.match(/<li class="turn"/g)?.length, 2);
  assert.ok(answerText(markup, 0) === ASK_ANSWER, 'the answer is whole, its citations linked inside it');
  assert.ok(visibleText(markup).includes(FOLLOW_QUESTION));
  // The total is drawn as facts since lane j6-ui-pro (cells parted by a short line, no middle dots): its words read the same.
  const total = /<p class="ask-total" data-ask-total=""[^>]*>([^]*?)<\/p>/.exec(markup)?.[1] ?? '';
  assert.match(visibleText(`<p>${total.replace(/<[^>]*>/g, '')}</p>`).join(''), /week used at 29%/);
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
  assert.ok(text.includes(ASK_QUESTION) && answerText(render(sentinel), 0) === ASK_ANSWER, 'the data is shown as it is');
});

// P215 (issue #331): the code an answer cites, linked by the service.

test('each citation the service checked is a link to GitHub at the commit the reader read, opened apart', () => {
  const markup = render(en);
  const short = ASK_COMMIT.slice(0, 7);
  for (const citation of ASK_CITATIONS) {
    const link = new RegExp(`<a class="citation" href="${citation.url?.replace(/[.?*+^$[\]\\(){}|-]/g, '\\$&')}" target="_blank" rel="noopener noreferrer" title="Open on GitHub at commit ${short}"[^>]*>${citation.text.replace(/[.]/g, '\\.')}</a>`);
    assert.match(markup, link, citation.text);
  }
  assert.equal(markup.match(/<a class="citation"/g)?.length, 3, 'two in the first answer, one in the follow-up');
  assert.doesNotMatch(markup, /data-citations-unchecked/, 'nothing cited was missing');
});

test('a citation the service could not check is said under its answer, with no link', () => {
  const ask = askFixture();
  const first = ask.turns[0]!;
  const made = { text: 'guestbook/src/made-up.ts:3', service: 'guestbook', path: 'src/made-up.ts', from: 3, to: 3, commit: ASK_COMMIT, url: null, problem: 'no_file' as const };
  const turns = [{ ...first, answer: `${first.answer} Also guestbook/src/made-up.ts:3.`, citations: [...first.citations, made] }, ...ask.turns.slice(1)];
  const markup = render(en, { ...ask, turns });
  assert.match(markup, /<ul class="citations-unchecked" data-citations-unchecked="" aria-label="Cited, but not found in the code read">/);
  assert.match(markup, new RegExp(`<li>guestbook/src/made-up\\.ts:3: no such file at commit ${ASK_COMMIT.slice(0, 7)}</li>`));
  assert.doesNotMatch(markup, /<a [^>]*>guestbook\/src\/made-up/);
  const french = render(fr, { ...ask, turns }, { language: 'fr' });
  assert.match(french, /aria-label="Cité, mais introuvable dans le code lu"/);
  assert.match(french, /title="Ouvrir sur GitHub au commit 5b2d8e1"/);
});

test('an address the reader wrote is text, never a link', () => {
  const ask = askFixture();
  const turns = [{ ...ask.turns[0]!, answer: 'See https://evil.example/x and javascript:alert(1).', citations: [] }];
  const markup = render(en, { ...ask, turns });
  assert.doesNotMatch(markup, /<a [^>]*href="(?:https:\/\/evil|javascript)/);
  assert.match(markup, /See https:\/\/evil\.example\/x and javascript:alert\(1\)\./);
});
