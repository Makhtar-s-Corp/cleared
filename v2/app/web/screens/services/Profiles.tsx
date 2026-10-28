// The Agent profile panel (issue #452), on the Services screen under the
// test secrets: the agent profile's and the environment's versions, newest
// first, each with its day, its person and what it sets; the current one
// marked, every other one with Restore, which makes it the next version.
// A change itself goes through the service's API (POST /api/profiles/...).
// profiles.ts holds the words' rules; the client is the test secrets'.
import { useCallback, useEffect, useState } from 'react';
import type { ProfilesView, VersionView } from '../../../../src/profiles/types.ts';
import { PROFILES_PATH } from '../../../../src/profiles/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { environmentFacts, profileFacts, profileRefusal, versionMeta } from './profiles.ts';
import type { TestValuesClient } from './test-values.ts';
import './profiles.css';

type ProfileObject = 'agent' | 'environment';
// The service's routes through the app's proxy, which adds /api/service.
const PATH = PROFILES_PATH.replace(/^\/api/, '');

function History<T>({ t, object, current, versions, facts, busy, onRestore }: {
  readonly t: Translate; readonly object: ProfileObject; readonly current: number; readonly versions: readonly VersionView<T>[];
  readonly facts: (body: T) => string[]; readonly busy: boolean; readonly onRestore?: (object: ProfileObject, version: number) => void;
}) {
  const titleId = `profiles-${object}-title`;
  return (
    <section className="profiles-object" aria-labelledby={titleId} data-profiles-object={object}>
      <h3 id={titleId}>{t(object === 'agent' ? 'profiles_agent' : 'profiles_environment')}</h3>
      <ol className="profiles-versions">
        {[...versions].reverse().map((version) => {
          const isCurrent = version.version === current;
          return (
            <li className="profiles-version" key={version.version} data-profile-version={version.version} data-current={isCurrent ? 'yes' : 'no'}>
              <div className="profiles-version-head">
                <p className="profiles-version-title">
                  <span>{t('profiles_version', { version: version.version })}</span>
                  {isCurrent ? <span className="profiles-current">{t('profiles_current')}</span> : null}
                </p>
                {isCurrent ? null : (
                  <Button variant="ghost" data-restore={`${object}:${version.version}`} disabled={busy}
                    aria-label={t(`profiles_restore_${object}_label`, { version: version.version })} onClick={() => onRestore?.(object, version.version)}>
                    {t('profiles_restore')}
                  </Button>
                )}
              </div>
              <p className="profiles-meta">
                {versionMeta(version, t)}
                {version.restoredFrom !== null ? <> {t('profiles_restored_from', { version: version.restoredFrom })}</> : null}
              </p>
              <ul className="profiles-facts">{facts(version.body).map((fact) => <li key={fact}>{fact}</li>)}</ul>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function ProfilesPanel({ t, view, busy = false, error = '', note = '', onRestore }: {
  readonly t: Translate; readonly view: ProfilesView; readonly busy?: boolean; readonly error?: string; readonly note?: string;
  readonly onRestore?: (object: ProfileObject, version: number) => void;
}) {
  return (
    <section className="profiles" aria-labelledby="profiles-title" data-profiles aria-busy={busy}>
      <header className="profiles-head">
        <h2 id="profiles-title">{t('profiles_title')}</h2>
        <p className="profiles-intro">{t('profiles_intro')}</p>
      </header>
      {error ? <p className="profiles-error" role="alert">{error}</p> : null}
      <p className="profiles-note" role="status">{note}</p>
      <div className="profiles-objects">
        <History t={t} object="agent" current={view.profile.current} versions={view.profile.versions} facts={(body) => profileFacts(body, t)} busy={busy} {...(onRestore ? { onRestore } : {})} />
        <History t={t} object="environment" current={view.environment.current} versions={view.environment.versions} facts={(body) => environmentFacts(body, t)} busy={busy} {...(onRestore ? { onRestore } : {})} />
      </div>
    </section>
  );
}

// The panel with its data: read from the service, each Restore sent, then read again.
export function ProfilesEditor({ t, client }: { readonly t: Translate; readonly client: TestValuesClient }) {
  const [view, setView] = useState<ProfilesView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const read = useCallback(() => client.get<ProfilesView>(PATH).then((answer) => {
    if (answer.status !== 200) return setError(profileRefusal(t, answer.body));
    setView(answer.body);
  }, () => setError(t('profiles_error_other'))), [client, t]);

  useEffect(() => { void read(); }, [read]);

  const restore = (object: ProfileObject, version: number) => {
    setBusy(true);
    setError('');
    setNote('');
    void client.post<VersionView<unknown>>(`${PATH}/${object}/restore`, { version }).then(async (answer) => {
      if (answer.status !== 200) return setError(profileRefusal(t, answer.body));
      setNote(t('profiles_restored', { version: answer.body.version, from: version }));
      await read();
    }, () => setError(t('profiles_error_other'))).finally(() => setBusy(false));
  };

  if (!view) return <div className="profiles" aria-busy={!error} data-profiles-loading>{error ? <p className="profiles-error" role="alert">{error}</p> : null}</div>;
  return <ProfilesPanel t={t} view={view} busy={busy} error={error} note={note} onRestore={restore} />;
}
