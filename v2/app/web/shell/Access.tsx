// The API access panel (docs/v2/milestone-5-plan.md, section 8, C18), a
// dialog the person's menu opens (Sidebar.tsx): the person's tokens, each
// by its name, the day it was made and when it was last used, with Revoke;
// a field to make one, whose value is then shown this once, with Copy and
// the command that uses it. The service keeps the hash only, so a value
// that is closed or lost cannot be shown again. Esc closes it; the shell
// gives the focus back to the menu's button (shell/App.tsx).
import { X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { Translate } from '@/lib/i18n.ts';
import type { ScreenContext } from '@/lib/screen.ts';
import type { ApiToken, MadeApiToken } from '../../../src/run/types.ts';
import { ACCESS_COMMAND, ACCESS_NAME_MAX, ACCESS_PER_PERSON, accessNameProblem, accessRows, initialAccess, type AccessView } from './access.ts';
import { trapTab } from './dialog.ts';

export type AccessBodyProps = {
  readonly t: Translate;
  readonly view: AccessView;
  readonly now: Date;
  readonly onName: (name: string) => void;
  readonly onMake: () => void;
  readonly onRevoke: (token: ApiToken) => void;
  readonly onCopy: () => void;
};

function failure(t: Translate, view: AccessView): string | null {
  const failed = view.failed;
  if (!failed) return null;
  if (failed.kind === 'revoke') return t('access_failed_revoke', { name: failed.name });
  return t(failed.kind === 'read' ? 'access_failed_read' : 'access_failed_make');
}

function problem(t: Translate, view: AccessView): string | null {
  switch (view.problem) {
    case 'empty': return t('access_name_empty');
    case 'long': return t('access_name_long', { max: ACCESS_NAME_MAX });
    case 'many': return t('access_many', { max: ACCESS_PER_PERSON });
    default: return null;
  }
}

export function AccessBody({ t, view, now, onName, onMake, onRevoke, onCopy }: AccessBodyProps) {
  const rows = view.rows ? accessRows(view.rows, now, t) : null;
  const failed = failure(t, view);
  const refused = problem(t, view);
  const submit = (event: FormEvent) => { event.preventDefault(); onMake(); };
  return (
    <div className="sheet-body access-body">
      <p className="access-lead">{t('access_lead')}</p>
      {failed ? <p className="access-failed" role="alert">{failed}</p> : null}
      {view.fresh ? (
        <section className="access-fresh" aria-labelledby="access-fresh-title">
          <h3 id="access-fresh-title">{t('access_fresh_title', { name: view.fresh.token.name })}</h3>
          <p>{t('access_fresh_note')}</p>
          <label htmlFor="access-value">{t('access_value_label', { name: view.fresh.token.name })}</label>
          <div className="access-value-row">
            <Input id="access-value" readOnly value={view.fresh.value} spellCheck={false} autoComplete="off" onFocus={(event) => event.currentTarget.select()} />
            <Button className="plain" id="access-copy" onClick={onCopy}>{t('access_copy')}</Button>
          </div>
          <p>{t('access_use')}</p>
          <pre className="access-command"><code>{ACCESS_COMMAND}</code></pre>
        </section>
      ) : null}
      <section aria-labelledby="access-list-title" aria-busy={rows === null ? true : undefined}>
        <h3 id="access-list-title">{t('access_list_title')}</h3>
        {rows === null ? <p className="access-note">{t('access_reading')}</p>
          : rows.length === 0 ? <p className="access-note">{t('access_none')}</p>
          : (
            <ul aria-labelledby="access-list-title">
              {rows.map((row, index) => (
                <li key={row.id} className="access-row">
                  <span className="access-name">{row.name}</span>
                  <span className="access-dates">{row.made} · {row.used}</span>
                  <Button className="plain" data-revoke={row.id} aria-label={t('access_revoke_label', { name: row.name })} disabled={view.busy}
                    onClick={() => onRevoke(view.rows![index]!)}>{t('access_revoke')}</Button>
                </li>
              ))}
            </ul>
          )}
      </section>
      <form className="access-form" onSubmit={submit} noValidate>
        <label htmlFor="access-name">{t('access_name_label')}</label>
        <p className="access-note" id="access-name-hint">{t('access_name_hint')}</p>
        <div className="access-value-row">
          <Input id="access-name" value={view.name} maxLength={ACCESS_NAME_MAX} autoComplete="off" aria-invalid={refused ? true : undefined}
            aria-describedby={refused ? 'access-problem' : 'access-name-hint'} onChange={(event) => onName(event.currentTarget.value)} />
          <Button type="submit" variant="ink" className="primary" id="access-make" disabled={view.busy}>{t('access_make')}</Button>
        </div>
        {refused ? <p className="access-failed" id="access-problem" role="alert">{refused}</p> : null}
      </form>
      <p className="sr-only" id="access-said" role="status" aria-live="polite">{view.said}</p>
    </div>
  );
}

export function AccessPanel({ t, api, onClose }: { readonly t: Translate; readonly api: ScreenContext['api']; readonly onClose: () => void }) {
  const [view, setView] = useState<AccessView>(initialAccess);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    let stopped = false;
    api<ApiToken[]>('/tokens').then(
      (rows) => { if (!stopped) setView((held) => ({ ...held, rows })); },
      () => { if (!stopped) setView((held) => ({ ...held, rows: [], failed: { kind: 'read' } })); },
    );
    return () => { stopped = true; };
  }, [api]);

  const make = () => {
    const refused = accessNameProblem(view.name) ?? ((view.rows?.length ?? 0) >= ACCESS_PER_PERSON ? 'many' : null);
    if (refused) {
      setView((held) => ({ ...held, problem: refused }));
      document.getElementById('access-name')?.focus();
      return;
    }
    setView((held) => ({ ...held, busy: true, problem: null, failed: null }));
    api<MadeApiToken>('/tokens', { method: 'POST', body: { name: view.name.trim() } }).then(
      (made) => {
        setView((held) => ({ ...held, busy: false, name: '', fresh: made, rows: [made.token, ...(held.rows ?? [])], said: '' }));
        requestAnimationFrame(() => document.getElementById('access-value')?.focus());
      },
      () => setView((held) => ({ ...held, busy: false, failed: { kind: 'make' } })),
    );
  };

  const revoke = (token: ApiToken) => {
    setView((held) => ({ ...held, busy: true, failed: null }));
    api<{ revoked: true }>(`/tokens/${encodeURIComponent(token.id)}/revoke`, { method: 'POST', body: {} }).then(
      () => {
        setView((held) => ({
          ...held, busy: false, rows: (held.rows ?? []).filter((row) => row.id !== token.id),
          fresh: held.fresh?.token.id === token.id ? null : held.fresh, said: t('access_revoked', { name: token.name }),
        }));
        document.getElementById('access-name')?.focus();
      },
      () => setView((held) => ({ ...held, busy: false, failed: { kind: 'revoke', name: token.name } })),
    );
  };

  const copy = () => {
    const value = view.fresh?.value;
    if (!value) return;
    navigator.clipboard.writeText(value).then(
      () => setView((held) => ({ ...held, said: t('access_copied') })),
      () => {
        // The browser refused the clipboard: the value is selected for the person to copy.
        const field = document.getElementById('access-value') as HTMLInputElement | null;
        field?.focus();
        field?.select();
      },
    );
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    trapTab(event);
  };
  return (
    <div className="overlay" data-overlay="access" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog sheet access" role="dialog" aria-modal="true" aria-labelledby="access-title" id="access" tabIndex={-1} ref={box} onKeyDown={keyDown}>
        <div className="sheet-head">
          <h2 id="access-title">{t('access_title')}</h2>
          <Button variant="ghost" className="icon" id="access-close" aria-label={t('access_close')} onClick={onClose}><X size={16} aria-hidden="true" /></Button>
        </div>
        <AccessBody t={t} view={view} now={new Date()} onName={(name) => setView((held) => ({ ...held, name, problem: null }))} onMake={make} onRevoke={revoke} onCopy={copy} />
      </div>
    </div>
  );
}
