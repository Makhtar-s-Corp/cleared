// The /ask/:id screen (decision 28): a question to the code, read only. The
// question and what it is about, each turn with the reader's answer as text
// and its cost, the ask's sum with the week share, and a follow-up field,
// held while a turn runs (the reader answers 409 then). model.ts holds the
// rules; this file draws them and reads the ask again while a turn runs.
import { ArrowLeft, Eye } from '@phosphor-icons/react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Ask } from '../../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { QUESTION_MAX, askFailure, askIdOf, followAsk, pollDelay, questionProblem, readAsk, running, stateLine, targetLine, totalLine, turnsOf, usageLine } from './model.ts';
import './ask.css';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function AskScreen({ ask, t, language, draft = '', note = '', busy = false, onDraft, onFollow }: {
  readonly ask: Ask; readonly t: Translate; readonly language: 'en' | 'fr';
  readonly draft?: string; readonly note?: string; readonly busy?: boolean;
  readonly onDraft?: (text: string) => void; readonly onFollow?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const turns = turnsOf(ask);
  const total = totalLine(ask, language, t);
  const runs = running(ask);
  return (
    <section className="ask-screen" data-ask={ask.id} data-state={ask.state} aria-labelledby="ask-title">
      <a className="ask-back" href="/"><ArrowLeft size={14} aria-hidden="true" />{t('ask_back')}</a>
      <header className="ask-head">
        <p className="ask-eyebrow"><span className="ask-kind">{t('ask_title')}</span><span className="ask-target">{targetLine(ask, t)}</span></p>
        <h1 id="ask-title">{ask.question}</h1>
        <p className="ask-state"><span className={`ask-dot ${ask.state}`} aria-hidden="true" />{stateLine(ask, t)}</p>
      </header>
      <ol className="turns" aria-label={t('ask_turns_label')}>
        {turns.map(({ turn, kind }, index) => {
          const usage = usageLine(turn, language, t);
          return (
            <li className="turn" key={index} data-turn={index}>
              {index > 0 ? <p className="question"><span className="who">{t('ask_you')}</span>{turn.question}</p> : null}
              {kind === 'answered' ? <div className="answer"><span className="who">{t('ask_reader')}</span><p className="answer-text">{turn.answer}</p></div>
                : kind === 'waiting' ? <p className="answer waiting" aria-live="polite">{t('ask_waiting_answer')}</p>
                : <p className="answer lost">{t('ask_no_answer')}</p>}
              <p className="turn-meta"><time dateTime={turn.at}>{clock(turn.at)}</time>{usage ? <><span className="sep" aria-hidden="true">·</span><span>{usage}</span></> : null}</p>
            </li>
          );
        })}
      </ol>
      {total ? <p className="ask-total" data-ask-total="">{t('ask_total', { text: total })}</p> : null}
      <form className="ask-follow" id="ask-follow" autoComplete="off" onSubmit={onFollow}>
        <label className="sr-only" htmlFor="follow-input">{t('ask_follow_label')}</label>
        <Textarea id="follow-input" name="question" maxLength={QUESTION_MAX} rows={3} placeholder={t('ask_follow_placeholder')} value={draft} disabled={busy}
          onChange={(event) => onDraft?.(event.target.value)} />
        <div className="follow-bar">
          <p className="follow-note" role="status">{note || (runs ? t('ask_follow_running') : '')}</p>
          <Button variant="ink" className="btn primary" type="submit" data-act="follow" disabled={busy || runs}>{t('ask_follow_send')}</Button>
        </div>
        <p className="ask-read-only"><Eye size={14} aria-hidden="true" />{t('ask_read_only')}</p>
      </form>
    </section>
  );
}

export default function AskPage() {
  const context = useScreen();
  const { t, api } = context;
  const id = askIdOf(context.path);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [failed, setFailed] = useState<string | null>(id ? null : t('ask_failed_gone'));
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setAsk(await readAsk(api, id));
      setFailed(null);
    } catch (error) {
      setFailed(t(askFailure(error, 'read')));
    }
  }, [api, id, t]);

  useEffect(() => { void load(); }, [load]);
  // Read again while a turn runs; an ended ask is read once.
  const delay = ask ? pollDelay(ask) : null;
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [ask, delay, load]);

  const follow = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ask) return;
    const problem = questionProblem(draft);
    if (problem) {
      setNote(t(problem === 'empty' ? 'ask_question_empty' : 'ask_question_long', { n: QUESTION_MAX }));
      document.getElementById('follow-input')?.focus();
      return;
    }
    setBusy(true);
    try {
      setAsk(await followAsk(api, ask.id, draft));
      setDraft('');
      setNote('');
    } catch (error) {
      setNote(t(askFailure(error, 'follow')));
    } finally {
      setBusy(false);
    }
  };

  if (failed !== null && !ask) return <div className="ask-screen"><p className="empty error">{failed}</p></div>;
  if (!ask) return <div className="ask-screen" aria-busy="true" />;
  return <AskScreen ask={ask} t={t} language={context.me.language} draft={draft} note={note} busy={busy} onDraft={setDraft} onFollow={(event) => void follow(event)} />;
}
