// The inbox (inbox.png): what waits for the human, oldest first by kind, then
// what was handled today, and the detail of the item chosen: a release to
// approve or send back, a permission to allow or deny, a question to answer,
// the lead's plan to approve (model.ts says what each gesture calls).
import { ArrowLeft } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { InboxItem, PermissionItem, Plan, PlanItemInbox, QuestionItem, ReleaseItem, SessionSummary } from '../../../../src/api/types.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { formatDuration, planStateLine } from '@/plan-panel/model.ts';
import { PlanPanel } from '@/plan-panel/PlanPanel.tsx';
import '@/screens/lead/lead.css';
import {
  CHECKS, GRACE_MS, RECOMMENDED, REFRESH_MS, STORE_KEY, afterPlanRefusal, answerRequest, answersFor, approve, approvePlan, chosen, clock, decisionFor, detailKey, elapsed, failure,
  graceLeft, isLead, isWebLink, itemFromHash, itemLine, itemTitle, kept, ordered, pausedLine, planOf, readPlan, releaseSession, sameOrigin, sendBack, sentence, sessionLink,
  sessionOf, sessionsLine, shareLine, short, target, ticketTitle, undoApproval, verbOf, type Gesture, type InboxView, type Local,
} from './model.ts';
import './inbox.css';

function Card({ item, current, view, t }: { readonly item: InboxItem; readonly current: boolean; readonly view: InboxView; readonly t: Translate }) {
  return (
    <li>
      <a className={`item${current ? ' current' : ''}${item.state === 'handled' ? ' handled' : ''}`} href={`#${encodeURIComponent(item.id)}`} aria-current={current ? 'true' : undefined} data-item={item.id}>
        <span className="item-head"><span className="chip">{t(`kind_${item.kind}`)}</span><span className="since">{elapsed(item.since, view.now, t)}</span></span>
        <span className="item-title">{itemTitle(item)}</span>
        <span className="item-line">{itemLine(item, view, t)}</span>
      </a>
    </li>
  );
}

function Empty({ t }: { readonly t: Translate }) {
  return <p className="empty"><strong>{t('empty_title')}</strong> {t('empty_note')}</p>;
}

export function List({ view, t }: { readonly view: InboxView; readonly t: Translate }) {
  const { waiting, handled } = ordered(view.items);
  const shown = chosen(view);
  const head = <div className="inbox-head"><h1 id="inbox-title">{t('inbox_title')}</h1>{waiting.length > 0 ? <span className="faint">{t('waiting_count', { n: waiting.length })}</span> : null}</div>;
  if (view.items.length === 0) return <>{head}<Empty t={t} /></>;
  const list = (items: InboxItem[]) => <ul className="items">{items.map((item) => <Card key={item.id} item={item} current={item.id === shown?.id} view={view} t={t} />)}</ul>;
  return (
    <>
      {head}
      {waiting.length > 0 ? list(waiting) : <Empty t={t} />}
      {handled.length > 0 ? <><h2 className="handled-title">{t('handled_title')}</h2>{list(handled)}</> : null}
    </>
  );
}

const Fact = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => <><dt>{label}</dt><dd>{children}</dd></>;

// The kind, whose item it is, and where to open it: the session, or the
// lead's screen for the lead's items, whose ticket is never shown.
function Eyebrow({ item, kind, open, openKey, t }: { readonly item: InboxItem; readonly kind: string; readonly open: string | undefined; readonly openKey: string; readonly t: Translate }) {
  return (
    <p className="d-eyebrow">
      <span className={item.state === 'waiting' ? 'd-kind waits' : 'd-kind'}>{kind}</span>
      <span className="id">{isLead(item) ? t('lead_label') : item.ticket}</span>
      {open ? <a className="d-link" href={open}>{t(openKey)}</a> : null}
    </p>
  );
}

function Shot({ item, side, frame, t }: { readonly item: ReleaseItem; readonly side: 'before' | 'after'; readonly frame: InboxView['frame']; readonly t: Translate }) {
  const url = sameOrigin(item.captures[side][frame]);
  return (
    <figure className={`shot ${side}`}>
      <div className="device">{url ? <img className="shot-img" src={url} alt={t(`alt_${side}`)} loading="lazy" /> : <span className="shot-none">{t('shot_none')}</span>}</div>
      <figcaption>{t(side)}</figcaption>
    </figure>
  );
}

