// The service map screen (docs/v2/milestone-4-plan.md, section 12.4): the
// drawing of the workspace's services, their databases and the links
// between them, one image with its name; beside it the same links in words,
// which is what a screen reader and a narrow screen read; the services as
// buttons, and the impact of the one picked, as the service computed it.
// model.ts holds the rules and the words; this file draws them, reads the
// map again on the change stream, and refreshes it on demand. Under the map,
// the services' test secrets (TestValues.tsx, C16), then the agent
// profile's and the environment's versions (Profiles.tsx, issue #452), then
// the nightly pass of each service (Dreaming.tsx, issue #455), all shown
// even when the map cannot be read.
import { ArrowsClockwise } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ServiceMap } from '../../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { useScreen } from '@/lib/context.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { useLive } from '@/lib/query.tsx';
import { FIT_WIDTH, builtLine, impactLines, layout, linkRows, mapFailure, problemLines, readMap, refreshMap, serviceDetail, type Drawing } from './model.ts';
import { DreamingEditor } from './Dreaming.tsx';
import { ProfilesEditor } from './Profiles.tsx';
import { TestValuesEditor } from './TestValues.tsx';
import { testValuesClient } from './test-values.ts';
import './services.css';

function Diagram({ drawing, picked, t }: { readonly drawing: Drawing; readonly picked: string | null; readonly t: Translate }) {
  return (
    // A box the keyboard reaches, so a drawing wider than the screen scrolls by the keyboard too.
    <div className="map-scroll" tabIndex={0} role="group" aria-label={t('map_diagram_label')}>
      <svg className="map-svg" role="img" aria-labelledby="services-diagram-title" data-fit={drawing.width <= FIT_WIDTH ? 'yes' : 'no'} viewBox={`0 0 ${drawing.width} ${drawing.height}`} width={drawing.width} height={drawing.height}>
        <title id="services-diagram-title">{t('map_diagram_title')}</title>
        <defs>
          <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="map-arrow" d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        {drawing.edges.map((edge) => (
          <path className="map-edge" data-edge={edge.kind} data-undeclared={edge.undeclared ? 'yes' : 'no'} key={`${edge.kind}:${edge.from}:${edge.to}`} d={edge.path}
            fill="none" markerEnd={edge.kind === 'database' ? undefined : 'url(#map-arrow)'} />
        ))}
        {drawing.boxes.map((box) => (
          <g className="map-box" data-box={box.kind} data-picked={box.id === picked ? 'yes' : 'no'} key={box.id}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={box.kind === 'database' ? 18 : 10} />
            <text x={box.x + box.w / 2} y={box.y + box.h / 2} textAnchor="middle" dominantBaseline="central">{box.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// The assistant's workspace step (lane v2-j5-connect): pick the repositories, have the links proposed.
function ConnectLink({ t }: { readonly t: Translate }) {
  return <Button asChild><a className="services-connect" href="/setup/workspace" data-act="services_connect">{t('map_connect')}</a></Button>;
}

// No map to read, as on a server with no workspace yet: the reason, and the way to connect one.
export function ServicesFailed({ t, message }: { readonly t: Translate; readonly message: string }) {
  return (
    <div className="services">
      <p className="empty error">{message}</p>
      <p className="services-connect-line">{t('map_connect_hint')} <ConnectLink t={t} /></p>
    </div>
  );
}

function Legend({ t }: { readonly t: Translate }) {
  const item = (kind: string, label: string) => (
    <li data-legend={kind}>
      <svg className="map-legend-line" viewBox="0 0 32 8" width="32" height="8" aria-hidden="true"><path className="map-edge" data-edge={kind === 'undeclared' ? 'call' : kind} data-undeclared={kind === 'undeclared' ? 'yes' : 'no'} d="M1 4 L31 4" /></svg>
      <span>{label}</span>
    </li>
  );
  return (
    <ul className="map-legend" aria-label={t('map_legend_label')}>
      {item('call', t('map_legend_call'))}
      {item('event', t('map_legend_event'))}
      {item('database', t('map_legend_database'))}
      {item('undeclared', t('map_legend_undeclared'))}
    </ul>
  );
}

export function ServicesView({ map, t, now, picked, busy = false, note = '', onPick, onRefresh }: {
  readonly map: ServiceMap; readonly t: Translate; readonly now: Date; readonly picked: string | null;
  readonly busy?: boolean; readonly note?: string; readonly onPick?: (service: string) => void; readonly onRefresh?: () => void;
}) {
  const drawing = layout(map);
  const rows = linkRows(map, t);
  const lines = picked ? impactLines(map, picked, t) : [];
  return (
    <section className="services" aria-labelledby="services-title" data-screen="services">
      <header className="services-head">
        <div>
          {/* The heading first, the workspace it maps under it (lane j6-ui-pro: no label over a heading). */}
          <h1 id="services-title">{t('map_title')}</h1>
          <p className="services-eyebrow">{t('map_eyebrow')}</p>
          <p className="services-sub">{t('map_subtitle')}</p>
        </div>
        <div className="services-actions">
          <p className="services-built">{builtLine(map, now, t)}</p>
          <ConnectLink t={t} />
          <Button id="services-refresh" disabled={busy} onClick={onRefresh}>
            <ArrowsClockwise size={16} aria-hidden="true" />{busy ? t('map_refreshing') : t('map_refresh')}
          </Button>
        </div>
      </header>
      {note ? <p className="services-note" role="alert">{note}</p> : null}
      <div className="services-grid">
        <div className="services-main">
          <figure className="map-figure">
            <Diagram drawing={drawing} picked={picked} t={t} />
            <figcaption><Legend t={t} /></figcaption>
          </figure>
          <section className="map-links" aria-labelledby="map-links-title">
            <h2 id="map-links-title">{t('map_links_title')}</h2>
            {rows.length === 0 ? <p className="map-empty">{t('map_links_empty')}</p> : (
              <ul>
                {rows.map((row) => (
                  <li key={row.key} data-link={row.key} data-kind={row.kind} data-undeclared={row.undeclared ? 'yes' : 'no'}>
                    <p className="link-text">{row.text}</p>
                    <p className="link-meta"><span className="link-state">{row.state}</span>{row.places ? <><span className="sep" aria-hidden="true"> · </span><span className="link-places">{t('map_places', { places: row.places })}</span></> : null}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="services-side" aria-labelledby="map-services-title">
          <h2 id="map-services-title">{t('map_services_title')}</h2>
          <ul className="map-services">
            {map.services.map((service) => {
              const problems = problemLines(service, t);
              return (
                <li key={service.name}>
                  <button type="button" className="map-service" data-service={service.name} aria-pressed={picked === service.name} onClick={() => onPick?.(service.name)}>
                    <span className="map-service-name">{service.name}</span>
                    <span className="map-service-detail">{serviceDetail(service, t)}</span>
                    {problems.map((problem) => <span className="map-service-problem" key={problem}>{problem}</span>)}
                  </button>
                </li>
              );
            })}
          </ul>
          <section className="services-impact" aria-live="polite" aria-labelledby="map-impact-title">
            {picked ? (
              <>
                <h3 id="map-impact-title">{t('map_impact_title', { service: picked })}</h3>
                <ul>{lines.map((line, i) => <li key={`${line.kind}:${i}`} data-impact={line.kind}>{line.text}</li>)}</ul>
              </>
            ) : <p className="map-hint" id="map-impact-title">{t('map_services_hint')}</p>}
          </section>
        </aside>
      </div>
    </section>
  );
}

export default function ServicesPage() {
  const context = useScreen();
  const { t, api } = context;
  const [map, setMap] = useState<ServiceMap | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const client = useMemo(() => testValuesClient(context.me.csrf), [context.me.csrf]);

  const load = useCallback(async () => {
    try {
      setMap(await readMap(api));
      setFailed(null);
    } catch (error) {
      setFailed(t(mapFailure(error)));
    }
  }, [api, t]);

  useEffect(() => { void load(); }, [load]);
  useLive(() => { void load(); });

  const refresh = async () => {
    setBusy(true);
    try {
      setMap(await refreshMap(api));
      setNote('');
    } catch {
      setNote(t('map_refresh_failed'));
    } finally {
      setBusy(false);
    }
  };

  const values = <div className="services services-values"><TestValuesEditor t={t} client={client} path="/test-values" idPrefix="services" /><ProfilesEditor t={t} client={client} /><DreamingEditor t={t} client={client} /></div>;
  if (!map) return failed !== null ? <><ServicesFailed t={t} message={failed} />{values}</> : <div className="services" aria-busy="true" />;
  return (
    <>
      <ServicesView map={map} t={t} now={context.now()} picked={picked} busy={busy} note={note} onPick={(service) => setPicked((before) => (before === service ? null : service))} onRefresh={() => void refresh()} />
      {values}
    </>
  );
}
