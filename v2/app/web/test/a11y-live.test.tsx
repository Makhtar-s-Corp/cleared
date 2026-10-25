// The live lines a screen reader says (P224): a status line is in the page,
// empty, before its message, so the message is said when it comes. A line
// drawn with its message already in it is not said by every reader.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Question } from '../../../src/session/events.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { Choices } from '../components/choices/Choices.tsx';
import { FREE_MAX, emptyDraft, typeFree } from '../components/choices/model.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { leadFixture } from '../../fixtures/lead.ts';
import { translator } from '../lib/i18n.ts';
import { html, renderPlanPanel } from './render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en'), ...loadCatalog('lead', 'en') });
const question: Question = { question: 'Which days show a heading?', options: [{ label: 'Monday' }, { label: 'Sunday' }] };

test('a question\'s line for a free answer too long is in the form, empty, before the answer is', () => {
  const empty = html(<Choices questions={[question]} status={{ kind: 'waiting' }} t={en} requestId="q-1" />);
  assert.match(empty, /<p class="choice-note" role="status"><\/p>/);
  const long = typeFree(emptyDraft([question]), 0, 'x'.repeat(FREE_MAX + 1));
  const said = html(<Choices questions={[question]} status={{ kind: 'waiting', draft: long }} t={en} requestId="q-1" />);
  assert.match(said, /<p class="choice-note" role="status">[^<]+<\/p>/);
  assert.equal([...said.matchAll(/role="status"/g)].length, 1, 'one line, the same one');
});

test('a plan\'s line under its buttons is in the panel, empty, before a gesture says anything', async () => {
  const [plan] = (await leadFixture(FIXTURE_NOW)).plans;
  assert.ok(plan);
  assert.match(renderPlanPanel(plan, en), /<p class="plan-note" role="status"><\/p>/);
  assert.match(renderPlanPanel(plan, en, { note: 'The plan could not be approved. Try again.' }), /<p class="plan-note" role="status">The plan could not be approved\. Try again\.<\/p>/);
});