function ReleaseBody({ item, view, t, onFrame }: { readonly item: ReleaseItem; readonly view: InboxView; readonly t: Translate; readonly onFrame?: (frame: InboxView['frame']) => void }) {
  const open = releaseSession(view, item.ticket);
  const pr = t('pr_link', { n: item.pr.number });
  return (
    <>
      <Eyebrow item={item} kind={t(item.state === 'waiting' ? 'eyebrow_release' : 'kind_release')} open={open && sessionLink(open.id)} openKey="open_sessions" t={t} />
      <h2 className="d-title">{item.title}</h2>
      {item.announcement ? <p className="announce">{item.announcement}</p> : null}
      <div className="shots-head">
        <h3>{t('shots_title')}</h3>
        <div className="switch" role="group" aria-label={t('frame_label')}>
          {(['desktop', 'phone'] as const).map((frame) => <Toggle key={frame} data-frame={frame} pressed={view.frame === frame} onPressedChange={() => onFrame?.(frame)}>{t(`frame_${frame}`)}</Toggle>)}
        </div>
      </div>
      <div className={`shots frame-${view.frame}`}><Shot item={item} side="before" frame={view.frame} t={t} /><Shot item={item} side="after" frame={view.frame} t={t} /></div>
      <dl className="facts">
        {item.sessions.length > 0 ? <Fact label={t('facts_sessions')}>{sessionsLine(item, t)}</Fact> : null}
        <Fact label={t('facts_change')}>
          {isWebLink(item.pr.url) ? <a href={item.pr.url} rel="noopener noreferrer">{pr}</a> : pr}
          <span className="sep" aria-hidden="true">·</span><span>{t(`checks_${CHECKS[item.pr.checks]}`)}</span>
        </Fact>
      </dl>
    </>
  );
}

function PermissionBody({ item, view, t }: { readonly item: PermissionItem; readonly view: InboxView; readonly t: Translate }) {
  const input = item.input;
  const shown = target(input);
  const session = sessionOf(view, item.sessionId);
  const title = ticketTitle(view, item.ticket);
  const facts = [
    input.kind === 'execute' && input.description ? <Fact key="for" label={t('facts_what_for')}>{input.description}</Fact> : null,
    item.suggestion.decision === 'ask' && item.suggestion.reason ? <Fact key="why" label={t('facts_why')}>{sentence(item.suggestion.reason)}</Fact> : null,
    session ? <Fact key="session" label={t('facts_session')}>{pausedLine(item, session, view.now, t)}</Fact> : null,
  ].filter(Boolean);
  return (
    <>
      <Eyebrow item={item} kind={t('eyebrow_permission')} open={sessionLink(item.sessionId)} openKey="open_session" t={t} />
      <h2 className="d-title">{t(`wants_${verbOf(input)}`, { tool: item.tool })}{shown ? <>{' '}<code>{shown}</code></> : null}</h2>
      {title ? <p className="d-ticket">{title}</p> : null}
      {facts.length ? <dl className="facts">{facts}</dl> : null}
    </>
  );
}

type Answers = { readonly picks: readonly (readonly string[])[]; readonly free: readonly string[] };

function QuestionBody({ item, view, t, answers, onPick, onFree }: {
  readonly item: QuestionItem; readonly view: InboxView; readonly t: Translate; readonly answers: Answers;
  readonly onPick?: (index: number, label: string, multi: boolean) => void; readonly onFree?: (index: number, value: string) => void;
}) {
  // The lead's question is read here and answered on the lead's screen.
  const lead = isLead(item);
  const waiting = item.state === 'waiting' && !lead;
  const title = lead ? undefined : ticketTitle(view, item.ticket);
  return (
    <>
      {lead ? <Eyebrow item={item} kind={t('eyebrow_lead_question')} open={undefined} openKey="" t={t} />
        : <Eyebrow item={item} kind={t('eyebrow_question')} open={sessionLink(item.sessionId)} openKey="open_session" t={t} />}
      <h2 className="sr-only">{t('kind_question')}</h2>
      {/* The question first, on the colour of what waits; the ticket under it (DESIGN.md, 4). */}
      <div className={`questions${item.state === 'waiting' ? ' waits' : ''}${lead ? ' read' : ''}`}>
        {item.questions.map((question, index) => {
          const options = question.options ?? [];
          return (
            <fieldset key={index} className="q" data-multi={question.multiSelect ? 'true' : undefined}>
              <legend className="q-text">{question.header ? <span className="q-header">{question.header}</span> : null}<span>{question.question}</span></legend>
              {options.length ? (
                <div className="options">
                  {options.map((option) => (
                    <Toggle key={option.label} className="option" data-q={index} data-option={option.label} disabled={!waiting}
                      pressed={(answers.picks[index] ?? []).includes(option.label)} onPressedChange={() => onPick?.(index, option.label, question.multiSelect === true)}>
                      <span className="o-label">{option.label.replace(RECOMMENDED, '')}</span>
                      {RECOMMENDED.test(option.label) ? <span className="o-rec">{t('recommended')}</span> : null}
                      {option.description ? <span className="o-desc">{option.description}</span> : null}
                    </Toggle>
                  ))}
                </div>
              ) : null}
              {waiting ? <label className="free"><span>{t('free_answer')}</span><Input type="text" data-free={index} maxLength={2000} autoComplete="off" value={answers.free[index] ?? ''} onChange={(event) => onFree?.(index, event.target.value)} /></label> : null}
            </fieldset>
          );
        })}
      </div>
      {title ? <p className="d-ticket for-question">{title}</p> : null}
    </>
  );
}

