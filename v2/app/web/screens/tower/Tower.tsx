// The tower (tower.png): the bar to create a ticket or open the lead, what
// needs the human (a plan the lead proposes among it), the live sessions
// with their current phrase, the lead's card with its state and last line,
// the plans under way, and what landed today with its duration. In a
// workspace of several services (lane 22): the services' line, each live
// session's service, a session taken over, and a chip per service in the bar.
// The milestone 2 additions (lane 27): a live session's step, the contract
// and knowledge items in Needs you, the schedules in the plans card, "Ask
// about the code" and "Run a recipe" in the bar, with the recipe's form.
// Lane 35 (docs/v2/ui-overhaul-plan.md, 2.2.4 and 2.2.7): what needs the
// person and the live sessions are rows (a kind, a title, one line), which
// J and K walk ([data-row]); an empty part says so in one sentence, with
// the one thing to do about it. Requirement C6: "Batch" in the bar opens a
// form of one ticket per line, and the batches under way are a side card.
// P214: "Template" in the bar shows the ready-made tickets (templates.ts).
import { Check, HandGrabbing, ListChecks, Package, TerminalWindow, X } from '@phosphor-icons/react';
import { Fragment, useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Recipe } from '../../../../src/api/types.ts';
import { TICKET_TEMPLATES, type TicketTemplate } from '../../../../src/tickets/templates.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import { useGo, useScreen } from '@/lib/context.tsx';
import { Empty } from '@/shell/Empty.tsx';
import { useKept, useLive } from '@/lib/query.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ApiError } from '@/lib/screen.ts';
import { sessionStatus, ticketState } from '@/lib/status.ts';
import { QUESTION_MAX, askBody, askFailure, askHref, questionProblem, startAsk } from '@/screens/ask/model.ts';
import {
  BATCH_LINES_MAX, BATCH_LINES_MIN, batchFailure, batchLine, batchLines, batchProblem, holdLine, startBatch,
  DRAFT_MAX, VARIANT_CHOICES, createTicket, duration, formatModel, harnessSquare, heading, leadHref, leadState, liveDot, liveOrder, loadTower, needId, needSentence, needTitle, pickedFor, planProgress, recipeKey,
  recipeDone, recipeFailure, recipeProblem, runRecipe, scheduleLine, serviceParts, serviceState, serviceTone, stepTag, takenOverText, towerModel, towerSummary,
  type BatchRow, type LeadCard as LeadCardModel, type LeadThread, type LiveCard, type NeedCard, type PlanRow, type ScheduleRow, type ServiceRow, type TowerModel,
} from './model.ts';
import { pickTemplate, templateLabels } from './templates.ts';
import './tower.css';

// A line of facts, each kept whole on a line (lane 38's art director: no fact cut, no line ending on its "·").
function Facts({ text }: { readonly text: string }) {
  return <>{text.split(' · ').map((fact, i) => <Fragment key={i}>{i > 0 ? <span className="fact-sep">{' · '}</span> : null}<span className="fact">{fact}</span></Fragment>)}</>;
}

