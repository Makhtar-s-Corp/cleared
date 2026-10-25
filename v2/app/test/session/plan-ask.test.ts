// The ask from a session's Plan tab (decision 28, matrix C11), as pure
// functions: what it sends to the reader's route, scoped to the session's
// service unless the question names a `service:path:line`, and the words
// that say what it reads, in English and in French.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { QUESTION_MAX } from '../../web/screens/ask/model.ts';
import { planAskBody, planAskProblem, planAskScope } from '../../web/screens/session/tabs.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

test('the ask is about the session\'s service; a named line wins; with no service, every service', () => {
  const services = ['guestbook', 'filter-api'];
  assert.deepEqual(planAskBody('  Where is an entry stored?  ', 'guestbook', services), { question: 'Where is an entry stored?', service: 'guestbook' });
  assert.deepEqual(planAskBody('What does filter-api:src/rules.ts:8 return?', 'guestbook', services),
    { question: 'What does filter-api:src/rules.ts:8 return?', target: 'filter-api:src/rules.ts:8' }, 'a line of another service names its own service');
  assert.deepEqual(planAskBody('Who calls the filter?', undefined, services), { question: 'Who calls the filter?' }, 'a session with no service asks the whole platform');
  assert.deepEqual(planAskBody('Is unknown:src/x.ts:3 used?', 'guestbook', services), { question: 'Is unknown:src/x.ts:3 used?', service: 'guestbook' }, 'a service the workspace does not have is no target');
});

test('an empty question and one past the reader\'s limit are refused before anything is sent', () => {
  assert.equal(planAskProblem('   ', en), 'Write the question first.');
  assert.equal(planAskProblem('x'.repeat(QUESTION_MAX + 1), en), `A question has at most ${QUESTION_MAX.toLocaleString('en')} characters.`);
  assert.equal(planAskProblem(`  ${'x'.repeat(QUESTION_MAX)}  `, en), undefined, 'the spaces around are not counted');
  assert.equal(planAskProblem('', fr), 'Écrivez d\'abord la question.');
  assert.match(planAskProblem('x'.repeat(QUESTION_MAX + 1), fr) ?? '', /^Une question fait au plus 4 000 caractères\.$/);
});

test('the card says what the reader reads: the base branch of the session\'s service, or of every service, not the session\'s changes', () => {
  assert.equal(planAskScope('guestbook', en), 'Read only, on the base branch of guestbook: the reader does not see this session\'s changes, and never edits, commits or pushes.');
  assert.equal(planAskScope(undefined, en), 'Read only, on the base branch of every service: the reader does not see this session\'s changes, and never edits, commits or pushes.');
  assert.equal(planAskScope('guestbook', fr), 'Lecture seule, sur la branche de base de guestbook : le lecteur ne voit pas les changements de cette session, et ne modifie, ne valide ni ne pousse jamais rien.');
  assert.equal(planAskScope(undefined, fr), 'Lecture seule, sur la branche de base de chaque service : le lecteur ne voit pas les changements de cette session, et ne modifie, ne valide ni ne pousse jamais rien.');
});