// The plan read for the item, in the plan panel without its buttons (the
// inbox's bar holds the gestures); until it is read, or when it cannot be,
// what the inbox item itself says.
function PlanBody({ item, view, t }: { readonly item: PlanItemInbox; readonly view: InboxView; readonly t: Translate }) {
  const plan = planOf(view, item);
  const language = view.language ?? 'en';
  const head = <Eyebrow item={item} kind={plan ? planStateLine(plan, t) : t(item.state === 'waiting' ? 'plan_state_proposed' : 'kind_plan')} open={`/plans/${encodeURIComponent(item.planId)}`} openKey="open_plan" t={t} />;
  if (plan) return <>{head}<PlanPanel plan={plan} t={t} options={{ language, actions: false }} /></>;
  return (
    <>
      {head}
      <h2 className="d-title">{item.title}</h2>
      <p className="announce">{item.summary}</p>
      <dl className="facts">
        <Fact label={t('facts_tickets')}>{t(item.itemCount === 1 ? 'tickets_one' : 'tickets_other', { n: item.itemCount })}</Fact>
        <Fact label={t('facts_work')}>{t('plan_work', { time: formatDuration(item.totals.minutes, t) })}</Fact>
        <Fact label={t('facts_share')}>{shareLine(item.totals, language, t)}</Fact>
      </dl>
    </>
  );
}

export type Act = (act: string) => void;

