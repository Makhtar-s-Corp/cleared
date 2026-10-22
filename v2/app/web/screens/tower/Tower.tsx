// The tower (tower.png): the bar to create a ticket or open the lead, what
// needs the human (a plan the lead proposes among it), the live sessions
// with their current phrase, the lead's card with its state and last line,
// the plans under way, and what landed today with its duration. In a
// workspace of several services (lane 22): the services' line, each live
// session's service, a session taken over, and a chip per service in the bar.
import { HandGrabbing } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ApiError } from '@/lib/screen.ts';
import {
  DRAFT_MAX, REFRESH_MS, createTicket, duration, formatModel, harnessSquare, heading, leadHref, leadState, liveDot, loadTower, needId, needSentence, planProgress,
  serviceParts, serviceState, serviceTone, takenOverText, towerModel, towerSummary,
  type LeadCard as LeadCardModel, type LeadThread, type LiveCard, type NeedCard, type PlanRow, type ServiceRow, type TowerModel,
} from './model.ts';
import './tower.css';

// The services a new ticket names: a chip per service of a workspace of
// several, shown with the description once a title is typed.
export function Bar({ t, title, body, services = [], picked = [], onTitle, onBody, onPick, onLead, onSubmit }: {
  readonly t: Translate; readonly title: string; readonly body: string;
  readonly services?: readonly string[]; readonly picked?: readonly string[];
  readonly onTitle?: (value: string) => void; readonly onBody?: (value: string) => void; readonly onPick?: (service: string) => void;
  readonly onLead?: (kind: 'goal' | 'lead') => void; readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="ask" id="ask" autoComplete="off" onSubmit={onSubmit}>
      <Input id="ask-input" name="title" maxLength={200} placeholder={t('bar_placeholder')} aria-label={t('bar_label')} value={title} onChange={(event) => onTitle?.(event.target.value)} />
      <div className="ask-actions">
        <Button variant="chip" className="chip-button" data-lead="goal" onClick={() => onLead?.('goal')}>{t('bar_new_goal')}</Button>
        <Button variant="chip" className="chip-button" data-lead="lead" onClick={() => onLead?.('lead')}>{t('bar_ask_lead')}</Button>
        <Button variant="ink" className="chip-button primary" type="submit">{t('bar_new_ticket')}</Button>
      </div>
      <Textarea id="ask-body" name="body" maxLength={20000} rows={5} placeholder={t('bar_body_placeholder')} aria-label={t('bar_body_label')} value={body} onChange={(event) => onBody?.(event.target.value)} />
      {services.length >= 2 ? (
        <div className="ask-services" role="group" aria-label={t('bar_services_label')}>
          {services.map((name) => <Toggle key={name} className="svc-toggle" pressed={picked.includes(name)} onPressedChange={() => onPick?.(name)} data-service={name}>{name}</Toggle>)}
        </div>
      ) : null}
    </form>
  );
}

function Need({ card, t }: { readonly card: NeedCard; readonly t: Translate }) {
  return (
    <li>
      <a className="need" href={card.href}>
        <span className="need-head"><span className="wait-line">{t(`need_${card.kind}`, { age: duration(card.minutes, t) })}</span><span className="id">{needId(card, t)}</span></span>
        <span className="need-title">{card.title}</span>
        <span className="need-detail">{needSentence(card, t)}</span>
      </a>
    </li>
  );
}

