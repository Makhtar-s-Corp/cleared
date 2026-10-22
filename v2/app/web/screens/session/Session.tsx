// The session screen (session.png): the ticket and its criteria on the
// left, the session's timeline in the middle with what waits for the human
// and the composer, the changes, checks and steps on the right. The
// timeline is the session's CopilotKit agent (agent.ts): this screen draws
// what the agent holds, and answers through the service's routes.
import {
  ArrowRight, ArrowUpRight, Check, Circle, DotOutline, Eye, MagnifyingGlass, PencilSimple, Play, Prohibit, Stop, WarningCircle, X, type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { SessionSummary } from '../../../../src/api/types.ts';
import type { SessionState } from '../../../../src/session/events.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { Choices, OwnChoices } from '@/components/choices/Choices.tsx';
import { sentText, type Answers } from '@/components/choices/model.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { CopilotThreads, useThread } from '@/copilot/provider.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ApiError } from '@/lib/screen.ts';
import { formatModel, harnessSquare, liveDot } from '../tower/model.ts';
import { isSessionThread, SessionAgent, sessionAgentId } from './agent.ts';
import {
  ENDED, answerBody, answerLine, clock, decisionOf, duration, family, known, latestOf, parseCriteria, phaseOf, phrase, questionStatus, refusal, resultSummary, statusMeta, statusTone, stepsOf, target, verb,
  type LocalAnswer, type QuestionRow, type RequestState, type Row, type SessionThread, type SessionView, type StreamLike, type ToolRow,
} from './model.ts';
import './session.css';

// The timeline's marks, Phosphor's regular weight.
const GLYPH: Readonly<Record<string, Icon>> = { read: Eye, edit: PencilSimple, execute: Play, other: DotOutline, search: MagnifyingGlass, fetch: ArrowUpRight, delete: X, move: ArrowRight };

function Glyph({ icon: Mark }: { readonly icon: Icon }) {
  return <span className="glyph" aria-hidden="true"><Mark size={14} /></span>;
}

function Frame({ kind, at, icon, refused = false, children }: { readonly kind: string; readonly at: string; readonly icon: Icon; readonly refused?: boolean; readonly children: ReactNode }) {
  return (
    <div className={refused ? 'row refused' : 'row'} data-row={kind}>
      <time dateTime={at}>{clock(at)}</time>
      <Glyph icon={icon} />
      <div className="what">{children}</div>
    </div>
  );
}

const Code = ({ text, title }: { readonly text: string; readonly title?: string | undefined }) => <code title={title || undefined}>{text}</code>;

function Counts({ added, removed }: { readonly added: number; readonly removed: number }) {
  return <><span className="add">+{added}</span>{removed > 0 ? <>{' '}<span className="del">−{removed}</span></> : null}</>;
}