// The bottom of the detail: what the person can do now, or what they did.
export function Actions({ item, view, t, note = '', reason = '', ready = false, onAct, onReason }: {
  readonly item: InboxItem; readonly view: InboxView; readonly t: Translate; readonly note?: string; readonly reason?: string; readonly ready?: boolean;
  readonly onAct?: Act; readonly onReason?: (value: string) => void;
}) {
  const local = view.local.get(item.id);
  const busy = local?.kind === 'busy';
  const status = <p className="d-note" id="d-note" role="status">{note}</p>;
  const done = (text: string) => <><p className="d-done">{text}</p>{status}</>;
  const act = (name: string, label: ReactNode, primary = false, disabled = false, extra: Record<string, string> = {}) => (
    <Button variant={primary ? 'ink' : 'outline'} className={primary ? 'btn primary' : 'btn'} data-act={name} disabled={disabled} onClick={() => onAct?.(name)} {...extra}>{label}</Button>
  );
  const signed = <span className="signed">{t('signed_in', { name: view.me.name })}</span>;
  if (local?.kind === 'settled') return done(t('settled'));
  if (local?.kind === 'answered') return done(t(`answered_${local.decision}`));
  if (local?.kind === 'approved') return done(t('approved', { time: clock(local.at) }));
  if (local?.kind === 'sent_back') return done(t('sent_back', { time: clock(local.at) }));
  if (local?.kind === 'plan_approved') return done(t('approved_plan', { time: clock(local.at) }));
  if (item.state === 'handled') return done(t('handled_note'));
  if (item.kind === 'question' && isLead(item)) {
    // Outlined: it only opens the lead's screen; ink is for a gesture.
    return <><p className="d-done">{t('lead_waits')}</p><div className="d-buttons"><Button asChild className="btn"><a href="/lead">{t('answer_on_lead')}</a></Button></div>{status}</>;
  }
  switch (item.kind) {
    case 'release': {
      if (local?.kind === 'grace') {
        const left = graceLeft(local.dueAt, view.now);
        return (
          <>
            <div className="grace" data-due={local.dueAt}>
              <div className="grace-track" role="presentation"><div className="grace-fill" style={{ transform: `scaleX(${Math.min(1, left / (GRACE_MS / 1000))})` }} /></div>
              <span className="grace-text" aria-label={t('grace_label')}>{t('grace_text', { n: left })}</span>{act('undo', t('undo'), true)}
            </div>
            {status}
          </>
        );
      }
      if (local?.kind === 'confirm') return <><p className="d-confirm">{t('confirm_send_back')}</p><div className="d-buttons">{act('keep', t('keep'))}{act('send_back_confirm', t('send_back_confirm'), true)}</div>{status}</>;
      const versions = item.heads.map((h) => t('version', { pr: h.pr, head: h.head })).join(', ');
      const first = item.heads[0];
      const label = <><span>{t('approve')}</span>{first ? <span className="commit">{short(first.head)}</span> : null}</>;
      return <>{signed}<div className="d-buttons">{act('send_back', t('send_back'), false, busy)}{act('approve', label, true, busy, { 'aria-label': t('approve_label', { versions }), title: versions })}</div>{status}</>;
    }
    case 'permission':
      return (
        <>
          <label className="deny-reason" htmlFor="deny-reason"><span className="sr-only">{t('deny_reason')}</span><Input id="deny-reason" type="text" maxLength={2000} autoComplete="off" placeholder={t('deny_reason')} disabled={busy} value={reason} onChange={(event) => onReason?.(event.target.value)} /></label>
          <div className="d-buttons">{act('reject_once', t('deny'), false, busy)}{act('allow_always', t('allow_always'), false, busy)}{act('allow_once', t('allow_once'), true, busy)}</div>
          {status}
        </>
      );
    case 'question':
      // Disabled until every question has a choice or a free answer.
      return <>{signed}<div className="d-buttons">{act('answer', t('send_answer'), true, busy || !ready)}</div>{status}</>;
    case 'plan': {
      // A plan the service no longer proposes is not approved from here.
      const plan = planOf(view, item);
      if (plan && plan.state !== 'proposed') return done(t('handled_note'));
      // Change the plan is said to the lead, on its screen (section 5.4).
      return <>{signed}<div className="d-buttons"><Button asChild className="btn"><a href={`/plans/${encodeURIComponent(item.planId)}`}>{t('plan_change')}</a></Button>{act('approve_plan', t('plan_approve'), true, busy)}</div>{status}</>;
    }
  }
}

const noAnswers = (item: InboxItem | undefined): Answers => {
  const n = item?.kind === 'question' ? item.questions.length : 0;
  return { picks: Array.from({ length: n }, () => []), free: Array.from({ length: n }, () => '') };
};

// The detail of the item shown. Its fields (a reason, the choices, a free
// answer) live as long as what it shows: the screen keys it by detailKey,
// so a refresh that changes nothing shown loses nothing being typed.
export function Detail({ view, t, note = '', onAct, onFrame }: {
  readonly view: InboxView; readonly t: Translate; readonly note?: string;
  readonly onAct?: (act: string, given: { readonly reason: string; readonly answers: Answers }) => void; readonly onFrame?: (frame: InboxView['frame']) => void;
}) {
  const item = chosen(view);
  const [reason, setReason] = useState('');
  const [answers, setAnswers] = useState<Answers>(() => noAnswers(item));
  const back = <a className="back" href="#" aria-label={t('back_label')}><ArrowLeft size={14} aria-hidden="true" /> {t('back')}</a>;
  if (!item) return <>{back}<div className="d-body"><p className="empty">{t('gone')}</p></div></>;
  const pick = (index: number, label: string, multi: boolean) => setAnswers((current) => ({
    ...current,
    picks: current.picks.map((chosenOnes, at) => {
      if (at !== index) return chosenOnes;
      if (chosenOnes.includes(label)) return chosenOnes.filter((other) => other !== label);
      return multi ? [...chosenOnes, label] : [label];
    }),
  }));
  const free = (index: number, value: string) => setAnswers((current) => ({ ...current, free: current.free.map((text, at) => (at === index ? value : text)) }));
  const ready = item.kind === 'question' && answersFor(item.questions, answers.picks, answers.free).missing === undefined;
  return (
    <>
      {back}
      <div className="d-body" data-kind={item.kind}>
        {item.kind === 'release' ? <ReleaseBody item={item} view={view} t={t} onFrame={onFrame} />
          : item.kind === 'permission' ? <PermissionBody item={item} view={view} t={t} />
          : item.kind === 'plan' ? <PlanBody item={item} view={view} t={t} />
          : <QuestionBody item={item} view={view} t={t} answers={answers} onPick={pick} onFree={free} />}
      </div>
      <div className="d-actions" id="d-actions">
        <Actions item={item} view={view} t={t} note={note} reason={reason} ready={ready} onReason={setReason} onAct={(act) => onAct?.(act, { reason, answers })} />
      </div>
    </>
  );
}