// A session taken over says by whom and since when in place of its phrase,
// which stopped when it was paused (decision 30).
export function LiveSession({ card, t }: { readonly card: LiveCard; readonly t: Translate }) {
  return (
    <li className={card.takenOver ? 'session-card taken' : 'session-card'}>
      <span className="session-head">
        <span className={liveDot(card.phase, card.role, card.takenOver)} aria-hidden="true" /><span className="role">{t(`role_${card.role}`)}</span>
        {card.service ? <span className="svc-tag">{card.service}</span> : null}<span className="id">{card.ticket}</span>
      </span>
      <span className="session-title">{card.title}</span>
      {card.takenOver ? <span className="phrase taken-line"><HandGrabbing size={14} aria-hidden="true" />{takenOverText(card.takenOver, t)}</span> : <span className="phrase">{card.status}</span>}
      <span className="session-foot">
        <span className="model"><span className={`sq ${harnessSquare(card.harness)}`} aria-hidden="true" />{formatModel(card.harness, card.model)}</span>
        <span className="elapsed">{duration(card.minutes, t)}</span>
        <a className="open" href={`/sessions/${card.id}`}>{t('open_session')}</a>
      </span>
    </li>
  );
}

function LeadSide({ lead, t, draft, onDraft }: { readonly lead: LeadCardModel | null; readonly t: Translate; readonly draft: string; readonly onDraft?: (value: string) => void }) {
  const state = leadState(lead, t);
  // The lead card's field opens the lead's screen with what was typed; the
  // message is sent from there, where its answer shows.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    location.assign(leadHref('lead', draft));
  };
  return (
    <section className="side-card" aria-labelledby="lead-title">
      <div className="lead-head">
        <span className="lead-mark" aria-hidden="true">{t('lead_initial')}</span>
        <div><h2 id="lead-title"><a href="/lead">{t('lead_title')}</a></h2><p className={`lead-state ${state.kind}`}>{state.text}</p></div>
      </div>
      {lead?.line ? <p className="note lead-line"><q>{lead.line}</q></p> : <p className="note faint">{t('lead_no_line')}</p>}
      <form className="lead-ask" id="lead-ask" autoComplete="off" onSubmit={submit}>
        <Input id="lead-ask-input" name="text" maxLength={DRAFT_MAX} placeholder={t('lead_message_placeholder')} aria-label={t('lead_message_label')} value={draft} onChange={(event) => onDraft?.(event.target.value)} />
      </form>
    </section>
  );
}

function ServiceState({ row, t }: { readonly row: ServiceRow; readonly t: Translate }) {
  const { live, train } = serviceParts(row, t);
  if (!train) return <span className="svc-state">{serviceState(row, t)}</span>;
  return <span className="svc-state">{live ? `${live} · ` : null}<span className="svc-train">{train}</span></span>;
}

function PlanLine({ row, t }: { readonly row: PlanRow; readonly t: Translate }) {
  const { bar, line } = planProgress(row, t);
  return (
    <li>
      <a className="plan-row" href={`/plans/${encodeURIComponent(row.id)}`}>
        <span className="plan-title">{row.title}</span>
        <span className="plan-bar" role="img" aria-label={bar}>{row.segments.map((segment, index) => <span key={index} className={`seg ${segment}`} />)}</span>
        <span className="plan-line">{line}</span>
      </a>
    </li>
  );
}

