// A team's question that waits too long (issue #290, lane j3-autonomy): the
// answer its session declared, and the words that tell a session, a ticket
// and the ledger what became of it. The flow decides when (engine.ts,
// #dueQuestions); this file only reads and says.
import type { Question } from '../session/events.ts';
import type { QuestionDefault } from './config.ts';

// The label the harness's AskUserQuestion gives the option it recommends,
// as the lead's prompt asks it (lead/prompts.ts) and the inbox shows it.
export const RECOMMENDED = /\(Recommended\)\s*$/i;

// The answer the session declared for its whole request: each question's
// first option labelled "(Recommended)", by the question's text as the
// answers are keyed. None when one question has none: a free question, or
// a choice with no recommendation, is left to a person.
export function declaredAnswers(questions: readonly Question[]): Readonly<Record<string, string>> | null {
  if (questions.length === 0) return null;
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const option = (question.options ?? []).find((o) => RECOMMENDED.test(o.label));
    if (!option) return null;
    answers[question.question] = option.label;
  }
  return answers;
}

// What the delay's end applies under the project's [session]
// question_default (issue #269): the declared answer; with `first`, each
// question without a recommended option takes its first, one even for a
// multiple choice; with `park`, nothing. A free question has no option to
// take: none, so the ticket is parked.
export function defaultAnswers(questions: readonly Question[], rule: QuestionDefault = 'recommended'): Readonly<Record<string, string>> | null {
  if (rule === 'park' || questions.length === 0) return null;
  if (rule === 'recommended') return declaredAnswers(questions);
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const options = question.options ?? [];
    const option = options.find((o) => RECOMMENDED.test(o.label)) ?? options[0];
    if (!option) return null;
    answers[question.question] = option.label;
  }
  return answers;
}

// "Which order?" or "Which order?" and "Which colour?".
export const asked = (questions: readonly Question[]): string => questions.map((q) => `"${q.question}"`).join(' and ');

// One line per question: "Which order?: Newest first (Recommended)".
export const answerLines = (answers: Readonly<Record<string, string>>): string =>
  Object.entries(answers).map(([question, answer]) => `${question}: ${answer}`).join('\n');