// The services a new ticket names: a chip per service of a workspace of
// several, shown with the description once a title is typed.
// "Ask about the code" asks the title (and the description) as a question
// to the code; "Run a recipe" opens the recipes' form, once the service has some.
// On a workspace of one service, the number of authors: one, or 2 to 4
// variants compared in the inbox (issue #271). "Batch" opens the form of
// several tickets at once (requirement C6). "Template" shows the ready-made
// tickets (P214), a row that stays while one is picked; the picked one says
// in the title's placeholder what to write.
export function Bar({ t, title, body, services = [], picked = [], variants = 1, recipes = [], recipeOpen = false, batchOpen = false, template = null, templatesOpen = false, busy = false, onTitle, onBody, onPick, onVariants, onLead, onAsk, onRecipe, onBatch, onTemplates, onTemplate, onSubmit }: {
  readonly t: Translate; readonly title: string; readonly body: string;
  readonly services?: readonly string[]; readonly picked?: readonly string[]; readonly variants?: number; readonly onVariants?: (n: number) => void;
  readonly recipes?: readonly Recipe[]; readonly recipeOpen?: boolean; readonly batchOpen?: boolean; readonly busy?: boolean;
  readonly template?: TicketTemplate | null; readonly templatesOpen?: boolean;
  readonly onTitle?: (value: string) => void; readonly onBody?: (value: string) => void; readonly onPick?: (service: string) => void;
  readonly onLead?: (kind: 'goal' | 'lead') => void; readonly onAsk?: () => void; readonly onRecipe?: () => void; readonly onBatch?: () => void;
  readonly onTemplates?: () => void; readonly onTemplate?: (template: TicketTemplate) => void; readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const templates = templatesOpen || template !== null;
  return (
    <form className="ask" id="ask" autoComplete="off" onSubmit={onSubmit}>
      <Input id="ask-input" name="title" maxLength={200} placeholder={t(template ? `template_${template}_title` : 'bar_placeholder')} aria-label={t('bar_label')} value={title} onChange={(event) => onTitle?.(event.target.value)} />
      <div className="ask-actions">
        <Button variant="chip" className="chip-button" data-lead="goal" onClick={() => onLead?.('goal')}>{t('bar_new_goal')}</Button>
        <Button variant="chip" className="chip-button" data-lead="lead" onClick={() => onLead?.('lead')}>{t('bar_ask_lead')}</Button>
        <Button variant="chip" className="chip-button" data-bar="ask" disabled={busy} title={t('bar_ask_code_note')} onClick={onAsk}>{t('bar_ask_code')}</Button>
        {recipes.length > 0 ? <Button variant="chip" className="chip-button" data-bar="recipe" aria-expanded={recipeOpen} aria-controls="recipe-form" onClick={onRecipe}>{t('bar_recipe')}</Button> : null}
        <Button variant="chip" className="chip-button" data-bar="template" aria-expanded={templates} aria-controls="ask-templates" onClick={onTemplates}>{t('bar_template')}</Button>
        <Button variant="chip" className="chip-button" data-bar="batch" aria-expanded={batchOpen} aria-controls="batch-form" onClick={onBatch}>{t('bar_batch')}</Button>
        <Button variant="ink" className="chip-button primary" type="submit">{t('bar_new_ticket')}</Button>
      </div>
      {templates ? (
        <div className="ask-templates" id="ask-templates" role="group" aria-label={t('bar_templates_label')}>
          <span className="ask-variants-label" aria-hidden="true">{t('bar_template')}</span>
          {TICKET_TEMPLATES.map((id) => (
            <Toggle key={id} className="svc-toggle" pressed={template === id} onPressedChange={() => onTemplate?.(id)} data-template={id}>
              {template === id ? <Check size={12} aria-hidden="true" /> : null}{t(`template_${id}`)}
            </Toggle>
          ))}
        </div>
      ) : null}
      <Textarea id="ask-body" name="body" maxLength={20000} rows={5} placeholder={t('bar_body_placeholder')} aria-label={t('bar_body_label')} value={body} onChange={(event) => onBody?.(event.target.value)} />
      {services.length >= 2 ? (
        <div className="ask-services" role="group" aria-label={t('bar_services_label')}>
          {services.map((name) => (
            <Toggle key={name} className="svc-toggle" pressed={picked.includes(name)} onPressedChange={() => onPick?.(name)} data-service={name}>
              {picked.includes(name) ? <Check size={12} aria-hidden="true" /> : null}{name}
            </Toggle>
          ))}
        </div>
      ) : (
        <div className="ask-variants" role="group" aria-label={t('bar_variants_label')}>
          <span className="ask-variants-label" aria-hidden="true">{t('bar_variants')}</span>
          {VARIANT_CHOICES.map((n) => (
            <Toggle key={n} className="svc-toggle" pressed={variants === n} onPressedChange={() => onVariants?.(n)} data-variants={n} aria-label={t(n === 1 ? 'bar_variants_one' : 'bar_variants_other', { n })}>
              {variants === n ? <Check size={12} aria-hidden="true" /> : null}{n}
            </Toggle>
          ))}
        </div>
      )}
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
  // A recipe is its service's and its name's: two services may name one alike (issue 227, item 1).
  const recipe = recipes.find((r) => recipeKey(r) === picked);
  return (
    <form className="recipe-form" id="recipe-form" autoComplete="off" noValidate aria-labelledby="recipe-title" onSubmit={onRun}>
      <div className="recipe-head">
        <h2 id="recipe-title">{t('recipe_title')}</h2>
        <Button variant="ghost" className="icon recipe-close" aria-label={t('recipe_close')} onClick={onClose}><X size={16} aria-hidden="true" /></Button>
      </div>
      <div className="recipe-list" role="group" aria-label={t('recipe_list_label')}>
        {recipes.map((r) => (
          <Toggle key={recipeKey(r)} className="recipe-toggle" pressed={recipeKey(r) === picked} onPressedChange={() => onPick?.(recipeKey(r))} data-recipe={r.name} data-service={r.service}>
            {recipeKey(r) === picked ? <Check size={12} aria-hidden="true" /> : null}{r.name}<span className="recipe-service">{r.service}</span>
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

// A batch (requirement C6): one ticket per line, 2 to 20, each its own
// session. A form of too few, too many or too long lines is refused here,
// before any call; the service starts them within the lanes and the stop.
export function BatchForm({ t, text, note, busy = false, onText, onRun, onClose }: {
  readonly t: Translate; readonly text: string; readonly note: string; readonly busy?: boolean;
  readonly onText?: (value: string) => void; readonly onRun?: (event: FormEvent<HTMLFormElement>) => void; readonly onClose?: () => void;
}) {
  return (
    <form className="recipe-form batch-form" id="batch-form" autoComplete="off" noValidate aria-labelledby="batch-form-title" onSubmit={onRun}>
      <div className="recipe-head">
        <h2 id="batch-form-title">{t('batch_form_title')}</h2>
        <Button variant="ghost" className="icon recipe-close" aria-label={t('batch_close')} onClick={onClose}><X size={16} aria-hidden="true" /></Button>
      </div>
      <p className="recipe-kind">{t('batch_hint', { min: BATCH_LINES_MIN, max: BATCH_LINES_MAX })}</p>
      <Textarea id="batch-lines" name="lines" aria-label={t('batch_lines_label')} rows={6} placeholder={t('batch_lines_placeholder')} disabled={busy} value={text}
        onChange={(event) => onText?.(event.target.value)} />
      <div className="recipe-bar">
        <p className="recipe-note" id="batch-note" role="status">{note}</p>
        {batchLines(text).problem === null
          ? <Button variant="ink" className="chip-button primary" type="submit" data-act="batch_run" disabled={busy}>{t('batch_run')}</Button>
          : <Button variant="chip" className="chip-button" type="submit" data-act="batch_run" disabled={busy}>{t('batch_run')}</Button>}
      </div>
    </form>
  );
}

// The batches under way, the three newest: how many started, what holds the
// rest (a lane to wait for, or the quota stop), and each ticket's state.
export function BatchCards({ t, rows }: { readonly t: Translate; readonly rows: readonly BatchRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="side-card" aria-labelledby="batches-title">
      <h2 id="batches-title">{t('batches_title')}</h2>
      <ul className="batches">
        {rows.map((row) => (
          <li key={row.id} className="batch" data-batch={row.id}>
            <p className="batch-head"><span className="id">{row.id}</span><span className="batch-line">{batchLine(row, t)}</span></p>
            {row.hold ? <p className="batch-hold">{holdLine(row.hold, t)}</p> : null}
            <ol className="batch-items">
              {row.items.map((item) => (
                <li key={item.position} className="batch-item" data-item-state={item.state}>
                  <span className="batch-item-title">{item.title}</span>
                  <span className="batch-item-state">{item.state === 'queued' ? t('batch_item_queued') : item.state === 'failed' ? t('batch_item_error', { note: item.note ?? '' }) : ticketState(item.status, t)}</span>
                  <span className="id">{item.ticket}</span>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A row of what needs the person: its kind, its title and one line of why,
// its ticket and how long it has waited. Amber says it waits, once: the kind.
// The link is named by its title and described by the rest, so a screen
// reader walking the rows with J and K hears the title first.
function Need({ card, t }: { readonly card: NeedCard; readonly t: Translate }) {
  const id = useId();
  return (
    <li>
      <a className="need row" href={card.href} data-row data-kind={card.kind} aria-labelledby={`${id}-title`} aria-describedby={`${id}-kind ${id}-detail ${id}-meta`}>
        <span className="row-kind wait-line" id={`${id}-kind`}>{t(`kind_${card.kind}`)}</span>
        <span className="row-main"><span className="need-title" id={`${id}-title`}>{needTitle(card, t)}</span><span className="need-detail" id={`${id}-detail`}>{needSentence(card, t)}</span></span>
        <span className="row-meta" id={`${id}-meta`}><span className={card.ticket ? 'id' : 'owner'}>{needId(card, t)}</span><span className="age">{duration(card.minutes, t)}</span></span>
      </a>
    </li>
  );
}

// A session taken over says by whom and since when in place of its phrase,
// which stopped when it was paused (decision 30).
export function LiveSession({ card, t }: { readonly card: LiveCard; readonly t: Translate }) {
  const id = useId();
  return (
    <li className={card.takenOver ? 'session-card taken' : 'session-card'} data-phase={card.phase}>
      <a className="open row" href={`/sessions/${card.id}`} data-row aria-labelledby={`${id}-title`} aria-describedby={`${id}-kind ${id}-phrase ${id}-meta`}>
        <span className="row-kind session-head" id={`${id}-kind`}><span className={liveDot(card.phase, card.role, card.takenOver)} aria-hidden="true" /><span className="role">{t(`role_${card.role}`)}</span></span>
        <span className="row-main">
          <span className="session-title" id={`${id}-title`}>{card.title}</span>
          {card.takenOver ? <span className="phrase taken-line" id={`${id}-phrase`}><HandGrabbing size={14} aria-hidden="true" />{takenOverText(card.takenOver, t)}</span> : <span className="phrase" id={`${id}-phrase`}>{sessionStatus(card, t)}</span>}
        </span>
        <span className="row-meta session-foot" id={`${id}-meta`}>
          {card.step ? <span className="svc-tag" data-step={card.step.position}>{stepTag(card.step, t)}</span>
            : card.service ? <span className="svc-tag">{card.service}</span> : null}
          <span className="model"><span className={`sq ${harnessSquare(card.harness)}`} aria-hidden="true" />{formatModel(card.harness, card.model)}</span>
          <span className="id">{card.ticket}</span>
          <span className="elapsed">{duration(card.minutes, t)}</span>
        </span>
      </a>
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
  const go = useGo();
  const quiet = model.live.length === 0 && model.plans.length === 0 && model.landed.length === 0 && model.weekLeft === null;
  return (
    <div className="tower">
      <div className="tower-main">
        {/* The heading says what needs the person, once: no section title under it repeats it, and its
            line says no session runs rather than a list of zeros (art director of lane 35, item 6). */}
        <div className="hello">
          <div><h1 id="tower-heading">{heading(model.needs.length, t)}</h1><p className="muted">{quiet ? t('live_empty') : <Facts text={towerSummary(model, t)} />}</p></div>
          {model.needs.length === 0 ? null : <a className="more" href="/inbox">{t('open_inbox')}</a>}
        </div>
        {model.services.length === 0 ? null : (
          <ul className="workspace-line" aria-label={t('services_title')}>
            {model.services.map((row) => <li key={row.name} className="svc" data-service={row.name} data-state={serviceTone(row)}><span className="svc-name">{row.name}</span> <ServiceState row={row} t={t} /></li>)}
          </ul>
        )}
        {/* Nothing waiting: the heading above says so; no empty list under it. */}
        {model.needs.length === 0 ? null : (
          <section className="block needs-block" aria-labelledby="tower-heading">
            <ul className="rows needs">{model.needs.map((card) => <Need key={card.id} card={card} t={t} />)}</ul>
          </section>
        )}
        {/* Nothing waiting and nothing running: the heading's line already says no session runs. */}
        {model.live.length === 0 && model.needs.length === 0 ? null : (
        <section className="block" aria-labelledby="live-title">
          <div className="block-head"><h2 id="live-title">{t('live_title')}</h2><span className="n">{model.live.length || ''}</span><a className="more" href="/sessions">{t('all_sessions')}</a></div>
          {/* The bar above is how a session starts: no second New ticket here. */}
          {model.live.length === 0 ? <Empty icon={TerminalWindow} id="live-empty" text={t('live_empty')} />
            : <ul className="rows sessions">{liveOrder(model.live).map((card) => <LiveSession key={card.id} card={card} t={t} />)}</ul>}
        </section>
        )}
      </div>
      <aside className="tower-side">
        <LeadSide lead={model.lead} t={t} draft={leadDraft} onDraft={onLeadDraft} />
        <BatchCards t={t} rows={model.batches} />
        <section className="side-card" aria-labelledby="plans-title">
          <h2 id="plans-title">{t('plans_title')}</h2>
          {model.plans.length === 0 ? <Empty icon={ListChecks} id="plans-empty" text={t('plans_empty')} action={{ label: t('bar_new_goal'), onClick: () => go(leadHref('goal', '')) }} />
            : <ul className="plans">{model.plans.map((row) => <PlanLine key={row.id} row={row} t={t} />)}</ul>}
          {model.schedules.length > 0 ? <Schedules rows={model.schedules} now={model.now} language={language} t={t} /> : null}
        </section>
        <section className="side-card" aria-labelledby="landed-title">
          <h2 id="landed-title">{t('landed_title')}</h2>
          {model.landed.length === 0 ? <Empty icon={Package} text={t('landed_empty')} /> : (
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
  const [variants, setVariants] = useState(1);
  const [asking, setAsking] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [recipe, setRecipe] = useState<string | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [recipeNote, setRecipeNote] = useState<{ readonly text: string; readonly link: string | null }>({ text: '', link: null });
  const [running, setRunning] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchNote, setBatchNote] = useState('');
  const [batching, setBatching] = useState(false);
  const [template, setTemplate] = useState<TicketTemplate | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
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
      const several = (model?.serviceNames.length ?? 0) >= 2;
      const count = several ? 1 : variants;
      const ticket = await createTicket(context.api, { title: typed, body, project: context.me.project, services, variants: count, labels: templateLabels(template) });
      setTitle('');
      setBody('');
      setPicked([]);
      setVariants(1);
      setTemplate(null);
      setTemplatesOpen(false);
      const status = ticketState(ticket.status, t);
      setNote({ text: count > 1 ? t('ticket_created_variants', { id: ticket.id, status, n: count }) : t('ticket_created', { id: ticket.id, status }), kind: 'ok' });
      void refresh();
    } catch {
      setNote({ text: t('ticket_failed'), kind: 'error' });
    }
  };

  // A ready-made ticket: its sections in an empty or untouched description, the title to write next. Only the
  // first pick takes the focus to the title, so the keys can still go from one template to the next.
  const choose = (id: TicketTemplate) => {
    const pick = pickTemplate({ template, body }, id, t);
    setTemplate(pick.template);
    setBody(pick.body);
    setNote(pick.kept ? { text: t('template_kept'), kind: 'ok' } : null);
    if (template === null && pick.template !== null) document.getElementById('ask-input')?.focus();
  };
  // The chip shows the row, or hides it with the template picked, its untouched sections with it.
  const toggleTemplates = () => {
    if (!templatesOpen && template === null) return setTemplatesOpen(true);
    if (template !== null) choose(template);
    setTemplatesOpen(false);
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
    const chosen = model?.recipes.find((r) => recipeKey(r) === recipe);
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

  // A batch: the lines checked here first, then one call for them all.
  const batch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { titles, problem } = batchLines(batchText);
    if (problem) {
      setBatchNote(batchProblem(problem, t));
      document.getElementById('batch-lines')?.focus();
      return;
    }
    setBatching(true);
    try {
      // The workspace's id, as the service names its project; the header's name is a label.
      const made = await startBatch(context.api, model?.project ?? context.me.project, titles);
      setBatchNote(t('batch_created', { id: made.id, n: made.items.length }));
      setBatchText('');
      void refresh();
    } catch (error) {
      setBatchNote(t(batchFailure(error)));
    } finally {
      setBatching(false);
    }
  };

  return (
    <div className="tower-screen">
      <Bar t={t} title={title} body={body} services={model?.serviceNames ?? []} picked={picked} variants={variants} onVariants={setVariants} recipes={model?.recipes ?? []} recipeOpen={recipeOpen} batchOpen={batchOpen} busy={asking}
        onTitle={(value) => { setTitle(value); if (!value.trim()) { setPicked([]); setVariants(1); } }} onBody={setBody} onSubmit={(event) => void submit(event)}
        onPick={(name) => setPicked((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]))}
        onLead={(kind) => go(leadHref(kind, title, body))} onAsk={() => void ask()} onRecipe={() => setRecipeOpen((open) => !open)}
        onBatch={() => setBatchOpen((open) => !open)} template={template} templatesOpen={templatesOpen} onTemplates={toggleTemplates} onTemplate={choose} />
      <p className="ask-note" id="ask-note" role="status" data-kind={note?.kind}>{note?.text ?? ''}</p>
      {recipeOpen && model && model.recipes.length > 0 ? (
        <RecipeForm t={t} recipes={model.recipes} picked={recipe} values={values} note={recipeNote.text} link={recipeNote.link} busy={running}
          onPick={(key) => { setRecipe((current) => (current === key ? null : key)); setValues({}); setRecipeNote({ text: '', link: null }); }}
          onValue={(name, value) => setValues((current) => ({ ...current, [name]: value }))} onRun={(event) => void run(event)} onClose={() => setRecipeOpen(false)} />
      ) : null}
      {batchOpen ? (
        <BatchForm t={t} text={batchText} note={batchNote} busy={batching} onText={setBatchText} onRun={(event) => void batch(event)} onClose={() => setBatchOpen(false)} />
      ) : null}
      <div id="tower-body" aria-busy={model === null && failed === null ? 'true' : undefined}>
        {failed !== null ? <div className="empty error tower-failed"><p>{failed}</p><Button variant="chip" className="chip-button" id="tower-retry" onClick={() => void refresh()}>{t('boundary_retry')}</Button></div>
          : model ? <TowerBody model={model} t={t} language={context.me.language} leadDraft={leadDraft} onLeadDraft={setLeadDraft} /> : null}
      </div>
    </div>
  );
}
