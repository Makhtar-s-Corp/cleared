// The lead and plan screen (/lead, /plans/<id>) of lead-and-plan.png
// (milestone 2, section 7.2): on the left the lead's card, with its state
// line, what it remembers, the owner's thread and the reply field; on the
// right the plan panel (shared with the inbox) and the other plans. Below
// 1024 px the panel goes under the thread.
//
// The thread is the lead's CopilotKit agent (agent.ts). The reply field
// sends through POST /api/lead/messages: a goal when Goal is pressed (the
// tower bar's New goal presses it), else the answer to the lead's pending
// question when one waits, else a message. The session answer route is not
// used: it answers 409 for the lead's session (issue 168, item 3), and the
// lead engine answers the pending question from that route (decision 8).
// The plan's gestures call the plan routes at once: approving a plan starts
// tickets, which is reversible, so there is no grace (decision 6).
import { ArrowCounterClockwise, ChatCircleText, ListChecks, TrainSimple, WarningCircle } from '@phosphor-icons/react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from 'react';
import type { LeadMemory, LeadMessage, LeadState, Plan } from '../../../../src/api/types.ts';
import { OwnChoices } from '@/components/choices/Choices.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import { CopilotThreads, useThread } from '@/copilot/provider.tsx';
import { useScreen } from '@/lib/context.tsx';
import { useKept } from '@/lib/query.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ApiError } from '@/lib/screen.ts';
import { planStateLine, type PlanAction } from '@/plan-panel/model.ts';
import { PlanPanel } from '@/plan-panel/PlanPanel.tsx';
import { Empty } from '@/shell/Empty.tsx';
import '@/screens/lead/lead.css';
import { isLeadThread, LEAD_AGENT, LeadAgent, type LeadThread } from './agent.ts';
import {
  GAP_MS, SEND, TEXT_MAX, TICK_MS, choiceReply, choosePlan, clockOf, composerMode, draftFrom, gestureFailure, headerLine, memoryStats, mergeMessages, mergePlan, otherPlans,
  placeholderKey, planFrom, planGesture, replyFor, sendReply, stopText, threadRows, trainHeadline, trainTone, waitsOn,
  type ComposerMode, type LeadDraft, type LeadView, type Reply, type StreamLike, type TrainLine,
} from './model.ts';

export function HeaderLine({ state, now, t }: { readonly state: LeadState; readonly now: Date; readonly t: Translate }) {
  const line = headerLine(state, now, t);
  return <p className={line.tone === 'down' ? 'lead-line lead-down' : 'lead-line'} id="lead-line">{line.text}</p>;
}

// A question that waits shows its options as the clickable answers, the
// reply field below being its free answer; once settled it reads as the
// lead's other lines, as in the capture, the owner's answer following it.
function QuestionBody({ message, state, t, busy = false, onAnswer }: { readonly message: LeadMessage; readonly state: LeadState; readonly t: Translate; readonly busy?: boolean; readonly onAnswer?: (reply: Reply) => void }) {
  const asked = message.question;
  if (!asked || !waitsOn(message, state)) return <p className="bubble-text">{asked ? asked.questions.map((q) => q.question).join('\n\n') : message.text}</p>;
  return (
    <>
      <OwnChoices key={asked.requestId} questions={asked.questions} t={t} requestId={asked.requestId} free={false} busy={busy}
        onAnswer={(answers) => onAnswer?.(choiceReply(asked.questions, answers))} />
      <p className="q-hint">{t('lead_question_answer_below')}</p>
    </>
  );
}

// A release train as a service line of the thread (lane 22): where it is,
// each service in landing order with its pull request and state, a block's
// reason and proposal, and the way to its card in the inbox.
export function TrainRow({ line, now, language, t }: { readonly line: TrainLine; readonly now: Date; readonly language: 'en' | 'fr'; readonly t: Translate }) {
  const tone = trainTone(line);
  const Icon = line.state === 'blocked' ? WarningCircle : tone === 'danger' ? ArrowCounterClockwise : TrainSimple;
  return (
    <li className={tone ? `train-line ${tone}` : 'train-line'} data-train={line.state} data-ticket={line.ticket}>
      <span className="train-mark" aria-hidden="true"><Icon size={14} /></span>
      <div className="train-body">
        <p className="train-head"><span>{trainHeadline(line, t)}</span> <time dateTime={line.at}>{clockOf(line.at, now, language)}</time></p>
        <p className="train-title">{line.title}</p>
        <ul className="train-stops" aria-label={t('lead_train_services')}>
          {line.stops.map((stop) => <li key={stop.service} className="train-stop" data-stop={stop.state}>{stopText(stop, t)}</li>)}
        </ul>
        {line.blocked ? <><p className="train-reason">{line.blocked.reason}</p><p className="train-proposal">{t('lead_train_proposal', { text: line.blocked.proposal })}</p></> : null}
        <a className="train-link" href={line.href}>{t('lead_train_open')}</a>
      </div>
    </li>
  );
}

