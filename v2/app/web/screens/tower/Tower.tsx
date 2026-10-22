// The tower (tower.png): the bar to create a ticket or open the lead, what
// needs the human (a plan the lead proposes among it), the live sessions
// with their current phrase, the lead's card with its state and last line,
// the plans under way, and what landed today with its duration. In a
// workspace of several services (lane 22): the services' line, each live
// session's service, a session taken over, and a chip per service in the bar.
// The milestone 2 additions (lane 27): a live session's step, the contract
// and knowledge items in Needs you, the schedules in the plans card, "Ask
// about the code" and "Run a recipe" in the bar, with the recipe's form.
import { Check, HandGrabbing, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Recipe } from '../../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import { useGo, useScreen } from '@/lib/context.tsx';
import { useKept, useLive } from '@/lib/query.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ApiError } from '@/lib/screen.ts';
import { QUESTION_MAX, askBody, askFailure, askHref, questionProblem, startAsk } from '@/screens/ask/model.ts';
import {
  DRAFT_MAX, createTicket, duration, formatModel, harnessSquare, heading, leadHref, leadState, liveDot, loadTower, needId, needSentence, needTitle, pickedFor, planProgress,
  recipeDone, recipeFailure, recipeProblem, runRecipe, scheduleLine, serviceParts, serviceState, serviceTone, stepTag, takenOverText, towerModel, towerSummary,
  type LeadCard as LeadCardModel, type LeadThread, type LiveCard, type NeedCard, type PlanRow, type ScheduleRow, type ServiceRow, type TowerModel,
} from './model.ts';
import './tower.css';

// The services a new ticket names: a chip per service of a workspace of
// several, shown with the description once a title is typed.
// "Ask about the code" asks the title (and the description) as a question
// to the code; "Run a recipe" opens the recipes' form, once the service has some.
export function Bar({ t, title, body, services = [], picked = [], recipes = [], recipeOpen = false, busy = false, onTitle, onBody, onPick, onLead, onAsk, onRecipe, onSubmit }: {
  readonly t: Translate; readonly title: string; readonly body: string;
  readonly services?: readonly string[]; readonly picked?: readonly string[];
  readonly recipes?: readonly Recipe[]; readonly recipeOpen?: boolean; readonly busy?: boolean;
  readonly onTitle?: (value: string) => void; readonly onBody?: (value: string) => void; readonly onPick?: (service: string) => void;
  readonly onLead?: (kind: 'goal' | 'lead') => void; readonly onAsk?: () => void; readonly onRecipe?: () => void; readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="ask" id="ask" autoComplete="off" onSubmit={onSubmit}>
      <Input id="ask-input" name="title" maxLength={200} placeholder={t('bar_placeholder')} aria-label={t('bar_label')} value={title} onChange={(event) => onTitle?.(event.target.value)} />
      <div className="ask-actions">
        <Button variant="chip" className="chip-button" data-lead="goal" onClick={() => onLead?.('goal')}>{t('bar_new_goal')}</Button>
        <Button variant="chip" className="chip-button" data-lead="lead" onClick={() => onLead?.('lead')}>{t('bar_ask_lead')}</Button>
        <Button variant="chip" className="chip-button" data-bar="ask" disabled={busy} title={t('bar_ask_code_note')} onClick={onAsk}>{t('bar_ask_code')}</Button>
        {recipes.length > 0 ? <Button variant="chip" className="chip-button" data-bar="recipe" aria-expanded={recipeOpen} aria-controls="recipe-form" onClick={onRecipe}>{t('bar_recipe')}</Button> : null}
        <Button variant="ink" className="chip-button primary" type="submit">{t('bar_new_ticket')}</Button>
      </div>
      <Textarea id="ask-body" name="body" maxLength={20000} rows={5} placeholder={t('bar_body_placeholder')} aria-label={t('bar_body_label')} value={body} onChange={(event) => onBody?.(event.target.value)} />
      {services.length >= 2 ? (
        <div className="ask-services" role="group" aria-label={t('bar_services_label')}>
          {services.map((name) => (
            <Toggle key={name} className="svc-toggle" pressed={picked.includes(name)} onPressedChange={() => onPick?.(name)} data-service={name}>
              {picked.includes(name) ? <Check size={12} aria-hidden="true" /> : null}{name}
            </Toggle>
          ))}
        </div>
      ) : null}
    </form>
  );
}

