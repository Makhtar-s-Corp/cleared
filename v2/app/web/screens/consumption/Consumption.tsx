// The Consumption screen (O15): per agent, the tokens of the last seven days
// as a curve and where the quota is heading before the next reset and
// after it; the dollars only where the agent reported them; and three levers
// that call real actions of the service. model.ts holds the rules and the
// words; this file draws them, reads the figures again every minute and
// after each lever, and says a refusal in the catalog's words. The week's
// figures (C17) are read on their own, so a failed read of them leaves the
// rest of the screen as it is.
import { ArrowRight, ArrowsClockwise, Gauge, Pause, Play, Stack, Timer } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import type { Consumption, HarnessConsumption, LeversChange, Quota, WeekFigures } from '../../../../src/api/types.ts';
import { Toggle } from '@/components/ui/toggle.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { useLive } from '@/lib/query.tsx';
import {
  REFRESH_MS, averagePerDay, browserZone, chartOf, costView, dayInitial, dayLong, harnessMaker, harnessName, headline, leverFailure, leverViews, measuredAt, percentText,
  periodText, projectionLines, quotaOf, readConsumption, readingLines, readFailure, readWeek, resetIn, setLevers, tokensText, verdictOf, weekView, winRows, type LeverId, type LeverView,
} from './model.ts';
import './consumption.css';

type Language = 'en' | 'fr';

const LEVER_ICONS: Readonly<Record<LeverId, typeof Gauge>> = { model: ArrowsClockwise, lanes: Stack, pause: Timer };

function Curve({ h, data, t, language }: { readonly h: HarnessConsumption; readonly data: Consumption; readonly t: Translate; readonly language: Language }) {
  const chart = chartOf(h.perDay);
  const name = harnessName(h.harness, t);
  return (
    <figure className="curve">
      <figcaption className="curve-label">{t('consumption_usage_per_day')}</figcaption>
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={t('consumption_chart_label', { harness: name })} className="curve-svg" data-curve={h.harness}>
        <path className="curve-area" d={chart.area} />
        <path className="curve-line" d={chart.line} fill="none" />
        {chart.points.map((p) => (
          <circle key={p.day} className="curve-dot" cx={p.x} cy={p.y} r={2.5}>
            <title>{t('consumption_day_usage', { day: dayLong(p.day, language), tokens: tokensText(p.tokens, language) })}</title>
          </circle>
        ))}
      </svg>
      <ol className="curve-days" aria-hidden="true">
        {data.days.map((day) => <li key={day}>{dayInitial(day, language)}</li>)}
      </ol>
    </figure>
  );
}

function HarnessCard({ h, data, t, language }: { readonly h: HarnessConsumption; readonly data: Consumption; readonly t: Translate; readonly language: Language }) {
  const average = averagePerDay(h);
  const used = h.sessions > 0;
  return (
    <article className="harness" data-harness={h.harness} data-used={used ? 'yes' : 'no'}>
      <header className="harness-head">
        <h2 className="harness-name"><span className={`sq ${h.harness === 'claude-code' ? 'claude' : h.harness === 'codex' ? 'codex' : ''}`} aria-hidden="true" />{harnessName(h.harness, t)}</h2>
        <p className="harness-maker">{harnessMaker(h.harness, t)}</p>
      </header>
      {used ? (
        <div className="harness-body">
          <div className="harness-figures">
            <p className="harness-tokens"><span className="num" data-total={h.harness}>{tokensText(h.tokens, language)}</span> <span className="unit">{t('consumption_usage_unit')}</span></p>
            <p className="harness-average">{t('consumption_average', { n: tokensText(average.tokens, language) })}</p>
          </div>
          <Curve h={h} data={data} t={t} language={language} />
        </div>
      ) : <p className="harness-empty">{h.harness === 'codex' ? t('consumption_not_used') : t('consumption_quiet')}</p>}
    </article>
  );
}