export function TowerBody({ model, t, leadDraft = '', onLeadDraft }: { readonly model: TowerModel; readonly t: Translate; readonly leadDraft?: string; readonly onLeadDraft?: (value: string) => void }) {
  return (
    <div className="tower">
      <div className="tower-main">
        <div className="hello"><h1>{heading(model.needs.length, t)}</h1><p className="muted">{towerSummary(model, t)}</p></div>
        {model.services.length === 0 ? null : (
          <ul className="workspace-line" aria-label={t('services_title')}>
            {model.services.map((row) => <li key={row.name} className="svc" data-service={row.name} data-state={serviceTone(row)}><span className="svc-name">{row.name}</span> <ServiceState row={row} t={t} /></li>)}
          </ul>
        )}
        <section className="block" aria-labelledby="needs-title">
          <div className="block-head"><span className="dot awaiting" aria-hidden="true" /><h2 id="needs-title">{t('needs_title')}</h2><a className="more" href="/inbox">{t('open_inbox')}</a></div>
          {model.needs.length === 0 ? <p className="empty">{t('needs_empty')}</p>
            : <ul className="needs">{model.needs.map((card) => <Need key={card.id} card={card} t={t} />)}</ul>}
        </section>
        <section className="block" aria-labelledby="live-title">
          <div className="block-head"><span className="dot progress" aria-hidden="true" /><h2 id="live-title">{t('live_title')}</h2><span className="n">{model.live.length}</span></div>
          {model.live.length === 0 ? <p className="empty">{t('live_empty')}</p>
            : <ul className="sessions">{model.live.map((card) => <LiveSession key={card.id} card={card} t={t} />)}</ul>}
        </section>
      </div>
      <aside className="tower-side">
        <LeadSide lead={model.lead} t={t} draft={leadDraft} onDraft={onLeadDraft} />
        <section className="side-card" aria-labelledby="plans-title">
          <h2 id="plans-title">{t('plans_title')}</h2>
          {model.plans.length === 0 ? <p className="faint small">{t('plans_empty')}</p>
            : <ul className="plans">{model.plans.map((row) => <PlanLine key={row.id} row={row} t={t} />)}</ul>}
        </section>
        <section className="side-card" aria-labelledby="landed-title">
          <h2 id="landed-title">{t('landed_title')}</h2>
          {model.landed.length === 0 ? <p className="faint">{t('landed_empty')}</p> : (
            <ul className="landed">
              {model.landed.map((row) => <li key={row.ticket}><span className="time">{row.time}</span><span className="what">{row.title}</span><span className="took">{duration(row.minutes, t)}</span></li>)}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

export default function Tower() {
  const context = useScreen();
  const { t } = context;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState<{ readonly text: string; readonly kind: 'ok' | 'error' } | null>(null);
  const [model, setModel] = useState<TowerModel | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [leadDraft, setLeadDraft] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const thread = useRef<LeadThread>({ after: 0, line: null });

  const refresh = useCallback(async (live: () => boolean = () => true) => {
    try {
      const loaded = await loadTower(context.api, thread.current);
      if (!live()) return;
      thread.current = loaded.thread;
      setModel(towerModel(loaded.data, context.now(), context.me.user.id));
      setFailed(null);
    } catch (error) {
      if (!live()) return;
      setFailed(t(error instanceof ApiError && error.status === 401 ? 'signed_out' : 'load_failed'));
    }
  }, [context, t]);

  useEffect(() => {
    let live = true;
    void refresh(() => live);
    const timer = setInterval(() => void refresh(() => live), REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [refresh]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typed = title.trim();
    if (!typed) {
      setNote({ text: t('ticket_needs_title'), kind: 'error' });
      document.getElementById('ask-input')?.focus();
      return;
    }
    try {
      const services = model?.serviceNames.filter((name) => picked.includes(name)) ?? [];
      const ticket = await createTicket(context.api, { title: typed, body, project: context.me.project, services });
      setTitle('');
      setBody('');
      setPicked([]);
      setNote({ text: t('ticket_created', { id: ticket.id, status: ticket.status }), kind: 'ok' });
      void refresh();
    } catch {
      setNote({ text: t('ticket_failed'), kind: 'error' });
    }
  };

  return (
    <>
      <Bar t={t} title={title} body={body} services={model?.serviceNames ?? []} picked={picked} onTitle={setTitle} onBody={setBody} onSubmit={(event) => void submit(event)}
        onPick={(name) => setPicked((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]))}
        onLead={(kind) => location.assign(leadHref(kind, title, body))} />
      <p className="ask-note" id="ask-note" role="status" data-kind={note?.kind}>{note?.text ?? ''}</p>
      <div id="tower-body" aria-busy={model === null && failed === null ? 'true' : undefined}>
        {failed !== null ? <p className="empty error">{failed}</p>
          : model ? <TowerBody model={model} t={t} leadDraft={leadDraft} onLeadDraft={setLeadDraft} /> : null}
      </div>
    </>
  );
}
