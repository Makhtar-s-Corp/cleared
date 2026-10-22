// The session screen (session.png): the ticket and its criteria on the
// left, the session's timeline in the middle with what waits for the human
// and the composer, the changes, checks and steps on the right. The
// timeline is the session's CopilotKit agent (agent.ts): this screen draws
// what the agent holds, and answers through the service's routes.
//
// The middle panel has four tabs (decision 30, lane 20; Tabs.tsx): Plan,
// Terminal (the timeline and the composer, opened first), Editor and
// Browser, with Take over and Give back beside them. Once the signed-in
// account took the session over, on the app's loopback address, the
// Terminal tab holds the web terminal in place of the timeline (decision
// 32); the Editor tab opens a changed file for editing and saves it through
// the files route (decision 33). Both packages load by a dynamic import
// (lane 32).
import {
  ArrowRight, ArrowUpRight, Check, DotOutline, Eye, ListChecks, MagnifyingGlass, PencilSimple, Play, Prohibit, Stop, WarningCircle, X, type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ConfirmableRule, SessionDetail, SessionFile, SessionFiles, SessionSummary, TakenOver, TicketStep } from '../../../../src/api/types.ts';
import type { SessionState } from '../../../../src/session/events.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { Choices, OwnChoices } from '@/components/choices/Choices.tsx';
import { sentText, type Answers } from '@/components/choices/model.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { editorReducer, editorStart, putFile, readOnlyWhy, saveOutcome, type EditorAction, type EditorState, type ReadOnlyWhy } from '@/components/editor/model.ts';
import { harnessName, terminalChoice } from '@/components/terminal/model.ts';
import { WebTerminal } from '@/components/terminal/Terminal.tsx';
import { CopilotThreads, useThread } from '@/copilot/provider.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ApiError } from '@/lib/screen.ts';
import { formatModel, harnessSquare, liveDot } from '../tower/model.ts';
import { isSessionThread, SessionAgent, sessionAgentId } from './agent.ts';
import {
  ENDED, answerBody, answerLine, clock, decisionOf, duration, family, known, latestOf, parseCriteria, phaseOf, phrase, questionStatus, refusal, resultSummary, statusMeta, statusTone, stepsOf, takenOverOf, target, verb,
  type LocalAnswer, type QuestionRow, type RequestState, type Row, type SessionThread, type SessionView, type StreamLike, type ToolRow,
} from './model.ts';
import { BrowserTab, Confidence, Criteria, EditorTab, PlanTab, TabStrip, TakeoverNotice, type EditorShown } from './Tabs.tsx';
import { browserView, changeProblem, CHANGE_MAX, goLine, nextTab, serviceLine, stepsView, tabOf, takeoverOf, type Tab } from './tabs.ts';
import { askHref } from '@/screens/ask/model.ts';
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
    case 'plan':
      return <Frame kind="plan" at={row.at} icon={row.go ? Check : ListChecks}><div>{row.go ? goLine(row, view.me, t) : t(`row_plan_${row.confidence}`)}</div></Frame>;
  }
}

export function Timeline({ view, t, onAnswer, onQuestion }: { readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer; readonly onQuestion?: QuestionAnswer }) {
  const rows = view.thread.rows;
  if (rows.length === 0) return <p className="empty">{t('timeline_empty')}</p>;
  return <>{rows.map((row, index) => <RowView key={'id' in row ? `${row.kind}:${row.id}` : `${row.kind}:${row.at}:${index}`} row={row} view={view} t={t} onAnswer={onAnswer} onQuestion={onQuestion} />)}</>;
}