export function StatusHead({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  return <><span className={`dot ${statusTone(view)}`} aria-hidden="true" /><h2 className="phrase-title">{phrase(view, t)}</h2><span className="meta">{statusMeta(view, t)}</span></>;
}

function RequestCard({ row, request, view, t, onAnswer }: { readonly row: ToolRow; readonly request: RequestState; readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer }) {
  const input = row.input;
  const lead = known(t, `wants_${verb(input)}`, { tool: row.name }) ?? t('wants_other', { tool: row.name });
  const description = input?.kind === 'execute' && input.description ? input.description : '';
  const reason = request.suggestion.decision === 'ask' ? request.suggestion.reason : '';
  const off = view.busy?.has(request.requestId) ?? false;
  const why = [description, reason].filter(Boolean);
  const answer = (kind: string) => onAnswer?.(request.requestId, kind);
  return (
    <div className="request" data-row="request" data-request-id={request.requestId} role="group" aria-label={t('request_group')}>
      <p className="request-title">{lead} <Code text={target(input)} /></p>
      {why.length ? <p className="request-why">{why.map((part) => <span key={part}>{part}</span>)}</p> : null}
      <div className="request-actions">
        <Button variant="ink" className="btn primary" data-answer="allow_once" disabled={off} onClick={() => answer('allow_once')}>{t('allow_once')}</Button>
        <Button className="btn" data-answer="allow_always" disabled={off} onClick={() => answer('allow_always')}>{t('allow_always')}</Button>
        <Button className="btn" data-answer="reject_once" disabled={off} onClick={() => answer('reject_once')}>{t('deny')}</Button>
      </div>
    </div>
  );
}

function ToolLine({ row, view, t, onAnswer }: { readonly row: ToolRow; readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer }) {
  const request = row.request;
  if (request?.state === 'waiting') return <RequestCard row={row} request={request} view={view} t={t} onAnswer={onAnswer} />;
  const input = row.input;
  const kind = verb(input);
  const summary = resultSummary(row.output);
  const subs: ReactNode[] = [];
  if (input?.kind === 'edit') subs.push(<Counts key="counts" added={input.added} removed={input.removed} />);
  if (summary) {
    const text = summary.key === 'passed' || summary.key === 'failed' ? t(summary.key === 'passed' ? 'result_count_ok' : 'result_failed', { n: summary.n ?? 0 }) : t(`result_${summary.key}`);
    subs.push(<span key="result" className={summary.tone === 'ok' ? 'ok' : 'bad'}>{text}</span>);
  }
  if (request) subs.push(<span key="decided" className="decided">{answerLine(request, view, t)}</span>);
  const label = input && input.kind !== 'think' && input.kind !== 'switch_mode' && input.kind !== 'other'
    ? t(`verb_${input.kind}`) : t(input?.kind === 'think' ? 'verb_think' : 'verb_other', { tool: row.name });
  const shown = target(input);
  const title = input?.kind === 'execute' ? input.description : undefined;
  const frameKind = kind === 'read' || kind === 'edit' ? kind : kind === 'execute' ? 'run' : 'tool';
  return (
    <Frame kind={frameKind} at={row.at} icon={GLYPH[kind] ?? DotOutline} refused={request?.decision === 'reject_once' || request?.decision === 'reject_always'}>
      <div>{label}{shown ? <>{' '}<Code text={shown} title={title} /></> : null}</div>
      {subs.length ? <div className="sub">{subs.flatMap((sub, index) => (index === 0 ? [sub] : [' · ', sub]))}</div> : null}
    </Frame>
  );
}

type Answer = (requestId: string, kind: string) => void;
// A question's answer: the answers keyed by question text, and the labels picked.
type QuestionAnswer = (requestId: string, answers: Answers, chosen: readonly string[]) => void;

// A question of the session, answered here through the session answer
// route: the questions the interrupt carries while it waits, else the row's.
function QuestionView({ row, view, t, onQuestion }: { readonly row: QuestionRow; readonly view: SessionView; readonly t: Translate; readonly onQuestion?: QuestionAnswer }) {
  const status = questionStatus(row, view, t);
  const questions = view.thread.interrupts.find((i) => i.id === row.requestId)?.metadata.questions ?? row.questions;
  return (
    <div className={status.kind === 'waiting' ? 'request question waits' : 'request question'} data-row="question" data-request-id={row.requestId}>
      {status.kind === 'waiting'
        ? <OwnChoices questions={questions} t={t} requestId={row.requestId} busy={status.busy ?? false} onAnswer={(answers, chosen) => onQuestion?.(row.requestId, answers, chosen)} />
        : <Choices questions={questions} status={status} t={t} requestId={row.requestId} />}
    </div>
  );
}

function RowView({ row, view, t, onAnswer, onQuestion }: { readonly row: Row; readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer; readonly onQuestion?: QuestionAnswer }) {
  switch (row.kind) {
    case 'read': {
      const [first = '', ...others] = row.paths;
      return (
        <Frame kind="read" at={row.at} icon={Eye}>
          <div>{t('verb_read')} <Code text={first} />{others.length > 0 ? ` ${t(others.length === 1 ? 'and_more_one' : 'and_more_other', { n: others.length })}` : null}</div>
        </Frame>
      );
    }
    case 'tool':
      return <ToolLine row={row} view={view} t={t} onAnswer={onAnswer} />;
    case 'message':
      return <div className={`bubble ${row.role}`} data-row="message">{row.text}</div>;
    case 'question':
      return <QuestionView row={row} view={view} t={t} onQuestion={onQuestion} />;
    case 'denied':
      return <Frame kind="denied" at={row.at} icon={Prohibit} refused><div>{refusal(row.rule, t)}</div></Frame>;
    case 'interrupted':
      return <Frame kind="interrupted" at={row.at} icon={Stop}><div>{t('row_interrupted')}</div></Frame>;
    case 'error':
      return <Frame kind="error" at={row.at} icon={WarningCircle} refused><div className="bad">{row.message}</div></Frame>;
    case 'verdict':
      return <Frame kind="verdict" at={row.at} icon={Check}><div>{t(row.verdict === 'changes_requested' ? 'verdict_changes' : 'verdict_ok', { round: row.round })}</div></Frame>;
  }
}

export function Timeline({ view, t, onAnswer, onQuestion }: { readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer; readonly onQuestion?: QuestionAnswer }) {
  const rows = view.thread.rows;
  if (rows.length === 0) return <p className="empty">{t('timeline_empty')}</p>;
  return <>{rows.map((row, index) => <RowView key={'id' in row ? `${row.kind}:${row.id}` : `${row.kind}:${row.at}:${index}`} row={row} view={view} t={t} onAnswer={onAnswer} onQuestion={onQuestion} />)}</>;
}

export function LeftCards({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  const parsed = parseCriteria(view.ticket?.body ?? '');
  return (
    <>
      <section className="card" aria-labelledby="ticket-title">
        <p className="eyebrow">{t('ticket_label')} <span className="id">{view.summary.ticket}</span></p>
        <h2 id="ticket-title" className="card-title">{view.ticket?.title ?? view.summary.ticket}</h2>
        {parsed.description.map((p, index) => <p key={index} className="desc">{p}</p>)}
      </section>
      <section className="card" aria-labelledby="criteria-title">
        <h3 id="criteria-title" className="card-label">{t('criteria_title')}</h3>
        {parsed.criteria.length === 0 ? <p className="faint small">{t('criteria_none')}</p> : (
          <ul className="criteria">
            {parsed.criteria.map((c, index) => (
              <li key={index} className={c.done ? 'crit-done' : 'crit-open'}>
                <span className="mark" aria-hidden="true">{c.done ? <Check size={13} /> : <Circle size={13} />}</span>
                <span>{c.text}</span>
                <span className="sr-only">{t(c.done ? 'criterion_done' : 'criterion_open')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-labelledby="plan-title"><h3 id="plan-title" className="card-label">{t('plan_title')}</h3><p className="faint small">{t('plan_empty')}</p></section>
    </>
  );
}

export function RightCards({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  const state = view.thread.state;
  const files = state?.files ?? [];
  const checks = state?.checks ?? [];
  const steps = stepsOf(view.thread, view.now.getTime());
  return (
    <>
      <section className="card" aria-labelledby="changes-title">
        <h3 id="changes-title" className="card-label">{t('changes_title')}</h3>
        {files.length === 0 ? <p className="faint small">{t('changes_none')}</p>
          : <ul className="changes">{files.map((f) => <li key={f.path}><span className="path">{f.path}</span><span><Counts added={f.added} removed={f.removed} /></span></li>)}</ul>}
      </section>
      <section className="card" aria-labelledby="checks-title">
        <h3 id="checks-title" className="card-label">{t('checks_title')}</h3>
        {checks.length === 0 ? <p className="faint small">{t('checks_none')}</p>
          : <ul className="checks">{checks.map((c) => <li key={c.name}><span className={`light ${c.state}`} aria-hidden="true" /><span>{c.name}</span><span className="state">· {t(`check_${c.state}`)}</span></li>)}</ul>}
        {steps.length === 0 ? null : (
          <>
            <h4 className="card-label sub-label">{t('steps_title')}</h4>
            <ul className="steps">
              {steps.map((step) => (
                <li key={step.name}>
                  <span>{t(`step_${step.name}`)}</span>
                  <span className="faint">{duration(step.ms, t)}{step.count > 1 ? ` · ${t('step_times', { n: step.count })}` : ''}{step.open ? ` · ${t('step_running')}` : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="card" aria-labelledby="screen-title"><h3 id="screen-title" className="card-label">{t('screen_title')}</h3><p className="empty-box">{t('screen_empty')}</p></section>
    </>
  );
}

export function Crumbs({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  const tab = (role: 'author' | 'reviewer') => {
    const found = latestOf(view.siblings, role);
    if (!found) return <span className="tab" aria-disabled="true">{t(`tab_${role}_waiting`)}</span>;
    const label = t(`tab_${role}`, { model: family(found.model) });
    return found.id === view.summary.id
      ? <a className="tab current" href={`/sessions/${found.id}`} aria-current="page">{label}</a>
      : <a className="tab" href={`/sessions/${found.id}`}>{label}</a>;
  };
  return (
    <>
      <nav className="crumbs" aria-label={t('crumbs_label')}><a href="/">{t('crumb_tower')}</a><span className="sep" aria-hidden="true">/</span><span className="here">{view.ticket?.title ?? view.summary.ticket}</span><span className="id">{view.summary.ticket}</span></nav>
      <div className="tabs">{tab('author')}{tab('reviewer')}</div>
    </>
  );
}

export function Composer({ view, t, text = '', sending = false, interrupting = false, note = '', onText, onSend, onInterrupt, onHandover }: {
  readonly view: SessionView; readonly t: Translate; readonly text?: string; readonly sending?: boolean; readonly interrupting?: boolean; readonly note?: string;
  readonly onText?: (value: string) => void; readonly onSend?: (event: FormEvent<HTMLFormElement>) => void; readonly onInterrupt?: () => void; readonly onHandover?: () => void;
}) {
  const off = ENDED.has(phaseOf(view));
  const role = view.summary.role === 'reviewer' ? 'reviewer' : 'author';
  return (
    <>
      <form className="composer" id="composer" autoComplete="off" onSubmit={onSend}>
        <Input id="message" name="text" placeholder={t(`composer_${role}`)} aria-label={t(`composer_${role}`)} disabled={off} value={text} onChange={(event) => onText?.(event.target.value)} />
        <Button className="btn" id="handover" aria-disabled="true" aria-describedby="handover-note" title={t('handover_note')} onClick={onHandover}>{t('handover')}</Button>
        <Button className="btn" id="interrupt" disabled={off || interrupting} onClick={onInterrupt}>{t('interrupt')}</Button>
        <Button variant="ink" className="btn primary" id="send" type="submit" disabled={off || sending}>{t('send')}</Button>
      </form>
      <span className="sr-only" id="handover-note">{t('handover_note')}</span>
      <p className="composer-note" id="composer-note" role="status">{note}</p>
    </>
  );
}

export function SessionIndex({ sessions, tickets, now, t }: { readonly sessions: readonly SessionSummary[]; readonly tickets: readonly Ticket[]; readonly now: Date; readonly t: Translate }) {
  const titles = new Map(tickets.map((ticket) => [ticket.id, ticket.title]));
  const minutes = (from: string) => Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));
  const ordered = [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <div className="index">
      <h1>{t('index_title')}</h1>
      {ordered.length === 0 ? <p className="empty">{t('index_empty')}</p> : (
        <ul className="sessions">
          {ordered.map((s) => (
            <li key={s.id} className="session-card">
              <span className="session-head"><span className={liveDot(s.phase, s.role)} aria-hidden="true" /><span className="role">{t(`role_${s.role}`)}</span><span className="id">{s.ticket}</span></span>
              <span className="session-title">{titles.get(s.ticket) ?? s.ticket}</span>
              <span className="phrase">{s.phase === 'waiting_human' ? t('status_waiting_human') : s.status}</span>
              <span className="session-foot">
                <span className="model"><span className={`sq ${harnessSquare(s.harness)}`} aria-hidden="true" />{formatModel(s.harness, s.model)}</span>
                <span className="elapsed">{t('minutes', { n: minutes(s.startedAt) })}</span>
                <a className="open" href={`/sessions/${s.id}`}>{t('open_session')}</a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const REFRESH_MS = 10_000;
const TICK_MS = 20_000;

function useEvery(ms: number, run: () => void): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

function Index() {
  const { t, api, now } = useScreen();
  const [data, setData] = useState<{ sessions: SessionSummary[]; tickets: Ticket[] } | 'failed' | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [sessions, tickets] = await Promise.all([api<SessionSummary[]>('/sessions'), api<Ticket[]>('/tickets')]);
      setData({ sessions, tickets });
    } catch {
      setData('failed');
    }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEvery(REFRESH_MS, () => void refresh());
  if (data === null) return null;
  if (data === 'failed') return <div className="index"><p className="empty error">{t('load_failed')}</p></div>;
  return <SessionIndex sessions={data.sessions} tickets={data.tickets} now={now()} t={t} />;
}

type Loaded = { readonly summary: SessionSummary; readonly state: SessionState; readonly ticket: Ticket | undefined; readonly siblings: readonly SessionSummary[] };

function Live({ loaded }: { readonly loaded: Loaded }) {
  const context = useScreen();
  const { t } = context;
  const { state: thread } = useThread<SessionThread>(sessionAgentId(loaded.summary.id), isSessionThread);
  const [siblings, setSiblings] = useState(loaded.siblings);
  const [now, setNow] = useState(() => context.now());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<ReadonlyMap<string, LocalAnswer>>(new Map());
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [note, setNote] = useState('');
  const timeline = useRef<HTMLDivElement | null>(null);
  const atEnd = useRef(true);
  const id = loaded.summary.id;

  // The reviewer's session appears once it starts; the clock moves on.
  useEvery(REFRESH_MS, async () => {
    try {
      const all = await context.api<SessionSummary[]>('/sessions');
      setSiblings(all.filter((s) => s.ticket === loaded.summary.ticket));
    } catch { /* the next tick tries again */ }
  });
  useEvery(TICK_MS, () => setNow(context.now()));

  const view: SessionView = useMemo(() => ({
    summary: loaded.summary, ticket: loaded.ticket, siblings, me: context.me.user.id, language: context.me.language, now, busy, answers,
    thread: thread ?? { lastSeq: 0, lastAt: undefined, state: loaded.state, rows: [], pending: [], interrupts: [], steps: [] },
  }), [loaded, siblings, context.me, now, busy, answers, thread]);

  // The timeline follows the newest row while the person is at its end.
  const onScroll = () => {
    const el = timeline.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = timeline.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [thread]);

  const post = async (path: string, body: unknown, failure: string): Promise<boolean> => {
    try {
      await context.api(`/sessions/${encodeURIComponent(id)}${path}`, { method: 'POST', body });
      setNote('');
      return true;
    } catch {
      setNote(t(failure));
      return false;
    }
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typed = text.trim();
    if (!typed) { document.getElementById('message')?.focus(); return; }
    setSending(true);
    if (await post('/messages', { text: typed }, 'send_failed')) setText('');
    setSending(false);
    document.getElementById('message')?.focus();
  };
  const interrupt = async () => {
    setInterrupting(true);
    await post('/interrupt', null, 'interrupt_failed');
    setInterrupting(false);
  };
  const answer: Answer = async (requestId, kind) => {
    if (busy.has(requestId)) return;
    setBusy((current) => new Set([...current, requestId]));
    if (await post(`/requests/${encodeURIComponent(requestId)}/answer`, { decision: decisionOf(kind, t) }, 'answer_failed')) context.inboxChanged();
    else setBusy((current) => new Set([...current].filter((other) => other !== requestId)));
  };
  // A question's answer, with its own body: a permission's decisionOf would
  // read an option's label as a denial.
  const answerQuestion: QuestionAnswer = async (requestId, given, chosen) => {
    if (busy.has(requestId)) return;
    setBusy((current) => new Set([...current, requestId]));
    const remember = (answer: LocalAnswer) => setAnswers((current) => new Map([...current, [requestId, answer]]));
    try {
      await context.api(`/sessions/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}/answer`, { method: 'POST', body: answerBody(given) });
      remember({ kind: 'sent', sent: sentText(given), chosen });
      setNote('');
      context.inboxChanged();
    } catch (error) {
      // 404: nothing waits under that id any more; 409: the session stopped.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        remember({ kind: 'settled' });
        context.inboxChanged();
      } else setNote(t('answer_failed'));
    }
    setBusy((current) => new Set([...current].filter((other) => other !== requestId)));
  };

  return (
    <>
      <div className="session-top" id="crumbs"><Crumbs view={view} t={t} /></div>
      <div className="session" aria-busy={thread ? undefined : 'true'}>
        <aside className="s-left" id="s-left" aria-label={t('left_label')}><LeftCards view={view} t={t} /></aside>
        <section className="panel" aria-label={t('timeline_label')}>
          <div className="panel-head" id="status"><StatusHead view={view} t={t} /></div>
          <div className="timeline" id="timeline" tabIndex={0} ref={timeline} onScroll={onScroll}><Timeline view={view} t={t} onAnswer={(requestId, kind) => void answer(requestId, kind)} onQuestion={(requestId, given, chosen) => void answerQuestion(requestId, given, chosen)} /></div>
          <div className="panel-foot">
            <Composer view={view} t={t} text={text} sending={sending} interrupting={interrupting} note={note} onText={setText}
              onSend={(event) => void send(event)} onInterrupt={() => void interrupt()} onHandover={() => setNote(t('handover_note'))} />
          </div>
        </section>
        <aside className="s-right" id="s-right" aria-label={t('right_label')}><RightCards view={view} t={t} /></aside>
      </div>
    </>
  );
}

// The session named by the address: its detail, its ticket and its
// siblings first; then its agent, which follows the stream.
function One({ id }: { readonly id: string }) {
  const context = useScreen();
  const [loaded, setLoaded] = useState<Loaded | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [detail, all] = await Promise.all([context.api<SessionSummary & { state: SessionState }>(`/sessions/${encodeURIComponent(id)}`), context.api<SessionSummary[]>('/sessions')]);
        const ticket = await context.api<Ticket>(`/tickets/${encodeURIComponent(detail.ticket)}`).catch(() => undefined);
        if (live) setLoaded({ summary: detail, state: detail.state, ticket, siblings: all.filter((s) => s.ticket === detail.ticket) });
      } catch {
        if (live) setLoaded('failed');
      }
    })();
    return () => { live = false; };
  }, [context, id]);
  const agents = useMemo(() => (loaded && loaded !== 'failed' ? {
    [sessionAgentId(id)]: new SessionAgent({
      sessionId: id, state: loaded.state,
      open: (url) => new EventSource(url) as unknown as StreamLike,
      later: (run, ms) => { setTimeout(run, ms); },
    }),
  } : null), [id, loaded]);
  if (loaded === 'failed') return <div className="index"><p className="empty error">{context.t('load_failed')}</p></div>;
  if (!loaded || !agents) return <><div className="session-top" /><div className="session" aria-busy="true" /></>;
  return <CopilotThreads agents={agents}><Live loaded={loaded} /></CopilotThreads>;
}

export default function Session() {
  const { path } = useScreen();
  const id = path.split('/')[2];
  return id ? <One id={id} /> : <Index />;
}

