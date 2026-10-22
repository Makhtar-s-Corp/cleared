// The checks of the doctor's `lead` section (docs/v2/milestone-2-plan.md,
// lanes 4 and 5): doctor.ts imports this list and runs it when the section
// is named; lane 5 fills it with a real lead generation on this server.
// Empty until then.

export type DoctorLeadContext = {
  readonly model: string;                         // the doctor's --model, claude-haiku-5-5 by default
  readonly build: boolean;                        // false with --no-build
  readonly say: (line: string) => void;           // a raw line, redacted as the doctor's own
};

export type DoctorLeadCheck = {
  readonly name: string;
  run(context: DoctorLeadContext): Promise<{ readonly ok: boolean; readonly detail?: string }>;
};

export const leadChecks: readonly DoctorLeadCheck[] = [];
