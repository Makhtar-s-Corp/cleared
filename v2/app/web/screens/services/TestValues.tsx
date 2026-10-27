// The Test secrets panel (docs/v2/milestone-5-plan.md, section 12, C16), on
// the Services screen and in the assistant's secrets step: each service with
// its test values by name, the day each was set and by whom, never a value;
// a value that cannot be read, and a service gone from the workspace, said
// with what to do; the form that adds or replaces one, its value typed in a
// password field and emptied once saved. test-values.ts holds the words'
// rules and the client; this file draws them.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { SetTestValueBody, TestValueSaved, TestValuesView } from '../../../../src/secrets/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { savedLine, testValueRefusal, type TestValuesClient } from './test-values.ts';
import './test-values.css';

export type TestValuesPanelProps = {
  readonly t: Translate;
  readonly view: TestValuesView;
  readonly idPrefix: 'services' | 'setup';
  readonly titled?: boolean;                       // its own heading; the step's frame has one
  readonly busy?: boolean;
  readonly error?: string;
  readonly note?: string;
  readonly onSave?: (body: SetTestValueBody) => Promise<boolean>;
  readonly onRemove?: (service: string, name: string) => void;
};

export function TestValuesPanel({ t, view, idPrefix, titled = true, busy = false, error = '', note = '', onSave, onRemove }: TestValuesPanelProps) {
  const id = (part: string) => `${idPrefix}-test-value-${part}`;
  const open = view.services.filter((service) => service.inWorkspace).map((service) => service.name);
  const [service, setService] = useState(open[0] ?? '');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const valueField = useRef<HTMLInputElement>(null);
  const chosen = open.includes(service) ? service : open[0] ?? '';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave?.({ service: chosen, name: name.trim(), value }).then((saved) => {
      // The value leaves the page once the service holds it.
      if (saved) { setValue(''); setName(''); }
    });
  };
  const replace = (service: string, name: string) => {
    setService(service);
    setName(name);
    setValue('');
    valueField.current?.focus();
  };

  // On the Services screen a section of its own; in the step, the step's frame is the section.
  const Frame = titled ? 'section' : 'div';
  return (
    <Frame className={`test-values ${idPrefix}-test-values`} {...(titled ? { 'aria-labelledby': `${idPrefix}-test-values-title` } : {})} data-test-values>
      {titled ? (
        <header className="test-values-head">
          <h2 id={`${idPrefix}-test-values-title`}>{t('test_values_panel_title')}</h2>
          <p className="test-values-intro">{t('test_values_panel_intro')}</p>
        </header>
      ) : null}
      {view.key === 'unusable' ? <p className="test-values-error" role="alert">{t('test_values_key_unusable')}</p> : null}
      <p className="test-values-warning">{t('test_values_warning')} {t('test_values_next_session')}</p>
      {!view.workspace ? <p className="test-values-empty">{t('test_values_no_workspace')}</p> : null}
      {view.services.length > 0 ? (
        <ul className="test-values-services">
          {view.services.map((group) => (
            <li className="test-values-service" key={group.name} data-test-values-service={group.name}>
              <h3 className="test-values-service-name">{group.name}</h3>
              {!group.inWorkspace ? <p className="test-values-gone">{t('test_values_gone')}</p> : null}
              {group.values.length === 0 ? <p className="test-values-none">{t('test_values_none')}</p> : (
                <ul className="test-values-list">
                  {group.values.map((item) => (
                    <li className="test-value" key={item.name} data-test-value={item.name} data-readable={item.readable ? 'yes' : 'no'}>
                      <div className="test-value-body">
                        <code className="test-value-name">{item.name}</code>
                        <span className="test-value-meta">{savedLine(item, t)}</span>
                        {!item.readable ? <span className="test-value-unreadable">{t('test_values_unreadable')}</span> : null}
                      </div>
                      <div className="test-value-actions">
                        {group.inWorkspace ? (
                          <Button variant="ghost" data-act="test_value_replace" disabled={busy} aria-label={t('test_values_replace_label', { name: item.name, service: group.name })} onClick={() => replace(group.name, item.name)}>
                            {t('test_values_replace')}
                          </Button>
                        ) : null}
                        <Button variant="ghost" data-act="test_value_remove" disabled={busy} aria-label={t('test_values_remove_label', { name: item.name, service: group.name })} onClick={() => onRemove?.(group.name, item.name)}>
                          {t('test_values_remove')}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="test-values-note" role="status">{note}</p> : null}
      {view.workspace && open.length > 0 && view.key !== 'unusable' ? (
        <form className="test-values-form" onSubmit={submit} aria-busy={busy} aria-labelledby={`${idPrefix}-test-values-form-title`}>
          <h3 id={`${idPrefix}-test-values-form-title`}>{t('test_values_form_title')}</h3>
          {open.length > 1 ? (
            <div className="test-values-field">
              <label htmlFor={id('service')}>{t('test_values_service_label')}</label>
              <select id={id('service')} name="service" value={chosen} onChange={(event) => setService(event.currentTarget.value)}>
                {open.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>
          ) : null}
          <div className="test-values-field">
            <label htmlFor={id('name')}>{t('test_values_name_label')}</label>
            <Input id={id('name')} name="name" autoComplete="off" spellCheck={false} autoCapitalize="characters" required maxLength={64}
              aria-describedby={id('name-hint')} value={name} onChange={(event) => setName(event.currentTarget.value)} />
            <p className="test-values-hint" id={id('name-hint')}>{t('test_values_name_hint')}</p>
          </div>
          <div className="test-values-field">
            <label htmlFor={id('value')}>{t('test_values_value_label')}</label>
            <Input ref={valueField} id={id('value')} name="value" type="password" autoComplete="off" spellCheck={false} required maxLength={4096}
              aria-describedby={id('value-hint')} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
            <p className="test-values-hint" id={id('value-hint')}>{t('test_values_value_hint')}</p>
          </div>
          {error ? <p className="test-values-error" role="alert">{error}</p> : null}
          <Button variant="ink" className="primary" type="submit" data-act={`${idPrefix}_test_values_save`} disabled={busy}>{busy ? t('test_values_saving') : t('test_values_save')}</Button>
        </form>
      ) : error ? <p className="test-values-error" role="alert">{error}</p> : null}
    </Frame>
  );
}

// The panel with its data: read from the service (unless the tests give
// it), each save and removal sent, then read again. `onView` tells the
// step whether a value is saved.
export function TestValuesEditor({ t, client, path, idPrefix, titled, initial, onView }: {
  readonly t: Translate; readonly client: TestValuesClient; readonly path: string; readonly idPrefix: 'services' | 'setup'; readonly titled?: boolean;
  readonly initial?: TestValuesView; readonly onView?: (view: TestValuesView) => void;
}) {
  const [view, setView] = useState<TestValuesView | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const told = useRef(onView);
  told.current = onView;

  const read = useCallback(() => client.get<TestValuesView>(path).then((answer) => {
    if (answer.status !== 200) return setError(testValueRefusal(t, answer.body));
    setView(answer.body);
    told.current?.(answer.body);
  }, () => setError(t('test_values_error_other'))), [client, path, t]);

  useEffect(() => {
    if (initial) return;
    void read();
  }, [initial, read]);

  const save = async (body: SetTestValueBody): Promise<boolean> => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const answer = await client.post<TestValueSaved>(path, body);
      if (answer.status !== 200) { setError(testValueRefusal(t, answer.body)); return false; }
      setNote(t(answer.body.replaced ? 'test_values_replaced' : 'test_values_saved', { name: answer.body.value.name, service: answer.body.value.service }));
      await read();
      return true;
    } catch {
      setError(t('test_values_error_other'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = (service: string, name: string) => {
    setBusy(true);
    setError('');
    setNote('');
    void client.post(`${path}/remove`, { service, name }).then(async (answer) => {
      if (answer.status !== 200) return setError(testValueRefusal(t, answer.body));
      setNote(t('test_values_removed', { name, service }));
      await read();
    }, () => setError(t('test_values_error_other'))).finally(() => setBusy(false));
  };

  if (!view) return <div className={`test-values ${idPrefix}-test-values`} aria-busy={!error} data-test-values>{error ? <p className="test-values-error" role="alert">{error}</p> : null}</div>;
  return <TestValuesPanel t={t} view={view} idPrefix={idPrefix} titled={titled} busy={busy} error={error} note={note} onSave={save} onRemove={remove} />;
}
