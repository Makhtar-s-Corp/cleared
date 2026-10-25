// The /ask/:id screen's rules (decision 28, lane 27): what an ask says of
// itself (its target, its turns, the cost of each and in all), the follow-up's
// checks before it is sent, what the bar sends to ask, the routes it calls,
// and how a refusal of the service reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUESTION } from '../../../src/reader/service.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { ASK_ANSWER, ASK_CITATIONS, ASK_COMMIT, ASK_ID, askFixture, platformAsk } from '../../fixtures/ask.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import type { AskCitation } from '../../../src/api/types.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../web/lib/screen.ts';
import {
  POLL_MS, QUESTION_MAX, answerParts, askBody, citationNote, citationTitle, uncheckedOf, askFailure, askHref, askIdOf, followAsk, pollDelay, questionProblem, readAsk, startAsk, stateLine, targetLine, totalLine, turnsOf, usageLine,
} from '../../web/screens/ask/model.ts';

const t = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('ask', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('ask', 'fr') });
const group = (n: number, language: 'en' | 'fr') => new Intl.NumberFormat(language).format(n);

type Call = { readonly path: string; readonly method: string; readonly body: unknown };
function stub(answer: unknown = askFixture()): { readonly api: ScreenContext['api']; readonly calls: Call[] } {
  const calls: Call[] = [];
  const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body });
    return answer;
  }) as ScreenContext['api'];
  return { api, calls };
}

test('the longest question is the reader\'s, and the screen polls while a turn runs, never after', () => {
  assert.equal(QUESTION_MAX, MAX_QUESTION);
  assert.equal(pollDelay(platformAsk()), POLL_MS);
  assert.equal(pollDelay(askFixture(FIXTURE_NOW, 'running')), POLL_MS);
  assert.equal(pollDelay(askFixture(FIXTURE_NOW, 'answered')), null);
  assert.equal(pollDelay(askFixture(FIXTURE_NOW, 'stopped')), null);
  assert.equal(pollDelay({ ...askFixture(), state: 'failed' }), null);
});

test('the address names the ask, and the screen reads it back', () => {
  assert.equal(askHref(ASK_ID), `/ask/${ASK_ID}`);
  assert.equal(askHref('a b/c'), '/ask/a%20b%2Fc');
  assert.equal(askIdOf(`/ask/${ASK_ID}`), ASK_ID);
  assert.equal(askIdOf('/ask/a%20b'), 'a b');
  assert.equal(askIdOf('/ask/'), undefined);
  assert.equal(askIdOf('/ask'), undefined);
  assert.equal(askIdOf('/ask/%E0%A4%A'), undefined, 'an address that does not decode names nothing');
});

test('what the ask is about: a service, a file and a line, or the whole platform', () => {
  assert.equal(targetLine(askFixture(), t), 'guestbook · src/page.ts, line 12');
  assert.equal(targetLine({ ...askFixture(), target: null }, t), 'guestbook');
  assert.equal(targetLine(platformAsk(), t), 'The whole platform');
  assert.equal(targetLine(askFixture(), fr), 'guestbook · src/page.ts, ligne 12');
  assert.equal(targetLine(platformAsk(), fr), 'Toute la plateforme');
});

test('each turn says its question, its answer or that it waits, and its cost', () => {
  const answered = turnsOf(askFixture());
  assert.equal(answered.length, 2);
  assert.deepEqual(answered.map((turn) => turn.kind), ['answered', 'answered']);
  assert.equal(usageLine(answered[0]!.turn, 'en', t), `$0.0023 · ${group(38_064, 'en')} tokens in, ${group(1_017, 'en')} out`);
  assert.equal(usageLine(answered[1]!.turn, 'en', t), `$0.0004 · ${group(20_350, 'en')} tokens in, 48 out`);
  assert.equal(usageLine(answered[0]!.turn, 'fr', fr), `0,0023\u00a0$ · ${group(38_064, 'fr')} jetons en entrée, ${group(1_017, 'fr')} en sortie`);
  // A turn that runs waits for its answer; one whose reader stopped before answering lost it.
  assert.deepEqual(turnsOf(askFixture(FIXTURE_NOW, 'running')).map((turn) => turn.kind), ['answered', 'waiting']);
  const stopped = askFixture(FIXTURE_NOW, 'running');
  assert.deepEqual(turnsOf({ ...stopped, state: 'stopped' }).map((turn) => turn.kind), ['answered', 'lost']);
  assert.equal(usageLine({ costUsd: null, inputTokens: 0, outputTokens: 0 }, 'en', t), undefined, 'no cost before the turn ends');
  // A cost of a cent or more reads in cents.
  assert.equal(usageLine({ costUsd: 0.4567, inputTokens: 1000, outputTokens: 10 }, 'en', t), `$0.46 · ${group(1000, 'en')} tokens in, 10 out`);
});