function QuotaRow({ h, quota, data, now, t, language }: { readonly h: HarnessConsumption; readonly quota: Quota | undefined; readonly data: Consumption; readonly now: Date; readonly t: Translate; readonly language: Language }) {
  const name = harnessName(h.harness, t);
  if (!quota) {
    return (
      <div className="quota" data-quota={h.harness} data-verdict="unknown">
        <p className="quota-name">{name}</p>
        <p className="quota-note">{t('consumption_quota_none')}</p>
        <Readings h={h} quota={undefined} data={data} t={t} language={language} />
      </div>
    );
  }
  const verdict = verdictOf(quota.projection);
  const lines = projectionLines(quota, h, data.timeZone, language, t);
  const used = percentText(quota.usedPercent, language);
  return (
    <div className="quota" data-quota={h.harness} data-verdict={verdict}>
      <p className="quota-head"><span className="quota-name">{name}</span><span className="quota-used">{t('consumption_quota_used', { percent: used })}</span></p>
      <progress className="quota-bar" max={100} value={Math.min(100, quota.usedPercent)} aria-label={`${name}, ${t(`consumption_window_${quota.window}`)}: ${t('consumption_quota_used', { percent: used })}`} />
      <p className="quota-reset"><span>{t(`consumption_window_${quota.window}`)}</span><span className="sep" aria-hidden="true">·</span><span>{resetIn(quota, now, t)}</span></p>
      <p className="quota-line" data-projection="before">{lines.before}</p>
      {lines.after ? <p className="quota-line quota-after" data-projection="after">{lines.after}</p> : null}
      <Readings h={h} quota={quota} data={data} t={t} language={language} />
    </div>
  );
}

function Readings({ h, quota, data, t, language }: { readonly h: HarnessConsumption; readonly quota: Quota | undefined; readonly data: Consumption; readonly t: Translate; readonly language: Language }) {
  return readingLines(h, quota, data.timeZone, language, t).map((line) => (
    <p key={line.kind} className={line.kind === 'failed' ? 'quota-reading quota-reading-failed' : 'quota-reading'} data-reading={line.kind} {...(line.kind === 'failed' ? { role: 'status' } : {})}>{line.text}</p>
  ));
}

function Lever({ lever, busy, onLever }: { readonly lever: LeverView; readonly busy: boolean; readonly onLever: (change: LeversChange) => void }) {
  const Icon = LEVER_ICONS[lever.id];
  return (
    <li className="lever" data-lever={lever.id} data-active={lever.active ? 'yes' : 'no'}>
      <span className="lever-icon" aria-hidden="true">{lever.id === 'pause' && lever.active ? <Play size={16} /> : lever.id === 'pause' ? <Pause size={16} /> : <Icon size={16} />}</span>
      <div className="lever-text">
        <p className="lever-title">{lever.title}</p>
        <p className="lever-detail">{lever.detail}</p>
        <p className="lever-state" role="status">{lever.state}</p>
      </div>
      <div className="lever-choices" role="group" aria-label={lever.title}>
        {lever.choices.map((choice) => (
          <Toggle key={choice.id} className="choice" pressed={choice.pressed} disabled={busy} data-choice={`${lever.id}:${choice.id}`}
            onPressedChange={() => onLever(choice.change)}>{choice.label}</Toggle>
        ))}
      </div>
    </li>
  );
}