export function LeftCards({ view, t, onPlan }: { readonly view: SessionView; readonly t: Translate; readonly onPlan?: () => void }) {
  const parsed = parseCriteria(view.ticket?.body ?? '');
  const plan = view.thread.plan;
  const service = serviceLine(view.summary.service, t, stepsView(view.steps, view.summary.id));
  return (
    <>
      <section className="card" aria-labelledby="ticket-title">
        <p className="eyebrow">{t('ticket_label')} <span className="id">{view.summary.ticket}</span>{service ? <> · <span className="service">{service}</span></> : null}</p>
        <h2 id="ticket-title" className="card-title">{view.ticket?.title ?? view.summary.ticket}</h2>
        {parsed.description.map((p, index) => <p key={index} className="desc">{p}</p>)}
      </section>
      <section className="card" aria-labelledby="criteria-title">
        <h3 id="criteria-title" className="card-label">{t('criteria_title')}</h3>
        <Criteria view={view} t={t} />
      </section>
      <section className="card" aria-labelledby="plan-title">
        <h3 id="plan-title" className="card-label">{t('plan_title')}</h3>
        {plan ? (
          <div className="plan-short">
            <p><Confidence plan={plan} t={t} /> <span className="faint small">{t('plan_steps_count', { n: plan.steps.length })}</span></p>
            <p className="small">{plan.go ? goLine(plan, view.me, t) : t('plan_waiting')}</p>
            {onPlan ? <button type="button" className="link-button small" onClick={onPlan}>{t('plan_tab_title')}</button> : null}
          </div>
        ) : <p className="faint small">{t('plan_empty')}</p>}
      </section>
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
  // A session taken over is written to by nobody until it is given back.
  const off = ENDED.has(phaseOf(view)) || takenOverOf(view) !== null;
  const role = view.summary.role === 'reviewer' ? 'reviewer' : 'author';
  const placeholder = takenOverOf(view) !== null && !ENDED.has(phaseOf(view)) ? t('composer_taken_over') : t(`composer_${role}`);
  return (
    <>
      <form className="composer" id="composer" autoComplete="off" onSubmit={onSend}>
        <Input id="message" name="text" placeholder={placeholder} aria-label={placeholder} disabled={off} value={text} onChange={(event) => onText?.(event.target.value)} />
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
          {ordered.map((s) => {
            // A reader's session (decision 28) is its question's: the ask
            // screen shows it, and its ticket is the ask's id.
            const reader = s.role === 'reader';
            return (
            <li key={s.id} className="session-card">
              <span className="session-head"><span className={liveDot(s.phase, s.role)} aria-hidden="true" /><span className="role">{t(`role_${s.role}`)}</span>{reader ? null : <span className="id">{s.ticket}</span>}</span>
              <span className="session-title">{reader ? t('reader_title') : titles.get(s.ticket) ?? s.ticket}</span>
              <span className="phrase">{s.phase === 'waiting_human' ? t('status_waiting_human') : s.status}</span>
              <span className="session-foot">
                <span className="model"><span className={`sq ${harnessSquare(s.harness)}`} aria-hidden="true" />{formatModel(s.harness, s.model)}</span>
                <span className="elapsed">{t('minutes', { n: minutes(s.startedAt) })}</span>
                {reader ? <a className="open" href={askHref(s.ticket)}>{t('open_ask')}</a> : <a className="open" href={`/sessions/${s.id}`}>{t('open_session')}</a>}
              </span>
            </li>
            );
          })}
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

type Loaded = {
  readonly summary: SessionSummary; readonly state: SessionState; readonly ticket: Ticket | undefined; readonly siblings: readonly SessionSummary[];
  readonly previewKey: string | null;
};

// A file of the checkout, or of the ticket's base, as the files route
// answers it; its refusal keeps the service's reason (a 403's rule).
async function readFile(id: string, path: string, base: boolean): Promise<SessionFile | null | { readonly refused: string }> {
  const url = `/api/service/sessions/${encodeURIComponent(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}${base ? '?version=base' : ''}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.ok) return await response.json() as SessionFile;
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (response.status === 403 || response.status === 415 || response.status === 413) return { refused: typeof body.error === 'string' ? body.error : String(response.status) };
  throw new ApiError(response.status, url);
}

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
  const [tab, setTab] = useState<Tab>(() => tabOf(window.location.hash));
  const [takenOver, setTakenOver] = useState<TakenOver | null>(loaded.summary.takenOver ?? null);
  const [gesture, setGesture] = useState(false);              // a take over, a give back, a Go or a Change on its way
  const [changing, setChanging] = useState(false);
  const [change, setChange] = useState('');
  const [planNote, setPlanNote] = useState('');
  const [files, setFiles] = useState<SessionFiles['files'] | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState<EditorShown | undefined>(undefined);
  const [fileFailed, setFileFailed] = useState(false);
  const [mode, setMode] = useState<'diff' | 'file'>('diff');
  const [steps, setSteps] = useState<readonly TicketStep[] | null>(null);
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [generation, setGeneration] = useState(0);
  const [editable, setEditable] = useState<{ readonly file: SessionFile; readonly why: ReadOnlyWhy | undefined } | null>(null);
  const editingNow = useRef(editing);
  editingNow.current = editing;
  const timeline = useRef<HTMLDivElement | null>(null);
  const atEnd = useRef(true);
  const id = loaded.summary.id;

  // The ticket's steps across services (lane 23's route): a service
  // without them, or a ticket of one step, shows none.
  const readSteps = useCallback(async () => {
    try {
      const answer = await context.api<unknown>(`/tickets/${encodeURIComponent(loaded.summary.ticket)}/steps`);
      setSteps(Array.isArray(answer) ? answer as TicketStep[] : null);
    }
    catch { /* the next tick tries again */ }
  }, [context, loaded.summary.ticket]);
  useEffect(() => { void readSteps(); }, [readSteps]);

  // The reviewer's session appears once it starts; who took this one over
  // follows the service; the steps move on; the clock moves on.
  useEvery(REFRESH_MS, async () => {
    void readSteps();
    try {
      const all = await context.api<SessionSummary[]>('/sessions');
      setSiblings(all.filter((s) => s.ticket === loaded.summary.ticket));
      const own = all.find((s) => s.id === id);
      if (own && !gesture) setTakenOver(own.takenOver ?? null);
    } catch { /* the next tick tries again */ }
  });
  useEvery(TICK_MS, () => setNow(context.now()));

  const view: SessionView = useMemo(() => ({
    summary: loaded.summary, ticket: loaded.ticket, siblings, me: context.me.user.id, language: context.me.language, now, busy, answers, takenOver, steps,
    thread: thread ?? { lastSeq: 0, lastAt: undefined, state: loaded.state, rows: [], pending: [], interrupts: [], steps: [], plan: null },
  }), [loaded, siblings, context.me, now, busy, answers, thread, takenOver, steps]);
  const ended = ENDED.has(phaseOf(view));
  const takeover = takeoverOf({ takenOver, me: view.me, role: loaded.summary.role, ended });
  const terminal = terminalChoice({ offered: context.me.terminal, takeover });
  // An author's live session, not another account's: the service checks the rest at the save.
  const sessionOpen = loaded.summary.role === 'author' && !ended && takeover.kind !== 'other';

  // The timeline follows the newest row while the person is at its end.
  const onScroll = () => {
    const el = timeline.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = timeline.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [thread, tab]);

  // The tab is in the address, so a reload keeps it.
  const select = (next: Tab, focus = false) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
    if (focus) document.getElementById(`tab-${next}-button`)?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    select(nextTab(tab, event.key), true);
  };

  // The Editor's files, when the tab opens and when the session changes one.
  const changed = (view.thread.state?.files ?? []).map((f) => `${f.path}:${f.added}:${f.removed}`).join('|');
  useEffect(() => {
    if (tab !== 'editor') return;
    let live = true;
    void context.api<SessionFiles>(`/sessions/${encodeURIComponent(id)}/files`).then((answer) => {
      if (!live) return;
      setFiles(answer.files);
      setSelected((current) => current ?? answer.files[0]?.path);
    }, () => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [context, id, tab, changed]);
  useEffect(() => {
    if (tab !== 'editor' || selected === undefined) return;
    let live = true;
    setShown(undefined);
    setFileFailed(false);
    void Promise.all([readFile(id, selected, false), readFile(id, selected, true)]).then(([file, base]) => {
      if (!live) return;
      if (file && 'refused' in file) return setShown({ file: null, base: null, error: file.refused });
      setShown({ file, base: base && !('refused' in base) ? base : null });
    }, () => { if (live) setFileFailed(true); });
    return () => { live = false; };
  }, [id, tab, selected, changed]);

  // The Editor's editing (decision 33): a file opens only when its text on
  // screen is the file (components/editor/model.ts); the editor's own text
  // stays until it is saved, put back or reloaded.
  const shownFile = shown?.file ?? null;
  useEffect(() => {
    if (!shownFile) return;
    let live = true;
    void readOnlyWhy(shownFile, { sessionOpen }).then((why) => { if (live) setEditable({ file: shownFile, why }); });
    return () => { live = false; };
  }, [shownFile, sessionOpen]);
  const editWhy: ReadOnlyWhy = editable?.file === shownFile ? editable.why ?? 'session' : 'session';
  const canEdit = editable?.file === shownFile && editable?.why === undefined;
  const stale = editing !== null && shownFile !== null && shownFile.path === editing.doc.path && shownFile.hash !== editing.doc.hash && editing.status !== 'saving';
  const dispatch = (action: EditorAction) => setEditing((current) => (current ? editorReducer(current, action) : current));
  const startEditing = (file: SessionFile) => {
    setEditing(editorStart(file));
    setGeneration((n) => n + 1);
  };
  const saveEditing = async (confirm?: ConfirmableRule) => {
    const current = editingNow.current;
    if (!current || current.status === 'saving') return;
    dispatch(confirm ? { kind: 'save', confirm } : { kind: 'save' });
    try {
      const answer = await putFile({ session: id, path: current.doc.path, text: current.text, hash: current.doc.hash, csrf: context.me.csrf, confirm });
      const outcome = saveOutcome(answer.status, answer.body, context.now().toISOString());
      dispatch(outcome);
      // The viewer holds what was saved, so the file is not taken for the session's change.
      if (outcome.kind === 'saved') {
        const lines = current.text === '' ? 0 : current.text.split('\n').length - (current.text.endsWith('\n') ? 1 : 0);
        setShown((was) => (was?.file?.path === current.doc.path ? { ...was, file: { ...was.file, text: current.text, hash: outcome.hash, lines } } : was));
      }
    } catch {
      dispatch({ kind: 'failed' });
    }
  };
  const reloadEditing = async () => {
    const current = editingNow.current;
    if (!current) return;
    try {
      const file = await readFile(id, current.doc.path, false);
      if (!file || 'refused' in file) return setEditing(null);
      setShown((was) => (was?.file?.path === file.path ? { ...was, file } : was));
      if (await readOnlyWhy(file, { sessionOpen })) return setEditing(null);
      startEditing(file);
    } catch {
      dispatch({ kind: 'failed' });
    }
  };

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

  // Take over and Give back (flow/takeover.ts).
  const takeOver = async () => {
    setGesture(true);
    if (await post('/takeover', null, 'takeover_failed')) {
      setTakenOver({ by: view.me, at: context.now().toISOString() });
      select('terminal');
      context.inboxChanged();
    }
    setGesture(false);
  };
  const giveBack = async () => {
    setGesture(true);
    if (await post('/giveback', null, 'giveback_failed')) setTakenOver(null);
    setGesture(false);
  };

  // The session plan's Go and Change (flow/plan-gate.ts).
  const planPost = async (path: string, body: unknown, failure: string): Promise<boolean> => {
    setGesture(true);
    try {
      await context.api(`/sessions/${encodeURIComponent(id)}${path}`, { method: 'POST', body });
      setPlanNote('');
      context.inboxChanged();
      return true;
    } catch {
      setPlanNote(t(failure));
      return false;
    } finally {
      setGesture(false);
    }
  };
  const go = () => void planPost('/plan/go', null, 'plan_go_failed');
  const sendChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = changeProblem(change);
    if (problem) { setPlanNote(t(problem === 'empty' ? 'plan_change_empty' : 'plan_change_too_long', { n: CHANGE_MAX })); return; }
    if (await planPost('/plan/change', { message: change.trim() }, 'plan_change_failed')) { setChanging(false); setChange(''); }
  };

  const browser = browserView({ id, previewKey: loaded.previewKey, previewOrigin: document.body.dataset.preview, pageHost: window.location.hostname });
  const panel = (name: Tab) => ({ id: `tab-${name}`, role: 'tabpanel', 'aria-labelledby': `tab-${name}-button`, hidden: tab !== name });

  return (
    <>
      <div className="session-top" id="crumbs"><Crumbs view={view} t={t} /></div>
      <div className="session" aria-busy={thread ? undefined : 'true'}>
        <aside className="s-left" id="s-left" aria-label={t('left_label')}><LeftCards view={view} t={t} onPlan={() => select('plan', true)} /></aside>
        <section className="panel" aria-label={t('timeline_label')}>
          <TabStrip tab={tab} t={t} takeover={takeover} busy={gesture} onSelect={(next) => select(next)} onKey={onKey} onTakeover={() => void takeOver()} onGiveback={() => void giveBack()} />
          <div className="panel-head" id="status"><StatusHead view={view} t={t} /></div>
          <div className="tab-panel" {...panel('terminal')}>
            {terminal.kind === 'web' ? (
              <div className="term-wrap">
                <TakeoverNotice view={view} t={t} web />
                <WebTerminal session={id} csrf={context.me.csrf} active={tab === 'terminal'} t={t} harness={harnessName(view.summary.harness)} />
              </div>
            ) : (
              <div className="timeline" id="timeline" tabIndex={0} ref={timeline} onScroll={onScroll}>
                <TakeoverNotice view={view} t={t} why={terminal.kind === 'notice' ? terminal.why : undefined} />
                <Timeline view={view} t={t} onAnswer={(requestId, kind) => void answer(requestId, kind)} onQuestion={(requestId, given, chosen) => void answerQuestion(requestId, given, chosen)} />
              </div>
            )}
            <div className="panel-foot">
              <Composer view={view} t={t} text={text} sending={sending} interrupting={interrupting} note={note} onText={setText}
                onSend={(event) => void send(event)} onInterrupt={() => void interrupt()} onHandover={() => setNote(t('handover_note'))} />
            </div>
          </div>
          <div className="tab-panel scroll" {...panel('plan')}>
            <PlanTab view={view} plan={view.thread.plan} t={t} changing={changing} change={change} busy={gesture} note={planNote}
              onGo={go} onChangeOpen={() => { setChanging(true); setPlanNote(''); }} onChangeText={setChange} onChangeSend={(event) => void sendChange(event)} onChangeCancel={() => { setChanging(false); setPlanNote(''); }} />
          </div>
          <div className="tab-panel scroll" {...panel('editor')}>
            {tab === 'editor' || files !== null ? (
              <EditorTab t={t} files={files ?? []} selected={selected} shown={shown} mode={mode} failed={fileFailed}
                onSelect={(path) => { setEditing(null); setSelected(path); setMode('diff'); }} onMode={setMode}
                edit={{
                  can: canEdit, why: editWhy, state: editing ?? undefined, stale, taken: takeover.kind === 'mine', generation,
                  onEdit: () => { if (shownFile) startEditing(shownFile); },
                  onChange: (text) => dispatch({ kind: 'edit', text }),
                  onSave: () => void saveEditing(),
                  onConfirm: () => { const current = editingNow.current; if (current?.status === 'confirm') void saveEditing(current.rule); },
                  onReload: () => void reloadEditing(),
                  onClose: () => setEditing(null),
                }} />
            ) : null}
          </div>
          <div className="tab-panel" {...panel('browser')}>
            {tab === 'browser' ? <BrowserTab view={browser} t={t} /> : null}
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
        const [detail, all] = await Promise.all([context.api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`), context.api<SessionSummary[]>('/sessions')]);
        const ticket = await context.api<Ticket>(`/tickets/${encodeURIComponent(detail.ticket)}`).catch(() => undefined);
        if (live) setLoaded({ summary: detail, state: detail.state, ticket, siblings: all.filter((s) => s.ticket === detail.ticket), previewKey: detail.previewKey ?? null });
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

