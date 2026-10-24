// The Consumption screen (O15): per agent, the tokens of the last seven days
// as a curve and where the quota is heading before the next reset and
// after it; the dollars only where the agent reported them; and three levers
// that call real actions of the service. model.ts holds the rules and the
// words; this file draws them, reads the figures again every minute and
// after each lever, and says a refusal in the catalog's words.
import { ArrowRight, ArrowsClockwise, Gauge, Pause, Play, Stack, Timer } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import type { Consumption, HarnessConsumption, LeversChange, Quota } from '../../../../src/api/types.ts';
import { Toggle } from '@/components/ui/toggle.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { useLive } from '@/lib/query.tsx';
import {
  REFRESH_MS, averagePerDay, browserZone, chartOf, costView, dayInitial, dayLong, harnessMaker, harnessName, headline, leverFailure, leverViews, measuredAt, percentText,
  periodText, projectionLines, quotaOf, readConsumption, readingLines, readFailure, resetIn, setLevers, tokensText, verdictOf, type LeverId, type LeverView,
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

export function ConsumptionView({ data, t, language, now, busy = false, note = '', onLever }: {
  readonly data: Consumption; readonly t: Translate; readonly language: Language; readonly now: Date;
  readonly busy?: boolean; readonly note?: string; readonly onLever?: (change: LeversChange) => void;
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
        <div className="harnesses" role="list" aria-label={t('consumption_harnesses_label')}>
          {data.harnesses.map((h) => <div role="listitem" key={h.harness}><HarnessCard h={h} data={data} t={t} language={language} /></div>)}
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

  useEffect(() => { void load(); }, [load]);
  useLive(() => { void load(); });
  useEffect(() => {
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

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
  return <ConsumptionView data={data} t={t} language={language} now={context.now()} busy={busy} note={note} onLever={(next) => void change(next)} />;
}
