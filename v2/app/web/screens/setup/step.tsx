// What every step's screen is given by the assistant (Setup.tsx), and the
// frame a step draws in (the owner's direction of 2026-10-30, issue #497): a
// title, one sentence, its one action, the rest folded behind "Show details".
import type { ReactNode } from 'react';
import type { StepView } from '../../../../src/setup/types.ts';
import type { Translate } from '@/lib/i18n.ts';
import type { SetupApi } from './model.ts';

export type StepProps<T = unknown> = {
  readonly t: Translate;
  readonly step: StepView;
  readonly api: SetupApi;
  readonly onDone: () => void;                 // the step's work is done: the assistant reads its view again
  readonly initial?: T;                        // what the step reads first (the tests'; else the step asks the service)
  readonly csrf?: string;
  readonly terminalHere?: boolean;             // the web terminal opens on the app's loopback address only (/api/me)
  // The step shows its own primary action: Continue steps back, one indigo button a screen.
  readonly onOwnAction?: (own: boolean) => void;
};

export function Detail({ t, children, label }: { readonly t: Translate; readonly children: ReactNode; readonly label?: string }) {
  return (
    <details className="setup-detail">
      <summary>{label ?? t('setup_detail')}</summary>
      <div className="setup-detail-body">{children}</div>
    </details>
  );
}

// `sentence`: the step's one sentence when it says more than its intro (its state).
export function StepFrame({ t, prefix, sentence, values, detail, children }: {
  readonly t: Translate; readonly prefix: string; readonly sentence?: string; readonly values?: Readonly<Record<string, string | number>>;
  readonly detail?: ReactNode; readonly children?: ReactNode;
}) {
  return (
    <section className="setup-step" aria-labelledby="setup-step-title">
      <h2 id="setup-step-title">{t(`${prefix}_title`)}</h2>
      <p className="setup-intro" role={sentence ? 'status' : undefined}>{sentence ?? t(`${prefix}_intro`, values)}</p>
      {children}
      {detail ? <Detail t={t}>{detail}</Detail> : null}
    </section>
  );
}