// A recipe of a service's repository (decision 29): pick one, give its
// parameters (the required ones marked), and run it: a ticket recipe as a
// one-ticket plan you approve by running it, a goal recipe as your message
// to the lead. A missing parameter is said before anything is posted.
export function RecipeForm({ t, recipes, picked, values, note, link = null, busy = false, onPick, onValue, onRun, onClose }: {
  readonly t: Translate; readonly recipes: readonly Recipe[]; readonly picked: string | null; readonly values: Readonly<Record<string, string>>;
  readonly note: string; readonly link?: string | null; readonly busy?: boolean;
  readonly onPick?: (name: string) => void; readonly onValue?: (name: string, value: string) => void;
  readonly onRun?: (event: FormEvent<HTMLFormElement>) => void; readonly onClose?: () => void;
}) {
  const recipe = recipes.find((r) => r.name === picked);
  return (
    <form className="recipe-form" id="recipe-form" autoComplete="off" noValidate aria-labelledby="recipe-title" onSubmit={onRun}>
      <div className="recipe-head">
        <h2 id="recipe-title">{t('recipe_title')}</h2>
        <Button variant="ghost" className="icon recipe-close" aria-label={t('recipe_close')} onClick={onClose}><X size={16} aria-hidden="true" /></Button>
      </div>
      <div className="recipe-list" role="group" aria-label={t('recipe_list_label')}>
        {recipes.map((r) => (
          <Toggle key={`${r.service}/${r.name}`} className="recipe-toggle" pressed={r.name === picked} onPressedChange={() => onPick?.(r.name)} data-recipe={r.name}>
            {r.name === picked ? <Check size={12} aria-hidden="true" /> : null}{r.name}<span className="recipe-service">{r.service}</span>
          </Toggle>
        ))}
      </div>
      {recipe ? (
        <>
          <p className="recipe-kind">{t(recipe.kind === 'goal' ? 'recipe_kind_goal' : 'recipe_kind_ticket')}</p>
          {recipe.parameters.length === 0 ? <p className="recipe-none">{t('recipe_no_parameter')}</p> : (
            <div className="recipe-params">
              {recipe.parameters.map((p) => (
                <label key={p.name} className="recipe-param" htmlFor={`recipe-param-${p.name}`}>
                  <span className="param-name">{p.name}{p.required ? <span className="param-required">{t('recipe_required')}</span> : null}</span>
                  {p.description ? <span className="param-description">{p.description}</span> : null}
                  <Input id={`recipe-param-${p.name}`} name={p.name} required={p.required} data-param={p.name} maxLength={2000} disabled={busy} value={values[p.name] ?? ''}
                    onChange={(event) => onValue?.(p.name, event.target.value)} />
                </label>
              ))}
            </div>
          )}
          <div className="recipe-bar">
            <p className="recipe-note" role="status">{note}{link ? <>{' '}<a href={link}>{t('recipe_open')}</a></> : null}</p>
            {/* In ink once it can run: until then the bar's New ticket stays the one ink gesture. */}
            {recipeProblem(recipe, values) === undefined
              ? <Button variant="ink" className="chip-button primary" type="submit" data-act="recipe_run" disabled={busy}>{t('recipe_run')}</Button>
              : <Button variant="chip" className="chip-button" type="submit" data-act="recipe_run" disabled={busy}>{t('recipe_run')}</Button>}
          </div>
        </>
      ) : <p className="recipe-pick">{t('recipe_pick')}</p>}
    </form>
  );
}

