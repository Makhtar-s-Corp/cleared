// The assistant's secrets step's screen (docs/v2/milestone-5-plan.md,
// sections 1 and 12, step 7, C16): the Services screen's Test secrets panel
// on the step's own routes (/api/setup/secrets), then Done once a value is
// saved. A project whose tests need none skips the step.
import { useState } from 'react';
import type { TestValuesView } from '../../../../../src/secrets/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { TestValuesEditor } from '../../services/TestValues.tsx';
import { testValueRefusal } from '../../services/test-values.ts';
import { StepFrame, type StepProps } from '../step.tsx';

const saved = (view: TestValuesView | undefined): boolean => view?.services.some((service) => service.values.some((value) => value.readable)) ?? false;

export function SecretsStep({ t, api, onDone, initial }: StepProps<TestValuesView>) {
  const [ready, setReady] = useState(saved(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = () => {
    setBusy(true);
    setError('');
    void api.post('/secrets/done', {}).then((answer) => {
      if (answer.status !== 200) return setError(testValueRefusal(t, answer.body));
      onDone();
    }, () => setError(t('test_values_error_other'))).finally(() => setBusy(false));
  };
  return (
    <StepFrame t={t} prefix="test_values">
      <TestValuesEditor t={t} client={api} path="/secrets" idPrefix="setup" titled={false} initial={initial} onView={(view) => setReady(saved(view))} />
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      <p className="setup-note test-values-done-hint" id="setup-test-values-done-hint">{t('test_values_step_done_hint')}</p>
      <Button variant="ink" className="primary" data-act="setup_test_values_done" aria-describedby="setup-test-values-done-hint" disabled={!ready || busy} onClick={done}>
        {t('test_values_step_done')}
      </Button>
    </StepFrame>
  );
}