// An empty thread or plan side (lane 35, docs/v2/ui-overhaul-plan.md,
// 2.2.7): one sentence, and the one thing to do, give the lead a goal.
export function Thread({ view, t, busy = false, onAnswer, onStart }: { readonly view: LeadView; readonly t: Translate; readonly busy?: boolean; readonly onAnswer?: (reply: Reply) => void; readonly onStart?: () => void }) {
  if (view.messages.length === 0 && !view.trains?.length) {
    return <li className="thread-start"><Empty icon={ChatCircleText} id="thread-empty" text={t('lead_thread_empty')} action={{ label: t('lead_start_goal'), onClick: () => onStart?.() }} /></li>;
  }
  const shown = choosePlan(view.plans, view.planId)?.id;
  let previous: number | undefined;
  return (
    <>
      {threadRows(view.messages, view.trains ?? []).map((row) => {
        if (row.kind === 'train') return <TrainRow key={`train-${row.line.id}`} line={row.line} now={view.now} language={view.language} t={t} />;
        const { message } = row;
        const at = Date.parse(message.at);
        const gap = previous !== undefined && at - previous >= GAP_MS && message.kind !== 'refresh'
          ? <li className="time-line"><time dateTime={message.at}>{clockOf(message.at, view.now, view.language)}</time></li> : null;
        previous = at;
        if (message.by === 'system') {
          const line = message.kind === 'refresh'
            ? t('lead_refresh_line', { generation: message.generation ?? '', time: clockOf(message.at, view.now, view.language) })
            : t('lead_system_line', { text: message.text, time: clockOf(message.at, view.now, view.language) });
          return <Fragment key={message.seq}>{gap}<li className="system-line"><span>{line}</span></li></Fragment>;
        }
        if (message.by === 'owner') return <Fragment key={message.seq}>{gap}<li className="owner-row"><p className="bubble owner">{message.text}</p></li></Fragment>;
        const question = message.kind === 'question';
        const waits = question && waitsOn(message, view.state);
        // The plan beside the thread is reached by its anchor where the panel
        // goes under the thread (below 1024 px); another plan by its address.
        const link = message.kind !== 'plan' || !message.planId ? null
          : message.planId === shown ? <a className="bubble-link to-panel" href={`#plan-title-${message.planId}`}>{t('lead_see_plan')}</a>
          : <a className="bubble-link" href={`/plans/${encodeURIComponent(message.planId)}`}>{t('lead_see_plan')}</a>;
        return (
          <Fragment key={message.seq}>{gap}<li className="lead-row">
            <span className="lead-mark small" aria-hidden="true">{t('lead_initial')}</span>
            <div className={`bubble lead${question ? ' question' : ''}${waits ? ' waits' : ''}`}>
              {question ? <QuestionBody message={message} state={view.state} t={t} busy={busy} onAnswer={onAnswer} /> : <p className="bubble-text">{message.text}</p>}
              {link}
            </div>
          </li></Fragment>
        );
      })}
    </>
  );
}

function Commitment({ text, ticket, meta }: { readonly text: string; readonly ticket: string | null; readonly meta: string }) {
  return <li><p>{text}{ticket ? <>{' '}<span className="id">{ticket}</span></> : null}</p><p className="memory-meta">{meta}</p></li>;
}

