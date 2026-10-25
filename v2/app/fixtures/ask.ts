// The asks of the fixtures (decision 28, lane 27): a question to the code of
// the guestbook, named by a `service:path:line` target, answered in two
// turns with their cost as lane 25's real run measured it; the same ask while
// its follow-up runs; and a question to the whole platform still starting.
// The answers are the reader's words, as the service stores them: text,
// with the code they cite, each linked by the service to the commit the
// reader read (P215).
import type { Ask, AskAnswer, AskCitation } from '../../src/api/types.ts';
import { FIXTURE_NOW } from './tower.ts';

export const ASK_ID = 'ask-2f0c5d1e-8a4b-4c7e-9d36-1b5a7e0c4f92';
export const PLATFORM_ASK_ID = 'ask-7b9e2c40-5d18-4f3a-a6c1-0e8d2f4b7a15';
export const ASK_QUESTION = 'What does line 12 of the page do, and which function calls it?';
export const ASK_ANSWER = 'Line 12 builds the ESCAPES table (guestbook/src/page.ts:12): the five characters HTML gives a meaning to, each with its entity. escapeHtml (guestbook/src/page.ts:20-24) reads it to escape a name and a message before the page writes them, so an entry cannot add markup to the page.';
export const FOLLOW_QUESTION = 'Which test file covers that function?';
export const FOLLOW_ANSWER = 'guestbook/test/page.test.ts:31: "an entry with markup is escaped" posts a name with a <script> tag and checks the page shows it as text.';
// The commit of the guestbook's base the reader read.
export const ASK_COMMIT = '5b2d8e1f0a3c4b6d7e8f9a0b1c2d3e4f5a6b7c8d';

const cite = (text: string, path: string, from: number, to: number): AskCitation => ({
  text, service: 'guestbook', path, from, to, commit: ASK_COMMIT, problem: null,
  url: `https://github.com/example-org/cleared-example-guestbook/blob/${ASK_COMMIT}/${path}#L${from}${to > from ? `-L${to}` : ''}`,
});
export const ASK_CITATIONS: readonly AskCitation[] = [cite('guestbook/src/page.ts:12', 'src/page.ts', 12, 12), cite('guestbook/src/page.ts:20-24', 'src/page.ts', 20, 24)];
export const FOLLOW_CITATIONS: readonly AskCitation[] = [cite('guestbook/test/page.test.ts:31', 'test/page.test.ts', 31, 31)];
export const ASK_USER = 'user-demo';

const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const turn = (question: string, answer: string | null, at: string, costUsd: number | null, inputTokens: number, outputTokens: number, citations: readonly AskCitation[] = []): AskAnswer =>
  ({ question, answer, at, costUsd, inputTokens, outputTokens, citations });

// state: 'answered' (both turns), 'running' (the follow-up asked, no answer
// yet), 'stopped' (the idle rule stopped it after both answers).
export function askFixture(now: Date = FIXTURE_NOW, state: 'answered' | 'running' | 'stopped' = 'answered'): Ask {
  const first = turn(ASK_QUESTION, ASK_ANSWER, ago(now, 6), 0.002331, 38_064, 1_017, ASK_CITATIONS);
  const follow = state === 'running' ? turn(FOLLOW_QUESTION, null, ago(now, 0), null, 0, 0) : turn(FOLLOW_QUESTION, FOLLOW_ANSWER, ago(now, 2), 0.000362, 20_350, 48, FOLLOW_CITATIONS);
  const turns = [first, follow];
  const sum = (pick: (t: AskAnswer) => number) => turns.reduce((total, t) => total + pick(t), 0);
  return {
    id: ASK_ID, question: ASK_QUESTION, service: 'guestbook', target: { service: 'guestbook', path: 'src/page.ts', line: 12 },
    session: 'fixture-reader-1', state, turns,
    costUsd: Math.round(sum((t) => t.costUsd ?? 0) * 1e6) / 1e6, inputTokens: sum((t) => t.inputTokens), outputTokens: sum((t) => t.outputTokens),
    weekPercent: 29, createdAt: ago(now, 7), by: ASK_USER,
  };
}

// A question to every service of the workspace, its session still starting.
export function platformAsk(now: Date = FIXTURE_NOW): Ask {
  return {
    id: PLATFORM_ASK_ID, question: 'Where does the guestbook call the filter API, and what does it do when the call fails?', service: null, target: null,
    session: null, state: 'starting', turns: [turn('Where does the guestbook call the filter API, and what does it do when the call fails?', null, ago(now, 0), null, 0, 0)],
    costUsd: 0, inputTokens: 0, outputTokens: 0, weekPercent: null, createdAt: ago(now, 0), by: ASK_USER,
  };
}
