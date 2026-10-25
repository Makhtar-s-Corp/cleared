// The inbox (inbox.png): what waits for the human, oldest first by kind, then
// what was handled today, and the detail of the item chosen: a release to
// approve or send back, a permission to allow or deny, a question to answer,
// the lead's plan to approve, an author's session plan to Go or Change, a
// contract to validate or send back, and knowledge to approve or reject
// (model.ts says what each gesture calls). A release of several services is
// a train (TrainBody).
import { CLOSE_REASON_MAX, closeReason, closeTicket } from '@/lib/close.ts';
import { ArrowCircleRight, ArrowCounterClockwise, ArrowLeft, CaretRight, CheckCircle, Circle, CircleNotch, LockSimple, Tray, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { ContractItem, KnowledgeItem, PermissionItem, Plan, PlanItemInbox, QuestionItem, ReleaseItem, SessionPlanItem, SessionSummary, TicketVariant, TrainState, TrainStop, VariantsItem } from '../../../../src/api/types.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import { Choices } from '@/components/choices/Choices.tsx';
import { FREE_MAX, emptyDraft, type ChoiceDraft } from '@/components/choices/model.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import { useScreen } from '@/lib/context.tsx';
import { useKept, useLive } from '@/lib/query.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { planStateLine } from '@/plan-panel/model.ts';
import { estimate, since } from '@/lib/time.ts';
import { PlanPanel } from '@/plan-panel/PlanPanel.tsx';
import '@/screens/lead/lead.css';
import { CHORD_MS } from '@/shell/keys.ts';
import { focusOf } from '@/shell/Shortcuts.tsx';
import {
  ROW_ANSWERS_MIN, closesOnEscape, foldOf, foldOpen, inboxKey, permissionAsk, permissionTitle, reasonOf, rowAnswers, type Answer,
  CHANGE_MAX, CHECKS, GRACE_MS, SEND_BACK_MAX, STORE_KEY, afterPlanRefusal, answerRequest, answersFor, approvable, approve, approveContract, approveKnowledge, approvePlan,
  changeMessage, chooseVariant, chosen, chosenLine, clock, deadlineLine, decidedLine, decisionFor, detailKey, failure, flagKey, flagsOf, goLine, graceLeft, groupsOf, isLead, isWebLink, itemFromHash, itemLine, itemTitle,
  kept, known, ordered, outcomeLine, pausedLine, planChange, planGo, planOf, readPlan, rejectKnowledge, releaseSession, sameOrigin, sendBack, sendBackContract, sendBackMessage,
  repairLine, sessionLink, sessionOf, sessionsLine, shareLine, short, variantFacts, variantHarness, variantTests,
  ticketTitle, trainLine, stopState, undoApproval, type Gesture, type InboxView, type Item, type Local,
} from './model.ts';
import './inbox.css';

// One row: the kind, the age, the title and one line. A request that waits
// carries its three answers beside the link from ROW_ANSWERS_MIN (lane 37).
function Card({ item, current, view, t, onAnswer }: {
  readonly item: Item; readonly current: boolean; readonly view: InboxView; readonly t: Translate; readonly onAnswer?: (item: Item, act: Answer) => void;
}) {
  const answers = rowAnswers(item, view);
  return (
    <li className={[answers.length > 0 ? 'with-answers' : '', current ? 'current' : ''].filter(Boolean).join(' ') || undefined}>
      <a className={`item${current ? ' current' : ''}${item.state === 'handled' ? ' handled' : ''}`} href={`#${encodeURIComponent(item.id)}`} aria-current={current ? 'true' : undefined} data-item={item.id}>
        <span className="item-head">
          <span className="chip">{t(`kind_${item.kind}`)}</span>
          {item.kind === 'release' && item.train && item.train.state !== 'waiting' ? <span className={`chip train-chip train-chip-${item.train.state}`} data-train-chip={item.train.state}>{t(`train_chip_${item.train.state}`)}</span> : null}
          <span className="since">{since(item.since, view.now, t)}</span>
        </span>
        <span className="item-title">{itemTitle(item, view, t)}</span>
        <span className="item-line">{itemLine(item, view, t)}</span>
      </a>
      {answers.length > 0 ? (
        <div className="row-answers" role="group" aria-label={t('answers_label', { title: itemTitle(item, view, t) })}>
          {answers.map((act) => (
            <button key={act} type="button" className="row-answer" data-row-act={act} onClick={() => onAnswer?.(item, act)}>{t(act === 'reject_once' ? 'deny' : act)}</button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function Empty({ t }: { readonly t: Translate }) {
  return <p className="empty-state inbox-empty"><Tray size={16} aria-hidden="true" /><span className="empty-text">{t('empty_title')}</span></p>;
}

// What waits, then the handled and the expired items in one folded group,
// "Traité", with its count (plan, 2.5.5). The top bar names the screen: the
// list has no heading of its own (lane 35's art director).
export function List({ view, t, handledOpen = false, onHandled, onAnswer }: {
  readonly view: InboxView; readonly t: Translate; readonly handledOpen?: boolean; readonly onHandled?: () => void; readonly onAnswer?: (item: Item, act: Answer) => void;
}) {
  const { waiting, handled } = ordered(view.items);
  const shown = chosen(view);
  if (view.items.length === 0) return <Empty t={t} />;
  // Under 1024 px the detail is a page of its own: no row is marked shown until one is open.
  const marked = view.narrow && !view.open ? undefined : shown?.id;
  const list = (items: Item[], id?: string) => <ul className="items" id={id}>{items.map((item) => <Card key={item.id} item={item} current={item.id === marked} view={view} t={t} onAnswer={onAnswer} />)}</ul>;
  // An address that names a handled item opens the group, so the item it shows is in view.
  const open = handledOpen || (shown?.state === 'handled' && view.selected === shown.id);
  return (
    <>
      {waiting.length > 0 ? <section aria-labelledby="waiting-title"><h2 className="group-title" id="waiting-title">{t('waiting_group', { n: waiting.length })}</h2>{list(waiting)}</section> : <Empty t={t} />}
      {handled.length > 0 ? (
        <section className="handled-group" id="handled" data-open={String(open)}>
          <h2 className="group-title">
            <button type="button" className="group-toggle" id="handled-toggle" aria-expanded={open} aria-controls="handled-items" onClick={onHandled}>
              <CaretRight size={12} aria-hidden="true" className="caret" />{t('handled_group', { n: handled.length })}
            </button>
          </h2>
          {open ? list(handled, 'handled-items') : null}
        </section>
      ) : null}
    </>
  );
}

// The grace's bar, drawn through the element's style object: the page
// carries no style attribute (no inline style under its Content-Security-Policy).
function GraceFill({ share }: { readonly share: number }) {
  const fill = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (fill.current) fill.current.style.transform = `scaleX(${share})`; }, [share]);
  return <div className="grace-fill" ref={fill} />;
}

const Fact = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => <><dt>{label}</dt><dd>{children}</dd></>;

// The kind, whose item it is, and where to open it: the session, or the
// lead's screen for the lead's items, whose ticket is never shown.
function Eyebrow({ item, kind, open, openKey, t }: { readonly item: Item; readonly kind: string; readonly open: string | undefined; readonly openKey: string; readonly t: Translate }) {
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

// The mark of a service in the train: what it is waiting for, or what became of it.
function StopMark({ stop, train }: { readonly stop: TrainStop; readonly train: TrainState }) {
  const props = { size: 18, 'aria-hidden': true } as const;
  switch (stop.state) {
    case 'healthy': return <CheckCircle {...props} />;
    case 'merged': return <CircleNotch {...props} />;
    case 'failed': return <WarningCircle {...props} />;
    case 'reverted': return <ArrowCounterClockwise {...props} />;
    case 'waiting': return train.state === 'landing' && train.services.find((s) => s.state === 'waiting') === stop ? <ArrowCircleRight {...props} /> : <Circle {...props} />;
  }
}

// A release of several services (decision 21): the services in landing
// order, each with its pull request and its state, the compatibility line,
// and where the train is. The data-* names are what the multi-service proof reads.
function TrainBody({ train, t }: { readonly train: TrainState; readonly t: Translate }) {
  const before = train.state === 'waiting' || train.state === 'blocked';
  return (
    <section className="train" data-train={train.state} aria-label={t('train_label')}>
      <div className="train-head">
        <h3>{t('train_title')}</h3>
        <span className="train-state" data-train-line="">{trainLine(train, t)}</span>
      </div>
      {before ? <p className="train-note">{t('train_order_note')}</p> : null}
      <ol className="stops">
        {train.services.map((stop) => (
          <li key={stop.service} className="stop" data-stop={stop.service} data-state={stop.state}>
            <span className="stop-mark"><StopMark stop={stop} train={train} /></span>
            <span className="stop-body">
              <span className="stop-top">
                <span className="stop-name">{stop.service}</span>
                {stop.pr ? (isWebLink(stop.pr.url) ? <a className="stop-pr" href={stop.pr.url} rel="noopener noreferrer">{t('pr_link', { n: String(stop.pr.number) })}</a> : <span className="stop-pr">{t('pr_link', { n: String(stop.pr.number) })}</span>)
                  : <span className="stop-pr none">{t('train_no_pr')}</span>}
              </span>
              <span className="stop-line"><span className="stop-state">{stopState(stop, train, t)}</span>{stop.at ? <><span className="sep" aria-hidden="true">·</span><time className="stop-time" dateTime={stop.at}>{clock(stop.at)}</time></> : null}</span>
              {stop.note ? <span className="stop-note">{stop.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {train.compatibility ? <p className="compat">{train.compatibility}</p> : null}
    </section>
  );
}

// Why a train cannot be approved, and the way out the service proposes.
function Blocked({ blocked, t }: { readonly blocked: NonNullable<TrainState['blocked']>; readonly t: Translate }) {
  return (
    <div className="blocked" data-blocked="" role="note">
      <p className="blocked-title"><LockSimple size={16} aria-hidden="true" /> {t('blocked_title')}</p>
      <p className="blocked-reason">{blocked.reason}</p>
      <p className="blocked-proposal"><span className="blocked-label">{t('blocked_proposal')}</span> {blocked.proposal}</p>
    </div>
  );
}

// What the author said it changed, by intent, and the flags the diff raised
// (decision 23): a flag is a chip, on the card and on the files it names.
function Changes({ item, t }: { readonly item: ReleaseItem; readonly t: Translate }) {
  const groups = groupsOf(item, t);
  const flags = flagsOf(item);
  if (groups.length === 0 && flags.length === 0) return null;
  return (
    <section className="changes">
      <h3>{t('changes_title')}</h3>
      {flags.length > 0 ? (
        <ul className="flags" aria-label={t('flags_label')}>
          {flags.map((flag) => (
            <li key={flag.kind} className="flag" data-flag={flag.kind}>
              <span className={`flag-chip ${flag.kind}`}>{t(`flag_${flagKey(flag.kind)}`)}</span>
              <span className="flag-note">{t(`flag_${flagKey(flag.kind)}_note`)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {groups.map((group) => (
        <section key={group.key} className="group" data-group={group.key}>
          <h4>{group.intent}</h4>
          <ul className="files">
            {group.files.map((file) => (
              <li key={file.path} data-file={file.path}>
                <code>{file.path}</code>
                {file.flags.map((kind) => <span key={kind} className={`file-flag ${kind}`} data-file-flag={kind}>{t(`flag_${flagKey(kind)}`)}</span>)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function ReleaseBody({ item, view, t, onFrame }: { readonly item: ReleaseItem; readonly view: InboxView; readonly t: Translate; readonly onFrame?: (frame: InboxView['frame']) => void }) {
  const open = releaseSession(view, item.ticket);
  const pr = t('pr_link', { n: String(item.pr.number) });
  const { train } = item;
  // A train with no picture of its screens shows none; a release of one
  // service keeps milestone 1's frames, empty or not.
  const pictures = !train || [item.captures.before, item.captures.after].some((c) => c.desktop || c.phone);
  const waits = item.state === 'waiting' && approvable(item);
  const repair = repairLine(item, t);
  return (
    <>
      <Eyebrow item={item} kind={t(waits ? 'eyebrow_release' : 'kind_release')} open={open && sessionLink(open.id)} openKey="open_sessions" t={t} />
      <h2 className="d-title">{item.title}</h2>
      {item.announcement ? <p className="announce">{item.announcement}</p> : null}
      {train?.blocked ? <Blocked blocked={train.blocked} t={t} /> : null}
      {train ? <TrainBody train={train} t={t} /> : null}
      <Changes item={item} t={t} />
      {pictures ? <Shots item={item} view={view} t={t} onFrame={onFrame} /> : null}
      <dl className="facts">
        {item.sessions.length > 0 ? <Fact label={t('facts_sessions')}>{sessionsLine(item, t)}</Fact> : null}
        {repair ? <Fact label={t('facts_repair')}><span data-repair={item.repair?.state}>{repair}</span></Fact> : null}
        {train ? <Fact label={t('facts_checks')}>{t(`checks_${CHECKS[item.pr.checks]}`)}</Fact> : (
          <Fact label={t('facts_change')}>
            {isWebLink(item.pr.url) ? <a href={item.pr.url} rel="noopener noreferrer">{pr}</a> : pr}
            <span className="sep" aria-hidden="true">·</span><span>{t(`checks_${CHECKS[item.pr.checks]}`)}</span>
          </Fact>
        )}
      </dl>
    </>
  );
}

function Shots({ item, view, t, onFrame }: { readonly item: ReleaseItem; readonly view: InboxView; readonly t: Translate; readonly onFrame?: (frame: InboxView['frame']) => void }) {
  return (
    <>
      <div className="shots-head">
        <h3>{t('shots_title')}</h3>
        <div className="switch" role="group" aria-label={t('frame_label')}>
          {(['desktop', 'phone'] as const).map((frame) => <Toggle key={frame} data-frame={frame} pressed={view.frame === frame} onPressedChange={() => onFrame?.(frame)}>{t(`frame_${frame}`)}</Toggle>)}
        </div>
      </div>
      <div className={`shots frame-${view.frame}`}><Shot item={item} side="before" frame={view.frame} t={t} /><Shot item={item} side="after" frame={view.frame} t={t} /></div>
    </>
  );
}

// A permission (plan, 2.5.1 to 2.5.4): the question, the ticket, the three
// answers before anything else, at every width; then why it asks, who asks,
// and the command folded, one part per line, with the harness's and the
// policy's own words when the app has none of its own.
function PermissionBody({ item, view, t, note, reason, onReason, onAct }: {
  readonly item: PermissionItem; readonly view: InboxView; readonly t: Translate; readonly note: string; readonly reason: string;
  readonly onReason?: (value: string) => void; readonly onAct?: Act;
}) {
  const session = sessionOf(view, item.sessionId);
  const title = ticketTitle(view, item.ticket);
  const why = reasonOf(item, t);
  const fold = foldOf(item);
  const description = item.input.kind === 'execute' ? item.input.description : undefined;
  const facts = [
    why.said ? <Fact key="why" label={t('facts_why')}>{why.said}</Fact> : null,
    session ? <Fact key="session" label={t('facts_session')}>{pausedLine(item, session, view.now, t)}</Fact> : null,
  ].filter(Boolean);
  return (
    <>
      <Eyebrow item={item} kind={t('eyebrow_permission')} open={sessionLink(item.sessionId)} openKey="open_session" t={t} />
      <h2 className="d-title d-ask">{item.state === 'waiting' ? permissionAsk(item, view, t) : permissionTitle(item, t)}</h2>
      {title ? <p className="d-ticket">{title}</p> : null}
      <div className="d-answers" id="d-answers"><PermissionAnswers item={item} view={view} t={t} note={note} reason={reason} onReason={onReason} onAct={onAct} /></div>
      {facts.length ? <dl className="facts">{facts}</dl> : null}
      {fold.length > 0 || why.raw || description ? (
        <details className="fold" id="fold" open={foldOpen(item)}>
          <summary>
            <CaretRight size={12} aria-hidden="true" className="caret" /><span className="fold-label">{t(item.input.kind === 'execute' ? 'fold_command' : 'fold_target')}</span>
            <code className="fold-peek">{fold[0]?.text ?? ''}</code>{fold.length > 1 ? <span className="fold-more">{t(fold.length === 2 ? 'fold_more_one' : 'fold_more_other', { n: fold.length - 1 })}</span> : null}
          </summary>
          {fold.length > 0 ? <pre className="fold-command"><code>{fold.map((part, index) => <span key={index} className="fold-line">{part.op ? <><span className="op">{part.op}</span>{' '}</> : null}{part.text}{'\n'}</span>)}</code></pre> : null}
          {description || why.raw ? (
            <dl className="facts fold-facts">
              {description ? <Fact label={t('facts_what_for')}>{description}</Fact> : null}
              {why.raw ? <Fact label={t('fold_policy')}>{why.raw}</Fact> : null}
            </dl>
          ) : null}
        </details>
      ) : null}
    </>
  );
}

// The three answers of a request, or what became of it.
function PermissionAnswers({ item, view, t, note, reason, onReason, onAct }: {
  readonly item: PermissionItem; readonly view: InboxView; readonly t: Translate; readonly note: string; readonly reason: string;
  readonly onReason?: (value: string) => void; readonly onAct?: Act;
}) {
  const local = view.local.get(item.id);
  const busy = local?.kind === 'busy';
  const status = <p className="d-note" id="d-note" role="status">{note}</p>;
  if (local?.kind === 'settled') return <><p className="d-done">{t('settled')}</p>{status}</>;
  if (local?.kind === 'answered') return <><p className="d-done" id="d-done">{t(`answered_${local.decision}`)}</p>{status}</>;
  // While an answer is on its way the cache already shows the item handled: the answers stay, disabled, until it lands.
  if (item.state === 'handled' && !busy) return <><p className="d-done">{t('handled_note')}</p>{status}</>;
  const act = (name: Answer, primary: boolean) => (
    <Button variant={primary ? 'ink' : 'outline'} className={primary ? 'btn primary' : 'btn'} data-act={name} disabled={busy} onClick={() => onAct?.(name)}
      aria-keyshortcuts={ANSWER_KEY[name]}>
      <span>{t(name === 'reject_once' ? 'deny' : name)}</span><kbd aria-hidden="true">{ANSWER_KEY[name]}</kbd>
    </Button>
  );
  return (
    <>
      <div className="d-buttons answers">{act('allow_once', true)}{act('allow_always', false)}{act('reject_once', false)}</div>
      <label className="deny-reason" htmlFor="deny-reason"><span className="sr-only">{t('deny_reason')}</span>
        <Input id="deny-reason" type="text" maxLength={2000} autoComplete="off" placeholder={t('deny_reason')} disabled={busy} value={reason} onChange={(event) => onReason?.(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onAct?.('reject_once'); } }} />
      </label>
      {status}
    </>
  );
}

const ANSWER_KEY: Readonly<Record<Answer, string>> = { allow_once: 'A', allow_always: 'T', reject_once: 'R' };

// What the person picked and typed: the clickable answers' draft, kept by
// the detail with its other fields and sent from the bar.
type Answers = ChoiceDraft;

function QuestionBody({ item, view, t, answers, onDraft, onAnswer }: {
  readonly item: QuestionItem; readonly view: InboxView; readonly t: Translate; readonly answers: Answers; readonly onDraft?: (draft: Answers) => void;
  readonly onAnswer?: (draft: Answers) => void;
}) {
  // The lead's question is read here and answered on the lead's screen.
  const lead = isLead(item);
  const waiting = item.state === 'waiting' && !lead;
  const title = lead ? undefined : ticketTitle(view, item.ticket);
  const busy = view.local.get(item.id)?.kind === 'busy';
  const deadline = deadlineLine(item, view.now, t);
  return (
    <>
      {lead ? <Eyebrow item={item} kind={t('eyebrow_lead_question')} open={undefined} openKey="" t={t} />
        : <Eyebrow item={item} kind={t('eyebrow_question')} open={sessionLink(item.sessionId)} openKey="open_session" t={t} />}
      <h2 className="sr-only">{t('kind_question')}</h2>
      {/* The question first, on the colour of what waits; the ticket under it (DESIGN.md, 4). */}
      <div className={`questions${item.state === 'waiting' ? ' waits' : ''}${lead ? ' read' : ''}`}>
        {/* A click on the only choice of one question answers it, as the bar's Send would (issue #269). */}
        <Choices questions={item.questions} t={t} requestId={item.requestId} send="bar" free={waiting}
          status={waiting ? { kind: 'waiting', draft: answers, busy } : { kind: 'read' }} onDraft={onDraft}
          onAnswer={onAnswer ? (_answers, chosen) => onAnswer({ picks: [chosen], free: [''] }) : undefined} />
      </div>
      {title ? <p className="d-ticket for-question">{title}</p> : null}
      {deadline ? <p className="d-deadline">{deadline}</p> : null}
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
  if (plan) return <>{head}<PlanPanel plan={plan} t={t} options={{ language, actions: false, services: true }} /></>;
  return (
    <>
      {head}
      <h2 className="d-title">{item.title}</h2>
      <p className="announce">{item.summary}</p>
      <dl className="facts">
        <Fact label={t('facts_tickets')}>{t(item.itemCount === 1 ? 'tickets_one' : 'tickets_other', { n: item.itemCount })}</Fact>
        <Fact label={t('facts_work')}>{t('plan_work', { time: estimate(item.totals.minutes, t) })}</Fact>
        <Fact label={t('facts_share')}>{shareLine(item.totals, language, t)}</Fact>
      </dl>
    </>
  );
}

// An author's session plan waiting for its Go (decision 22): what it means
// to do and to touch, how sure it is and why, and who let it start.
function SessionPlanBody({ item, view, t }: { readonly item: SessionPlanItem; readonly view: InboxView; readonly t: Translate }) {
  const { plan } = item;
  const session = sessionOf(view, item.sessionId);
  const waiting = item.state === 'waiting';
  return (
    <>
      <Eyebrow item={item} kind={t(waiting ? 'eyebrow_session_plan' : 'kind_session_plan')} open={sessionLink(item.sessionId)} openKey="open_session" t={t} />
      <h2 className="d-title">{itemTitle(item, view, t)}</h2>
      {item.service ? <p className="d-ticket">{t('on_service', { service: item.service })}</p> : null}
      <div className="confidence" data-confidence={plan.confidence}>
        <span className="confidence-chip">{t(`confidence_${plan.confidence}`)}</span>
        <p className="confidence-reason">{plan.reason}</p>
        {waiting ? <p className="confidence-rule">{t(plan.confidence === 'high' ? 'confidence_starts' : 'confidence_waits')}</p> : null}
      </div>
      <h3 className="d-sub">{t('plan_steps')}</h3>
      <ol className="plan-steps">{plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      {plan.files.length > 0 ? <><h3 className="d-sub">{t('plan_files')}</h3><ul className="plan-files">{plan.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></> : null}
      <dl className="facts">
        {session ? <Fact label={t('facts_session')}>{pausedLine(item, session, view.now, t)}</Fact> : null}
        <Fact label={t('facts_proposed')}><time dateTime={plan.proposedAt}>{clock(plan.proposedAt)}</time></Fact>
      </dl>
    </>
  );
}

// A contract step's change to its service's contract (decision 26): the
// diff, validated with Approve or sent back with a message; the steps after
// it wait for it. A knowledge item (decision 27): the text and its level,
// approved into the memory or rejected.
function ContractBody({ item, view, t }: { readonly item: ContractItem; readonly view: InboxView; readonly t: Translate }) {
  const title = ticketTitle(view, item.ticket);
  return (
    <>
      <Eyebrow item={item} kind={t(item.state === 'waiting' ? 'eyebrow_contract' : 'kind_contract')} open={sessionLink(item.sessionId)} openKey="open_session" t={t} />
      <h2 className="d-title">{t('contract_of', { service: item.service })}</h2>
      <p className="d-ticket"><code>{item.path}</code>{title ? <><span className="sep" aria-hidden="true">·</span>{title}</> : null}</p>
      {item.state === 'waiting' ? <p className="decide-rule">{t('contract_rule')}</p> : null}
      <h3 className="d-sub">{t('contract_diff')}</h3>
      <Diff diff={item.diff} />
    </>
  );
}

// A diff, its added and removed lines coloured.
function Diff({ diff, label }: { readonly diff: string; readonly label?: string }) {
  return (
    <pre className="diff" {...(label ? { 'aria-label': label, tabIndex: 0 } : {})}><code>{diff.split('\n').map((line, index) => (
      <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : undefined}>{line}{'\n'}</span>
    ))}</code></pre>
  );
}

// The variants of one ticket side by side (issue #271): each one's state,
// files, lines, cost and time, and its diff; a variant that is done is
// chosen for the review from its own column, and the others stop.
function VariantsBody({ item, view, t, busy, onAct }: { readonly item: VariantsItem; readonly view: InboxView; readonly t: Translate; readonly busy: boolean; readonly onAct?: Act }) {
  const title = ticketTitle(view, item.ticket);
  const waits = item.state === 'waiting' && view.local.get(item.id)?.kind !== 'chosen';
  return (
    <>
      <Eyebrow item={item} kind={t(item.state === 'waiting' ? 'eyebrow_variants' : 'kind_variants')} open={undefined} openKey="open_session" t={t} />
      <h2 className="d-title">{title ?? item.ticket}</h2>
      <p className="d-ticket">{t('variants_of', { n: item.variants.length })}</p>
      {waits ? <p className="decide-rule">{t(item.pick ? 'variants_pick_rule' : 'variants_rule')}</p> : null}
      <div className="variants" data-count={item.variants.length}>
        {item.variants.map((variant) => <VariantColumn key={variant.position} variant={variant} view={view} t={t} pick={item.pick === true} choosable={waits && variant.state === 'done'} busy={busy} onAct={onAct} />)}
      </div>
    </>
  );
}

// In a harness pick (issue #329), a column also names its agent and says its own run of the tests.
function VariantColumn({ variant, view, t, pick, choosable, busy, onAct }: { readonly variant: TicketVariant; readonly view: InboxView; readonly t: Translate; readonly pick: boolean; readonly choosable: boolean; readonly busy: boolean; readonly onAct?: Act | undefined }) {
  const name = t('variant_name', { n: variant.position });
  const id = `variant-${variant.position}`;
  const tests = pick ? variantTests(variant, t) : null;
  return (
    <section className="variant" data-state={variant.state} aria-labelledby={id}>
      <header className="variant-head">
        <h3 className="d-sub" id={id}>{name}</h3>
        <span className={`variant-state ${variant.state}`}>{variant.state === 'running' ? <CircleNotch size={12} aria-hidden="true" /> : variant.state === 'failed' ? <WarningCircle size={12} aria-hidden="true" /> : variant.state === 'chosen' ? <CheckCircle size={12} aria-hidden="true" /> : null}{t(`variant_${variant.state}`)}</span>
      </header>
      {pick ? <p className="variant-harness" data-harness={variant.harness}>{variantHarness(variant, t)}</p> : null}
      {tests ? <p className={`variant-tests ${variant.tests}`} data-tests={variant.tests}>{tests}</p> : null}
      {variant.session ? <a className="d-link" href={sessionLink(variant.session)}>{t('open_session')}</a> : null}
      {variant.state === 'done' || variant.state === 'chosen' || (variant.state === 'dropped' && variant.diff !== '') ? (
        <>
          <p className="variant-facts">{variantFacts(variant, view, t).join(' · ')}</p>
          {variant.files.length > 0 ? <ul className="variant-files">{variant.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : null}
          {variant.diff !== '' ? <Diff diff={variant.diff} label={t('variant_diff_label', { n: variant.position })} /> : <p className="variant-note">{t('variant_no_diff')}</p>}
          {variant.cut ? <p className="variant-note">{t('variant_cut')}</p> : null}
        </>
      ) : null}
      {variant.note && variant.state !== 'dropped' ? <p className="variant-note">{variant.note}</p> : null}
      {choosable ? (
        <Button variant="ink" className="btn primary" data-act={`variant_choose_${variant.position}`} disabled={busy} onClick={() => onAct?.(`variant_choose_${variant.position}`)}>
          {t('variant_choose', { n: variant.position })}
        </Button>
      ) : null}
    </section>
  );
}

function KnowledgeBody({ item, t }: { readonly item: KnowledgeItem; readonly t: Translate }) {
  const level = item.level === 'workspace' || !item.service ? t('level_workspace') : t(`level_${item.level}`, { service: item.service });
  return (
    <>
      <Eyebrow item={item} kind={t(item.state === 'waiting' ? 'eyebrow_knowledge' : 'kind_knowledge')} open={sessionLink(item.sessionId)} openKey="open_session" t={t} />
      <h2 className="sr-only">{t('kind_knowledge')}</h2>
      <p className="announce knowledge-text">{item.text}</p>
      <dl className="facts"><Fact label={t('facts_level')}>{level}</Fact></dl>
      {item.state === 'waiting' ? <p className="decide-rule">{t('knowledge_rule')}</p> : null}
    </>
  );
}

export type Act = (act: string) => void;

// The bottom of the detail: what the person can do now, or what they did.
export function Actions({ item, view, t, note = '', reason = '', ready = false, message = '', onAct, onReason, onMessage }: {
  readonly item: Item; readonly view: InboxView; readonly t: Translate; readonly note?: string; readonly reason?: string; readonly ready?: boolean;
  readonly message?: string; readonly onAct?: Act; readonly onReason?: (value: string) => void; readonly onMessage?: (value: string) => void;
}) {
  // A permission's answers and what became of it are at the top of its detail (PermissionAnswers).
  if (item.kind === 'permission') return null;
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
  if (local?.kind === 'closed') return done(t('closed_done', { time: clock(local.at) }));
  if (local?.kind === 'plan_approved') return done(t('approved_plan', { time: clock(local.at) }));
  if (local?.kind === 'plan_go') return done(t('plan_go_done', { time: clock(local.at) }));
  if (local?.kind === 'plan_changed') return done(t('plan_changed_done', { time: clock(local.at) }));
  if (local?.kind === 'decided' && (item.kind === 'contract' || item.kind === 'knowledge')) return done(decidedLine(local, item, t));
  if (local?.kind === 'chosen') return done(t('variant_chosen_done', { n: local.position, time: clock(local.at) }));
  if (item.state === 'handled') {
    if (item.kind === 'release' && item.outcome) return done(outcomeLine(item, view, t));
    if (item.kind === 'release' && item.train) return done(t('train_no_approval', { text: trainLine(item.train, t) }));
    if (item.kind === 'contract' || item.kind === 'knowledge') return done(outcomeLine(item, view, t));
    if (item.kind === 'variants') return done(chosenLine(item, view, t));
    return done(item.kind === 'session_plan' && item.plan.go ? goLine(item.plan.go, view, t) : t('handled_note'));
  }
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
              <div className="grace-track" role="presentation"><GraceFill share={Math.min(1, left / (GRACE_MS / 1000))} /></div>
              <span className="grace-text" aria-label={t('grace_label')}>{t('grace_text', { n: left })}</span>{act('undo', t('undo'), true)}
            </div>
            {status}
          </>
        );
      }
      // Close asks why: the reason is mandatory, and the card stays in the history with it.
      if (local?.kind === 'close' || (busy && message !== '')) {
        return (
          <>
            <p className="decide-rule">{t('close_rule')}</p>
            <label className="change-field" htmlFor="close-message"><span className="sr-only">{t('close_field')}</span>
              <Textarea id="close-message" maxLength={CLOSE_REASON_MAX} rows={2} autoComplete="off" placeholder={t('close_field')} disabled={busy} value={message} onChange={(event) => onMessage?.(event.target.value)} />
            </label>
            <div className="d-buttons">{act('close_keep', t('close_keep'), false, busy)}{act('close_send', t('close_send'), true, busy)}</div>
            {status}
          </>
        );
      }
      if (local?.kind === 'confirm') return <><p className="d-confirm">{t('confirm_send_back')}</p><div className="d-buttons">{act('keep', t('keep'))}{act('send_back_confirm', t('send_back_confirm'), true)}</div>{status}</>;
      // A blocked train can still be sent back, or completed by the lead;
      // a train that lands or landed was approved already.
      if (item.train?.blocked || item.train?.state === 'blocked') {
        return <><p className="d-done">{t('blocked_done')}</p><div className="d-buttons">{act('close', t('close'), false, busy)}{act('send_back', t('send_back'), false, busy)}<Button asChild variant="ink" className="btn primary ask-lead"><a href="/lead">{t('ask_lead')}</a></Button></div>{status}</>;
      }
      if (item.train && !approvable(item)) return done(t('train_no_approval', { text: trainLine(item.train, t) }));
      const versions = item.heads.map((h) => t('version', { pr: String(h.pr), head: h.head })).join(', ');
      const first = item.heads[0];
      // A train's approval names its number of pull requests, on one line.
      const label = item.heads.length > 1 ? <span>{t('approve_count', { n: item.heads.length })}</span>
        : <><span>{t('approve')}</span>{first ? <span className="commit">{short(first.head)}</span> : null}</>;
      return <>{signed}<div className="d-buttons">{act('close', t('close'), false, busy)}{act('send_back', t('send_back'), false, busy)}{act('approve', label, true, busy, { 'aria-label': t('approve_label', { versions }), title: versions })}</div>{status}</>;
    }
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
    case 'session_plan':
      // Change asks what to change; the message reopens the author.
      if (local?.kind === 'change' || (busy && message !== '')) {
        return (
          <>
            <label className="change-field" htmlFor="plan-change"><span className="sr-only">{t('plan_change_field')}</span>
              <Textarea id="plan-change" maxLength={CHANGE_MAX} rows={2} autoComplete="off" placeholder={t('plan_change_field')} disabled={busy} value={message} onChange={(event) => onMessage?.(event.target.value)} />
            </label>
            <div className="d-buttons">{act('plan_keep', t('plan_keep'), false, busy)}{act('plan_change_send', t('plan_change_send'), true, busy)}</div>
            {status}
          </>
        );
      }
      return <>{signed}<div className="d-buttons">{act('plan_change', t('plan_change_open'), false, busy)}{act('plan_go', t('plan_go'), true, busy, { 'aria-label': t('plan_go_label') })}</div>{status}</>;
    case 'contract':
      // Send back asks what to change; the message reopens the contract step.
      if (local?.kind === 'change' || (busy && message !== '')) {
        return (
          <>
            <label className="change-field" htmlFor="contract-message"><span className="sr-only">{t('contract_send_back_field')}</span>
              <Textarea id="contract-message" maxLength={SEND_BACK_MAX} rows={2} autoComplete="off" placeholder={t('contract_send_back_field')} disabled={busy} value={message} onChange={(event) => onMessage?.(event.target.value)} />
            </label>
            <div className="d-buttons">{act('contract_keep', t('contract_keep'), false, busy)}{act('contract_send_back_send', t('contract_send_back_send'), true, busy)}</div>
            {status}
          </>
        );
      }
      return <>{signed}<div className="d-buttons">{act('contract_send_back', t('send_back'), false, busy)}{act('contract_approve', t('contract_approve'), true, busy)}</div>{status}</>;
    case 'knowledge':
      return <>{signed}<div className="d-buttons">{act('knowledge_reject', t('knowledge_reject'), false, busy)}{act('knowledge_approve', t('knowledge_approve'), true, busy)}</div>{status}</>;
    // Each done variant is chosen from its own column.
    case 'variants':
      return <>{signed}<p className="d-done">{item.variants.some((v) => v.state === 'done') ? t('variants_choose_one') : t('variants_none_done')}</p>{status}</>;
  }
}

const noAnswers = (item: Item | undefined): Answers => emptyDraft(item?.kind === 'question' ? item.questions : []);

// The detail of the item shown. Its fields (a reason, the choices, a free
// answer) live as long as what it shows: the screen keys it by detailKey,
// so a refresh that changes nothing shown loses nothing being typed.
// A Change's message is kept by the screen, not the detail: the detail is
// drawn again when the call starts, and a refused Change keeps its text.
export function Detail({ view, t, note = '', message = '', onAct, onFrame, onMessage }: {
  readonly view: InboxView; readonly t: Translate; readonly note?: string; readonly message?: string;
  readonly onAct?: (act: string, given: Given) => void; readonly onFrame?: (frame: InboxView['frame']) => void; readonly onMessage?: (value: string) => void;
}) {
  const item = chosen(view);
  const [reason, setReason] = useState('');
  const [answers, setAnswers] = useState<Answers>(() => noAnswers(item));
  const back = <a className="back" href="#" aria-label={t('back_label')}><ArrowLeft size={14} aria-hidden="true" /> {t('back')}</a>;
  if (!item) return <>{back}<div className="d-body"><p className="empty">{t('gone')}</p></div></>;
  const ready = item.kind === 'question' && answersFor(item.questions, answers.picks, answers.free).answers !== undefined;
  return (
    <>
      {back}
      <div className="d-body" data-kind={item.kind}>
        {item.kind === 'release' ? <ReleaseBody item={item} view={view} t={t} onFrame={onFrame} />
          : item.kind === 'permission' ? <PermissionBody item={item} view={view} t={t} note={note} reason={reason} onReason={setReason} onAct={(act) => onAct?.(act, { reason, answers, message })} />
          : item.kind === 'plan' ? <PlanBody item={item} view={view} t={t} />
          : item.kind === 'session_plan' ? <SessionPlanBody item={item} view={view} t={t} />
          : item.kind === 'contract' ? <ContractBody item={item} view={view} t={t} />
          : item.kind === 'knowledge' ? <KnowledgeBody item={item} t={t} />
          : item.kind === 'variants' ? <VariantsBody item={item} view={view} t={t} busy={view.local.get(item.id)?.kind === 'busy'} onAct={(act) => onAct?.(act, { reason, answers, message })} />
          : <QuestionBody item={item} view={view} t={t} answers={answers} onDraft={setAnswers}
              onAnswer={onAct ? (draft) => { setAnswers(draft); onAct('answer', { reason, answers: draft, message }); } : undefined} />}
      </div>
      <div className="d-actions" id="d-actions">
        <Actions item={item} view={view} t={t} note={note} reason={reason} ready={ready} message={message} onReason={setReason} onMessage={onMessage}
          onAct={(act) => onAct?.(act, { reason, answers, message })} />
      </div>
    </>
  );
}

type Given = { readonly reason: string; readonly answers: Answers; readonly message: string };

export function InboxScreen({ view, t, note = '', message = '', onAct, onFrame, onMessage, detailRef, handledOpen, onHandled, onAnswer, said = '' }: {
  readonly view: InboxView; readonly t: Translate; readonly note?: string; readonly message?: string; readonly said?: string;
  readonly onAct?: (act: string, given: Given) => void; readonly onFrame?: (frame: InboxView['frame']) => void; readonly onMessage?: (value: string) => void;
  readonly detailRef?: Ref<HTMLElement>; readonly handledOpen?: boolean; readonly onHandled?: () => void; readonly onAnswer?: (item: Item, act: Answer) => void;
}) {
  const list = <List view={view} t={t} handledOpen={handledOpen} onHandled={onHandled} onAnswer={onAnswer} />;
  // What an answer did, said once, from outside the detail (which is drawn again with it).
  const live = <p className="sr-only" role="status" id="inbox-live">{said}</p>;
  if (view.items.length === 0) return <div className="inbox empty-inbox" data-open="false"><aside className="inbox-list" id="inbox-list" aria-label={t('list_label')}>{list}</aside>{live}</div>;
  return (
    <div className="inbox" data-open={String(view.open)}>
      {live}
      <aside className="inbox-list" id="inbox-list" aria-label={t('list_label')}>{list}</aside>
      <section className="detail" id="detail" tabIndex={-1} aria-label={t('detail_label')} ref={detailRef}>
        <Detail key={detailKey(view)} view={view} t={t} note={note} message={message} onAct={onAct} onFrame={onFrame} onMessage={onMessage} />
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
  const [data, setData] = useKept<Data | undefined>('inbox', undefined);
  const [failed, setFailed] = useState(false);
  const [local, setLocal] = useState<ReadonlyMap<string, Local>>(restore);
  const [plans, setPlans] = useKept<ReadonlyMap<string, Plan>>('inbox-plans', new Map());
  // On a phone the captures start in their phone frame; the switch changes the frame only.
  const [frame, setFrame] = useState<InboxView['frame']>(() => (window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop'));
  const [hash, setHash] = useState(() => location.hash);
  // From ROW_ANSWERS_MIN a request's row carries its answers; the group of what was handled opens on a click.
  const [wide, setWide] = useState(() => window.matchMedia(`(min-width: ${ROW_ANSWERS_MIN}px)`).matches);
  const [handledOpen, setHandledOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  const [said, setSaid] = useState('');
  const peeking = useRef(false);
  const [now, setNow] = useState(() => context.now());
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
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
        api<unknown[]>('/inbox').then(known), api<Ticket[]>('/tickets').catch(() => []), api<SessionSummary[]>('/sessions').catch(() => []),
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
  }, [api, change, setData, setPlans]);

  // Drawn from the cache, then again each time a resource it read changes.
  useEffect(() => { void load(); }, [load]);
  useLive(() => void load());

  const selected = itemFromHash(hash);
  const view: InboxView | undefined = data && {
    ...data, selected, open: selected !== undefined, me: context.me.user, now, local, frame, plans, language: context.me.language, wide, narrow,
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
    const media = window.matchMedia(`(min-width: ${ROW_ANSWERS_MIN}px)`);
    const small = window.matchMedia('(max-width: 1023px)');
    const onWidth = () => { setWide(media.matches); setNarrow(small.matches); };
    media.addEventListener('change', onWidth);
    small.addEventListener('change', onWidth);
    return () => { media.removeEventListener('change', onWidth); small.removeEventListener('change', onWidth); };
  }, []);

  useEffect(() => {
    const onHash = () => {
      setHash(location.hash);
      setNote('');
      setMessage('');
      // A peek (Space on a row) shows the item and leaves the focus on the row;
      // a row's answer gives it to the answer's line.
      if (peeking.current) { peeking.current = false; return; }
      if (itemFromHash(location.hash) !== undefined) {
        queueMicrotask(() => detail.current?.focus({ preventScroll: true }));
        if (window.matchMedia('(max-width: 1023px)').matches) window.scrollTo(0, 0);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The inbox's own keys (SCREEN_KEYS.inbox): A, T and R press the answer of
  // the request shown, Space peeks at the row walked to; Esc leaves the item,
  // never from a field (the text typed there stays). Handled here, the shell
  // leaves them alone (preventDefault).
  // Once the answer is drawn, the detail takes the focus (the pressed button
  // is gone with the answers); the detail's inside is drawn again when the
  // cache moves the item to what was handled, the detail itself stays.
  const focusDone = useRef(false);
  useLayoutEffect(() => {
    if (!focusDone.current || !document.getElementById('d-done')) return;
    focusDone.current = false;
    detail.current?.focus({ preventScroll: true });
  });

  const keyState = useRef({ shown: undefined as Item | undefined, visible: false, busy: false });
  useEffect(() => {
    let lastG = -Infinity;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const afterG = performance.now() - lastG <= CHORD_MS;
      lastG = event.key.toLowerCase() === 'g' && !event.metaKey && !event.ctrlKey && !event.altKey ? performance.now() : -Infinity;
      const focus = focusOf(event.target);
      if (event.key === 'Escape') {
        if (location.hash && closesOnEscape(focus) && !document.querySelector('.overlay')) location.hash = '';
        return;
      }
      const row = (event.target as Element | null)?.closest?.('#inbox-list a.item');
      const onRow = row instanceof HTMLAnchorElement;
      const read = inboxKey(
        {
          key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, focus, onRow, overlay: document.querySelector('.overlay') !== null, afterG,
          rowShown: onRow && row.getAttribute('data-item') === keyState.current.shown?.id, beside: window.matchMedia('(min-width: 1024px)').matches,
        },
        { item: keyState.current.shown, visible: keyState.current.visible, busy: keyState.current.busy },
      );
      if (!read) return;
      event.preventDefault();
      if (read.kind === 'peek' && row instanceof HTMLAnchorElement) {
        peeking.current = location.hash !== row.hash;
        location.hash = row.hash;
      } else if (read.kind === 'answer') document.querySelector<HTMLButtonElement>(`#detail [data-act="${read.act}"]`)?.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const act = async (item: Item, gesture: Gesture, run: () => Promise<Local | undefined>) => {
    const before = localRef.current.get(item.id);
    change((next) => next.set(item.id, { kind: 'busy' }));
    try {
      const after = await run();
      change((next) => { if (after) next.set(item.id, after); else next.delete(item.id); });
      setNote('');
      // The answer is said once, and the detail that shows it takes the focus.
      if (after?.kind === 'answered') {
        setSaid(t(`answered_${after.decision}`));
        focusDone.current = true;
      }
      if (gesture === 'plan_change' || gesture === 'contract_send_back' || gesture === 'close') setMessage('');
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
      // A request settled without the person says so once, on the detail's line ("Réglé depuis la session.").
      const quiet = settled && gesture === 'answer';
      setNote(quiet ? '' : t(key));
      if (gesture === 'answer') setSaid(t(quiet ? 'settled' : key));
      // A Change whose plan no longer waits has nowhere to go: its text is dropped.
      if (settled && (gesture === 'plan_change' || gesture === 'contract_send_back')) setMessage('');
      if (settled) context.inboxChanged();
      if (settled || key === 'approve_conflict' || gesture === 'approve_plan') {
        await load();
        const plan = item.kind === 'plan' ? plansRef.current.get(item.planId) : undefined;
        const after = afterPlanRefusal(key, plan);
        setNote(quiet ? '' : t(after));
        if (after !== key) context.inboxChanged();
      }
    }
  };

  const onAct = (name: string, given: Given, item: Item | undefined = shown) => {
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
      case 'close':
        change((next) => next.set(item.id, { kind: 'close' }));
        return;
      case 'close_keep':
        change((next) => next.delete(item.id));
        setMessage('');
        setNote('');
        return;
      case 'close_send': {
        const checked = closeReason(given.message);
        if ('error' in checked) { setNote(t(checked.error, { n: CLOSE_REASON_MAX })); return; }
        void act(item, 'close', () => closeTicket(api, item.ticket, checked.reason, context.now()));
        return;
      }
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
      case 'plan_go':
        if (item.kind === 'session_plan') void act(item, 'plan_go', () => planGo(api, item, context.now()));
        return;
      case 'plan_change':
        change((next) => next.set(item.id, { kind: 'change' }));
        return;
      case 'plan_keep':
        change((next) => next.delete(item.id));
        setMessage('');
        setNote('');
        return;
      case 'plan_change_send': {
        if (item.kind !== 'session_plan') return;
        const checked = changeMessage(given.message);
        if ('error' in checked) { setNote(t(checked.error, { n: CHANGE_MAX })); return; }
        void act(item, 'plan_change', () => planChange(api, item, checked.message, context.now()));
        return;
      }
      case 'contract_approve':
        if (item.kind === 'contract') void act(item, 'contract_approve', () => approveContract(api, item, context.now()));
        return;
      case 'contract_send_back':
        change((next) => next.set(item.id, { kind: 'change' }));
        return;
      case 'contract_keep':
        change((next) => next.delete(item.id));
        setMessage('');
        setNote('');
        return;
      case 'contract_send_back_send': {
        if (item.kind !== 'contract') return;
        const checked = sendBackMessage(given.message);
        if ('error' in checked) { setNote(t(checked.error, { n: SEND_BACK_MAX })); return; }
        void act(item, 'contract_send_back', () => sendBackContract(api, item, checked.message, context.now()));
        return;
      }
      case 'knowledge_approve': case 'knowledge_reject':
        if (item.kind === 'knowledge') void act(item, name as 'knowledge_approve' | 'knowledge_reject', () => (name === 'knowledge_approve' ? approveKnowledge : rejectKnowledge)(api, item, context.now()));
        return;
      case 'variant_choose_1': case 'variant_choose_2': case 'variant_choose_3': case 'variant_choose_4':
        if (item.kind === 'variants') void act(item, 'variant_choose', () => chooseVariant(api, item, Number(name.slice('variant_choose_'.length)), context.now()));
        return;
      case 'allow_once': case 'allow_always': case 'reject_once':
        if (item.kind === 'permission') void act(item, 'answer', () => answerRequest(api, item, decisionFor(name, given.reason, t)));
        return;
      case 'answer': {
        if (item.kind !== 'question') return;
        const result = answersFor(item.questions, given.answers.picks, given.answers.free);
        if (result.missing !== undefined) { setNote(t('answer_missing')); return; }
        if (result.tooLong !== undefined) { setNote(t('choice_too_long', { n: FREE_MAX })); return; }
        void act(item, 'answer', () => answerRequest(api, item, { kind: 'answer', answers: result.answers }));
        return;
      }
      default:
    }
  };

  // The detail is in view beside the list from 1024 px, or as its own page once an item is open.
  keyState.current = { shown, visible: view !== undefined && (view.open || window.matchMedia('(min-width: 1024px)').matches), busy: shownLocal !== undefined };
  if (!view) {
    return failed
      ? <div className="inbox-error"><p className="empty error inbox-failed"><span>{t('inbox_load_failed')}</span><button type="button" className="chip-button" onClick={() => { setFailed(false); void load(); }}>{t('inbox_retry')}</button></p></div>
      : <div className="inbox-loading" aria-busy="true" />;
  }
  // A row's answer is the detail's, given with no reason (a deny's reason is
  // typed in the detail); the item is shown at once, so what it did, or why it
  // failed, is said on that item.
  const onAnswer = (item: Item, act: Answer) => {
    if (location.hash !== `#${encodeURIComponent(item.id)}`) {
      peeking.current = true;                        // the answer's line takes the focus, not the detail
      location.hash = encodeURIComponent(item.id);
      setHash(location.hash);                        // the detail shows it now, not at the hashchange (which would draw it again)
    }
    onAct(act, { reason: '', answers: noAnswers(undefined), message: '' }, item);
  };
  return <InboxScreen view={view} t={t} note={note} message={message} onAct={onAct} onFrame={setFrame} onMessage={setMessage} detailRef={detail}
    handledOpen={handledOpen} onHandled={() => setHandledOpen((open) => !open)} onAnswer={onAnswer} said={said} />;
}

export type { Answers };