test('the ask\'s total adds the week share only once it is measured', () => {
  assert.equal(totalLine(askFixture(), 'en', t), `$0.0027 · ${group(58_414, 'en')} tokens in, ${group(1_065, 'en')} out · week used at 29%`);
  assert.equal(totalLine({ ...askFixture(), weekPercent: null }, 'en', t), `$0.0027 · ${group(58_414, 'en')} tokens in, ${group(1_065, 'en')} out`);
  assert.equal(totalLine(askFixture(), 'fr', fr), `0,0027\u00a0$ · ${group(58_414, 'fr')} jetons en entrée, ${group(1_065, 'fr')} en sortie · semaine utilisée à 29\u202f%`);
  assert.equal(totalLine(platformAsk(), 'en', t), undefined, 'nothing spent yet');
});

test('the state line says what the reader does', () => {
  assert.equal(stateLine(platformAsk(), t), 'Starting a reader on the base branch…');
  assert.equal(stateLine(askFixture(FIXTURE_NOW, 'running'), t), 'Reading the code…');
  assert.equal(stateLine(askFixture(), t), 'Answered');
  assert.match(stateLine(askFixture(FIXTURE_NOW, 'stopped'), t), /^Stopped/);
  assert.match(stateLine({ ...askFixture(), state: 'failed' }, t), /failed/);
});

test('a question is some text of at most the reader\'s length, checked before it is sent', () => {
  assert.equal(questionProblem(''), 'empty');
  assert.equal(questionProblem('   \n '), 'empty');
  assert.equal(questionProblem('x'.repeat(QUESTION_MAX)), undefined);
  assert.equal(questionProblem(`${'x'.repeat(QUESTION_MAX)}y`), 'too_long');
  assert.equal(questionProblem(' Which test covers it? '), undefined);
});

test('what the bar sends: a service:path:line target of the workspace, else the one service picked, else the platform', () => {
  const services = ['guestbook', 'filter-api'];
  assert.deepEqual(askBody('  What does guestbook:src/page.ts:12 do?  ', services, []), { question: 'What does guestbook:src/page.ts:12 do?', target: 'guestbook:src/page.ts:12' });
  assert.deepEqual(askBody('What calls filter-api:src/check.ts:40, and why?', services, ['guestbook']), { question: 'What calls filter-api:src/check.ts:40, and why?', target: 'filter-api:src/check.ts:40' });
  assert.deepEqual(askBody('Is other:src/x.ts:3 used?', services, []), { question: 'Is other:src/x.ts:3 used?' }, 'a service the workspace does not have is no target');
  assert.deepEqual(askBody('How is an entry stored?', services, ['filter-api']), { question: 'How is an entry stored?', service: 'filter-api' });
  assert.deepEqual(askBody('How is an entry stored?', services, services), { question: 'How is an entry stored?' }, 'two picked: the platform');
  // A workspace the tower could not read: the service checks the target itself.
  assert.deepEqual(askBody('What does guestbook:src/page.ts:12 do?', [], []), { question: 'What does guestbook:src/page.ts:12 do?', target: 'guestbook:src/page.ts:12' });
  assert.deepEqual(askBody('At 10:30:15 the log says what?', services, []), { question: 'At 10:30:15 the log says what?' }, 'a time is not a target');
});

