// The /ask/:id screen's rules (decision 28, lane 27): what an ask says of
// itself (its target, its turns, the cost of each and in all), the follow-up's
// checks before it is sent, what the bar sends to ask, the routes it calls,
// and how a refusal of the service reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUESTION } from '../../../src/reader/service.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { ASK_ID, askFixture, platformAsk } from '../../fixtures/ask.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../web/lib/screen.ts';
import {
  POLL_MS, QUESTION_MAX, askBody, askFailure, askHref, askIdOf, followAsk, pollDelay, questionProblem, readAsk, startAsk, stateLine, targetLine, totalLine, turnsOf, usageLine,
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
