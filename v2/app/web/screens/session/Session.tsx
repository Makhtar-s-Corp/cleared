// The session screen (session.png): the ticket and its criteria on the
// left, the thread in the middle with what waits for the human and the
// composer, the changes, checks and steps on the right. Each session's
// timeline is its CopilotKit agent (agent.ts): this screen draws what the
// agents hold, and answers through the service's routes.
//
// The view follows the ticket, not the session id (lane 36, U6; ticket.ts):
// one thread of the ticket's sessions, a handover row where the reviewer
// took over, the reviewer's stream continuing below, live, in the same
// view; Author and Reviewer filter that thread. The view acts on the
// ticket's live session, whatever its role (its status, its composer, its
// Take over), and the address follows it without a navigation, so a reload
// lands on the live one. A view kept hidden (lib/stack.tsx) holds no
// stream and reads nothing until it is shown again.
//
// The middle panel has four tabs (decision 30, lane 20; Tabs.tsx): Plan,
// Terminal (the thread and the composer, opened first), Editor and
// Browser. Once the signed-in account took the session over, on the app's
// loopback address, the Terminal tab holds the web terminal in place of the
// thread (decision 32); the Editor tab holds the ticket's diff and opens a
// changed file for editing (decision 33). Both packages load by a dynamic
// import (lane 32).
import {
  ArrowCounterClockwise, ArrowRight, ArrowUpRight, CaretRight, ChatText, Check, DotOutline, Eye, ListChecks, MagnifyingGlass, PencilSimple, Play, Prohibit, Stop, Terminal, WarningCircle, X, type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import type { ConfirmableRule, EditorLinks, SessionDetail, SessionFile, SessionFiles, SessionSummary, TakenOver, TicketStep } from '../../../../src/api/types.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { Choices, OwnChoices } from '@/components/choices/Choices.tsx';
import { sentText, type Answers } from '@/components/choices/model.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import {
  editorReducer, editorStart, lastTurnFiles, putFile, readOnlyWhy, saveOutcome, type EditorAction, type EditorState, type ReadOnlyWhy, type Scope,
} from '@/components/editor/model.ts';
import { harnessName, terminalChoice } from '@/components/terminal/model.ts';
import { WebTerminal } from '@/components/terminal/Terminal.tsx';
import { CopilotThreads, useThread } from '@/copilot/provider.tsx';
import { useGo, useScreen } from '@/lib/context.tsx';
import { Empty } from '@/shell/Empty.tsx';
import { commandParts, intentSentence, looksLikeCommand } from '@/lib/intent.ts';
import { sessionStatus } from '@/lib/status.ts';
import { since } from '@/lib/time.ts';
import { requestAsk, requestFold, requestFoldOpen, requestReason } from '@/lib/request.ts';
import { useKept, useLive } from '@/lib/query.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { forgetView, keepWith, viewOf } from '@/lib/routes.ts';
import { ApiError } from '@/lib/screen.ts';
import { formatModel, harnessSquare, liveDot } from '../tower/model.ts';
import { isSessionThread, SessionAgent, sessionAgentId } from './agent.ts';
import {
  ENDED, REPLAY_MAX, answerBody, answerLine, clock, decisionOf, duration, family, parseCriteria, phaseOf, phrase, questionStatus, refusal, resultSummary, shortCommit, statusMeta, statusTone, stepCommit, takenOverOf, target, verb, who,
  type EditsRow, type LocalAnswer, type QuestionRow, type ReadRow, type ReplayRow, type RequestState, type Row, type SessionThread, type SessionView, type StreamLike, type ToolRow,
} from './model.ts';
import { BrowserTab, Confidence, Criteria, EditorTab, OpenInEditor, PlanTab, TabStrip, TakeoverButton, TakeoverNotice, type EditorShown } from './Tabs.tsx';
import { browserView, changeProblem, CHANGE_MAX, editorOffer, goLine, nextTab, serviceLine, stepsView, tabOf, takeoverOf, type Tab } from './tabs.ts';
import {
  actingSession, editsOf, viewSessions, filterOptions, handoverLine, isLive, partsOf, ticketChecks, ticketFiles, ticketPlan, ticketSessions, ticketSteps, ticketThread,
  type Filter, type Handover, type ThreadEntry, type TicketPart,
} from './ticket.ts';
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

// A step of the thread (a command, an edit, a read: Devin's worklog): one
// row that opens its detail, folded until the person asks.
// `resume`: its Resume from here (issue #272), under the detail.
function Step({ kind, at, icon, refused = false, line, detail, resume }: {
  readonly kind: string; readonly at: string; readonly icon: Icon; readonly refused?: boolean; readonly line: ReactNode; readonly detail: ReactNode; readonly resume?: ReactNode;
}) {
  return (
    <details className={refused ? 'row step refused' : 'row step'} data-row={kind}>
      <summary>
        <time dateTime={at}>{clock(at)}</time>
        <Glyph icon={icon} />
        <div className="what">{line}</div>
        <CaretRight className="caret" size={12} aria-hidden="true" />
      </summary>
      <div className="step-detail">{detail}{resume}</div>
    </details>
  );
}

const Code = ({ text, title }: { readonly text: string; readonly title?: string | undefined }) => <code title={title || undefined}>{text}</code>;

// A command as it ran, one command a line, the operator before each.
export function CommandLines({ command }: { readonly command: string }) {
  return (
    <pre className="command"><code>{commandParts(command).map((part, index) => (
      <span key={index} className="command-line">{part.op ? <span className="op">{part.op} </span> : null}{part.text}{'\n'}</span>
    ))}</code></pre>
  );
}

function Counts({ added, removed }: { readonly added: number; readonly removed: number }) {
  return <><span className="add">+{added}</span>{removed > 0 ? <>{' '}<span className="del">−{removed}</span></> : null}</>;
}

// The last lines a command printed: enough to see how it ended.
const OUTPUT_LINES = 8;
const tail = (text: string) => text.replace(/\s+$/, '').split('\n').slice(-OUTPUT_LINES).join('\n');

export function StatusHead({ view, t }: { readonly view: SessionView; readonly t: Translate }) {
  const several = (view.parts?.length ?? 1) > 1;
  const who = several && (view.summary.role === 'author' || view.summary.role === 'reviewer') ? `${t(`tab_${view.summary.role}`, { model: family(view.summary.model) })} · ` : '';
  return <><span className={`dot ${statusTone(view)}`} aria-hidden="true" /><h2 className="phrase-title">{phrase(view, t)}</h2><span className="meta">{who ? <span className="who">{who}</span> : null}{statusMeta(view, t)}</span></>;
}

