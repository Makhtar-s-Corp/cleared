// Clickable answers to a question a session or the lead asks (decision 17
// of the milestone 2 plan): its options as buttons, a free answer, and what
// the question became once it no longer waits. Shared by the session
// screen, the lead screen and the inbox's question detail; Choices.tsx
// draws it.
//
// The question is the `cleared.question` CUSTOM event, whose questions keep
// Claude Code's AskUserQuestion shape: a header, options with a label and a
// description, multiSelect. A label that ends with "(Recommended)" is the
// asker's recommendation: shown as a mark, sent back exactly as written.
//
// Pure, so the tests run it under Node. A page loads only the shell's
// catalog and its own, so every key is named in CHOICE_KEYS and the
// session's, the lead's and the inbox's catalogs hold them (a test checks).
import type { Question } from '../../../../src/session/events.ts';

export const CHOICE_KEYS = [
  'choice_recommended', 'choice_free', 'choice_send', 'choice_too_long',
  'choice_answered', 'choice_answered_with', 'choice_cancelled', 'choice_settled', 'choice_ended',
] as const;

export const RECOMMENDED = /\s*\(Recommended\)\s*$/i;
export const FREE_MAX = 2000;                              // what the session answer route accepts per answer

// What the person picked and typed, per question.
export type ChoiceDraft = { readonly picks: readonly (readonly string[])[]; readonly free: readonly string[] };

// What the question is now, as the component shows it.
export type ChoiceStatus =
  | { readonly kind: 'waiting'; readonly draft?: ChoiceDraft; readonly busy?: boolean }
  | { readonly kind: 'answered'; readonly who: string; readonly sent?: string; readonly chosen?: readonly string[] }   // who: already in words ("you")
  | { readonly kind: 'cancelled' }                         // the turn was interrupted while it waited
  | { readonly kind: 'settled' }                           // the answer came after it no longer waited
  | { readonly kind: 'ended' }                             // the session ended before an answer
  | { readonly kind: 'read' };                             // shown only: answered elsewhere

export type Answers = Readonly<Record<string, string>>;

export function emptyDraft(questions: readonly Question[]): ChoiceDraft {
  return { picks: questions.map(() => []), free: questions.map(() => '') };
}

// "Pages of 20 (Recommended)" reads "Pages of 20", marked.
export function labelOf(label: string): { readonly text: string; readonly recommended: boolean } {
  return { text: label.replace(RECOMMENDED, ''), recommended: RECOMMENDED.test(label) };
}

const offers = (question: Question | undefined, label: string) => question?.options?.some((o) => o.label === label) === true;

// One question with one choice is answered by a click; otherwise the clicks
// toggle and Send sends.
export function answersOnClick(questions: readonly Question[]): boolean {
  const [only] = questions;
  return questions.length === 1 && only?.multiSelect !== true && (only?.options?.length ?? 0) > 0;
}

// The answer a click makes, keyed by the question's text as the harness
// asked it; undefined when a click only toggles, or for a label not offered.
export function clickAnswer(questions: readonly Question[], index: number, label: string): Answers | undefined {
  const question = questions[index];
  if (!question || !answersOnClick(questions) || !offers(question, label)) return undefined;
  return { [question.question]: label };
}

// A click that toggles: one pick for a single choice, several for a multiple one.
export function pick(questions: readonly Question[], draft: ChoiceDraft, index: number, label: string): ChoiceDraft {
  const question = questions[index];
  if (!question || !offers(question, label)) return draft;
  const own = draft.picks[index] ?? [];
  const next = own.includes(label) ? own.filter((l) => l !== label) : question.multiSelect ? [...own, label] : [label];
  return { ...draft, picks: questions.map((_, i) => (i === index ? next : draft.picks[i] ?? [])) };
}

export function typeFree(draft: ChoiceDraft, index: number, text: string): ChoiceDraft {
  const free = [...draft.free];
  while (free.length <= index) free.push('');
  free[index] = text;
  return { ...draft, free };
}

// The answers, keyed by question text: a free answer wins over the choices,
// several choices are joined with ", ", every question needs one, and none
// may be longer than the answer route accepts.
export function answersFor(questions: readonly Question[], draft: ChoiceDraft):
  | { readonly answers: Answers; readonly missing?: undefined; readonly tooLong?: undefined }
  | { readonly missing: number; readonly answers?: undefined; readonly tooLong?: undefined }
  | { readonly tooLong: number; readonly answers?: undefined; readonly missing?: undefined } {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const value = (draft.free[index] ?? '').trim() || (draft.picks[index] ?? []).join(', ');
    if (!value) return { missing: index };
    if (value.length > FREE_MAX) return { tooLong: index };
    answers[question.question] = value;
  }
  return { answers };
}

// Every label picked, in order, to mark once the answer is sent.
export function chosenOf(draft: ChoiceDraft): string[] {
  return draft.picks.flat();
}

// What was sent, in one line, for the answered state.
export function sentText(answers: Answers): string {
  return Object.values(answers).join(' · ');
}