export function MemoryBody({ memory, state, now, t, language = 'en' }: { readonly memory: LeadMemory; readonly state: LeadState; readonly now: Date; readonly t: Translate; readonly language?: 'en' | 'fr' }) {
  const stats = memoryStats(state, t);
  const { handover } = memory;
  const open = memory.commitments.filter((c) => c.state === 'open');
  const done = memory.commitments.filter((c) => c.state === 'done');
  return (
    <>
      <p className="memory-stats">{stats.text}{stats.model ? <>{' · '}<span className="nowrap">{stats.model}</span></> : null}</p>
      <h3>{t('lead_memory_handover')}</h3>
      {handover === null ? <p className="faint">{t('lead_memory_no_handover')}</p>
        : handover.machine ? <p className="memory-meta">{t('lead_memory_handover_machine', { generation: handover.generation, time: clockOf(handover.at, now, language) })}</p>
        : <><p className="memory-meta">{t('lead_memory_handover_meta', { generation: handover.generation, time: clockOf(handover.at, now, language) })}</p><p className="memory-text">{handover.summary}</p></>}
      <h3>{t('lead_memory_open')}</h3>
      {open.length === 0 ? <p className="faint">{t('lead_memory_none_open')}</p> : (
        <ul className="commitments">
          {open.map((c) => <Commitment key={c.id} text={c.text} ticket={c.ticket}
            meta={[t('lead_memory_promised', { time: clockOf(c.createdAt, now, language) }), ...(c.due ? [t('lead_memory_due', { time: clockOf(c.due, now, language) })] : [])].join(' · ')} />)}
        </ul>
      )}
      {done.length === 0 ? null : (
        <>
          <h3>{t('lead_memory_done')}</h3>
          <ul className="commitments done">
            {done.map((c) => {
              const when = c.fulfilledAt ? clockOf(c.fulfilledAt, now, language) : '';
              return <Commitment key={c.id} text={c.text} ticket={c.ticket} meta={c.note ? t('lead_memory_fulfilled_note', { time: when, note: c.note }) : t('lead_memory_fulfilled', { time: when })} />;
            })}
          </ul>
        </>
      )}
    </>
  );
}

function MemoryPanel({ view, t, onClose }: { readonly view: LeadView; readonly t: Translate; readonly onClose?: () => void }) {
  if (view.memory === null) return null;
  return (
    <section className="memory" aria-labelledby="memory-title">
      <div className="memory-head"><h2 id="memory-title">{t('lead_memory_title')}</h2><Button className="plain memory-close" data-memory-close onClick={onClose}>{t('lead_memory_close')}</Button></div>
      {view.memory === 'loading' ? <p className="faint">{t('lead_memory_loading')}</p>
        : view.memory === 'failed' ? <p className="memory-error">{t('lead_memory_failed')}</p>
        : <MemoryBody memory={view.memory} state={view.state} now={view.now} t={t} language={view.language} />}
    </section>
  );
}

export function Side({ view, t, busy = false, note = null, onAction, onStart }: { readonly view: LeadView; readonly t: Translate; readonly busy?: boolean; readonly note?: string | null; readonly onAction?: (plan: Plan, action: PlanAction) => void; readonly onStart?: () => void }) {
  const shown = choosePlan(view.plans, view.planId);
  const others = otherPlans(view.plans, shown);
  return (
    <>
      {shown ? <PlanPanel plan={shown} t={t} options={{ language: view.language, busy, note, services: true }} onAction={(action) => onAction?.(shown, action)} />
        : view.planId === null ? <Empty icon={ListChecks} id="plan-empty" block text={t('lead_no_plan')} note={t('lead_no_plan_note')} action={{ label: t('lead_start_goal'), onClick: () => onStart?.() }} />
        : <p className="empty plan-empty">{t('lead_plan_missing', { id: view.planId })}</p>}
      {others.length === 0 ? null : (
        <section className="other-plans" aria-labelledby="other-plans-title">
          <h2 id="other-plans-title">{t('lead_other_plans')}</h2>
          <ul>{others.map((plan) => <li key={plan.id}><a href={`/plans/${encodeURIComponent(plan.id)}`}>{plan.title}</a> <span className={plan.state === 'proposed' ? 'faint waits' : 'faint'}>{planStateLine(plan, t)}</span></li>)}</ul>
        </section>
      )}
    </>
  );
}

export function ReplyForm({ mode, changing = false, text, sending = false, note = '', t, onText, onGoal, onSubmit, onKeyDown, fieldRef }: {
  readonly mode: ComposerMode; readonly changing?: boolean; readonly text: string; readonly sending?: boolean; readonly note?: string; readonly t: Translate;
  readonly onText?: (value: string) => void; readonly onGoal?: () => void; readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void; readonly fieldRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <form className="reply" id="reply" noValidate onSubmit={onSubmit}>
      <Toggle className="goal-toggle" id="goal-toggle" pressed={mode === 'goal'} onPressedChange={() => onGoal?.()} title={t('lead_goal_hint')}>{t('lead_goal')}</Toggle>
      <label className="sr-only" htmlFor="reply-text">{t('lead_reply_label')}</label>
      <Textarea id="reply-text" rows={1} maxLength={TEXT_MAX} placeholder={t(placeholderKey(mode, changing))} value={text} ref={fieldRef}
        onChange={(event) => onText?.(event.target.value)} onKeyDown={onKeyDown} />
      <Button variant="ink" className="primary" id="reply-send" type="submit" disabled={sending}>{t(SEND[mode])}</Button>
      <p className="reply-note" id="reply-note" role="status">{note}</p>
    </form>
  );
}