test('the routes: ask, read and follow, each name the ask encoded', async () => {
  const one = stub();
  assert.equal((await startAsk(one.api, { question: 'Why?', service: 'guestbook' })).id, ASK_ID);
  await readAsk(one.api, 'ask-1/2');
  await followAsk(one.api, ASK_ID, '  Which test file covers that function?  ');
  assert.deepEqual(one.calls, [
    { path: '/asks', method: 'POST', body: { question: 'Why?', service: 'guestbook' } },
    { path: '/asks/ask-1%2F2', method: 'GET', body: undefined },
    { path: `/asks/${ASK_ID}/follow`, method: 'POST', body: { question: 'Which test file covers that function?' } },
  ]);
  // A follow-up the screen refuses never reaches the service.
  const two = stub();
  await assert.rejects(followAsk(two.api, ASK_ID, ' '), /ask_question_empty/);
  await assert.rejects(followAsk(two.api, ASK_ID, 'x'.repeat(QUESTION_MAX + 1)), /ask_question_long/);
  assert.deepEqual(two.calls, []);
});

test('a refusal of the service reads as what it means', () => {
  const error = (status: number) => new ApiError(status, `/api/service/asks: ${status}`);
  assert.equal(askFailure(error(409), 'ask'), 'ask_failed_busy');
  assert.equal(askFailure(error(409), 'follow'), 'ask_failed_running');
  assert.equal(askFailure(error(400), 'ask'), 'ask_failed_invalid');
  assert.equal(askFailure(error(404), 'follow'), 'ask_failed_gone');
  assert.equal(askFailure(error(404), 'read'), 'ask_failed_gone');
  assert.equal(askFailure(error(503), 'ask'), 'ask_failed_off');
  assert.equal(askFailure(error(401), 'read'), 'signed_out');
  assert.equal(askFailure(error(500), 'follow'), 'ask_failed');
  assert.equal(askFailure(new Error('network'), 'read'), 'ask_load_failed');
  for (const key of ['ask_failed_busy', 'ask_failed_running', 'ask_failed_invalid', 'ask_failed_gone', 'ask_failed_off', 'ask_failed', 'ask_load_failed']) assert.ok(t(key) && fr(key));
});

// P215 (issue #331): the code an answer cites, linked by the service.

const citation = (over: Partial<AskCitation>): AskCitation => ({
  text: 'guestbook/src/page.ts:12', service: 'guestbook', path: 'src/page.ts', from: 12, to: 12, commit: ASK_COMMIT, problem: null,
  url: `https://github.com/example-org/cleared-example-guestbook/blob/${ASK_COMMIT}/src/page.ts#L12`, ...over,
});

test('an answer is cut around the citations the service linked, every place each is written', () => {
  const parts = answerParts(ASK_ANSWER, ASK_CITATIONS);
  assert.equal(parts.map((part) => part.text).join(''), ASK_ANSWER, 'nothing of the answer is lost');
  assert.deepEqual(parts.filter((part) => part.url).map((part) => [part.text, part.url]), ASK_CITATIONS.map((c) => [c.text, c.url]));
  const twice = answerParts('a guestbook/src/page.ts:12 b guestbook/src/page.ts:12', [citation({})]);
  assert.deepEqual(twice.map((part) => [part.text, part.url !== undefined]), [['a ', false], ['guestbook/src/page.ts:12', true], [' b ', false], ['guestbook/src/page.ts:12', true]]);
  // The longer mention wins where one starts inside the other.
  const nested = answerParts('see guestbook/src/page.ts:12-14.', [citation({}), citation({ text: 'guestbook/src/page.ts:12-14', to: 14, url: `https://github.com/example-org/cleared-example-guestbook/blob/${ASK_COMMIT}/src/page.ts#L12-L14` })]);
  assert.deepEqual(nested.map((part) => part.text), ['see ', 'guestbook/src/page.ts:12-14', '.']);
});

