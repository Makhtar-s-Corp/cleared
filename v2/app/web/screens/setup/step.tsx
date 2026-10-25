// What every step's screen is given by the assistant (Setup.tsx), and the
// frame a step draws in: its title, its words, then its own part. A step's
// lane fills its screen and never edits this file or another step's.
import type { ReactNode } from 'react';
import type { StepId, StepView } from '../../../../src/setup/types.ts';
import type { Translate } from '@/lib/i18n.ts';
import { stepKey, type SetupApi } from './model.ts';

export type StepProps<T = unknown> = {
  readonly t: Translate;
  readonly step: StepView;
  readonly api: SetupApi;
  readonly onDone: () => void;                 // the step's work is done: the assistant reads its view again
  readonly initial?: T;                        // what the step reads first (the tests'; else the step asks the service)
  readonly csrf?: string;
  readonly terminalHere?: boolean;             // the web terminal opens on the app's loopback address only (/api/me)
};

export function StepFrame({ t, prefix, children }: { readonly t: Translate; readonly prefix: string; readonly children?: ReactNode }) {
  return (
    <section className="setup-step" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title">{t(`${prefix}_title`)}</h2>
      <p className="setup-intro">{t(`${prefix}_intro`)}</p>
      {children}
    </section>
  );
}

// A step a later lane fills: what it will do, and that it can be skipped for now.
export function StepStub({ t, id }: { readonly t: Translate; readonly id: StepId }) {
  return (
    <StepFrame t={t} prefix={stepKey(id)}>
      <p className="setup-note" data-step-stub={id}>{t('setup_stub_later')}</p>
    </StepFrame>
  );
}