export function InboxScreen({ view, t, note = '', onAct, onFrame, detailRef }: {
  readonly view: InboxView; readonly t: Translate; readonly note?: string;
  readonly onAct?: (act: string, given: { readonly reason: string; readonly answers: Answers }) => void; readonly onFrame?: (frame: InboxView['frame']) => void;
  readonly detailRef?: Ref<HTMLElement>;
}) {
  if (view.items.length === 0) return <div className="inbox empty-inbox" data-open="false"><aside className="inbox-list" id="inbox-list" aria-labelledby="inbox-title"><List view={view} t={t} /></aside></div>;
  return (
    <div className="inbox" data-open={String(view.open)}>
      <aside className="inbox-list" id="inbox-list" aria-label={t('list_label')}><List view={view} t={t} /></aside>
      <section className="detail" id="detail" tabIndex={-1} aria-label={t('detail_label')} ref={detailRef}>
        <Detail key={detailKey(view)} view={view} t={t} note={note} onAct={onAct} onFrame={onFrame} />
      </section>
    </div>
  );
}

// The grace and its outcome survive a reload of this tab.
function restore(): Map<string, Local> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '{}') as Record<string, Local>;
    return new Map(Object.entries(saved).filter(([, local]) => kept(local)));
  } catch {
    return new Map();
  }
}

function save(local: ReadonlyMap<string, Local>): void {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries([...local].filter(([, l]) => kept(l))))); }
  catch { /* the state lasts for this page only */ }
}

type Data = Pick<InboxView, 'items' | 'tickets' | 'sessions'>;