test('a linked mention is drawn only where it stands whole, never inside a longer one the service did not link', () => {
  const answer = 'guestbook/src/page.ts:1 and guestbook/src/page.ts:150, guestbook/src/page.ts:12-99, vendor/guestbook/src/page.ts:1, guestbook/src/page.ts:1.';
  const parts = answerParts(answer, [citation({ text: 'guestbook/src/page.ts:1', from: 1, to: 1 }), citation({}), citation({ text: 'guestbook/src/page.ts:150', from: 150, to: 150, url: null, problem: 'no_line' })]);
  assert.deepEqual(parts.filter((part) => part.url).map((part) => [part.text, answer.indexOf(part.text) >= 0]), [['guestbook/src/page.ts:1', true], ['guestbook/src/page.ts:1', true]]);
  assert.equal(parts.map((part) => part.text).join(''), answer);
  const linkedAt = [];
  let at = 0;
  for (const part of parts) { if (part.url) linkedAt.push(at); at += part.text.length; }
  assert.deepEqual(linkedAt, [0, answer.lastIndexOf('guestbook/src/page.ts:1.')], 'the first and the last, not :150, :12-99 or vendor/');
});

test('only a GitHub link the service built is drawn; a citation it could not check, and an address the reader wrote, stay text', () => {
  const answer = 'guestbook/src/page.ts:12 and guestbook/src/made-up.ts:3, see https://github.com/evil/x; guestbook/src/page.ts:13 and guestbook/src/page.ts:14.';
  const parts = answerParts(answer, [
    citation({}),
    citation({ text: 'guestbook/src/made-up.ts:3', path: 'src/made-up.ts', from: 3, to: 3, url: null, problem: 'no_file' }),
    citation({ text: 'guestbook/src/page.ts:13', from: 13, to: 13, url: 'javascript:alert(1)' }),
    citation({ text: 'guestbook/src/page.ts:14', from: 14, to: 14, url: 'http://github.com/x' }),
  ]);
  assert.deepEqual(parts.filter((part) => part.url).map((part) => part.text), ['guestbook/src/page.ts:12'],
    'the reader\'s own address is no citation, and an address that is not https://github.com/ is never drawn');
  assert.equal(parts.map((part) => part.text).join(''), answer);
  assert.deepEqual(answerParts('plain', []), [{ text: 'plain' }]);
});

test('what was cited but not found is said with its reason and the commit the reader read', () => {
  const short = ASK_COMMIT.slice(0, 7);
  const unchecked = uncheckedOf({ citations: [citation({}), citation({ text: 'x/a.ts:3', problem: 'no_file', url: null }), citation({ text: 'x/a.ts:90', problem: 'no_line', url: null })] });
  assert.deepEqual(unchecked.map((c) => c.text), ['x/a.ts:3', 'x/a.ts:90']);
  assert.equal(citationNote(citation({ text: 'x/a.ts:3', problem: 'no_file', url: null }), t), `x/a.ts:3: no such file at commit ${short}`);
  assert.equal(citationNote(citation({ text: 'x/a.ts:90', problem: 'no_line', url: null }), t), `x/a.ts:90: the file has no such lines at commit ${short}`);
  assert.equal(citationNote(citation({ text: 'x/a.ts:3', problem: 'no_file', url: null, commit: null }), t), 'x/a.ts:3: guestbook was not in the code the reader read');
  assert.equal(citationNote(citation({ text: 'x/a.ts:3', problem: 'no_repository', url: null }), t), 'x/a.ts:3: no GitHub repository is known for guestbook');
  assert.equal(citationNote(citation({ text: 'x/a.ts:3', problem: 'unchecked', url: null }), t), 'x/a.ts:3: could not be checked');
  assert.equal(citationNote(citation({ text: 'x/a.ts:3', problem: 'no_file', url: null }), fr), `x/a.ts:3\u00a0: aucun fichier de ce nom au commit ${short}`);
  assert.equal(citationTitle(citation({}), t), `Open on GitHub at commit ${short}`);
  assert.equal(citationTitle(citation({}), fr), `Ouvrir sur GitHub au commit ${short}`);
  assert.deepEqual(uncheckedOf({ citations: undefined as never }), [], 'an ask the service stored before P215');
});
