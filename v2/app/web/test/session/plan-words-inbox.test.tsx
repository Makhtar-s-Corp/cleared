// The inbox's plan card reads like the session's (issue #501): a step a person
// can read, no command at the top; the steps are not raw Markdown.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { PlanStepList } from '../../screens/inbox/Inbox.tsx';
import { html, visibleText } from '../render.tsx';

const fr: Translate = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });
const en: Translate = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const STEPS = ['Lire le **composant**', 'Lancer `npm test`', 'Modifier web/Message.tsx'];

test('the card shows the steps a person reads and says the others in words', () => {
  const text = visibleText(html(<PlanStepList steps={STEPS} t={fr} />)).join('\n');
  assert.match(text, /Lire le composant/);
  assert.doesNotMatch(text, /npm|Message\.tsx|\*\*|`/);
  assert.match(text, /Une étape technique/);
  assert.match(visibleText(html(<PlanStepList steps={STEPS} t={en} />)).join('\n'), /A technical step/);
});

test('every step keeps its line and its number', () => {
  assert.equal([...html(<PlanStepList steps={STEPS} t={fr} />).matchAll(/<li/g)].length, 3);
});