// A request waiting in the thread, as the inbox says it (lib/request.ts, lane
// 37): the question naming who asks, why in the person's words, the three
// answers, then the command folded, open by itself when it must be read.
function RequestCard({ row, request, view, t, onAnswer }: { readonly row: ToolRow; readonly request: RequestState; readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer }) {
  const input = row.input;
  const asked = input ? { input, tool: row.name } : undefined;
  const title = asked ? requestAsk(asked, view.summary.role, t) : t('wants_other', { tool: row.name });
  const why = asked ? requestReason(asked, request.suggestion, t) : {};
  const description = input?.kind === 'execute' && input.description ? input.description : '';
  const fold = input ? requestFold(input) : [];
  const off = view.busy?.has(request.requestId) ?? false;
  const answer = (kind: string) => onAnswer?.(request.requestId, kind, view.summary.id);
  return (
    <div className="request" data-row="request" data-request-id={request.requestId} data-command={input ? target(input) : undefined} role="group" aria-label={t('request_group')}>
      <p className="request-title">{title}</p>
      {why.said ? <p className="request-why"><span>{why.said}</span></p> : null}
      <div className="request-actions">
        <Button variant="ink" className="btn primary" data-answer="allow_once" disabled={off} onClick={() => answer('allow_once')}>{t('allow_once')}</Button>
        <Button className="btn" data-answer="allow_always" disabled={off} onClick={() => answer('allow_always')}>{t('allow_always')}</Button>
        <Button className="btn" data-answer="reject_once" disabled={off} onClick={() => answer('reject_once')}>{t('deny')}</Button>
      </div>
      {fold.length > 0 ? (
        <details className="request-fold" open={asked ? requestFoldOpen(asked) : false}>
          <summary><span className="fold-label">{t(input?.kind === 'execute' ? 'fold_command' : 'fold_target')}</span> <Code text={fold[0]?.text ?? ''} />{fold.length > 1 ? <span className="fold-more"> {t(fold.length === 2 ? 'fold_more_one' : 'fold_more_other', { n: fold.length - 1 })}</span> : null}</summary>
          {input?.kind === 'execute' ? <CommandLines command={input.command} /> : null}
          {description || why.raw ? (
            <p className="request-why">{description ? <span>{description}</span> : null}{why.raw ? <span>{why.raw}</span> : null}</p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function ToolLine({ row, view, t, onAnswer, onFile, resume }: { readonly row: ToolRow; readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer; readonly onFile?: OpenFile; readonly resume?: ReactNode }) {
  const request = row.request;
  if (request?.state === 'waiting') return <RequestCard row={row} request={request} view={view} t={t} onAnswer={onAnswer} />;
  const input = row.input;
  const kind = verb(input);
  const summary = resultSummary(row.output);
  const subs: ReactNode[] = [];
  if (input?.kind === 'edit') subs.push(<Counts key="counts" added={input.added} removed={input.removed} />);
  // A command that went well says nothing more; a count or a failure does.
  if (summary && summary.key !== 'done') {
    const text = summary.key === 'passed' || summary.key === 'failed' ? t(summary.key === 'passed' ? 'result_count_ok' : 'result_failed', { n: summary.n ?? 0 }) : t(`result_${summary.key}`);
    subs.push(<span key="result" className={summary.tone === 'ok' ? 'ok' : 'bad'}>{text}</span>);
  }
  if (request) subs.push(<span key="decided" className="decided">{answerLine(request, view, t)}</span>);
  const label = input && input.kind !== 'think' && input.kind !== 'switch_mode' && input.kind !== 'other'
    ? t(`verb_${input.kind}`) : t(input?.kind === 'think' ? 'verb_think' : 'verb_other', { tool: row.name });
  const shown = target(input);
  const frameKind = kind === 'read' || kind === 'edit' ? kind : kind === 'execute' ? 'run' : 'tool';
  const refused = request?.decision === 'reject_once' || request?.decision === 'reject_always';
  const sub = subs.length ? <div className="sub">{subs.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]))}</div> : null;
  // A command says what it means to do; the command itself, and how it ended, in the detail.
  if (input?.kind === 'execute') {
    const output = row.output?.kind === 'execute' ? tail(row.output.output) : '';
    return (
      <Step kind={frameKind} at={row.at} icon={GLYPH[kind] ?? DotOutline} refused={refused} resume={resume}
        line={<><div>{intentSentence(input.command, t)}</div>{sub}</>}
        detail={<><CommandLines command={input.command} />{output ? <pre className="output"><code>{output}</code></pre> : null}</>} />
    );
  }
  const line = <><div>{label}{shown ? <>{' '}<Code text={shown} /></> : null}</div>{sub}</>;
  if (input?.kind === 'edit') {
    return (
      <Step kind={frameKind} at={row.at} icon={GLYPH[kind] ?? DotOutline} refused={refused} line={line} resume={resume}
        detail={<FileDetail path={input.path} added={input.added} removed={input.removed} count={1} t={t} onFile={onFile} />} />
    );
  }
  if (!shown) return <Frame kind={frameKind} at={row.at} icon={GLYPH[kind] ?? DotOutline} refused={refused}>{line}</Frame>;
  return <Step kind={frameKind} at={row.at} icon={GLYPH[kind] ?? DotOutline} refused={refused} line={line} resume={resume} detail={<pre className="command"><code>{shown}</code></pre>} />;
}

type OpenFile = (path: string, mode: 'diff' | 'file') => void;

function FileDetail({ path, added, removed, count, t, onFile }: { readonly path: string; readonly added: number; readonly removed: number; readonly count: number; readonly t: Translate; readonly onFile?: OpenFile | undefined }) {
  return (
    <p className="file-detail">
      <span className="path">{path}</span>
      <span className="counts"><Counts added={added} removed={removed} />{count > 1 ? ` · ${t('edits_count', { n: count })}` : null}</span>
      {onFile ? <button type="button" className="link-button" data-act="open_diff" onClick={() => onFile(path, 'diff')}>{t('step_show_diff')}</button> : null}
    </p>
  );
}

function EditsLine({ row, t, onFile, resume }: { readonly row: EditsRow; readonly t: Translate; readonly onFile?: OpenFile | undefined; readonly resume?: ReactNode }) {
  return (
    <Step kind="edit" at={row.at} icon={PencilSimple} resume={resume}
      line={<><div>{t('verb_edit')} <Code text={row.path} /></div><div className="sub"><Counts added={row.added} removed={row.removed} />{` · ${t('edits_count', { n: row.count })}`}</div></>}
      detail={<FileDetail path={row.path} added={row.added} removed={row.removed} count={row.count} t={t} onFile={onFile} />} />
  );
}

function ReadLine({ row, t, onFile, resume }: { readonly row: ReadRow; readonly t: Translate; readonly onFile?: OpenFile | undefined; readonly resume?: ReactNode }) {
  const [first = '', ...others] = row.paths;
  return (
    <Step kind="read" at={row.at} icon={Eye} resume={resume}
      line={<div>{t('verb_read')} <Code text={first} />{others.length > 0 ? ` ${t(others.length === 1 ? 'and_more_one' : 'and_more_other', { n: others.length })}` : null}</div>}
      detail={(
        <ul className="read-paths">
          {row.paths.map((path, index) => (
            <li key={`${path}:${index}`}>
              {onFile ? <button type="button" className="link-button path" data-act="open_file" onClick={() => onFile(path, 'file')}>{path}</button> : <span className="path">{path}</span>}
            </li>
          ))}
        </ul>
      )} />
  );
}

// A permission's answer, and the session it is asked of.
type Answer = (requestId: string, kind: string, session: string) => void;
// A question's answer: the answers keyed by question text, and the labels picked.
type QuestionAnswer = (requestId: string, answers: Answers, chosen: readonly string[], session: string) => void;

// A question of the session, answered here through the session answer
// route: the questions the interrupt carries while it waits, else the row's.
function QuestionView({ row, view, t, onQuestion }: { readonly row: QuestionRow; readonly view: SessionView; readonly t: Translate; readonly onQuestion?: QuestionAnswer }) {
  const status = questionStatus(row, view, t);
  const questions = view.thread.interrupts.find((i) => i.id === row.requestId)?.metadata.questions ?? row.questions;
  return (
    <div className={status.kind === 'waiting' ? 'request question waits' : 'request question'} data-row="question" data-request-id={row.requestId}>
      {status.kind === 'waiting'
        ? <OwnChoices questions={questions} t={t} requestId={row.requestId} busy={status.busy ?? false} onAnswer={(answers, chosen) => onQuestion?.(row.requestId, answers, chosen, view.summary.id)} />
        : <Choices questions={questions} status={status} t={t} requestId={row.requestId} />}
    </div>
  );
}

// Resume from here (issue #272): what the service answered.
export type ResumeOutcome = 'resumed' | 'owner' | 'failed';
// Resume from here on a step: the session, the step's first event, the corrected instruction.
type Resume = (session: string, seq: number, message: string) => Promise<ResumeOutcome>;

// Resume from here, under a step's detail: the button opens the corrected
// instruction, which says where the branch goes back to and that what
// follows stays readable.
export function ResumeFrom({ session, seq, commit, t, onResume }: { readonly session: string; readonly seq: number; readonly commit: string; readonly t: Translate; readonly onResume?: Resume }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const id = `resume-${session.replace(/[^\w-]/g, '')}-${seq}`;
  if (!open) {
    return (
      <button type="button" className="link-button resume-open" data-act="resume_open" data-seq={seq} onClick={() => { setOpen(true); setNote(''); }}>
        <ArrowCounterClockwise size={14} aria-hidden="true" />{t('resume_here')}
      </button>
    );
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) { setNote(t('resume_empty')); return; }
    setBusy(true);
    const outcome = await (onResume?.(session, seq, message) ?? Promise.resolve<ResumeOutcome>('failed'));
    setBusy(false);
    if (outcome === 'resumed') { setOpen(false); setText(''); setNote(''); }
    else setNote(t(outcome === 'owner' ? 'resume_owner' : 'resume_failed'));
  };
  return (
    <form className="resume-form" data-seq={seq} onSubmit={(event) => void submit(event)}>
      <label htmlFor={id} className="small">{t('resume_label')}</label>
      <p className="faint small">{t('resume_where', { commit: shortCommit(commit) })}</p>
      <Textarea id={id} maxLength={REPLAY_MAX} rows={3} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
      <div className="plan-actions">
        <Button variant="ink" className="btn primary" type="submit" data-act="resume_send" disabled={busy}>{t('resume_send')}</Button>
        <Button className="btn" data-act="resume_cancel" disabled={busy} onClick={() => { setOpen(false); setNote(''); }}>{t('resume_cancel')}</Button>
      </div>
      <p className="plan-note" role="status">{note}</p>
    </form>
  );
}

// Where a resumed ticket went on, or came from: the branch, the commit, and the instruction, folded.
function ReplayLine({ row, view, t }: { readonly row: ReplayRow; readonly view: SessionView; readonly t: Translate }) {
  const values = { who: who(row.by, view, t), branch: row.branch, commit: shortCommit(row.commit) };
  return (
    <Step kind="replay" at={row.at} icon={ArrowCounterClockwise}
      line={<div>{t(row.side === 'left' ? 'replay_left' : 'replay_resumed', values)}</div>}
      detail={<><p className="small">{t('replay_instruction')}</p><div className="prose">{row.message}</div></>} />
  );
}

function RowView({ row, view, t, onAnswer, onQuestion, onFile, resume }: {
  readonly row: Row; readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer; readonly onQuestion?: QuestionAnswer; readonly onFile?: OpenFile | undefined;
  readonly resume?: ReactNode;
}) {
  switch (row.kind) {
    case 'read':
      return <ReadLine row={row} t={t} onFile={onFile} resume={resume} />;
    case 'edits':
      return <EditsLine row={row} t={t} onFile={onFile} resume={resume} />;
    case 'tool':
      return <ToolLine row={row} view={view} t={t} onAnswer={onAnswer} onFile={onFile} resume={resume} />;
    // The session's prose is a row of the worklog, flat (lane 36's art
    // director); the person's own message keeps a quiet bubble.
    case 'message':
      return row.role === 'assistant'
        ? <Frame kind="message" at={row.at} icon={ChatText}><div className="prose">{row.text}</div></Frame>
        : <div className={`bubble ${row.role}`} data-row="message">{row.text}</div>;
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
    case 'channel':
      return (
        <Step kind="channel" at={row.at} icon={ArrowRight} resume={resume}
          line={<div>{t(row.from === 'reviewer' ? 'channel_request' : 'channel_answer', { round: row.round, limit: row.limit })}{row.afterMs === undefined ? null : <span className="sub">{` · ${t('channel_after', { time: duration(row.afterMs, t) })}`}</span>}</div>}
          detail={<div className="prose">{row.text}</div>} />
      );
    case 'plan':
      return <Frame kind="plan" at={row.at} icon={row.go ? Check : ListChecks}><div>{row.go ? goLine(row, view.me, t) : t(`row_plan_${row.confidence}`)}</div></Frame>;
    case 'replay':
      return <ReplayLine row={row} view={view} t={t} />;
  }
}

export function HandoverRow({ handover, t }: { readonly handover: Handover; readonly t: Translate }) {
  return <p className="handover" data-row="handover" data-session={handover.session} data-role={handover.role}><span>{handoverLine(handover, t)}</span></p>;
}

// The thread of the ticket: each session's rows under its own view (its
// requests answer it, its questions wait in it), a handover row between.
export function Timeline({ view, t, onAnswer, onQuestion, onFile, onResume }: {
  readonly view: SessionView; readonly t: Translate; readonly onAnswer?: Answer; readonly onQuestion?: QuestionAnswer; readonly onFile?: OpenFile; readonly onResume?: Resume;
}) {
  const parts = partsOf(view);
  const filter = view.filter ?? 'all';
  const entries = ticketThread(parts, filter);
  const views = new Map(parts.map((part) => [part.summary.id, part.summary.id === view.summary.id ? view : { ...view, summary: part.summary, thread: part.thread ?? emptyThread(part) }]));
  if (entries.length === 0) return <Empty block icon={ChatText} text={t('timeline_empty')} />;
  const row = (entry: Extract<ThreadEntry, { kind: 'row' }>, index: number) => {
    const key = 'id' in entry.row ? `${entry.session}:${entry.row.kind}:${entry.row.id}` : `${entry.session}:${entry.row.kind}:${entry.row.at}:${index}`;
    // Each step of an author's thread resumes from the commit it began from,
    // once the flow journaled its branch; not a step of the continuation a
    // resume left, which the ticket's branch no longer holds.
    const own = views.get(entry.session) ?? view;
    const left = own.thread.rows.reduce((first, r) => (r.kind === 'replay' && r.side === 'left' ? Math.min(first, r.step) : first), Infinity);
    const commit = own.summary.role === 'author' && entry.row.seq !== undefined && entry.row.seq < left ? stepCommit(own.thread.checkpoints ?? [], entry.row.seq) : undefined;
    const resume = commit && entry.row.seq !== undefined ? <ResumeFrom session={entry.session} seq={entry.row.seq} commit={commit.commit} t={t} onResume={onResume} /> : undefined;
    return <RowView key={key} row={entry.row} view={own} t={t} onAnswer={onAnswer} onQuestion={onQuestion} onFile={onFile} resume={resume} />;
  };
  // The whole ticket: an ended session a later one followed is folded into
  // one row (who, how many steps), unless the view saw it live.
  const last = [...parts].sort((a, b) => Date.parse(a.summary.startedAt) - Date.parse(b.summary.startedAt)).at(-1)?.summary.id;
  const folded = (session: string) => {
    const summary = parts.find((p) => p.summary.id === session)?.summary;
    return filter === 'all' && session !== last && summary !== undefined && !isLive(summary) && !view.unfolded?.has(session);
  };
  const out: ReactNode[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as ThreadEntry;
    if (entry.kind === 'handover') { out.push(<HandoverRow key={`handover:${entry.session}`} handover={entry} t={t} />); continue; }
    if (!folded(entry.session)) { out.push(row(entry, index)); continue; }
    const start = index;
    const rows: ReactNode[] = [];
    while (index < entries.length && entries[index]?.kind === 'row' && (entries[index] as { session: string }).session === entry.session) { rows.push(row(entries[index] as Extract<ThreadEntry, { kind: 'row' }>, index)); index++; }
    index--;
    const summary = parts.find((p) => p.summary.id === entry.session)?.summary;
    const who = summary && (summary.role === 'author' || summary.role === 'reviewer') ? t(`tab_${summary.role}`, { model: family(summary.model) }) : '';
    out.push(
      <details key={`earlier:${entry.session}:${start}`} className="earlier" data-session={entry.session}>
        <summary><CaretRight className="caret" size={12} aria-hidden="true" /><span>{t(rows.length === 1 ? 'earlier_one' : 'earlier_other', { who, n: rows.length })}</span></summary>
        {rows}
      </details>,
    );
  }
  return <>{out}</>;
}

const emptyThread = (part: TicketPart): SessionThread => ({ lastSeq: 0, lastAt: undefined, state: undefined, rows: [], turns: [], pending: [], interrupts: [], steps: [], plan: null, checkpoints: [], ...(part.thread ?? {}) });

// Author and Reviewer filter the ticket's thread (lane 36): the whole
// ticket, or one role's rows, once the ticket has two sessions.
export function ThreadFilter({ view, t, onFilter }: { readonly view: SessionView; readonly t: Translate; readonly onFilter?: (filter: Filter) => void }) {
  const filter = view.filter ?? 'all';
  // One session: nothing to filter yet.
  if (view.siblings.filter((s) => s.role === 'author' || s.role === 'reviewer').length < 2) return null;
  return (
    <div className="thread-filter" role="group" aria-label={t('filter_label')}>
      {filterOptions(view.siblings, t).map((option) => (
        <button key={option.filter} type="button" className="filter" data-filter={option.filter} aria-pressed={filter === option.filter} disabled={option.disabled}
          onClick={() => onFilter?.(option.filter)}>{option.label}</button>
      ))}
    </div>
  );
}

// The screen's one heading: the ticket's number and title, read out; the top bar draws them (lane 38).
export function SessionHeading({ view }: { readonly view: SessionView }) {
  return <h1 className="sr-only">{view.summary.ticket} · {view.ticket?.title ?? view.summary.ticket}</h1>;
}

export function LeftCards({ view, t, onPlan }: { readonly view: SessionView; readonly t: Translate; readonly onPlan?: () => void }) {
  const parsed = parseCriteria(view.ticket?.body ?? '');
  const plan = ticketPlan(partsOf(view)) ?? view.thread.plan;
  const service = serviceLine(view.summary.service, t, stepsView(view.steps, view.summary.id));
  // A card with nothing to say is not drawn (lane 34's art director): the ticket card says it all.
  return (
    <>
      <section className="card" aria-labelledby="ticket-title">
        <p className="eyebrow">{t('ticket_label')} <span className="id">{view.summary.ticket}</span>{service ? <> · <span className="service">{service}</span></> : null}</p>
        <h2 id="ticket-title" className="card-title">{view.ticket?.title ?? view.summary.ticket}</h2>
        {parsed.description.map((p, index) => <p key={index} className="desc">{p}</p>)}
      </section>
      {parsed.criteria.length > 0 ? (
        <section className="card" aria-labelledby="criteria-title">
          <h3 id="criteria-title" className="card-label">{t('criteria_title')}</h3>
          <Criteria view={view} t={t} />
        </section>
      ) : null}
      {plan ? (
        <section className="card" aria-labelledby="plan-title">
          <h3 id="plan-title" className="card-label">{t('plan_title')}</h3>
          <div className="plan-short">
            <p><Confidence plan={plan} t={t} /> <span className="faint small">{t('plan_steps_count', { n: plan.steps.length })}</span></p>
            <p className="small">{plan.go ? goLine(plan, view.me, t) : t('plan_waiting')}</p>
            {onPlan ? <button type="button" className="link-button small" onClick={onPlan}>{t('plan_tab_title')}</button> : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

// A check, said by its intent when its name is a command, the command folded under.
function CheckRow({ check, t }: { readonly check: { readonly name: string; readonly state: 'passed' | 'pending' | 'failed' }; readonly t: Translate }) {
  const head = (name: string) => <><span className={`light ${check.state}`} aria-hidden="true" /><span className="check-name">{name}</span><span className="state">{t(`check_${check.state}`)}</span></>;
  if (!looksLikeCommand(check.name)) return <li className="check">{head(check.name)}</li>;
  return (
    <li className="check">
      <details>
        <summary>{head(intentSentence(check.name, t))}<CaretRight className="caret" size={11} aria-hidden="true" /></summary>
        <CommandLines command={check.name} />
      </details>
    </li>
  );
}

export function RightCards({ view, t, onFile }: { readonly view: SessionView; readonly t: Translate; readonly onFile?: OpenFile }) {
  const parts = partsOf(view);
  const files = ticketFiles(parts);
  const checks = ticketChecks(parts);
  const steps = ticketSteps(parts, view.now.getTime());
  return (
    <>
      <section className="card" aria-labelledby="changes-title">
        <h3 id="changes-title" className="card-label">{t('changes_title')}</h3>
        {files.length === 0 ? <p className="faint small">{t('changes_none')}</p>
          : <ul className="changes">{files.map((f) => (
            <li key={f.path}>
              {onFile ? <button type="button" className="link-button path" data-act="open_change" onClick={() => onFile(f.path, 'diff')}>{f.path}</button> : <span className="path">{f.path}</span>}
              <span><Counts added={f.added} removed={f.removed} /></span>
            </li>
          ))}</ul>}
      </section>
      <section className="card" aria-labelledby="checks-title">
        <h3 id="checks-title" className="card-label">{t('checks_title')}</h3>
        {checks.length === 0 ? <p className="faint small">{t('checks_none')}</p>
          : <ul className="checks">{checks.map((c) => <CheckRow key={c.name} check={c} t={t} />)}</ul>}
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
      <section className="card" aria-labelledby="screen-title"><h3 id="screen-title" className="card-label">{t('screen_title')}</h3><p className="faint small">{t('screen_empty')}</p></section>
    </>
  );
}

export function Composer({ view, t, text = '', sending = false, interrupting = false, note = '', input, onText, onSend, onInterrupt, onHandover }: {
  readonly view: SessionView; readonly t: Translate; readonly text?: string; readonly sending?: boolean; readonly interrupting?: boolean; readonly note?: string;
  readonly input?: Ref<HTMLInputElement>;
  readonly onText?: (value: string) => void; readonly onSend?: (event: FormEvent<HTMLFormElement>) => void; readonly onInterrupt?: () => void; readonly onHandover?: () => void;
}) {
  // A session taken over is written to by nobody until it is given back.
  const off = ENDED.has(phaseOf(view)) || takenOverOf(view) !== null;
  const role = view.summary.role === 'reviewer' ? 'reviewer' : 'author';
  const placeholder = takenOverOf(view) !== null && !ENDED.has(phaseOf(view)) ? t('composer_taken_over') : t(`composer_${role}`);
  return (
    <>
      <form className="composer" id="composer" autoComplete="off" onSubmit={onSend}>
        <Input id="message" name="text" ref={input} placeholder={placeholder} aria-label={placeholder} disabled={off} value={text} onChange={(event) => onText?.(event.target.value)} />
        <Button className="btn" id="handover" aria-disabled="true" aria-describedby="handover-note" title={t('handover_note')} onClick={onHandover}>{t('handover')}</Button>
        <Button className="btn" id="interrupt" disabled={off || interrupting} onClick={onInterrupt}><Stop size={16} aria-hidden="true" /><span className="btn-label">{t('interrupt')}</span></Button>
        {/* Send waits for a message (lane 38, the critique): one ink button at a time, the screen's own gesture first. */}
        <Button variant="ink" className="btn primary" id="send" type="submit" disabled={off || sending || text.trim() === ''}>{t('send')}</Button>
      </form>
      <span className="sr-only" id="handover-note">{t('handover_note')}</span>
      <p className="composer-note" id="composer-note" role="status">{note}</p>
    </>
  );
}

export function SessionIndex({ sessions, tickets, now, t, onNew }: { readonly sessions: readonly SessionSummary[]; readonly tickets: readonly Ticket[]; readonly now: Date; readonly t: Translate; readonly onNew?: () => void }) {
  const titles = new Map(tickets.map((ticket) => [ticket.id, ticket.title]));
  // One row per ticket (lane 36): the session its view acts on; a reader's or the lead's alone.
  const tickets_ = new Set(sessions.filter((s) => s.role === 'author' || s.role === 'reviewer').map((s) => s.ticket));
  const shown = [
    ...sessions.filter((s) => s.role !== 'author' && s.role !== 'reviewer'),
    ...[...tickets_].flatMap((ticket) => { const own = ticketSessions(sessions, ticket); const acting = actingSession(own, own.at(-1)?.id ?? ''); return acting ? [acting] : []; }),
  ];
  // What waits for the person first, as the tower orders it (lane 38, the critique), then the most recent.
  const waits = (s: SessionSummary) => (s.phase === 'waiting_human' ? 0 : 1);
  const ordered = shown.sort((a, b) => waits(a) - waits(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  // Rows as the tower's (lane 38): the row is the link, named by the title and described by the rest.
  return (
    <div className="index">
      {/* The top bar names the screen (lane 38's art director): its heading is read out, not drawn twice. */}
      <h1 className="sr-only">{t('index_title')}</h1>
      {ordered.length === 0 ? <Empty block icon={Terminal} text={t('index_empty')} note={t('index_empty_note')} action={{ label: t('index_new_ticket'), onClick: () => onNew?.() }} /> : (
        <ul className="sessions">
          {ordered.map((s) => {
            // A reader's session (decision 28) is its question's: the ask
            // screen shows it, and its ticket is the ask's id.
            const reader = s.role === 'reader';
            const id = `index-${s.id.replace(/[^\w-]/g, '')}`;
            return (
            <li key={s.id} className="session-card" data-phase={s.phase}>
              <a className="open index-row" href={reader ? askHref(s.ticket) : `/sessions/${s.id}`} data-row aria-labelledby={`${id}-title`} aria-describedby={`${id}-kind ${id}-phrase ${id}-meta`}>
                <span className="index-kind session-head" id={`${id}-kind`}><span className={liveDot(s.phase, s.role)} aria-hidden="true" /><span className="role">{t(`role_${s.role}`)}</span></span>
                <span className="index-main">
                  <span className="session-title" id={`${id}-title`}>{reader ? t('reader_title') : titles.get(s.ticket) ?? s.ticket}</span>
                  <span className="phrase" id={`${id}-phrase`}>{sessionStatus(s, t)}</span>
                </span>
                <span className="index-meta session-foot" id={`${id}-meta`}>
                  <span className="model"><span className={`sq ${harnessSquare(s.harness)}`} aria-hidden="true" />{formatModel(s.harness, s.model)}</span>
                  {reader ? null : <span className="id">{s.ticket}</span>}
                  <span className="elapsed">{since(s.startedAt, now, t)}</span>
                </span>
              </a>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const TICK_MS = 20_000;

function useEvery(ms: number, run: () => void, on = true): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [ms, on]);
}

// Whether the view is shown: a kept session hidden by the shell
// (lib/stack.tsx, display: none) has no box. Shown where nothing measures.
function useShown(ref: { readonly current: Element | null }): boolean {
  const [shown, setShown] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setShown(element.getClientRects().length > 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return shown;
}

function Index() {
  const { t, api, now } = useScreen();
  const go = useGo();
  // New ticket: the tower's bar, its field focused once the tower is drawn.
  const newTicket = useCallback(() => {
    go('/');
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('ask-input')?.focus()));
  }, [go]);
  const [data, setData] = useKept<{ sessions: SessionSummary[]; tickets: Ticket[] } | 'failed' | null>('sessions', null);
  const refresh = useCallback(async () => {
    try {
      const [sessions, tickets] = await Promise.all([api<SessionSummary[]>('/sessions'), api<Ticket[]>('/tickets')]);
      setData({ sessions, tickets });
    } catch {
      setData('failed');
    }
  }, [api, setData]);
  // Drawn from the cache, then again each time a resource it read changes.
  useEffect(() => { void refresh(); }, [refresh]);
  useLive(() => void refresh());
  if (data === null) return null;
  if (data === 'failed') return <div className="index"><p className="empty error">{t('load_failed')}</p></div>;
  return <SessionIndex sessions={data.sessions} tickets={data.tickets} now={now()} t={t} onNew={newTicket} />;
}

type Loaded = {
  readonly detail: SessionDetail; readonly ticket: Ticket | undefined; readonly sessions: readonly SessionSummary[];
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

// The first session of the list whose checkout has the file: the ticket's
// live session reads the ticket's branch; an ended author's may be gone.
async function readFrom(ids: readonly string[], path: string, base: boolean): Promise<SessionFile | null | { readonly refused: string }> {
  let failed: unknown;
  for (const id of ids) {
    try {
      const found = await readFile(id, path, base);
      if (found) return found;
    } catch (error) { failed = error; }
  }
  if (failed) throw failed;
  return null;
}

// A session of the ticket, followed by its own agent in the background:
// its thread goes up to the view. Its stream is open only when `open`.
function Feed({ summary, detail, open, onThread }: {
  readonly summary: SessionSummary; readonly detail: SessionDetail | undefined; readonly open: boolean;
  readonly onThread: (id: string, thread: SessionThread | undefined) => void;
}) {
  const id = summary.id;
  const agent = useMemo(() => new SessionAgent({
    sessionId: id, state: detail?.state,
    open: (url) => new EventSource(url) as unknown as StreamLike,
    later: (run, ms) => { setTimeout(run, ms); },
    streaming: open,
  }), [id]);     // made once per session: the state and the openness given are only the first
  const agents = useMemo(() => ({ [sessionAgentId(id)]: agent }), [id, agent]);
  useEffect(() => { agent.setOpen(open); }, [agent, open]);
  return <CopilotThreads agents={agents}><FeedReader id={id} onThread={onThread} /></CopilotThreads>;
}

function FeedReader({ id, onThread }: { readonly id: string; readonly onThread: (id: string, thread: SessionThread | undefined) => void }) {
  const { state } = useThread<SessionThread>(sessionAgentId(id), isSessionThread);
  useEffect(() => { onThread(id, state); }, [id, state, onThread]);
  return null;
}

function Live({ view: viewId, loaded }: { readonly view: string; readonly loaded: Loaded }) {
  const context = useScreen();
  const { t } = context;
  const root = useRef<HTMLDivElement | null>(null);
  const shown = useShown(root);
  const ticketId = loaded.detail.ticket;
  const [sessions, setSessions] = useState<readonly SessionSummary[]>(() => viewSessions(loaded.sessions, loaded.detail));
  const [details, setDetails] = useState<ReadonlyMap<string, SessionDetail>>(() => new Map([[loaded.detail.id, loaded.detail]]));
  const [threads, setThreads] = useState<ReadonlyMap<string, SessionThread>>(new Map());
  const [now, setNow] = useState(() => context.now());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<ReadonlyMap<string, LocalAnswer>>(new Map());
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [note, setNote] = useState('');
  const [tab, setTab] = useState<Tab>(() => tabOf(window.location.hash));
  const [filter, setFilter] = useState<Filter>('all');
  const [taken, setTaken] = useState<{ readonly id: string; readonly by: TakenOver | null } | null>(null);   // what a gesture of this tab knows, newer than the list
  const [editor, setEditor] = useState<EditorLinks | null>(null);    // the links that open the checkout in an editor (flow/editor.ts)
  const [editorOpen, setEditorOpen] = useState(false);
  const [gesture, setGesture] = useState(false);              // a take over, a give back, a Go or a Change on its way
  const [changing, setChanging] = useState(false);
  const [change, setChange] = useState('');
  const [planNote, setPlanNote] = useState('');
  const [files, setFiles] = useState<SessionFiles['files'] | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [shownFile, setShownFile] = useState<EditorShown | undefined>(undefined);
  const [fileFailed, setFileFailed] = useState(false);
  const [mode, setMode] = useState<'diff' | 'file'>('diff');
  const [steps, setSteps] = useState<readonly TicketStep[] | null>(null);
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [generation, setGeneration] = useState(0);
  const [editable, setEditable] = useState<{ readonly file: SessionFile; readonly why: ReadOnlyWhy | undefined } | null>(null);
  const [said, setSaid] = useState('');
  const editingNow = useRef(editing);
  editingNow.current = editing;
  const timeline = useRef<HTMLDivElement | null>(null);
  const message = useRef<HTMLInputElement | null>(null);
  const atEnd = useRef(true);
  const missed = useRef(false);                                // something changed while the view was hidden

  const acting = actingSession(sessions, viewId) ?? loaded.detail;
  const id = acting.id;
  const actingTaken = taken?.id === id ? taken.by : acting.takenOver ?? null;

  // The ticket's sessions, and its steps across services (lane 23's route):
  // read from the cache when a resource changes, never while hidden.
  const gestureNow = useRef(gesture);
  gestureNow.current = gesture;
  const readSteps = useCallback(async () => {
    try {
      const answer = await context.api<unknown>(`/tickets/${encodeURIComponent(ticketId)}/steps`);
      setSteps(Array.isArray(answer) ? answer as TicketStep[] : null);
    }
    catch { /* the next change tries again */ }
  }, [context, ticketId]);
  const refresh = useCallback(async () => {
    void readSteps();
    try {
      const all = await context.api<SessionSummary[]>('/sessions');
      setSessions((before) => {
        const next = viewSessions(all, loaded.detail);
        return next.length === before.length && next.every((s, index) => s === before[index]) ? before : next;
      });
      setTaken((local) => (local && !gestureNow.current ? null : local));
    } catch { /* the next change tries again */ }
  }, [context, loaded.detail, readSteps]);
  useEffect(() => { void readSteps(); }, [readSteps]);
  useLive(() => {
    if (shown) void refresh();
    else missed.current = true;
  });
  useEffect(() => {
    if (!shown || !missed.current) return;
    missed.current = false;
    void refresh();
  }, [shown, refresh]);
  useEvery(TICK_MS, () => setNow(context.now()), shown);

  // Each session's detail (its first state, its preview), from the cache.
  useEffect(() => {
    let live = true;
    for (const s of sessions) {
      if (details.has(s.id)) continue;
      void context.api<SessionDetail>(`/sessions/${encodeURIComponent(s.id)}`).then((detail) => {
        if (live) setDetails((before) => new Map([...before, [s.id, detail]]));
      }, () => {});
    }
    return () => { live = false; };
  }, [context, sessions, details]);

  // A session that joins while the view is shown is said, as the handover row says it.
  const known = useRef(new Set(sessions.map((s) => s.id)));
  useEffect(() => {
    const fresh = sessions.filter((s) => !known.current.has(s.id));
    for (const s of sessions) known.current.add(s.id);
    const last = fresh.at(-1);
    if (!last || !shown) return;
    const before = sessions[sessions.indexOf(last) - 1];
    if (before && (last.role === 'author' || last.role === 'reviewer') && (before.role === 'author' || before.role === 'reviewer')) {
      setSaid(handoverLine({ kind: 'handover', session: last.id, at: last.startedAt, role: last.role, model: family(last.model), after: before.role }, t));
    }
  }, [sessions, shown, t]);

  // The sessions of the ticket are drawn by this view: a link to any of
  // them shows it, and the address follows the live one (lib/routes.ts).
  useEffect(() => {
    for (const s of sessions) keepWith(s.id, viewId);
  }, [sessions, viewId]);
  useEffect(() => () => forgetView(viewId), [viewId]);
  useEffect(() => {
    if (!shown) return;
    const named = decodeURIComponent(window.location.pathname.split('/')[2] ?? '');
    if (named !== viewId && !sessions.some((s) => s.id === named)) return;
    // Shown again after a move of the router: the tab goes back in the address (review of 248, F5).
    const hash = `#${tab}`;
    const next = isLive(acting) && named !== acting.id && viewOf(acting.id) === viewId ? `/sessions/${encodeURIComponent(acting.id)}` : window.location.pathname;
    if (next !== window.location.pathname || (window.location.hash !== hash && (window.location.hash !== '' || tab !== 'terminal'))) {
      window.history.replaceState(window.history.state, '', `${next}${window.location.hash === '' && tab === 'terminal' ? '' : hash}`);
    }
  }, [shown, acting, sessions, viewId, tab]);

  const onThread = useCallback((session: string, thread: SessionThread | undefined) => {
    if (!thread) return;
    setThreads((before) => (before.get(session) === thread ? before : new Map([...before, [session, thread]])));
  }, []);

  // The sessions this view saw live stay unfolded once they end: nothing folds under the person's eyes.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set(viewSessions(loaded.sessions, loaded.detail).filter(isLive).map((s) => s.id)));
  useEffect(() => {
    const live = sessions.filter((s) => isLive(s) && !unfolded.has(s.id));
    if (live.length > 0) setUnfolded((before) => new Set([...before, ...live.map((s) => s.id)]));
  }, [sessions, unfolded]);
  const parts: TicketPart[] = useMemo(() => sessions.map((summary) => ({ summary, thread: threads.get(summary.id) })), [sessions, threads]);
  const actingThread = threads.get(id);
  const actingDetail = details.get(id);
  const view: SessionView = useMemo(() => ({
    summary: acting, ticket: loaded.ticket, siblings: sessions, me: context.me.user.id, language: context.me.language, now, busy, answers, takenOver: actingTaken, steps,
    thread: actingThread ?? { lastSeq: 0, lastAt: undefined, state: actingDetail?.state, rows: [], turns: [], pending: [], interrupts: [], steps: [], plan: null, checkpoints: [] },
    parts, filter, unfolded,
  }), [acting, loaded.ticket, sessions, context.me, now, busy, answers, actingTaken, steps, actingThread, actingDetail, parts, filter, unfolded]);
  const ended = ENDED.has(phaseOf(view));
  // Asked again when the session changes or ends; 403, 409 and the rest: no button.
  useEffect(() => {
    let current = true;
    setEditor(null);
    setEditorOpen(false);
    context.api<unknown>(`/sessions/${encodeURIComponent(id)}/editor`).then((answer) => { if (current) setEditor(editorOffer(answer)); }, () => {});
    return () => { current = false; };
  }, [context, id, ended]);
  const takeover = takeoverOf({ takenOver: actingTaken, me: view.me, role: acting.role, ended });
  const terminal = terminalChoice({ offered: context.me.terminal, takeover });
  // An author's live session, not another account's: the service checks the rest at the save.
  const sessionOpen = acting.role === 'author' && !ended && takeover.kind !== 'other';

  // The thread follows the newest row while the person is at its end.
  const onScroll = () => {
    const el = timeline.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = timeline.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [parts, tab, filter]);

  // The tab is in the address, so a reload keeps it.
  const select = (next: Tab, focus = false) => {
    setTab(next);
    window.history.replaceState(window.history.state, '', `#${next}`);
    if (focus) document.getElementById(`tab-${next}-button`)?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    select(nextTab(tab, event.key), true);
  };

  // The Editor holds the ticket's diff: the files every author of the
  // ticket changed (the newest's counts), read from the live session's
  // checkout first, which is the ticket's branch, then the authors'.
  const authors = useMemo(() => sessions.filter((s) => s.role === 'author').map((s) => s.id).reverse(), [sessions]);
  const readers = useMemo(() => [...new Set([id, ...authors])], [id, authors]);
  const changed = ticketFiles(parts).map((f) => `${f.path}:${f.added}:${f.removed}`).join('|');
  useEffect(() => {
    if (tab !== 'editor' || !shown) return;
    let live = true;
    void Promise.all(authors.map((author) => context.api<SessionFiles>(`/sessions/${encodeURIComponent(author)}/files`).then((answer) => answer.files, () => null))).then((lists) => {
      if (!live) return;
      const merged = new Map<string, SessionFiles['files'][number]>();
      for (const list of [...lists].reverse()) for (const file of list ?? []) merged.set(file.path, file);
      const all = [...merged.values()];
      setFiles(all);
      setSelected((current) => current ?? all[0]?.path);
    });
    return () => { live = false; };
  }, [context, authors, tab, changed, shown]);
  const lastTurn = useMemo(() => lastTurnFiles(editsOf(parts), parts.flatMap((p) => p.thread?.turns ?? [])), [parts]);
  const scoped = useMemo(() => {
    if (!files || scope === 'all') return files ?? [];
    return files.flatMap((file) => {
      const last = lastTurn.find((edit) => edit.path === file.path || edit.path.endsWith(`/${file.path}`));
      return last ? [{ path: file.path, added: last.added, removed: last.removed }] : [];
    });
  }, [files, scope, lastTurn]);
  useEffect(() => {
    if (tab !== 'editor' || selected === undefined || !shown) return;
    let live = true;
    // Another file waits for its text; the same file read again (the session
    // changed it, or the reviewer took over) stays on screen until it comes.
    setShownFile((was) => (was?.file?.path === selected ? was : undefined));
    setFileFailed(false);
    void Promise.all([readFrom(readers, selected, false), readFrom(readers, selected, true)]).then(([file, base]) => {
      if (!live) return;
      if (file && 'refused' in file) return setShownFile({ file: null, base: null, error: file.refused });
      setShownFile((was) => (was?.file && file && was.file.hash === file.hash && was.base?.hash === (base && !('refused' in base) ? base.hash : undefined) ? was
        : { file, base: base && !('refused' in base) ? base : null }));
    }, () => { if (live) setFileFailed(true); });
    return () => { live = false; };
  }, [readers, tab, selected, changed, shown]);
  const openFile: OpenFile = (path, how) => {
    setEditing(null);
    setScope('all');
    setSelected(path);
    setMode(how);
    select('editor');
  };

  // The Editor's editing (decision 33): a file opens only when its text on
  // screen is the file (components/editor/model.ts); the editor's own text
  // stays until it is saved, put back or reloaded.
  const fileNow = shownFile?.file ?? null;
  useEffect(() => {
    if (!fileNow) return;
    let live = true;
    void readOnlyWhy(fileNow, { sessionOpen }).then((why) => { if (live) setEditable({ file: fileNow, why }); });
    return () => { live = false; };
  }, [fileNow, sessionOpen]);
  const editWhy: ReadOnlyWhy = editable?.file === fileNow ? editable.why ?? 'session' : 'session';
  const canEdit = editable?.file === fileNow && editable?.why === undefined;
  const stale = editing !== null && fileNow !== null && fileNow.path === editing.doc.path && fileNow.hash !== editing.doc.hash && editing.status !== 'saving';
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
        setShownFile((was) => (was?.file?.path === current.doc.path ? { ...was, file: { ...was.file, text: current.text, hash: outcome.hash, lines } } : was));
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
      setShownFile((was) => (was?.file?.path === file.path ? { ...was, file } : was));
      if (await readOnlyWhy(file, { sessionOpen })) return setEditing(null);
      startEditing(file);
    } catch {
      dispatch({ kind: 'failed' });
    }
  };

  const post = async (session: string, path: string, body: unknown, failure: string): Promise<boolean> => {
    try {
      await context.api(`/sessions/${encodeURIComponent(session)}${path}`, { method: 'POST', body });
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
    if (!typed) { message.current?.focus(); return; }
    // The composer empties at once; a refused message comes back to it,
    // before what was typed meanwhile.
    setSending(true);
    setText('');
    if (!(await post(id, '/messages', { text: typed }, 'send_failed'))) setText((current) => (current.trim() ? `${text} ${current}` : text));
    setSending(false);
    // This view's composer, not whichever view is shown now (review of 248, F-a).
    if (shown) message.current?.focus();
  };
  const interrupt = async () => {
    setInterrupting(true);
    await post(id, '/interrupt', null, 'interrupt_failed');
    setInterrupting(false);
  };
  const answer: Answer = async (requestId, kind, session) => {
    if (busy.has(requestId)) return;
    setBusy((current) => new Set([...current, requestId]));
    if (await post(session, `/requests/${encodeURIComponent(requestId)}/answer`, { decision: decisionOf(kind, t) }, 'answer_failed')) context.inboxChanged();
    else setBusy((current) => new Set([...current].filter((other) => other !== requestId)));
  };
  // A question's answer, with its own body: a permission's decisionOf would
  // read an option's label as a denial.
  const answerQuestion: QuestionAnswer = async (requestId, given, chosen, session) => {
    if (busy.has(requestId)) return;
    setBusy((current) => new Set([...current, requestId]));
    const remember = (local: LocalAnswer) => setAnswers((current) => new Map([...current, [requestId, local]]));
    try {
      await context.api(`/sessions/${encodeURIComponent(session)}/requests/${encodeURIComponent(requestId)}/answer`, { method: 'POST', body: answerBody(given) });
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

  // Take over and Give back (flow/takeover.ts), on the ticket's live session, whatever its role.
  const takeOver = async () => {
    setGesture(true);
    if (await post(id, '/takeover', null, 'takeover_failed')) {
      setTaken({ id, by: { by: view.me, at: context.now().toISOString() } });
      select('terminal');
      context.inboxChanged();
    }
    setGesture(false);
  };
  const giveBack = async () => {
    setGesture(true);
    if (await post(id, '/giveback', null, 'giveback_failed')) setTaken({ id, by: null });
    setGesture(false);
  };

  // Resume from here (flow/replay.ts): the ticket's new author joins this view, which follows it.
  const resumeFrom: Resume = async (session, seq, message) => {
    try {
      await context.api(`/sessions/${encodeURIComponent(session)}/replay`, { method: 'POST', body: { seq, message } });
      select('terminal');
      context.inboxChanged();
      return 'resumed';
    } catch (error) {
      return error instanceof ApiError && error.status === 403 ? 'owner' : 'failed';
    }
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

  // The trial environment: the live session's, else the newest author's that has one.
  const previewOf = [id, ...authors].find((s) => details.get(s)?.previewKey);
  const browser = browserView({ id: previewOf ?? id, previewKey: previewOf ? details.get(previewOf)?.previewKey : null, previewOrigin: document.body.dataset.preview, pageHost: window.location.hostname });
  const panel = (name: Tab) => ({ id: `tab-${name}`, role: 'tabpanel', 'aria-labelledby': `tab-${name}-button`, hidden: tab !== name });
  const open = (summary: SessionSummary) => shown && (isLive(summary) || (threads.get(summary.id)?.lastSeq ?? 0) < summary.lastSeq);

  return (
    <>
      {sessions.map((summary) => <Feed key={summary.id} summary={summary} detail={details.get(summary.id)} open={open(summary)} onThread={onThread} />)}
      <div className="session" ref={root} aria-busy={actingThread ? undefined : 'true'}>
        <SessionHeading view={view} />
        <aside className="s-left" id="s-left" aria-label={t('left_label')}><LeftCards view={view} t={t} onPlan={() => select('plan', true)} /></aside>
        <section className="panel" aria-label={t('timeline_label')}>
          <TabStrip tab={tab} t={t} onSelect={(next) => select(next)} onKey={onKey} />
          <div className="panel-head" id="status">
            <StatusHead view={view} t={t} />
            <div className="head-actions">
              <OpenInEditor t={t} offer={editor} expanded={editorOpen} onToggle={() => setEditorOpen((open) => !open)} />
              <TakeoverButton t={t} takeover={takeover} busy={gesture} onTakeover={() => void takeOver()} onGiveback={() => void giveBack()} />
            </div>
          </div>
          <div className="tab-panel" {...panel('terminal')}>
            {terminal.kind === 'web' ? (
              <div className="term-wrap">
                <TakeoverNotice view={view} t={t} web />
                <WebTerminal key={id} session={id} csrf={context.me.csrf} active={tab === 'terminal' && shown} t={t} harness={harnessName(acting.harness)} />
              </div>
            ) : (
              <>
                <ThreadFilter view={view} t={t} onFilter={setFilter} />
                <div className="timeline" id="timeline" tabIndex={0} ref={timeline} onScroll={onScroll}>
                  <TakeoverNotice view={view} t={t} why={terminal.kind === 'notice' ? terminal.why : undefined} />
                  <Timeline view={view} t={t} onFile={openFile} onResume={resumeFrom}
                    onAnswer={(requestId, kind, session) => void answer(requestId, kind, session)}
                    onQuestion={(requestId, given, chosen, session) => void answerQuestion(requestId, given, chosen, session)} />
                </div>
              </>
            )}
            <div className="panel-foot">
              <Composer view={view} t={t} text={text} sending={sending} interrupting={interrupting} note={note} input={message} onText={setText}
                onSend={(event) => void send(event)} onInterrupt={() => void interrupt()} onHandover={() => setNote(t('handover_note'))} />
            </div>
          </div>
          <div className="tab-panel scroll" {...panel('plan')}>
            <PlanTab view={view} plan={ticketPlan(parts) ?? view.thread.plan} t={t} changing={changing} change={change} busy={gesture} note={planNote}
              onGo={go} onChangeOpen={() => { setChanging(true); setPlanNote(''); }} onChangeText={setChange} onChangeSend={(event) => void sendChange(event)} onChangeCancel={() => { setChanging(false); setPlanNote(''); }} />
          </div>
          <div className="tab-panel scroll" {...panel('editor')}>
            {tab === 'editor' || files !== null ? (
              <EditorTab t={t} files={scoped} selected={selected} shown={shownFile} mode={mode} failed={fileFailed}
                scope={{ value: scope, all: files?.length ?? 0, last: lastTurn.length, onScope: setScope }}
                onSelect={(path) => { setEditing(null); setSelected(path); setMode('diff'); }} onMode={setMode}
                edit={{
                  can: canEdit, why: editWhy, state: editing ?? undefined, stale, taken: takeover.kind === 'mine', generation,
                  onEdit: () => { if (fileNow) startEditing(fileNow); },
                  onChange: (value) => dispatch({ kind: 'edit', text: value }),
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
        <aside className="s-right" id="s-right" aria-label={t('right_label')}><RightCards view={view} t={t} onFile={openFile} /></aside>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
    </>
  );
}

// The session named by the address: its detail, the ticket's sessions and
// the ticket first; then the view of the ticket, each session's agent
// following its stream.
function One({ id }: { readonly id: string }) {
  const context = useScreen();
  const [loaded, setLoaded] = useKept<Loaded | 'failed' | null>(`session:${id}`, null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [detail, all] = await Promise.all([context.api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`), context.api<SessionSummary[]>('/sessions')]);
        const ticket = await context.api<Ticket>(`/tickets/${encodeURIComponent(detail.ticket)}`).catch(() => undefined);
        if (live) setLoaded({ detail, ticket, sessions: all.some((s) => s.id === detail.id) ? all : [...all, detail] });
      } catch {
        if (live) setLoaded('failed');
      }
    })();
    return () => { live = false; };
  }, [context, id, setLoaded]);
  if (loaded === 'failed') return <div className="index"><p className="empty error">{context.t('load_failed')}</p></div>;
  if (!loaded) return <div className="session" aria-busy="true" />;
  return <Live view={id} loaded={loaded} />;
}

export default function Session() {
  const { path } = useScreen();
  const id = path.split('/')[2];
  return id ? <One id={id} /> : <Index />;
}
