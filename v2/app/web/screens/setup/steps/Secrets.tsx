// The assistant's secrets step's screen (docs/v2/milestone-5-plan.md, sections
// 1 and 12, step 7, C16; the owner's request of 2026-10-30): the step reads the
// repositories and asks for the names the tests expect, one field each; with
// none it says so in one sentence and skips itself. The Services screen's Test
// secrets panel, on the step's own routes (/api/setup/secrets), is in the
// detail for any other value.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TestValuesView } from '../../../../../src/secrets/types.ts';
import type { ExpectedSecrets } from '../../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { TestValuesEditor } from '../../services/TestValues.tsx';
import { testValueRefusal } from '../../services/test-values.ts';
import { StepFrame, type StepProps } from '../step.tsx';

const savedAny = (view: TestValuesView | undefined): boolean => view?.services.some((service) => service.values.some((value) => value.readable)) ?? false;
const savedName = (view: TestValuesView | undefined, service: string, name: string): boolean =>
  view?.services.find((each) => each.name === service)?.values.some((value) => value.name === name && value.readable) ?? false;

type Initial = TestValuesView & { readonly expected?: ExpectedSecrets };

export function SecretsStep({ t, api, onDone, initial, onOwnAction }: StepProps<Initial>) {
  const [expected, setExpected] = useState<ExpectedSecrets | undefined>(initial?.expected);
  const [values, setValues] = useState<TestValuesView | undefined>(initial);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (initial) return;
    void api.get<ExpectedSecrets>('/secrets/expected').then((answer) => setExpected(answer.status === 200 ? answer.body : { services: [] }));
    void api.get<TestValuesView>('/secrets').then((answer) => { if (answer.status === 200) setValues(answer.body); });
  }, [api, initial]);

  const rows = expected?.services.flatMap((service) => service.names.map((name) => ({ service: service.service, ...name }))) ?? [];
  const several = (expected?.services.filter((service) => service.names.length > 0).length ?? 0) > 1;
  const nothing = expected !== undefined && values !== undefined && rows.length === 0 && !savedAny(values);

  // Nothing to ask: the step skips itself, once.
  const skipped = useRef(false);
  useEffect(() => {
    if (!nothing || skipped.current || initial) return;
    skipped.current = true;
    void api.post('/secrets/skip', {}).then(() => done.current());
  }, [nothing, api, initial]);

  const missing = rows.filter((row) => !savedName(values, row.service, row.name));
  useEffect(() => { onOwnAction?.(missing.length > 0); }, [onOwnAction, missing.length]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      for (const row of missing) {
        const value = String(form.get(`${row.service}:${row.name}`) ?? '');
        if (!value) continue;
        const answer = await api.post('/secrets', { service: row.service, name: row.name, value });
        if (answer.status !== 200) { setError(testValueRefusal(t, answer.body)); return; }
      }
      const reread = await api.get<TestValuesView>('/secrets');
      if (reread.status === 200) setValues(reread.body);
      const closed = await api.post('/secrets/done', {});
      if (closed.status !== 200) { setError(testValueRefusal(t, closed.body)); return; }
      setSaved(true);
      done.current();
    } catch {
      setError(t('test_values_error_other'));
    } finally {
      setBusy(false);
    }
  };

  if (!expected || !values) return <StepFrame t={t} prefix="test_values" sentence={t('test_values_step_read')}><span className="setup-spinner" aria-hidden="true" /></StepFrame>;
  const editor = <TestValuesEditor t={t} client={api} path="/secrets" idPrefix="setup" titled={false} initial={values} onView={setValues} />;
  if (nothing) return <StepFrame t={t} prefix="test_values" sentence={t('test_values_step_none')} detail={editor}><span data-test-values-none /></StepFrame>;
  return (
    <StepFrame t={t} prefix="test_values" sentence={missing.length === 0 ? t('test_values_step_saved') : undefined} detail={editor}>
      {missing.length > 0 ? (
        <form className="setup-form" onSubmit={(event) => void submit(event)} aria-busy={busy} data-test-values-expected>
          {missing.map((row) => {
            const id = `setup-expected-${row.service}-${row.name}`;
            return (
              <div key={id} className="setup-field" data-expected={row.name}>
                <label htmlFor={id}><code>{row.name}</code>{several ? <span className="setup-field-service"> {row.service}</span> : null}</label>
                <Input id={id} name={`${row.service}:${row.name}`} type="password" autoComplete="off" spellCheck={false} maxLength={4096} aria-label={t('test_values_step_field', { name: row.name })} aria-describedby={`${id}-from`} />
                <p className="setup-hint" id={`${id}-from`}>{t('test_values_step_from', { file: row.from })}</p>
              </div>
            );
          })}
          {error ? <p className="setup-error" role="alert">{error}</p> : null}
          <Button variant="ink" className="primary" type="submit" data-act="setup_test_values_done" disabled={busy}>{busy ? t('test_values_step_saving') : t('test_values_step_save')}</Button>
        </form>
      ) : null}
      {saved ? <span data-test-values-saved /> : null}
    </StepFrame>
  );
}
