// The assistant's environment step's screen: a stub (docs/v2/milestone-5-plan.md,
// decision 9), which the step's lane fills.
import { StepStub, type StepProps } from '../step.tsx';

export function EnvironmentStep({ t }: StepProps) {
  return <StepStub t={t} id="environment" />;
}