// The harness pick's wins per ticket type (issue #329): a table once a pick
// has ended, else a line that says none has.
function Wins({ data, t, language }: { readonly data: Consumption; readonly t: Translate; readonly language: Language }) {
  const rows = winRows(data.wins, t, language);
  return (
    <section className="panel wins" aria-labelledby="wins-title" data-wins={rows.length > 0 ? 'shown' : 'empty'}>
      <h2 id="wins-title">{t('consumption_wins_title')}</h2>
      <p className="wins-sub">{t('consumption_wins_sub')}</p>
      {rows.length > 0 ? (
        <div className="wins-scroll">
          <table className="wins-table">
            <thead>
              <tr>
                <th scope="col">{t('consumption_wins_type')}</th>
                <th scope="col">{t('consumption_wins_agent')}</th>
                <th scope="col" className="n">{t('consumption_wins_runs')}</th>
                <th scope="col" className="n">{t('consumption_wins_green')}</th>
                <th scope="col" className="n">{t('consumption_wins_kept')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr data-win={row.key} key={row.key}>
                  <td>{row.type}</td>
                  <td>{row.harness}</td>
                  <td className="n num">{row.runs}</td>
                  <td className="n num">{row.green}</td>
                  <td className="n num">{row.wins}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="wins-empty">{t('consumption_wins_empty')}</p>}
    </section>
  );
}

// The week's figures (C17): what the last seven days merged and what it
// took, then each merged ticket against its estimate, then per service.
function Week({ week, failed, t, language }: { readonly week: WeekFigures | undefined; readonly failed: boolean; readonly t: Translate; readonly language: Language }) {
  if (!week) {
    if (!failed) return null;
    return (
      <section className="panel week" aria-labelledby="week-title" data-week="failed">
        <h2 id="week-title">{t('consumption_week_title')}</h2>
        <p className="week-failed" role="status">{t('consumption_week_failed')}</p>
      </section>
    );
  }
  const view = weekView(week, language, t);
  return (
    <section className="panel week" aria-labelledby="week-title" data-week="shown">
      <h2 id="week-title">{t('consumption_week_title')}</h2>
      <p className="week-sub">{t('consumption_week_sub')}</p>
      <ul className="week-facts">
        <li data-week-fact="merged">{view.merged}</li>
        {view.tokens ? <li data-week-fact="tokens">{view.tokens}</li> : null}
        {view.time ? <li data-week-fact="time">{view.time}</li> : null}
        {view.idle ? <li data-week-fact="idle">{view.idle}</li> : null}
      </ul>
      {view.dollars ? <p className="week-dollars" data-week-dollars="shown">{view.dollars}</p> : null}
      {view.noDollars ? <p className="week-dollars week-no-dollars" data-week-dollars="none">{view.noDollars}</p> : null}
      {view.tickets.length > 0 ? (
        <ol className="week-tickets" aria-label={t('consumption_week_tickets_label')}>
          {view.tickets.map((ticket) => (
            <li key={ticket.id} data-week-ticket={ticket.id}>
              <p className="week-ticket-head"><span className="id">{ticket.id}</span><span className="week-ticket-title">{ticket.title}</span></p>
              <p className="week-ticket-meta"><span>{ticket.services}</span><span className="sep" aria-hidden="true">·</span><span>{ticket.estimate}</span></p>
            </li>
          ))}
        </ol>
      ) : null}
      {view.estimates ? <p className="week-estimates">{view.estimates}</p> : null}
      {view.rows.length > 0 ? (
        <>
          <h3 className="week-services">{t('consumption_week_services')}</h3>
          <div className="week-scroll">
            <table className="week-table">
              <thead>
                <tr>
                  <th scope="col">{t('consumption_week_service')}</th>
                  <th scope="col" className="n">{t('consumption_week_col_merged')}</th>
                  <th scope="col" className="n">{t('consumption_week_col_used')}</th>
                  <th scope="col" className="n">{t('consumption_week_col_time')}</th>
                  <th scope="col" className="n">{t('consumption_week_col_dollars')}</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.key} data-week-service={row.key}>
                    <td>{row.name}</td>
                    <td className="n num">{row.merged}</td>
                    <td className="n num">{row.tokens}</td>
                    <td className="n num">{row.time}</td>
                    <td className="n num dollars">{row.dollars}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function ConsumptionView({ data, t, language, now, busy = false, note = '', onLever, week, weekFailed = false }: {
  readonly data: Consumption; readonly t: Translate; readonly language: Language; readonly now: Date;
  readonly busy?: boolean; readonly note?: string; readonly onLever?: (change: LeversChange) => void;
  readonly week?: WeekFigures; readonly weekFailed?: boolean;
}) {
  const summary = headline(data, language, t);
  const cost = costView(data, language, t);
  const levers = leverViews(data.levers, t);
  return (
    <section className="consumption" aria-labelledby="consumption-title" data-screen="consumption">
      <header className="consumption-head">
        <div>
          <p className="consumption-eyebrow">{t('consumption_eyebrow')}</p>
          <h1 id="consumption-title">{t('consumption_title')}</h1>
          <p className="consumption-sub">{t('consumption_subtitle')}</p>
        </div>
        <p className="consumption-period">{periodText(data.days, language)}</p>
      </header>
      <div className="consumption-grid">
        <div className="main-col">
          <Week week={week} failed={weekFailed} t={t} language={language} />
          <div className="harnesses" role="list" aria-label={t('consumption_harnesses_label')}>
            {data.harnesses.map((h) => <div role="listitem" key={h.harness}><HarnessCard h={h} data={data} t={t} language={language} /></div>)}
          </div>
          <Wins data={data} t={t} language={language} />
        </div>
        <aside className="side" aria-labelledby="limits-title">
          <section className="panel limits">
            <header className="panel-head">
              <h2 id="limits-title">{t('consumption_limits_title')}</h2>
              {summary.kind === 'hit' ? <span className="chip warn">{t('consumption_chip_hit', { harness: harnessName(summary.harness ?? '', t) })}</span>
                : <span className="chip">{summary.kind === 'ok' ? t('consumption_chip_ok') : t('consumption_chip_none')}</span>}
            </header>
            <p className="headline" data-headline={summary.kind}>{summary.text}</p>
            <div className="quotas">
              {data.harnesses.map((h) => <QuotaRow key={h.harness} h={h} quota={quotaOf(h)} data={data} now={now} t={t} language={language} />)}
            </div>
          </section>
          {cost ? (
            <section className="panel cost" data-cost="shown" aria-labelledby="cost-title">
              <header className="panel-head">
                <h2 id="cost-title">{t('consumption_cost_title')}</h2>
                <p className="cost-total"><span className="cost-total-label">{t('consumption_cost_total')}</span> <span className="num" data-cost-total="">{cost.total}</span></p>
              </header>
              <p className="cost-period">{t('consumption_cost_period')}</p>
              <ul className="cost-rows">
                {cost.rows.map((row) => (
                  <li key={row.harness} data-cost-row={row.harness}><span>{row.name}</span><span className="cost-amount">{row.amount}</span>{row.partial ? <span className="cost-partial">{row.partial}</span> : null}</li>
                ))}
              </ul>
              <p className="cost-source">{t('consumption_cost_source')}</p>
            </section>
          ) : null}
          <section className="panel levers" aria-labelledby="levers-title">
            <h2 id="levers-title">{t('consumption_levers_title')}</h2>
            <p className="levers-label">{t('consumption_levers_label')}</p>
            <ul className="lever-list">
              {levers.map((lever) => <Lever key={lever.id} lever={lever} busy={busy} onLever={(change) => onLever?.(change)} />)}
            </ul>
            {note ? <p className="levers-note" role="alert">{note}</p> : null}
          </section>
        </aside>
      </div>
      <footer className="consumption-foot">
        <p>{measuredAt(data, language, t)}</p>
        <p className="foot-data"><ArrowRight size={12} aria-hidden="true" />{t('consumption_footer_data')}</p>
      </footer>
    </section>
  );
}

export default function ConsumptionPage() {
  const context = useScreen();
  const { t, api } = context;
  const language = context.me.language;
  const [zone] = useState(browserZone);
  const [data, setData] = useState<Consumption | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [week, setWeek] = useState<WeekFigures | undefined>(undefined);
  const [weekFailed, setWeekFailed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await readConsumption(api, zone));
      setFailed(null);
    } catch (error) {
      setFailed(t(readFailure(error)));
    }
  }, [api, zone, t]);
  // The week on its own: a failed read keeps the figures it read last.
  const loadWeek = useCallback(async () => {
    try {
      setWeek(await readWeek(api, zone));
      setWeekFailed(false);
    } catch {
      setWeekFailed(true);
    }
  }, [api, zone]);

  useEffect(() => { void load(); void loadWeek(); }, [load, loadWeek]);
  useLive(() => { void load(); void loadWeek(); });
  useEffect(() => {
    const timer = setInterval(() => { void load(); void loadWeek(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, loadWeek]);

  const change = async (next: LeversChange) => {
    setBusy(true);
    try {
      const levers = await setLevers(api, next);
      setData((before) => (before ? { ...before, levers } : before));
      setNote('');
    } catch (error) {
      setNote(t(leverFailure(error)));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return failed !== null ? <div className="consumption"><p className="empty error">{failed}</p></div> : <div className="consumption" aria-busy="true" />;
  return <ConsumptionView data={data} t={t} language={language} now={context.now()} busy={busy} note={note} onLever={(next) => void change(next)}
    {...(week ? { week } : {})} weekFailed={weekFailed && !week} />;
}