function Need({ card, t }: { readonly card: NeedCard; readonly t: Translate }) {
  return (
    <li>
      <a className="need" href={card.href}>
        <span className="need-head"><span className="wait-line">{t(`need_${card.kind}`, { age: duration(card.minutes, t) })}</span><span className="id">{needId(card, t)}</span></span>
        <span className="need-title">{needTitle(card, t)}</span>
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
        {card.step ? <span className="svc-tag" data-step={card.step.position}>{stepTag(card.step, t)}</span>
          : card.service ? <span className="svc-tag">{card.service}</span> : null}<span className="id">{card.ticket}</span>
      </span>
      <span className="session-title">{card.title}</span>
      {card.takenOver ? <span className="phrase taken-line"><HandGrabbing size={16} aria-hidden="true" />{takenOverText(card.takenOver, t)}</span> : <span className="phrase">{card.status}</span>}
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
  const go = useGo();
  // The lead card's field opens the lead's screen with what was typed; the
  // message is sent from there, where its answer shows.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    go(leadHref('lead', draft));
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

// The schedules (decision 29): each recipe or goal with its next run and its budget.
function Schedules({ rows, now, language, t }: { readonly rows: readonly ScheduleRow[]; readonly now: Date; readonly language: 'en' | 'fr'; readonly t: Translate }) {
  return (
    <>
      <h3 className="sub-title" id="schedules-title">{t('schedules_title')}</h3>
      <ul className="schedules" aria-labelledby="schedules-title">
        {rows.map((row) => <li key={row.id} className={row.enabled ? 'schedule' : 'schedule off'} data-schedule={row.id}><span className="schedule-name">{row.name}</span><span className="schedule-line">{scheduleLine(row, now, language, t)}</span></li>)}
      </ul>
    </>
  );
}

export function TowerBody({ model, t, language = 'en', leadDraft = '', onLeadDraft }: {
  readonly model: TowerModel; readonly t: Translate; readonly language?: 'en' | 'fr'; readonly leadDraft?: string; readonly onLeadDraft?: (value: string) => void;
}) {
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
          {model.schedules.length > 0 ? <Schedules rows={model.schedules} now={model.now} language={language} t={t} /> : null}
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
  const go = useGo();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState<{ readonly text: string; readonly kind: 'ok' | 'error' } | null>(null);
  const [model, setModel] = useKept<TowerModel | null>('tower', null);
  const [failed, setFailed] = useState<string | null>(null);
  const [leadDraft, setLeadDraft] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [asking, setAsking] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [recipe, setRecipe] = useState<string | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [recipeNote, setRecipeNote] = useState<{ readonly text: string; readonly link: string | null }>({ text: '', link: null });
  const [running, setRunning] = useState(false);
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
  }, [context, t, setModel]);

  // Drawn from the cache, then again each time a resource it read changes.
  useEffect(() => {
    let live = true;
    void refresh(() => live);
    return () => { live = false; };
  }, [refresh]);
  useLive(() => void refresh());

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typed = title.trim();
    if (!typed) {
      setNote({ text: t('ticket_needs_title'), kind: 'error' });
      document.getElementById('ask-input')?.focus();
      return;
    }
    try {
      const services = model?.serviceNames.filter((name) => pickedFor(title, picked).includes(name)) ?? [];
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

  // "Ask about the code": the title and the description are the question;
  // a `service:path:line` in it, or the one service picked, names what it is about.
  const ask = async () => {
    const text = [title.trim(), body.trim()].filter(Boolean).join('\n\n');
    const problem = questionProblem(text);
    if (problem) {
      setNote({ text: t(problem === 'empty' ? 'ask_needs_question' : 'ask_question_long', { n: QUESTION_MAX }), kind: 'error' });
      document.getElementById('ask-input')?.focus();
      return;
    }
    setAsking(true);
    try {
      const asked = await startAsk(context.api, askBody(text, model?.askServices ?? [], pickedFor(title, picked)));
      go(askHref(asked.id));
    } catch (error) {
      setNote({ text: t(askFailure(error, 'ask')), kind: 'error' });
      setAsking(false);
    }
  };

  const run = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = model?.recipes.find((r) => r.name === recipe);
    if (!chosen) return;
    const missing = recipeProblem(chosen, values);
    if (missing !== undefined) {
      setRecipeNote({ text: t('recipe_missing', { name: missing }), link: null });
      document.getElementById(`recipe-param-${missing}`)?.focus();
      return;
    }
    setRunning(true);
    try {
      const done = recipeDone(await runRecipe(context.api, chosen, values), chosen, t);
      setRecipeNote({ text: done.text, link: done.href });
      setValues({});
      void refresh();
    } catch (error) {
      setRecipeNote({ text: t(recipeFailure(error)), link: null });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Bar t={t} title={title} body={body} services={model?.serviceNames ?? []} picked={picked} recipes={model?.recipes ?? []} recipeOpen={recipeOpen} busy={asking}
        onTitle={(value) => { setTitle(value); if (!value.trim()) setPicked([]); }} onBody={setBody} onSubmit={(event) => void submit(event)}
        onPick={(name) => setPicked((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]))}
        onLead={(kind) => go(leadHref(kind, title, body))} onAsk={() => void ask()} onRecipe={() => setRecipeOpen((open) => !open)} />
      <p className="ask-note" id="ask-note" role="status" data-kind={note?.kind}>{note?.text ?? ''}</p>
      {recipeOpen && model && model.recipes.length > 0 ? (
        <RecipeForm t={t} recipes={model.recipes} picked={recipe} values={values} note={recipeNote.text} link={recipeNote.link} busy={running}
          onPick={(name) => { setRecipe((current) => (current === name ? null : name)); setValues({}); setRecipeNote({ text: '', link: null }); }}
          onValue={(name, value) => setValues((current) => ({ ...current, [name]: value }))} onRun={(event) => void run(event)} onClose={() => setRecipeOpen(false)} />
      ) : null}
      <div id="tower-body" aria-busy={model === null && failed === null ? 'true' : undefined}>
        {failed !== null ? <p className="empty error">{failed}</p>
          : model ? <TowerBody model={model} t={t} language={context.me.language} leadDraft={leadDraft} onLeadDraft={setLeadDraft} /> : null}
      </div>
    </>
  );
}
