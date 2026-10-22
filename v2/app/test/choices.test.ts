// The clickable answers' model, shared by the session screen, the lead
// screen and the inbox's question detail: the answer a click makes, the
// picks of a multiple choice, the free answer and its limit, the answers
// keyed by the question's text, and the keys each screen's catalog must hold
// (a page loads only the shell's catalog and its own).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { Question } from '../../src/session/events.ts';
import { loadCatalog } from '../src/catalog.ts';
import {
  CHOICE_KEYS, FREE_MAX, answersFor, answersOnClick, chosenOf, clickAnswer, emptyDraft, labelOf, pick, sentText, typeFree,
} from '../web/components/choices/model.ts';

const week: Question = {
  question: 'Should a week that spans two months appear under the first month or be split?',
  header: 'Month edges',
  options: [
    { label: 'Under the first month (Recommended)', description: 'One heading per week, as the list reads today.' },
    { label: 'Split at the month\'s end' },
  ],
};
const days: Question = { question: 'Which days show a heading?', multiSelect: true, options: [{ label: 'Monday' }, { label: 'Saturday' }, { label: 'Sunday' }] };

test('a label reads without its "(Recommended)" mark, which is shown apart and kept in what is sent', () => {
  assert.deepEqual(labelOf('Under the first month (Recommended)'), { text: 'Under the first month', recommended: true });
  assert.deepEqual(labelOf('Pages of 20 (recommended) '), { text: 'Pages of 20', recommended: true });
  assert.deepEqual(labelOf('Split'), { text: 'Split', recommended: false });
  assert.deepEqual(clickAnswer([week], 0, 'Under the first month (Recommended)'), { [week.question]: 'Under the first month (Recommended)' }, 'the label exactly as the asker wrote it');
});

test('one question with one choice is answered by a click; several questions or several choices toggle, then send', () => {
  assert.equal(answersOnClick([week]), true);
  assert.equal(answersOnClick([days]), false);
  assert.equal(answersOnClick([week, week]), false);
  assert.equal(answersOnClick([{ question: 'Anything to add?' }]), false, 'no option: nothing to click');
  assert.deepEqual(clickAnswer([week], 0, 'Split at the month\'s end'), { [week.question]: 'Split at the month\'s end' });
  assert.equal(clickAnswer([week], 0, 'Not an option'), undefined, 'only a label the question offers');
  assert.equal(clickAnswer([days], 0, 'Monday'), undefined, 'a multiple choice is toggled, not sent');
});

test('a multiple choice sends every picked label; a single choice keeps the last one; a second click takes one back', () => {
  let draft = emptyDraft([days, week]);
  draft = pick([days, week], draft, 0, 'Monday');
  draft = pick([days, week], draft, 0, 'Sunday');
  draft = pick([days, week], draft, 1, 'Under the first month (Recommended)');
  draft = pick([days, week], draft, 1, 'Split at the month\'s end');
  assert.deepEqual(draft.picks, [['Monday', 'Sunday'], ['Split at the month\'s end']]);
  assert.deepEqual(answersFor([days, week], draft), { answers: { [days.question]: 'Monday, Sunday', [week.question]: 'Split at the month\'s end' } });
  assert.deepEqual(chosenOf(draft), ['Monday', 'Sunday', 'Split at the month\'s end']);
  draft = pick([days, week], draft, 0, 'Monday');
  assert.deepEqual(draft.picks[0], ['Sunday']);
  assert.equal(pick([days], draft, 0, 'Not an option'), draft, 'a label not offered changes nothing');
  assert.deepEqual(answersFor([days, week], emptyDraft([days, week])), { missing: 0 });
  assert.equal(sentText({ a: 'Sunday, Monday', b: 'Split' }), 'Sunday, Monday · Split');
});

test('a free answer wins over the choices, trimmed; one of more than 2000 characters is refused before sending', () => {
  let draft = pick([days], emptyDraft([days]), 0, 'Monday');
  draft = typeFree(draft, 0, '  Every day  ');
  assert.deepEqual(answersFor([days], draft), { answers: { [days.question]: 'Every day' } });
  assert.equal(FREE_MAX, 2000, 'what the session answer route accepts per answer');
  const long = typeFree(draft, 0, 'x'.repeat(FREE_MAX + 1));
  assert.deepEqual(answersFor([days], long), { tooLong: 0 });
  assert.deepEqual(answersFor([days], typeFree(draft, 0, 'x'.repeat(FREE_MAX))), { answers: { [days.question]: 'x'.repeat(FREE_MAX) } }, '2000 is accepted');
  const many: Question = { question: 'Which?', multiSelect: true, options: Array.from({ length: 3 }, (_, i) => ({ label: `${String(i).repeat(900)}` })) };
  let picks = emptyDraft([many]);
  for (const option of many.options ?? []) picks = pick([many], picks, 0, option.label);
  assert.deepEqual(answersFor([many], picks), { tooLong: 0 }, 'the picks joined are held to the same limit');
});

test('every key the component names is in its list, and the session, lead and inbox catalogs hold them alike in English and French', () => {
  const dir = new URL('../web/components/choices/', import.meta.url);
  const code = readdirSync(dir).filter((name) => /\.tsx?$/.test(name)).map((name) => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const named = new Set([...code.matchAll(/'(choice_[a-z0-9_]+)'/g)].map((m) => m[1] as string));
  for (const key of CHOICE_KEYS) {
    assert.ok(named.has(key), `${key} is listed but never used`);
    named.delete(key);
  }
  assert.deepEqual([...named], [], 'keys the component uses but does not list');
  assert.doesNotMatch(code, /\bt\(`/, 'no key built from a template string: the list could not see it');
  const english = loadCatalog('session', 'en');
  for (const screen of ['session', 'lead', 'inbox'] as const) {
    for (const language of ['en', 'fr'] as const) {
      const catalog = loadCatalog(screen, language);
      for (const key of CHOICE_KEYS) assert.ok(Object.hasOwn(catalog, key), `${screen}.${language}.json lacks ${key}`);
    }
    for (const language of ['en', 'fr'] as const) {
      for (const key of CHOICE_KEYS) assert.equal(loadCatalog(screen, language)[key], loadCatalog('session', language)[key], `${key} reads the same on every screen (${language})`);
    }
  }
  const french = loadCatalog('session', 'fr');
  for (const key of CHOICE_KEYS) assert.notEqual(french[key], english[key], `${key} is translated`);
});