export default function Inbox() {
  const context = useScreen();
  const { t, api } = context;
  const [data, setData] = useState<Data | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [local, setLocal] = useState<ReadonlyMap<string, Local>>(restore);
  const [plans, setPlans] = useState<ReadonlyMap<string, Plan>>(new Map());
  // On a phone the captures start in their phone frame; the switch changes the frame only.
  const [frame, setFrame] = useState<InboxView['frame']>(() => (window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop'));
  const [hash, setHash] = useState(() => location.hash);
  const [now, setNow] = useState(() => context.now());
  const [note, setNote] = useState('');
  const detail = useRef<HTMLElement | null>(null);
  const localRef = useRef(local);
  localRef.current = local;
  const plansRef = useRef(plans);
  plansRef.current = plans;

  const change = useCallback((edit: (next: Map<string, Local>) => void) => {
    const next = new Map(localRef.current);
    edit(next);
    localRef.current = next;
    save(next);
    setLocal(next);
  }, []);

  // The plans of the lead's items, read with the list: a service without the
  // lead answers none, and a plan item then shows what it says itself.
  const load = useCallback(async () => {
    try {
      const [items, tickets, sessions] = await Promise.all([
        api<InboxItem[]>('/inbox'), api<Ticket[]>('/tickets').catch(() => []), api<SessionSummary[]>('/sessions').catch(() => []),
      ]);
      let read = plansRef.current;
      if (items.some((item) => item.kind === 'plan')) {
        const all = await api<unknown[]>('/plans').catch(() => undefined);
        if (Array.isArray(all)) {
          const next = new Map<string, Plan>();
          for (const value of all) { const plan = readPlan(value); if (plan) next.set(plan.id, plan); }
          read = next;
        }
      }
      plansRef.current = read;
      setPlans(read);
      // A grace whose release is gone from the list ended elsewhere.
      change((next) => { for (const [id, l] of next) if (!items.some((item) => item.id === id) && l.kind !== 'busy') next.delete(id); });
      setData({ items, tickets, sessions });
    } catch {
      setFailed(true);
    }
  }, [api, change]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const selected = itemFromHash(hash);
  const view: InboxView | undefined = data && {
    ...data, selected, open: selected !== undefined, me: context.me.user, now, local, frame, plans, language: context.me.language,
  };

  // The grace counts down each second; at its end the approval is written.
  useEffect(() => {
    const timer = setInterval(() => setNow(context.now()), 1000);
    return () => clearInterval(timer);
  }, [context]);
  const shown = view ? chosen(view) : undefined;
  const shownLocal = shown ? local.get(shown.id) : undefined;
  useEffect(() => {
    if (!shown || shownLocal?.kind !== 'grace' || graceLeft(shownLocal.dueAt, now) > 0) return;
    change((next) => next.set(shown.id, { kind: 'approved', at: shownLocal.dueAt }));
    context.inboxChanged();
  }, [shown, shownLocal, now, change, context]);

  useEffect(() => {
    const onHash = () => {
      setHash(location.hash);
      setNote('');
      if (itemFromHash(location.hash) !== undefined) {
        queueMicrotask(() => detail.current?.focus({ preventScroll: true }));
        if (window.matchMedia('(max-width: 1023px)').matches) window.scrollTo(0, 0);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && location.hash && !(event.target as Element | null)?.closest?.('input')) location.hash = '';
    };
    window.addEventListener('hashchange', onHash);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const act = async (item: InboxItem, gesture: Gesture, run: () => Promise<Local | undefined>) => {
    const before = localRef.current.get(item.id);
    change((next) => next.set(item.id, { kind: 'busy' }));
    try {
      const after = await run();
      change((next) => { if (after) next.set(item.id, after); else next.delete(item.id); });
      setNote('');
      context.inboxChanged();
      void load();                                   // the list shows the item handled at once
    } catch (error) {
      const { key, settled } = failure(error, gesture);
      change((next) => {
        if (settled) next.set(item.id, { kind: 'settled' });
        // Approved elsewhere, replaced, or approved by a call that failed after
        // it was written (issue 175, item 2): the plan read again says which.
        else if (gesture === 'approve_plan') next.delete(item.id);
        else if (gesture === 'undo' && key === 'undo_late' && before?.kind === 'grace') next.set(item.id, { kind: 'approved', at: before.dueAt });
        else if (before) next.set(item.id, before);
        else next.delete(item.id);
      });
      setNote(t(key));
      if (settled) context.inboxChanged();
      if (settled || key === 'approve_conflict' || gesture === 'approve_plan') {
        await load();
        const plan = item.kind === 'plan' ? plansRef.current.get(item.planId) : undefined;
        const after = afterPlanRefusal(key, plan);
        setNote(t(after));
        if (after !== key) context.inboxChanged();
      }
    }
  };

  const onAct = (name: string, given: { readonly reason: string; readonly answers: Answers }) => {
    const item = shown;
    if (!item) return;
    const at = context.now();
    switch (name) {
      case 'approve':
        if (item.kind === 'release') void act(item, 'approve', () => approve(api, item, at));
        return;
      case 'undo':
        if (item.kind === 'release') void act(item, 'undo', async () => { await undoApproval(api, item); return undefined; });
        return;
      case 'send_back':
        change((next) => next.set(item.id, { kind: 'confirm' }));
        return;
      case 'keep':
        change((next) => next.delete(item.id));
        return;
      case 'approve_plan':
        if (item.kind === 'plan') void act(item, 'approve_plan', async () => {
          const plan = readPlan(await approvePlan(api, item));
          if (plan) {
            const next = new Map(plansRef.current).set(plan.id, plan);
            plansRef.current = next;
            setPlans(next);
          }
          return { kind: 'plan_approved', at: context.now().toISOString() };
        });
        return;
      case 'send_back_confirm':
        if (item.kind === 'release') void act(item, 'send_back', async () => { await sendBack(api, item); return { kind: 'sent_back', at: context.now().toISOString() }; });
        return;
      case 'allow_once': case 'allow_always': case 'reject_once':
        if (item.kind === 'permission') void act(item, 'answer', () => answerRequest(api, item, decisionFor(name, given.reason, t)));
        return;
      case 'answer': {
        if (item.kind !== 'question') return;
        const result = answersFor(item.questions, given.answers.picks, given.answers.free);
        if (result.missing !== undefined) { setNote(t('answer_missing')); return; }
        void act(item, 'answer', () => answerRequest(api, item, { kind: 'answer', answers: result.answers }));
        return;
      }
      default:
    }
  };

  if (!view) return failed ? <div className="inbox-error"><p className="empty error">{t('inbox_load_failed')}</p></div> : <div className="inbox-loading" aria-busy="true" />;
  return <InboxScreen view={view} t={t} note={note} onAct={onAct} onFrame={setFrame} detailRef={detail} />;
}

export type { Answers };
