// The clickable answers (model.ts): a question's options as buttons, the
// recommended mark, the free answer and Send while it waits; the options as
// lines, those sent marked, and what happened once it no longer waits.
//
// Two ways to answer. `inline` (the session and the lead): a click on the
// only choice of one question answers at once; otherwise the clicks toggle
// and Send below answers. `bar` (the inbox): a click on the only choice of
// one question answers at once too when the screen takes it (onAnswer,
// issue #269); otherwise the clicks only pick, and the screen's own bar
// sends. Every option carries `data-answer` with its label
// as written, the selector the proof scripts read.
//
// Controlled: the screen holds the draft (the inbox keeps it with its other
// fields), or lets OwnChoices hold it.
import { Check } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import type { Question } from '../../../../src/session/events.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import type { Translate } from '@/lib/i18n.ts';
import {
  FREE_MAX, answersFor, answersOnClick, chosenOf, clickAnswer, emptyDraft, labelOf, pick, typeFree, type Answers, type ChoiceDraft, type ChoiceStatus,
} from './model.ts';
import './choices.css';

export type ChoicesProps = {
  readonly questions: readonly Question[];
  readonly status: ChoiceStatus;
  readonly t: Translate;
  readonly requestId?: string;
  readonly free?: boolean;                                 // a free answer per question; false where the screen's own field is it
  readonly send?: 'inline' | 'bar';
  readonly onDraft?: (draft: ChoiceDraft) => void;
  readonly onAnswer?: (answers: Answers, chosen: readonly string[]) => void;
};

type Option = NonNullable<Question['options']>[number];

function Label({ option, t }: { readonly option: Option; readonly t: Translate }) {
  const { text, recommended } = labelOf(option.label);
  return (
    <>
      <span className="choice-label">{text}</span>
      {recommended ? <span className="choice-rec">{t('choice_recommended')}</span> : null}
      {option.description ? <span className="choice-desc">{option.description}</span> : null}
    </>
  );
}

function Legend({ question }: { readonly question: Question }) {
  return <legend className="choice-text">{question.header ? <span className="choice-header">{question.header}</span> : null}<span className="choice-question">{question.question}</span></legend>;
}

function foot(status: Exclude<ChoiceStatus, { kind: 'waiting' }>, t: Translate): string {
  switch (status.kind) {
    case 'answered': return status.sent ? t('choice_answered_with', { who: status.who, answer: status.sent }) : t('choice_answered', { who: status.who });
    case 'cancelled': return t('choice_cancelled');
    case 'settled': return t('choice_settled');
    case 'ended': return t('choice_ended');
    case 'read': return '';
  }
}

// No longer answerable here: the options as lines, those this tab sent marked.
function Settled({ questions, status, t, requestId }: { readonly questions: readonly Question[]; readonly status: Exclude<ChoiceStatus, { kind: 'waiting' }>; readonly t: Translate; readonly requestId?: string | undefined }) {
  const chosen = status.kind === 'answered' ? status.chosen ?? [] : [];
  const line = foot(status, t);
  return (
    <div className="choices" data-choices-state={status.kind} data-request-id={requestId}>
      {questions.map((question, index) => {
        const options = question.options ?? [];
        return (
          <fieldset key={index} className="choice-q">
            <Legend question={question} />
            {options.length ? (
              <ul className="choice-lines">
                {options.map((option) => {
                  const picked = chosen.includes(option.label);
                  return (
                    <li key={option.label} className={picked ? 'choice-line chosen' : 'choice-line'}>
                      {picked ? <Check className="choice-mark" size={14} aria-hidden="true" /> : null}
                      <Label option={option} t={t} />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </fieldset>
        );
      })}
      {line ? <p className="choice-foot">{line}</p> : null}
    </div>
  );
}

export function Choices({ questions, status, t, requestId, free = true, send = 'inline', onDraft, onAnswer }: ChoicesProps) {
  if (status.kind !== 'waiting') return <Settled questions={questions} status={status} t={t} requestId={requestId} />;
  const draft = status.draft ?? emptyDraft(questions);
  const busy = status.busy === true;
  const clicks = (send === 'inline' || onAnswer !== undefined) && answersOnClick(questions);
  const result = answersFor(questions, draft);
  // Send is there when a click does not answer, or when a free answer can be typed.
  const sendable = send === 'inline' && (free || !clicks);
  const click = (index: number, label: string) => {
    if (busy) return;
    const answers = clicks ? clickAnswer(questions, index, label) : undefined;
    if (answers) onAnswer?.(answers, [label]);
    else onDraft?.(pick(questions, draft, index, label));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && result.answers) onAnswer?.(result.answers, chosenOf(draft));
  };
  const body = questions.map((question, index) => {
    const options = question.options ?? [];
    const picked = draft.picks[index] ?? [];
    return (
      <fieldset key={index} className="choice-q" data-multi={question.multiSelect ? 'true' : undefined}>
        <Legend question={question} />
        {options.length ? (
          <div className="choice-options">
            {options.map((option) => (clicks
              ? <Button key={option.label} className="choice" data-answer={option.label} data-q={index} disabled={busy} onClick={() => click(index, option.label)}><Label option={option} t={t} /></Button>
              : (
                <Toggle key={option.label} className="choice" data-answer={option.label} data-q={index} disabled={busy}
                  pressed={picked.includes(option.label)} onPressedChange={() => click(index, option.label)}>
                  <Label option={option} t={t} />
                </Toggle>
              )))}
          </div>
        ) : null}
        {free ? (
          <label className="choice-free">
            <span>{t('choice_free')}</span>
            <Input type="text" className="choice-free-input" data-free={index} maxLength={FREE_MAX} autoComplete="off" disabled={busy}
              value={draft.free[index] ?? ''} onChange={(event) => onDraft?.(typeFree(draft, index, event.target.value))} />
          </label>
        ) : null}
      </fieldset>
    );
  });
  // In the form from the start, empty: a status line drawn with its message is not read out by every reader.
  const note = <p className="choice-note" role="status">{result.tooLong !== undefined ? t('choice_too_long', { n: FREE_MAX }) : ''}</p>;
  if (send === 'bar') return <div className="choices" data-choices data-request-id={requestId}>{body}{note}</div>;
  return (
    <form className="choices" data-choices data-request-id={requestId} noValidate onSubmit={submit}>
      {body}
      {note}
      {sendable ? (
        <div className="choice-actions">
          <Button variant="ink" type="submit" className="choice-send" data-choice-send disabled={busy || !result.answers}>{t('choice_send')}</Button>
        </div>
      ) : null}
    </form>
  );
}

// A waiting question whose draft lives here: the session's and the lead's,
// one per question in the thread.
export function OwnChoices(props: Omit<ChoicesProps, 'status' | 'onDraft'> & { readonly busy?: boolean }) {
  const { busy = false, ...rest } = props;
  const [draft, setDraft] = useState<ChoiceDraft>(() => emptyDraft(props.questions));
  return <Choices {...rest} status={{ kind: 'waiting', draft, busy }} onDraft={setDraft} />;
}
