// The lead's rules ask for options whenever a question allows them, in the
// form the screens turn into buttons: two to four short labels, the
// recommended one first and ending with "(Recommended)", which the screens
// mark, and no "Other", since the owner can always answer in their own words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_RULES } from '../../src/lead/prompts.ts';

const RECOMMENDED = /\s*\(Recommended\)\s*$/i;                // the screens' pattern (app/web/components/choices/model.ts)

test('the lead offers two to four options whenever the question allows it, its recommendation first, with no "Other"', () => {
  const section = /## How you speak to the owner\n([\s\S]*?)\n## /.exec(LEAD_RULES)?.[1];
  assert.ok(section, 'the rules on speaking to the owner');
  const rule = section.split('\n').filter((line) => /AskUserQuestion|options/.test(line)).join('\n');
  assert.match(rule, /one closed question at a time/i);
  assert.match(rule, /Never two questions in one turn/);
  assert.match(rule, /options whenever the question allows it/i);
  assert.match(rule, /two to four options/i);
  assert.match(rule, /buttons/);
  assert.match(rule, /recommendation first/i);
  assert.match(rule, /"\(Recommended\)"/);
  assert.match(rule, /no "Other" option/);
  assert.match(rule, /in their own words/);
  assert.ok(RECOMMENDED.test('Pages of 20 (Recommended)'), 'the label the rule asks for is the one the screens mark');
});
