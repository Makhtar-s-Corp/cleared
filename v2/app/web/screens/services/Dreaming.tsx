// The nightly pass panel (issue #455), on the Services screen under the
// agent profile: each service's pass on or off, and what its last run did.
// Its proposals wait in the inbox for the owner's Approve; this panel only
// turns the pass on or off, through the service's API (POST /api/dreaming/:service).
import { useCallback, useEffect, useState } from 'react';
import type { DreamingView } from '../../../../src/api/types.ts';
import type { Translate } from '@/lib/i18n.ts';
import { DREAMING_PATH, dreamingRefusal, lastPassLine } from './dreaming.ts';
import type { TestValuesClient } from './test-values.ts';
import './dreaming.css';

export function DreamingPanel({ t, view, busy = false, error = '', onSet }: {
  readonly t: Translate; readonly view: DreamingView; readonly busy?: boolean; readonly error?: string;
  readonly onSet?: (service: string, enabled: boolean) => void;
}) {
  return (
    <section className="dreaming" aria-labelledby="dreaming-title" data-dreaming aria-busy={busy}>
      <h2 id="dreaming-title">{t('dreaming_title')}</h2>
      <p className="dreaming-intro">{t('dreaming_intro')}</p>
      {error ? <p className="dreaming-error" role="alert">{error}</p> : null}
      <ul className="dreaming-services">
        {view.services.map((row, i) => (
          <li key={row.service} data-dreaming-service={row.service}>
            <input type="checkbox" id={`dreaming-${i}`} checked={row.enabled} disabled={busy} onChange={(event) => onSet?.(row.service, event.currentTarget.checked)} />
            <label htmlFor={`dreaming-${i}`}>
              <span className="dreaming-name">{t('dreaming_service', { service: row.service })}</span>
              <span className="dreaming-last">{row.enabled ? lastPassLine(row.last, t) : t('dreaming_off')}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The panel with its data: read from the service, each change sent, the answer shown.
export function DreamingEditor({ t, client }: { readonly t: Translate; readonly client: TestValuesClient }) {
  const [view, setView] = useState<DreamingView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 503: no workspace yet, or the module is off; the map's own failure already says why.
  const read = useCallback(() => client.get<DreamingView>(DREAMING_PATH).then((answer) => {
    if (answer.status === 503) return undefined;
    if (answer.status !== 200) return setError(dreamingRefusal(t, answer.status));
    setView(answer.body);
  }, () => setError(t('dreaming_error_other'))), [client, t]);

  useEffect(() => { void read(); }, [read]);

  const set = (service: string, enabled: boolean) => {
    setBusy(true);
    setError('');
    void client.post<DreamingView>(`${DREAMING_PATH}/${encodeURIComponent(service)}`, { enabled }).then((answer) => {
      if (answer.status !== 200) return setError(dreamingRefusal(t, answer.status));
      setView(answer.body);
    }, () => setError(t('dreaming_error_other'))).finally(() => setBusy(false));
  };

  if (!view) return error ? <div className="dreaming"><p className="dreaming-error" role="alert">{error}</p></div> : null;
  return <DreamingPanel t={t} view={view} busy={busy} error={error} onSet={set} />;
}