// The whole screen for a view, as the tests render it.
export function LeadScreen({ view, t, draft = { text: '', goal: false } }: { readonly view: LeadView; readonly t: Translate; readonly draft?: LeadDraft }) {
  return (
    <div className="lead-screen">
      <section className="lead-card" aria-labelledby="lead-title">
        <div className="lead-top">
          <span className="lead-mark" aria-hidden="true">{t('lead_initial')}</span>
          <div className="lead-who"><h1 id="lead-title">{t('lead_heading')}</h1><HeaderLine state={view.state} now={view.now} t={t} /></div>
          <Button variant="link" className="link-button" id="lead-remember" aria-expanded={view.memory !== null} aria-controls="lead-memory">{t('lead_remember')}</Button>
        </div>
        <div id="lead-memory"><MemoryPanel view={view} t={t} /></div>
        <ol className="thread" id="thread" aria-label={t('lead_thread_label')}><Thread view={view} t={t} /></ol>
        <ReplyForm mode={composerMode(view.state, draft.goal)} text={draft.text} t={t} />
      </section>
      <div className="plan-side" id="plan-side"><Side view={view} t={t} /></div>
    </div>
  );
}

function Live({ draft, planId }: { readonly draft: LeadDraft; readonly planId: string | null }) {
  const context = useScreen();
  const { t } = context;
  const { agent, state: own } = useThread<LeadThread>(LEAD_AGENT, isLeadThread);
  // A second visit draws the thread it last showed until the agent's own
  // arrives from the cache and the stream (lane 34): no placeholder.
  const [last, keep] = useKept<LeadThread | undefined>('lead-thread', undefined);
  useEffect(() => { if (own) keep(own); }, [own, keep]);
  const thread = own ?? last;
  const lead = agent as unknown as LeadAgent;
  const [now, setNow] = useState(() => context.now());
  const [memory, setMemory] = useState<LeadView['memory']>(null);
  const [goal, setGoal] = useState(draft.goal);
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState(draft.text);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [planNote, setPlanNote] = useState<string | null>(null);
  const threadRef = useRef<HTMLOListElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const remember = useRef<HTMLButtonElement | null>(null);
  const side = useRef<HTMLDivElement | null>(null);
  const atEnd = useRef(true);
  const toEnd = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(context.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [context]);

  // The trains move without a frame of the lead's stream: the inbox is read again at each tick.
  const loaded = thread !== undefined;
  useEffect(() => {
    if (loaded) void lead.readTrains();
  }, [now, lead, loaded]);

  const view: LeadView | undefined = thread && { state: thread.lead, messages: thread.messages, plans: thread.plans, planId, now, language: context.me.language, memory, trains: thread.trains };

  // The thread follows the newest line while the person is at its end.
  const onScroll = () => {
    const el = threadRef.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && (atEnd.current || toEnd.current)) el.scrollTop = el.scrollHeight;
    toEnd.current = false;
  }, [thread?.messages, thread?.lead.pendingQuestion?.requestId]);

  const ready = thread !== undefined;
  useEffect(() => {
    if (ready && (draft.text || draft.goal)) field.current?.focus();
  }, [ready, draft]);

  if (!view || !thread) return <div className="lead-screen" aria-busy="true" />;
  const mode = composerMode(view.state, goal);

  const deliver = async (reply: Reply) => {
    if (sending) return;
    setSending(true);
    setNote('');
    try {
      const sent = await sendReply(context.api, reply);
      lead.update((current) => {
        let next = current;
        if (reply.kind === 'answer') {
          // The question is settled now; the stream's next state says so too.
          const asked = current.lead.pendingQuestion?.requestId;
          next = {
            ...next, lead: { ...next.lead, pendingQuestion: null },
            messages: next.messages.map((m) => (m.question && m.question.requestId === asked ? { ...m, question: { ...m.question, state: 'handled' as const } } : m)),
          };
        }
        return { ...next, messages: mergeMessages(next.messages, [sent]) };
      });
      if (reply.kind === 'answer') context.inboxChanged();
      setText((current) => (current.trim() === reply.body.text ? '' : current));
      setGoal(false);
      setChanging(false);
      toEnd.current = true;
    } catch {
      setNote(t('lead_send_failed'));
    } finally {
      setSending(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reply = replyFor(text, view.state, goal);
    if (!reply) { field.current?.focus(); return; }
    void deliver(reply);
  };
  // Enter sends, Shift+Enter starts a new line, as in a chat.
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    (document.getElementById('reply') as HTMLFormElement | null)?.requestSubmit();
  };

  const openMemory = async () => {
    if (memory !== null) { setMemory(null); return; }
    setMemory('loading');
    try {
      const read = await context.api<LeadMemory>('/lead/memory');
      setMemory((current) => (current === null ? null : read));
    } catch {
      setMemory((current) => (current === null ? null : 'failed'));
    }
  };

  const act = async (plan: Plan, action: PlanAction) => {
    if (planBusy) return;
    if (action === 'change') {
      // The lead proposes a new version, which supersedes this one (section 5.4).
      setGoal(false);
      setChanging(true);
      field.current?.focus();
      field.current?.scrollIntoView({ block: 'nearest' });
      return;
    }
    setPlanBusy(true);
    setPlanNote(null);
    try {
      const moved = await planGesture(context.api, plan, action);
      lead.update((current) => ({ ...current, plans: mergePlan(current.plans, moved) }));
      context.inboxChanged();
    } catch (error) {
      setPlanNote(t(gestureFailure(error, action)));
      if (error instanceof ApiError && error.status === 409) {
        const fresh = await context.api<Plan>(`/plans/${encodeURIComponent(plan.id)}`).catch(() => undefined);
        if (fresh) lead.update((current) => ({ ...current, plans: mergePlan(current.plans, fresh) }));
      }
    }
    setPlanBusy(false);
    queueMicrotask(() => side.current?.querySelector<HTMLButtonElement>('[data-plan-action]:not([data-plan-action="change"])')?.focus());
  };

  const startGoal = () => { setGoal(true); setChanging(false); field.current?.focus(); };

  return (
    <div className="lead-screen">
      <section className="lead-card" aria-labelledby="lead-title">
        <div className="lead-top">
          <span className="lead-mark" aria-hidden="true">{t('lead_initial')}</span>
          <div className="lead-who"><h1 id="lead-title">{t('lead_heading')}</h1><HeaderLine state={view.state} now={view.now} t={t} /></div>
          <Button variant="link" className="link-button" id="lead-remember" aria-expanded={memory !== null} aria-controls="lead-memory" ref={remember} onClick={() => void openMemory()}>{t('lead_remember')}</Button>
        </div>
        <div id="lead-memory"><MemoryPanel view={view} t={t} onClose={() => { setMemory(null); remember.current?.focus(); }} /></div>
        <ol className="thread" id="thread" aria-label={t('lead_thread_label')} ref={threadRef} onScroll={onScroll}>
          <Thread view={view} t={t} busy={sending} onAnswer={(reply) => { if (view.state.pendingQuestion) void deliver(reply); }} onStart={startGoal} />
        </ol>
        <ReplyForm mode={mode} changing={changing} text={text} sending={sending} note={note} t={t} fieldRef={field} onText={setText}
          onGoal={() => { setGoal((current) => !current); setChanging(false); field.current?.focus(); }} onSubmit={submit} onKeyDown={keyDown} />
      </section>
      <div className="plan-side" id="plan-side" ref={side}><Side view={view} t={t} busy={planBusy} note={planNote} onAction={(plan, action) => void act(plan, action)} onStart={startGoal} /></div>
    </div>
  );
}

export default function Lead() {
  const context = useScreen();
  // The draft is read once; the address keeps no typed text (issue 164).
  const [draft] = useState(() => draftFrom(location.search));
  useEffect(() => {
    if (location.search) history.replaceState(history.state, '', location.pathname + location.hash);
  }, []);
  const agents = useMemo(() => ({
    [LEAD_AGENT]: new LeadAgent({
      api: context.api,
      open: (url) => new EventSource(url) as unknown as StreamLike,
      later: (run, ms) => { setTimeout(run, ms); },
      onFrame: (frame) => {
        if (frame.kind === 'plan' || (frame.kind === 'state' && frame.state.pendingQuestion)) context.inboxChanged();
      },
    }),
  }), [context]);
  return <CopilotThreads agents={agents}><Live draft={draft} planId={planFrom(context.path)} /></CopilotThreads>;
}
